import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ChannelManager,
    InMemoryChannelStore,
    normalizeChannelName,
} from "../src/server/channels.ts";

test("Channel name normalization and validation", () => {
    assert.equal(normalizeChannelName("smalltalk"), "smalltalk");
    assert.equal(normalizeChannelName("#smalltalk"), "smalltalk");
    assert.equal(normalizeChannelName("  #SmallTalk  "), "smalltalk");
    assert.equal(normalizeChannelName("zk-review_2"), "zk-review_2");

    // Invalid names
    assert.throws(() => normalizeChannelName(""), /Channel name cannot be empty/);
    assert.throws(() => normalizeChannelName("#"), /Channel name cannot be empty/);
    assert.throws(() => normalizeChannelName("hello world"), /Invalid channel name/);
    assert.throws(() => normalizeChannelName("general!"), /Invalid channel name/);
    assert.throws(() => normalizeChannelName("测试频道"), /Invalid channel name/);
});

test("ChannelManager creation and duplicate rejection", async () => {
    const store = new InMemoryChannelStore();
    const manager = new ChannelManager(store);

    const channel1 = await manager.create("general", "user-1");

    assert.equal(channel1.name, "general");
    assert.equal(channel1.title, "#general");
    assert.equal(channel1.createdBy, "user-1");

    // Duplicate rejection (case-insensitive and with #)
    await assert.rejects(
        () => manager.create("#General", "user-1"),
        /A channel called #general is already here/,
    );
    await assert.rejects(
        () => manager.create("general", "user-2"),
        /A channel called #general is already here/,
    );
});

test("ChannelManager retrieval by name or id, and active listing", async () => {
    const store = new InMemoryChannelStore();
    const manager = new ChannelManager(store);

    const c1 = await manager.create("general", "user-1");
    const c2 = await manager.create("smalltalk", "user-1");

    const list = manager.list();

    assert.equal(list.length, 2);
    assert.equal(list[0]?.name, "general");
    assert.equal(list[1]?.name, "smalltalk");

    // Get by name (with or without #, case-insensitive)
    assert.equal(manager.get("general")?.id, c1.id);
    assert.equal(manager.get("#General")?.id, c1.id);
    assert.equal(manager.get("smalltalk")?.id, c2.id);
    assert.equal(manager.get("#smalltalk")?.id, c2.id);

    // Get by id
    assert.equal(manager.get(c1.id)?.name, "general");
    assert.equal(manager.get(c2.id)?.name, "smalltalk");

    // Non-existent
    assert.equal(manager.get("non-existent"), undefined);
});

test("ChannelManager post delivery and fail-fast routing", async () => {
    const store = new InMemoryChannelStore();
    const delivered: {
        targetId: unknown;
        fromId: unknown;
        sourceName?: string;
        message: string;
    }[] = [];

    const manager = new ChannelManager(store, async (target, options) => {
        delivered.push({
            targetId: target.id,
            fromId: options.fromId,
            sourceName: options.sourceChannel?.name,
            message: options.message,
        });
    });

    const c1 = await manager.create("smalltalk", "user-1");
    const c2 = await manager.create("zk-review", "user-1");
    const c3 = await manager.create("old-archive", "user-1");

    c3.archived = true;

    // Successful cross-channel post
    const result = await manager.post(c1.id, "zk-review", "Hello zk team");

    assert.match(result, /Posted into #zk-review \(session \d+\)/);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.targetId, c2.id);
    assert.equal(delivered[0]?.fromId, c1.id);
    assert.equal(delivered[0]?.sourceName, "smalltalk");
    assert.equal(delivered[0]?.message, "Hello zk team");

    // Posting with # prefix
    await manager.post(c1.id, "#zk-review", "Another update");
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1]?.message, "Another update");

    // Fail-fast: Empty message
    await assert.rejects(() => manager.post(c1.id, "zk-review", "   "), /Say what to post/);

    // Fail-fast: Target does not exist (no fuzzy guessing)
    await assert.rejects(
        () => manager.post(c1.id, "zk", "test"),
        /No live channel called #zk is here/,
    );
    await assert.rejects(
        () => manager.post(c1.id, "nonexistent", "test"),
        /No live channel called #nonexistent is here/,
    );

    // Fail-fast: Target is archived
    await assert.rejects(
        () => manager.post(c1.id, "old-archive", "test"),
        /Channel #old-archive is archived/,
    );

    // Fail-fast: Target is the same conversation
    await assert.rejects(
        () => manager.post(c1.id, "smalltalk", "test"),
        /That is this very conversation: just say it here/,
    );
});
