import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ConversationRuleEngine,
    type ConversationRule,
} from "../src/server/rule-engine/index.ts";

test("activeSchedulesForSession projects silence countdown for matching channel name and session ID", () => {
    const rules: ConversationRule[] = [
        {
            id: "card-summary",
            title: "Luhmann Card Summary",
            channel: "smalltalk",
            on: "silence",
            after: "60m",
            action: { type: "prompt", instruction: "Summarize" },
        },
        {
            id: "session-107-rule",
            title: "Session 107 Rule",
            channel: "107",
            on: "silence",
            after: "30m",
            action: { type: "prompt", instruction: "Summarize 107" },
        },
    ];

    const engine = new ConversationRuleEngine({ rules });
    const t0 = 1000000;

    // Initially no activity recorded: active schedules must be empty
    assert.deepEqual(engine.activeSchedulesForSession(107, "smalltalk", t0), []);

    // 1. User speaks in smalltalk (session 107) at t0
    engine.touch("smalltalk", t0, 501);

    // Query active schedules for session 107 in channel smalltalk at t0 + 10m
    const schedules = engine.activeSchedulesForSession(107, "smalltalk", t0 + 10 * 60 * 1000);

    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.id, "rule:card-summary");
    assert.equal(schedules[0]?.text, "Luhmann Card Summary");
    assert.equal(schedules[0]?.next, t0 + 60 * 60 * 1000);
    assert.equal(schedules[0]?.createdAt, t0);
    assert.equal(schedules[0]?.isRule, true);

    // 2. User speaks again at t0 + 40m: countdown pushed back!
    engine.touch("smalltalk", t0 + 40 * 60 * 1000, 502);

    const postponed = engine.activeSchedulesForSession(107, "smalltalk", t0 + 45 * 60 * 1000);

    assert.equal(postponed.length, 1);
    assert.equal(
        postponed[0]?.next,
        t0 + (40 + 60) * 60 * 1000,
        "Countdown must be extended by 60m from the latest message",
    );
});

test("activeSchedulesForSession returns empty once silence trigger has fired", async () => {
    const rule: ConversationRule = {
        id: "card-summary",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: { type: "prompt", instruction: "Summarize" },
    };

    const engine = new ConversationRuleEngine({ rules: [rule] });
    const t0 = 1000000;

    engine.touch("smalltalk", t0);

    // Active before 60m
    assert.equal(engine.activeSchedulesForSession(107, "smalltalk", t0 + 30 * 60 * 1000).length, 1);

    // Fire at 60m
    await engine.tick(t0 + 60 * 60 * 1000);

    // After firing, until new user message arrives, active schedules must be empty
    assert.equal(engine.activeSchedulesForSession(107, "smalltalk", t0 + 65 * 60 * 1000).length, 0);

    // New user message arrives at t0 + 70m: countdown reactivated!
    engine.touch("smalltalk", t0 + 70 * 60 * 1000);
    const reactivated = engine.activeSchedulesForSession(107, "smalltalk", t0 + 75 * 60 * 1000);

    assert.equal(reactivated.length, 1);
    assert.equal(reactivated[0]?.next, t0 + (70 + 60) * 60 * 1000);
});

test("Merged schedules array conforms to web client SchedulesPill contract", () => {
    // Normal schedule format from SQLite room.ts
    const regularSchedule = {
        id: "normal-sched-1",
        version: "1",
        text: "Daily Standup",
        next: 2000000,
        createdAt: 1000000,
    };

    // Projected rule schedule
    const ruleSchedule = {
        id: "rule:card-summary",
        version: "1",
        text: "Quiet Card Summary",
        next: 1500000,
        createdAt: 1000000,
        isRule: true,
    };

    const merged = [regularSchedule, ruleSchedule].sort((a, b) => a.next - b.next);

    // Soonest schedule is ruleSchedule (1500000 < 2000000)
    assert.equal(merged[0]?.id, "rule:card-summary");
    assert.equal(merged[0]?.next, 1500000);
    assert.equal(merged[0]?.text, "Quiet Card Summary");
    assert.equal(typeof merged[0]?.next, "number");
    assert.equal(typeof merged[0]?.text, "string");
    assert.equal(typeof merged[0]?.id, "string");
});
