# SWE-bench Lite workflow ablation — 2026-11-12

## Decision / 结论

The five-issue cohort does **not** support enabling independent model review by default. Direct and Planned + reviewer both resolved 9/15; the review arm delivered only 5 correct completed results and blocked four patches that passed official grading. Planned-no-review resolved and delivered 11/15 on this sample. It is a descriptive small-sample lead, not proof that planning generally improves coding. Adaptive execution remains the default.

这批实测不支持默认启用独立模型审阅。Direct 与带 reviewer 的 Planned 官方通过均为 9/15；带审阅组正确且完成交付只有 5 次，另有 4 份正确补丁被阻断。Planned-no-review 在本样本中通过并交付 11/15，表现最好；只有 5 道独立题目，不能据此证明规划普遍更强。默认保持自适应。

## Results / 结果

| Metric | Direct | Planned-no-review | Planned + independent model reviewer |
| --- | ---: | ---: | ---: |
| Scheduled / officially assessed | 15/15 | 15/15 | 15/15 |
| Officially resolved | 9 (60.0%) | 11 (73.3%) | 9 (60.0%) |
| Accepted patch (resolved + integrity) | 9 | 11 | 9 |
| Forge completed | 15 | 15 | 9 |
| Correct completed delivery | 9 | 11 | 5 |
| False completion | 6 | 4 | 4 |
| Resolved patch, host not completed | 0 | 0 | 4 |
| Unresolved patch, host not completed | 0 | 0 | 2 |
| Infrastructure failure after regrading | 0 | 0 | 0 |
| Request tokens (includes cache reads) | 9,233,515 | 18,963,602 | 25,291,022 |
| Output tokens | 237,751 | 289,503 | 458,902 |
| Model turns / tool calls | 397 / 477 | 545 / 614 | 758 / 917 |
| Review calls / repairs | 0 / 0 | 0 / 0 | 16 / 1 |
| P50 / P95 execution time | 196.5 / 570.4 s | 172.9 / 698.2 s | 229.3 / 506.5 s |
| Cost | Unknown | Unknown | Unknown |

Completion precision (correct completed deliveries / Forge completed) is 9/15 (60.0%), 11/15 (73.3%) and 5/9 (55.6%). False-completion rates over **all 15 scheduled executions** are 40.0%, 26.7% and 26.7%. The review arm’s lower false-completion count partly reflects stopping; among its six stops, four patches passed and two failed official grading. It did not improve official resolution or correctly completed delivery in this comparison.

Planned-no-review used 2.05× the Direct request tokens. The reviewer arm used 1.33× the no-review request tokens and 2.74× Direct tokens. Arms are separate stochastic runs, so these differences are observed arm totals, not an exact attribution of each token to review. Cache-read tokens are 8,722,176 / 17,640,320 / 23,106,560. Execution time covers **all model attempts**, excluding image preparation and external grading. Prices were absent in the configured catalog; cost remains unknown.

错误完成减少不能单独等同于质量提高。带审阅组的 6 次停止中，4 份补丁实际通过、2 份失败；正确交付反而少于另外两组。三组均没有测试文件改动、保护违规或空补丁。

### Per-issue official resolution

| Instance | Direct | Planned-no-review | Planned + reviewer |
| --- | ---: | ---: | ---: |
| scikit-learn__scikit-learn-13584 | 3/3 | 3/3 | 3/3 |
| pallets__flask-4045 | 0/3 | 1/3 | 0/3 |
| matplotlib__matplotlib-23563 | 0/3 | 1/3 | 0/3 |
| astropy__astropy-6938 | 3/3 | 3/3 | 3/3 |
| sympy__sympy-18189 | 3/3 | 3/3 | 3/3 |

The no-review arm’s two extra passes are one Flask run and one Matplotlib run, each 1/3. This variation is retained rather than selecting the successful repetition.

## Original measurement and separate regrading

- Direct: [43166685286](https://github.com/sun-sh/forge-agent/actions/runs/43166685286), revision `e17f903525342a07cf6891ad93bbd8186e1292ab`.
- Planned original: [43184349339](https://github.com/sun-sh/forge-agent/actions/runs/43184349339), revision `ee74e75f6b55d13a79d86c7da0553777131a97a3`. The original report retained 15 executions but graded only nine: five resolved, four false completions and six rows incorrectly excluded as infrastructure.
- Official retained-patch regrading: [43196437456](https://github.com/sun-sh/forge-agent/actions/runs/43196437456), grader revision `7d97a9675c3063b047415c9056d0c163d3c14ea9`, **zero model requests**. All 15 patches and snapshots match the original hashes; the previous nine assessed verdicts are unchanged. Four original stops were reviewer budgets and two were completion-gate refusals. Regrading establishes 9/15 resolved and zero infrastructure failures without changing the host verdicts.
- Planned-no-review: [43190544679](https://github.com/sun-sh/forge-agent/actions/runs/43190544679), same runtime revision and package as Planned. All 15 original executions reached official grading without regrading.

Regrading records its source-report hash and grader fingerprint separately. It does not relabel the source report as a new model run or validate newer runtime behavior. Nonzero evaluation workflow exits mean at least one task was not accepted; controller health is assessed from retained evidence separately. Original failures remain accessible.

补判不重新采样模型，不覆盖原报告。原 6 条“基础设施失败”通过结构化任务/子任务状态被确认为工作流停止；同一补丁进入同一官方镜像/harness 补判。旧数据及修正数据分别保留，不能把后续代码修复说成已经取得这些分数。

## Mechanism diagnosis / 机制问题

1. **Implementation assumptions became preserved requirements.** One Matplotlib handoff required rejecting 2D arrays instead of preserving supported Nx1 drawing. Static review validated that interpretation while the official behavior failed. A model-authored ledger is not additional user authority.
2. **Independent context was missing observed tool evidence.** SymPy’s parent tools recorded the repository-native runner returning 43 passed, 1 skipped and 2 expected failures. The reviewer received only the host syntax check and marked the existing-test criterion unconfirmed. Its unchanged patch passed official grading. Command receipts require bounded scope and explicit historical freshness rather than copying implementation thinking.
3. **The reviewer missed failures and blocked correct patches.** All three Flask reviews were ready while all three official evaluations failed. All three Astropy patches passed official regrading but none completed in Forge. Four reviewer attempts exhausted the 24-turn limit. Increasing that limit alone does not fix requirement assumptions or missing receipts.

因此本轮修正先处理：工作流失败不再被评测分母排除、UI 明确配置检查的边界、向只读独立 reviewer 交接有界历史命令回执，并提示再次对照原始请求。命令回执保留失败/零测试/截断信息，不能升级成当前文件已通过验收。审阅权限、预算及完成门禁没有放宽。这些改动有工程回归；**本表属于修复前代码，尚未测得修复后的真实质量收益**。

The follow-up implementation supplies bounded native command receipts and explicit model-authored requirement provenance. Regression tests exercise isolation, actual Pi shell delivery, failure preservation and size limits. The reviewer retains readers only; historical results do not replace current host verification. **Those fixes postdate all model executions in this table and have no new real-model quality score here.**

## Protocol, identity and limits

Five fixed Lite issues, three repetitions per arm, official DeepSeek `deepseek-flash`, `medium`, identical frozen budgets, changed-Python-syntax-only host checks, protected tests/configuration and independent official grading. All baseline/reference pairs validated (5/5) for every arm. The cohort, model configuration, harness, all five task image content IDs, pinned Node image and limits match.

Package hashes:

- Direct: `ccadc91f712db95ae0a77ee3d29a2b643ee6fe65ed42689fdc05a44f6195911c`.
- Both planned arms: `1761c7dcfd71d2b9ff4db53ca02cfb7025e364cb10b66a523e2180e6ca2e2508`.
- All **202 packaged dist files** have the same sorted-path/content fingerprint: `a2ebf7ae436e83141390517ff53166617a95a1a52804a34cea46dc508fec396f`. Non-executable documentation changes explain the package difference; package identities remain separate.
- Model harness: `ccfec774c8a83947b902ee64899223535e08d9397a0978934b59887c26bb7bb7`.
- Regrader: `8c8b95443085bab90241e8d4daa4e8716190cc93b205f2e220f2c32167c5ceeb`; Planned source report: `a1792a3e12313809fd574f62f0539f67f71cd82ee4ddea5f99ba7aaf35070bff`.

The [allowlisted JSON aggregate](swebench-ablation-2026-11-12.json) includes every row’s patch fingerprint and outcomes, arm identity, retained original Planned summary, regrade identity, budgets and usage. Raw artifacts contain original snapshots, patches and official reports; public documents omit credentials, endpoints and runner-local paths.

This is a descriptive five-issue subset, **not 45 independent issues**, full SWE-bench Lite, a competitor ranking or a causal proof. Arms were dispatched separately rather than jointly randomized/counterbalanced; time, provider behavior and cache conditions can differ. Repetitions on public tasks are not independent repository samples and can have training contamination. No claim is made for long-task recovery, memory gain, or quality improvement from the follow-up fixes. The [protocol](swebench-lite-2026-11-10.md) and original [Direct baseline](swebench-direct-final-2026-11-12.md) remain available.
