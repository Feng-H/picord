import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { NOTE_ENTRY } from "../src/server/entry-format.ts";
import {
    LocalCommandRegistry,
    TurnPipeline,
    type ConversationSubmitter,
    type SubmitRequest,
} from "../src/server/turn-pipeline/index.ts";

const TEST_USER: User = {
    id: "user-test",
    name: "Tester",
    role: "owner",
    tokenHash: "hash-123",
    createdAt: Date.now(),
};

test("LocalCommandRegistry registers and resolves prefix commands with args", () => {
    const registry = new LocalCommandRegistry();

    registry.register("/rule", (ctx) => ({
        reply: `Rule executed: ${ctx.args}`,
        prefixTag: "rule",
    }));

    registry.register("help", () => ({
        reply: "Available commands: /rule, /help",
        prefixTag: "help",
    }));

    // Exact command
    const res1 = registry.resolve("/rule");

    assert.ok(res1);
    assert.equal(res1.command, "rule");
    assert.equal(res1.args, "");

    // Command with args
    const res2 = registry.resolve("/rule status --all");

    assert.ok(res2);
    assert.equal(res2.command, "rule");
    assert.equal(res2.args, "status --all");

    // Help command
    const res3 = registry.resolve("/help");

    assert.ok(res3);
    assert.equal(res3.command, "help");

    // Non-commands
    assert.equal(registry.resolve("hello /rule"), undefined);
    assert.equal(registry.resolve("just normal chat"), undefined);
    assert.equal(registry.resolve("/unknown-cmd"), undefined);
});

test("TurnPipeline executes local command and writes NOTE_ENTRY without LLM", async () => {
    const registry = new LocalCommandRegistry();

    registry.register("/rule", (ctx) => ({
        reply: `Active rules for channel: ${ctx.args}`,
        prefixTag: "rule",
        authorName: "Rule Engine",
    }));

    const writtenEntries: unknown[] = [];
    const fakeConversation: ConversationSubmitter = {
        submit: async (action) => {
            writtenEntries.push(action);

            return { id: "sub-local-1" };
        },
    };

    let standardDispatched = false;
    const pipeline = new TurnPipeline({
        registry,
        conversationLookup: async () => fakeConversation,
        standardDispatcher: async () => {
            standardDispatched = true;

            return {
                submissionId: "std-1" as unknown as SubmissionId,
                requestId: "req-std-1",
            };
        },
    });

    const request: SubmitRequest = {
        text: "/rule status",
        requestId: "req-123",
    };

    const result = await pipeline.submit(
        1 as unknown as ConversationId,
        TEST_USER,
        request,
    );

    assert.equal(result.isLocalCommand, true);
    assert.equal(result.requestId, "req-123");
    assert.equal(standardDispatched, false, "Standard dispatcher must not be invoked for local commands");

    assert.equal(writtenEntries.length, 1);
    const entry = writtenEntries[0] as {
        type: string;
        entry: {
            kind: string;
            data: { text: string; by: string; name: string };
            model: Array<{ role: string; content: Array<{ text: string }> }>;
        };
    };

    assert.equal(entry.type, "write");
    assert.equal(entry.entry.kind, NOTE_ENTRY);
    assert.equal(entry.entry.data.name, "Rule Engine");
    assert.equal(entry.entry.data.text, "Active rules for channel: status");
    assert.equal(entry.entry.model[0]?.content[0]?.text, "[rule] Active rules for channel: status");
});

test("TurnPipeline falls back to standardDispatcher when text is not a command", async () => {
    const registry = new LocalCommandRegistry();

    registry.register("/rule", () => ({ reply: "ok" }));

    let standardDispatched = false;
    const pipeline = new TurnPipeline({
        registry,
        conversationLookup: async () => ({
            submit: async () => ({ id: "noop" }),
        }),
        standardDispatcher: async (convId, actor, req) => {
            standardDispatched = true;

            return {
                submissionId: "std-42" as unknown as SubmissionId,
                requestId: req.requestId,
                isLocalCommand: false,
            };
        },
    });

    const request: SubmitRequest = {
        text: "Can you help me summarize this project?",
        requestId: "req-chat-456",
    };

    const result = await pipeline.submit(
        1 as unknown as ConversationId,
        TEST_USER,
        request,
    );

    assert.equal(result.isLocalCommand, false);
    assert.equal(result.submissionId, "std-42");
    assert.equal(standardDispatched, true);
});
