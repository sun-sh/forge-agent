# Final repaired Direct baseline — 2026-11-12

This is the corrected five-task Direct baseline after the Git submodule workspace-evidence repair. It is a real-model SWE-bench Lite pilot, not a full Lite score or a competitor ranking.

## Protocol

GitHub Actions run [43166685286](https://github.com/sun-sh/forge-agent/actions/runs/43166685286) used the repaired Forge revision `e17f903525342a07cf6891ad93bbd8186e1292ab`, the official DeepSeek `deepseek-flash` model, medium reasoning, the frozen five-task cohort and three repetitions per task. All 5 baseline/reference pairs validated before model execution, and the Provider preflight passed.

Each run used the fixed budget: 30 minutes, 160 model turns, 400 tool calls, 200,000 generated tokens and a configured USD 50 ceiling. Provider pricing was unavailable, so cost remains unknown. Official resolution was evaluated in fresh containers after Forge collected the patch.

## Aggregate results

| Metric | Result |
| --- | ---: |
| Scheduled executions | 15 |
| Officially assessed | 15 |
| Officially resolved | 9/15 (60%) |
| Forge completed | 15/15 |
| Forge accepted | 9/15 (60%) |
| False completions | 6/15 (40%) |
| Infrastructure failures | 0/15 |
| Protected/test-file violations | 0 |
| Empty patches | 0 |
| P50 execution time | 196.5 s |
| P95 execution time | 570.4 s |
| Model turns | 397 |
| Tool calls | 477 |
| Request tokens | 9,233,515 |
| Generated tokens | 237,751 |
| Cache-read tokens | 8,722,176 |

## Per-task results

| Task | Official resolved | Accepted | False completions | Infrastructure failures |
| --- | ---: | ---: | ---: | ---: |
| scikit-learn 13584 | 3/3 | 3/3 | 0 | 0 |
| Flask 4045 | 0/3 | 0/3 | 3 | 0 |
| Matplotlib 23563 | 0/3 | 0/3 | 3 | 0 |
| Astropy 6938 | 3/3 | 3/3 | 0 | 0 |
| SymPy 18189 | 3/3 | 3/3 | 0 | 0 |

The Astropy result is the direct validation of the gitlink repair: the pre-fix run had 3/3 freshness infrastructure failures; the repaired run reached official grading and resolved all 3 repetitions.

The remaining quality problem is false completion. Flask and Matplotlib both reached Forge's completed state and passed the visible syntax check, but the independent official grader rejected all six patches. This is why Forge completion and official resolution remain separate fields.

## Identity and evidence

- Protocol: `forge-swebench-lite-official-v2`.
- Cohort fingerprint: `6810ced4345d86b7359c2513c631e749ad4598e256de789554d38a9f851a34b0`.
- Harness fingerprint: `ccfec774c8a83947b902ee64899223535e08d9397a0978934b59887c26bb7bb7`.
- Backend hash: `06de453652119882dc311f17cd4c1e8aca5e52b09b6fd5a6ba46cfde4c923abc`.
- Package hash: `ccadc91f712db95ae0a77ee3d29a2b643ee6fe65ed42689fdc05a44f6195911c`.

The machine-readable aggregate is available as [JSON](swebench-direct-final-2026-11-12.json). The raw GitHub artifact retains individual patches, official reports, snapshots and failure evidence; public documentation excludes credentials, endpoints and runner-local paths.
