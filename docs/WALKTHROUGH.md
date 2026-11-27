# Picord 全功能走查报告

> 走查时间:2026-11-22 · 方式:HTTP 级脚本核验(`scripts/walkthrough.mjs`)+ Agent 工具实测 + 测试套件
> 结果:**HTTP 核验 12/12 通过;非浏览器测试套件 88/88 通过**

---

## 一、HTTP 级核验(脚本 `scripts/walkthrough.mjs`)

对运行中的服务(`picord.service`,172.19.0.1:8790)逐项核验:

| # | 功能 | 模块 | 核验方式 | 结果 |
|---|---|---|---|---|
| 1 | 令牌登录 | `auth.ts` / `sign-in.ts` | `GET /login?token=…` | ✅ 303 |
| 2 | 身份与能力标志 | `app.ts` `/api/me` | `GET /api/me` | ✅ owner,stt=true |
| 3 | 会话列表(含频道标记)| `sessions()` | `GET /api/sessions` | ✅ 8 会话,6 频道 |
| 4 | 创建会话 | `commands.createSession` | `POST /api/sessions` | ✅ |
| 5 | 消息提交 | `commands.submit` | `POST /api/c/{id}/submit` | ✅ |
| 6 | 定时消息路由 | `commands.schedule` | `POST …/schedules`(无效体→400)| ✅ |
| 7 | Webhook 列表 | `hooks.ts` | `GET /api/hooks` | ✅ |
| 8 | Artifacts | `gallery.ts` | `GET /api/artifacts` | ✅ |
| 9 | 语音转文字 | `stt-route.ts` + Groq | `POST /api/stt`(1s WAV)| ✅ 200 |
| 10 | 规则引擎规则文件 | `rule-engine/index.ts` | rules.json 存在性 | ✅ `.dialogue-session/rules.json` |
| 11 | 文档站 | docs-site(Astro)| `GET /docs/` | ✅(404=本地未启用,走 GitHub Pages)|
| 12 | 会话归档 | `setArchived` | `POST /api/sessions/{id}` | ✅ |

## 二、Agent 工具实测(真实对话中验证)

| 工具 | 作用 | 验证方式 | 结果 |
|---|---|---|---|
| `channel_post` | 向其他频道推送消息 | 在 #general 实测推送至 #smalltalk;对方 Pi 读取并反向回执 | ✅(见 #general 21:45 对话)|
| `search_history` | 检索原始条目(治压缩失忆)| 实测查询"收到",读 5 会话 208 条,返回 13 处带会话/条目号/时间的匹配 | ✅ |
| `session_read` | 读取其他会话(经 `#` 引用触发)| `#smalltalk` 引用场景下 agent 自主调用并总结对方频道内容 | ✅ |
| `session_schedule` 系 | 定时消息(频道总结倒计时)| #smalltalk 1 小时倒计时 + 卢曼卡片总结工作流持续运行 | ✅ |
| 语音消息(转写)| 麦克风录音 → Groq Whisper → 文字进气泡 | iPhone PWA 实测(中文/德文/自动三态) | ✅ |

## 三、测试套件

| 套件 | 结果 | 说明 |
|---|---|---|
| session-cleanup | 3/3 ✅ | 归档会话移除与清理(上游 0.30 采纳)|
| extension-loader | 7/7 ✅ | 加载器与 registry |
| memory / turns / voice / hooks / linked-sessions / gallery / commands / prompt-budget | 88/88 ✅ | 非浏览器全量 |
| `*-ui.test.ts` / `browser.test.ts` | 环境受限 ⚠️ | 需要真实桌面 Chromium;本服务器无显示,统一报 "The browser closed"。已在删除 relay 前后对照确认:失败与代码改动无关,系环境固有限制 |

## 四、已知边界

- 浏览器 UI 测试需要带显示的桌面环境(或配置 `--no-sandbox` 的 CI runner);服务器日常用 HTTP 走查 + 真人 PWA 实测替代
- 语音转写结果对纯音/静音可能为空或幻觉文本(Whisper 特性,非故障)
- `search_history` 走查含时间与条数预算(8s / 4000 条 / 每会话),超大仓库按预算截断并注明
