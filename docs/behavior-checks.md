# Behavioral checks / 行为检查

## 中文

“规划并执行”在 Agent 模式且项目配置了至少一条 `verify` 时，启用独立行为检查。Direct、自适应、只读问答/规划、纯验证请求和未配置检查的轻量实现不增加这轮模型调用；历史任务没有 `behavior` 字段时保留兼容行为。隔离评测的 `planned-no-review` 仍用于消融，普通 Web 请求不能关闭门禁。CLI 继续使用 Pi 和既有配置验证，没有宣称具有 Web 的任务编排。

新任务流程是：原始需求 → 只读检查设计 → 父 Pi 原生基线执行 → 必要时一次只读诊断及替换方案重跑 → 实现 → 冻结命令候选执行 → 配置验证 → 独立审阅。检查设计在实现前建立全新 Pi 上下文，不接收实现步骤、实现者推理或实现转录。路径提示只用于定位。2–3 条结构化检查至少包含原触发条件和一条合理边界，逐项引用原始请求原文；假设与未解决的预期单列。范围、JSON schema、命令唯一性和原文引用由宿主校验；schema 合法不证明预期正确。无法确认的异常类型、输入约定或环境应返回 unavailable，而非创造隐藏验收要求。

检查方案保存在 `task.behavior.plan`，设计者会话 ID/模型和来源存入 `designer`。正常新任务来源为 `before_implementation`；兼容记录中的 `resumed_workspace` 不冒称原始盲测，也不允许在新任务实现后补造基线。实现前唯一可采纳的更正须经过下述校准；实现开始后，自动修复和明确继续均复用冻结方案，不因失败降低预期。检查设计及基线诊断各使用普通只读上限：3 分钟、12 回合、60 工具、16,000 输出 token/$2，且受共享父预算约束，不使用扩展交付审阅额度。价格未知时金额阈值不是计费保证。

基线不是要求所有检查先通过：完整原生回执和稳定工作区可让预期的复现失败成为 `observed`。边界/回归失败或基线不完整至多触发一次全新、仅 reader 工具的诊断；它按原请求和所属 API 源码区分 `expected_failure`、`valid_check`、`invalid_expectation`、`environment`、`unconfirmed`：提示明确要求通过且有契约支持的边界/回归检查使用 `valid_check`，真实语义不明仍保持 `unconfirmed` 并阻断；返回 `keep`、`replace` 或 `unavailable`。替换须保留检查数量、顺序 ID、类型、shell、需求原文引用，且单条超时不得增大；每个改动命令或预期须附无效预期/环境 finding 和宿主核对存在的源码引文。原方案及回执保留，替换方案在实现前重新执行。引文存在不证明相关性或预期正确；未知语义、无效诊断和缺失基线仍阻断静态 ready，不能以安装依赖、删掉失败检查或隐藏失败来更正。详见[生产校准](behavior-calibration.md#production-calibration)。

`check` 阶段通过主 Pi 会话执行相同文本、指定 shell 的命令。宿主只开放内建 readers 和匹配冻结方案的 bash/powershell；禁止文件写工具、MCP、委派和替换/重复命令。单条命令最长 120 秒，未填写的方案默认 60 秒；继续获取新的 runId，不复用上次命令结果。执行前再次确认 Agent 模式和项目信任。Pi 仍拥有 model/tool loop 与实际进程执行，Forge 不另建模型循环或从模型 JSON 直接启动命令。

Shell 本身仍有启动用户的 OS 权限，限制工具名和检查命令不构成 OS 沙箱，也不能保证任意模型命令没有副作用。不要在本机直接执行不信任仓库；使用容器、VM 或受限账户。只读设计者可以提出命令但不能运行；主会话受原有信任/模式控制。检查提示要求不安装依赖、不联网、不读凭证、不修改测试/配置和源文件；执行后对比工作区，保护路径仍由原有验证器保留初始指纹。工作区版本变化、无法完整观测或配置验证改变文件都会令证据无效；受保护文件变化仍直接失败。

宿主在 Pi `tool_result` 接收原生 `structuredContent.exit_code/output/truncated`，与命令哈希、检查 ID、runId、toolCallId、shell 对齐后写入持久状态。没有退出码、零测试结果、输出截断、敏感输出或缺命令回执都不会从模型正文推断通过。输出保留有界片段和完整输出哈希；敏感内容省略。非零退出码记录命令失败，但不自动等于源代码缺陷。全部精确回执、退出码零、输出未显示失败/零测试且工作区稳定才报告检查命令通过。

这证明的是“这些模型提出的命令确实在该版本运行并返回结果”，不证明完整需求覆盖，也不保证检查程序正确、失败没有被 shell 脚本掩盖。一个 `echo success` 的零退出码不能由宿主自动理解为真实语义测试；独立设计与最终审阅仍可能出错。因此结果继续是 `implemented_unverified`、`acceptance=unverified`、`resolutionClaimed=false`。`task.result.behaviorChecks` 单独展示 `not_run/running/passed/failed/unconfirmed`。检查缺失时，静态 `ready` 也不能让 Planned 执行正常收尾。

检查运行状态、方案、回执和请求哈希随任务持久化。实现前明确继续须保持首次基线的工作区 digest/scope，累计最多四次基线准入，包含原始、替换及中断后的恢复执行，不是四次额外重试。基线 running 恢复为 unconfirmed；诊断 running 恢复为 unavailable，单次机会仍已消耗。版本改变、无法观测或次数耗尽时须检查文件并新建任务，不能重置旧对照。实现开始后只补候选检查/验证，不重设计或重建基线；中断发生在实现时先继续实现，候选 check/verify/review 恢复获取当前版本新回执，不重放成功实现。自动修复仍共享 `verifyRetries`，审阅补证至多一次；继续不重置已用额度，也不能删除配置来消除已启用门禁。

## 审阅分类

新 reviewer 的每个 `issues` 条目必须有对应 `issueKinds`：`code_defect`、`missing_execution`、`environment` 或 `requirement_ambiguity`。宿主执行新审阅时严格校验；旧持久化记录仍可读。

纯缺执行、环境或预期不明的 findings 归一化为 `insufficient_evidence`，保留原 finding 在 notes，将 unmet 转为 unconfirmed，并引导 `provide_evidence`；不计入代码缺陷数量。不混淆“断言命令退出非零”“程序必有缺陷”和“未知环境”。包含真实 code_defect 的混合 finding 仍阻断并按具体缺陷修复。检查失败的原始回执保留，即使 reviewer 错判 ready 也不会被抹掉。

## English

New Planned Web changes with configured verification freeze 2–3 original-request reproduction/boundary checks from a fresh reader-only Pi session, then actually run the baseline through the parent Pi before implementation. The designer sees no implementation transcript or plan. Exact request quotes, ordered IDs, limits and unique commands are schema-validated; semantics remain a model hypothesis. Unsupported/ambiguous checks remain unavailable. Direct/adaptive, read-only, pure verification, unconfigured and legacy paths retain their scope; no new configuration keys or CLI Planned orchestration are added.

A complete stable baseline can be observed with an expected reproduction failure. A failed boundary/regression or incomplete baseline admits one fresh reader-only diagnosis. Its prompt explicitly classifies a passing, contract-supported boundary/regression as `valid_check`; uncertain semantics remain `unconfirmed` and blocking. Only a complete replacement preserving count, ordered IDs, kinds, shells, original request anchors and non-increasing timeouts is admissible. Each changed command/expectation needs a source-quote-validated invalid-expectation/environment finding. Quote presence does not prove relevance. Original plans/receipts survive, and replacements execute again before implementation. Comparisons (`changed_to_pass`, `unchanged_pass`, `pre_existing_failure`, `candidate_regression`, `unconfirmed`) are observations, not concrete-defect proof; output-hash equality is not semantic equivalence. Unavailable/invalid baseline evidence still blocks static ready. See [production calibration](behavior-calibration.md#production-calibration).

The parent Pi session executes only exact frozen commands in the `check` phase, under existing Agent mode, trust and parent budget. Native Pi readers/shells are admitted; mutation tools/MCP/delegation/substitute commands are blocked. Commands retain launching-user OS permissions: no OS sandbox is claimed. Each check has a 1–120-second bound, with 60 seconds as the plan default. Pi owns actual turns and processes. Source/test/config preservation is checked by workspace/protection fingerprints, not inferred from a command description.

Receipts bind run/check/tool IDs, command hashes, native exit codes, bounded output/hash, truncation and workspace identity. Prose, missing exits, zero-test observations, incomplete/sensitive output and stale workspaces never become passing evidence. Nonzero exits record process failure, not automatic code-defect attribution. All receipts must match the same frozen plan and current version. Model-ready cannot override a missing/failed/stale receipt gate. Passing these proposed commands does not prove full coverage or certify resolution; product results stay implemented/unverified.

Before implementation, explicit continuation requires the same first-admitted workspace digest/scope and shares a ceiling of four total baseline admissions, including initial/replacement/interrupted runs. Interrupted baselines restore as unconfirmed; an interrupted diagnosis is unavailable and remains consumed. After implementation starts, continuation/repairs preserve design and baseline history, obtain fresh candidate run IDs and verification, and never rebuild a baseline on implemented files. Running candidate checks restore as unconfirmed. Repair/evidence allowances stay shared and bounded; removing configuration cannot erase an enabled gate. Legacy designer/session origin is not a retrospective baseline claim; a continued legacy task already past implementation entry cannot create a new design or baseline.

New review findings carry a parallel `issueKinds` list. Missing execution, environment limitations and ambiguous expectations normalize to insufficient evidence with `provide_evidence`, preserving text and IDs instead of claiming source defects. Only concrete code-defect findings drive code repair. Persisted legacy reviews remain readable. No earlier synthetic/upstream evaluation is relabeled as validation of this implementation; meaningful quality evidence requires a new separately fingerprinted run.


## Historical qualification / 历史验证

The following reports qualify their recorded code/protocol only. Their historical engineering counts and model outcomes do not validate the production baseline/correction lifecycle added above. New evidence will be recorded separately after a fresh run; no new test/model result is asserted here.

The [engineering record](evaluations/behavior-engineering-2026-11-14.json) binds the final source hashes and distinguishes one full-run wait timeout from a passing unchanged-file rerun: 775/776 tests passed in the full run; the five output-recovery tests then passed in isolation, with the planned case taking 15.876 seconds under the unchanged 45-second bound. This is grouped revalidation, not a claim that one complete run or remote CI was green. Typecheck, build, CLI/bin and local tarball checks passed; isolated Edge acceptance passed, and the existing scripted evaluation entry passed 1/1. Earlier MCP/browser fixture failures remain retained. No product/test timeout or review budget was enlarged to remove the final full-run failure.

The [real-model diagnostic](evaluations/behavior-native-gate-2026-11-14.md) retains two format-related failures on correct candidates and the third attempt's shared-plan success/failure receipts. Those measurements qualify one explicit controlled behavior, not the historical upstream misses. 普通全量负载下仍观察到一次审阅等待时延波动；本轮没有宣称所有稳定性问题或 SWE-bench 漏检已经解决。


The [frozen upstream replay protocol](upstream-behavior-replay.md) now has [original-image execution evidence](evaluations/behavior-upstream-2026-11-14.md). The revised samples deliver both correct candidates, but the failing-candidate stops are invalid expectations/environment and budget exhaustion, not demonstrated concrete-defect detection. All first attempts remain separate.


See [historical frozen baseline/candidate calibration](behavior-calibration.md#historical-frozen-check-diagnostic) for the separate no-model diagnostic. Its reports remain immutable; the new production lifecycle is documented separately on that page.

## Designer convergence

The first original-image replay exhausted the designer's 12-turn cap on Matplotlib and Astropy while reading source, before producing checks. The designer now reads the supplied file hints first, receives a remaining-read notice after six native reads/searches, and loses further tools after ten, leaving a native Pi turn to return the bounded plan or an explicit unavailable result when the hard budgets still permit it. The revised Matplotlib sample exhausted output before finalizing, so the designer now also closes collection at 8k observed output tokens, when at most one exploration turn remains, or when the smaller local/parent output remainder is at most 6k. Existing OpenAI-compatible output-limit fields are capped to 2k during collection and at most 6k during finalization, never above the smaller remaining allowance or a lower Provider ceiling. The sole schema correction also closes collection immediately and uses the finalization allowance; this avoids trapping a truncated early plan under the exploration cap twice. Other APIs (including Anthropic thinking budgets) are left to Pi rather than guessing compatible wire fields. Native usage arrives at response boundaries and Providers can ignore limits, so this is a bounded convergence policy rather than guaranteed completion. Native Pi fixture regressions cover the new policy; the previous model samples do not qualify it. The model-turn, duration and cost ceilings are unchanged. This is a collection/finalization boundary, not another agent loop or a claim that ten reads establish behavior. The original exhausted runs remain published separately from any subsequent qualification.
