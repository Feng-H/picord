# Picord 运维手册

> 面向所有者(Owner)的日常操作手册。部署形态:Linux 服务器 + systemd 用户服务 + 手机/浏览器 PWA。

---

## 一、服务管理

```bash
systemctl --user start picord        # 启动
systemctl --user stop picord         # 停止
systemctl --user restart picord      # 重启(每次改动服务端代码后需要)
systemctl --user status picord       # 状态
journalctl --user -u picord -f       # 实时日志
```

- 服务文件:`~/.config/systemd/user/picord.service`(`Restart=always`,崩溃自动拉起)
- 数据目录:`~/.picord/`(数据库、上传文件、扩展令牌;**备份即备份此目录**)
- 登录令牌:重启后若令牌轮换,取新链接:
  `journalctl --user -u picord -n 200 | grep -o 'token=[A-Za-z0-9]*' | tail -1`

## 二、登录与账号

- **令牌登录**:浏览器打开 `https://bot.851127.xyz/login?token=<令牌>`,即登录并种下 Cookie
- **账号密码**:设置好密码后走登录页;默认严格私有隔离——每人只见自己的会话
- **PWA**:手机浏览器打开站点 → 添加到主屏幕;改动前端后需**完全关闭重开** PWA 才会加载新前端

## 三、频道日常

| 操作 | 做法 |
|---|---|
| 建频道 | 侧栏 CHANNELS 分组头 `+`(输入名字);或 `/channel 名字` |
| 引用频道 | 输入框敲 `#`,候选选择;agent 会收到隐藏上下文并可用 `session_read` 深读 |
| 跨频道推送 | 直接对 agent 说"把 XX 推送给 #某频道",它会用 `channel_post` |
| 重命名 | 长按频道行 → 重命名(重名会被拒绝) |
| 归档 | 长按频道行 → 归档(从主列表消失,`#` 引用仍可见并带"归档"标记)|
| **真删除** | 归档标签页 → 长按 → **Remove and clean up**(移出应用并清理文件;转录保留在 durable 存储)|

## 四、语音消息

- 麦克风**点按开始 → 再点发送**;发送中麦克风转圈
- 识别语言:麦克风旁的小芯片(AUTO → 中 → EN → DE 循环),按人记忆
- 转写文字出现在你自己的气泡里(`🎙 …`),agent 直接读
- 失败会弹具体原因;上传中断自动重试三次

## 五、定时与规则引擎

- 对 agent 说"每小时总结一次"之类,它会用 `schedule` 工具建定时任务
- 规则文件:`~/.picord/rules.json` 与项目内 `.dialogue-session/rules.json`(声明式规则:静默倒计时、卡片沉淀、跨频道推送)
- 改完规则文件无需重启,引擎热加载

## 六、记忆与检索

- **search_history**:对 agent 说"查一下 XX 早期在哪说的",它会检索原始条目(而非压缩摘要)
- **Memory** Menu → Memory:跨会话经验(分项目/全局/单会话三个作用域)
- **卢曼卡片**:在思维频道正常聊天即可,静默到点自动沉淀为 ZK 编号卡片并入 git

## 七、升级策略(重要)

1. **不要点应用内的"升级"提示**:自更新器假设跟随上游,一键安装会把 fork 分支甩掉(已默认关闭)
2. 升级走:每周一上游简报 → 确认 → **手动 cherry-pick** 挑选的提交 → 重启回归
3. 升级时同步抬版本号与 README 的 upstream 徽章

## 八、备份

```bash
systemctl --user stop picord
cp -a ~/.picord ~/backup/picord-$(date +%F)
systemctl --user start picord
```

至少备份:`pocket.sqlite*`(全部对话与状态)、`extensions/`(令牌)、`uploads/`。

## 九、故障排查

| 症状 | 排查 |
|---|---|
| 打不开/503 | `systemctl --user status picord`;看日志是否端口被占或启动报错 |
| "could not start" | 页面加载被重启打断,**刷新即可**;若反复,清浏览器缓存后重进 |
| 语音报错 | 看提示原文:常见为麦克风权限、无 Groq key、网络中断(已自动重试三次)|
| agent 找不到别的频道内容 | 确认用 `#频道名` 引用;或让它"用 search_history scope all 查" |
| 前端没更新 | PWA 需完全关闭重开(移动端);桌面刷新 + 硬缓存清理 |
