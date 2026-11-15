import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allBehaviorChecksNonDiscriminating, behaviorCheckDiscrimination, behaviorCurrent, behaviorHash, beginBehaviorRun, newBehaviorState, settleBehaviorRun, type BehaviorPlan, type BehaviorReceipt, type BehaviorState } from '../src/task/behavior.js';
import { constrainReviewDiscrimination } from '../src/task/review-discrimination.js';
import { reviewStop, type TaskReview } from '../src/task/review.js';
import type { TaskPlan } from '../src/task/plan.js';
import { buildReviewHandoff } from '../src/task/review-handoff.js';
import { createExecutionState } from '../src/task/controller.js';

const request = 'Fix column normalization while preserving valid inputs.';
const plan: BehaviorPlan = {version:1,status:'ready',summary:'Controlled receipt policy, not model quality',assumptions:[],unresolved:[],checks:[
  {id:'B1',kind:'reproduction',requestQuote:'Fix column normalization',expectation:'Columns work',command:'node trigger.cjs',shell:'bash',timeoutSeconds:30},
  {id:'B2',kind:'boundary',requestQuote:'preserving valid inputs',expectation:'Flat input works',command:'node boundary.cjs',shell:'bash',timeoutSeconds:30}
]};
const taskPlan: TaskPlan = {version:1,summary:request,affectedPaths:['points.cjs'],constraints:[],steps:['Fix the behavior'],acceptance:[
  {id:'A1',criterion:'Columns normalize',check:'automated',evidence:'An applicable native assertion'},
  {id:'A2',criterion:'Valid inputs remain valid',check:'automated',evidence:'Boundary assertions'}
]};
const stamp = (letter:string) => ({version:1 as const,scope:'git' as const,digest:letter.repeat(64),files:1});
function receipt(state:BehaviorState,index:number,exitCode:number,output:string):BehaviorReceipt {
  const check=state.plan!.checks[index]!;
  return {version:1,runId:state.runId!,checkId:check.id,toolCallId:randomUUID(),tool:check.shell,commandSha256:behaviorHash(check.command),source:'pi-builtin-shell',exitCode,status:exitCode===0?'passed':'failed',output,outputSha256:behaviorHash(output),outputCharacters:output.length,truncated:false,recordedAt:new Date().toISOString()};
}
function evidence(before=[0,0],after=[0,0],differentOutput=false) {
  let state=beginBehaviorRun({...newBehaviorState(request),plan:structuredClone(plan)},stamp('a'),'baseline');
  state.receipts=before.map((code,index)=>receipt(state,index,code,'check '+index));state=settleBehaviorRun(state,stamp('a'));
  state.calibration!.implementationStarted=true;state=beginBehaviorRun(state,stamp('b'),'candidate');
  state.receipts=after.map((code,index)=>receipt(state,index,code,'check '+index+(differentOutput&&index===0?' changed':'')));
  return settleBehaviorRun(state,stamp('b'));
}
const ready=():TaskReview=>({verdict:'ready',summary:'Model claims ready',issues:[],issueKinds:[],acceptance:taskPlan.acceptance.map(item=>({id:item.id,status:'met',evidence:'Model-authored opinion'}))});

describe('frozen check discrimination review constraint',()=>{
  it('does not count identical successful receipts as evidence of patch effect',()=>{
    const state=evidence(),review=ready(),saved=structuredClone({state,review});
    expect(behaviorCurrent(state,stamp('b').digest)).toBe(true); // Native process semantics do not change.
    expect(behaviorCheckDiscrimination(state).map(item=>item.status)).toEqual(['non_discriminating','non_discriminating']);
    const result=constrainReviewDiscrimination(review,taskPlan,state);
    expect(result).toMatchObject({verdict:'insufficient_evidence',issues:[],acceptance:[{id:'A1',status:'unconfirmed'},{id:'A2',status:'unconfirmed'}]});
    expect(reviewStop(result,['A1','A2'])).toMatchObject({reason:'insufficient_evidence',action:'provide_evidence',issueCount:0,unconfirmedIds:['A1','A2']});
    expect({state,review}).toEqual(saved);
  });
  it('does not turn identical pre-existing failures into a new defect',()=>{
    const state=evidence([1,0],[1,0]);
    expect(allBehaviorChecksNonDiscriminating(state)).toBe(true);
    const result=constrainReviewDiscrimination(ready(),taskPlan,state);
    expect(result.verdict).toBe('insufficient_evidence');expect(result.issues).toEqual([]);
    expect(state.receipts[0]).toMatchObject({status:'failed',exitCode:1}); // Execution is still reported.
  });
  it('retains independent concrete defects despite non-discriminating checks',()=>{
    const review:TaskReview={verdict:'changes_requested',summary:'Source counterexample',issues:['points.cjs rejects previously accepted Nx1 input'],issueKinds:['code_defect'],acceptance:[{id:'A1',status:'unmet',evidence:'Specific path and trigger'},{id:'A2',status:'met',evidence:'Boundary source'}]};
    expect(constrainReviewDiscrimination(review,taskPlan,evidence())).toBe(review);
    expect(reviewStop(review,['A1','A2'])?.reason).toBe('code_defects');
  });
  it('keeps failure-to-pass evidence with a stable boundary eligible',()=>{
    const state=evidence([1,0],[0,0]);
    expect(behaviorCheckDiscrimination(state).map(item=>item.status)).toEqual(['discriminating','non_discriminating']);
    const review=ready();expect(constrainReviewDiscrimination(review,taskPlan,state)).toBe(review);
  });
  it('counts changed output as a distinguishable observation, not automatic proof',()=>{
    const state=evidence([0,0],[0,0],true);
    expect(behaviorCheckDiscrimination(state)[0]!.status).toBe('discriminating');
    const uncertain:TaskReview={...ready(),verdict:'insufficient_evidence',acceptance:taskPlan.acceptance.map(item=>({id:item.id,status:'unconfirmed',evidence:'No semantic conclusion'}))};
    expect(constrainReviewDiscrimination(uncertain,taskPlan,state)).toBe(uncertain);
  });
  it.each(['missing','stale','truncated','wrong_command','duplicate'] as const)('does not disguise invalid evidence as an identical comparison (%s)',kind=>{
    const state=evidence();
    if(kind==='missing')state.receipts.pop();
    if(kind==='stale')state.runWorkspace!.digest='c'.repeat(64);
    if(kind==='truncated')state.receipts[0]!.truncated=true;
    if(kind==='wrong_command')state.receipts[0]!.commandSha256='d'.repeat(64);
    if(kind==='duplicate')state.receipts[1]=structuredClone(state.receipts[0]!);
    expect(allBehaviorChecksNonDiscriminating(state)).toBe(false);
    expect(behaviorCurrent(state,stamp('b').digest)).toBe(false);
  });
  it('keeps missing/duplicate acceptance IDs invalid rather than repairing the review',()=>{
    const review=ready();review.acceptance=[review.acceptance![0]!,review.acceptance![0]!];
    expect(constrainReviewDiscrimination(review,taskPlan,evidence())).toBe(review);
    expect(reviewStop(review,['A1','A2'])?.reason).toBe('invalid_review');
  });
  it('does not invent a baseline or classify historical tasks without calibration',()=>{
    const state=evidence();delete state.calibration;
    expect(behaviorCheckDiscrimination(state)).toEqual([]);
    const review=ready();expect(constrainReviewDiscrimination(review,taskPlan,state)).toBe(review);
  });
  it('carries compatibility, test-regression and discrimination rules without hidden test names',()=>{
    const task=createExecutionState(request,{workflow:'planned'});task.plan=taskPlan;task.behavior=evidence();
    const handoff=buildReviewHandoff(task,{version:1,files:[],characters:0,lines:0});
    expect(handoff.prompt).toContain('COMPATIBILITY NARROWING:');
    expect(handoff.prompt).toContain('PRE-EXISTING TEST FAILURE:');
    expect(handoff.prompt).toContain('CHECK DISCRIMINATION:');
    expect(handoff.prompt).toContain('ORIGINAL USER REQUEST');
    expect(handoff.prompt).not.toContain('test_draw_single_lines_from_Nx1');
    expect(handoff.prompt).not.toContain('test_route_decorator_custom_endpoint_with_dots');
    const value=JSON.parse(handoff.prompt.split('EVIDENCE:')[1]!.trim().split(String.fromCharCode(10))[0]!);
    expect(value.independentBehaviorChecks.discrimination[0].status).toBe('non_discriminating');
  });
});
