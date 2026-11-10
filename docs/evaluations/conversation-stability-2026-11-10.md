# Conversation lifecycle qualification — 2026-11-10

The [qualification aggregate](conversation-stability-2026-11-10.json) binds the final tested source tree to a fingerprint. This report separates fixture integration checks, browser acceptance and one seeded live-model retrieval task from the [45 real coding executions](five-task-ablation-2026-11-10.md).

## What changed

Navigation no longer shares a lock with background execution. Users can switch chats or start another one while the original task continues on the server, including during compaction and stop acknowledgement. Drafts, in-page attachments and next-message configuration remain scoped to the conversation. Old SSE frames, compaction responses and stop acknowledgements cannot replace a newly selected chat or clear a newer operation. Mode/workflow choices made during execution are staged; active permissions do not change. Canonical project execution remains exclusive.

Same-project history is read on demand through two host-owned Pi extension tools. Selected-branch user/assistant text and retained summaries carry source IDs and revision-tagged pagination. Other projects, trash, private child directories, thinking, tool results and hidden host instructions are excluded from these tools. Accepted scoped memory remains a separate reference layer. These are retrieval-tool boundaries, not an OS sandbox for Pi file or shell access.

## Regression qualification

The first diagnostic full run passed 665/669 tests and retained four integration timeouts: a 15-second settlement wait, a two-execution/restart case under a 30-second lifecycle and two output-recovery waits of 25 seconds. Persisted output-recovery tasks completed with files and passing verification in about 22.9 and 27.7 seconds; one planned case had reached finalization before the shorter poll expired. This was a non-frozen diagnostic run during UI work, not a controlled before/after benchmark.

Only the affected real-Pi integration budgets were calibrated: mode settlement 30 seconds inside a 60-second lifecycle, output-recovery polling 45 seconds inside a 60-second lifecycle, with phase/status/finalization/tool diagnostics. Product budgets, retries, trust, completion gates and artifact/verification assertions stayed intact. Initial logs were retained.

The subsequent fixed-tree `npm run check` passed **48 files / 669 tests**, typecheck, build, CLI version/help and bin checks in the recorded environment. The test portion took 1,314.84 seconds. Final isolated Edge smoke and a clean dependency installation from the actual tgz also passed. These are local Windows results; no new remote CI result is claimed.

Targeted coverage includes first-turn pending-model navigation, background task ownership after SSE disconnect, per-chat choices/attachments/drafts, failed staged saves, mode application before exactly one next prompt, stale stream/compaction/stop responses, same-project reads through genuine Pi tools, cross-project/path/private-directory rejection, archived/trash handling, revision changes and bounded scans. The model responses in fixture integrations are scripted and do not measure model quality.

## One live-model project-history acceptance

The [live acceptance aggregate](project-context-live-2026-11-10.json) records one real DeepSeek V4.1 Flash task at medium reasoning. Reference conversations were seeded in two isolated projects; the second project contained a random sentinel. The current Ask conversation requested the first project's color, corner radius and source session ID. It used two search calls and one read call, then returned all requested facts and the correct source ID. All **10 gates passed** in 6.512 seconds over three model turns. The user branch stayed independent, no writer ran and the other project's sentinel did not enter the current transcript.

This demonstrates that on-demand referencing is usable without automatically merging chat histories. It is one seeded functional acceptance, not a retrieval-recall, adversarial isolation or coding-quality benchmark. Tool scope does not restrict unrelated native host file access. Its runtime fingerprint is `0c70a42cee087b45c58469c41ed9e0bfe331bfce80b062ad4b987a5a603bcd4c`.

## Source identity and remaining limits

Final source fingerprint: `431bc42dcbc133713e06efb4747c8b7770020e77b081277e2df8daad2e4147c9` over 128 source/test/script/config files. The JSON aggregate specifies path ordering and LF normalization for reproduction; documentation and private artifacts are excluded.

A green local regression and repeated miniature tasks are progress, not a completed reliability program. Complex upstream repository cohorts, hours-long context/compaction and disconnect/restart soak tests, retrieval recall and false-reference rates, and multi-agent net benefit still need separate real-model measurements. Earlier failures and protocols remain available in [evaluation methods](../evaluation.md).
