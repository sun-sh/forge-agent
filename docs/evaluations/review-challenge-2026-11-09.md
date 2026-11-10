# Reviewer fault-injection challenge — 2026-11-09

This is a **synthetic reviewer diagnostic**, not a natural-task coding benchmark. It exists because the clean-task ablation had no defect for the independent reviewer to discover: the corrected one-task run passed in all three arms, while the reviewer added latency and tokens without a measurable quality difference.

## Protocol

- Task: `config-normalize-cross-file` from `forge-eval-small-repo-v6`, suite fingerprint `1bcbae8b34042e4e`.
- Model: DeepSeek V4.1 Flash, medium reasoning, Pi 1.4.0, Windows / Node 24.19.0.
- Repetition: one run per arm, with the same project fixture, visible verification and held-out oracle.
- Arms: `direct`, `planned` with the independent reviewer, and evaluator-only `planned-no-review`.
- Fault: after implementation and before verification, the isolated evaluator replaced `src/config.mjs` with a known implementation that passes the visible positive case but mishandles negative retries and mixed-type tags. The file is not protected, so the test measures review and repair rather than protection enforcement.
- Success requires held-out assertions, current configured verification, workspace integrity and host completion. Costs are unknown because provider pricing was unavailable.

| Arm | Passed | Held-out oracle | Host completed | False completions | Reviewer calls | Review repairs | Total tokens | Elapsed |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| direct | 1/1 | pass | yes | 0 | 0 | 0 | 30,554 | 28.3 s |
| planned | 1/1 | pass | yes | 0 | 2 | 1 | 316,641 | 156.5 s |
| planned-no-review | 0/1 | fail | yes | 1 | 0 | 0 | 87,114 | 61.7 s |

The planned reviewer returned a blocking finding, the parent performed one bounded repair, and the second verification/review cycle passed. The no-review arm completed after visible verification but retained the injected defect; the external held-out oracle rejected it. The direct arm did not receive the synthetic mutation and is included as a clean control for the run.

This supports a narrow engineering claim: the independent reviewer and bounded repair path can prevent this injected false completion. It does not estimate the reviewer's natural-task precision, prove that planned execution is generally better, or justify comparing Forge with another agent. The reviewer cost is substantial in this run, so the default adaptive path should remain available and review should be reserved for tasks where the extra gate is worth the latency.

## Fingerprints

- Git revision: `29978dd7ab2a80e8e83fd97d8f276e8500dd7e45`
- Harness fingerprint: `000a508ec9c9c2258a1b8827baad80e4b8e196dafe4f0b2f448ec6301ca2d972`
- Environment: Node `v24.19.0`, `win32/x64`, Pi `1.4.0`

The full local report and per-run evidence remain in the ignored evaluation output directory. They are not published because they contain local execution details.

## 中文说明

这是一项**审阅器故障注入诊断**，不是自然任务编码 benchmark。之前的干净小任务三组都能通过，reviewer 没有缺陷可发现，因此只能看到额外成本，看不到质量收益。

本次在实现完成、自动验证开始前，在隔离项目中把 `src/config.mjs` 替换为一个能通过可见正向检查、但会错误处理负数 retries 和混合类型 tags 的实现。`planned` 的独立 reviewer 发现问题，触发一次有界修复后通过 held-out oracle；`planned-no-review` 完成了宿主流程，但被外部判题拦截并记为一次 false completion。

这只支持一个窄结论：reviewer 和修复闭环能够阻止这类注入的错误完成。它不代表自然任务上的 reviewer 精度，也不证明规划流程整体更强。真实模型运行中 planned 的成本明显高于 no-review，因此默认自适应路径仍然保留，规划和独立审阅应留给值得额外门禁的任务。
