# Picord 与原项目（pi-pocket）差异全览

本文对照 `Feng-H/picord` 与上游原版 `TannerMidd/pi-pocket`（基于合入的 `v0.30.1` 代码基线），说明本项目保留了什么、新增长出了什么、精简删掉了什么，以及底层架构做了哪些调整。

> **重大演进摘要**：Picord 自 2026-11-21 分叉以来，陆续完成了「去外部聊天平台 Relay → 原生 `#频道` 与语音转文字 → 声明式规则引擎 → 账号密码与默认私有隔离 → `picord` 独立品牌与测试/CI 闭环」五轮重大演进，详见 [重大演进历史](changelog-history.md)。

---

## 一、定位差异一句话总结

| 维度 | 原项目 `TannerMidd/pi-pocket` | 本项目 `Feng-H/picord` |
| --- | --- | --- |
| **核心形态** | 单机/小圈子共用的 Pi Web 控制台 + 外部聊天平台中继 + 桌面安装包 | **自托管个人/小团队“第二大脑”运行环境**（Pi Agent + Discord 风格原生频道） |
| **会话可见性** | 登录用户默认可见全部会话，适合一人多端或高度互信团队 | **默认严格私有隔离**：每人仅见自己的会话与主动加入的共享群组 |
| **自动化思考** | 以对话内显式 `/schedule` 定时消息为主 | 额外内置**声明式对话规则引擎**（无人发言静默倒计时、沉淀卡片与跨频道推送） |
| **跨对话协作** | 通过外部聊天中继、Linked Sessions / Agent Teams 与 PiP 串联 | 取消外部中继，改为原生 **`#频道`、输入框 `#` 引用、`channel_post` 直邮、跨频道引用溯源与 `search_history`** |
| **发布与维护** | npm 全局包、Windows/macOS 桌面安装包、NixOS、每周五发版 | **聚焦 Linux 服务器 / systemd / Docker / 手机 PWA 自托管部署**，剔除多余桌面打包负担 |

---

## 二、Picord 独有的新增与深化能力

1. **原生 Discord 风格频道体系（`src/server/channels.ts`、`src/server/extensions/channels.ts`）**
   - 侧栏独立 `CHANNELS` 分组与快捷 `+` 建频道，同人同名拦截、不同人各自私有名下同名频道互不冲突。
   - 输入框敲 `#` 实时联想并引用任意频道，附带隐藏会话来源上下文，Agent 可按需用 `session_read` 读取原文。
   - 工具 `channel_post` 实现频道间直邮投递与双向确认。
2. **声明式对话规则引擎（`src/server/rule-engine/`、`#smalltalk` 生态）**
   - 根据真人发言记录、静默超时倒计时自动触发规则（如将 `#smalltalk` 碎片想法沉淀为 `.dialogue-session/` 中的卢曼卡片并派发到 `#zk-review`）。
   - 支持热加载 `rules.json`、`/rule` 指令、启动环境变更通知，以及直接投影到日程面板并支持 UI **编辑 / 暂停 / 取消**。
3. **频道优先历史检索与引用溯源（`src/server/history-search.ts`、`src/server/quote-provenance.ts`）**
   - 工具 `search_history` 直接检索原始条目（先本频道、再全局，带时间窗口和条数预算），缓解长对话总结（Compaction）丢失细节导致的“跨天失忆”。
   - 跨频道/跨位置引用文字时保留来源定位元数据与前端反链跳转。
4. **账号密码认证、邀请码注册与默认私有隔离（`src/server/password.ts`、`src/server/session-access.ts`）**
   - 原项目主要靠 URL Token 登录；Picord 新增完整的用户名密码登录（`/login`）、邀请码注册（`/register`）、未登录全站重定向拦截。
   - **默认私有隔离（方案 B）**：新建对话与 `#频道` 默认只有创建者自己能看能搜；通过 Share 面板或 `Mod+K` 主动拉入群成员、或生成单会话邀请链接后才共享，踢人即时生效、成员可主动退群。
5. **服务端语音转文字与移动端 PWA 对讲增强（`src/server/stt.ts`、`web/voice.js`、`web/sw.js`）**
   - 内置 Groq Whisper 服务端语音转文字（`/api/stt`，支持按人选语言、断网重试、无 Key 时退化为浏览器听写）。
   - 独立抽离深化的 `web/voice.js`：支持按住说话（Push-to-Talk）、上滑取消、屏幕常亮锁（Wake Lock）、iOS 停止事件兜底与 PWA App 骨架缓存加速秒开。
6. **全界面中文化与独立品牌（`web/i18n.js`、`bin/picord.js`、`contrib/systemd/picord@.service`）**
   - 支持侧栏一键 **中文 / EN** 即时切换；运行时命令行、systemd 服务与默认数据目录全面统一为 `picord` / `~/.picord/`（同时兼容读取历史 `~/.pi-pocket/` 或 `PI_POCKET_DIR`）。
7. **深模块工程架构抽取（`src/server/dialogue-runtime.ts`、`src/server/turn-pipeline/`、`web/live.js` 等）**
   - 从原先偏臃肿的 `PocketApp` 与路由中拆出 `TurnPipeline`、`DialogueRuntime`、`HistorySearchEngine`、`EventConnection`（含手机睡眠唤醒事件流看门狗），并为 `pi-durable 1.6.0` 修复了休眠子代理重复巡检（`sleeping` 状态遗漏）的真实缺陷。

---

## 三、明确删减与关闭的功能/组件

| 已移除或关闭项 | 原项目用途 | Picord 处理方式与原因 |
| --- | --- | --- |
| **外部聊天平台中继（Relay）** | 桥接外部聊天软件/中继消息 | 已删除（以内置 `#频道` + Web/PWA 为唯一一等入口，减少外部状态同步维护面）。 |
| **Windows / macOS 桌面客户端与安装包** | Inno Setup / `.pkg` 安装包、托盘程序 | 已删除（`packaging/`、`docs/windows.md`、`docs/macos.md`、`docs/desktop-app.md` 及对应构建流水线），聚焦服务器与手机浏览器/PWA。 |
| **NixOS 打包与每周五发版流水线** | `flake.nix`、`nix/`、`publish.yml`、`releases.md` | 已删除，改用独立仓库与 GitHub Actions `CI`（`check` + `lint` + `test:server`）控质。 |
| **自动从上游拉取更新（默认关闭自更新）** | 连接 `TannerMidd/pi-pocket` 检查 npm 更新 | 默认关闭/指向 `Feng-H/picord`，避免分叉版本被原版包误覆盖。 |

---

## 四、底层架构与升级策略调整

1. **`pi-durable` 引擎版本策略**：
   - 上游在 `v0.30.1`（及后续 `v0.31.0-beta.7`）均运行于 `@earendil-works/pi-durable 1.6.0`。
   - 经拆包评估，`1.6.1` 仅包含 Windows Git Bash / 超长行小修，却带了 7 项破坏性接口变更；因此 Picord 主动锁定 **`1.6.0`**，并把精力放在修实 `sleeping` 子代理竞态、清零测试债与稳定上线运行。
2. **保留的原项目核心功能底座**：
   - 原项目自带的 **持久化执行（SQLite）、Lancet Guard 命令审批、后台任务（Background）、定时消息（Schedules）、Done when 验收（`/until`）、Plan 只读模式、内存跨会话经验（Memory）、无头浏览器（Browser）、Artifacts 沙箱与 Design 模式、Agent Teams、PiP 画中画助理、Codemode 与 `tool_search`、PR/仓库监听与 Webhook、主题与自定义布局** 等数十个功能模块均完整保留在 Picord 代码库中，详情与逐项实测指引见 [原项目保留功能实测探索手册](upstream-features-guide.md)。
