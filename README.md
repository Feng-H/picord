<div align="center">

# Picord

**基于 Pi 的自托管 Discord 风格个人 Agent 运行时**  
**A self-hosted, Discord-style personal Agent runtime built on Pi.**

[功能全览 / Feature tour](docs/features.md) · [致敬原型 / Upstream: pi-pocket](https://github.com/TannerMidd/pi-pocket)

[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)

</div>

> 我不是"评估"这个项目的人。我每天开着它,在频道里跟自己的 agent 说话:想到什么说什么,说完就去干活。
> 下面的每一个功能,都不是设计出来的,是**用出来的**——先有痛点,再有代码。
>
> I am not evaluating this app; I live in it. Every feature below started as a real pain in my daily use.

## 一个真实的日常:#smalltalk,我的思维频道

我在 `#smalltalk` 里"出声思考":想到什么说一句,中文、碎片化、不整理。跟 agent 聊过之后,这套机制自己长成了这样——

**我说,它记,倒计时归零。**
每发一条消息,agent 把新观点记进 `viewpoints.md`,并把一个 1 小时的定时检查重置。1 小时内我没有再发言 → 到点自动生成总结。
**总结不是摘要:每个观点一张卢曼卡片**——编号(ZK-2026-…)、原文、来源时间,写进 `.dialogue-session/` 并 git 提交。这套东西迭代了几版,已经从 demo 转正,叫「卢曼卡片 · 思维图谱」,名字不再跟着版本走。

![卢曼卡片 · 思维图谱:规则说明](docs/shots/smalltalk-rules.png)

![正式系统「卢曼卡片 · 思维图谱」,git 已提交](docs/shots/smalltalk-luhmann.png)

**到点的产出,不躺在频道里——直接推给干活的频道。**
总结出的"待重写卡片 / 候选连接 / 矛盾警报",agent 用 `channel_post` 直接推进 `#zk-review`(我专门放 review 的频道)。那边的 Pi 读完就开始处理,还会回一条确认到这里来。双向的。

![跨频道推送与倒计时](docs/shots/smalltalk-countdown.png)

English: `#smalltalk` is where I think out loud. Every message resets a one-hour timer and logs the new thought; when I go quiet, the agent writes **one Zettelkasten card per viewpoint** (id, original words, source time) into a git-tracked folder — then pushes the "to-rewrite / candidate-links / contradictions" list into `#zk-review`, a separate review channel, with `channel_post`. That channel's Pi reads it and works there.

## 输入框里敲 `#`:把别的频道"@"进来

在任何一个频道的输入框敲 `#`,候选列表就出来。选中即引用——而 agent 收到的不只是文字:每个 `#频道名` 都附带了"这是哪个会话"的隐藏信息,它需要时会自己拿 `session_read` 去读那个频道的原文。

![输入 # 引用频道](docs/shots/channel-mention.png)

English: typing `#` offers the channels; a pick writes `#name`, and a hidden context part tells Pi which session that channel is, so it can read the original with `session_read`.

## 两个频道之间的往返:channel_post

上面那条"确认收到 ✅ 通道可用"就是 `#smalltalk` 的 Pi **主动推回来**的。一条命令、一个工具(`channel_post`):把结论交给别的频道,那边的 Pi 读完就在自己的频道里接话。我曾经用"共享文件信箱"变通过——现在删了,直邮。

![两个频道之间的双向确认](docs/shots/channel-post.png)

English: `channel_post` delivers a message into another channel, marked with where it came from; that channel's Pi reads it there and answers in its own voice. This replaced my earlier shared-file mailbox workaround.

## search_history:治好"跨天失忆"

长对话会触发摘要(Compaction),摘要保形状、丢细节。于是当有人问"我们昨天讨论过 X 吗?"——**先查,再答**:工具 `search_history` 直接检索原始条目(本会话或全部会话,带时间与条数预算),答案从原文里来。系统提示词里立了规矩:_不许猜能查到的东西_。

English: compaction summarizes; `search_history` retrieves. The prompt now tells Pi: when a question reaches past the visible context, look first and answer from what was found.

## 语音:走路时也能想

麦克风按下即录、再按即发。录音**直接作为消息**进频道,服务端用 Groq Whisper 转写,转写文字显示在我的气泡里,agent 读转写回答。识别语言按人可选(自动 / 中文 / English / Deutsch);上传失败自动重试;iOS 停止事件丢失有兜底。没配 Groq key 时退化为浏览器听写。

English: press to record, press again to send. The server hears it with Groq's Whisper; the words land in my own bubble. Language pickable per person.

## 中文界面 / 中文界面优先

全界面中文化:侧栏、启动器、菜单、外观设置、每一个弹窗。侧栏旁 **中文 / EN** 一键切换、即时生效、按浏览器记忆。因为我的思考语言是中文,agent 的思考环境也应该是。

English: the whole interface speaks Chinese; a chip switches at once, per browser.

## 顺手做的小事 / Smaller things

- 频道重名直接拒绝(服务端 409,大小写/`#`/空格归一化);`/channel` 撞名时直接打开已有频道
- 归档会话可**真正删除**(采纳上游 0.30 的 Session cleanup:移出应用、清理 worktree/上传/日志,转录留在 durable 存储)
- 归档频道可改名以示区分,改名后 `#` 引用与 agent 上下文读新名
- 语音上传失败自动重试;iPhone 停止事件丢失不影响发送
- `#` 弹窗里归档频道带标记,不接聊天平台(relay 已移除,fork 精简)

## 运行 / Run

与上游一致：Node.js ≥ 22.19，无构建步骤。语音转文字需配置 `GROQ_API_KEY`。

```bash
git clone https://github.com/Feng-H/picord.git
cd picord
npm install
node bin/pi-pocket.js
```

## 原型与许可 / Origins & license

- 本项目由衷致敬 Tanner Middleton 的开源项目 [pi-pocket](https://github.com/TannerMidd/pi-pocket)（MIT 许可）。我们在其优雅的 Agent 运行时基础上独立演进，去除了外部聊天平台中继依赖，将 Discord 频道交互原生内置到自托管 Web/PWA 中，打造真正自由自主的个人智能体第二大脑。
- 原项目英文 README：[README-UPSTREAM.md](./README-UPSTREAM.md)
- MIT License。再次感谢 [@TannerMidd](https://github.com/TannerMidd) 的出色工作。
