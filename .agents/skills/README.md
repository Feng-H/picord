# 项目级 Skills(跟随仓库走)

本目录装的是 [mattpocock/skills](https://github.com/mattpocock/skills) 全集(39 个),
供 Pi / T3 Code 及其他支持 Agent Skills 规范的 agent 在**本项目**内自动发现使用。

- **来源提交**:mattpocock/skills `6f7f7831a625f040a8e06a0e7954826b87ce775a`(2026-11-28 同步)
- **许可**:MIT · Copyright (c) 2026 Matt Pocock(已随上游保留)
- **结构**:扁平(每 skill 一个目录,含 SKILL.md);Pi 从仓库根递归发现 `.agents/skills/`
- **更新方式**:克隆上游仓库,把 `skills/<分类>/<名称>` 覆盖到本目录顶层,重跑重名检查

注:不自动识别 `.agents/skills/` 的 agent(如部分 CLI),开发时可直接读
对应目录下的 `SKILL.md`。
