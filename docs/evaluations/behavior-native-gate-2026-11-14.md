# Native behavioral gate diagnostic — 2026-11-14

The third separately fingerprinted attempt accepts the fixed correct candidate after three real native-Pi check commands pass, and blocks the fixed defective candidate after those same three commands fail. The earlier two attempts blocked the correct candidate because check-design formatting was invalid; those attempts remain in the [allowlisted aggregate](behavior-native-gate-2026-11-14.json). This is one explicit small behavior task, not SWE-bench or a general quality gain.

## Protocol

The original request names `normalizePoints([[1],[2]]) -> [1,2]`, preservation of flat/empty inputs, new-array identity and no input mutation. Before a fixed implementation is injected, an actual fresh read-only Pi designer reads the original request and baseline source and proposes reproduction/boundary commands. The parent Pi session executes exact frozen shell commands under `behaviorExecutionExtension`, and the actual `TaskController`, configured verification runtime and independent final reviewer determine settlement. The same successful frozen plan is reused on both candidates in the same project path. No hidden oracle is shown to the model. External assertions execute only after the initial product decision is saved.

Inspection and implementation are scripted candidate injection. The correct candidate maps Nx1 rows to their scalar elements; the defective candidate merely changes the error text while still rejecting column input. The original test covers only flat input and would not distinguish them. Actual model design/execution/review is used; no mock verdicts are used in this diagnostic.

Attempts use the configured `deepseek/deepseek-v4.1-flash`, openai-completions, medium effort on Windows/Node 24/Pi 1.4.0. Provider alias/endpoint/credentials are omitted. The catalog has no prices, so cost remains unknown rather than zero. Shared parent and child limits remain bounded as recorded. These are revised attempts, not three repetitions of one frozen protocol.

## Observations

| Attempt | Correct candidate | Defective candidate | Interpretation |
| --- | --- | --- | --- |
| 1 | Unconfirmed; blocked | Unconfirmed; blocked | A ready check plan also listed out-of-scope unresolved questions; JSON contract invalid after one retry. No native behavior receipts. |
| 2 | Unconfirmed; blocked | Commands failed; blocked | Correct plan still exceeded five assumptions after generic format correction. The failed design was not reused; later defective design succeeded. |
| 3 | Three zero exits; `passed`; `implemented_unverified` | Three exit-1 receipts; `failed`; `blocked` | One valid pre-implementation plan reused verbatim on both candidates. Final model review is ready / changes_requested respectively; external assertions pass / fail. |

The implemented format correction now reports actual Zod paths/messages, rather than repeating only a generic JSON example. It also states field/array bounds and keeps out-of-scope unknowns in assumptions instead of blockers. The host continues failing closed on invalid plans; it does not silently turn malformed output into a pass.

Third-attempt request totals including cache reads are 36,294 for correct and 23,705 for defective; output tokens are 5,680 and 1,727. Correct totals include the one shared designer call; defective totals exclude another design, so they are not a balanced efficiency comparison. Parent model turns are 8 and 4; both include final review and real command turns. Dollar cost is unknown. Native receipts bind actual tool call IDs/command hashes, run IDs, output/exit codes and stable workspace identity. The defective review records one concrete code defect; missing execution evidence is separately classified in earlier attempts, not counted as another source defect.

The third attempt's harness fingerprint is `af498957dfb869b0c0547cdb089e913deb78c9a7eb080e31aa309bc73f8731bc`; protocol-content fingerprint is `916c86cf08627668b9e1473e561252065892543c40d516a71143fc457b70371d`. Product base is `48a808e2bfb2bc7b22b74d7c08f8f396a9215c7f` with measured uncommitted changes represented by captured dist bytes. Each prior attempt has its own harness/protocol/result hashes in the aggregate. Later changes excluding behavior gates from pure verification-only tasks, rejecting untyped unmet findings and correcting integration fixtures are not retroactively model-qualified by this result.

## Limits

- This task explicitly names the expected column behavior, unlike all expectations in the historical Flask/Matplotlib issues. This result does not qualify either upstream miss, and all 12 old-patch replay decisions remain unchanged.
- Only one correct/defective pair and one successful frozen plan are measured. Two earlier correct candidates were blocked by formatting. This does not establish a reliability, precision/recall or efficiency improvement.
- A zero exit proves that the proposed process returned zero, not that model-generated assertions are correct or complete. Product acceptance stays unverified and `resolutionClaimed=false`.
- Commands are executed by Pi with launching-user permissions in this self-controlled project, not an OS sandbox. Model-generated checks in untrusted repositories still require a container/VM/restricted account.
- A wrong static ready cannot bypass missing/failed behavioral receipts in deterministic controller/Web regressions. In this real diagnostic the defective model reviewer also identifies the defect, so it does not isolate the incremental causal contribution of the host gate.

## Reproduction

```sh
npm run build
node scripts/probe-behavior-gate.mjs --model YOUR_PROVIDER/YOUR_MODEL --output .forge-agent/NEW_BEHAVIOR_DIRECTORY
```

The raw task, plan, transcripts, command receipts and snapshots are local evidence; the public aggregate excludes endpoints, credential stores and user paths. The driver saves decisions before external assertions, and deletes its task-owned temporary credential home on completion. It is a diagnostic runner, not an automated universal acceptance oracle.

## 中文

第三轮使用同一套真实模型预先设计的检查：正确候选三条命令退出码均为 0，正常结束但仍“需求未验收”；错误候选三条退出码均为 1，保持阻断，外部断言也分别通过/失败。第一、二轮正确候选因为方案格式/字段上限被误挡，均完整保留。它验证新链路可以工作，没有证明历史 SWE-bench 漏检已经修复，也没有证明整体质量提升；后续要在独立未见任务和固定上游候选上另作测量。

See the separate [final engineering record](behavior-engineering-2026-11-14.json) for source hashes, full-run timeout and unchanged-file revalidation. These engineering outcomes do not alter the model measurements above.
