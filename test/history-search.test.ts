import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { HttpError } from "../src/server/errors.ts";
import {
    type HistoryDataSource,
    HistorySearchEngine,
    type SessionSummary,
} from "../src/server/history-search.ts";

class InMemoryHistoryDataSource implements HistoryDataSource {
    sessions: SessionSummary[] = [];
    entries = new Map<number, EntryRecord[]>();
    readCount = 0;

    getSessions(): SessionSummary[] {
        return this.sessions;
    }

    getSessionMeta(id: number): SessionSummary | undefined {
        return this.sessions.find((s) => s.id === id);
    }

    async readEntries(
        id: number,
        query?: { minEntryId?: number; maxEntryId?: number },
    ): Promise<EntryRecord[]> {
        this.readCount++;
        const all = this.entries.get(id) ?? [];
        const min = query?.minEntryId ?? 0;
        const max = query?.maxEntryId ?? Number.POSITIVE_INFINITY;

        return all.filter((e) => {
            const entryId = Number(e.id);

            return entryId >= min && entryId <= max;
        });
    }
}

function makeEntry(
    id: number,
    text: string,
    role = "user",
    timestamp = 1732450000000,
): EntryRecord {
    return {
        id: id as any,
        conversationId: 1 as any,
        model: [
            {
                role,
                timestamp,
                content: [{ type: "text", text }],
            },
        ],
    } as unknown as EntryRecord;
}

test("HistorySearchEngine throws HttpError 400 on empty query", async () => {
    const ds = new InMemoryHistoryDataSource();
    const engine = new HistorySearchEngine(ds);

    await assert.rejects(
        async () => engine.search(1, "   "),
        (err: unknown) => err instanceof HttpError && err.status === 400,
    );
});

test("HistorySearchEngine searches single conversation and extracts excerpt", async () => {
    const ds = new InMemoryHistoryDataSource();

    ds.sessions = [{ id: 1, title: "project discussion" }];
    ds.entries.set(1, [
        makeEntry(1, "Let us configure the port to 8790 for Docker container.", "user"),
        makeEntry(2, "Confirmed, port 8790 is set up in compose file.", "assistant"),
    ]);

    const engine = new HistorySearchEngine(ds);
    const result = await engine.search(1, "8790", "current");

    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0]?.entryId, 1);
    assert.match(result.matches[0]?.excerpt ?? "", /8790/);
    assert.match(result.formatted, /2 matches for "8790"/);
});

test("HistorySearchEngine supports channel-first scoping: #name, channels, and chats", async () => {
    const ds = new InMemoryHistoryDataSource();

    ds.sessions = [
        { id: 1, title: "ops", channel: true },
        { id: 2, title: "general", channel: true },
        { id: 3, title: "private chat with alice", channel: false },
    ];

    ds.entries.set(1, [makeEntry(101, "Deployment secret key is alpha-123", "user")]);
    ds.entries.set(2, [makeEntry(201, "Deployment roadmap for Q4", "user")]);
    ds.entries.set(3, [makeEntry(301, "Deployment personal thoughts", "user")]);

    const engine = new HistorySearchEngine(ds);

    // 1. Search specific channel by #name
    const resOps = await engine.search(1, "Deployment", "#ops");

    assert.equal(resOps.matches.length, 1);
    assert.equal(resOps.matches[0]?.sessionId, 1);

    // 2. Search scope "channels": should include session 1 and 2, but skip 3
    const resChannels = await engine.search(1, "Deployment", "channels");

    assert.equal(resChannels.matches.length, 2);
    assert.deepEqual(
        resChannels.matches.map((m) => m.sessionId),
        [1, 2],
    );

    // 3. Search scope "chats": should include only session 3
    const resChats = await engine.search(1, "Deployment", "chats");

    assert.equal(resChats.matches.length, 1);
    assert.equal(resChats.matches[0]?.sessionId, 3);

    // 4. Unknown channel should throw 404
    await assert.rejects(
        async () => engine.search(1, "Deployment", "#nonexistent"),
        (err: unknown) => err instanceof HttpError && err.status === 404,
    );
});

test("HistorySearchEngine incremental cache avoids re-reading older entries", async () => {
    const ds = new InMemoryHistoryDataSource();

    ds.sessions = [{ id: 1, title: "main" }];
    ds.entries.set(1, [
        makeEntry(1, "First message about redis"),
        makeEntry(2, "Second message about postgres"),
    ]);

    const engine = new HistorySearchEngine(ds);

    // Initial search: reads entries
    const res1 = await engine.search(1, "redis");

    assert.equal(res1.matches.length, 1);
    assert.equal(ds.readCount, 1);

    // Second search for postgres: uses cache, queries for entries > 2, finds none
    const res2 = await engine.search(1, "postgres");

    assert.equal(res2.matches.length, 1);
    // ds.readEntries was called with minEntryId: 3, returned []
    assert.equal(ds.readCount, 2);

    // Append new entry 3
    ds.entries.get(1)!.push(makeEntry(3, "Third message about postgres replication"));

    // Third search: queries minEntryId: 3, gets only entry 3!
    const res3 = await engine.search(1, "postgres");

    assert.equal(res3.matches.length, 2);
    assert.equal(res3.matches[0]?.entryId, 2);
    assert.equal(res3.matches[1]?.entryId, 3);
});

test("HistorySearchEngine enforces limit clamping between 1 and 25", async () => {
    const ds = new InMemoryHistoryDataSource();

    ds.sessions = [{ id: 1, title: "test" }];
    const manyEntries: EntryRecord[] = [];

    for (let i = 1; i <= 30; i++) {
        manyEntries.push(makeEntry(i, `Item ${i} matchable keyword`));
    }

    ds.entries.set(1, manyEntries);

    const engine = new HistorySearchEngine(ds);

    // Request 50 -> clamped to 25
    const resMax = await engine.search(1, "matchable", "current", 50);

    assert.equal(resMax.matches.length, 25);

    // Request 0 -> clamped to 1
    const resMin = await engine.search(1, "matchable", "current", 0);

    assert.equal(resMin.matches.length, 1);
});
