# Evaluation and evidence

## SWE-bench Lite adapter

The [portable SWE-bench protocol](evaluations/swebench-lite-2026-11-10.md) fixes the official 300-instance snapshot, a seeded 20-task/12-repository cohort, harness commit, and explicit budgets. A dedicated controller runs Forge in task-image containers, then submits complete patches to fresh containers through official execution/parsing/grading. Gold patches, hidden tests and grading records stay outside model workspaces. Official resolution is separate from Forge completion and test-preservation acceptance; missing/invalid test evidence remains infrastructure data.

Import/prepare and JavaScript/Python fixture checks run on the current Windows host. Docker execution, baseline/gold and real-model scores remain unmeasured until a Linux/Docker evaluation machine is configured. The prepared cohort is not a benchmark result. The guide includes immutable image/package identity, required validation, and resuming assessed successes and failures under identical conditions.

## Conversation qualification and five-task repetition — 2026-11-10

The [conversation qualification](evaluations/conversation-stability-2026-11-10.md) records per-chat navigation/configuration, genuine Pi history tools, retained timeout diagnostics, a final 48-file / 669-test local check, final isolated Edge acceptance and clean tgz installation. One seeded real-model history task separately passed all ten functional gates. This does not establish retrieval recall or host filesystem isolation.

The [five-task, three-workflow report](evaluations/five-task-ablation-2026-11-10.md) retains 45 real DeepSeek V4.1 Flash executions: three repetitions for each of five miniature repository tasks in each arm. Direct, planned and planned-no-review all passed 15/15 with zero observed false completions. Median execution times were 36.6, 79.3 and 54.2 seconds respectively; no quality gain was demonstrated on these easy tasks. Each protocol records its own code/suite identity. These results do not replace complex upstream issue or hours-long recovery/compaction evaluation, and earlier failures remain below.

## Public web and empty-verification recovery — 2026-11-10

The [targeted real-model regression](evaluations/network-empty-verification-2026-11-10.md) retains an initial ten-minute shell hang and a separately fingerprinted revised run that passed all eight gates for public search, official-document reading, HTML delivery, empty verification and final host/index agreement. The revised run took 191.4 seconds. It validates this specific execution path; it is not a visual-quality benchmark, a controlled timeout ablation or a general reliability rate.

Local regression qualification for this change: typecheck, build, browser smoke and clean tarball installation passed. A full 47-file / 653-test run retained one 15-second resumed-settlement timeout (652 passed). Only that multi-stage recovery wait was calibrated to 30 seconds under a 60-second lifecycle budget, and the entire 42-test working-mode file then passed. The other 46 files passed in the preceding full run; this is grouped revalidation, not a claim that a later single full check or new remote CI run was green.

## Configured-check planning regression — 2026-11-10

The [planning regression](evaluations/deepseek-planned-delivery-2026-11-10.md) ran DeepSeek V4.1 Flash once on config-normalize-cross-file during the initial diagnosis. This task has configured checks and does not exercise the empty-verification failure. Held-out assertions, host verification, workspace integrity and Forge task completion all passed (1/1); false completions were 0. The run used 11 model requests, 15 tool calls and 79,781 request tokens over 87.1 seconds, with one independent review and no repair. The report base revision was 3032f71 with then-uncommitted diagnostic edits, represented by the recorded harness fingerprint. It predates the empty-verification and network-tool fixes and does not validate them. It does not establish a general planned-versus-direct quality gain.

## Focused review and clean-task comparison — 2026-11-10

The [focused-review report](evaluations/focused-review-2026-11-10.md) separates
paired candidate review from a clean natural task. Both prompt policies accepted
3/3 correct candidates and blocked 3/3 defective ones; focused review consumed
32.6% fewer request tokens on these six candidates. The separate natural-task
batch ran three repetitions per workflow under a frozen budget and rotated order:
direct, planned and planned-no-review each passed 3/3, with no observed quality
benefit from review. The adaptive default remains appropriate for that task.
Aggregates retain individual results, effective limits and code/suite fingerprints;
these small samples do not establish general reviewer accuracy or coding gains.

## Structured handoff and Chinese intent regression

The [structured-handoff experiment](evaluations/structured-handoff-2026-11-08.md)
and [allowlisted aggregate](evaluations/deepseek-structured-handoff-2026-11-08.json)
exercise a Chinese implementation request that the hint rules leave undetermined.
The initial batch passed 1/2: planned execution safely stopped at a valid JSON brief
preceded by findings prose. After a bounded parsing fix, the separately fingerprinted
batch passed 2/2 external runtime/declaration checks, protected-file checks and host
completion gates. Planning carried 11 criteria through exact review coverage.
The initial failure remains public; these are small regressions, not model rankings
or a real-model compaction/independent-reviewer experiment.

## Runtime depth and repository failure analysis

The [reviewed experiment and failure analysis](evaluations/runtime-depth-2026-11-08.md)
and [allowlisted aggregate](evaluations/deepseek-runtime-depth-2026-11-08.json)
cover five small tasks in both workflows, repeated execution on a pinned
third-party repository, and one explicitly requested two-child integration.
The initial repository batch exposed an `Extend` task-routing defect and an
unrelated ambient-type oracle failure. Its raw results remain separate from the
corrected protocol; failures were retained rather than removed from the record.
The corrected repository runs passed 4/4; the small suite passed 10/10.
These are small engineering regressions with different runtime fingerprints,
not a competitor benchmark or measured memory/multi-agent quality gains.

The [review-ablation diagnostic](evaluations/review-ablation-2026-11-09.md)
and [allowlisted aggregate](evaluations/deepseek-review-ablation-2026-11-09.json)
retain the initial 3/9 batch and a separately fingerprinted 3/3 regression.
One small task and differing repetition counts/budgets do not establish a
planning or independent-review benefit. A separate empty-directory real-model
run created index.html and stopped honestly at missing verification.

The [reviewer fault-injection challenge](evaluations/review-challenge-2026-11-09.md)
adds a separate diagnostic for the missing signal. It injects one known hidden
defect after implementation and before verification in an isolated fixture.
In the real DeepSeek run, planned review detected and repaired it (1/1), while
planned-no-review completed the host flow and was rejected by the held-out oracle
(0/1, one false completion). This supports the reviewer repair path for that
synthetic defect only; it is not a natural-task quality estimate.

## Reviewed real-model regression

The [2026-11-08 aggregate](evaluations/deepseek-small-task-2026-11-08.json) records
DeepSeek V4.1 Flash on `config-normalize-cross-file`, using an isolated project and
home with medium reasoning effort. Adaptive and planned execution each passed the
external assertions, protected-file integrity check and current-version verification.
Adaptive execution took about 30 seconds including setup; planned execution took
about 69 seconds, with about 8 seconds in inspection. Adaptive did not run a model
review; planned review returned `ready`. Both reported unknown cost because the
model catalog had no prices.

This is one small task with one run per workflow. It checks the changed delivery
path and does not establish a speed comparison, larger-repository quality or an
industry ranking. The aggregate identifies the modified-tree base and harness
fingerprint; private transcripts and provider credentials are excluded.

This repository includes regression tests for the supported Pi-backed product,
a browser acceptance script, and a small coding-task evaluation harness. They
answer different questions and must not be combined into a frontier-performance claim.

## Latest real-model pilot

The [DeepSeek pinned-repository pilot](evaluations/deepseek-swe-multilingual-pilot-2026-11-09.md)
is the first public result from the fixed third-party cohort. The cohort has 20
tasks, of which 11 passed baseline/reference validation and 9 were skipped before
any model request. A one-task Axios extraction was then run once in each workflow:
direct produced one false completion because protected files changed after the
oracle and verification passed; planned reached its time budget and left a
Windows test-process cleanup failure before verification/review. These are real
observations of the current protocol, not a 20-task model score. The report keeps
the suite and harness fingerprints, token breakdowns, unknown cost, and the
distinction between model outcome and infrastructure failure.

| Command | What it establishes |
| --- | --- |
| `npm run check` | Types, active regression tests, build and CLI/bin integration. |
| `npm run eval:repo -- --suite evals/repositories/forge-provider-removal.json --prepare` | Inspect the fixed public repository commit, commands and oracle fingerprint without running repository code or a model. |
| `npm run eval:repo:validate -- --suite path/to/suite.json --trust-suite --repeat 3` | Run baseline and a known-correct `referencePatch` in separate fresh workspaces for every repetition; no model is called. |
| `npm run eval:repo -- --suite evals/repositories/forge-provider-removal.json --model provider/model --workflow both --repeat 3 --trust-suite` | Execute a reviewed suite in temporary pinned worktrees for local sources or fresh clones for HTTPS sources, with independent external acceptance and false-completion reporting. |
| `npm run eval:repo -- --suite path/to/suite.json --model provider/model --workflow both --trust-suite --validation path/to/cohort-validation.json` | Reuse baseline/reference validation for the matching suite fingerprint; invalid tasks are explicitly skipped before any model request. |
| `npm run test:web` | A real Chromium browser can operate the local Web client against a local fixture model. |
| `npm run eval:smoke` | Five scripted solutions execute through actual Pi tools and forge-agent's workflow, then pass independent assertions and completion checks. No model coding judgment is measured. |
| `npm run eval:agent -- --model provider/model --workflow direct` | Runs the five public tasks through adaptive/direct execution against the selected real model. The evaluator copies the selected Forge model catalog and credentials into an isolated evaluation home, sends task content to that provider, and incurs its usage. |
| `npm run eval:agent -- --model provider/model --workflow planned` | Runs the same tasks through the explicit staged workflow for comparison. |
| `npm run eval:agent -- --model provider/model --workflow both --repeat 3` | Repeats both workflows with the same task set and records run number, variance-relevant metadata, and aggregate metrics. |
| `npm run eval:agent -- --model provider/model --workflow ablation --repeat 3` | Runs evaluator-only `direct`, `planned` and `planned-no-review` arms. Production requests cannot disable planned review. |
| `npm run eval:agent -- --model provider/model --workflow ablation --review-challenge --task config-normalize-cross-file` | Runs the isolated reviewer fault-injection diagnostic; planned arms receive a known hidden defect, and the report labels synthetic results separately. |

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
retained home is needed for inspection. `report.byWorkflow` keeps workflow totals
separate: completed runs, false-completion rate, review calls and repairs,
p50/p95 execution time, tokens and cost. Unknown pricing remains `null`.

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

Use `--thinking medium` to fix the requested reasoning level; each result records
the effective level returned by the session. `eval:agent` also accepts `--task
<id>` for focused failure reproduction. Version 4 of the small suite explicitly
requires invalid retry values to fall back to 3 without rounding or clamping;
older prompts left this ambiguous. Keep their original reports separate when
comparing runs.

Each gate is recorded independently, including when hidden assertions fail after
the host reports completion. Such an outcome counts as a false completion.
Final session snapshots and tracked Git diffs are retained under `evidence/`
before temporary workspaces are removed. These are local diagnostic artifacts:
transcripts and command outputs need review before sharing. Credential stores
are not copied into reports. Reports retain the configured model pricing; when
all prices are zero, aggregate cost is `null` (unknown), not a claim of free usage.

The scripted smoke path validates tool execution, evidence, completion gates,
and evaluator integrity. It does not measure model coding quality. No
real-model benchmark result on a complex repository is currently claimed by
this implementation, and five small public tasks cannot support an industry
ranking.

### Frozen-budget comparisons and paired reviewer diagnosis

The small-task evaluator accepts an explicit `--budget path/to/limits.json`.
It copies only model/auth configuration into its evaluation home and writes the
same validated budget for every arm. Its schema-5 report records effective limits,
execution-only timing separately from setup/total latency, and the exact schedule.
Arm order rotates by task and repetition (`counterbalanced-cyclic-v1`); three
repetitions balance each arm's position within a task. This reduces fixed-order
bias but does not eliminate provider-load or cache effects.

`npm run eval:review -- --validate-only` first checks paired correct/defective
candidates with external assertions, without calling a model. Correct candidates
must pass, defective candidates must fail, and both must pass the deliberately
limited visible check. Validation failure prevents all model requests.

`npm run eval:review -- --real --model provider/model --thinking medium --repeat 3 --budget path/to/limits.json`
compares `baseline-v1` and `focused-v2` prompts on the same fixed candidates.
The former reconstructs the prior verbose handoff on the current child runtime;
it is a prompt comparison, not execution of an old product release. Both use
fresh independent Pi reader sessions, the same model/effort and identical budgets.
Candidate directory names are random; correctness labels and held-out oracles do
not enter the prompt. Reports preserve every verdict, exact acceptance coverage,
workspace integrity, usage, delay and code/suite fingerprints. Invalid or
unconfirmed decisions are abstentions, not successful negatives. Recall includes
all defective candidates in its denominator; false-positive rate includes all
correct candidates. Blocking a labelled defective candidate does not establish
that every textual finding is accurate, so retained findings still need review.
These small diagnostics measure review decisions; natural-task workflow results
remain separate.

### Three-arm review ablation

`--workflow ablation` runs `direct`, `planned`, and `planned-no-review` on the
same tasks with the same model, reasoning setting, budget and repetition count.
The last arm retains inspection, planning, implementation, verification,
protected-path checks and finalization, skipping only the independent reviewer.
It is admitted only by the evaluator's programmatic gateway option; ordinary
Web prompts cannot request it, including after a session is restored.

Use this to compare delivery success, false completions, tokens, execution
latency and known cost. Reports retain review calls, review-triggered repairs
and format retries. Parent budgets include reviewer usage. `falseCompletionRate`
uses completed runs as its denominator; a workflow that never completes has a
`null` rate. Scripted smoke only checks that the three arms and measurements
work; real-model repetitions are required for conclusions.

`--review-challenge` is intentionally different from a normal ablation. The
evaluator writes a task-defined faulty implementation after the model's
implementation phase and before host verification. The normal `planned` arm
can use the independent reviewer and bounded repair; `planned-no-review` cannot.
Use the resulting report to test the reviewer mechanism, then keep its result
separate from clean-task completion rates. The hook is programmatic-only and is
not reachable through production Web requests.

### Protected content in the product

The evaluator configures the same `protect` delivery gate as the CLI and Web
product. Fingerprints are captured before model tools, and automatic repair
retains that baseline. An unchanged protected tree is required even when tests
pass; command success and protection failure remain separate fields. The
external oracle and integrity observation remain independent checks against
false completion. This observes final content; it does not prevent transient
writes or replace operating-system isolation.

## Pinned repository evaluations

`scripts/evaluate-repository.mjs` accepts a strict versioned JSON manifest.
Each task needs a unique ID, local/HTTPS source, immutable 40/64-character Git
revision, prompt, setup commands, at least one verification command, protected
files and an independent standalone Node oracle. A task may also provide a
`testPatch`; when present, the runner applies it only around the external oracle
and reverses it before checking workspace integrity, so the agent never sees
held-out tests during its run. `dirtyFiles` can seed existing user work. The oracle receives the workspace as `process.argv[2]`; it must be
within the suite directory and cannot use an escaping symlink. The manifest
and oracle bytes determine the fingerprint.

One public-repository example asks for revision-checked provider deletion
at a pinned Forge commit where that capability is absent. It checks stale writes,
unrelated-provider preservation and credential removal beyond visible regressions.
It is one public development task, not an unbiased benchmark or a published
real-model result. A second example, `yocto-queue-bounded-drain.json`, extends a
fixed third-party repository's lazy drain iterator and TypeScript declaration.
Its external oracle checks partial consumption, undefined values, invalid limits,
queue integrity and real declaration compilation. Direct test-dependency versions
are explicit; the upstream repository has no lockfile, so transitive dependency
resolution remains a reproducibility limit. Review the JSON and oracle before execution.

A failing baseline alone does not validate an oracle. Test a known-correct
implementation and meaningful incorrect variants under the same prepared
compiler/dependency environment. The drain oracle uses `types: []` for its
browser-neutral declaration checks so unrelated ambient Node definitions cannot
invalidate acceptance. A regression verifies both that isolation and rejection
of wrong runtime behavior and parameter declarations.

The runner creates a temporary worktree for a local source mirror (or clones an
HTTPS source without hardlinks), checks out the exact revision, runs reviewed
setup, seeds dirty files and configures the checks. It refuses symlinked/sensitive
fixture paths and rejects repository/legacy configuration that overrides the
suite's verification. The baseline oracle must fail before the model starts.
Before publishing a cohort comparison, separately confirm that a known reference
patch passes the same held-out oracle. A non-zero baseline alone does not validate
an oracle; `scripts/validate-repository.mjs` runs this check in a separate fresh
workspace for each baseline and reference repetition, retaining failures.
A copy of the oracle stays outside the project; afterward its assertions,
protected hashes, effective configuration, host completion and verification must
all pass. The default per-execution budget follows the Web host: 90 minutes,
240 model turns, 500 tool calls, 300,000 generated tokens, cumulative request
tokens disabled, and 40 dollars of configured cost;
a provider's single response can cross a limit before usage is available.

### Validation gate for a fixed cohort

For a multi-repository comparison, validate every task before spending model
requests. The validation artifact records the suite fingerprint and the result
of running both the baseline and a known-correct reference patch in the pinned
environment. `npm run eval:repo:validate` ships this model-free validator.
Each task supplies a `referencePatch` relative to the suite directory; its bytes
are included in the suite fingerprint. The model evaluator never applies that
patch. Missing references invalidate the task without executing code. The
validation artifact includes this required shape:

```json
{
  "suiteFingerprint": "<fingerprint from --prepare>",
  "valid": 1,
  "total": 2,
  "results": [
    { "id": "task-one", "valid": true },
    { "id": "task-two", "valid": false, "error": "Reference oracle failed" }
  ]
}
```

Include exactly one result per suite task. The validator retains per-task JSON,
setup/oracle logs, repetitions and cleanup failures. `valid` requires baseline
failure and reference success in every repetition without infrastructure faults.
An externally authored artifact remains an assertion by its author. After
reviewing the commands, oracle and logs, pass the artifact to the evaluator:

```powershell
npm run eval:repo:validate -- --suite path/to/suite.json --trust-suite --repeat 3 --output .forge-agent/validation
npm run eval:repo -- --suite path/to/suite.json --model provider/model --workflow ablation --trust-suite --validation .forge-agent/validation/cohort-validation.json --repeat 3
```

The evaluator refuses a mismatched suite fingerprint. A task whose baseline or
reference validation is invalid is recorded as `validationSkipped` and
`infrastructureFailure`; it does not run setup, repository code, or a model
request. Skipped tasks remain in the report so the cohort size and environment
limitations are visible. Latency percentiles exclude skipped tasks. The gate
separates model behavior from a broken oracle or unavailable test environment;
it does not make the remaining tasks representative by itself.


`--budget path/to/limits.json` selects an explicit per-execution budget. Supply
all six `BudgetLimits` fields: `maxDurationMs`, `maxModelTurns`, `maxToolCalls`,
`maxTotalTokens`, `maxOutputTokens` and `maxCostUsd`; set `maxTotalTokens` to 0
to disable its cumulative request-token guard. Unknown or invalid fields are rejected before
tasks start. Reports and each execution record the effective limits. Token
totals still include cached input across turns for measurement, even when that
guard is disabled. Preserve failed baseline runs when comparing a larger budget. The cost
guard depends on configured prices and cannot enforce billing when prices are
unknown.

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
tokens and cost. Repository results separate setup time from agent execution
time, and retain final snapshots and tracked diffs under `evidence/`. A fixture test checks that visible-test success with an external
oracle failure is recorded as false completion. Temporary worktrees/clones and
credentials are cleaned afterward; logs and reports remain and need review before
sharing. Oracle timeouts terminate the complete child-process tree before cleanup,
and the Windows evaluator waits for Pi's asynchronous tree termination before
removing the temporary worktree. A locked test runner is recorded as an
infrastructure failure rather than a model result; the report is still written
when cleanup itself fails.

## 中文说明

五个公开小任务的 smoke 验证链路，真实模型执行才测模型行为；两者不能合并宣传。
固定仓库评测使用临时 worktree（HTTPS 源使用独立 clone）、不可变 commit、外部 oracle、保护文件和已有脏内容，
同时核对验证门禁和宿主完成状态，并记录错误完成率。示例 suite 是可复现开发任务，
模板本身不等于模型成绩；已完成的实测与首批失败分析见本文开头链接。先执行 `--prepare` 并审阅仓库、命令与判题脚本；明确
`--trust-suite` 后才执行项目代码。运行、安装和 oracle 都不是 OS 沙箱。

真实运行可用 `--thinking medium` 固定推理强度，结果会保存实际生效的强度；小任务
可用 `--task <id>` 复现单项失败。隐藏断言、验证、工作区保护和宿主完成状态分别记录，
避免某项失败让其他指标被误标。最终会话与 tracked diff 留在本机 `evidence/` 中，
分享前需检查敏感输出。模型价格全为 0 时费用记作未知，不宣称免费。小任务 v4 已明确
非法重试次数回退到 3，禁止取整或夹紧；带歧义的旧题面结果单独保留。
