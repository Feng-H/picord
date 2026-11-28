---
description: 切换开发场景(例:/scene code-matt-pocock)
argument-hint: "<场景名>"
---
用户要通过「场景」切换工作流。场景名:$@($1)。可用场景:

- **code-matt-pocock** — Matt Pocock 工程流:
  - 实现遵循 `.agents/skills/implement/SKILL.md`
  - 测试遵循 `.agents/skills/tdd/SKILL.md`(先红后绿)
  - 动大设计前:先读 `docs/adr/` 相关决策,再用 `.agents/skills/grilling/SKILL.md` 追问清楚
  - 收尾审查 `.agents/skills/code-review/SKILL.md`,提交走 `.agents/skills/pr/SKILL.md`

执行规则:
1. 场景名匹配 → 读取对应 SKILL.md,把其工作流作为后续执行守则,并向用户复述一句「已切换到 X 场景」。
2. 场景名不匹配或为空 → 列出可用场景,请用户选择;不要臆测。
3. 本清单可扩充:在 `.pi/prompts/scene.md` 的可用场景表里加一行即可。
