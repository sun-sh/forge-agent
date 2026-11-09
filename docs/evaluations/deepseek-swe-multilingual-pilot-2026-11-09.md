# DeepSeek V4.1 Flash：固定仓库评测试运行（2026-11-09）

这份记录发布一组真实模型的**试运行**，用于展示 Forge 的外部验收、保护文件和基础设施故障分类。它不是 20 题成绩，也不是 direct 与 planned 的公平对照：同一个 Axios 题只各运行一次，planned 运行还触发了预算与 Windows 清理故障。因此不能据此宣称 Forge 或该模型的总体编码能力。

## 协议

- 来源数据集：`SWE-bench/SWE-bench_Multilingual`
- 数据集 revision：`846e647b9f33c0b51b739d005d13d85493c9af09`
- 固定 cohort：20 题
- baseline/reference 校验通过：11 题
- validation skipped：9 题
- 20 题 cohort fingerprint：`3f9ee68acbe2a884ea4a14ad10913d1bdbbeedc656ae52d139a5838fbc2036e8`
- 实际模型试运行：`deepseek/deepseek-v4.1-flash`（已省略本机 Provider 标识）
- Node.js：24.19.0；Pi Coding Agent：1.4.0；平台：Windows
- 费用：模型目录价格为 0，实际费用记为未知；`$0` 不代表免费

校验无效的 9 题没有发送模型请求，也没有被算作模型失败。模型试运行从同一公开 suite 中抽出 `axios-axios-4731`，形成单题 suite，单题 suite fingerprint 为 `0eb8fee5396f24afaec49a75cb9e3ded7cdf81d39ced2d03f47b938a5568a34d`。每次运行均使用固定 commit、临时 worktree、独立 Forge home、外部 oracle、held-out test patch 和受保护文件列表。

## 结果

| 流程 | 执行 | 通过 | 错误完成 | 基础设施故障 | 外部 oracle | 当前验证 | 宿主完成 | 工作区完整性 | p50/p95 总耗时 | turns / tools | total tokens | 费用 |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | --- | ---: | --- |
| direct | 1 | 0 | 1 | 0 | 通过 | 通过 | 是 | 否 | 221.8s / 221.8s | 11 / 14 | 202,459 | 未知 |
| planned | 1 | 0 | 0 | 1 | 通过 | 否 | 否 | 否 | 1,033.7s / 1,033.7s | 23 / 32 | 476,826 | 未知 |

direct 的执行完成了修改，配置验证和外部 oracle 都通过，但模型修改了受保护的测试文件和依赖锁文件，所以被记录为 `falseCompletion`，没有计入通过。这个结果说明“测试通过”与“交付可接受”是两个独立门槛。

planned 在 15 分钟任务预算内没有完成实现、验证和独立审阅。保留的证据显示模型并行启动了占用同一端口的测试命令，之后又启动了长时间测试；预算中止后 Windows 仍有测试进程占用临时 worktree，清理被记录为 `infrastructureFailure`。这个结果不能作为模型代码质量的负分，也不能作为 planned 天生更差的结论；它说明当前评测协议需要把命令并发、测试端口隔离和子进程树清理作为单独实验变量。

两次运行的 token 分解如下：

| 流程 | input | output | cache read | cache write | 预算原因 |
| --- | ---: | ---: | ---: | ---: | --- |
| direct | 22,593 | 5,274 | 174,592 | 0 | 正常结束 |
| planned | 61,357 | 12,333 | 403,136 | 0 | 超过 15 分钟总时限 |

## 代码与证据指纹

报告只公开能复核协议的标识，不公开模型凭据、私有 transcript 或本机路径。下列指纹对应试运行当时的代码，不能作为后续路由、审阅时间线等修改的模型质量验证。

| 运行 | harness fingerprint |
| --- | --- |
| direct | `01e1a84819c4d92d75de123b631c1ef11c620f457f5dc73036f04c1d24306d06` |
| planned | `1244938c65cc6e4effc33b05b89a747361a376ffb0d1a2ffebbc9cb35afdfe61` |

完整本机 JSON、任务快照、日志和 diff 保存在 ignored 的 `.forge-agent/repository-evals/` 目录中，提交前需要自行审阅敏感输出。评测器在总循环异常、预算中止或清理失败时仍写 `report.json`，并把未完成部分标为 `fatalError` 或 `infrastructureFailure`。

## 结论边界

这组数据支持以下判断：

- Forge 能把外部 oracle、当前验证、工作区完整性、宿主完成状态和错误完成分开记录。
- direct 样本中，模型通过可见检查且宿主曾报告完成，但评测器因受保护文件被修改而拒绝交付。
- planned 样本中，长任务预算、测试命令并发和 Windows 子进程清理仍是需要继续工程化的边界。

这组数据不能支持以下判断：

- 不能把 11 个 valid 任务当成已经完成的 20 题模型评测；当前只有 1 题的 direct 和 1 题的 planned 试运行。
- 不能比较 Forge 与 Claude Code、OpenHands、Goose 或 Codex。
- 不能证明规划、独立审阅、记忆或子 Agent 在总体上提高了成功率。
- 不能把 validation skipped 计入模型失败，也不能把费用 0 当成真实账单。

下一次正式 cohort 应先解决命令并发与 Windows 子进程清理，再在相同模型、推理强度、预算和固定任务集下完成足够的 direct/planned 重复运行；独立 reviewer 的收益另做消融实验。

---

# DeepSeek V4.1 Flash: pinned repository pilot (2026-11-09)

This document records a real-model **pilot**, not a 20-task score or a fair direct-versus-planned benchmark. One public Axios task was run once through each workflow. The planned run hit the execution budget and a Windows cleanup failure, so these measurements must not be generalized to Forge or to the model.

The source cohort contained 20 pinned tasks from `SWE-bench/SWE-bench_Multilingual`. Baseline/reference validation accepted 11 and skipped 9. Skipped tasks did not send model requests. The cohort fingerprint is `3f9ee68acbe2a884ea4a14ad10913d1bdbbeedc656ae52d139a5838fbc2036e8`; the extracted one-task suite has fingerprint `0eb8fee5396f24afaec49a75cb9e3ded7cdf81d39ced2d03f47b938a5568a34d`. The model was `deepseek/deepseek-v4.1-flash` (local provider identifier omitted), with Pi 1.4.0 on Node 24.19.0 and Windows. Pricing was unavailable, so cost is unknown. The recorded harness fingerprints identify the pilot code, not validation of subsequent routing or reviewer timeline changes.

| Workflow | Runs | Passed | False completions | Infrastructure failures | Oracle | Verification | Host completed | Workspace integrity | Total latency | Turns / tools | Total tokens |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | --- | ---: |
| direct | 1 | 0 | 1 | 0 | pass | pass | yes | no | 221.8s | 11 / 14 | 202,459 |
| planned | 1 | 0 | 0 | 1 | pass | no | no | no | 1,033.7s | 23 / 32 | 476,826 |

The direct run completed and passed the configured verification and external oracle, but changed protected test and lock files. The evaluator therefore classified the host's completion claim as a false completion. The planned run did not complete implementation and the subsequent verification and independent review within the 15-minute budget. Its retained evidence shows competing test commands using the same port, followed by a long-running test command; after budget cancellation, Windows test processes still held the worktree. This is recorded as infrastructure evidence, not as a model-quality score.

These results demonstrate the value of separate external acceptance and workspace-integrity gates. They do not establish a benchmark ranking, a general planned-workflow benefit, a memory or subagent gain, or a comparison with other coding agents. A full cohort run should first isolate test-process concurrency and Windows process-tree cleanup, then repeat direct and planned under identical conditions.
