import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Auth } from "../src/server/auth.ts";
import { ConfigStore, type User } from "../src/server/config.ts";
import { hashPassword } from "../src/server/password.ts";

let tempDir: string;
let store: ConfigStore;
let auth: Auth;
let owner: User;

before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "picord-auth-test-"));
    store = new ConfigStore(tempDir);
    auth = new Auth(store);
    const existingOwner = store.users.find((u) => u.role === "owner")!;

    store.updateUser(existingOwner.id, { name: "John" });
    owner = store.userById(existingOwner.id)!;
});

after(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

test("userByName performs case-insensitive lookup", () => {
    const found1 = store.userByName("JOHN");
    const found2 = store.userByName("john");
    const found3 = store.userByName("  John  ");
    const notFound = store.userByName("nonexistent");

    assert.ok(found1);
    assert.equal(found1?.id, owner.id);
    assert.equal(found2?.id, owner.id);
    assert.equal(found3?.id, owner.id);
    assert.equal(notFound, undefined);
});

test("setPassword updates user passwordHash and persists", async () => {
    const pwd = "TestAdminPassword123!";
    const hash = await hashPassword(pwd);

    assert.equal(store.setPassword("nonexistent-id", hash), false);
    assert.equal(store.setPassword(owner.id, hash), true);

    const reloaded = store.userById(owner.id);

    assert.equal(reloaded?.passwordHash, hash);
});

test("verifyCredentials validates username and password", async () => {
    const pwd = "TestAdminPassword123!";

    // Valid credentials
    const valid = await auth.verifyCredentials("John", pwd);

    assert.ok(valid);
    assert.equal(valid?.user.id, owner.id);
    assert.ok(typeof valid?.token === "string" && valid.token.length > 0);

    // Wrong password
    const wrongPwd = await auth.verifyCredentials("John", "WrongPassword!");

    assert.equal(wrongPwd, undefined);

    // Case-insensitive username check
    const caseCheck = await auth.verifyCredentials("john", pwd);

    assert.ok(caseCheck);
    assert.equal(caseCheck?.user.id, owner.id);

    // Non-existent user
    const noUser = await auth.verifyCredentials("Nobody", pwd);

    assert.equal(noUser, undefined);
});

test("redeemWithPassword registers a new member using invite code", async () => {
    const invite = auth.createInvite(owner, { role: "guest" }, 15);
    const memberPwd = "MemberPassword987!";
    const memberHash = await hashPassword(memberPwd);

    // Attempt registration with taken username (John)
    const duplicate = auth.redeemWithPassword(invite.code, "John", memberHash);

    assert.equal(duplicate, undefined);

    // Invite code should still be valid because duplicate was rejected before consuming
    assert.ok(auth.inviteValid(invite.code));

    // Register with new username
    const registered = auth.redeemWithPassword(invite.code, "Alice", memberHash);

    assert.ok(registered);
    assert.equal(registered?.user.name, "Alice");
    assert.equal(registered?.user.role, "guest");
    assert.equal(registered?.user.passwordHash, memberHash);

    // Invite code is now consumed
    assert.equal(auth.inviteValid(invite.code), false);

    // Newly registered member can log in via verifyCredentials
    const loginResult = await auth.verifyCredentials("Alice", memberPwd);

    assert.ok(loginResult);
    assert.equal(loginResult?.user.id, registered?.user.id);

    // Wrong password for newly registered member fails
    const badLogin = await auth.verifyCredentials("Alice", "BadPassword");

    assert.equal(badLogin, undefined);
});

test("redeemWithPassword rejects invalid or owner invites", async () => {
    const hash = await hashPassword("SomePassword123!");

    // Non-existent code
    assert.equal(auth.redeemWithPassword("badcode", "Bob", hash), undefined);

    // Owner invite
    const ownerInvite = auth.createInvite(owner, { role: "owner" }, 15);

    assert.equal(auth.redeemWithPassword(ownerInvite.code, "Eve", hash), undefined);
});
