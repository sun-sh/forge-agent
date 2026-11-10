# DeepSeek planned delivery regression — 2026-11-10

This is a single real-model clean-task regression run during the initial diagnosis, using configured verification. It predates the empty-verification and network-tool fixes and does not validate either change. It validates the execution and evidence path; it is not a benchmark or a general coding-quality estimate.

## Protocol

- Model: DeepSeek V4.1 Flash, medium reasoning effort.
- Workflow: planned; task: config-normalize-cross-file; repetitions: 1.
- Environment: Windows, Node v24.19.0, Pi 1.4.0.
- Suite: forge-eval-small-repo-v6; suite fingerprint: 1bcbae8b34042e4e.
- Harness fingerprint: 21e8650418dfd749e9e5fd2a8e31ae190f4f35213a59310a9a1ef4e19405eec6.
- The evaluator used the fixed Forge budget: 240 model turns, 500 tool calls, 300,000 generated tokens, and a 90 minute duration ceiling. Cumulative request-token protection was disabled for this run.
- The report records base Git revision 3032f71540ab775ae5bf3bb137d9059385c7a20b; then-uncommitted diagnostic edits were represented by the harness fingerprint. Some of those edits were subsequently removed. This is permanently a historical run of that fingerprint, not validation of later code.

## Result

| Gate | Result |
| --- | --- |
| Held-out assertions | Pass |
| Host verification | Pass |
| Workspace integrity | Pass |
| Forge task completion | Pass |
| False completion | 0 |
| Independent review | 1 call, 0 repair rounds |
| Model requests | 11 |
| Tool calls | 15 |
| Request tokens | 79,781 |
| End-to-end latency | 87.1 s |
| Reported cost | Unknown; provider pricing was incomplete |

The run passed all four quality gates (1/1). It confirms that the current planned workflow can reach a completed host task, current verification, independent review and the held-out oracle on this task at that recorded fingerprint. One repetition and one task do not show that planned execution is better than adaptive execution, and they do not measure the model's general coding ability.

The raw report is retained locally under .forge-agent/evals/2026-11-10T06-42-43.283Z/report.json; private session paths and credentials are intentionally excluded from this document.
