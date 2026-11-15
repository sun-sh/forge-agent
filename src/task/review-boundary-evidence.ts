import { behaviorBaseline, behaviorHash, compareBehaviorBaseline, behaviorReceiptSchema, type BehaviorReceipt, type BehaviorState } from './behavior.js';
import { sensitiveCommandEvidence, type ReviewCommandEvidence } from './review-evidence.js';

function usable(receipt: BehaviorReceipt | undefined) {
  return Boolean(receipt && behaviorReceiptSchema.safeParse(receipt).success && !receipt.truncated && receipt.status !== 'unconfirmed'
    && receipt.outputCharacters === receipt.output.length && behaviorHash(receipt.output) === receipt.outputSha256 && !sensitiveCommandEvidence(receipt.output));
}
function observation(receipt: BehaviorReceipt | undefined) {
  if (!receipt) return null;
  const safe = usable(receipt);
  return { runId: receipt.runId, toolCallId: receipt.toolCallId, source: receipt.source, exitCode: receipt.exitCode, status: receipt.status,
    commandSha256: receipt.commandSha256, outputSha256: receipt.outputSha256, usableNativeOutput: safe,
    outputExcerpt: safe ? receipt.output.slice(0, 400) : '[Unconfirmed or incomplete native output; inspect the retained receipt]',
    excerptTruncated: !safe || receipt.output.length > 400 };
}

/** Paired navigation over existing native evidence, never a new check or oracle. */
export function reviewBoundaryEvidence(state: BehaviorState | undefined, originalRequest: string) {
  if (!state?.calibration || !state.plan) return undefined;
  const baseline = behaviorBaseline(state), comparisons = compareBehaviorBaseline(state);
  return { version: 1, source: 'pi-builtin-shell', scope: 'frozen-check-observations-not-acceptance',
    originalRequestAuthority: 'Quotes anchor model-authored expectations; neither the plan nor a receipt defines additional user requirements.',
    pairs: state.plan.checks.map(check => {
      const before = baseline?.receipts.filter(item => item.checkId === check.id) ?? [];
      const after = state.receipts.filter(item => item.checkId === check.id);
      const comparison = comparisons.find(item => item.checkId === check.id);
      const anchored = originalRequest.includes(check.requestQuote);
      const attributable = anchored && comparison?.outcome !== undefined && comparison.outcome !== 'unconfirmed'
        && before.length === 1 && after.length === 1 && usable(before[0]) && usable(after[0]);
      return { checkId: check.id, kind: check.kind, originalRequestQuote: check.requestQuote, quotePresent: anchored,
        expectation: check.expectation, commandSha256: behaviorHash(check.command),
        observation: attributable ? comparison!.outcome : 'unconfirmed', attributable,
        sameOutput: attributable ? comparison!.sameOutput : null,
        baseline: observation(before.length === 1 ? before[0] : undefined), candidate: observation(after.length === 1 ? after[0] : undefined),
        fullReceiptLocation: 'independentBehaviorChecks.baseline.receipts / independentBehaviorChecks.receipts (match runId, checkId and toolCallId)' };
    }) };
}

/** Reuse exactly matching native outputs instead of duplicating them as history. */
export function reuseNativeCommandEvidence(commands: ReviewCommandEvidence | undefined, state: BehaviorState | undefined): ReviewCommandEvidence | undefined {
  if (!commands || !state?.calibration) return commands;
  const native = [...(behaviorBaseline(state)?.receipts ?? []), ...state.receipts].filter(usable);
  const represented: NonNullable<ReviewCommandEvidence['representedByNativeReceipts']> = [];
  const kept = commands.commands.filter(command => {
    const receipt = native.find(item => item.toolCallId === command.toolCallId && item.tool === command.tool
      && item.commandSha256 === command.command.sha256 && item.outputSha256 === command.output.sha256 && command.sourceTruncation !== 'reported');
    if (!receipt) return true;
    represented.push({ toolCallId: receipt.toolCallId, runId: receipt.runId, checkId: receipt.checkId });
    return false;
  });
  return represented.length ? { ...commands, commands: kept, representedByNativeReceipts: [...(commands.representedByNativeReceipts ?? []), ...represented],
    summary: { ...commands.summary, retainedReceipts: kept.length } } : commands;
}
