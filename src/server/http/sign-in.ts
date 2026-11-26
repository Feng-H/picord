/** The pages outside the app: signing in with password or link, registering with an invite, and shares. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { type Auth, quickTunnelHost, setAuthCookie } from "../auth.ts";
import { HttpError } from "../errors.ts";
import { hashPassword } from "../password.ts";
import { conversationId, escapeHtml, readBody, send } from "./io.ts";

/** A form posted from another site, as browsers report it. Such a post must not sign this browser in or out. */
function crossSite(request: IncomingMessage): boolean {
    const site = request.headers["sec-fetch-site"];

    return site !== undefined && site !== "same-origin" && site !== "none";
}

/** Where to go after signing in: a path on this server, never `//host` or `/\host`, which browsers read as another site. */
function localPath(next: string | null): string {
    return next !== null && /^\/(?![/\\])/.test(next) ? next : "/";
}

function page(title: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg?v=20261126"><link rel="icon" type="image/x-icon" href="/favicon.ico?v=20261126" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=20261126"><link rel="stylesheet" href="/style.css"></head><body class="plain-page"><main class="plain">${body}</main></body></html>`;
}

function renderLoginPage(options: {
    error?: string;
    next?: string;
    username?: string;
}): string {
    const errorHtml = options.error
        ? `<div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; line-height: 1.4;">${escapeHtml(options.error)}</div>`
        : "";
    const nextVal = escapeHtml(options.next ?? "/");
    const userVal = escapeHtml(options.username ?? "");

    return page(
        "Sign In · Picord",
        `<div style="display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 12px;">
            <img src="/icon.svg" width="56" height="56" alt="Picord" style="border-radius: 14px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); display: block;">
            <h1 style="margin: 0;">Picord</h1>
            <p style="margin: 0; color: var(--muted); font-size: 0.95rem;">Sign in to your account</p>
        </div>
        ${errorHtml}
        <form method="post" action="/login">
            <input type="hidden" name="next" value="${nextVal}">
            <label>
                Username
                <input type="text" name="username" value="${userVal}" required autofocus autocomplete="username" autocapitalize="none" placeholder="Username">
            </label>
            <label>
                Password
                <input type="password" name="password" required autocomplete="current-password" placeholder="Password">
            </label>
            <button type="submit">Sign In</button>
        </form>
        <p style="text-align: center; margin-top: 1rem; font-size: 0.9rem; color: var(--muted);">
            Have an invite code? <a href="/register">Register</a>
        </p>
        <details style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--muted);">
            <summary style="cursor: pointer; padding: 4px 0;">Token sign-in</summary>
            <form method="post" action="/login" style="margin-top: 0.75rem;">
                <input type="hidden" name="next" value="${nextVal}">
                <label>
                    Access Token
                    <input type="text" name="token" placeholder="Paste access token" required>
                </label>
                <button type="submit" style="background: var(--card); border: 1px solid var(--hair-2); color: var(--text);">Sign in with Token</button>
            </form>
        </details>`,
    );
}

function renderRegisterPage(options: {
    error?: string;
    code?: string;
    username?: string;
}): string {
    const errorHtml = options.error
        ? `<div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; line-height: 1.4;">${escapeHtml(options.error)}</div>`
        : "";
    const codeVal = escapeHtml(options.code ?? "");
    const userVal = escapeHtml(options.username ?? "");

    return page(
        "Register · Picord",
        `<div style="display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 12px;">
            <img src="/icon.svg" width="56" height="56" alt="Picord" style="border-radius: 14px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); display: block;">
            <h1 style="margin: 0;">Join Picord</h1>
            <p style="margin: 0; color: var(--muted); font-size: 0.95rem;">Create your account with an invite code</p>
        </div>
        ${errorHtml}
        <form method="post" action="/register">
            <label>
                Invite Code
                <input type="text" name="code" value="${codeVal}" required placeholder="Invite code" autocomplete="off" ${codeVal ? "" : "autofocus"}>
            </label>
            <label>
                Username
                <input type="text" name="username" value="${userVal}" required maxlength="40" placeholder="Choose a username" autocomplete="username" autocapitalize="none" ${codeVal ? "autofocus" : ""}>
            </label>
            <label>
                Password
                <input type="password" name="password" required minlength="6" placeholder="At least 6 characters" autocomplete="new-password">
            </label>
            <label>
                Confirm Password
                <input type="password" name="confirmPassword" required minlength="6" placeholder="Repeat password" autocomplete="new-password">
            </label>
            <button type="submit">Create Account</button>
        </form>
        <p style="text-align: center; margin-top: 1rem; font-size: 0.9rem; color: var(--muted);">
            Already have an account? <a href="/login">Sign in</a>
        </p>`,
    );
}

/** `/login`: sign in with username & password, or token link. */
export async function login(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
): Promise<void> {
    const posted = request.method === "POST";

    if (posted && crossSite(request)) {
        throw new HttpError(403, "Sign in from Picord's own page.");
    }

    const form = posted
        ? new URLSearchParams((await readBody(request, 10_000)).toString("utf8"))
        : url.searchParams;
    // A one-time link from the desktop app (`/login?once=…`) is spent here, whatever happens next.
    const once = form.get("once");
    const username = form.get("username")?.trim() ?? "";
    const password = form.get("password") ?? "";
    const token =
        (once === null ? form.get("token")?.trim() : auth.redeemSignInLink(once)) ?? "";
    const next = localPath(form.get("next"));

    // Case 1: Username & Password POST login
    if (posted && username && password) {
        const verified = await auth.verifyCredentials(username, password);

        if (verified === undefined) {
            return send(
                response,
                401,
                renderLoginPage({ error: "Invalid username or password.", next, username }),
                "text/html; charset=utf-8",
            );
        }

        setAuthCookie(request, response, verified.token);
        response.writeHead(303, { location: next });
        response.end();

        return;
    }

    // Case 2: Token-based login (via one-time link or token form)
    if (token) {
        const signingIn = auth.tokenUser(token);

        if (signingIn === undefined) {
            return send(
                response,
                401,
                renderLoginPage({ error: "Login link or token is invalid or expired.", next }),
                "text/html; charset=utf-8",
            );
        }

        const current = auth.user(request);

        // A one-time link is the owner's own app window, which signs in as the owner without prompting.
        if (!posted && once === null && current !== undefined && current.id !== signingIn.id) {
            return send(
                response,
                200,
                page(
                    "Switch account? · Picord",
                    `<h1>Switch account?</h1><p>This browser is signed in as ${escapeHtml(current.name)}. The link you opened signs it in as ${escapeHtml(signingIn.name)} instead.</p><form method="post" action="/login"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Sign in as ${escapeHtml(signingIn.name)}</button></form><p><a href="/">Stay signed in as ${escapeHtml(current.name)}</a></p>`,
                ),
                "text/html; charset=utf-8",
                { "referrer-policy": "no-referrer" },
            );
        }

        setAuthCookie(request, response, token);
        response.writeHead(303, { location: next });
        response.end();

        return;
    }

    // Case 3: Expired or spent one-time desktop link (GET or POST)
    if (once !== null) {
        return send(
            response,
            401,
            page(
                "Picord",
                `<h1>Link expired</h1><p>This one-time sign-in link was used already, or it is more than a minute old. Open Picord again from its icon in the menu bar or the notification area.</p>`,
            ),
            "text/html; charset=utf-8",
        );
    }

    // Case 4: POST without valid credentials
    if (posted) {
        return send(
            response,
            400,
            renderLoginPage({ error: "Please enter your username and password.", next, username }),
            "text/html; charset=utf-8",
        );
    }

    // Case 5: Normal GET /login page
    return send(
        response,
        200,
        renderLoginPage({ next }),
        "text/html; charset=utf-8",
    );
}

/** `/register`: register a new account with an invite code, username, and password. */
export async function register(
    app: PocketApp,
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
): Promise<void> {
    const posted = request.method === "POST";

    if (posted && crossSite(request)) {
        throw new HttpError(403, "Register from Picord's own page.");
    }

    const form = posted
        ? new URLSearchParams((await readBody(request, 10_000)).toString("utf8"))
        : url.searchParams;

    const code = form.get("code")?.trim() ?? "";
    const username = (form.get("username") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const password = form.get("password") ?? "";
    const confirmPassword = form.get("confirmPassword") ?? "";

    if (!posted) {
        return send(
            response,
            200,
            renderRegisterPage({ code, username }),
            "text/html; charset=utf-8",
        );
    }

    // Validation
    if (!code) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Invite code is required.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    if (!username) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Username is required.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    if (username.length > 40) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Username must be 40 characters or fewer.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    if (password.length < 6) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Password must be at least 6 characters.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    if (password !== confirmPassword) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Passwords do not match.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    // Check invite validity first (without consuming it)
    if (!auth.inviteValid(code)) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Invite code is invalid or has expired.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    // Check if username is taken
    if (app.config.userByName(username) !== undefined) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Username is already taken. Please choose another.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    // Hash password and redeem
    const passwordHash = await hashPassword(password);
    const redeemed = auth.redeemWithPassword(code, username, passwordHash);

    if (redeemed === undefined) {
        return send(
            response,
            400,
            renderRegisterPage({ error: "Failed to redeem invite. It may have expired.", code, username }),
            "text/html; charset=utf-8",
        );
    }

    const tunnel = quickTunnelHost(request);

    if (tunnel !== undefined && redeemed.user.role !== "owner") {
        app.config.updateUser(redeemed.user.id, { tunnel });
    }

    setAuthCookie(request, response, redeemed.token);
    response.writeHead(303, { location: "/" });
    response.end();
}

/** `/join/:code`: what an invite grants, and redeeming it with a name (or, for an owner invite, signing in as the owner). */
export async function join(
    app: PocketApp,
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    code: string,
): Promise<void> {
    if (request.method === "POST") {
        if (crossSite(request)) {
            throw new HttpError(403, "Join from Picord's own page.");
        }

        const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
        const redeemed = auth.redeem(code, form.get("name") ?? "");

        if (redeemed === undefined) {
            return send(
                response,
                410,
                page("Picord", "<h1>Invite expired</h1><p>Ask for a new one.</p>"),
                "text/html; charset=utf-8",
            );
        }

        const tunnel = quickTunnelHost(request);

        // The owner is never tied to one tunnel.
        if (tunnel !== undefined && redeemed.user.role !== "owner") {
            app.config.updateUser(redeemed.user.id, { tunnel });
        }

        setAuthCookie(request, response, redeemed.token);
        response.writeHead(303, { location: "/" });
        response.end();

        return;
    }

    const grant = auth.invite(code);

    if (grant === undefined) {
        return send(
            response,
            410,
            page(
                "Picord",
                "<h1>Invite expired</h1><p>Each invite works once, and only until it expires. Ask for a new one.</p>",
            ),
            "text/html; charset=utf-8",
        );
    }

    if (grant.role === "owner") {
        const current = auth.user(request);
        // Signed in as someone else: say so, as switching accounts does.
        const switching =
            current !== undefined && current.role !== "owner"
                ? `<p>This browser is signed in as ${escapeHtml(current.name)}. It will change to the owner.</p>`
                : "";

        return send(
            response,
            200,
            page(
                "Sign in as owner · Picord",
                `<h1>Sign in as owner</h1><p>This device will sign in as you, the owner. It gets full control of Picord and of this machine.</p>${switching}<form method="post"><button type="submit">Sign in as owner</button></form>`,
            ),
            "text/html; charset=utf-8",
            { "referrer-policy": "no-referrer" },
        );
    }

    const where =
        grant.session === undefined
            ? "every session on this server"
            : `the session “${escapeHtml(await app.conversationTitle(conversationId(grant.session)))}”`;
    const can =
        grant.role === "viewer"
            ? `read ${where} and chat with the people there, but not steer Pi`
            : `read and steer ${where}. Pi can run commands on this machine`;

    return send(
        response,
        200,
        page(
            "Join Picord",
            `<h1>Join Picord</h1><p>This device will be able to ${can}.</p><form method="post"><label>Your name<input name="name" maxlength="40" autofocus required placeholder="e.g. Alex"></label><button type="submit">Join</button></form><p style="text-align: center; margin-top: 1rem; font-size: 0.9rem; color: var(--muted);">Prefer password login? <a href="/register?code=${encodeURIComponent(code)}">Register with password</a></p>`,
        ),
        "text/html; charset=utf-8",
    );
}

/** `/share`: a share that reached the server, before the service worker that takes shares was installed here. */
export function sharePage(response: ServerResponse): void {
    return send(
        response,
        200,
        page(
            "Share to Pi",
            `<h1>Open Picord first</h1><p>Sharing works once Picord has been opened on this device over https. Open it, then share again.</p><p><a href="/">Open Picord</a></p>`,
        ),
        "text/html; charset=utf-8",
    );
}
