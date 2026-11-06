# Evaluation and evidence

This repository includes regression tests for the supported Pi-backed product,
a browser acceptance script, and a small coding-task evaluation harness. They
answer different questions and must not be combined into a frontier-performance claim.

| Command | What it establishes |
| --- | --- |
| `npm run check` | Types, active regression tests, build and CLI/bin integration. |
| `npm run test:web` | A real Chromium browser can operate the local Web client against a local fixture model. |
| `npm run eval:smoke` | Five scripted solutions execute through actual Pi tools and forge-agent's workflow, then pass independent assertions and completion checks. No model coding judgment is measured. |
| `npm run eval:agent -- --model provider/model --workflow direct` | Runs the five public tasks through adaptive/direct execution against the selected real model, using configured Pi credentials. This sends task content to that provider and incurs its usage. |
| `npm run eval:agent -- --model provider/model --workflow planned` | Runs the same tasks through the explicit staged workflow for comparison. |
| `npm run eval:agent -- --model provider/model --workflow both --repeat 3` | Repeats both workflows with the same task set and records run number, variance-relevant metadata, and aggregate metrics. |

Results are written to `.forge-agent/evals/<timestamp>/report.json`, with one evidence
file per task. Reports distinguish `scripted-smoke` and `real-model` explicitly.
Each task reports `heldOutPass`, `verificationGate`, `workspaceIntegrity`,
`taskCompletion`, and `qualityPass`, alongside latency, repairs, tool calls,
tokens, cost, and Pi session statistics. The report also includes the Git
revision, suite version and fingerprint, Node/platform/Pi versions, workflow,
repeat number, p50/p95 latency, and aggregate rates for these gates. The
workspace and evaluation home are isolated by default; use `--home` when a
retained home is needed for inspection.

The public suite checks bound handling, strict port parsing, stable duplicate
removal, normalization across a two-file module, and safe path joining across a
two-file module. Hidden assertions live outside the task workspace. The
evaluator also detects edits to the visible test and an unrelated user file.
These are small public tasks, not private or adversarial benchmark cases, and
the agent still runs with the launching user's permissions. Use an isolated
account or container if the evaluated model or tools are not trusted.

For an orchestration comparison, run both workflows with fixed settings and
repeat them when variance matters:

```powershell
npm run eval:agent -- --model provider/model --workflow direct
npm run eval:agent -- --model provider/model --workflow planned
npm run eval:agent -- --model provider/model --workflow both --repeat 3
```

Compare actual task assertions, unrelated changes, gate failures, repair count,
duration, requests/tokens and cost. Do not assume that extra stages improve every
task; retain direct execution when it has better measured latency or reliability.
Keep model/provider, reasoning, Pi version and prompt/task set fixed, report the
number of runs and variance, and add repository-level tasks before generalizing.

The scripted smoke path validates tool execution, evidence, completion gates,
and evaluator integrity. It does not measure model coding quality. No
real-model benchmark result on a complex repository is currently claimed by
this implementation, and five small public tasks cannot support an industry
ranking.
