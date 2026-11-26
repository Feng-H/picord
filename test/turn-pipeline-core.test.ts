import test from "node:test";
import assert from "node:assert/strict";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { NOTE_ENTRY } from "../src/server/entry-format.ts";
import {
    LocalCommandRegistry,
    TurnPipeline,
    type Attachment,
    type ConversationSubmitter,
    type StandardTurnAdapter,
    type SubmitRequest,
} from "../src/server/turn-pipeline/index.ts";

const TEST_USER: User = {
    id: "user-test",
    name: "Tester",
    role: "owner",
    tokenHash: "hash-123",
    createdAt: Date.now(),
};

function createStubStandardAdapter(overrides: Partial<StandardTurnAdapter> = {}): {
    adapter: StandardTurnAdapter;
    dispatched: Array<{
        conversationId: ConversationId;
        content: string | Array<TextContent | ImageContent>;
        whenBusy: "steer" | "followUp";
        allowInterrupt: boolean;
        requestId: string;
    }>;
    committed: Array<{
        submissionId: SubmissionId;
        typed: string;
        said: string;
        text: string;
    }>;
    notices: Array<{ level: string; message: string }>;
} {
    const dispatched: Array<{
        conversationId: ConversationId;
        content: string | Array<TextContent | ImageContent>;
        whenBusy: "steer" | "followUp";
        allowInterrupt: boolean;
        requestId: string;
    }> = [];
    const committed: Array<{
        submissionId: SubmissionId;
        typed: string;
        said: string;
        text: string;
    }> = [];
    const notices: Array<{ level: string; message: string }> = [];

    const adapter: StandardTurnAdapter = {
        prepareTurn: async () => ({ supportsImages: true }),
        formatBody: (actor, written) => `${actor.name}: ${written}`,
        dispatchDurable: async (input) => {
            dispatched.push({
                conversationId: input.conversationId,
                content: input.content,
                whenBusy: input.whenBusy,
                allowInterrupt: input.allowInterrupt,
                requestId: input.requestId,
            });

            return {
                submissionId: "std-sub-1" as unknown as SubmissionId,
                knownRetry: false,
                finalActor: input.actor,
            };
        },
        onCommitted: async (input) => {
            committed.push({
                submissionId: input.submissionId,
                typed: input.typed,
                said: input.said,
                text: input.text,
            });
        },
        notice: (_id, level, message) => {
            notices.push({ level, message });
        },
        ...overrides,
    };

    return { adapter, dispatched, committed, notices };
}

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

    const res1 = registry.resolve("/rule");

    assert.ok(res1);
    assert.equal(res1.command, "rule");
    assert.equal(res1.args, "");

    const res2 = registry.resolve("/rule status --all");

    assert.ok(res2);
    assert.equal(res2.command, "rule");
    assert.equal(res2.args, "status --all");

    const res3 = registry.resolve("/help");

    assert.ok(res3);
    assert.equal(res3.command, "help");

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

    let authorized = false;
    const { adapter, dispatched } = createStubStandardAdapter({
        authorize: async () => {
            authorized = true;
        },
    });
    const pipeline = new TurnPipeline({
        registry,
        conversationLookup: async () => fakeConversation,
        standard: adapter,
    });

    const request: SubmitRequest = {
        text: "/rule status",
        requestId: "req-123",
    };

    const result = await pipeline.submit(1 as unknown as ConversationId, TEST_USER, request);

    assert.equal(authorized, true);
    assert.equal(result.isLocalCommand, true);
    assert.equal(result.requestId, "req-123");
    assert.equal(dispatched.length, 0, "Standard adapter must not run for local commands");

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

test("TurnPipeline routes standard turn through expansion, masking, MediaProcessor, enrichment, dispatch, and post-commit", async () => {
    const events: string[] = [];
    const audioFile: Attachment = {
        path: "/tmp/voice.ogg",
        name: "voice.ogg",
        mime: "audio/ogg",
        size: 1024,
    };
    const imageFile: Attachment = {
        path: "/tmp/shot.png",
        name: "shot.png",
        mime: "image/png",
        size: 2048,
    };

    const { adapter, dispatched, committed, notices } = createStubStandardAdapter({
        authorize: async () => {
            events.push("authorize");
        },
        expandText: (_id, typed) => {
            events.push("expand");

            return typed.replace("/skill:deploy", "Deploy steps with SECRET_XYZ");
        },
        maskHidden: (_id, text) => text.replaceAll("SECRET_XYZ", "[hidden]"),
        prepareTurn: async () => {
            events.push("prepareTurn");

            return { supportsImages: true };
        },
        media: {
            sttConfigured: () => true,
            readFile: async () => Buffer.from("audio"),
            transcribe: async (_buf, _mime, lang) => {
                assert.equal(lang, "zh");

                return "请检查部署状态";
            },
            isInlineImage: (file) => file.mime.startsWith("image/"),
            processImage: async () => ({
                image: { type: "image", data: "YmFzZTY0", mimeType: "image/png" },
                note: "(resized)",
            }),
        },
        enrichContext: async ({ typed }) => {
            assert.equal(typed, "/skill:deploy @notes.md");

            return {
                about: "<pocket-context session=\"2\"/>",
                quotes: "<pocket-context quotes>[q1]</pocket-context>",
                channels: "<pocket-context channels>#ops</pocket-context>",
                mentionedParts: [{ type: "text", text: "<file>SECRET_XYZ</file>" }],
            };
        },
    });

    const pipeline = new TurnPipeline({
        conversationLookup: async () => ({ submit: async () => ({ id: "noop" }) }),
        standard: adapter,
    });

    const result = await pipeline.submit(42 as unknown as ConversationId, TEST_USER, {
        text: "/skill:deploy @notes.md",
        attachments: [audioFile, imageFile],
        audioLanguage: "zh",
        requestId: "req-std-1",
    });

    assert.equal(result.isLocalCommand, false);
    assert.equal(result.submissionId, "std-sub-1" as unknown as SubmissionId);
    assert.deepEqual(events, ["authorize", "expand", "prepareTurn"]);
    assert.equal(notices.length, 0);
    assert.equal(dispatched.length, 1);

    const parts = dispatched[0]!.content as Array<TextContent | ImageContent>;

    assert.ok(Array.isArray(parts), "Expected multipart content with enrichment and image");

    const textParts = parts.filter((p): p is TextContent => p.type === "text").map((p) => p.text);
    const body = textParts[0]!;

    assert.ok(body.includes("Deploy steps with [hidden] @notes.md"));
    assert.ok(!body.includes("SECRET_XYZ"), "Hidden value must be redacted in body");
    assert.ok(body.includes("🎙 请检查部署状态"));
    assert.ok(body.includes("- /tmp/shot.png (shot.png, image/png, 2048 bytes) (resized)"));
    assert.equal(textParts[1], "<file>[hidden]</file>");
    assert.ok(textParts.includes('<pocket-context session="2"/>'));
    assert.ok(textParts.includes("<pocket-context quotes>[q1]</pocket-context>"));
    assert.ok(textParts.includes("<pocket-context channels>#ops</pocket-context>"));

    const imageParts = parts.filter((p): p is ImageContent => p.type === "image");

    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0]?.data, "YmFzZTY0");

    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.typed, "/skill:deploy @notes.md");
    assert.ok(committed[0]?.said.includes("🎙 请检查部署状态"));
});

test("TurnPipeline gracefully degrades on STT and image processing failures while preserving typed text", async () => {
    const audioFile: Attachment = {
        path: "/tmp/fail.ogg",
        name: "fail.ogg",
        mime: "audio/ogg",
        size: 512,
    };
    const imageFile: Attachment = {
        path: "/tmp/corrupt.png",
        name: "corrupt.png",
        mime: "image/png",
        size: 1024,
    };

    const { adapter, dispatched, committed, notices } = createStubStandardAdapter({
        media: {
            sttConfigured: () => true,
            readFile: async () => Buffer.from("audio"),
            transcribe: async () => {
                throw new Error("STT 503 unavailable");
            },
            isInlineImage: (file) => file.mime.startsWith("image/"),
            processImage: async () => {
                throw new Error("bad PNG header");
            },
        },
    });

    const pipeline = new TurnPipeline({
        conversationLookup: async () => ({ submit: async () => ({ id: "noop" }) }),
        standard: adapter,
    });

    await pipeline.submit(7 as unknown as ConversationId, TEST_USER, {
        text: "Important deployment note",
        attachments: [audioFile, imageFile],
        requestId: "req-degrade-1",
    });

    assert.equal(notices.length, 2);
    assert.equal(notices[0]?.level, "warning");
    assert.ok(notices[0]?.message.includes("Could not transcribe fail.ogg"));
    assert.equal(notices[1]?.level, "warning");
    assert.ok(notices[1]?.message.includes("Could not attach corrupt.png"));

    assert.equal(dispatched.length, 1);
    assert.equal(typeof dispatched[0]!.content, "string");
    const content = dispatched[0]!.content as string;

    assert.ok(content.includes("Important deployment note"));
    assert.ok(content.includes("[warning: audio transcription unavailable for fail.ogg]"));
    assert.ok(content.includes("[image processing failed, kept original file]"));
    assert.equal(committed.length, 1);
});

test("TurnPipeline rejects empty request without attachments", async () => {
    const { adapter, dispatched } = createStubStandardAdapter();
    const pipeline = new TurnPipeline({
        conversationLookup: async () => ({ submit: async () => ({ id: "noop" }) }),
        standard: adapter,
    });

    await assert.rejects(
        () =>
            pipeline.submit(1 as unknown as ConversationId, TEST_USER, {
                text: "   ",
                requestId: "req-empty",
            }),
        /Nothing to send/,
    );
    assert.equal(dispatched.length, 0);
});

test("TurnPipeline demotes unauthorized steer and interrupt against another user's active turn and notifies", async () => {
    const guestBob: User = {
        id: "user-bob",
        name: "Bob",
        role: "guest",
        tokenHash: "hash-bob",
        createdAt: Date.now(),
    };

    const { adapter, dispatched, notices } = createStubStandardAdapter({
        getActiveTurnAuthorId: async () => "user-alice",
    });

    const pipeline = new TurnPipeline({
        conversationLookup: async () => ({ submit: async () => ({ id: "noop" }) }),
        standard: adapter,
    });

    await pipeline.submit(9 as unknown as ConversationId, guestBob, {
        text: "/steer Hijack Alice",
        requestId: "req-bob-steer",
    });

    await pipeline.submit(9 as unknown as ConversationId, guestBob, {
        text: "Cancel Alice",
        mode: "interrupt",
        requestId: "req-bob-interrupt",
    });

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0]?.whenBusy, "followUp");
    assert.equal(dispatched[0]?.allowInterrupt, false);
    assert.equal(dispatched[1]?.whenBusy, "followUp");
    assert.equal(dispatched[1]?.allowInterrupt, false);

    assert.equal(notices.length, 2);
    assert.ok(notices.every((n) => n.message.includes("Only administrators or the original author")));
});

test("TurnPipeline allows owner or active author to interrupt with allowInterrupt: true", async () => {
    const alice: User = {
        id: "user-alice",
        name: "Alice",
        role: "guest",
        tokenHash: "hash-alice",
        createdAt: Date.now(),
    };

    const { adapter, dispatched, notices } = createStubStandardAdapter({
        getActiveTurnAuthorId: async () => "user-alice",
    });

    const pipeline = new TurnPipeline({
        conversationLookup: async () => ({ submit: async () => ({ id: "noop" }) }),
        standard: adapter,
    });

    await pipeline.submit(9 as unknown as ConversationId, alice, {
        text: "Restart my turn",
        mode: "interrupt",
        requestId: "req-alice-interrupt",
    });

    await pipeline.submit(9 as unknown as ConversationId, TEST_USER, {
        text: "Owner override",
        mode: "interrupt",
        requestId: "req-owner-interrupt",
    });

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0]?.allowInterrupt, true);
    assert.equal(dispatched[1]?.allowInterrupt, true);
    assert.equal(notices.length, 0);
});
