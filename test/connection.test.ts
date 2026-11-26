import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConnectionStatus, EventConnection, type SwitchPayload } from "../web/connection.js";

class FakeEnv {
    nowTime = 1000000;
    timers = new Map<number, { due: number; fn: () => void; interval?: number }>();
    nextId = 1;
    eventSources: MockEventSource[] = [];

    now = () => this.nowTime;

    setTimeout = (fn: () => void, ms: number) => {
        const id = this.nextId++;

        this.timers.set(id, { due: this.nowTime + ms, fn });

        return id;
    };

    clearTimeout = (id: number) => {
        this.timers.delete(id);
    };

    setInterval = (fn: () => void, ms: number) => {
        const id = this.nextId++;

        this.timers.set(id, { due: this.nowTime + ms, fn, interval: ms });

        return id;
    };

    clearInterval = (id: number) => {
        this.timers.delete(id);
    };

    advance(ms: number) {
        this.nowTime += ms;
        const dueTimers = Array.from(this.timers.entries())
            .filter(([, timer]) => timer.due <= this.nowTime)
            .sort((a, b) => a[1].due - b[1].due);

        for (const [id, timer] of dueTimers) {
            if (!this.timers.has(id)) {
                continue;
            }

            timer.fn();

            if (timer.interval !== undefined) {
                timer.due = this.nowTime + timer.interval;
            } else {
                this.timers.delete(id);
            }
        }
    }

    getEventSourceClass() {
        const self = this;

        return class extends MockEventSource {
            constructor(url: string) {
                super(url);
                self.eventSources.push(this);
            }
        };
    }
}

class MockEventSource {
    url: string;
    readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSED
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(url: string) {
        this.url = url;
    }

    addEventListener(name: string, fn: (event: { data: string }) => void) {
        const list = this.listeners.get(name) ?? [];

        list.push(fn);
        this.listeners.set(name, list);
    }

    simulateOpen() {
        this.readyState = 1;
        this.onopen?.();
    }

    simulateEvent(name: string, data: unknown) {
        const list = this.listeners.get(name) ?? [];
        const event = { data: typeof data === "string" ? data : JSON.stringify(data) };

        for (const fn of list) {
            fn(event);
        }
    }

    simulateError() {
        this.onerror?.();
    }

    close() {
        this.readyState = 2;
        this.closed = true;
    }
}

test("EventConnection connects and dispatches events", () => {
    const env = new FakeEnv();
    const events: { name: string; data: unknown }[] = [];
    const statuses: string[] = [];

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            storage: new Map() as any,
        },
        url: () => "/api/events",
        onEvent: (name: string, data: unknown) => events.push({ name, data }),
        onStatusChange: (status: ConnectionStatus) => statuses.push(status),
    });

    connection.connect();
    assert.equal(statuses[statuses.length - 1], "connecting");
    assert.equal(env.eventSources.length, 1);

    const source = env.eventSources[0]!;

    source.simulateOpen();
    assert.equal(statuses[statuses.length - 1], "open");

    // Server sends an event
    source.simulateEvent("chat", { text: "hello" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, "chat");
    assert.deepEqual(events[0]?.data, { text: "hello" });

    connection.disconnect();
    assert.equal(source.closed, true);
});

test("EventConnection foreground wake probe triggers reconnect when silent > 1.5x", () => {
    const env = new FakeEnv();
    let reconnectCount = 0;

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            storage: new Map() as any,
        },
        url: () => "/api/events",
        isLocal: () => true,
        onEvent: () => {},
        onStatusChange: (status: ConnectionStatus) => {
            if (status === "connecting") {
                reconnectCount++;
            }
        },
    });

    connection.connect();
    assert.equal(reconnectCount, 1);
    const source1 = env.eventSources[0]!;

    source1.simulateOpen();

    // Ping received with 15s interval
    source1.simulateEvent("ping", { every: 15000 });

    // 1. Phone briefly in background for only 5 seconds (< 1.5 * 15s = 22.5s)
    env.advance(5000);
    connection.wake();
    // Should NOT reconnect
    assert.equal(reconnectCount, 1);

    // 2. Phone in background for 25 seconds (> 22.5s) - silent socket!
    env.advance(20000);
    connection.wake();
    // Must immediately reconnect!
    assert.equal(reconnectCount, 2);
    assert.equal(env.eventSources.length, 2);
    assert.equal(source1.closed, true);
});

test("EventConnection active watchdog triggers reconnect when silent > 2.5x", () => {
    const env = new FakeEnv();
    let reconnectCount = 0;

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            storage: new Map() as any,
        },
        url: () => "/api/events",
        isLocal: () => true,
        onEvent: () => {},
        onStatusChange: (status: ConnectionStatus) => {
            if (status === "connecting") {
                reconnectCount++;
            }
        },
    });

    connection.connect();
    const source1 = env.eventSources[0]!;

    source1.simulateOpen();
    source1.simulateEvent("ping", { every: 15000 });

    // Keep active with heartbeats: 15s pass, ping arrives
    env.advance(15000);
    source1.simulateEvent("ping", { every: 15000 });
    assert.equal(reconnectCount, 1);

    // Now silence: no pings arrive. Advance 38 seconds (> 2.5 * 15s = 37.5s)
    env.advance(38000);
    // Active watchdog must detect silence and reconnect!
    assert.equal(reconnectCount, 2);
    assert.equal(source1.closed, true);
    assert.equal(env.eventSources.length, 2);
});

test("EventConnection falls back to polling when initial batch is blocked by proxy", () => {
    const env = new FakeEnv();
    const storage = new Map<string, string>();
    let reconnectCount = 0;

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            storage: storage as any,
        },
        url: () => "/api/events",
        isLocal: () => false, // Non-local (e.g. behind proxy/tunnel)
        onEvent: () => {},
        onStatusChange: (status: ConnectionStatus) => {
            if (status === "connecting") {
                reconnectCount++;
            }
        },
    });

    connection.connect();
    assert.equal(reconnectCount, 1);
    const source1 = env.eventSources[0]!;

    source1.simulateOpen();

    // Initial batch does not settle within 6 seconds
    env.advance(6000);

    // Must have flagged poll mode in storage and reconnected
    assert.equal(reconnectCount, 2);
    const transport = storage.get("pocket.transport");

    assert.match(transport ?? "", /^poll:\d+/);
});

test("EventConnection switchSession drops residual events from previous session until confirmed", async () => {
    const env = new FakeEnv();
    const events: { name: string; data: unknown }[] = [];
    let switchPayload: any = null;

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            storage: new Map() as any,
        },
        url: () => "/api/events",
        isLocal: () => true,
        switchApi: async (payload: SwitchPayload) => {
            switchPayload = payload;
        },
        onEvent: (name: string, data: unknown) => events.push({ name, data }),
    });

    connection.connect();
    const source1 = env.eventSources[0]!;

    source1.simulateOpen();

    // In session 1: receive chat event
    source1.simulateEvent("chat", { text: "msg in session 1" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, "chat");

    // Initiate switch to session 2
    const switchPromise = connection.switchSession(2, { since: 100 });

    assert.equal(switchPayload.c, 2);
    assert.equal(switchPayload.seq, 2);

    // Old session 1 delayed event arrives on the wire while switch is in-flight
    source1.simulateEvent("chat", { text: "delayed msg from session 1" });
    // Must be DROPPED!
    assert.equal(events.length, 1);

    // Global events (not session-specific, like 'hello' or 'settings') should NOT be dropped
    source1.simulateEvent("settings", { dark: true });
    assert.equal(events.length, 2);
    assert.equal(events[1]?.name, "settings");

    // Server acknowledges the switch with 'switched' event matching seq
    source1.simulateEvent("switched", { seq: 2 });
    await switchPromise;

    // Now events for session 2 arrive on the wire
    source1.simulateEvent("chat", { text: "fresh msg in session 2" });
    assert.equal(events.length, 4);
    assert.equal(events[2]?.name, "switched");
    assert.equal(events[3]?.name, "chat");
    assert.deepEqual(events[3]?.data, { text: "fresh msg in session 2" });
});

test("EventConnection forwards extended SSE events and retries silent initial local stream", () => {
    const env = new FakeEnv();
    const events: { name: string; data: unknown }[] = [];

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            storage: new Map() as any,
        },
        url: () => "/api/events",
        isLocal: () => true,
        onEvent: (name: string, data: unknown) => events.push({ name, data }),
    });

    connection.connect();
    assert.equal(env.eventSources.length, 1);

    // No ping or event arrives within 10s FIRST_DATA_MS -> local stream is replaced
    env.advance(10_000);
    assert.equal(env.eventSources.length, 2);

    const source2 = env.eventSources[1]!;

    source2.simulateEvent("notice", { level: "info", message: "hi" });
    source2.simulateEvent("pip", { working: true });
    assert.deepEqual(
        events.map((item) => item.name),
        ["notice", "pip"],
    );

    connection.disconnect();
});

test("EventConnection aborts a hung long poll using hold timing", async () => {
    const env = new FakeEnv();
    const storage = new Map<string, string>([["pocket.transport", `poll:${env.nowTime}`]]);
    const events: { name: string; data: unknown }[] = [];
    let pollCalls = 0;

    const connection = new EventConnection({
        env: {
            now: env.now,
            setTimeout: env.setTimeout as any,
            clearTimeout: env.clearTimeout as any,
            setInterval: env.setInterval as any,
            clearInterval: env.clearInterval as any,
            EventSource: env.getEventSourceClass() as any,
            fetch: (async (input: string, init?: { signal?: AbortSignal }) => {
                if (String(input).includes("close=1")) {
                    return { status: 200, ok: true, async json() { return {}; } };
                }

                pollCalls++;

                if (pollCalls === 1) {
                    return {
                        status: 200,
                        ok: true,
                        async json() {
                            return {
                                session: "poll-1",
                                hold: 300,
                                events: [{ seq: 1, event: "reload", data: {} }],
                            };
                        },
                    };
                }

                if (pollCalls === 2) {
                    return await new Promise((_, reject) => {
                        init?.signal?.addEventListener("abort", () =>
                            reject(new Error("aborted")),
                        );
                    });
                }

                return {
                    status: 200,
                    ok: true,
                    async json() {
                        connection.disconnect();

                        return { session: "poll-1", hold: 300, events: [] };
                    },
                };
            }) as any,
            storage: storage as any,
        },
        url: () => "/api/events",
        isLocal: () => false,
        onEvent: (name: string, data: unknown) => events.push({ name, data }),
    });

    connection.connect();
    // Let first poll complete and second poll start + stall timer register
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pollCalls, 2);

    // hold=300 => pollStallMs(300) = 2450ms -> abort second poll and advance 1s retry backoff
    env.advance(2500);
    await new Promise((r) => setTimeout(r, 10));
    env.advance(1000);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(pollCalls, 3);
    assert.deepEqual(events, [{ name: "reload", data: {} }]);
});
