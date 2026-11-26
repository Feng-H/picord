import test from "node:test";
import assert from "node:assert/strict";
import type { User } from "../src/server/config.ts";
import { SteeringPolicy } from "../src/server/turn-pipeline/steering.ts";

const ADMIN_USER: User = {
    id: "admin-1",
    name: "Admin John",
    role: "owner",
    tokenHash: "hash-admin",
    createdAt: Date.now(),
};

const AUTHOR_USER: User = {
    id: "user-author",
    name: "Alice",
    role: "guest",
    tokenHash: "hash-alice",
    createdAt: Date.now(),
};

const OTHER_USER: User = {
    id: "user-other",
    name: "Bob",
    role: "guest",
    tokenHash: "hash-bob",
    createdAt: Date.now(),
};

test("SteeringPolicy defaults to followUp queue when no steer requested", () => {
    const policy = new SteeringPolicy();
    const decision = policy.evaluate({
        text: "Hello everyone in the channel",
        actor: AUTHOR_USER,
    });

    assert.equal(decision.whenBusy, "followUp");
    assert.equal(decision.steerRequested, false);
    assert.equal(decision.steerGranted, false);
    assert.equal(decision.cleanedText, "Hello everyone in the channel");
});

test("SteeringPolicy recognizes /steer prefix and grants steering to author", () => {
    const policy = new SteeringPolicy();
    const decision = policy.evaluate({
        text: "/steer Stop, answer in Python instead!",
        actor: AUTHOR_USER,
        activeTurnAuthorId: AUTHOR_USER.id,
    });

    assert.equal(decision.whenBusy, "steer");
    assert.equal(decision.steerRequested, true);
    assert.equal(decision.steerGranted, true);
    assert.equal(decision.cleanedText, "Stop, answer in Python instead!");
});

test("SteeringPolicy allows admin to steer any ongoing turn", () => {
    const policy = new SteeringPolicy();
    const decision = policy.evaluate({
        text: "Please summarize immediately",
        mode: "steer",
        actor: ADMIN_USER,
        activeTurnAuthorId: "someone-else-id",
    });

    assert.equal(decision.whenBusy, "steer");
    assert.equal(decision.steerRequested, true);
    assert.equal(decision.steerGranted, true);
});

test("SteeringPolicy demotes unauthorized third-party steering to followUp queue", () => {
    const policy = new SteeringPolicy();
    const decision = policy.evaluate({
        text: "/steer Interrupt Alice's answer with my question",
        actor: OTHER_USER,
        activeTurnAuthorId: AUTHOR_USER.id, // Alice is active
    });

    // Bob is not admin and not Alice -> demoted to queue!
    assert.equal(decision.whenBusy, "followUp");
    assert.equal(decision.steerRequested, true);
    assert.equal(decision.steerGranted, false);
    assert.ok(decision.reason?.includes("Only administrators or the original author"));
    assert.equal(decision.cleanedText, "Interrupt Alice's answer with my question");
});

test("SteeringPolicy allows owner and active turn author to interrupt an ongoing turn", () => {
    const policy = new SteeringPolicy();

    const authorDecision = policy.evaluate({
        text: "Stop and switch approach",
        mode: "interrupt",
        actor: AUTHOR_USER,
        activeTurnAuthorId: AUTHOR_USER.id,
    });

    assert.equal(authorDecision.allowInterrupt, true);
    assert.equal(authorDecision.whenBusy, "steer");
    assert.equal(authorDecision.steerRequested, true);
    assert.equal(authorDecision.steerGranted, true);

    const adminDecision = policy.evaluate({
        text: "Stop immediately",
        mode: "interrupt",
        actor: ADMIN_USER,
        activeTurnAuthorId: AUTHOR_USER.id,
    });

    assert.equal(adminDecision.allowInterrupt, true);
    assert.equal(adminDecision.steerGranted, true);
});

test("SteeringPolicy grants interrupt when no turn is active and demotes unauthorized interrupt", () => {
    const policy = new SteeringPolicy();

    const idleDecision = policy.evaluate({
        text: "Urgent question",
        mode: "interrupt",
        actor: OTHER_USER,
        activeTurnAuthorId: undefined,
    });

    assert.equal(idleDecision.allowInterrupt, true);
    assert.equal(idleDecision.steerGranted, true);

    const blockedDecision = policy.evaluate({
        text: "Cancel Alice's work for mine",
        mode: "interrupt",
        actor: OTHER_USER,
        activeTurnAuthorId: AUTHOR_USER.id,
    });

    assert.equal(blockedDecision.allowInterrupt, false);
    assert.equal(blockedDecision.whenBusy, "followUp");
    assert.equal(blockedDecision.steerRequested, true);
    assert.equal(blockedDecision.steerGranted, false);
    assert.ok(blockedDecision.reason?.includes("Only administrators or the original author"));

    const steerOnly = policy.evaluate({
        text: "Steer only",
        mode: "steer",
        actor: AUTHOR_USER,
        activeTurnAuthorId: AUTHOR_USER.id,
    });

    assert.equal(steerOnly.allowInterrupt, false);
    assert.equal(steerOnly.whenBusy, "steer");
});

test("SteeringPolicy treats active unowned run (null) as protected for guests but steerable for owners", () => {
    const policy = new SteeringPolicy();

    const guestBlocked = policy.evaluate({
        text: "Interrupt background job",
        mode: "interrupt",
        actor: OTHER_USER,
        activeTurnAuthorId: null,
    });

    assert.equal(guestBlocked.allowInterrupt, false);
    assert.equal(guestBlocked.whenBusy, "followUp");
    assert.equal(guestBlocked.steerGranted, false);

    const ownerAllowed = policy.evaluate({
        text: "Owner interrupt background job",
        mode: "interrupt",
        actor: ADMIN_USER,
        activeTurnAuthorId: null,
    });

    assert.equal(ownerAllowed.allowInterrupt, true);
    assert.equal(ownerAllowed.steerGranted, true);
});
