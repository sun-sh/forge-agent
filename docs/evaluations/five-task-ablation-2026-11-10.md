# Five small coding tasks, three workflows, three repetitions — 2026-11-10

The [allowlisted aggregate](deepseek-five-task-ablation-2026-11-10.json) retains all 45 executions. Each of five hand-authored miniature repositories ran through adaptive direct, planned, and evaluator-only planned-no-review three times. These are actual DeepSeek V4.1 Flash calls with medium reasoning, without injected defects. They are not upstream issue fixes or a comparison with other agents.

## Protocol

Tasks: inclusive clamp bounds, strict port parsing, stable deduplication, cross-file configuration normalization, and root-safe path resolution. Every execution starts from fresh task files in an isolated project and Pi session. Only model/auth configuration enters the temporary evaluation home; user sessions, project memory and MCP configuration are not copied. The same explicit budget applies to every execution: 10 minutes, 80 model turns, 160 tool calls, 40,000 generated tokens, no cumulative request-token stop and a configured USD 30 ceiling. Model prices were unavailable, so observed dollar cost remains unknown.

Order rotates over tasks and repetitions using counterbalanced-cyclic-v1; each arm occupies each position once for a task across its three repetitions. Success requires held-out external assertions, current host verification, protected-file integrity and completed host state. Failed runs would remain in the denominator. No baseline/reference task was skipped in this miniature suite.

## Observed results

| Workflow | Passed | False completions / completed | Median execution | p95 execution | Request tokens | Generated tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | 15/15 | 0/15 | 36.6 s | 64.4 s | 541,692 | 20,980 |
| planned | 15/15 | 0/15 | 79.3 s | 148.4 s | 1,171,587 | 84,176 |
| planned-no-review | 15/15 | 0/15 | 54.2 s | 100.2 s | 1,123,263 | 53,097 |

All 45 runs passed all four delivery gates. Planned execution activated 15 independent reviewers. One reviewer needed the existing bounded JSON-format correction; no implementation repair was required by a reviewer. The no-review arm activated no reviewers. Production HTTP requests cannot select that experimental bypass.

Execution time excludes task setup; total duration remains in the aggregate. Request-token totals include repeated context and cache reads. This run shared a Windows host with qualification and browser checks, so elapsed times describe this batch rather than an isolated performance SLO. The p95 in an arm of 15 is effectively the largest observed run, not a reliable tail estimate.

## Interpretation

There is no observed coding-success or false-completion benefit from planning or independent review on these five easy tasks. Planned median execution was 79.3 seconds versus 36.6 seconds for direct. The adaptive default remains appropriate; planning/review should be selected for tasks whose additional evidence is worth the overhead. This is a bounded descriptive result, not evidence that review can never help. Prior paired correct/defective reviewer diagnostics remain a separate protocol.

Small functions and two-file modules do not measure large repository understanding, long-running compaction, recovery after hours of work, multi-agent gains, browser task quality or visual animation quality. Those remain separate evaluation work. There is no competitor ranking and no claim of production-wide reliability from 45 successes.

## Identity and retained evidence

- Suite version: forge-eval-small-repo-v6; fingerprint: `038cbefa1a6e76c2`.
- Harness fingerprint: `77d288c931c47f1d80ec39c7d63459625169b7cb954ca31957f748399f709688`.
- Environment: Windows x64, Node v24.19.0, Pi 1.4.0.
- Base revision: `3032f71540ab775ae5bf3bb137d9059385c7a20b` with then-uncommitted edits. The retained JavaScript harness fingerprint, not the base commit alone, identifies evaluated code.

Later UI and cancellation refinements have separate [conversation qualification](conversation-stability-2026-11-10.md); this run is not retroactively labelled as coverage of them. Raw snapshots, diffs, harness files and initial diagnostic failures stay in local private artifacts. The public aggregate omits credentials, endpoints, transcripts and user-specific paths. Earlier measurements remain linked from [evaluation methods](../evaluation.md).

## 中文结论

这是五个手写小仓库任务、三条执行路径、每条路径各三次重复的真实模型实验，共 45 次；不是大型开源仓库 issue benchmark。三组均通过 15/15，未观察到错误完成；规划并执行的中位执行时间约 79.3 秒，自适应约 36.6 秒。这批题上没有证明额外规划或审阅提高了成功率，因此继续以自适应作为默认。所有逐次结果、固定预算与代码指纹都保留，实际美元费用未知。
