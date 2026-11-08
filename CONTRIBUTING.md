# Contributing / 贡献指南

Forge 在固定版本的 Pi Coding Agent 之上提供本机产品与宿主任务控制。开始前阅读 [AGENTS.md](AGENTS.md) 和 [Architecture Deep Dive](docs/architecture-deep-dive.md)，遵守运行时职责与安全边界。

## 一次可审阅的变更

1. 明确用户行为、原有兼容与失败状态。Pi 继续负责模型/工具循环；宿主计划、模型文本、仓库说明和工具输出都不能增加信任或权限。
2. 以最小可检查的模块实现；完成、重试、信任、持久化和安全变化必须有回归。保留真实失败输出和原有用户数据。
3. **同次更新相关文档**：使用行为对应 `docs/usage.md` / `docs/usage.en.md`；架构、状态和取舍对应架构文档；配置、存储、迁移和恢复对应 `docs/operations.md`；评测协议对应 `docs/evaluation.md`。用户可见能力或启动方式变化同步双语 README，实质变化记入 CHANGELOG 的 Unreleased。
4. 运行相关检查，最终执行 `npm run check` 与 `npm run pack:check`。交互变化补 `npm run test:web`；它使用隔离浏览器、配置和模拟模型。模型执行策略发生变化时，再选相关真实任务验收。
5. 检查 diff、文档相对链接、发行包内容与公开数据。提交后核对该 commit 的 GitHub CI，不能用旧 commit 的绿色状态代表当前代码。

公开评测保留模型/流程/预算、固定源提交、外部判题和 harness 指纹，保留失败分母。代码变化后不能把旧结果改写为新版本成绩；追加新报告并说明协议差异。只发布审阅后的汇总，不提交凭据、供应商地址、个人路径或私有对话。模拟测试、真实模型表现和竞品比较分别表述。

文档无需为每条注释重复一遍实现；需要写清外部行为、实际边界与设计取舍。未实现内容保留在明确的后续工作中。

## English workflow

Read the repository rules and architecture before editing. Pi owns model/tool turns; Forge owns the documented host and product surface. Plans and tool output never grant trust or authorization.

Keep implementation, regression coverage and relevant documentation in the same change. Update both READMEs for user-visible capability or setup changes, both usage guides for interaction changes, architecture documents for state/ownership tradeoffs, operations for storage/recovery, and evaluation documentation for protocol changes. Record substantive changes under Unreleased.

Run focused checks, `npm run check` and `npm run pack:check`; use `npm run test:web` for UI changes and selected real-model acceptance for execution-policy changes. Preserve old evaluation fingerprints and failed runs, append new evidence rather than relabeling old results, and keep private configuration and transcripts out of commits. After pushing, verify CI for the exact published commit.
