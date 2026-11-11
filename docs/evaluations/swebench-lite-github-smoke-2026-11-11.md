# GitHub Docker smoke — 2026-11-11

GitHub Actions run [43007161220](https://github.com/sun-sh/forge-agent/actions/runs/43007161220) passed on commit `b4977ef806546f6658289f2f8b52071237eb4634`.

This was a one-instance plumbing smoke for `scikit-learn__scikit-learn-13584`, with a scripted no-key model. It deliberately wrote a marker file and did not repair the benchmark issue. It is not a model-quality score.

| Gate | Result |
| --- | --- |
| Linux x86_64 runner and Docker | passed |
| Pinned SWE-bench harness `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` | passed |
| Base baseline | target F2P failed and P2P passed |
| Gold reference patch | officially resolved |
| Forge package and task runner image | passed |
| Forge task completed | passed |
| Marker file collected in prediction patch | passed |
| Protected test files changed | no |
| Independent official result for scripted Agent | unresolved |
| False completion detected | yes |
| Real model requests | 0 |

The run used a fresh task container and a separate official grading container. The artifact retained official reports, Forge snapshot and the generated patch for local inspection. No API key, user session, or raw project path was included in the public report.

This establishes that the GitHub Linux/Docker path and the completion-vs-official-result boundary work. It does not establish a SWE-bench pass rate. The next measurement is baseline/reference validation for the frozen 20-task cohort, followed by real-model execution on the configured evaluation machine.
