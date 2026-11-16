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

报告绑定各自记录的代码、模型、协议和预算。它们是历史样本，不自动验证后续版本；失败运行和原始判读应与汇总一起阅读。相应协议与机器可读数据在报告或评测索引中链接；并非每份叙述报告都有独立 JSON。

### 当前发布边界与审阅实验

- [Final reviewer boundary qualification — 2026-11-16](evaluations/reviewer-boundary-2026-11-16.md) — 最终四补丁实验；原生证据准备不合格，假设未获资格验证。
- [Boundary preregistration](evaluations/reviewer-boundary-protocol-2026-11-16.md) — 选择、顺序、预算和停止门槛。
- [Reviewer compatibility replay — 2026-11-16](evaluations/reviewer-compatibility-2026-11-16.md) — 固定候选审阅结果；未达漏检门槛。
- [Compatibility preregistration](evaluations/reviewer-compatibility-protocol-2026-11-15.md) — 目标归因和预注册判读规则。
- [Reviewer call latency — 2026-11-16](evaluations/review-call-latency-2026-11-16.md) and [protocol](evaluations/review-call-latency-protocol-2026-11-16.md) — 固定输入单次调用计时。
- [Required tests omitted — 2026-11-13](evaluations/review-no-tests-2026-11-13.md) — 一次明确漏跑用户要求测试的拦截探针。
- [Reviewer counterexamples — 2026-11-13](evaluations/review-counterexamples-2026-11-13.md) — 固定模拟机制，不代表真实仓库质量。
- [Upstream review replay — 2026-11-14](evaluations/review-upstream-replay-2026-11-14.md) — 历史漏检复放。
- [Command-evidence repair — 2026-11-12](evaluations/review-command-evidence-2026-11-12.md) — 定向 Astropy/SymPy 修复路径。
- [Review budget/evidence — 2026-11-13](evaluations/review-budget-evidence-2026-11-13.md) — 两次不同样本的预算和证据变化。
- [Review fault-injection challenge — 2026-11-09](evaluations/review-challenge-2026-11-09.md) — 控制性挑战，不是自然任务精度。
- [Earlier review ablation — 2026-11-09](evaluations/review-ablation-2026-11-09.md) · [focused review](evaluations/focused-review-2026-11-10.md) — 较早机制试验。

### 验证门禁、恢复与会话

- [Production behavior calibration — 2026-11-15](evaluations/behavior-production-2026-11-15.md) — 新版生产基线流程及保留失败。
- [Frozen-check calibration — 2026-11-15](evaluations/behavior-calibration-2026-11-15.md) — 历史原生回执诊断。
- [Native behavior gate — 2026-11-14](evaluations/behavior-native-gate-2026-11-14.md) — 单一正确/错误对照任务。
- [Upstream behavior replay — 2026-11-14](evaluations/behavior-upstream-2026-11-14.md) — 原始镜像中的固定候选。
- [Upstream replay protocol](upstream-behavior-replay.md) — 固定原始镜像复放的输入、隔离与判读规则。
- [Conversation stability — 2026-11-10](evaluations/conversation-stability-2026-11-10.md) — 历史导航、恢复与压缩验收。
- [Network and empty-verification recovery — 2026-11-10](evaluations/network-empty-verification-2026-11-10.md) — 联网、交付与空验证回归。
- [Structured handoff — 2026-11-08](evaluations/structured-handoff-2026-11-08.md) · [runtime-depth replay](evaluations/runtime-depth-2026-11-08.md) — 较早任务理解和执行链路。

### 模型和仓库任务比较

- [SWE-bench three-arm ablation — 2026-11-12](evaluations/swebench-ablation-2026-11-12.md) — Direct / Planned-no-review / Planned 固定样本对照。
- [Direct baseline](evaluations/swebench-direct-final-2026-11-12.md) · [baseline repair history](evaluations/swebench-direct-baseline-2026-11-12.md) — 原始评测及修复后补判。
- [SWE-bench protocol](evaluations/swebench-lite-2026-11-10.md) — 数据、harness、环境和预算。
- [GitHub Docker smoke](evaluations/swebench-lite-github-smoke-2026-11-11.md) · [first real-model run](evaluations/swebench-real-github-2026-11-11.md) — 环境验证与首次 Provider 网络失败。
- [DeepSeek clean ablation](evaluations/deepseek-current-ablation-2026-11-11.md) — 简单任务对照。
- [Five-task, three-workflow run](evaluations/five-task-ablation-2026-11-10.md) — 早期固定小题重复实验。
- [Planned delivery regression](evaluations/deepseek-planned-delivery-2026-11-10.md) · [multilingual repository pilot](evaluations/deepseek-swe-multilingual-pilot-2026-11-09.md) — 早期定向试运行。

### 附属原始工件

底层 JSON、预注册、分阶段报告和工程对照保留在 evaluations 目录；优先从上面的 Markdown 报告进入，以免把孤立数据误读为独立成绩。完整原始文件清单见 [evaluation directory](evaluations/)。
