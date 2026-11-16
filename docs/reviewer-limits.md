# Independent review: release boundary

独立审阅是一个可选择的额外检查层，不是正确性证明。默认仍为自适应执行。固定上游补丁的漏检尚未修复；这轮原生边界证据准备也未通过资格要求。发布保留这些限制，不再追加审阅机制或用更大预算替代验证。

## What Forge can enforce

Pi owns the model/tool loop. Forge can enforce configured verification, protected-path fingerprints, evidence freshness, bounded execution and explicit recovery states. A configured check failure, changed protected path or invalid required evidence cannot become successful delivery merely because a reviewer says `ready`. Those controls enforce their observable contracts; a passing configured command can still miss a requirement.

New configured Planned Web changes also freeze independently designed checks and run their baseline through the parent Pi session before implementation. The host preserves receipts, source-backed correction history and candidate comparisons. A failed check plan or unresolved baseline remains an evidence gap. This machinery does not ensure that the model designed the right checks.

The independent reviewer is a fresh read-only Pi session, with the original goal, structured acceptance, actual bounded patch and retained evidence. A structured verdict, schema validation or an additional model call does not turn its judgment into external acceptance. Finished implementations remain `implemented_unverified`; configured checks and model review are reported separately.

## What the model evidence establishes

- The [no-tests probe](evaluations/review-no-tests-2026-11-13.md) blocked one candidate that omitted tests explicitly required by the user. It is one observed case, not proof that the product is generally safe.
- The [fixed-patch compatibility experiment](evaluations/reviewer-compatibility-2026-11-16.md) did not reach its registered target: Flask 0/3 and Matplotlib 1/3 targeted findings, with both controls accepted 3/3. Timeouts count as abstentions.
- The [final native-boundary experiment](evaluations/reviewer-boundary-2026-11-16.md) retains preparation failures and every scheduled review. None of the four preparations supplied an attributable boundary pair. Its reviewer decisions cannot qualify the usable-boundary-evidence hypothesis.
- The [three-arm coding evaluation](evaluations/swebench-ablation-2026-11-12.md) did not establish a delivery benefit from independent review. Those scores belong to their recorded code/model identities, not this release.

Controlled fixtures test wiring and policy. They do not establish upstream defect-detection rates. Seven review-related implementation files support one optional review path; they are not seven measured benefits.

## Evidence gaps and information limits are different

An invalid plan, model format failure, timeout, incompatible environment or absent baseline is an engineering/evidence failure. It is not a detected source defect and does not prove that the task is impossible. In particular, the final preparation failure prevents a causal conclusion about the value of usable paired native evidence.

Hidden tests and underspecified requests can leave multiple contracts consistent with everything visible to a reviewer. When visible observations cannot distinguish those contracts, a reviewer cannot reliably infer which hidden contract will be graded; clarifying the requirement or supplying relevant boundary evidence can change that. This is a conditional information limit, not a measured universal ceiling. Three repetitions of selected patches cannot establish a numerical upper bound or prove that further engineering is useless.

The Flask target illustrates the authority problem: the original issue explicitly rejects dotted blueprint names, whereas the retained external failure concerns the exception type for a dotted route endpoint. That expectation is not explicitly requested. Matplotlib's Nx1 compatibility boundary is a different source-level failure and must not be excused by a broad claim that all 2D input was already broken.

## How to use the release

Use adaptive Agent execution for ordinary work. Choose Planned explicitly when the extra planning, native checks and independent review justify additional time and failure modes. Supply observable acceptance criteria, configure relevant verification commands, protect tests/lockfiles when appropriate, and inspect delivered files and diffs. Critical or ambiguous behavior still needs relevant external tests or human acceptance.

Reviewer standard limits remain 300 seconds, 24 turns, 120 tools and 32,000 output tokens, with a configured $4 ceiling; incomplete provider prices prevent treating that dollar setting as an independently enforced billing cap. Extended limits are explicit opt-in, not a demonstrated quality improvement. Budget exhaustion, insufficient evidence and concrete findings stay distinct. Historical receipts do not attest to the current workspace.

## Stopping rule for this release

The preregistered four-patch, three-review batch is the final mechanism experiment for this release. Preserve its misses, abstentions and preparation failures. Do not resample until a favorable result, loosen schemas, manufacture baselines or add more prompts to declare success. No production review file or default review allowance changes in this release qualification. Future work requires a separate, falsifiable proposal and evidence; publication does not depend on another mechanism.

See [review outcomes](review-outcomes.md), [diagnostics](reviewer-diagnostics.md), [evaluation index](evaluation.md) and the [preregistered decision](evaluations/reviewer-boundary-protocol-2026-11-16.md).
