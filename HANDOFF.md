# HANDOFF — Picord 开发接力文档

> 这是 VPS 与 MacBook 之间的「接力棒」。**谁接手开发,谁先读完这份文件。**
> 接手后请持续更新它:改了什么、有什么半成品,写清楚再推送。
> 本文件永远以仓库最新版本为准;协调完成后可随时删除。

---

## 一、项目是什么(30 秒版)

**Picord** = 基于 Pi 的自托管、Discord 风格个人 Agent 运行时。
分叉自 `TannerMidd/pi-pocket`(v0.30.1 基线),按个人需求深度改造:
原生 `#频道`(`channel_post` 跨频道推送)、语音转文字(Groq)、声明式规则引擎
(静默倒计时→卢曼卡片→自动推送 #zk-review)、账号密码与默认私有隔离、
中文界面、`search_history` 历史检索。**已移除**外部聊天平台中继(relay)与桌面打包。

## 二、当前状态

- **代码基线**:`main` 分支,以仓库最新提交为准(`git log --oneline -3` 即可核对)
- **生产部署**:只在 VPS 上——systemd 用户服务 `picord.service`,经 NPM 反代
  `https://bot.851127.xyz` → `172.19.0.1:8790`;数据在 VPS 的 `~/.picord/pocket.sqlite`
  (**不在仓库里,永不进仓库**)
- **文档站**:`https://feng-h.github.io/picord/`(Pages 自动部署,双语)
- **VPS 接力线程**(本文件的另一半):T3 Code 线程
  `mcp:4b87b3d0-1479-4602-9440-30d327555a96`

## 三、必读文件索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 项目故事与真实用例(中文) |
| `docs/diff-with-upstream.md` | 与上游差异全览(保留/新增/删除) |
| `docs/changelog-history.md` | 重大演进历史 |
| `docs/OPERATIONS.md` | 运维手册(重启/日志/备份) |
| `docs/user-guide.md` · `docs/WALKTHROUGH.md` | 用户手册 · 全功能走查 |
| `site/guide.html` | 项目全景导读(给非程序员的图解版) |

## 四、硬性约定(改代码前必读)

1. **不复活 relay**:外部聊天平台中继已整体移除,不要重新引入。
2. **自更新器保持默认关闭**:`updates.ts` 在 `OFF_BY_DEFAULT` 中——一键更新会检出
   上游 tag、丢掉全部分叉提交;升级方式 = 每周精选 cherry-pick。
3. **htm 模板插值必须写 `${t(...)}`**:裸写 `{t(...)}` 会按字面渲染(CI 的
   `eslint .` 会抓出来,历史上坏过 72 处)。
4. **提交信息用英文**,符合仓库现有风格;**推送后必须盯 CI 到绿**再收工。
5. 无显示环境跑不了浏览器 UI 测试(Chromium 会话会失败,属环境限制):
   用 `npm run test:server` 与 HTTP 脚本验证。
6. 界面以中文为主;界面文案在 `web/i18n.js`(中英对照表)。
7. TypeScript 用 Node strip-types 运行;本地类型检查:
   `NODE_OPTIONS=--max-old-space-size=1024 npx tsc --noEmit -p .`

## 五、进行中 / 待办(交接时快照)

- session-cleanup 的浏览器模块 UI 中文翻译——**等用户确认后才做**
- GitHub About 已加 fork 署名;**topics 标签**未加(用户意向:加 `self-hosted`、`ai-agent`、`pi-pocket-fork` 等)
- 上游 **v0.31.0** 稳定版已发布 → 待做整体升级评估(pi-durable 1.6.0 是 0.31-beta 锁定版本;Surfaces 生成式 UI 是头条特性,建议整体升级而非零星 cherry-pick)
- 远期(仓库外档案 `/home/ubuntu/T3code/commmander/PI-POCKET.md`,在 VPS 上):
  Hermes cron 迁移(二期)、Hermes skills 分类(三期)

## 六、交接协议(双向)

### MacBook → VPS(用户说「我们到 VPS 上开发」时执行)

1. **全部工作** commit 并 push 到 `main`(提交信息英文;别留未提交改动)。
2. **更新本文件**:改写「二、当前状态」与「五、进行中」两节——改了什么、
   哪些是半成品、下一步是什么;然后再次 push。
3. **通知 VPS 线程**(二选一):
   - 若你是 T3 Code 线程:调用 `t3_thread_send`,发给
     `mcp:4b87b3d0-1479-4602-9440-30d327555a96`,一句话概括即可;
   - 若你是独立 CLI(不经 T3):直接告诉用户「已推送」,由用户回到 VPS
     线程说一声「同步」。
4. VPS 端收到后:`git pull origin main` → 重读本文件 → 继续开发;
   需要上线时 `systemctl --user restart picord.service` + 走查验证。

### VPS → MacBook(本次交接,已完成 ✓)

- `main` 已全部推送;MacBook 克隆位于 `/Users/apple/pidev/picord`;
- T3 Code 已注册项目「picord」;用户可自选 Workbuddy / OpenCode / Zcode 接手。

## 七、常用命令(VPS 侧)

```bash
systemctl --user restart picord.service          # 重启服务
journalctl --user -u picord -f                   # 看日志
journalctl --user -u picord -n 200 | grep -o 'token=[A-Za-z0-9]*' | tail -1  # 登录令牌(重启后轮换)
NODE_OPTIONS=--max-old-space-size=1024 npx tsc --noEmit -p .                # 类型检查
npm run test:server                              # 服务端测试
npm run lint                                     # lint(CI 同款)
```
