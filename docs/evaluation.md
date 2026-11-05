# Evaluation and evidence

This repository includes regression tests for the supported Pi-backed product,
a browser acceptance script, and a small coding-task evaluation harness. They
answer different questions and must not be combined into a frontier-performance claim.

| Command | What it establishes |
| --- | --- |
| `npm run check` | Types, active regression tests, build and CLI/bin integration. |
| `npm run test:web` | A real Chromium browser can operate the local Web client against a local fixture model. |
| `npm run eval:smoke` | Two scripted solutions execute through actual Pi tools and forge-agent's workflow, then pass independent assertions and completion checks. No model coding judgment is measured. |
| `npm run eval:agent -- --model provider/model` | Runs the same public tasks against the selected real model, using configured Pi credentials. This sends task content to that provider and incurs its usage. |

Results are written to `.forge-agent/evals/<timestamp>/report.json`, with one evidence
file per task. Reports distinguish `scripted-smoke` and `real-model` explicitly.
Each task reports `heldOutPass`, `verificationGate`, `workspaceIntegrity`,
`taskCompletion`, and `qualityPass`, alongside latency, repairs, tool calls and
Pi session statistics. The report also includes aggregate rates for these gates.
The workspace is retained
in a temporary evaluation folder so failures can be inspected.

The initial suite checks bound handling, strict port parsing and stable duplicate
removal. Hidden assertions
live outside the task workspace. The evaluator also detects edits to the visible
test and an unrelated user file. These are small public tasks, not private or
adversarial benchmark cases, and the agent still runs with the launching user's
permissions. Use an isolated account/container if the evaluated model or tools
are not trusted.

For an orchestration comparison, run the same model twice with fixed settings:

```powershell
npm run eval:agent -- --model provider/model --workflow direct
npm run eval:agent -- --model provider/model --workflow planned
```

Compare actual task assertions, unrelated changes, gate failures, repair count,
duration, requests/tokens and cost. Do not assume that extra stages improve every
task; retain direct execution when it has better measured latency or reliability.
Keep model/provider, reasoning, Pi version and prompt/task set fixed, report the
number of runs and variance, and add repository-level tasks before generalizing.

No real-model benchmark result is currently claimed by this implementation.
