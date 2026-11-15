import {describe,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import {calibrationHash as hash,prepareCalibration as prepareSourceCalibration,compareCalibration} from '../scripts/behavior-calibration-protocol.mjs';
import {parseBehaviorPlan,type BehaviorPlan} from '../src/task/behavior.js';
const prepareCalibration=(bytes:Uint8Array,spec:any,expected:any,request:string)=>prepareSourceCalibration(bytes,spec,expected,request,parseBehaviorPlan);
const plan:BehaviorPlan={version:1,status:'ready',summary:'Frozen checks',assumptions:[],unresolved:[],checks:[
 {id:'B1',kind:'reproduction',requestQuote:'Fix trigger',expectation:'Trigger works',command:'python repro.py',shell:'bash',timeoutSeconds:60},
 {id:'B2',kind:'boundary',requestQuote:'Fix trigger',expectation:'Boundary works',command:'python boundary.py',shell:'bash',timeoutSeconds:60}
]};
function fixture(){
 const spec={id:'test-case',patchSha256:'a'.repeat(64)};
 const result={candidateUnchanged:true,finalPatchSha256:spec.patchSha256,protection:'unchanged',designCompletedAt:'2026-11-14T00:00:00Z',injectedAt:'2026-11-14T00:00:01Z',task:{behavior:{requestSha256:hash('Fix trigger'),plan}}};
 const source={protocol:'frozen-upstream-native-behavior-v1',case:spec,result};
 const bytes=Buffer.from(JSON.stringify(source));
 return {spec,source,bytes,expected:{reportSha256:hash(bytes),planSha256:hash(JSON.stringify(plan))}};
}
function control(name:string,exits:Array<number|null>){return {control:name,planSha256:hash(JSON.stringify(plan)),workspaceUnchanged:true,receipts:plan.checks.map((check,index)=>({checkId:check.id,commandSha256:hash(check.command),source:'pi-programmatic-shell',exitCode:exits[index],status:exits[index]===null?'unconfirmed':exits[index]===0?'passed':'failed',output:'native output',outputSha256:hash('native output'),truncated:false}))};}
describe('frozen behavioral baseline calibration',()=>{
 it('admits exactly the pre-implementation plan without regenerating expectations',()=>{
  const f=fixture();expect(prepareCalibration(f.bytes,f.spec,f.expected,'Fix trigger')).toEqual({plan,reason:null});
  expect(()=>prepareCalibration(Buffer.from('{}'),f.spec,f.expected,'Fix trigger')).toThrow();
  expect(()=>prepareCalibration(f.bytes,f.spec,{...f.expected,planSha256:'b'.repeat(64)},'Fix trigger')).toThrow();
  expect(()=>prepareCalibration(f.bytes,f.spec,f.expected,'different request')).toThrow();
 });
 it('retains an absent plan as unavailable instead of designing a replacement',()=>{
  const f=fixture();delete (f.source.result.task.behavior as any).plan;
  const bytes=Buffer.from(JSON.stringify(f.source));
  expect(prepareCalibration(bytes,f.spec,{reportSha256:hash(bytes),planSha256:null},'Fix trigger')).toEqual({plan:null,reason:'No frozen plan was produced'});
 });
 it.each(['candidateUnchanged','protection','designCompletedAt'])('rejects invalid source provenance: %s',field=>{
  const f=fixture();(f.source.result as any)[field]=field==='candidateUnchanged'?false:field==='protection'?'changed':'2026-11-15T00:00:00Z';
  const bytes=Buffer.from(JSON.stringify(f.source));expect(()=>prepareCalibration(bytes,f.spec,{...f.expected,reportSha256:hash(bytes)},'Fix trigger')).toThrow();
 });
 it('separates changed-to-pass from inherited failures and never claims concrete defects',()=>{
  expect(compareCalibration(plan,control('baseline',[1,1]),control('candidate',[0,1]))).toMatchObject([
   {checkId:'B1',outcome:'changed_to_pass',concreteDefectClaimed:false},
   {checkId:'B2',outcome:'pre_existing_failure',concreteDefectClaimed:false}
  ]);
  expect(compareCalibration(plan,control('baseline',[0,0]),control('candidate',[0,1]))).toMatchObject([{outcome:'unchanged_pass'},{outcome:'candidate_regression',concreteDefectClaimed:false}]);
  expect(compareCalibration(plan,control('baseline',[null,0]),control('candidate',[1,0]))[0]?.outcome).toBe('unconfirmed');
 });
 it.each(['command','duplicate','missing','mutated','control','plan','fakePass','truncation'])('fails closed on invalid control evidence: %s',field=>{
  const a=control('baseline',[1,0]),b=control('candidate',[0,0]);
  if(field==='command')b.receipts[0]!.commandSha256='f'.repeat(64);
  if(field==='duplicate')b.receipts[1]=b.receipts[0]!;
  if(field==='missing')b.receipts.pop();
  if(field==='mutated')b.workspaceUnchanged=false;
  if(field==='control')b.control='baseline';
  if(field==='plan')b.planSha256='f'.repeat(64);
  if(field==='fakePass')b.receipts[0]!.exitCode=1;
  if(field==='truncation')b.receipts[0]!.truncated=true;
  expect(()=>compareCalibration(plan,a,b)).toThrow();
 });
 it('uses native offline controls without model credentials, mounts or a replacement plan',async()=>{
  const workflow=YAML.parse(await readFile('.github/workflows/behavior-calibration.yml','utf8'));
  expect(workflow.jobs.calibrate.strategy['max-parallel']).toBe(2);
  expect(JSON.stringify(workflow)).not.toContain('secrets.');
  const worker=await readFile('scripts/swebench-behavior-calibration-agent.mjs','utf8');
  expect(worker).toContain('createBashToolDefinition');expect(worker).not.toMatch(/createAgentSession|ModelRuntime|auth\.json|models\.json/);
  const host=await readFile('scripts/swebench-behavior-replay.mjs','utf8');expect(host).toContain("'--network=none'");
  expect(host).not.toMatch(/--privileged|docker\.sock|--mount|--volume/);
 });
});
