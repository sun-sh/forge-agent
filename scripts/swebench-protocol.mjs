import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const HARNESS_COMMIT = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e';
export const DATASET_REVISION = 'b0dde1093fe417d83b7184254edf8199c1f0dff5';
export const DATASET_NAME = 'SWE-bench/SWE-bench_Lite';
export const PROTOCOL = 'forge-swebench-lite-official-v2';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/);
const testIds = z.preprocess((value) => typeof value === 'string' ? JSON.parse(value) : value, z.array(z.string().min(1)).max(10000));
export const recordSchema = z.object({
  instance_id: id, repo: z.string().regex(/^[a-z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), base_commit: z.string().regex(/^[a-f0-9]{40}$/),
  problem_statement: z.string().min(1).max(100000), patch: z.string().min(1).max(5000000), test_patch: z.string().min(1).max(5000000),
  image: z.string().regex(/^swebench\/[a-z0-9_.-]+(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$/),
  eval_script: z.string().min(1).max(5000000), log_parser: z.string().min(1), eval_type: z.literal('pass_and_fail'),
  FAIL_TO_PASS: testIds.pipe(z.array(z.string()).min(1)), PASS_TO_PASS: testIds,
  version: z.string().min(1), environment_setup_commit: z.string().optional(), difficulty: z.string().optional(), created_at: z.string().optional()
});
export function parseDataset(raw) {
  if (Buffer.byteLength(raw) > 64000000) throw new Error('Dataset export exceeds 64 MB');
  const text = raw.replace(/^\uFEFF/, '').trim();
  const values = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const records = z.array(recordSchema).min(1).max(300).parse(values);
  if (new Set(records.map((record) => record.instance_id)).size !== records.length) throw new Error('Duplicate instance IDs');
  return records;
}
// Outcomes, reference patch sizes and hidden tests never participate in selection.
export function selectCohort(records, count = 20, seed = 'forge-lite-20-v1', explicit) {
  if (!Number.isInteger(count) || count < 1 || count > records.length) throw new Error('Cohort count must be within dataset size');
  if (explicit) {
    if (new Set(explicit).size !== explicit.length || !explicit.length) throw new Error('Duplicate or empty instance selection');
    const selected = explicit.map((key) => records.find((record) => record.instance_id === key));
    if (selected.some((record) => !record)) throw new Error('Unknown instance ID in cohort');
    return selected;
  }
  const groups = new Map();
  for (const record of records) { const list = groups.get(record.repo) ?? []; list.push(record); groups.set(record.repo, list); }
  const repos = [...groups].sort(([a], [b]) => sha256(seed + a).localeCompare(sha256(seed + b)));
  for (const [, list] of repos) list.sort((a, b) => sha256(seed + a.instance_id).localeCompare(sha256(seed + b.instance_id)));
  const selected = [];
  for (let round = 0; selected.length < count; round++) for (const [, list] of repos) if (list[round] && selected.length < count) selected.push(list[round]);
  return selected;
}
const taskSchema = z.object({ instanceId: id, repo: z.string(), baseCommit: z.string().regex(/^[a-f0-9]{40}$/), image: z.string(), recordHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const manifestSchema = z.object({
  version: z.literal(2), protocol: z.literal(PROTOCOL), dataset: z.literal(DATASET_NAME), datasetRevision: z.string().regex(/^[a-f0-9]{40}$/),
  exportSha256: z.string().regex(/^[a-f0-9]{64}$/), harnessCommit: z.literal(HARNESS_COMMIT),
  selection: z.object({ algorithm: z.enum(['repository-round-robin-seeded-v1', 'explicit-ids']), seed: z.string() }).strict(),
  tasks: z.array(taskSchema).min(1).max(300), fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const manifestFingerprint = (manifest) => { const { fingerprint, ...data } = manifest; return sha256(JSON.stringify(data)); };
export function makeManifest(records, raw, { count = 20, seed, explicit, revision = DATASET_REVISION } = {}) {
  const manifest = { version: 2, protocol: PROTOCOL, dataset: DATASET_NAME, datasetRevision: revision, exportSha256: sha256(raw), harnessCommit: HARNESS_COMMIT,
    selection: { algorithm: explicit ? 'explicit-ids' : 'repository-round-robin-seeded-v1', seed: seed ?? 'forge-lite-20-v1' },
    tasks: selectCohort(records, count, seed, explicit).map((record) => ({ instanceId: record.instance_id, repo: record.repo, baseCommit: record.base_commit, image: record.image, recordHash: sha256(JSON.stringify(record)) })) };
  return manifestSchema.parse({ ...manifest, fingerprint: manifestFingerprint(manifest) });
}
export async function loadBundle(directory) {
  const root = await realpath(directory), manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  if (manifest.fingerprint !== manifestFingerprint(manifest)) throw new Error('Manifest fingerprint mismatch');
  if (new Set(manifest.tasks.map((task) => task.instanceId)).size !== manifest.tasks.length) throw new Error('Duplicate cohort IDs');
  const records = [];
  for (const task of manifest.tasks) {
    const record = recordSchema.parse(JSON.parse(await readFile(join(root, 'records', task.instanceId + '.json'), 'utf8')));
    if (sha256(JSON.stringify(record)) !== task.recordHash || record.instance_id !== task.instanceId || record.base_commit !== task.baseCommit || record.repo !== task.repo || record.image !== task.image) throw new Error('Cohort record fingerprint mismatch: ' + task.instanceId);
    records.push(record);
  }
  return { root, manifest, records };
}
export function validateCohort(artifact, manifest, backendHash) {
  if (artifact?.protocol !== PROTOCOL || artifact.cohortFingerprint !== manifest.fingerprint || artifact.harnessCommit !== HARNESS_COMMIT || artifact.backendHash !== backendHash) throw new Error('Validation identity does not match cohort/harness/backend');
  const expected = manifest.tasks.map((task) => task.instanceId), found = artifact.results?.map((row) => row.instanceId) ?? [];
  if (artifact.total !== expected.length || found.length !== expected.length || new Set(found).size !== expected.length || found.some((key) => !expected.includes(key))) throw new Error('Validation must retain exactly every cohort member');
  if (artifact.results.some((row) => typeof row.valid !== 'boolean')) throw new Error('Invalid validation validity flags');
  for (const row of artifact.results) if (row.valid && (!row.baseline?.valid || !row.baseline.baselineExpectedFailure || row.baseline.resolved !== false || !row.reference?.valid || row.reference.resolved !== true || !/^sha256:[a-f0-9]{64}$/.test(row.imageId))) throw new Error('Invalid baseline/reference evidence');
  if (artifact.valid !== artifact.results.filter((row) => row.valid === true).length) throw new Error('Invalid validation count');
  return new Map(artifact.results.map((row) => [row.instanceId, row]));
}
// Reassess retained v2 executions without treating a workflow gate as unavailable infrastructure.
// Only structured host/child state is used; error-string keywords never decide quality scoring.
export function retainedExecutionFailure(snapshot, { transportError, patchError, legacyError } = {}) {
  const task = snapshot?.task;
  const diagnostic = task?.error || snapshot?.error || legacyError;
  const infrastructure = (reason) => ({ infrastructureFailure: true, reason, taskError: diagnostic ?? null });
  const workflow = (kind) => ({ infrastructureFailure: false, workflowFailure: true, failureKind: kind, taskError: diagnostic ?? null });
  if (transportError || patchError) return infrastructure(transportError || patchError);
  if (!task || snapshot.running || !['completed', 'failed', 'needs_attention', 'budget_exceeded', 'aborted', 'interrupted'].includes(task.status)) return infrastructure('missing_terminal_task_snapshot');
  if (task.finalization === 'failed') return infrastructure('host_finalization_failed');
  // Provider errors in the latest parent response remain infrastructure failures.
  const lastAssistant = snapshot.messages?.findLast((message) => message.role === 'assistant');
  if (lastAssistant?.stopReason === 'error') return infrastructure('provider_request_failed');
  if (task.status === 'completed' && !diagnostic && !legacyError) return { infrastructureFailure: false, workflowFailure: false, taskError: null };
  const gates = (snapshot.subagents ?? []).filter((child) => child.purpose === 'review_gate' && typeof task.startedAt === 'string' && child.startedAt >= task.startedAt && child.status === 'failed');
  if (gates.some((child) => child.budget?.exceededReason)) return workflow('review_budget');
  if (gates.some((child) => child.errorCode === 'invalid_review')) return workflow('review_format');
  if (task.status === 'budget_exceeded') return workflow('task_budget');
  if (['aborted', 'interrupted'].includes(task.status)) return workflow('interrupted');
  if (task.status === 'needs_attention') return workflow('completion_gate');
  if (task.status === 'failed' && task.verification?.status === 'failed') return workflow('configured_check');
  if (task.status !== 'completed' || diagnostic || legacyError) return infrastructure('unclassified_execution_failure');
  return { infrastructureFailure: false, workflowFailure: false, taskError: null };
}

export function gradeObservation({ official, completed, integrity, emptyPatch, patchRejected = false, executionError = null, resolutionClaimed }) {
  const assessed = !executionError && (official?.valid === true || patchRejected);
  const resolved = assessed ? official?.valid === true ? official.resolved : false : null;
  const unacceptable = resolved !== true || integrity !== true || emptyPatch === true;
  return { officialResolved: resolved, accepted: resolved === true && integrity === true,
    // Compatibility metric: a finished host workflow with an unacceptable patch.
    // Product wording or abstaining from resolution claims must not erase it.
    falseCompletion: completed && assessed ? unacceptable : null,
    infrastructureFailure: !assessed, integrityViolation: integrity === false,
    ...(typeof resolutionClaimed === 'boolean' ? { resolutionClaimed,
      falseResolutionClaim: resolutionClaimed && assessed ? unacceptable : null } : {})
  };
}
export function summarize(results, workflows) {
  return Object.fromEntries(workflows.map((workflow) => {
    const rows = results.filter((row) => row.workflow === workflow), evaluated = rows.filter((row) => !row.skipped && !row.infrastructureFailure);
    const times = evaluated.map((row) => row.executionMs).filter(Number.isFinite).sort((a, b) => a - b);
    return [workflow, { scheduled: rows.length, validationSkipped: rows.filter((row) => row.skipped).length, evaluated: evaluated.length,
      resolved: evaluated.filter((row) => row.officialResolved === true).length, accepted: evaluated.filter((row) => row.accepted).length,
      forgeCompleted: evaluated.filter((row) => row.completed === true).length, resolvedNotCompleted: evaluated.filter((row) => row.officialResolved === true && row.completed !== true).length,
      deliveredAccepted: evaluated.filter((row) => row.accepted && row.completed === true).length, workflowFailures: rows.filter((row) => row.workflowFailure).length,
      unresolvedFinishes: evaluated.filter((row) => row.completed && row.officialResolved === false).length,
      unverifiedFinishes: evaluated.filter((row) => row.completed && row.resolutionClaimed === false).length,
      resolutionClaims: rows.filter((row) => row.resolutionClaimed === true).length,
      assessedResolutionClaims: evaluated.filter((row) => row.resolutionClaimed === true && typeof row.officialResolved === 'boolean').length,
      falseResolutionClaims: evaluated.filter((row) => row.falseResolutionClaim === true).length,
      falseResolutionClaimRate: evaluated.some((row) => row.resolutionClaimed === true && typeof row.officialResolved === 'boolean')
        ? evaluated.filter((row) => row.falseResolutionClaim === true).length / evaluated.filter((row) => row.resolutionClaimed === true && typeof row.officialResolved === 'boolean').length : null,
      falseCompletions: evaluated.filter((row) => row.falseCompletion === true).length, infrastructureFailures: rows.filter((row) => row.infrastructureFailure).length,
      integrityViolations: rows.filter((row) => row.integrityViolation).length, emptyPatches: rows.filter((row) => row.emptyPatch).length,
      p50ExecutionMs: times.length ? times[Math.floor(times.length / 2)] : null,
      requestTokens: rows.reduce((sum, row) => sum + (row.budget?.totalTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.budget?.usage?.output ?? 0), 0),
      costUsd: rows.length && rows.every((row) => row.budget && !row.budget.costIncomplete) ? rows.reduce((sum, row) => sum + row.budget.costUsd, 0) : null }];
  }));
}

export function assertResumeIdentity(previous, current) {
  for (const key of ['protocol', 'cohortFingerprint', 'harnessFingerprint', 'backendHash', 'model', 'thinking', 'limits', 'validationFingerprint', 'schedule']) {
    if (current[key] === undefined || JSON.stringify(previous[key]) !== JSON.stringify(current[key])) throw new Error('Resume identity mismatch: ' + key);
  }
}
export function canReuseExecution(row) {
  return Boolean(row && !row.infrastructureFailure && typeof row.officialResolved === 'boolean' && (row.official?.valid === true || row.official?.patchRejected === true));
}
