# Changelog

## Unreleased

- Give independent reviewers complete bounded patches and one same-session JSON format correction, preserving evidence limits and parent budgets.

- Enforce strict protected-path delivery checks with pre-model content baselines, unchanged dirty user work across repairs, bounded observation, and shared CLI/Web failure semantics.

- Preserve an interrupted task's adaptive/planned workflow from the composer as well as the task center, including after restart; cover resume without unwanted planning, review or extra model calls.
- Gate planned delivery on a fresh, read-only Pi reviewer with a dedicated JSON result contract and aggregate parent-budget accounting, without sharing the implementation transcript or falling back to self-review.
- Separate generated-output limits from cumulative request/cache tokens: default to 200,000 generated tokens with the optional cumulative guard disabled, while retaining existing saved limits.
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
