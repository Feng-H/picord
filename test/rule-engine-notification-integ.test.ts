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
    type EngineEvent,
    type ConversationRule,
} from "../src/server/rule-engine/index.ts";

test("End-to-end engine event dual-channel notification flow", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "engine-notif-integ-"));
    const logPath = join(tempDir, "engine-events.log");
    const injectedNotes: Array<{ channel: string; text: string; author: string }> = [];

    const mockInjectNote = (channel: string, noteText: string) => {
        injectedNotes.push({ channel, text: noteText, author: "Rule Engine" });
    };

    const handleEvent = async (event: EngineEvent) => {
        // Channel 1: Write to log file
        appendEngineEventLog(logPath, event);

        // Channel 2: Inject system note for key events
        const inChannelEvents = new Set(["rule_added", "rule_modified", "rule_fired", "cursor_advanced"]);

        if (event.channel && inChannelEvents.has(event.type)) {
            mockInjectNote(event.channel, formatEngineEventNote(event));
        }
    };

    const store = new InMemoryRuleEngineStore();
    const rules: ConversationRule[] = [
        {
            id: "smalltalk-summary",
            title: "小结倒计时",
            channel: "smalltalk",
            on: "silence",
            after: "30m",
            cursor: { type: "entry_id" },
            action: { type: "prompt", instruction: "总结", forwardToChannel: "zk-review" },
        },
    ];

    const engine = new ConversationRuleEngine({
        rules,
        store,
        onEvent: handleEvent,
    });

    try {
        // 1. Advance cursor
        engine.touch("smalltalk", 1000, 50);
        engine.advanceCursor("smalltalk-summary", 50);

        // 2. Modify rule
        engine.reloadRules([
            {
                id: "smalltalk-summary",
                title: "小结倒计时(已延期)",
                channel: "smalltalk",
                on: "silence",
                after: "60m",
                cursor: { type: "entry_id" },
                action: { type: "prompt", instruction: "新总结", forwardToChannel: "zk-review" },
            },
        ]);

        // 3. Verify Log File (Channel 1)
        assert.ok(existsSync(logPath));
        const logLines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));

        assert.ok(logLines.length >= 2, "Expected multiple event records in log");
        const cursorLog = logLines.find((l) => l.type === "cursor_advanced");

        assert.ok(cursorLog !== undefined);
        assert.equal(cursorLog?.details.newCursorId, 50);

        const modLog = logLines.find((l) => l.type === "rule_modified");

        assert.ok(modLog !== undefined);
        assert.equal(modLog?.details.after, "60m");

        // 4. Verify In-Channel Notes (Channel 2)
        assert.ok(injectedNotes.length >= 2, "Expected in-channel system notes for cursor and modify events");
        assert.ok(injectedNotes.some((n) => n.text.includes("[engine]") && n.text.includes("游标推进")));
        assert.ok(injectedNotes.some((n) => n.text.includes("[engine]") && n.text.includes("已更新")));
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
