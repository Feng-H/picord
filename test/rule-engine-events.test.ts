import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    ConversationRuleEngine,
    InMemoryRuleEngineStore,
    appendEngineEventLog,
    formatEngineEventNote,
    formatRuleStatus,
    type ConversationRule,
    type EngineEvent,
} from "../src/server/rule-engine/index.ts";

test("reloadRules emits rule_added, rule_removed, and rule_modified events with diff details", () => {
    const store = new InMemoryRuleEngineStore();
    const emittedEvents: EngineEvent[] = [];

    const initialRules: ConversationRule[] = [
        {
            id: "rule-keep",
            title: "保持不变的规则",
            channel: "smalltalk",
            on: "silence",
            after: "30m",
            action: { type: "prompt", instruction: "保持不变" },
        },
        {
            id: "rule-modify",
            title: "待修改的规则",
            channel: "smalltalk",
            on: "silence",
            after: "60m",
            action: { type: "prompt", instruction: "旧指令" },
        },
        {
            id: "rule-delete",
            title: "待删除的规则",
            channel: "general",
            on: "silence",
            after: "10m",
            action: { type: "prompt", instruction: "删除" },
        },
    ];

    const engine = new ConversationRuleEngine({
        rules: initialRules,
        store,
        onEvent: (event) => {
            emittedEvents.push(event);
        },
    });

    emittedEvents.length = 0; // Clear initialization events if any

    const newRules: ConversationRule[] = [
        {
            id: "rule-keep",
            title: "保持不变的规则",
            channel: "smalltalk",
            on: "silence",
            after: "30m",
            action: { type: "prompt", instruction: "保持不变" },
        },
        {
            id: "rule-modify",
            title: "待修改的规则（已修改）",
            channel: "smalltalk",
            on: "silence",
            after: "45m",
            action: { type: "prompt", instruction: "新指令", forwardToChannel: "zk-review" },
        },
        {
            id: "rule-new",
            title: "全新规则",
            channel: "dev",
            on: "silence",
            after: "15m",
            action: { type: "prompt", instruction: "新规则任务" },
        },
    ];

    engine.reloadRules(newRules);

    const types = emittedEvents.map((e) => e.type);

    assert.ok(types.includes("rule_added"), "Expected rule_added event for rule-new");
    assert.ok(types.includes("rule_removed"), "Expected rule_removed event for rule-delete");
    assert.ok(types.includes("rule_modified"), "Expected rule_modified event for rule-modify");

    const added = emittedEvents.find((e) => e.type === "rule_added");

    assert.equal(added?.ruleId, "rule-new");
    assert.equal(added?.channel, "dev");

    const removed = emittedEvents.find((e) => e.type === "rule_removed");

    assert.equal(removed?.ruleId, "rule-delete");
    assert.equal(removed?.channel, "general");

    const modified = emittedEvents.find((e) => e.type === "rule_modified");

    assert.equal(modified?.ruleId, "rule-modify");
    assert.equal(modified?.details?.after, "45m");
});

test("advanceCursor emits cursor_advanced event with progression details", () => {
    const store = new InMemoryRuleEngineStore();
    const emittedEvents: EngineEvent[] = [];

    const engine = new ConversationRuleEngine({
        rules: [
            {
                id: "cursor-rule",
                channel: "smalltalk",
                on: "silence",
                after: "30m",
                cursor: { type: "entry_id" },
                action: { type: "prompt", instruction: "游标测试" },
            },
        ],
        store,
        onEvent: (event) => {
            emittedEvents.push(event);
        },
    });

    engine.touch("smalltalk", 1000, 100);
    emittedEvents.length = 0;

    const advanced = engine.advanceCursor("cursor-rule", 100);

    assert.equal(advanced, true);
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0]?.type, "cursor_advanced");
    assert.equal(emittedEvents[0]?.ruleId, "cursor-rule");
    assert.equal(emittedEvents[0]?.details?.prevCursorId, 0);
    assert.equal(emittedEvents[0]?.details?.newCursorId, 100);
});

test("tick emits rule_fired event when silence duration expires", async () => {
    const store = new InMemoryRuleEngineStore();
    const emittedEvents: EngineEvent[] = [];

    const engine = new ConversationRuleEngine({
        rules: [
            {
                id: "fire-rule",
                channel: "smalltalk",
                on: "silence",
                after: "60m",
                action: { type: "prompt", instruction: "执行任务", forwardToChannel: "zk-review" },
            },
        ],
        store,
        onEvent: (event) => {
            emittedEvents.push(event);
        },
    });

    const now = 100_000_000;

    engine.touch("smalltalk", now, 50);
    emittedEvents.length = 0;

    // Tick before 60m: no fire
    await engine.tick(now + 30 * 60 * 1000);
    assert.equal(emittedEvents.length, 0);

    // Tick after 60m: fired
    const firedNow = now + 60 * 60 * 1000 + 1000;

    await engine.tick(firedNow);

    const fired = emittedEvents.find((e) => e.type === "rule_fired");

    assert.ok(fired !== undefined, "Expected rule_fired event");
    assert.equal(fired?.ruleId, "fire-rule");
    assert.equal(fired?.channel, "smalltalk");
    assert.equal(fired?.details?.headEntryId, 50);
    assert.equal(fired?.details?.forwardToChannel, "zk-review");
});

test("touch and activeSchedulesForSession emit schedule_projected event", () => {
    const store = new InMemoryRuleEngineStore();
    const emittedEvents: EngineEvent[] = [];

    const engine = new ConversationRuleEngine({
        rules: [
            {
                id: "proj-rule",
                title: "倒计时任务",
                channel: "smalltalk",
                on: "silence",
                after: "30m",
                action: { type: "prompt", instruction: "测试" },
            },
        ],
        store,
        onEvent: (event) => {
            emittedEvents.push(event);
        },
    });

    emittedEvents.length = 0;
    const now = 200_000_000;

    // touch refreshes projected deadline
    engine.touch("smalltalk", now, 10);

    const projected = emittedEvents.find((e) => e.type === "schedule_projected");

    assert.ok(projected !== undefined, "Expected schedule_projected event on touch");
    assert.equal(projected?.ruleId, "proj-rule");
    assert.equal(projected?.channel, "smalltalk");
    assert.equal(projected?.details?.next, now + 30 * 60 * 1000);
});

test("appendEngineEventLog appends valid JSONL lines to log file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "engine-events-log-"));
    const logPath = join(tempDir, "engine-events.log");

    try {
        const event1: EngineEvent = {
            timestamp: 1732620000000,
            type: "rule_added",
            ruleId: "test-rule",
            channel: "smalltalk",
            details: { title: "测试规则", after: "30m" },
        };

        const event2: EngineEvent = {
            timestamp: 1732620005000,
            type: "rule_fired",
            ruleId: "test-rule",
            channel: "smalltalk",
            details: { cursorEntryId: 10, headEntryId: 25 },
        };

        appendEngineEventLog(logPath, event1);
        appendEngineEventLog(logPath, event2);

        assert.ok(existsSync(logPath));
        const content = readFileSync(logPath, "utf8");
        const lines = content.trim().split("\n");

        assert.equal(lines.length, 2);

        const parsed1 = JSON.parse(lines[0]!);

        assert.equal(parsed1.type, "rule_added");
        assert.equal(parsed1.ruleId, "test-rule");

        const parsed2 = JSON.parse(lines[1]!);

        assert.equal(parsed2.type, "rule_fired");
        assert.equal(parsed2.details.headEntryId, 25);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("formatEngineEventNote outputs concise readable text with [engine] prefix", () => {
    const note1 = formatEngineEventNote({
        timestamp: Date.now(),
        type: "rule_fired",
        ruleId: "smalltalk-card-summary",
        channel: "smalltalk",
        details: { cursorEntryId: 120, headEntryId: 150, forwardToChannel: "zk-review" },
    });

    assert.ok(note1.startsWith("[engine]"));
    assert.ok(note1.includes("已触发"));
    assert.ok(note1.includes("smalltalk-card-summary"));
    assert.ok(note1.includes("120") && note1.includes("150"));

    const note2 = formatEngineEventNote({
        timestamp: Date.now(),
        type: "schedule_projected",
        ruleId: "smalltalk-card-summary",
        channel: "smalltalk",
        details: { title: "卡片整理倒计时", remainingMinutes: 59, next: Date.now() + 3540000 },
    });

    assert.ok(note2.startsWith("[engine]"));
    assert.ok(note2.includes("卡片整理倒计时"));
    assert.ok(note2.includes("到期"));
});

test("formatRuleStatus displays projected schedules with deadline and remaining duration", () => {
    const store = new InMemoryRuleEngineStore();
    const now = 500_000_000;

    const engine = new ConversationRuleEngine({
        rules: [
            {
                id: "smalltalk-card-summary",
                title: "卡片整理倒计时",
                channel: "smalltalk",
                on: "silence",
                after: "60m",
                action: { type: "prompt", instruction: "总结", forwardToChannel: "zk-review" },
            },
        ],
        store,
    });

    engine.touch("smalltalk", now, 20);

    const statusText = formatRuleStatus(engine, now + 10 * 60 * 1000);

    assert.ok(statusText.includes("引擎投影定时任务 (Projected Schedules)"));
    assert.ok(statusText.includes("卡片整理倒计时"));
    assert.ok(statusText.includes("smalltalk-card-summary"));
    assert.ok(statusText.includes("50 分钟"));
});
