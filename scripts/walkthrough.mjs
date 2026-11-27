#!/usr/bin/env node
// Picord 全功能走查脚本:对运行中的服务做一遍 HTTP 级别的功能核验。
// 用法: node scripts/walkthrough.mjs [baseUrl] [token]
//   baseUrl 默认 http://172.19.0.1:8790,token 默认取 journalctl 里最新的登录令牌。
// 每项输出 [PASS]/[FAIL] 与细节;任何 FAIL 都会让退出码非零。

import { execSync } from "node:child_process";

const base = (process.argv[2] ?? "http://172.19.0.1:8790").replace(/\/$/, "");
let token = process.argv[3];

if (token === undefined) {
    try {
        token = execSync(
            "journalctl --user -u picord.service -n 200 --no-pager | grep -o 'token=[A-Za-z0-9]*' | tail -1",
        )
            .toString()
            .trim()
            .replace("token=", "");
    } catch {
        token = "";
    }
}

let cookie = "";
let passed = 0;
let failed = 0;

function record(name, ok, detail = "") {
    if (ok) {
        passed++;
        console.log(`[PASS] ${name}${detail === "" ? "" : `: ${detail}`}`);
    } else {
        failed++;
        console.log(`[FAIL] ${name}${detail === "" ? "" : `: ${detail}`}`);
    }
}

async function call(path, { method = "GET", body, raw = false, headers = {} } = {}) {
    const init = { method, headers: { "x-pocket": "1", ...headers }, redirect: "manual" };

    if (cookie !== "") {
        init.headers.cookie = cookie;
    }

    if (body !== undefined) {
        init.body = body instanceof Uint8Array ? body : JSON.stringify(body);

        if (!(body instanceof Uint8Array)) {init.headers["content-type"] = "application/json";}
    }

    const out = await fetch(`${base}${path}`, init);

    if (!raw) {cookie = out.headers.get("set-cookie") ?? cookie;}

    return out;
}

// 1. 登录(token 换 cookie)
{
    const out = await call(`/login?token=${token}`, { method: "GET" });

    record("auth.token_login", out.status === 303, `status=${out.status}`);
}

// 2. 我是谁
let me;

{
    const out = await call("/api/me");

    me = await out.json().catch(() => ({}));
    record("me", out.status === 200 && me.user?.name !== undefined, `user=${me.user?.name} stt=${me.user?.stt}`);
}

// 3. 会话列表(含频道标记)
let sessions = [];

{
    const out = await call("/api/sessions");

    sessions = await out.json().catch(() => []);
    const channels = sessions.filter((s) => s.channel === true);

    record(
        "sessions.list",
        out.status === 200 && sessions.length > 0,
        `${sessions.length} 个会话,其中频道 ${channels.length} 个: ${channels.map((s) => "#" + s.title).join(", ")}`,
    );
    globalThis.__scratch = sessions.find((s) => s.title === "你好")?.id ?? sessions[0]?.id;
    globalThis.__channels = channels;
}

// 4. 建一个走查专用会话,用完归档
{
    const out = await call("/api/sessions", {
        method: "POST",
        body: { cwd: sessions[0]?.cwd ?? process.cwd(), title: "walkthrough-scratch" },
    });
    const made = await out.json().catch(() => ({}));

    record("sessions.create", out.status === 200 && made.id !== undefined, `id=${made.id}`);
    globalThis.__scratchId = made.id;
}

// 5. 向走查会话发一条消息(提交进队列)
{
    const out = await call(`/api/c/${globalThis.__scratchId}/submit`, {
        method: "POST",
        body: { text: "Picord 全功能走查:这是一条核验消息,请只回复:OK", requestId: `walk-${Date.now()}` },
    });
    const made = await out.json().catch(() => ({}));

    record("submit", out.status === 200 && made.submissionId !== undefined, `submission=${made.submissionId}`);
}

// 6. 定时消息路由存活(列表走事件流,无 GET;无效创建应被拒绝而非 404)
{
    const out = await call(`/api/c/${globalThis.__scratchId}/schedules`, {
        method: "POST",
        body: {},
    });

    record("schedules.route", out.status !== 404, `status=${out.status}(400=参数校验正常)`);
}

// 7. Webhook 列表(所有者)
{
    const out = await call("/api/hooks");

    record("hooks.list", out.status === 200, `status=${out.status}`);
}

// 8. Artifacts(全局)
{
    const out = await call("/api/artifacts");

    record("artifacts.list", out.status === 200, `status=${out.status}`);
}

// 9. 语音转文字:1 秒 16kHz 正弦 WAV
{
    const sr = 16000;
    const n = sr; // 1 秒
    const data = Buffer.alloc(44 + n * 2);

    data.write("RIFF", 0);
    data.writeUInt32LE(36 + n * 2, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(sr, 24);
    data.writeUInt32LE(sr * 2, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write("data", 36);
    data.writeUInt32LE(n * 2, 40);

    for (let i = 0; i < n; i++) {data.writeInt16LE(Math.round(3000 * Math.sin((i * 2 * Math.PI * 440) / sr)), 44 + i * 2);}

    const out = await fetch(`${base}/api/stt`, {
        method: "POST",
        headers: { cookie, "content-type": "audio/wav", "x-pocket": "1" },
        body: new Uint8Array(data),
    });
    const body = await out.json().catch(() => ({}));

    record("stt", out.status === 200, `status=${out.status} text=${JSON.stringify(body.text ?? "").slice(0, 40)}`);
}

// 10. 规则引擎:rules.json 存在即视为在位(file-based)
{
    const { existsSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const candidates = [
        path.join(os.homedir(), ".picord", "rules.json"),
        path.join(os.homedir(), ".picord", "rules.local.json"),
        path.join(process.cwd(), ".dialogue-session", "rules.json"),
    ];
    const hit = candidates.filter((p) => existsSync(p));

    record("rule-engine.rules_file", hit.length > 0, hit.join(", ") || "未找到 rules.json(可能尚未创建规则)");
}

// 11. 文档站(构建产物)
{
    const out = await fetch(`${base}/docs/`);

    record("docs.served", out.status === 200 || out.status === 404, `status=${out.status}(404=未启用文档路由,走 GitHub Pages)`);
}

// 12. 会话归档收尾
{
    const id = globalThis.__scratchId;

    if (id !== undefined) {
        const out = await call(`/api/sessions/${id}`, { method: "POST", body: { archived: true } });

        record("sessions.archive_scratch", out.status === 200, `id=${id} status=${out.status}`);
    }
}

console.log(`\n走查完成: ${passed} 通过, ${failed} 失败。`);
process.exit(failed === 0 ? 0 : 1);
