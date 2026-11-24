import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    ConversationRuleEngine,
    InMemoryRuleEngineStore,
    formatSummarizedMarker,
    appendSummarizedMarker,
    formatRulePrompt,
    type DispatchedTask,
    type ConversationRule,
} from "../src/server/rule-engine/index.ts";

test("formatSummarizedMarker produces expected human-readable format", () => {
    const fixedDate = new Date("2026-11-24T21:12:00");
    const marker = formatSummarizedMarker(fixedDate);

    assert.equal(marker, ">>>SUMMARIZED<<< 2026-11-24 21:12");
});

test("appendSummarizedMarker preserves and appends marker to markdown file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rule-marker-test-"));
    const filePath = join(tempDir, "viewpoints.md");

    try {
        writeFileSync(filePath, "# Viewpoints\n- Initial viewpoint.\n", "utf8");

        const testDate = new Date("2026-11-24T22:30:00");

        appendSummarizedMarker(filePath, testDate);

        const updated = readFileSync(filePath, "utf8");

        assert.ok(updated.includes("# Viewpoints\n- Initial viewpoint.\n>>>SUMMARIZED<<< 2026-11-24 22:30\n"));
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("formatRulePrompt formats deterministic entry range boundary", () => {
    const task: DispatchedTask = {
        ruleId: "smalltalk-card-summary",
        channel: "smalltalk",
        instruction: "整理观点并生成卡片",
        cursorEntryId: 42,
        headEntryId: 99,
        forwardToChannel: "zk-review",
        triggeredAt: Date.now(),
    };

    const prompt = formatRulePrompt(task, 42, 99);

    assert.ok(prompt.includes("[系统规则触发：smalltalk-card-summary]"));
    assert.ok(prompt.includes("(42, 99]"));
    assert.ok(prompt.includes("整理观点并生成卡片"));
    assert.ok(prompt.includes("#zk-review"));
});

test("ConversationRuleEngine tracks monotonically increasing cursorEntryId", () => {
    const store = new InMemoryRuleEngineStore();
    const rules: ConversationRule[] = [
        {
            id: "rule-cursor-test",
            channel: "smalltalk",
            on: "silence",
            after: "10m",
            cursor: { type: "entry_id" },
            action: {
                type: "prompt",
                instruction: "测试任务",
                forwardToChannel: "zk-review",
            },
        },
    ];

    const engine = new ConversationRuleEngine({ rules, store });

    // Initial state
    assert.equal(engine.getState("rule-cursor-test")?.cursorEntryId, undefined);

    // Touch records head entry ID
    engine.touch("smalltalk", 1000, 50);
    assert.equal(engine.getState("rule-cursor-test")?.headEntryId, 50);

    // Touch with higher entry ID advances headEntryId
    engine.touch("smalltalk", 2000, 75);
    assert.equal(engine.getState("rule-cursor-test")?.headEntryId, 75);

    // Touch with lower entry ID does NOT regress headEntryId
    engine.touch("smalltalk", 3000, 60);
    assert.equal(engine.getState("rule-cursor-test")?.headEntryId, 75);

    // Advance cursor to 50 succeeds
    const ok1 = engine.advanceCursor("rule-cursor-test", 50);

    assert.equal(ok1, true);
    assert.equal(engine.getState("rule-cursor-test")?.cursorEntryId, 50);

    // Attempting to advance cursor backwards (to 40) is rejected
    const ok2 = engine.advanceCursor("rule-cursor-test", 40);

    assert.equal(ok2, false);
    assert.equal(engine.getState("rule-cursor-test")?.cursorEntryId, 50);

    // Attempting to advance cursor to same value (50) is rejected (strictly monotonic)
    const ok3 = engine.advanceCursor("rule-cursor-test", 50);

    assert.equal(ok3, false);
    assert.equal(engine.getState("rule-cursor-test")?.cursorEntryId, 50);

    // Advancing cursor forward to 75 succeeds
    const ok4 = engine.advanceCursor("rule-cursor-test", 75);

    assert.equal(ok4, true);
    assert.equal(engine.getState("rule-cursor-test")?.cursorEntryId, 75);
});

test("tick populates cursorEntryId and headEntryId in dispatched task", async () => {
    const dispatched: DispatchedTask[] = [];
    const rules: ConversationRule[] = [
        {
            id: "rule-dispatch-cursor",
            channel: "smalltalk",
            on: "silence",
            after: 1000,
            cursor: { type: "entry_id" },
            action: {
                type: "prompt",
                instruction: "生成卡片",
                forwardToChannel: "zk-review",
            },
        },
    ];

    const engine = new ConversationRuleEngine({
        rules,
        onDispatch: (t) => {
            dispatched.push(t);
        },
    });

    engine.touch("smalltalk", 1000, 120);
    engine.advanceCursor("rule-dispatch-cursor", 100);

    // Tick before timeout
    await engine.tick(1500);
    assert.equal(dispatched.length, 0);

    // Tick at silence threshold (1000 + 1000 = 2000)
    await engine.tick(2000);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.cursorEntryId, 100);
    assert.equal(dispatched[0]!.headEntryId, 120);
    assert.equal(dispatched[0]!.forwardToChannel, "zk-review");
});

test("End-to-end quiet-to-summary execution pipeline and channel dispatch", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rule-e2e-test-"));
    const archivePath = join(tempDir, "viewpoints.md");

    writeFileSync(archivePath, "# Dialogue Viewpoints\n- Point 1\n", "utf8");

    const postedToChannels: Array<{ target: string; message: string }> = [];
    const submittedTurns: Array<{ channel: string; prompt: string }> = [];

    const store = new InMemoryRuleEngineStore();
    const rules: ConversationRule[] = [
        {
            id: "smalltalk-card-summary",
            channel: "smalltalk",
            on: "silence",
            after: "30s",
            cursor: { type: "entry_id" },
            action: {
                type: "prompt",
                instruction: "读取增量对话并整理为卢曼卡片推送至 #zk-review",
                forwardToChannel: "zk-review",
                archiveFile: archivePath,
            },
        },
    ];

    let engine: ConversationRuleEngine;

    // Simulate harness execution handler
    const mockExecutionHandler = async (task: DispatchedTask) => {
        const headEntryId = task.headEntryId ?? 88;
        const prompt = formatRulePrompt(task, task.cursorEntryId ?? 0, headEntryId);

        submittedTurns.push({ channel: task.channel, prompt });

        // Simulate turn completion & answer generation
        const mockGeneratedSummary = "### ZK-2026-15: 声明式规则引擎保障静默总结";

        // Advance cursor upon completion
        engine.advanceCursor(task.ruleId, headEntryId);

        // Forward to channel
        if (task.forwardToChannel) {
            postedToChannels.push({
                target: task.forwardToChannel,
                message: mockGeneratedSummary,
            });
        }

        // Append marker
        if (task.archiveFile) {
            appendSummarizedMarker(task.archiveFile, new Date("2026-11-24T23:00:00"));
        }
    };

    engine = new ConversationRuleEngine({
        rules,
        store,
        onDispatch: async (task) => {
            await mockExecutionHandler(task);
        },
    });

    try {
        // Step 1: User speaks in smalltalk with entryId 88
        const startTime = 10000;

        engine.touch("smalltalk", startTime, 88);

        assert.equal(engine.getState("smalltalk-card-summary")?.cursorEntryId, undefined);
        assert.equal(engine.getState("smalltalk-card-summary")?.headEntryId, 88);

        // Step 2: 15s elapsed (silence duration is 30s) -> should NOT fire
        await engine.tick(startTime + 15000);
        assert.equal(submittedTurns.length, 0);
        assert.equal(postedToChannels.length, 0);

        // Step 3: 30s elapsed -> silence trigger fires!
        await engine.tick(startTime + 30000);

        // Verify task prompt was injected with boundary (0, 88]
        assert.equal(submittedTurns.length, 1);
        assert.ok(submittedTurns[0]!.prompt.includes("(0, 88]"));
        assert.ok(submittedTurns[0]!.prompt.includes("读取增量对话并整理为卢曼卡片推送至 #zk-review"));

        // Verify cursor advanced safely to 88
        assert.equal(engine.getState("smalltalk-card-summary")?.cursorEntryId, 88);

        // Verify forwarded to #zk-review
        assert.equal(postedToChannels.length, 1);
        assert.equal(postedToChannels[0]!.target, "zk-review");
        assert.ok(postedToChannels[0]!.message.includes("ZK-2026-15"));

        // Verify >>>SUMMARIZED<<< marker in markdown archive
        const archiveContent = readFileSync(archivePath, "utf8");

        assert.ok(archiveContent.includes(">>>SUMMARIZED<<< 2026-11-24 23:00"));

        // Step 4: Continued silence does NOT fire again (idempotent)
        await engine.tick(startTime + 60000);
        assert.equal(submittedTurns.length, 1);

        // Step 5: New user message at entry 105
        engine.touch("smalltalk", startTime + 70000, 105);
        assert.equal(engine.getState("smalltalk-card-summary")?.headEntryId, 105);

        // Step 6: 30s after new message -> fires with new boundary (88, 105]!
        await engine.tick(startTime + 70000 + 30000);
        assert.equal(submittedTurns.length, 2);
        assert.ok(submittedTurns[1]!.prompt.includes("(88, 105]"));
        assert.equal(engine.getState("smalltalk-card-summary")?.cursorEntryId, 105);
        assert.equal(postedToChannels.length, 2);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
