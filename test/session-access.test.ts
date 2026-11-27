import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeChannelName } from "../src/server/channels.ts";
import {
    assertPrivateChannelNameAvailable,
    attributionForViewer,
    canConversationAccessTarget,
    canLeaveSession,
    canManageSessionMembers,
    canSeeSession,
    isGroupSession,
    normalizeMemberIds,
    resolveChannelTargetForScope,
    type SessionAccessMeta,
    type SessionAccessUser,
} from "../src/server/session-access.ts";

const JOHN: SessionAccessUser = { id: "john-id", name: "John", role: "owner" };
const TESTER: SessionAccessUser = { id: "tester-id", name: "tester", role: "guest" };
const ALICE: SessionAccessUser = { id: "alice-id", name: "Alice", role: "viewer" };
const SCOPED: SessionAccessUser = {
    id: "scoped-id",
    name: "Scoped",
    role: "guest",
    sessions: ["20"],
};
const USERS = [JOHN, TESTER, ALICE, SCOPED];

test("private sessions and channels isolate everyone including the owner", () => {
    const johnPrivate: SessionAccessMeta = { title: "John Note", createdBy: JOHN.id };
    const testerPrivate: SessionAccessMeta = {
        title: "#general",
        channel: true,
        createdBy: TESTER.id,
    };
    const legacyUnattributed: SessionAccessMeta = { title: "Legacy" };
    const johnPip: SessionAccessMeta = { title: "PiP", pip: JOHN.id, createdBy: JOHN.id };

    assert.equal(canSeeSession(JOHN, 1, johnPrivate), true);
    assert.equal(canSeeSession(TESTER, 1, johnPrivate), false);
    assert.equal(canSeeSession(ALICE, 1, johnPrivate), false);

    // Owner cannot see tester's private channel until tester shares it
    assert.equal(canSeeSession(TESTER, 2, testerPrivate), true);
    assert.equal(canSeeSession(JOHN, 2, testerPrivate), false);

    // Legacy sessions without createdBy default to the server owner
    assert.equal(canSeeSession(JOHN, 3, legacyUnattributed), true);
    assert.equal(canSeeSession(TESTER, 3, legacyUnattributed), false);

    // PiP stays strictly single-user
    assert.equal(canSeeSession(JOHN, 4, johnPip), true);
    assert.equal(canSeeSession(TESTER, 4, { ...johnPip, members: [TESTER.id] }), false);
    assert.equal(canManageSessionMembers(JOHN, johnPip), false);

    // Removed sessions are hidden for everyone
    assert.equal(canSeeSession(JOHN, 1, johnPrivate, true), false);
});

test("adding members promotes a conversation to a shared group with creator-only management", () => {
    const group: SessionAccessMeta = {
        title: "#general",
        channel: true,
        createdBy: TESTER.id,
        members: [JOHN.id, ALICE.id],
    };

    assert.equal(isGroupSession(group), true);
    assert.equal(canSeeSession(JOHN, 10, group), true);
    assert.equal(canSeeSession(TESTER, 10, group), true);
    assert.equal(canSeeSession(ALICE, 10, group), true);

    // Creator-only member management; recipients can leave
    assert.equal(canManageSessionMembers(TESTER, group), true);
    assert.equal(canManageSessionMembers(JOHN, group), false);
    assert.equal(canManageSessionMembers(ALICE, group), false);
    assert.equal(canLeaveSession(JOHN, group), true);
    assert.equal(canLeaveSession(ALICE, group), true);
    assert.equal(canLeaveSession(TESTER, group), false);

    // Single-session scoped invitee only sees explicitly pinned sessions
    assert.equal(canSeeSession(SCOPED, 10, { ...group, members: [SCOPED.id] }), false);
    assert.equal(canSeeSession(SCOPED, 20, { ...group, members: [SCOPED.id] }), true);

    assert.deepEqual(normalizeMemberIds(JOHN.id, [JOHN.id, TESTER.id, "", TESTER.id, ALICE.id]), [
        TESTER.id,
        ALICE.id,
    ]);
});

test("channel names collide only with own unshared private channels; groups allow duplicates", () => {
    const sessions: Record<string, SessionAccessMeta> = {
        "1": { title: "#general", channel: true, createdBy: JOHN.id }, // John's private #general
        "2": { title: "#general", channel: true, createdBy: TESTER.id, members: [JOHN.id] }, // tester's group #general
        "3": { title: "#general", channel: true, createdBy: ALICE.id, members: [JOHN.id] }, // another group #general
    };

    // John cannot create a second private #general of his own
    assert.throws(
        () => assertPrivateChannelNameAvailable(JOHN, "general", sessions),
        /A channel called #general is already here/,
    );

    // Tester CAN create their own private #general even though John and Alice have one
    assert.doesNotThrow(() => assertPrivateChannelNameAvailable(TESTER, "general", sessions));

    // When channel "2" is already a group, renaming/updating it has no collision check
    assert.doesNotThrow(() => assertPrivateChannelNameAvailable(TESTER, "general", sessions, "2"));

    // Attribution shows ownerName only when shared by someone else
    const userNameOf = (id: string) => USERS.find((u) => u.id === id)?.name;
    const seenByJohnFromJohn = attributionForViewer(sessions["1"]!, JOHN, userNameOf);
    const seenByJohnFromTester = attributionForViewer(sessions["2"]!, JOHN, userNameOf);

    assert.equal(seenByJohnFromJohn.ownerName, undefined);
    assert.equal(seenByJohnFromJohn.isGroup, false);
    assert.equal(seenByJohnFromTester.ownerName, "tester");
    assert.equal(seenByJohnFromTester.isGroup, true);
});

test("AI cross-session scope blocks private session leaks and disambiguates duplicate group channels", () => {
    const sessions: Record<string, SessionAccessMeta> = {
        "1": { title: "John Private", createdBy: JOHN.id },
        "2": { title: "Tester Private", createdBy: TESTER.id },
        "3": {
            title: "John+Tester Group",
            createdBy: JOHN.id,
            members: [TESTER.id],
        },
        "4": {
            title: "#general",
            channel: true,
            createdBy: JOHN.id,
            members: [TESTER.id],
        },
        "5": {
            title: "#general",
            channel: true,
            createdBy: TESTER.id,
            members: [JOHN.id],
        },
        "6": { title: "#secret-ops", channel: true, createdBy: JOHN.id },
    };

    // From John's private session (1): can access his own #secret-ops (6), never Tester's private (2)
    assert.equal(
        canConversationAccessTarget("1", sessions["1"], "6", sessions["6"], USERS),
        true,
    );
    assert.equal(
        canConversationAccessTarget("1", sessions["1"], "2", sessions["2"], USERS),
        false,
    );

    // From shared group (3): neither John's private (1/#secret-ops 6) nor Tester's private (2) are accessible
    assert.equal(
        canConversationAccessTarget("3", sessions["3"], "1", sessions["1"], USERS),
        false,
    );
    assert.equal(
        canConversationAccessTarget("3", sessions["3"], "6", sessions["6"], USERS),
        false,
    );
    assert.equal(
        canConversationAccessTarget("3", sessions["3"], "4", sessions["4"], USERS),
        true,
    );

    // Ambiguous #general inside shared group (3) rejects with session numbers
    assert.throws(
        () => resolveChannelTargetForScope("3", sessions["3"], "#general", sessions, USERS, normalizeChannelName),
        /Multiple channels called #general are visible here: #general · John \(session 4\), #general · tester \(session 5\)\. Pass the session number instead\./,
    );

    // Resolving by exact numeric ID inside shared group succeeds
    const resolved = resolveChannelTargetForScope(
        "3",
        sessions["3"],
        "5",
        sessions,
        USERS,
        normalizeChannelName,
    );

    assert.deepEqual(resolved, { id: 5, name: "general", ownerName: "tester" });

    // Targeting John's private #secret-ops from shared group (3) returns 404 (hidden)
    assert.throws(
        () =>
            resolveChannelTargetForScope(
                "3",
                sessions["3"],
                "#secret-ops",
                sessions,
                USERS,
                normalizeChannelName,
            ),
        /No live channel called #secret-ops is here/,
    );
});
