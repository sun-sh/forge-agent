import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const calibrationHash = value => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const controlReceiptSchema = z.object({
 checkId:z.string().regex(/^B[1-3]$/), commandSha256:hash, source:z.literal('pi-programmatic-shell'),
 exitCode:z.number().int().nullable(), status:z.enum(['passed','failed','unconfirmed']),
 output:z.string().max(6000), outputSha256:hash, truncated:z.boolean(), error:z.string().max(1000).optional()
}).strict();
export function prepareCalibration(bytes, spec, expected, request, parsePlan) {
 assert.equal(calibrationHash(bytes),expected.reportSha256,'Frozen design report identity changed');
 const report=JSON.parse(bytes),result=report.result;
 assert.equal(report.protocol,'frozen-upstream-native-behavior-v1');assert.ok(!report.error&&!report.executionFailure&&!result?.error,'Failed source replay cannot supply controls');
 assert.deepEqual(report.case,spec,'Frozen candidate identity changed');
 assert.equal(result?.candidateUnchanged,true);assert.equal(result.finalPatchSha256,spec.patchSha256);assert.equal(result.protection,'unchanged');
 assert.equal(result.task.behavior.requestSha256,calibrationHash(request));
 const raw=result.task.behavior.plan;
 if(!raw){assert.equal(expected.planSha256,null);return {plan:null,reason:result.task.behavior.reason??'No frozen plan was produced'};}
 assert.equal(calibrationHash(JSON.stringify(raw)),expected.planSha256,'Frozen check plan changed');
 const plan=parsePlan(JSON.stringify(raw),request,'bash');assert.ok(plan?.status==='ready');
 assert.ok(result.designCompletedAt<result.injectedAt,'Design did not precede patch injection');
 return {plan,reason:null};
}
export function compareCalibration(plan, baseline, candidate) {
 const parse=(control,expectedControl)=>{
  assert.equal(control.control,expectedControl);assert.equal(control.planSha256,calibrationHash(JSON.stringify(plan)),'Control plan identity changed');
  assert.equal(control.workspaceUnchanged,true,'Control mutated its tracked workspace');
  const rows=z.array(controlReceiptSchema).parse(control.receipts);
  assert.equal(rows.length,plan.checks.length,'Missing native control receipt');
  assert.equal(new Set(rows.map(r=>r.checkId)).size,rows.length,'Duplicate control receipt');
  for(const check of plan.checks){const row=rows.find(r=>r.checkId===check.id);assert.ok(row);assert.equal(row.commandSha256,calibrationHash(check.command));
   assert.ok(row.status!=='passed'||row.exitCode===0&&!row.truncated,'Invalid passing receipt');
   assert.ok(row.status!=='failed'||row.exitCode!==null&&row.exitCode!==0&&!row.truncated,'Invalid failing receipt');}
  return rows;
 };
 const before=parse(baseline,'baseline'),after=parse(candidate,'candidate');
 return plan.checks.map(check=>{const a=before.find(r=>r.checkId===check.id),b=after.find(r=>r.checkId===check.id);
  const outcome=a.status==='unconfirmed'||b.status==='unconfirmed'?'unconfirmed':a.status==='passed'?b.status==='passed'?'unchanged_pass':'candidate_regression':b.status==='passed'?'changed_to_pass':'pre_existing_failure';
  return {checkId:check.id,kind:check.kind,commandSha256:calibrationHash(check.command),baseline:a.status,candidate:b.status,outcome,sameOutput:a.outputSha256===b.outputSha256,concreteDefectClaimed:false};
 });
}
