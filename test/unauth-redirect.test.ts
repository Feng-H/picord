import { cleanUp, openApp, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let server: Server;
let base: string;
let app: Awaited<ReturnType<typeof openApp>>;
let validAuthCookie: string;

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const adminToken = app.config.ownerToken;

    validAuthCookie = `pocket_auth=${encodeURIComponent(adminToken)}`;
});

after(async () => {
    server?.close();
    await app?.close();
    cleanUp();
});

test("unauthenticated GET / redirects to /login", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
});

test("unauthenticated GET /s/session-xyz preserves next destination", async () => {
    const res = await fetch(`${base}/s/session-xyz`, { redirect: "manual" });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login?next=%2Fs%2Fsession-xyz");
});

test("unauthenticated GET /s/session-xyz with query params encodes full next destination", async () => {
    const res = await fetch(`${base}/s/session-xyz?view=code`, { redirect: "manual" });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login?next=%2Fs%2Fsession-xyz%3Fview%3Dcode");
});

test("unauthenticated GET /index.html redirects to /login", async () => {
    const res = await fetch(`${base}/index.html`, { redirect: "manual" });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
});

test("unauthenticated GET /login serves the login page directly (no redirect loop)", async () => {
    const res = await fetch(`${base}/login`, { redirect: "manual" });

    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Sign in|Login|Picord/i);
});

test("unauthenticated HEAD /login responds with 200", async () => {
    const res = await fetch(`${base}/login`, { method: "HEAD", redirect: "manual" });

    assert.equal(res.status, 200);
});

test("unauthenticated GET /web/icon.svg is accessible as public asset", async () => {
    const res = await fetch(`${base}/icon.svg`, { redirect: "manual" });

    assert.equal(res.status, 200);
});

test("authenticated GET / serves the application with 200", async () => {
    const res = await fetch(`${base}/`, {
        headers: { cookie: validAuthCookie },
        redirect: "manual",
    });

    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /<!doctype html>/i);
});

test("authenticated GET /s/session-xyz serves the application with 200", async () => {
    const res = await fetch(`${base}/s/session-xyz`, {
        headers: { cookie: validAuthCookie },
        redirect: "manual",
    });

    assert.equal(res.status, 200);
});
