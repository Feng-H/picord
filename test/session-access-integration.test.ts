import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { cleanUp, fakeTab, openApp, owner, scriptedModel, until } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base: string;
let work: string;

before(async () => {
    app = await openApp(scriptedModel());
    work = app.defaultCwd;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function api(token: string, path: string, body?: unknown) {
    const response = await fetch(`${base}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("strict private-by-default isolation, group promotion, attribution, eviction, and self-leave", async () => {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const alice = app.config.addUser("Alice", "guest");
    const bob = app.config.addUser("Bob", "guest");
    const ownerUser = owner(app);

    // Owner creates private session & channel; Alice and Bob create their own #general channels
    const ownerPrivate = (await app.commands.createSession(ownerUser, { cwd: work, title: "Owner Secret" })).id;
    const ownerGeneral = (
        await app.commands.createSession(ownerUser, { cwd: work, title: "#general", channel: true })
    ).id;
    const aliceGeneral = (
        await app.commands.createSession(alice.user, { cwd: work, title: "#general", channel: true })
    ).id;
    const bobGeneral = (
        await app.commands.createSession(bob.user, { cwd: work, title: "#general", channel: true })
    ).id;

    // Strict isolation: owner does NOT see Alice/Bob's private channels; Alice does NOT see owner's
    assert.deepEqual(
        app.sessions(alice.user).map((s) => s.id),
        [Number(aliceGeneral)],
    );
    assert.deepEqual(
        app.sessions(bob.user).map((s) => s.id),
        [Number(bobGeneral)],
    );
    assert.equal(app.canSee(ownerUser, aliceGeneral), false);
    assert.equal(app.canSee(ownerUser, bobGeneral), false);
    assert.equal(app.canSee(alice.user, ownerPrivate), false);
    assert.equal(app.canSee(alice.user, ownerGeneral), false);

    // Owner cannot create a second private #general while theirs is unshared
    await assert.rejects(
        app.commands.createSession(ownerUser, { cwd: work, title: "#general", channel: true }),
        /already here/,
    );

    // Bob shares Bob's #general with Alice (turns into a group; duplicate #general allowed!)
    // Outsider receives 404 (session existence is hidden)
    const outsider = await api(alice.token, `c/${bobGeneral}/members`, { members: [ownerUser.id] });

    assert.equal(outsider.status, 404);

    const added = await api(bob.token, `c/${bobGeneral}/members`, { members: [alice.user.id] });

    assert.equal(added.status, 200);
    assert.equal(added.json.isGroup, true);

    // Group non-creator member receives 403 when trying to manage members
    const forbidden = await api(alice.token, `c/${bobGeneral}/members`, { members: [ownerUser.id] });

    assert.equal(forbidden.status, 403);

    // Owner shares Owner's #general with Alice too -> Alice now sees 3 #general channels!
    const addedOwner = await api(app.config.ownerToken, `c/${ownerGeneral}/members`, {
        members: [alice.user.id],
    });

    assert.equal(addedOwner.status, 200);

    const aliceList = app.sessions(alice.user);

    assert.equal(aliceList.length, 3);
    assert.equal(aliceList.find((s) => s.id === Number(aliceGeneral))?.ownerName, undefined);
    assert.equal(aliceList.find((s) => s.id === Number(bobGeneral))?.ownerName, "Bob");
    assert.equal(
        aliceList.find((s) => s.id === Number(ownerGeneral))?.ownerName,
        ownerUser.name,
    );

    // Because Bob's #general is now a group, Bob CAN even create another #general without collision!
    const bobSecondGeneral = (
        await app.commands.createSession(bob.user, { cwd: work, title: "#general", channel: true })
    ).id;

    assert.ok(bobSecondGeneral !== bobGeneral);

    // channel_post from a shared group disambiguates duplicate #general by numeric ID, and hides private ones
    const sharedGroup = (
        await app.commands.createSession(ownerUser, { cwd: work, title: "Shared Work" })
    ).id;

    await api(app.config.ownerToken, `c/${sharedGroup}/members`, { members: [alice.user.id] });

    // Owner has ownerGeneral (#general, shared with Alice), Alice has aliceGeneral (#general, private),
    // and Bob shared bobGeneral with Alice (NOT Owner). From sharedGroup (Owner + Alice), ONLY ownerGeneral is visible!
    const posted = await app.postToChannel(sharedGroup, "#general", "hello group");

    assert.match(posted, new RegExp(`session ${Number(ownerGeneral)}`));

    // Now Bob also adds Owner to bobGeneral -> sharedGroup sees BOTH #general channels -> ambiguous!
    await api(bob.token, `c/${bobGeneral}/members`, { members: [alice.user.id, ownerUser.id] });
    await assert.rejects(
        app.postToChannel(sharedGroup, "#general", "ambiguous"),
        /Multiple channels called #general are visible here.*Pass the session number instead/,
    );
    const targeted = await app.postToChannel(sharedGroup, String(bobGeneral), "explicit id works");

    assert.match(targeted, new RegExp(`session ${Number(bobGeneral)}`));

    // Live eviction when creator removes member
    const aliceTab = fakeTab(bobGeneral, alice.user);

    await app.attach(aliceTab.client);
    await api(bob.token, `c/${bobGeneral}/members`, { members: [ownerUser.id] });
    await until(() => aliceTab.last("missing") !== undefined, "eviction notice on removal");
    app.detach(aliceTab.client);
    assert.equal(app.canSee(alice.user, bobGeneral), false);

    // Self-leave by a member (Owner leaves bobGeneral); creator cannot leave
    const ownerLeave = await api(app.config.ownerToken, `c/${bobGeneral}/leave`, {});

    assert.equal(ownerLeave.status, 200);
    assert.equal(app.canSee(ownerUser, bobGeneral), false);

    const creatorLeave = await api(bob.token, `c/${bobGeneral}/leave`, {});

    assert.equal(creatorLeave.status, 400);
});

test("search_history inside a shared group never leaks participants' private sessions", async () => {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const bob = app.config.addUser("BobSearch", "guest");
    const ownerUser = owner(app);

    const ownerSecret = (
        await app.commands.createSession(ownerUser, { cwd: work, title: "Owner Vault" })
    ).id;
    const bobSecret = (await app.commands.createSession(bob.user, { cwd: work, title: "Bob Vault" }))
        .id;
    const group = (await app.commands.createSession(ownerUser, { cwd: work, title: "Joint Ops" })).id;

    await api(app.config.ownerToken, `c/${group}/members`, { members: [bob.user.id] });

    await app.commands.submit(ownerSecret, ownerUser, {
        text: "classified pineapple-token-999",
        requestId: crypto.randomUUID(),
    });
    await app.commands.submit(bobSecret, bob.user, {
        text: "secret banana-token-888",
        requestId: crypto.randomUUID(),
    });
    await app.commands.submit(group, ownerUser, {
        text: "public mango-token-777",
        requestId: crypto.randomUUID(),
    });

    await until(
        () => !app.isBusy(ownerSecret) && !app.isBusy(bobSecret) && !app.isBusy(group),
        "all turns settled",
    );

    // Inside group (Owner + Bob), search_history(scope="all") must NOT see Owner's or Bob's private vault!
    const leakOwner = await app.searchHistory(group, "pineapple-token-999", "all");
    const leakBob = await app.searchHistory(group, "banana-token-888", "all");
    const joint = await app.searchHistory(group, "mango-token-777", "all");

    assert.match(leakOwner, /No match/);
    assert.match(leakBob, /No match/);
    assert.match(joint, /2 matches/);

    // HTTP /api/search for Bob finds Bob's vault but NOT Owner's vault
    const bobHttp = await api(bob.token, "search?q=pineapple-token-999&scope=all");
    const bobOwnHttp = await api(bob.token, "search?q=banana-token-888&scope=all");

    assert.equal(bobHttp.status, 200);
    assert.deepEqual(bobHttp.json.matches, []);
    assert.equal(bobOwnHttp.status, 200);
    assert.ok((bobOwnHttp.json.matches as unknown[]).length >= 1);
});

test("single-session invite redemption via /register enrolls member into target session", async () => {
    const ownerUser = owner(app);
    const sharedSession = (
        await app.commands.createSession(ownerUser, { cwd: work, title: "Shared Invite Room" })
    ).id;
    const inviteRes = await api(app.config.ownerToken, "invite", {
        role: "guest",
        session: Number(sharedSession),
    });

    assert.equal(inviteRes.status, 200);
    const code = String(inviteRes.json.code);

    const reg = await fetch(`${base}/register`, {
        method: "POST",
        redirect: "manual",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
            code,
            username: "InvitedUser",
            password: "StrongPassword123!",
            confirmPassword: "StrongPassword123!",
        }),
    });

    assert.equal(reg.status, 303);
    const invitedUser = app.config.userByName("InvitedUser")!;

    assert.ok(invitedUser !== undefined);
    assert.equal(app.canSee(invitedUser, sharedSession), true);
    assert.equal(app.sessions(invitedUser).length, 1);
    assert.equal(app.sessions(invitedUser)[0]!.id, Number(sharedSession));
});
