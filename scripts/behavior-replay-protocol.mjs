/** Immutable replay admission. Grading records stay in the controller, never the worker. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const replaySha256 = value => createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/), commit = z.string().regex(/^[a-f0-9]{40}$/);
export const frozenCaseSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+__[-a-zA-Z0-9_]+-\d+$/), sourceKey: z.string().regex(/^[-a-zA-Z0-9_]+\.planned\.r1$/),
  baseCommit: commit, effectiveHead: commit, patchSha256: sha, snapshotSha256: sha, officialReportSha256: sha,
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), image: z.string().regex(/^swebench\/[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}$/),
  originalOfficialResolved: z.boolean(), originalCompleted: z.boolean()
}).strict();
export function prepareFrozenReplay(spec, source, grade, patchBytes, snapshotBytes, request, officialBytes) {
  spec = frozenCaseSchema.parse(spec);
  const equal = (value, expected, field) => { if (value !== expected) throw new Error('Frozen replay identity mismatch: ' + field); };
  equal(source.instanceId, spec.id, 'instance'); equal(source.run, 1, 'run'); equal(source.workflow, 'planned', 'workflow');
  equal(source.patchHash, spec.patchSha256, 'source patch'); equal(grade.patchHash, spec.patchSha256, 'graded patch');
  equal(replaySha256(patchBytes), spec.patchSha256, 'patch bytes'); equal(replaySha256(snapshotBytes), spec.snapshotSha256, 'snapshot bytes');
  equal(replaySha256(officialBytes), spec.officialReportSha256, 'official bytes');
  equal(source.effectiveHead, spec.effectiveHead, 'effective HEAD'); equal(source.baseCommit, spec.baseCommit, 'base commit');
  equal(source.integrity, true, 'original protected paths'); equal(source.testChanges.length, 0, 'original test edits');
  equal(source.completed, spec.originalCompleted, 'original completion'); equal(grade.officialResolved, spec.originalOfficialResolved, 'official label');
  equal(JSON.parse(officialBytes.toString('utf8'))[spec.id]?.resolved, spec.originalOfficialResolved, 'official report label');
  const snapshot = JSON.parse(snapshotBytes.toString('utf8')), task = snapshot.task;
  equal(task.baseline.head, spec.effectiveHead, 'snapshot baseline'); equal(request.imageId, spec.imageId, 'original image');
  if (!task.prompt.startsWith(request.prompt) || !task.brief || !task.plan || task.repairs !== 0) throw new Error('Unsupported original fixed candidate');
  // Neither a label, a former review nor the implementation transcript crosses this boundary.
  const criterion = ({ id, ...item }) => item;
  const brief = { ...task.brief, acceptance: task.brief.acceptance.map(criterion), steps: task.plan.steps };
  const worker = { version: 1, protocol: 'frozen-upstream-native-behavior-v1', instanceId: spec.id,
    baseCommit: spec.baseCommit, effectiveHead: spec.effectiveHead, patchSha256: spec.patchSha256,
    originalRequest: task.prompt, brief, originalPlan: { ...task.plan, acceptance: task.plan.acceptance.map(criterion) } };
  return { worker, originalTaskId: task.id, entries: snapshot.entries };
}

/** Admit captured observations only; never convert programmatic controls to session receipts. */
export function admitNativeReviewCapture(spec, report, originalRequest, parseBehavior) {
  const equal=(a,b,label)=>{if(a!==b)throw new Error('Native capture identity mismatch: '+label);};
  equal(report.case?.id,spec.id,'case');equal(report.case?.patchSha256,spec.patchSha256,'patch');equal(report.case?.effectiveHead,spec.effectiveHead,'HEAD');
  const result=report.result;
  if(report.error||report.executionFailure||result?.error||!result?.reviewEvidence?.task)
    return {behavior:undefined,unavailable:'Native capture did not reach the review handoff; no evidence synthesized'};
  equal(result.candidateUnchanged,true,'candidate unchanged');equal(result.finalPatchSha256,spec.patchSha256,'final patch');equal(result.protection,'unchanged','protected paths');
  if(result.children?.some(child=>child.purpose==='review_gate'))throw new Error('Native preparation included reviewer decisions');
  const captured=result.reviewEvidence.task;equal(captured.prompt,originalRequest,'original request');
  equal(captured.behavior?.requestSha256,replaySha256(originalRequest),'request hash');
  const behavior=parseBehavior(captured.behavior);
  if(behavior.plan?.status!=='ready')return {behavior,unavailable:'Native capture has no ready frozen check plan; no paired evidence invented'};
  if(!(result.designCompletedAt<result.injectedAt))throw new Error('Native design did not precede fixed patch injection');
  return {behavior,unavailable:null};
}
