# Evaluation and evidence

This repository includes regression tests for the supported Pi-backed product,
a browser acceptance script, and a small coding-task evaluation harness. They
answer different questions and must not be combined into a frontier-performance claim.

| Command | What it establishes |
| --- | --- |
| `npm run check` | Types, active regression tests, build and CLI/bin integration. |
| `npm run eval:repo -- --suite evals/repositories/forge-provider-removal.json --prepare` | Inspect the fixed public repository commit, commands and oracle fingerprint without running repository code or a model. |
| `npm run eval:repo -- --suite evals/repositories/forge-provider-removal.json --model provider/model --workflow both --repeat 3 --trust-suite` | Execute a reviewed suite in fresh pinned clones, with independent external acceptance and false-completion reporting. |
| `npm run test:web` | A real Chromium browser can operate the local Web client against a local fixture model. |
| `npm run eval:smoke` | Five scripted solutions execute through actual Pi tools and forge-agent's workflow, then pass independent assertions and completion checks. No model coding judgment is measured. |
| `npm run eval:agent -- --model provider/model --workflow direct` | Runs the five public tasks through adaptive/direct execution against the selected real model. The evaluator copies the selected Forge model catalog and credentials into an isolated evaluation home, sends task content to that provider, and incurs its usage. |
| `npm run eval:agent -- --model provider/model --workflow planned` | Runs the same tasks through the explicit staged workflow for comparison. |
| `npm run eval:agent -- --model provider/model --workflow both --repeat 3` | Repeats both workflows with the same task set and records run number, variance-relevant metadata, and aggregate metrics. |

Before a real run starts, the harness performs one model-availability check. By
default it reads the current Forge home; use `--config-home <path>` to choose a
different source. It copies only `models.json` and `auth.json` into the isolated
home, never reuses the source session or task directories, and fails before the
first task when the requested model is unavailable. Credentials are not printed
or included in the report. Pass `--home <path>` when the isolated evaluation
home itself should be retained; with an explicit `--home`, populate it first or
combine it with `--config-home`.

Results are written to `.forge-agent/evals/<timestamp>/report.json`, with one evidence
file per task. Reports distinguish `scripted-smoke` and `real-model` explicitly.
Each task reports `heldOutPass`, `verificationGate`, `workspaceIntegrity`,
`taskCompletion`, and `qualityPass`, alongside latency, repairs, tool calls,
tokens, cost, and Pi session statistics. Execution budget totals include model
turns, tool calls, tokens, and cost charged by managed read-only child agents;
the parent Pi transcript statistics remain available separately. The report also includes the Git
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

# If the credentials live in another Forge home:
npm run eval:agent -- --model provider/model --config-home C:\path\to\forge-home --workflow both
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

## Pinned repository evaluations

`scripts/evaluate-repository.mjs` accepts a strict versioned JSON manifest.
Each task needs a unique ID, local/HTTPS source, immutable 40/64-character Git
revision, prompt, setup commands, at least one verification command, protected
files and an independent standalone Node oracle. `dirtyFiles` can seed existing
user work. The oracle receives the workspace as `process.argv[2]`; it must be
within the suite directory and cannot use an escaping symlink. The manifest
and oracle bytes determine the fingerprint.

The included public-repository example asks for revision-checked provider deletion
at a pinned Forge commit where that capability is absent. It checks stale writes,
unrelated-provider preservation and credential removal beyond visible regressions.
It is one public development task, not an unbiased benchmark or a published
real-model result. Review the JSON and oracle before executing it.

The runner clones without hardlinks, checks out the exact revision, runs reviewed
setup, seeds dirty files and configures the checks. It refuses symlinked/sensitive
fixture paths and rejects repository/legacy configuration that overrides the
suite's verification. The baseline oracle must fail before the model starts.
A copy of the oracle stays outside the project; afterward its assertions,
protected hashes, effective configuration, host completion and verification must
all pass. Each execution has a ten-minute, two-dollar host budget; a provider's
single response can cross the limit before usage is available.

Execution requires an explicit `--model provider/model` and `--trust-suite`.
`--prepare` validates and prints metadata without cloning, setup, model calls or
oracle execution. `--config-home` chooses the source credentials; only model/auth
configuration is copied into a temporary home. Setup, project resources and
oracles run with the launching user's permissions. This is not a container or
hostile-code sandbox; use a restricted environment for untrusted suites.

Reports live in `.forge-agent/repository-evals/<timestamp>/`, or `--output`.
They include task/repository revisions, fingerprint, model, workflow, repeats,
environment, baseline failure, external result, workspace integrity, completion,
verification, false completions, infrastructure failures, latency percentiles,
tokens and cost. A fixture test checks that visible-test success with an external
oracle failure is recorded as false completion. Temporary clones and credentials
are cleaned afterward; logs and reports remain and need review before sharing.

## 中文说明

五个公开小任务的 smoke 验证链路，真实模型执行才测模型行为；两者不能合并宣传。
固定仓库评测使用独立 clone、不可变 commit、外部 oracle、保护文件和已有脏内容，
同时核对验证门禁和宿主完成状态，并记录错误完成率。示例 suite 是可复现开发任务，
不代表已经取得真实模型成绩。先执行 `--prepare` 并审阅仓库、命令与判题脚本；明确
`--trust-suite` 后才执行项目代码。运行、安装和 oracle 都不是 OS 沙箱。
