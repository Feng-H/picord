import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    ConversationRuleEngine,
    FileRuleEngineStore,
    InMemoryRuleEngineStore,
    loadDefaultRules,
    watchRuleFiles,
    formatRuleStatus,
    type ConversationRule,
    type EngineEvent,
} from "../src/server/rule-engine/index.ts";

test("reloadRules updates rules without clearing existing runtime state", () => {
    const store = new InMemoryRuleEngineStore();
    const initialRules: ConversationRule[] = [
        {
            id: "rule-1",
            title: "规则一",
            channel: "smalltalk",
            on: "silence",
            after: "30m",
            action: { type: "prompt", instruction: "测试一" },
        },
    ];

    const engine = new ConversationRuleEngine({ rules: initialRules, store });

    // Touch and advance cursor
    engine.touch("smalltalk", 1000, 42);
    engine.advanceCursor("rule-1", 42);

    assert.equal(engine.getState("rule-1")?.lastActivity, 1000);
    assert.equal(engine.getState("rule-1")?.cursorEntryId, 42);
    assert.equal(engine.rules.length, 1);

    // Reload with updated rule definition + a new rule
    const updatedRules: ConversationRule[] = [
        {
            id: "rule-1",
            title: "规则一（更新后）",
            channel: "smalltalk",
            on: "silence",
            after: "45m",
            action: { type: "prompt", instruction: "测试一新版", forwardToChannel: "zk-review" },
        },
        {
            id: "rule-2",
            title: "规则二",
            channel: "general",
            on: "silence",
            after: "15m",
            action: { type: "prompt", instruction: "测试二" },
        },
    ];

    engine.reloadRules(updatedRules);

    assert.equal(engine.rules.length, 2);
    assert.equal(engine.rules[0]!.title, "规则一（更新后）");
    assert.equal(engine.rules[0]!.after, "45m");

    // Existing countdown & cursor state remains intact
    assert.equal(engine.getState("rule-1")?.lastActivity, 1000);
    assert.equal(engine.getState("rule-1")?.cursorEntryId, 42);
});

test("watchRuleFiles invokes callback when file is modified", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rule-watch-test-"));
    const ruleFile = join(tempDir, "rules.json");

    writeFileSync(ruleFile, JSON.stringify([{
        id: "watch-rule",
        channel: "test",
        on: "silence",
        after: "10m",
        action: { type: "prompt", instruction: "init" },
    }]), "utf8");

    let reloadedCount = 0;
    const stopWatcher = watchRuleFiles([ruleFile], () => {
        reloadedCount++;
    });

    try {
        // Trigger modification
        writeFileSync(ruleFile, JSON.stringify([{
            id: "watch-rule",
            channel: "test",
            on: "silence",
            after: "20m",
            action: { type: "prompt", instruction: "updated" },
        }]), "utf8");

        // Wait for debounce timeout
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.ok(reloadedCount >= 1, "Expected watchRuleFiles to trigger reload callback");
    } finally {
        stopWatcher();
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("formatRuleStatus generates human-readable status text", () => {
    const rules: ConversationRule[] = [
        {
            id: "status-test",
            title: "测试状态规则",
            channel: "smalltalk",
            on: "silence",
            after: "60m",
            action: { type: "prompt", instruction: "整理卡片", forwardToChannel: "zk-review" },
        },
    ];

    const engine = new ConversationRuleEngine({ rules });

    engine.touch("smalltalk", 100000, 10);
    engine.advanceCursor("status-test", 10);

    const statusText = formatRuleStatus(engine, 100000 + 15 * 60 * 1000);

    assert.ok(statusText.includes("测试状态规则"));
    assert.ok(statusText.includes("#smalltalk"));
    assert.ok(statusText.includes("45"));
    assert.ok(statusText.includes("cursor_entry_id = 10"));
});

test("Issue #25 Bug#2: system/rule submissions do not reset user-scoped silence timer", async () => {
    const rule: ConversationRule = {
        id: "smalltalk-card-summary",
        channel: "smalltalk",
        on: "silence",
        after: "60m",
        action: { type: "prompt", instruction: "Summarize", forwardToChannel: "zk-review" },
    };
    const engine = new ConversationRuleEngine({ rules: [rule] });
    const t0 = 1_000_000;

    engine.touch("smalltalk", t0, 100, "user");
    assert.equal((await engine.tick(t0 + 60 * 60_000)).length, 1);

    // Simulated rule dispatch / AI reply 50ms later must NOT reset silence countdown
    engine.touch("smalltalk", t0 + 60 * 60_000 + 50, 105, "system");
    assert.equal((await engine.tick(t0 + 120 * 60_000 + 1000)).length, 0);
    assert.equal(engine.activeSchedules("smalltalk", t0 + 60 * 60_000 + 1000).length, 0);

    // Next genuine human message arms the countdown again
    engine.touch("smalltalk", t0 + 130 * 60_000, 106, "user");
    assert.equal(engine.activeSchedules("smalltalk", t0 + 130 * 60_000).length, 1);
});

test("Issue #25 Bug#4: empty rules.json disables rules, removes persisted timers, and survives atomic renames", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rule-bug4-test-"));
    const dataDir = join(tempDir, "data");
    const wsDir = join(tempDir, "ws");

    writeFileSync(join(tempDir, "init"), "", "utf8");
    const { mkdirSync } = await import("node:fs");

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(wsDir, ".dialogue-session"), { recursive: true });
    const ruleFile = join(wsDir, ".dialogue-session", "rules.json");

    writeFileSync(ruleFile, "[]", "utf8");

    try {
        // Explicit [] rules.json must return [] rather than resurrecting hardcoded defaults
        assert.deepEqual(loadDefaultRules(dataDir, wsDir), []);

        const events: EngineEvent[] = [];
        const store = new FileRuleEngineStore(dataDir);
        const engine = new ConversationRuleEngine({
            rules: [
                {
                    id: "temp-rule",
                    title: "卡片整理倒计时",
                    channel: "smalltalk",
                    on: "silence",
                    after: "60m",
                    action: { type: "prompt", instruction: "Summarize", forwardToChannel: "zk-review" },
                },
            ],
            store,
            onEvent: (e) => {
                events.push(e);
            },
        });

        engine.touch("smalltalk", 10_000, 50, "user");
        assert.equal(engine.activeSchedules("smalltalk", 10_000).length, 1);

        engine.reloadRules([]);
        assert.equal(engine.activeSchedules("smalltalk", 20_000).length, 0);
        assert.equal(engine.getState("temp-rule"), undefined);
        const persisted = JSON.parse(readFileSync(join(dataDir, "rule-states.json"), "utf8"));

        assert.equal(persisted["temp-rule"], undefined);
        assert.equal(
            events.find((e) => e.type === "rule_removed")?.details.cancelledScheduleId,
            "rule-silence-temp-rule",
        );

        // Atomic rename still triggers watchRuleFiles
        let watchedReloads = 0;
        const stop = watchRuleFiles([ruleFile], () => {
            watchedReloads++;
        });

        try {
            const tmp = join(wsDir, ".dialogue-session", "rules.json.tmp");

            writeFileSync(tmp, "[]", "utf8");
            renameSync(tmp, ruleFile);
            await new Promise((resolve) => setTimeout(resolve, 350));
            assert.ok(watchedReloads >= 1, "Expected atomic rename on rules.json to trigger reload");
        } finally {
            stop();
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("Issue #26: projected schedule Edit/Pause/Cancel maps back to rules.json and rule-states.json", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-pocket-rule-mutate-"));

    try {
        const wsDir = join(tempDir, "ws");
        const dataDir = join(tempDir, "data");
        const rulesDir = join(wsDir, ".dialogue-session");
        const ruleFile = join(rulesDir, "rules.json");
        const { mkdirSync, chmodSync } = await import("node:fs");

        mkdirSync(rulesDir, { recursive: true });
        mkdirSync(dataDir, { recursive: true });

        const siblingRule = {
            id: "sibling-rule",
            title: "Sibling Rule",
            channel: "ops",
            on: "silence",
            after: "45m",
            action: {
                type: "prompt",
                instruction: "Keep sibling untouched",
                silent: true,
                extraNote: "preserve-me",
            },
        };
        const initialRules = [
            {
                id: "card-summary",
                title: "小窗总结",
                channel: "smalltalk",
                on: "silence",
                after: "60m",
                action: {
                    type: "prompt",
                    instruction: "初始总结指令",
                    silent: true,
                },
            },
            siblingRule,
        ];

        writeFileSync(ruleFile, `${JSON.stringify({ rules: initialRules }, null, 2)}\n`, "utf8");

        const store = new FileRuleEngineStore(dataDir);
        const loaded = JSON.parse(readFileSync(ruleFile, "utf8")) as { rules: ConversationRule[] };
        const engine = new ConversationRuleEngine({
            rules: loaded.rules,
            store,
            rulesFile: ruleFile,
        });

        engine.touch("smalltalk", 10_000, 1);

        // 1. Edit text -> updates action.instruction & hot-reloads; preserves sibling rule verbatim
        const updatedText = engine.updateFromScheduleMutation("card-summary", {
            text: "新的总结提示词",
            everyMinutes: 60,
            next: 10_000 + 60 * 60_000,
            hasEvery: true,
        });

        assert.equal(updatedText.action.instruction, "新的总结提示词");
        assert.equal(updatedText.after, "60m");

        const afterTextFile = JSON.parse(readFileSync(ruleFile, "utf8")) as {
            rules: Array<Record<string, unknown>>;
        };

        assert.equal(afterTextFile.rules.length, 2);
        assert.deepEqual(afterTextFile.rules[1], siblingRule);
        assert.equal(
            (afterTextFile.rules[0]!.action as Record<string, unknown>).instruction,
            "新的总结提示词",
        );

        // 2. Edit everyMinutes (60 -> 120) while text equals display title -> does not clobber instruction
        const updatedEvery = engine.updateFromScheduleMutation("card-summary", {
            text: "小窗总结",
            everyMinutes: 120,
            hasEvery: true,
        });

        assert.equal(updatedEvery.after, "120m");
        assert.equal(updatedEvery.action.instruction, "新的总结提示词");

        // 3. next-only mutation without every throws 400
        assert.throws(
            () =>
                engine.updateFromScheduleMutation("card-summary", {
                    text: "should fail",
                    next: 99_999,
                    hasEvery: false,
                }),
            /投影任务由静默规则驱动/,
        );

        // 4. Pause & resume persist across restart and block tick()
        engine.pauseRule("card-summary", true, "John", 20_000);
        await new Promise((resolve) => setTimeout(resolve, 20));

        const storeAfterRestart = new FileRuleEngineStore(dataDir);
        const engineRestarted = new ConversationRuleEngine({
            rules: JSON.parse(readFileSync(ruleFile, "utf8")).rules as ConversationRule[],
            store: storeAfterRestart,
            rulesFile: ruleFile,
        });

        assert.equal(engineRestarted.getState("card-summary")?.pausedBy, "John");
        assert.ok(engineRestarted.getState("card-summary")?.paused !== undefined);
        const pausedSchedules = engineRestarted.activeSchedulesForSession(1, "smalltalk", 20_000);

        assert.equal(pausedSchedules.length, 1);
        assert.ok(pausedSchedules[0]!.paused !== undefined);
        assert.equal((await engineRestarted.tick(20_000 + 200 * 60_000)).length, 0);

        // Resuming schedules countdown without immediately firing
        engineRestarted.pauseRule("card-summary", false, "John", 30_000);
        assert.equal(engineRestarted.getState("card-summary")?.paused, undefined);
        assert.equal((await engineRestarted.tick(30_000)).length, 0);

        // 5. Cancel removes only target rule, preserves sibling rule, and cleans state
        engineRestarted.cancelRule("card-summary");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const afterCancelFile = JSON.parse(readFileSync(ruleFile, "utf8")) as {
            rules: Array<Record<string, unknown>>;
        };

        assert.deepEqual(afterCancelFile.rules, [siblingRule]);
        assert.equal(engineRestarted.getState("card-summary"), undefined);
        assert.equal(engineRestarted.activeSchedules("smalltalk", 40_000).length, 0);

        // 6. Missing rule returns 400 "规则已移除"
        assert.throws(
            () => engineRestarted.pauseRule("card-summary", true, "John"),
            /规则已移除/,
        );
        assert.throws(
            () => engineRestarted.cancelRule("card-summary"),
            /规则已移除/,
        );

        // 7. Unwritable rules.json throws 500 error (never swallowed)
        chmodSync(ruleFile, 0o444);

        try {
            assert.throws(
                () =>
                    engineRestarted.updateFromScheduleMutation("sibling-rule", {
                        everyMinutes: 90,
                        hasEvery: true,
                    }),
                /写入规则文件失败/,
            );
        } finally {
            chmodSync(ruleFile, 0o644);
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
