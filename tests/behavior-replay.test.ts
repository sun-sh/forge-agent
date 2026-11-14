import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { frozenCaseSchema, prepareFrozenReplay, replaySha256 as sha } from '../scripts/behavior-replay-protocol.mjs';

function fixture() {
  const patch = Buffer.from('diff --git a/code.py b/code.py\n'), task = {
    id: 'fixture-task', prompt: 'Fix the original trigger.\nEvaluation policy: preserve tests.', repairs: 0,
    baseline: { head: 'a'.repeat(40) },
    brief: { version: 1, intent: 'change', goal: 'Fix trigger', constraints: [], affectedPaths: ['code.py'], unresolved: [], acceptance: [{ id: 'A1', criterion: 'Trigger works', check: 'automated', evidence: 'Focused assertion' }] },
    plan: { version: 1, summary: 'Fix', steps: ['Implement'], constraints: [], affectedPaths: ['code.py'], acceptance: [{ id: 'A1', criterion: 'Trigger works', check: 'automated', evidence: 'Focused assertion' }] },
    review: { verdict: 'ready', summary: 'PRIVATE_OLD_REVIEW', issues: [] }
  };
  const snapshot = Buffer.from(JSON.stringify({ task, entries: [{ type: 'message', message: { content: 'PRIVATE_IMPLEMENTATION' } }] }));
  const official = Buffer.from(JSON.stringify({ 'pallets__flask-4045': { resolved: false, hidden: 'PRIVATE_ORACLE' } }));
  const spec = { id: 'pallets__flask-4045', sourceKey: 'pallets__flask-4045.planned.r1', baseCommit: 'b'.repeat(40), effectiveHead: 'a'.repeat(40), patchSha256: sha(patch), snapshotSha256: sha(snapshot), officialReportSha256: sha(official), imageId: 'sha256:' + 'c'.repeat(64), image: 'swebench/fixed@sha256:' + 'd'.repeat(64), originalOfficialResolved: false, originalCompleted: true };
  const row = { instanceId: spec.id, run: 1, workflow: 'planned', patchHash: spec.patchSha256, baseCommit: spec.baseCommit, effectiveHead: spec.effectiveHead, integrity: true, testChanges: [], completed: true };
  const grade = { patchHash: spec.patchSha256, officialResolved: false };
  const request = { imageId: spec.imageId, prompt: 'Fix the original trigger.' };
  return { spec, row, grade, patch, snapshot, request, official };
}

describe('immutable upstream native-behavior replay protocol', () => {
  it('sends only original task understanding, not labels or former implementation/review', () => {
    const f = fixture(), result = prepareFrozenReplay(f.spec, f.row, f.grade, f.patch, f.snapshot, f.request, f.official);
    const text = JSON.stringify(result.worker);
    expect(text).not.toMatch(/officialResolved|originalCompleted|expectedDefect|PRIVATE_/);
    expect(result.worker.brief.acceptance[0]).not.toHaveProperty('id');
    expect(result.worker.originalRequest).toContain('Evaluation policy');
    expect(result.entries).toHaveLength(1); // Controller-only input to the bounded native receipt extractor.
  });
  it.each(['patch', 'snapshot', 'official', 'effectiveHead', 'image', 'label', 'testEdits'])('rejects a changed identity before any model request: %s', (field) => {
    const f = fixture();
    if (field === 'patch') f.patch = Buffer.from('changed');
    if (field === 'snapshot') f.snapshot = Buffer.from('{}');
    if (field === 'official') f.official = Buffer.from('{}');
    if (field === 'effectiveHead') f.row.effectiveHead = 'f'.repeat(40);
    if (field === 'image') f.request.imageId = 'sha256:' + 'f'.repeat(64);
    if (field === 'label') f.grade.officialResolved = true;
    if (field === 'testEdits') f.row.testChanges = ['tests/test_edited.py'] as never[];
    expect(() => prepareFrozenReplay(f.spec, f.row, f.grade, f.patch, f.snapshot, f.request, f.official)).toThrow();
  });
  it('pins all four cases and runs containers without host mounts, privilege or code regeneration', async () => {
    const manifest = JSON.parse(await readFile('evals/swebench-lite/behavior-replay.json', 'utf8'));
    expect(manifest.cases).toHaveLength(4); expect(manifest.repeat).toBe(1);
    manifest.cases.forEach((item: unknown) => expect(frozenCaseSchema.safeParse(item).success).toBe(true));
    const workflow = YAML.parse(await readFile('.github/workflows/behavior-upstream.yml', 'utf8'));
    expect(workflow.jobs.replay.strategy['max-parallel']).toBe(2);
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    const script = await readFile('scripts/swebench-behavior-replay.mjs', 'utf8');
    expect(script).toContain('--cap-drop=ALL'); expect(script).toContain('--security-opt=no-new-privileges');
    expect(script).not.toMatch(/--privileged|docker\.sock|--mount|--volume/);
  });
});
