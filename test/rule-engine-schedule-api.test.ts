// End-to-end HTTP + Commands + PocketApp tests for Issue #26 projected rule schedule mutations.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";

const dataDir = join(root, "rule-api-data");
const ruleFile = join(dataDir, "rules.json");

const siblingRule = {
    id: "ops-digest",
    title: "Ops Digest",
    channel: "ops",
    on: "silence",
    after: "45m",
    action: { type: "prompt", instruction: "Ops summary", silent: true },
};

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base: string;

before(async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
        ruleFile,
        `${JSON.stringify(
            {
                rules: [
                    {
                        id: "smalltalk-card-summary",
                        title: "闲聊卡片总结",
                        channel: "smalltalk",
                        on: "silence",
                        after: "60m",
                        action: {
                            type: "prompt",
                            instruction: "原始总结提示词",
                            silent: true,
                        },
                    },
                    siblingRule,
                ],
            },
            null,
            2,
        )}\n`,
        "utf8",
    );

    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function api(
    token: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
) {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
    };
}

test("projected schedule HTTP Edit, Pause/Resume, and Cancel map back to rules.json without 404", async () => {
    const john = app.config.addUser("John", "guest");
    const smalltalk = await app.commands.createSession(john.user, {
        cwd: app.defaultCwd,
        title: "#smalltalk",
        channel: true,
    });

    // Touch rule on #smalltalk directly to simulate human activity without waiting on model streaming
    const now = Date.now();

    app.ruleEngine?.touch("#smalltalk", now, 1, "user");
    const projected = app.ruleEngine?.activeSchedulesForSession(smalltalk.id, "#smalltalk") ?? [];

    assert.equal(projected.length, 1);
    assert.equal(projected[0]!.id, "rule:smalltalk-card-summary");
    assert.deepEqual(projected[0]!.every, { minutes: 60 });

    // 1. Once (next-only) edit is rejected with 400
    const badOnce = await api(
        john.token,
        "PUT",
        `c/${smalltalk.id}/schedules/rule:smalltalk-card-summary`,
        {
            text: "不允许改为单次",
            next: now + 30 * 60_000,
        },
    );

    assert.equal(badOnce.status, 400);
    assert.match(String(badOnce.json.error), /投影任务由静默规则驱动/);

    // 2. Repeat edit via HTTP PUT (carrying UI's every + next + updated text) succeeds
    const edited = await api(
        john.token,
        "PUT",
        `c/${smalltalk.id}/schedules/rule:smalltalk-card-summary`,
        {
            text: "HTTP 修改后的总结提示词",
            every: { minutes: 90 },
            next: projected[0]!.next,
        },
    );

    assert.equal(edited.status, 200);
    assert.deepEqual(edited.json.every, { minutes: 90 });

    const rulesAfterEdit = JSON.parse(readFileSync(ruleFile, "utf8")) as {
        rules: Array<{ id: string; after: string; action: { instruction: string } }>;
    };

    assert.equal(rulesAfterEdit.rules[0]!.after, "90m");
    assert.equal(rulesAfterEdit.rules[0]!.action.instruction, "HTTP 修改后的总结提示词");

    // 3. Mismatched session rule returns 404
    const wrongChannel = await api(
        john.token,
        "PUT",
        `c/${smalltalk.id}/schedules/rule:ops-digest`,
        { every: { minutes: 30 } },
    );

    assert.equal(wrongChannel.status, 404);

    // 4. Pause & resume accept both `rule:` and `rule-silence-` prefixes and persist in rule-states.json
    const paused = await api(
        john.token,
        "POST",
        `c/${smalltalk.id}/schedules/rule-silence-smalltalk-card-summary/pause`,
        { paused: true },
    );

    assert.equal(paused.status, 200);
    assert.ok(app.ruleEngine?.getState("smalltalk-card-summary")?.paused !== undefined);

    const resumed = await api(
        john.token,
        "POST",
        `c/${smalltalk.id}/schedules/rule:smalltalk-card-summary/pause`,
        { paused: false },
    );

    assert.equal(resumed.status, 200);
    assert.equal(app.ruleEngine?.getState("smalltalk-card-summary")?.paused, undefined);

    // 5. Cancel removes rule from rules.json, preserves sibling rule, and subsequent operations return 400
    const cancelled = await api(
        john.token,
        "POST",
        `c/${smalltalk.id}/schedules/rule:smalltalk-card-summary/cancel`,
        {},
    );

    assert.equal(cancelled.status, 200);

    const rulesAfterCancel = JSON.parse(readFileSync(ruleFile, "utf8")) as {
        rules: unknown[];
    };

    assert.deepEqual(rulesAfterCancel.rules, [siblingRule]);

    const afterDelete = await api(
        john.token,
        "POST",
        `c/${smalltalk.id}/schedules/rule:smalltalk-card-summary/pause`,
        { paused: true },
    );

    assert.equal(afterDelete.status, 400);
    assert.equal(afterDelete.json.error, "规则已移除");
});
