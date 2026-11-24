import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    ConversationRuleEngine,
    InMemoryRuleEngineStore,
    watchRuleFiles,
    formatRuleStatus,
    type ConversationRule,
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
