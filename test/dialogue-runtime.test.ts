import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationId, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { NOTE_ENTRY } from "../src/server/entry-format.ts";
import { DialogueRuntime, type DialogueRuntimeHost } from "../src/server/dialogue-runtime.ts";
import type { ConversationRule } from "../src/server/rule-engine/index.ts";
import type { StandardTurnAdapter, SubmitRequest } from "../src/server/turn-pipeline/index.ts";

const OWNER_USER: User = {
    id: "user-owner",
    name: "Owner",
    role: "owner",
    tokenHash: "hash-owner",
    createdAt: Date.now(),
};

const MEMBER_USER: User = {
    id: "user-member",
    name: "Member",
    role: "guest",
    tokenHash: "hash-member",
    createdAt: Date.now(),
};

function makeFakeHost(
    dirs: { dataDir: string; workspaceDir: string },
    rules: ConversationRule[],
): {
    host: DialogueRuntimeHost;
    notesWritten: Array<{ id: ConversationId; action: unknown }>;
    turnsSubmitted: Array<{ id: ConversationId; user: User; request: SubmitRequest; via?: string }>;
    entriesByConv: Map<number, EntryRecord[]>;
    nextAnswerByConv: Map<number, { status: string; type: string; answer: number }>;
    logs: string[];
    resetCounts(): void;
    setRule(next: ConversationRule[]): void;
} {
    let currentRules = rules;
    const notesWritten: Array<{ id: ConversationId; action: unknown }> = [];
    const turnsSubmitted: Array<{ id: ConversationId; user: User; request: SubmitRequest; via?: string }> = [];
    const logs: string[] = [];

    const sessions = new Map<
        number,
        {
            title?: string;
            channel?: boolean;
            archived?: boolean;
            createdBy?: string;
            members?: string[];
            cwd?: string;
        }
    >([
        [1, { title: "#general", channel: true, createdBy: OWNER_USER.id }],
        [
            2,
            {
                title: "#digest",
                channel: true,
                createdBy: MEMBER_USER.id,
                members: [OWNER_USER.id],
            },
        ],
        [3, { title: "Private DM", channel: false, createdBy: MEMBER_USER.id }],
        [4, { title: "#member-private", channel: true, createdBy: MEMBER_USER.id }],
    ]);

    const entriesByConv = new Map<number, EntryRecord[]>();
    const nextAnswerByConv = new Map<number, { status: string; type: string; answer: number }>();
    let subSeq = 100;

    const standardAdapter: StandardTurnAdapter = {
        prepareTurn: async () => ({ supportsImages: false }),
        formatBody: (actor, written) => `${actor.name}: ${written}`,
        dispatchDurable: async (input) => ({
            submissionId: `sub-${++subSeq}` as unknown as SubmissionId,
            knownRetry: false,
            finalActor: input.actor,
        }),
    };

    const host: DialogueRuntimeHost = {
        dataDir: dirs.dataDir,
        workspaceDir: dirs.workspaceDir,
        build: "test-build",
        pid: 9999,
        tickIntervalMs: null,
        watchFiles: false,
        loadRules: () => currentRules,
        listSessions: () =>
            Array.from(sessions.entries()).map(([id, meta]) => ({ id, ...meta })),
        sessionMeta: (id) => sessions.get(Number(id)),
        createChannelSession: async (user, options) => {
            const id = (sessions.size + 1) as unknown as ConversationId;

            sessions.set(Number(id), {
                title: options.title,
                channel: true,
                createdBy: user.id,
                cwd: options.cwd,
            });

            return { id };
        },
        userById: (id) => [OWNER_USER, MEMBER_USER].find((u) => u.id === id),
        listUsers: () => [OWNER_USER, MEMBER_USER],
        fallbackUser: () => OWNER_USER,
        requireSee: () => {},
        requireSteer: () => {},
        conversation: async (id) => ({
            submit: async (action) => {
                notesWritten.push({ id, action });

                return { id: `note-${notesWritten.length}` };
            },
        }),
        readTranscriptEntries: async (id) => entriesByConv.get(id) ?? [],
        entriesAfter: async (id, cursorEntryId) => {
            const list = (entriesByConv.get(Number(id)) ?? []).filter(
                (entry) => Number(entry.id) > cursorEntryId,
            );
            const last = list.at(-1)?.id !== undefined ? Number(list.at(-1)!.id) : cursorEntryId;

            return { entries: list, last };
        },
        visibleEntry: async (id, entryId) =>
            (entriesByConv.get(Number(id)) ?? []).find((entry) => Number(entry.id) === entryId),
        submitTurn: async (id, user, request, via) => {
            turnsSubmitted.push({ id, user, request, via });
            const outcome = nextAnswerByConv.get(Number(id));

            return {
                submissionId: `turn-${turnsSubmitted.length}` as unknown as SubmissionId,
                requestId: request.requestId,
                wait: outcome === undefined ? undefined : Promise.resolve(outcome),
            };
        },
        standardTurnAdapter: () => standardAdapter,
        log: (line) => logs.push(line),
    };

    return {
        host,
        notesWritten,
        turnsSubmitted,
        entriesByConv,
        nextAnswerByConv,
        logs,
        resetCounts: () => {
            notesWritten.length = 0;
            turnsSubmitted.length = 0;
        },
        setRule: (next) => {
            currentRules = next;
        },
    };
}

function makeTempDirs(): { dataDir: string; workspaceDir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "picord-dialogue-runtime-"));
    const dataDir = join(root, "data");
    const workspaceDir = join(root, "ws");

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    return {
        dataDir,
        workspaceDir,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

test("DialogueRuntime executes /rule commands through TurnPipeline and logs engine notes", async () => {
    const dirs = makeTempDirs();
    const initialRules: ConversationRule[] = [
        {
            id: "summarize-general",
            channel: "general",
            on: "silence",
            after: "10m",
            action: { type: "prompt", instruction: "Summarize progress" },
        },
    ];
    const { host, notesWritten, setRule } = makeFakeHost(dirs, initialRules);
    const runtime = new DialogueRuntime(host);

    try {
        // Initial engine_version_changed event is logged cleanly without crashing
        assert.ok(runtime.ruleEngine.rules.length === 1);

        const listResult = await runtime.turnPipeline.submit(
            1 as unknown as ConversationId,
            OWNER_USER,
            { text: "/rule list", requestId: "r-1" },
        );

        assert.equal(listResult.isLocalCommand, true);
        assert.equal(notesWritten.length, 1);
        const listNote = notesWritten[0]!.action as {
            entry: { kind: string; data: { text: string } };
        };

        assert.equal(listNote.entry.kind, NOTE_ENTRY);
        assert.ok(listNote.entry.data.text.includes("summarize-general"));

        setRule([
            ...initialRules,
            {
                id: "summarize-digest",
                channel: "digest",
                on: "silence",
                after: "5m",
                action: { type: "prompt", instruction: "Recap" },
            },
        ]);

        await runtime.turnPipeline.submit(1 as unknown as ConversationId, OWNER_USER, {
            text: "/rule reload",
            requestId: "r-2",
        });

        assert.equal(runtime.ruleEngine.rules.length, 2);
        // Reload emits rule_added event which injects [engine] note into #digest and writes both JSONL logs
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(
            notesWritten.some(
                (item) =>
                    Number(item.id) === 2 &&
                    (item.action as { entry: { data: { text: string } } }).entry.data.text.includes(
                        "summarize-digest",
                    ),
            ),
        );

        const wsLog = readFileSync(join(dirs.workspaceDir, ".dialogue-session", "engine-events.log"), "utf8");
        const dataLog = readFileSync(join(dirs.dataDir, "engine-events.log"), "utf8");

        assert.ok(wsLog.includes("engine_version_changed"));
        assert.ok(wsLog.includes("rule_added"));
        assert.ok(dataLog.includes("rule_added"));

        // Verify /rule status and default help branches
        notesWritten.length = 0;
        await runtime.turnPipeline.submit(1 as unknown as ConversationId, OWNER_USER, {
            text: "/rule status",
            requestId: "r-3",
        });
        await runtime.turnPipeline.submit(1 as unknown as ConversationId, OWNER_USER, {
            text: "/rule",
            requestId: "r-4",
        });
        assert.equal(notesWritten.length, 2);
        assert.ok(
            (notesWritten[0]!.action as { entry: { data: { text: string } } }).entry.data.text.includes(
                "summarize-general",
            ),
        );
        assert.ok(
            (notesWritten[1]!.action as { entry: { data: { text: string } } }).entry.data.text.includes(
                "/rule list",
            ),
        );
    } finally {
        runtime.close();
        dirs.cleanup();
    }
});

test("DialogueRuntime enforces channel permissions, creation, and listing", async () => {
    const dirs = makeTempDirs();
    const { host, turnsSubmitted } = makeFakeHost(dirs, []);
    let allowSee = true;

    host.requireSee = () => {
        if (!allowSee) {
            throw new Error("403 forbidden");
        }
    };

    const runtime = new DialogueRuntime(host);

    try {
        const created = await runtime.channels.create("alerts", OWNER_USER.id);

        assert.equal(created.name, "alerts");
        assert.ok(runtime.channels.list().some((c) => c.name === "alerts"));

        await runtime.channels.post(1 as unknown as ConversationId, "digest", "Deployment done");
        assert.equal(turnsSubmitted.length, 1);
        assert.equal(Number(turnsSubmitted[0]!.id), 2);
        assert.equal(turnsSubmitted[0]!.request.text, "[via #general]\nDeployment done");
        assert.equal(turnsSubmitted[0]!.via, "channel #digest (via #general)");

        // Private channel owned by another user is invisible to #general's owner
        await assert.rejects(
            () => runtime.channels.post(1 as unknown as ConversationId, "member-private", "Secret"),
            /No live channel called #member-private is here/,
        );

        allowSee = false;
        await assert.rejects(
            () => runtime.channels.post(1 as unknown as ConversationId, "digest", "Blocked"),
            /403 forbidden/,
        );
        assert.equal(turnsSubmitted.length, 1);
    } finally {
        runtime.close();
        dirs.cleanup();
    }
});

test("DialogueRuntime skips empty deltas, unanswered runs, and path-traversal archive files", async () => {
    const dirs = makeTempDirs();
    const { host, turnsSubmitted, entriesByConv, nextAnswerByConv, logs } = makeFakeHost(dirs, [
        {
            id: "r-skip",
            channel: "general",
            on: "silence",
            after: "10m",
            action: { type: "prompt", instruction: "Summarize" },
        },
    ]);
    const runtime = new DialogueRuntime(host);

    try {
        // 1. Empty entry delta -> skips dispatch
        await runtime.handleRuleDispatchedTask({
            ruleId: "r-skip",
            channel: "general",
            instruction: "Summarize",
            cursorEntryId: 0,
            headEntryId: 0,
            triggeredAt: Date.now(),
        });
        assert.equal(turnsSubmitted.length, 0);

        // 2. Unanswered run -> cursor stays undefined, no forward post, no marker
        entriesByConv.set(1, [
            { id: 5 as unknown as EntryRecord["id"], kind: "input", model: [] } as unknown as EntryRecord,
        ]);
        nextAnswerByConv.set(1, { status: "unanswered", type: "input", answer: 5 });

        await runtime.handleRuleDispatchedTask({
            ruleId: "r-skip",
            channel: "general",
            instruction: "Summarize",
            cursorEntryId: 0,
            headEntryId: 5,
            forwardToChannel: "digest",
            triggeredAt: Date.now(),
        });
        assert.equal(turnsSubmitted.length, 1);
        assert.equal(runtime.ruleEngine.getState("r-skip")?.cursorEntryId, undefined);

        // 3. Path traversal archiveFile is rejected safely
        entriesByConv.set(1, [
            {
                id: 6 as unknown as EntryRecord["id"],
                kind: "pi.message",
                model: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
            } as unknown as EntryRecord,
        ]);
        nextAnswerByConv.set(1, { status: "completed", type: "input", answer: 6 });

        await runtime.handleRuleDispatchedTask({
            ruleId: "r-skip",
            channel: "general",
            instruction: "Summarize",
            cursorEntryId: 5,
            headEntryId: 6,
            archiveFile: "../outside.md",
            triggeredAt: Date.now(),
        });
        assert.ok(logs.some((line) => line.includes("refused archive path outside workspace")));
    } finally {
        runtime.close();
        dirs.cleanup();
    }
});

test("DialogueRuntime handleRuleDispatchedTask summarizes, advances cursor, forwards to channel, and marks archive", async () => {
    const dirs = makeTempDirs();
    const { host, turnsSubmitted, entriesByConv, nextAnswerByConv } = makeFakeHost(dirs, [
        {
            id: "auto-archive",
            channel: "general",
            on: "silence",
            after: "10m",
            action: {
                type: "prompt",
                instruction: "Summarize decisions",
                forwardToChannel: "digest",
                archiveFile: "summary.md",
            },
        },
    ]);

    writeFileSync(join(dirs.workspaceDir, "summary.md"), "# Notes\nLine 1\n");
    entriesByConv.set(1, [
        {
            id: 10 as unknown as EntryRecord["id"],
            kind: "input",
            model: [{ role: "user", content: [{ type: "text", text: "Hello team" }] }],
        } as unknown as EntryRecord,
        {
            id: 11 as unknown as EntryRecord["id"],
            kind: "pi.message",
            model: [{ role: "assistant", content: [{ type: "text", text: "Key decision: Ship C3" }] }],
        } as unknown as EntryRecord,
    ]);
    nextAnswerByConv.set(1, { status: "completed", type: "input", answer: 11 });

    const runtime = new DialogueRuntime(host);

    try {
        await runtime.handleRuleDispatchedTask({
            ruleId: "auto-archive",
            channel: "general",
            instruction: "Summarize decisions",
            cursorEntryId: 5,
            headEntryId: 11,
            forwardToChannel: "digest",
            archiveFile: "summary.md",
            triggeredAt: Date.now(),
        });

        // 1. Prompt injected into #general, 2. Forwarded summary posted to #digest
        assert.equal(turnsSubmitted.length, 2);
        assert.equal(Number(turnsSubmitted[0]!.id), 1);
        assert.equal(turnsSubmitted[0]!.via, "rule:auto-archive");
        assert.equal(Number(turnsSubmitted[1]!.id), 2);
        assert.ok(turnsSubmitted[1]!.request.text.includes("Key decision: Ship C3"));

        // Cursor advanced to 11
        assert.equal(runtime.ruleEngine.getState("auto-archive")?.cursorEntryId, 11);

        // Archive marker appended
        const archive = readFileSync(join(dirs.workspaceDir, "summary.md"), "utf8");

        assert.ok(archive.includes(">>>SUMMARIZED<<<"));
    } finally {
        runtime.close();
        dirs.cleanup();
    }
});

test("DialogueRuntime ignores late dispatches, reloads, and events after close()", async () => {
    const dirs = makeTempDirs();
    let ruleLoads = 0;
    const { host, turnsSubmitted, notesWritten, entriesByConv, setRule } = makeFakeHost(dirs, [
        {
            id: "r1",
            channel: "general",
            on: "silence",
            after: "10m",
            action: { type: "prompt", instruction: "Check" },
        },
    ]);

    host.tickIntervalMs = 20;

    host.loadRules = () => {
        ruleLoads += 1;

        return [
            {
                id: "r1",
                channel: "general",
                on: "silence",
                after: "10m",
                action: { type: "prompt", instruction: "Check" },
            },
        ];
    };

    entriesByConv.set(1, [
        { id: 1 as unknown as EntryRecord["id"], kind: "input", model: [] } as unknown as EntryRecord,
    ]);

    const runtime = new DialogueRuntime(host);
    const loadsBeforeClose = ruleLoads;

    runtime.close();
    runtime.close(); // idempotent

    // Reload and engine event after close become no-ops
    setRule([]);
    runtime.reloadRules();
    assert.equal(ruleLoads, loadsBeforeClose);

    await runtime.handleEngineEvent({
        timestamp: Date.now(),
        type: "rule_fired",
        channel: "general",
        ruleId: "r1",
        details: {},
    });
    assert.equal(notesWritten.length, 0);

    await runtime.handleRuleDispatchedTask({
        ruleId: "r1",
        channel: "general",
        instruction: "Check",
        cursorEntryId: 0,
        headEntryId: 1,
        triggeredAt: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(turnsSubmitted.length, 0, "Closed DialogueRuntime must not submit tasks");
    dirs.cleanup();
});
