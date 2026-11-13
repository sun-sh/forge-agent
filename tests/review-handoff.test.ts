import { describe, expect, it } from 'vitest';
import { createExecutionState } from '../src/task/controller.js';
import { buildReviewHandoff } from '../src/task/review-handoff.js';
import { parseTaskBrief, planFromBrief, taskRequirements } from '../src/task/plan.js';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };
import { reviewCommandEvidence } from '../src/task/review-evidence.js';
import { isVerificationUnconfigured } from '../src/verification/pi-extension.js';

describe('focused independent review handoff', () => {
  it('keeps a single complete requirement ledger and the actual patch', () => {
    const task = createExecutionState('background '.repeat(3000) + 'TAIL_REQUIREMENT', { workflow: 'planned' });
    task.brief = parseTaskBrief(JSON.stringify({ ...handoff.brief, constraints: ['UNIQUE_CONSTRAINT'], steps: ['Implement the requested behavior'] }))!;
    task.requirements = taskRequirements(task.brief); task.plan = planFromBrief(task.brief, task.requirements);
    const patch = { version: 1 as const, files: [{ path: 'src/main.ts', status: ' M', preexisting: false, observed: true, patch: '@@ -1 +1 @@\n-old\n+new' }], characters: 25, lines: 3 };
    const result = buildReviewHandoff(task, patch);
    expect(result.prompt).toContain('TAIL_REQUIREMENT'); expect(result.prompt).toContain('+new');
    expect(result.prompt.match(/UNIQUE_CONSTRAINT/g)).toHaveLength(1);
    expect(result.prompt).toContain('"id":"A1"'); expect(result.prompt).toContain('"sha256"');
    expect(result.prompt).not.toContain('"understanding"');
    expect(result).toMatchObject({ version: 2, scope: 'initial', characters: result.prompt.length });
  });
  it('labels command receipts as historical and the ledger as model-authored without changing acceptance', () => {
    const task = createExecutionState('Preserve Nx1 input behavior', { workflow: 'planned' });
    const commands = reviewCommandEvidence([], task.id, new Set(['bash']));
    const handoff = buildReviewHandoff(task, { version: 1, files: [], characters: 0, lines: 0 }, undefined, commands);
    expect(handoff.prompt).toContain('historical-unattested');
    expect(handoff.prompt).toContain('model-authored interpretations');
    expect(handoff.prompt).toContain('not the implementation transcript or a current-workspace attestation');
    expect(handoff.prompt).toContain('Missing a direct reproduction receipt is an evidence limitation, not by itself a blocking defect');
    expect(handoff.prompt).toContain('original user explicitly required that exact check');
    expect(handoff.prompt).toContain('Preserve Nx1 input behavior');
    expect(handoff.prompt).toContain('If evidence is insufficient use unconfirmed');
  });
  it('keeps invalid combined steps out of plans and preserves legacy briefs', () => {
    const brief = parseTaskBrief(JSON.stringify(handoff.brief))!;
    expect(brief).toBeDefined(); expect(planFromBrief(brief)).toBeUndefined();
    expect(parseTaskBrief(JSON.stringify({ ...handoff.brief, steps: [] }))).toBeUndefined();
    expect(planFromBrief({ ...brief, steps: ['scoped implementation'], unresolved: ['A real user decision is missing'] })).toBeUndefined();
  });
  it('only identifies a clean missing-check outcome, never protection or stale failures', () => {
    const skipped = { status: 'skipped' as const, attempts: 0, reason: 'No verification commands configured.' };
    expect(isVerificationUnconfigured(skipped)).toBe(true);
    expect(isVerificationUnconfigured({ ...skipped, reason: 'No verification commands configured. Tool failed.' })).toBe(false);
    expect(isVerificationUnconfigured({ ...skipped, error: 'storage failed' })).toBe(false);
    expect(isVerificationUnconfigured({ ...skipped, evidence: { workspace: { version: 1, scope: 'directory', files: 0 }, configHash: 'a'.repeat(64), freshness: 'stale' } })).toBe(false);
  });
});
