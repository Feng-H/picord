import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ConversationRuleEngine,
    InMemoryRuleEngineStore,
    parseDuration,
    type ConversationRule,
    type DispatchedTask,
} from "../src/server/rule-engine/index.ts";

test("parseDuration parses human-readable units accurately", () => {
    assert.equal(parseDuration("30s"), 30 * 1000);
    assert.equal(parseDuration("60m"), 60 * 60 * 1000);
    assert.equal(parseDuration("1h"), 60 * 60 * 1000);
    assert.equal(parseDuration("2d"), 2 * 24 * 60 * 60 * 1000);
    assert.equal(parseDuration(5000), 5000);
    assert.throws(() => parseDuration("invalid"), /Invalid duration format/);
    assert.throws(() => parseDuration("-10m"), /Duration must be positive/);
});

test("Rule Engine initialization and rule validation", () => {
    const invalidRule: any = {
        id: "bad-rule",
        channel: "smalltalk",
        on: "unknown",
        after: "60m",
        action: { type: "prompt", instruction: "test" },
    };

    assert.throws(
        () => new ConversationRuleEngine({ rules: [invalidRule] }),
        /Unsupported trigger type/,
    );
});

test("Silence Trigger fires when silence threshold is reached", async () => {
    const dispatched: DispatchedTask[] = [];
    const rule: ConversationRule = {
        id: "summarize-cards",
        title: "Luhmann Card Summary",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: {
            type: "prompt",
            instruction: "Extract cards from recent dialogue",
            forwardToChannel: "zk-review",
        },
    };

    const engine = new ConversationRuleEngine({
        rules: [rule],
        onDispatch: (task) => {
            dispatched.push(task);
        },
    });

    const t0 = 1000000;

    // 1. User speaks at t0
    engine.touch("smalltalk", t0, 101);

    // 2. Tick at t0 + 30m (not enough silence)
    const tasks30 = await engine.tick(t0 + 30 * 60 * 1000);

    assert.equal(tasks30.length, 0);
    assert.equal(dispatched.length, 0);

    // 3. Tick at t0 + 59m (still 1 minute remaining)
    const tasks59 = await engine.tick(t0 + 59 * 60 * 1000);

    assert.equal(tasks59.length, 0);

    // 4. Tick at t0 + 60m (silence threshold reached!)
    const tasks60 = await engine.tick(t0 + 60 * 60 * 1000);

    assert.equal(tasks60.length, 1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.ruleId, "summarize-cards");
    assert.equal(dispatched[0]?.channel, "smalltalk");
    assert.equal(dispatched[0]?.forwardToChannel, "zk-review");
});

test("Silence Trigger idempotency: does not fire repeatedly during continued silence", async () => {
    const dispatched: DispatchedTask[] = [];
    const rule: ConversationRule = {
        id: "summarize-cards",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: { type: "prompt", instruction: "Summarize" },
    };

    const engine = new ConversationRuleEngine({
        rules: [rule],
        onDispatch: (t) => {
            dispatched.push(t);
        },
    });

    const t0 = 1000000;

    engine.touch("smalltalk", t0);

    // Fire at 60m
    await engine.tick(t0 + 60 * 60 * 1000);
    assert.equal(dispatched.length, 1);

    // Subsequent ticks at 61m, 70m, 120m without new user activity must NO-OP
    await engine.tick(t0 + 61 * 60 * 1000);
    await engine.tick(t0 + 70 * 60 * 1000);
    await engine.tick(t0 + 120 * 60 * 1000);
    assert.equal(dispatched.length, 1, "Must never fire repeatedly during same silence window");
});

test("User activity postpones/debounces the silence countdown", async () => {
    const dispatched: DispatchedTask[] = [];
    const rule: ConversationRule = {
        id: "summarize-cards",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: { type: "prompt", instruction: "Summarize" },
    };

    const engine = new ConversationRuleEngine({
        rules: [rule],
        onDispatch: (t) => {
            dispatched.push(t);
        },
    });

    const t0 = 1000000;

    // Initial activity at t0
    engine.touch("smalltalk", t0);

    // User speaks again at t0 + 40m (postponing the silence trigger)
    engine.touch("smalltalk", t0 + 40 * 60 * 1000);

    // At t0 + 60m (only 20m since last activity), must NOT fire!
    const tasks60 = await engine.tick(t0 + 60 * 60 * 1000);

    assert.equal(tasks60.length, 0);
    assert.equal(dispatched.length, 0);

    // At t0 + 99m (59m since last activity), must NOT fire!
    const tasks99 = await engine.tick(t0 + 99 * 60 * 1000);

    assert.equal(tasks99.length, 0);

    // At t0 + 100m (exactly 60m after the second activity at t0 + 40m), it fires!
    const tasks100 = await engine.tick(t0 + 100 * 60 * 1000);

    assert.equal(tasks100.length, 1);
    assert.equal(dispatched.length, 1);
});

test("Channel isolation: activity in one channel does not affect another channel", async () => {
    const dispatched: DispatchedTask[] = [];
    const rules: ConversationRule[] = [
        {
            id: "rule-smalltalk",
            channel: "smalltalk",
            on: "silence",
            after: "60m",
            action: { type: "prompt", instruction: "Smalltalk summary" },
        },
        {
            id: "rule-general",
            channel: "general",
            on: "silence",
            after: "60m",
            action: { type: "prompt", instruction: "General summary" },
        },
    ];

    const engine = new ConversationRuleEngine({
        rules,
        onDispatch: (t) => {
            dispatched.push(t);
        },
    });

    const t0 = 1000000;

    engine.touch("smalltalk", t0);
    engine.touch("general", t0);

    // User speaks in general at t0 + 50m, but stays silent in smalltalk
    engine.touch("general", t0 + 50 * 60 * 1000);

    // Tick at t0 + 60m: smalltalk should fire, general should NOT fire
    const tasks = await engine.tick(t0 + 60 * 60 * 1000);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.channel, "smalltalk");
});

test("Status line activeSchedules projection matches web SchedulesPill contract", () => {
    const rule: ConversationRule = {
        id: "summarize-cards",
        title: "Card Summary Countdown",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: { type: "prompt", instruction: "Summarize" },
    };

    const engine = new ConversationRuleEngine({ rules: [rule] });
    const t0 = 1000000;

    engine.touch("smalltalk", t0);

    // Check at t0 + 10m: 50m remaining
    const schedules = engine.activeSchedules("smalltalk", t0 + 10 * 60 * 1000);

    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.id, "rule:summarize-cards");
    assert.equal(schedules[0]?.next, t0 + 60 * 60 * 1000);
    assert.equal(schedules[0]?.text, "Card Summary Countdown");
    assert.equal(schedules[0]?.remainingMs, 50 * 60 * 1000);

    // If channel has no activity yet or already fired, schedules is empty
    assert.equal(engine.activeSchedules("unrelated-channel", t0).length, 0);
});

test("Persistence store preserves runtime state across engine instances", async () => {
    const store = new InMemoryRuleEngineStore();
    const rule: ConversationRule = {
        id: "summarize-cards",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: { type: "prompt", instruction: "Summarize" },
    };

    const t0 = 1000000;
    const engine1 = new ConversationRuleEngine({ rules: [rule], store });

    engine1.touch("smalltalk", t0, 500);
    assert.equal(store.getState("summarize-cards")?.lastActivity, t0);

    // Create engine2 using same store (simulating service restart)
    const dispatched: DispatchedTask[] = [];
    const engine2 = new ConversationRuleEngine({
        rules: [rule],
        store,
        onDispatch: (t) => {
            dispatched.push(t);
        },
    });

    // Check schedules immediately recovered
    const schedules = engine2.activeSchedules("smalltalk", t0 + 20 * 60 * 1000);

    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.next, t0 + 60 * 60 * 1000);

    // Tick at t0 + 60m on engine2 fires correctly
    const tasks = await engine2.tick(t0 + 60 * 60 * 1000);

    assert.equal(tasks.length, 1);
    assert.equal(dispatched.length, 1);
});
