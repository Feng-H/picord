// Pi Pocket's service worker. It shows push notifications (Pi finished, an approval, a chat message), answers an
// approval from its notification, opens the right session when one is tapped, and hands things shared to Pi Pocket
// from other apps to the page. It caches static shell assets to provide instant startup, while updating in background.

const SHELL_CACHE = "picord-shell-v9";
/** Where shared things wait until the page picks them up; see `web/share.js`. */
const SHARE_CACHE = "pocket-share";

const CORE_ASSETS = [
    "/",
    "/style.css",
    "/app.js",
    "/composer.js",
    "/connection.js",
    "/voice.js",
    "/store.js",
    "/ui.js",
    "/i18n.js",
    "/vendor/preact.mjs",
    "/vendor/preact-hooks.mjs",
    "/vendor/htm.mjs",
    "/vendor/marked.mjs",
    "/vendor/purify.mjs",
    "/icon.svg",
    "/icon-192.png",
    "/icon-maskable-512.png",
    "/favicon.svg",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/fonts/Geist.woff2",
    "/fonts/JetBrainsMono.woff2",
];

self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
            cache.addAll(CORE_ASSETS).catch(() => {
                // Non-critical failures on individual assets do not abort install
            }),
        ),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key.startsWith("picord-shell-") && key !== SHELL_CACHE)
                        .map((key) => caches.delete(key)),
                ),
            ),
        ]),
    );
});

self.addEventListener("push", (event) => {
    let data = {};

    try {
        data = event.data?.json() ?? {};
    } catch {
        data = { title: "Pi Pocket", body: event.data?.text() ?? "" };
    }

    const approval = data.approval;
    // Allowing from the notification is offered only when the server says the whole call shows and this person may.
    const actions = approval
        ? [
              ...(approval.allow ? [{ action: "allow", title: "Allow" }] : []),
              { action: "deny", title: "Deny" },
          ]
        : [];

    event.waitUntil(
        Promise.all([
            self.registration.showNotification(data.title || "Pi Pocket", {
                body: data.body || "",
                tag: data.tag,
                renotify: Boolean(data.tag),
                icon: "/icon.svg",
                actions,
                data: { url: data.url || "/", approval },
            }),
            // A dot on the home-screen icon; the app sets the real count once it opens.
            self.navigator.setAppBadge?.().catch(() => {}),
        ]),
    );
});

/** Answer an approval with this device's sign-in. Only a failure shows: the notification going away is the answer. */
async function answerApproval(approval, allow, data) {
    let problem;

    try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ allow }),
        });

        if (!response.ok) {
            problem =
                (await response.json().catch(() => ({}))).error ??
                `The server answered ${response.status}.`;
        }
    } catch {
        problem = "Pi Pocket could not be reached.";
    }

    if (problem === undefined) {
        return;
    }

    await self.registration.showNotification(`Could not ${allow ? "allow" : "deny"} the call`, {
        body: problem,
        icon: "/icon.svg",
        data: { url: data.url },
    });
}

async function openUrl(url) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);

    // PiP's notifications open its panel over whatever the window shows, rather than take the window elsewhere.
    if (open && new URL(url).searchParams.has("pip")) {
        await open.focus();
        open.postMessage({ type: "pocket.pip" });

        return;
    }

    if (open) {
        await open.focus();

        try {
            await open.navigate(url);

            return;
        } catch {
            // Not controlled by this worker yet: open a new window instead.
        }
    }

    await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data ?? {};

    if ((event.action === "allow" || event.action === "deny") && data.approval) {
        event.waitUntil(answerApproval(data.approval, event.action === "allow", data));

        return;
    }

    event.waitUntil(openUrl(new URL(data.url || "/", self.location.origin).href));
});

/**
 * Something shared to Pi Pocket from another app (the manifest's share target) arrives as a form post. Keep it until
 * the page picks it up, then open the page to choose where it goes. Any website could post a form here too, and
 * nothing tells it apart from a share; it only fills in a message the person still reads and sends themselves.
 */
async function receiveShare(request) {
    let form;

    try {
        form = await request.formData();
    } catch {
        return Response.redirect("/?share=failed", 303);
    }

    const id = crypto.randomUUID();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll("files").filter((file) => file instanceof File && file.size > 0);
    const text = (name) => (typeof form.get(name) === "string" ? form.get(name) : "");
    const meta = {
        title: text("title"),
        text: text("text"),
        url: text("url"),
        files: files.map((file) => ({ name: file.name, type: file.type })),
    };

    await cache.put(
        `/share/${id}/meta`,
        new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }),
    );
    await Promise.all(
        files.map((file, index) =>
            cache.put(
                `/share/${id}/file/${index}`,
                new Response(file, {
                    headers: { "content-type": file.type || "application/octet-stream" },
                }),
            ),
        ),
    );

    return Response.redirect(`/?share=${id}`, 303);
}

async function staleWhileRevalidate(request, fallbackUrl) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(fallbackUrl || request);

    const fetchPromise = fetch(request)
        .then((response) => {
            if (response && response.status === 200) {
                cache.put(fallbackUrl || request, response.clone());
            }

            return response;
        })
        .catch(() => undefined);

    if (cached) {
        return cached;
    }

    const fetched = await fetchPromise;

    if (fetched) {
        return fetched;
    }

    if (fallbackUrl) {
        const rootCached = await cache.match("/");

        if (rootCached) {
            return rootCached;
        }
    }

    return new Response("Offline", { status: 503, statusText: "Offline" });
}

async function networkFirst(request, fallbackUrl, timeoutMs = 1500) {
    const cache = await caches.open(SHELL_CACHE);

    const networkPromise = fetch(request).then((response) => {
        if (response && response.status === 200) {
            cache.put(fallbackUrl || request, response.clone());
        }

        return response;
    });

    const cached = await cache.match(fallbackUrl || request);

    if (!cached) {
        try {
            return await networkPromise;
        } catch {
            if (fallbackUrl) {
                const rootCached = await cache.match("/");

                if (rootCached) {
                    return rootCached;
                }
            }

            return new Response("Offline", { status: 503, statusText: "Offline" });
        }
    }

    let timer;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });

    try {
        const result = await Promise.race([networkPromise.catch(() => null), timeoutPromise]);

        clearTimeout(timer);

        if (result) {
            return result;
        }
    } catch {
        clearTimeout(timer);
    }

    return cached;
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (
        event.request.method === "POST" &&
        url.origin === self.location.origin &&
        url.pathname === "/share"
    ) {
        event.respondWith(receiveShare(event.request));

        return;
    }

    if (event.request.method === "GET" && url.origin === self.location.origin) {
        if (url.pathname.startsWith("/api/")) {
            return;
        }

        if (event.request.mode === "navigate") {
            event.respondWith(networkFirst(event.request, "/"));

            return;
        }

        if (
            url.pathname.endsWith(".css") ||
            url.pathname.endsWith(".js") ||
            url.pathname.endsWith(".webmanifest")
        ) {
            event.respondWith(networkFirst(event.request));

            return;
        }

        if (
            url.pathname.endsWith(".mjs") ||
            url.pathname.endsWith(".woff2") ||
            url.pathname.endsWith(".svg") ||
            url.pathname.endsWith(".png") ||
            url.pathname.endsWith(".ico")
        ) {
            event.respondWith(staleWhileRevalidate(event.request));
        }
    }
});
