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
