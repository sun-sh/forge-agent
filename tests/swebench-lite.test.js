import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { parseDataset, makeManifest, selectCohort, loadBundle, sha256, validateCohort, gradeObservation, summarize, assertResumeIdentity, canReuseExecution, PROTOCOL, HARNESS_COMMIT } from '../scripts/swebench-protocol.mjs';
const execute = promisify(execFile), roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = (n = 1, repo = 'owner/repo') => ({ instance_id: repo.replace('/', '__') + '-' + n, repo, base_commit: 'a'.repeat(40), version: '1.0',
  problem_statement: 'Fix the public issue.', patch: 'GOLD_PATCH_MUST_STAY_PRIVATE', test_patch: 'HIDDEN_TEST_PATCH', image: 'swebench/example:latest', eval_script: 'OFFICIAL_EVAL_MUST_STAY_PRIVATE',
  log_parser: 'parse_log_pytest', eval_type: 'pass_and_fail', FAIL_TO_PASS: ['tests/test_hidden.py::test_case'], PASS_TO_PASS: ['tests/test_old.py::test_case'] });
async function root() { const path = await mkdtemp(join(tmpdir(), 'forge-swebench-v2-')); roots.push(path); return path; }
async function bundle(records = [fixture()]) {
  const path = await root(), raw = records.map((row) => JSON.stringify(row)).join('\n'), manifest = makeManifest(parseDataset(raw), raw, { count: records.length });
  await mkdir(join(path, 'records'));
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  for (const record of parseDataset(raw)) await writeFile(join(path, 'records', record.instance_id + '.json'), JSON.stringify(record));
  return { path, manifest, raw };
}
describe('SWE-bench frozen protocol and official outcome boundaries', () => {
  it('accepts actual owner__repo IDs and JSON-array strings without including answers in the public manifest', () => {
    const row = fixture(); row.FAIL_TO_PASS = JSON.stringify(row.FAIL_TO_PASS);
    const raw = JSON.stringify([row]), records = parseDataset(raw), manifest = makeManifest(records, raw, { count: 1 });
    expect(manifest.tasks[0].instanceId).toBe('owner__repo-1');
    const publicData = JSON.stringify(manifest);
    for (const secret of ['GOLD_PATCH', 'HIDDEN_TEST', 'OFFICIAL_EVAL', 'test_hidden']) expect(publicData).not.toContain(secret);
    expect(manifest.harnessCommit).toBe(HARNESS_COMMIT);
  });
  it('rejects duplicate IDs, traversal IDs, invalid base commits and missing official fields', () => {
    expect(() => parseDataset(JSON.stringify([fixture(), fixture()]))).toThrow('Duplicate');
    for (const row of [{ ...fixture(), instance_id: '../outside' }, { ...fixture(), base_commit: 'main' }, { ...fixture(), image: 'untrusted/other:latest' }, { ...fixture(), FAIL_TO_PASS: [] }, { ...fixture(), eval_script: undefined }]) expect(() => parseDataset(JSON.stringify([row]))).toThrow();
  });
  it('selects deterministically across repositories without consulting gold patches, hidden tests or outcome labels', () => {
    const rows = ['a/r', 'b/r', 'c/r'].flatMap((repo) => [1, 2, 3].map((n) => fixture(n, repo)));
    const before = selectCohort(rows, 6, 'seed').map((row) => row.instance_id);
    expect(selectCohort([...rows].reverse(), 6, 'seed').map((row) => row.instance_id)).toEqual(before);
    const changed = rows.map((row) => ({ ...row, patch: 'arbitrary gold', FAIL_TO_PASS: ['new secret test'] }));
    expect(selectCohort(changed, 6, 'seed').map((row) => row.instance_id)).toEqual(before);
    expect(new Set(before.slice(0, 3).map((key) => key.split('__')[0])).size).toBe(3);
    expect(() => selectCohort(rows, 1, 'seed', ['absent'])).toThrow('Unknown');
    expect(() => selectCohort(rows, 1, 'seed', [rows[0].instance_id, rows[0].instance_id])).toThrow('Duplicate');
  });
  it('binds records and cohort to their full fingerprints, refusing reference tampering and manifest edits', async () => {
    const f = await bundle(); expect((await loadBundle(f.path)).records).toHaveLength(1);
    const record = parseDataset(f.raw)[0]; record.patch = 'changed reference';
    await writeFile(join(f.path, 'records', record.instance_id + '.json'), JSON.stringify(record));
    await expect(loadBundle(f.path)).rejects.toThrow('fingerprint');
    f.manifest.tasks[0].repo = 'other/repo'; await writeFile(join(f.path, 'manifest.json'), JSON.stringify(f.manifest));
    await expect(loadBundle(f.path)).rejects.toThrow('Manifest');
  });
  it('requires exact baseline/reference coverage and image identities, not merely a nonzero baseline exit', async () => {
    const f = await bundle(), row = { instanceId: f.manifest.tasks[0].instanceId, valid: true, imageId: 'sha256:' + 'b'.repeat(64), baseline: { valid: true, resolved: false, baselineExpectedFailure: true }, reference: { valid: true, resolved: true } };
    const validation = { protocol: PROTOCOL, cohortFingerprint: f.manifest.fingerprint, harnessCommit: HARNESS_COMMIT, backendHash: 'backend', total: 1, valid: 1, results: [row] };
    expect(validateCohort(validation, f.manifest, 'backend').size).toBe(1);
    for (const changed of [{ ...validation, results: [] }, { ...validation, backendHash: 'other' }, { ...validation, results: [{ ...row, baseline: { valid: false, resolved: false } }] }, { ...validation, results: [{ ...row, imageId: 'latest' }] }]) expect(() => validateCohort(changed, f.manifest, 'backend')).toThrow();
  });
  it('records host completed plus official failure as false completion even if the wrapper exited zero', () => {
    expect(gradeObservation({ official: { valid: true, resolved: false, wrapperExitCode: 0 }, completed: true, integrity: true, emptyPatch: false })).toMatchObject({ officialResolved: false, falseCompletion: true, accepted: false, infrastructureFailure: false });
  });
  it('never converts a missing report, Docker failure or unparsed test log into a model failure/score', () => {
    for (const official of [undefined, { valid: false, resolved: false, reason: 'missing report' }, { valid: false, reason: 'Docker unavailable' }]) expect(gradeObservation({ official, completed: true, integrity: true })).toMatchObject({ officialResolved: null, falseCompletion: null, accepted: false, infrastructureFailure: true });
  });
  it('keeps official resolved distinct from file integrity and classifies rejected patches without inventing test results', () => {
    expect(gradeObservation({ official: { valid: true, resolved: true }, completed: true, integrity: false, emptyPatch: false })).toMatchObject({ officialResolved: true, accepted: false, falseCompletion: true, integrityViolation: true });
    expect(gradeObservation({ official: { valid: false }, completed: true, integrity: true, patchRejected: true })).toMatchObject({ officialResolved: false, falseCompletion: true, infrastructureFailure: false });
  });

  it('classifies a provider or Forge execution error as infrastructure instead of a model result', () => {
    expect(gradeObservation({ official: { valid: true, resolved: false }, completed: false, integrity: true, emptyPatch: true, executionError: '403: IP not allowed' })).toMatchObject({ officialResolved: null, accepted: false, falseCompletion: null, infrastructureFailure: true });
  });
  it('retains every scheduled task while separating infrastructure and invalid-cohort counts', () => {
    const rows = [{ workflow: 'direct', officialResolved: true, accepted: true, executionMs: 100, budget: { totalTokens: 10, costIncomplete: true } }, { workflow: 'direct', skipped: true, infrastructureFailure: true }, { workflow: 'direct', officialResolved: false, falseCompletion: true, emptyPatch: true, executionMs: 200 }];
    expect(summarize(rows, ['direct']).direct).toMatchObject({ scheduled: 3, validationSkipped: 1, evaluated: 2, resolved: 1, accepted: 1, falseCompletions: 1, infrastructureFailures: 1, emptyPatches: 1, costUsd: null });
  });
});
describe('SWE-bench portable entry points', () => {
  it('imports and prepares a frozen bundle without Docker or model calls, rejecting output reuse', async () => {
    const path = await root(), dataset = join(path, 'export.jsonl'), output = join(path, 'bundle');
    await writeFile(dataset, JSON.stringify(fixture()));
    const command = ['scripts/swebench-lite.mjs', 'import', '--dataset', dataset, '--output', output, '--limit', '1'];
    const imported = await execute(process.execPath, command, { windowsHide: true }); expect(JSON.parse(imported.stdout).tasks).toBe(1);
    const prepared = await execute(process.execPath, ['scripts/swebench-lite.mjs', 'prepare', '--bundle', output], { windowsHide: true });
    expect(JSON.parse(prepared.stdout).tasks[0].instanceId).toBe('owner__repo-1');
    expect(prepared.stdout).not.toContain('GOLD_PATCH');
    await expect(execute(process.execPath, command, { windowsHide: true })).rejects.toMatchObject({ code: 1 });
  });
  it('refuses mismatched frozen cohorts and never runs code without explicit suite trust', async () => {
    const f = await bundle();
    await expect(execute(process.execPath, ['scripts/swebench-lite.mjs', 'validate', '--bundle', f.path], { windowsHide: true })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--trust-suite') });
    const dataset = join(f.path, 'dataset.jsonl'), cohort = join(f.path, 'cohort.json'); await writeFile(dataset, f.raw); await writeFile(cohort, JSON.stringify({ exportSha256: 'wrong', instances: [fixture().instance_id] }));
    await expect(execute(process.execPath, ['scripts/swebench-lite.mjs', 'import', '--dataset', dataset, '--cohort', cohort, '--output', join(f.path, 'new')], { windowsHide: true })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('hash') });
  });
  it('does not let a smoke input escape its frozen cohort', async () => {
    const f = await bundle(), dataset = join(f.path, 'dataset.jsonl'), cohort = join(f.path, 'cohort.json');
    await writeFile(dataset, f.raw); await writeFile(cohort, JSON.stringify({ exportSha256: sha256(f.raw), instances: [f.manifest.tasks[0].instanceId] }));
    await expect(execute(process.execPath, ['scripts/swebench-lite.mjs', 'import', '--dataset', dataset, '--cohort', cohort, '--instance', 'other__repo-2', '--output', join(f.path, 'escaped')], { windowsHide: true })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('outside') });
  });
});


describe('SWE-bench resumption identity', () => {
  it('requires the same code, cohort, validation, budget, model and schedule', () => {
    const current = { protocol: PROTOCOL, cohortFingerprint: 'cohort', harnessFingerprint: 'code', backendHash: 'backend', model: 'provider/model', thinking: 'medium', limits: { maxDurationMs: 60000 }, validationFingerprint: 'validated', schedule: [{ instanceId: 'a', workflow: 'direct', run: 1 }] };
    expect(() => assertResumeIdentity(structuredClone(current), current)).not.toThrow();
    for (const key of Object.keys(current)) expect(() => assertResumeIdentity({ ...current, [key]: 'changed' }, current)).toThrow('Resume identity');
  });
  it('retains assessed failures as well as successes, retrying only unfinished/infra runs', () => {
    expect(canReuseExecution({ officialResolved: true, official: { valid: true } })).toBe(true);
    expect(canReuseExecution({ officialResolved: false, falseCompletion: true, official: { valid: true } })).toBe(true);
    expect(canReuseExecution({ officialResolved: false, official: { patchRejected: true } })).toBe(true);
    expect(canReuseExecution({ officialResolved: null, infrastructureFailure: true })).toBe(false);
    expect(canReuseExecution({ official: { valid: true } })).toBe(false);
  });
});
