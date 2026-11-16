# Forge Agent 文档目录 / Documentation

这是完整的文档入口。按读者任务组织使用指南、架构与专项参考，再单独列出历史评测；不需要按时间顺序读完整个档案。

This is the complete documentation map, organized by reader needs rather than chronology.

## 从这里开始

| 目标 | 推荐入口 |
| --- | --- |
| 首次安装与使用 | [中文使用指南](usage.md) · [English guide](usage.en.md) |
| 中文理解 Forge 和 Pi 的职责 | [架构总览（中文）](architecture.zh.md) · [架构深读（中文）](architecture-deep-dive.md) |
| English component map | [Architecture overview](architecture.md) |
| 中文配置验证与结果状态 | [行为检查](behavior-checks.md) · [结果语义](task-results.md#中文) |
| 运维、长任务和恢复 | [运行手册](operations.md) · [任务调度](task-scheduling.md) |
| 查看中文评测结论 | [评测摘要](evaluation.md#中文摘要) |

## 产品与工程参考

### 架构、执行与恢复

- [Architecture overview (English)](architecture.md) — 活动组件、Pi / Forge 职责与能力边界。
- [架构总览（中文）](architecture.zh.md) — Forge / Pi 职责、源码目录和执行路径。
- [架构深读（中文）](architecture-deep-dive.md) — 状态机、权限、持久化、恢复、取舍与未证明事项。
- [Task results / 任务结果（中英双语）](task-results.md) — 执行结束、验证、模型审阅与验收声明的区别。
- [Task scheduling](task-scheduling.md) — 多项目队列、并发和进度监测。
- [Execution records](execution-records.md) — 只读时间线的字段和证据来源。
- [Subagents](subagents.md) — explorer/reviewer/worker 权限、预算与提案应用。
- [Frozen upstream replay protocol](upstream-behavior-replay.md) — 固定原始镜像复放的输入、隔离与判读规则。

### 验证、审阅与记忆

- [行为检查（中文先）](behavior-checks.md) — 规划任务的冻结检查设计、运行和证据格式。
- [Behavior calibration and recovery (English)](behavior-calibration.md) — 实现前基线、校正和中断恢复。
- [Review outcomes / 审阅结果](review-outcomes.md#中文) — 中文状态解释与恢复操作；English policy is above.
- [Reviewer limits (English)](reviewer-limits.md) — 哪些是宿主可强制控制，哪些仍未通过模型质量验证。
- [Reviewer diagnostics (English)](reviewer-diagnostics.md) — 单次模型调用计时和原生前后证据如何生成。
- [记忆与上下文（中文）](architecture-deep-dive.md) — 记忆作用域、压缩交接和当前检索限制，见第 5 节。

### 配置、集成与安全

- [MCP management (English)](mcp-management.md) — Web MCP 配置、权限、OAuth 和运行状态。
- [Operations / 运维（中英双语）](operations.md) — 本地服务、数据位置、恢复、升级与发布。
- [UI design notes (English)](ui-design-notes.md) — 工作区界面的设计意图与交互说明。
- [本机安全边界（中文）](security.zh.md) · [SECURITY.md (English)](../SECURITY.md) — 威胁模型、主动防护及非沙箱边界。
- [Configuration schema](../forge-agent.schema.json) — 项目验证配置的唯一允许字段。
- [Contributing](../CONTRIBUTING.md) — 变更、测试、文档和评测要求。
- [AGENTS.md](../AGENTS.md) — 仓库协作规则和实现约束。
- [CHANGELOG.md](../CHANGELOG.md) — 版本变更记录。

### 历史审查资料

- [产品与工程审查（中文）](product-audit.md) — 分阶段审查记录；各节中的旧基线问题不一定描述当前版本。

## 评测档案

评测结果绑定各自记录的代码、模型、协议和预算，不自动代表当前版本。公开入口只保留三个读者最需要的结论：

- [评测摘要](evaluation.md) — 当前发布边界、工程证据与真实模型结论。
- [SWE-bench 三组比较](evaluations/swebench-ablation-2026-11-12.md) — 真实仓库任务的历史对照，结果绑定旧代码。
- [最终 reviewer 边界实验](evaluations/reviewer-boundary-2026-11-16.md) — reviewer 机制冻结前的最后资格实验。

完整历史协议、失败记录、预注册文件和机器可读 JSON 保留在 [评测档案目录](evaluations/)。这些文件用于复现和审计，不是推荐的线性阅读路径，也不应被合并成一个“总分”。
