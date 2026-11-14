# Behavioral checks / 行为检查

## 中文

“规划并执行”在 Agent 模式且项目配置了至少一条 `verify` 时，启用独立行为检查。Direct、自适应、只读问答/规划、纯验证请求和未配置检查的轻量实现不增加这轮模型调用；历史任务没有 `behavior` 字段时保留兼容行为。隔离评测的 `planned-no-review` 仍用于消融，普通 Web 请求不能关闭门禁。CLI 继续使用 Pi 和既有配置验证，没有宣称具有 Web 的任务编排。

流程是：原始需求 → 只读检查设计 → 实现 → 冻结命令执行 → 配置验证 → 独立审阅。检查设计在原始实现之前建立全新 Pi 上下文，不接收实现步骤、实现者推理或实现转录。路径提示只用于定位。2–3 条结构化检查至少包含原触发条件和一条合理边界，逐项引用原始请求中的原文；假设与未解决的预期单列。范围、JSON schema、命令唯一性和原文引用由宿主校验；宿主不因 schema 合法就宣称预期正确。无法确认的异常类型、输入约定或环境应返回 unavailable，而不是创造隐藏验收要求。

检查方案保存在 `task.behavior.plan`，设计者会话 ID/模型和来源存入 `designer`。正常新任务的来源是 `before_implementation`；从旧实现工作区新增的设计标明 `resumed_workspace`，不冒称盲测。方案冻结后，自动修复和明确继续均复用它，不因失败而降低预期。检查设计普通上限为 3 分钟、12 回合、60 工具、16,000 输出 token/$2，受父预算约束；它不是扩大后的交付审阅额度。价格未知时金额阈值不是计费保证。

`check` 阶段通过主 Pi 会话执行相同文本、指定 shell 的命令。宿主只开放内建 readers 和匹配冻结方案的 bash/powershell；禁止文件写工具、MCP、委派和替换/重复命令。单条命令最长 120 秒，未填写的方案默认 60 秒；继续获取新的 runId，不复用上次命令结果。执行前再次确认 Agent 模式和项目信任。Pi 仍拥有 model/tool loop 与实际进程执行，Forge 不另建模型循环或从模型 JSON 直接启动命令。

Shell 本身仍有启动用户的 OS 权限，限制工具名和检查命令不构成 OS 沙箱，也不能保证任意模型命令没有副作用。不要在本机直接执行不信任仓库；使用容器、VM 或受限账户。只读设计者可以提出命令但不能运行；主会话受原有信任/模式控制。检查提示要求不安装依赖、不联网、不读凭证、不修改测试/配置和源文件；执行后对比工作区，保护路径仍由原有验证器保留初始指纹。工作区版本变化、无法完整观测或配置验证改变文件都会令证据无效；受保护文件变化仍直接失败。

宿主在 Pi `tool_result` 接收原生 `structuredContent.exit_code/output/truncated`，与命令哈希、检查 ID、runId、toolCallId、shell 对齐后写入持久状态。没有退出码、零测试结果、输出截断、敏感输出或缺命令回执都不会从模型正文推断通过。输出保留有界片段和完整输出哈希；敏感内容省略。非零退出码记录命令失败，但不自动等于源代码缺陷。全部精确回执、退出码零、输出未显示失败/零测试且工作区稳定才报告检查命令通过。

这证明的是“这些模型提出的命令确实在该版本运行并返回结果”，不证明完整需求覆盖，也不保证检查程序正确、失败没有被 shell 脚本掩盖。一个 `echo success` 的零退出码不能由宿主自动理解为真实语义测试；独立设计与最终审阅仍可能出错。因此结果继续是 `implemented_unverified`、`acceptance=unverified`、`resolutionClaimed=false`。`task.result.behaviorChecks` 单独展示 `not_run/running/passed/failed/unconfirmed`。检查缺失时，静态 `ready` 也不能让 Planned 执行正常收尾。

检查运行状态、方案、回执和请求哈希与任务一起持久化。中断的 running 恢复为 unconfirmed；继续保留方案，重新执行检查与配置验证，获取当前版本证据，不重放已经完成的实现。中断发生在实现时先继续实现；阶段为 check/verify/review 时从当前代码补检查。自动修复继续使用共享 `verifyRetries`；补证机会仍至多一次，不重置预算。不允许靠删除验证配置消除已经启用的行为门禁。

## 审阅分类

新 reviewer 的每个 `issues` 条目必须有对应 `issueKinds`：`code_defect`、`missing_execution`、`environment` 或 `requirement_ambiguity`。宿主执行新审阅时严格校验；旧持久化记录仍可读。

纯缺执行、环境或预期不明的 findings 归一化为 `insufficient_evidence`，保留原 finding 在 notes，将 unmet 转为 unconfirmed，并引导 `provide_evidence`；不计入代码缺陷数量。不混淆“断言命令退出非零”“程序必有缺陷”和“未知环境”。包含真实 code_defect 的混合 finding 仍阻断并按具体缺陷修复。检查失败的原始回执保留，即使 reviewer 错判 ready 也不会被抹掉。

## English

Planned Web changes with configured verification freeze a fresh read-only Pi session's 2–3 original-request reproduction/boundary checks before implementation. The designer sees no implementation transcript or plan. Exact request quotes, ordered IDs, limits and unique commands are schema-validated; semantic correctness is still a model hypothesis. Unsupported checks/ambiguous expectations remain unavailable, not invented requirements. Direct, read-only, pure verification, unconfigured-check and legacy paths retain their scope; this does not add Planned orchestration to the CLI.

The parent Pi session executes only exact frozen commands in the `check` phase, under existing Agent mode, trust and parent budget. Native Pi readers/shells are admitted; mutation tools/MCP/delegation/substitute commands are blocked. Commands retain launching-user OS permissions: no OS sandbox is claimed. Each check has a 1–120-second bound, with 60 seconds as the plan default. Pi owns actual turns and processes. Source/test/config preservation is checked by workspace/protection fingerprints, not inferred from a command description.

Receipts bind run/check/tool IDs, command hashes, native exit codes, bounded output/hash, truncation and workspace identity. Prose, missing exits, zero-test observations, incomplete/sensitive output and stale workspaces never become passing evidence. Nonzero exits record process failure, not automatic code-defect attribution. All receipts must match the same frozen plan and current version. Model-ready cannot override a missing/failed/stale receipt gate. Passing these proposed commands does not prove full coverage or certify resolution; product results stay implemented/unverified.

Continuation persists the frozen plan and original request hash, replaces old execution receipts with a fresh run ID and reruns checks/verification without replaying successful implementation. Running checks restore as unconfirmed. Repair/evidence allowances remain shared and bounded; removing configuration cannot erase an already enabled behavioral gate. Designer/session origin distinguishes pre-implementation from restored-workspace design.

New review findings carry a parallel `issueKinds` list. Missing execution, environment limitations and ambiguous expectations normalize to insufficient evidence with `provide_evidence`, preserving text and IDs instead of claiming source defects. Only concrete code-defect findings drive code repair. Persisted legacy reviews remain readable. No earlier synthetic/upstream evaluation is relabeled as validation of this implementation; meaningful quality evidence requires a new separately fingerprinted run.


## Qualification / 本轮验证

The [engineering record](evaluations/behavior-engineering-2026-11-14.json) binds the final source hashes and distinguishes one full-run wait timeout from a passing unchanged-file rerun: 775/776 tests passed in the full run; the five output-recovery tests then passed in isolation, with the planned case taking 15.876 seconds under the unchanged 45-second bound. This is grouped revalidation, not a claim that one complete run or remote CI was green. Typecheck, build, CLI/bin and local tarball checks passed; isolated Edge acceptance passed, and the existing scripted evaluation entry passed 1/1. Earlier MCP/browser fixture failures remain retained. No product/test timeout or review budget was enlarged to remove the final full-run failure.

The [real-model diagnostic](evaluations/behavior-native-gate-2026-11-14.md) retains two format-related failures on correct candidates and the third attempt's shared-plan success/failure receipts. Those measurements qualify one explicit controlled behavior, not the historical upstream misses. 普通全量负载下仍观察到一次审阅等待时延波动；本轮没有宣称所有稳定性问题或 SWE-bench 漏检已经解决。


The [frozen upstream replay protocol](upstream-behavior-replay.md) now has [original-image execution evidence](evaluations/behavior-upstream-2026-11-14.md). The revised samples deliver both correct candidates, but the failing-candidate stops are invalid expectations/environment and budget exhaustion, not demonstrated concrete-defect detection. All first attempts remain separate.


## Designer convergence

The first original-image replay exhausted the designer's 12-turn cap on Matplotlib and Astropy while reading source, before producing checks. The designer now reads the supplied file hints first, receives a remaining-read notice after six native reads/searches, and loses further tools after ten, leaving a native Pi turn to return the bounded plan or an explicit unavailable result when the hard budgets still permit it. Output-token headroom is not guaranteed, as the revised Matplotlib sample demonstrates. The model-turn, duration and cost ceilings are unchanged. This is a collection/finalization boundary, not another agent loop or a claim that ten reads establish behavior. The original exhausted runs remain published separately from any subsequent qualification.
