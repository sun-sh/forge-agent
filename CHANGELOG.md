# Changelog

## Unreleased

- Retain the first GitHub real-model SWE-bench attempt as an infrastructure failure after all three baseline/reference pairs passed but the Provider rejected GitHub runner IPs. Propagate Forge session errors into SWE-bench results, stop before grading empty patches on Provider/Forge execution errors, and classify those rows as unresolved infrastructure rather than model outcomes.

- Add a manual GitHub Actions real-model SWE-bench Lite workflow. It validates a selected frozen three-task subset, runs one configurable Forge arm in isolated Docker containers, and publishes official resolution beside Forge completion, acceptance, false-completion and infrastructure fields. The workflow consumes only explicitly configured repository secrets and leaves the existing no-key smoke workflow as a plumbing test.

- Add a real Provider preflight before SWE-bench Docker execution, using the same isolated model configuration and a bounded minimal request. Record the preflight source in the harness fingerprint so endpoint, authentication, protocol and model-ID failures stop before expensive task execution.

- Treat Git submodule entries as opaque gitlink fingerprints during workspace evidence capture. Preserve fail-closed behavior for non-Git nested repositories while allowing large repositories with untouched submodules to reach independent grading.

- Record the five-task Direct SWE-bench baseline and targeted Astropy post-fix rerun. Retain the pre-fix 6/12 resolved, 6/12 false-completion, 3/15 infrastructure result under its original code identity; the repaired Astropy task resolved 3/3.

- Publish the final repaired Direct baseline: 15/15 officially assessed, 9/15 resolved, 6/15 false completions and 0 infrastructure failures on the five-task cohort. Keep it as the reference arm for later Planned/reviewer comparisons.

- Record a fresh 45-run DeepSeek V4.1 Flash ablation on the current revision. Direct, planned and evaluator-only planned-no-review each passed 15/15 on the five-task miniature suite with no false completions or infrastructure failures; planning and review added measurable latency and token overhead without a quality lift in this sample. Publish the protocol, code/harness fingerprints and sanitized aggregate while keeping cost unknown when catalog pricing is unavailable.

- Clarify Windows-hosted evaluation through WSL2/Linux Docker, separate distribution/image storage, and budget-aware Codespaces pilot limits; require checking firmware virtualization and actual Docker API access.

- Add a source-only SWE-bench Lite controller with a fixed 20-task cohort, reproducible dataset export, pinned official harness, separate agent/grading containers, validation before model calls and immutable resume identities. Keep official resolution, Forge completion, test integrity and infrastructure failures separate. Document the evaluation-machine setup; current evidence covers protocol/fixture checks, not Docker integration or SWE-bench model scores.

- Qualify the final conversation changes with the full Windows check, isolated Edge smoke, clean tgz installation and a seeded real-model reference task. Retain the initial integration timeout failures and document calibrated lifecycle waits. Publish all 45 clean coding runs across five miniature tasks, three workflows and three repetitions, with no demonstrated quality gain from extra planning/review on this sample.

- Keep Web history navigation and new conversations available during background execution. Scope drafts, in-page attachments and pending model/effort/mode/workflow choices to each chat, reject late frames from old SSE subscriptions, and stage mode changes for the next message without changing active-run permissions. Preserve exclusive canonical-project execution ownership.
- Add on-demand same-project conversation search/read over Pi's selected branches, with UUID and canonical-project validation, bounded output/scans, source revisions and untrusted historical provenance. Exclude trash, private subdirectories, thinking, tool output and hidden host messages; admit only the host-owned readers in Plan/Ask.

- Retry transient OS sharing errors when reading service records, preserve malformed-record failures, and publish service state through the existing atomic replacement helper. Terminate Windows verification process trees without blocking the host event loop.
- Give native Pi bash/powershell calls a 120-second default only when no timeout is supplied. Pi retains execution/cancellation ownership; long commands can supply an explicit timeout and failures return to the model.
- Run independent Git metadata reads concurrently to reduce Windows phase and checkpoint overhead; retain existing bounds and evidence semantics.
- Fix planned tasks that remained unfinished after the model called `run_verification` without configured checks: canonicalize the skipped outcome and remove the misleading empty failure report. Add a Pi tool-call → host check → task-index regression.
- Bundle public `web_search` and `web_fetch` as Pi extension tools for Web and CLI, with source URLs, bounded output, cancellation, address/redirect checks and an opt-out plus actual document-connection diagnostic under Settings → Tools. Read-only modes admit only the host-owned web readers.

- Combine bounded inspection and planning in one handoff, with a separate planning fallback for older replies. Focus independent review on one complete requirement ledger and full hunks; pass previous blocking findings to fresh repair reviewers. Missing verification no longer hides failed review, budget or finalization states.
- Add counterbalanced small-task evaluation with explicit frozen budgets and execution-only timing, plus paired correct/defective candidate reviewer diagnostics with independently validated oracles, false positives, missed defects and abstentions. Preserve earlier synthetic and natural-task evidence separately.

- Add an evaluator-only reviewer fault-injection challenge. A known hidden defect is inserted after implementation in an isolated fixture; planned review must detect and repair it while planned-no-review exposes the held-out false completion. Record the real DeepSeek diagnostic separately from the clean-task ablation.

- Show files written or edited by a task in a delivery card, including non-Git projects, with one-click opening in the right-side file viewer. Treat a project with no configured verification commands as completed implementation with an explicit unverified state; hide continuation controls and keep read-only Plan skips quiet.

- Recover Web model length/empty stops through two bounded Pi settlement continuations without changing model effort or resetting parent usage. Do not advance incomplete output to verification; repair legacy continuation records that hid a truncated implementation behind a missing-checks error. Add actual-file Pi integration regressions.

- Resume planned tasks at a validated saved phase with their goal, acceptance, plan, original protection baseline and consumed repair count; revalidate before review and preserve same-session context without duplicating user messages. Reconsider ordinary defaults once during inspection, retain blocking ambiguities, and expose stop reasons beside a compact, collapsible task summary. Add explicit standard/long-task budget form presets.

- Add strict `protect` configuration for literal files and directories. Capture content before model execution, preserve initial dirty content across repairs, and reject changed or unconfirmed protection even when checks pass. CLI, Web and persisted verification share this gate.
- Supply independent reviewers complete staged/unstaged/untracked text patches, bounded to 2,000 lines per file and 60,000 characters overall. Incomplete, sensitive, binary or oversized evidence requires attention instead of silent truncation.
- Retry malformed review JSON once inside the same reviewer Pi session and parent budget; preserve format-retry evidence and stop after the second invalid result.
- Add evaluator-only `planned-no-review` / three-arm `ablation` execution and a reproducible baseline/reference validator with isolated workspaces and retained failure logs. Production HTTP requests cannot disable review.
- Make continuation a real same-session operation: stopped, interrupted and budget-limited tasks use a hidden host continuation message, preserve the current workspace context, retry malformed inspect/plan handoffs once, and no longer expose a duplicated original user prompt. Increase new-install execution defaults to 90 minutes, 240 model turns, 500 tool calls, 300,000 generated tokens and 40 USD; existing settings remain unchanged.

- Preserve an interrupted task's adaptive/planned workflow from the composer as well as the task center, including after restart; cover resume without unwanted planning, review or extra model calls.
- Gate planned delivery on a fresh, read-only Pi reviewer with a dedicated JSON result contract and aggregate parent-budget accounting, without sharing the implementation transcript or falling back to self-review.
- Separate generated-output limits from cumulative request/cache tokens: the prior default was 200,000 generated tokens with the optional cumulative guard disabled; new installations now use the documented 300,000-token long-task baseline while retaining existing saved limits.
- Add pinned cohort validation for repository evaluations: baseline/reference failures are retained as infrastructure skips, invalid tasks do not send model requests, and the validation artifact is bound to the suite fingerprint; add a regression for this gate.
- Persist a host-owned task requirement ledger separately from model intent, so goals, constraints, acceptance IDs, affected paths and unresolved questions survive phase transitions, legacy restore and compaction handoffs.
- Make repository evaluation reports durable on fatal startup, budget or cleanup errors, extend bounded Windows worktree cleanup, and publish the first real-model Axios pilot with false-completion and infrastructure-failure classification.
- Add structured subagent handoffs for file scope, deliverables, acceptance and dependencies, with explicit completed/unverified/parent-action result guidance and immutable scope on read-only follow-ups.
- Exclude Pi shell wall-clock duration from repeated-evidence fingerprints, preserving command output, exit status, other structured evidence and custom-tool duration fields; cover varying bash/PowerShell timings and the real Pi shell loop.
- Resolve all planned user prompts through read-only structured understanding instead of regex shortcuts, and keep adaptive hints out of completion gates; preserve complete constraints and acceptance ahead of background context.
- Route explicit host verification actions without natural-language inference, and derive read-only completion labels from the executed permission mode.
- Accept one schema-valid final JSON handoff after evidence prose while rejecting ambiguous objects and trailing instructions; retain the real-provider failure and separately fingerprinted corrected repository runs.
- Share host finalization across adaptive and planned executions, hold success pending until sealing/restoration/persistence, and fail consistently on injected cleanup/storage faults without erasing historical checks.
- Coalesce usage/progress persistence, skip superseded queued index writes, record write volume, and detect repeated successful shell evidence as well as reads and failures.
- Add versioned planning handoffs with host-assigned acceptance IDs, exact review coverage, and a stop before implementation for invalid plans; retain legacy task compatibility and adaptive short paths.
- Add a read-only execution graph projection over Pi history with stable task/phase/message/tool identities, retry edges, actual check results and interruption semantics, exposed in the right-side execution view.
- Represent each fresh-context delivery reviewer as an explicit timeline model node under its own attempt, distinguish it in the UI, and preserve previous reviews across retries and history recovery.
- Require documentation changes alongside behavior changes, with a bilingual contribution workflow and preserved evaluation protocol fingerprints.
- Bind verification to bounded workspace observations and command configuration, and invalidate stale evidence across sessions after undo, proposal application, terminal operations and observed external edits.
- Separate execution, automated verification and model review in completion reporting; add bounded review repairs and explicit inspection/planning handoffs.
- Add asynchronous child-agent start/wait/result collection with a settlement guard, and selected proposal application followed by configured verification under the same project ownership.
- Run queued tasks across up to three projects with per-project FIFO order, independent cancellation, committed snapshots and ownership-race deferral.
- Add repeated-evidence progress warnings and bounded needs-attention stops, durable goal context through Pi compaction, and explainable task-relevant scoped memory recall.
- Fix extension requests being routed to verification-only work and isolate external declaration acceptance from unrelated ambient types discovered during real-model repository evaluation.
- Separate input/output/cache usage and unknown pricing, harden Windows metadata replacement, and expand repository evaluation fixtures and runtime fingerprints.
- Document architecture decisions, failure semantics, source/test evidence and remaining runtime, permission and evaluation gaps in Architecture Deep Dive.

## 0.2.0

- Added task-owned working-file checkpoints, diff review and selective conflict-checked undo that preserves pre-existing dirty work and Git index contents.
- Added a detached local Web service, durable FIFO jobs, frozen job settings and explicit recovery for interrupted executions.
- Added writable Pi subagents in isolated Git worktrees, reviewable proposals, selective application and workspace cleanup.
- Added an optional provider coding-compatibility probe for streaming text, tool-call arguments and tool-result continuation.
- Added reviewed project/session memory candidates with provenance, deduplication, replacement conflicts and revision checks.
- Added pinned repository evaluation with independent external oracles, protected files, workflow comparisons and false-completion reporting.
- Added tarball validation, clean-install release checks, and tag-driven GitHub Release automation.
- Hardened session startup/shutdown, provider deletion and rebinding, project-lock cleanup, fork ownership and stale UI controls.

Pi 1.4.0 continues to own model/tool loops, sessions, authentication, compaction, MCP, Skills and resource discovery. Fixture checks do not establish real-model coding quality.
