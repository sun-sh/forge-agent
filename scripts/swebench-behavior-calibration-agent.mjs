/** Offline control probe: native Pi shell implementation, no AgentSession or Provider. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {createBashToolDefinition,VERSION} from '/opt/forge/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {behaviorPlanSchema} from '/opt/forge/node_modules/forge-agent/dist/task/behavior.js';
import {captureWorkspace} from '/opt/forge/node_modules/forge-agent/dist/verification/evidence.js';
import {classifyCommandReceipt,sensitiveCommandEvidence} from '/opt/forge/node_modules/forge-agent/dist/task/review-evidence.js';
const execute=promisify(execFile),project='/testbed',output='/tmp/forge-output';
const input=JSON.parse(await readFile('/tmp/forge-input.json','utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=args=>execute('git',['--no-pager','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],{cwd:project,timeout:30000,maxBuffer:8000000});
const result={version:1,protocol:input.protocol,control:input.control,instanceId:input.instanceId,planSha256:input.planSha256,modelCalls:0,receipts:[],startedAt:new Date().toISOString(),environment:{node:process.version,pi:VERSION,platform:process.platform}};
const save=()=>writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');
try{
 assert.ok(['baseline','candidate'].includes(input.control));
 assert.equal((await git(['rev-parse','HEAD'])).stdout.trim(),input.effectiveHead);
 assert.equal((await git(['status','--porcelain','--untracked-files=no'])).stdout,'');
 const patch=await readFile('/tmp/candidate.patch');assert.equal(hash(patch),input.patchSha256);
 const plan=behaviorPlanSchema.parse(input.plan);assert.equal(plan.status,'ready');assert.equal(hash(JSON.stringify(plan)),input.planSha256);
 if(input.control==='candidate'){await git(['apply','--check','/tmp/candidate.patch']);await git(['apply','--whitespace=nowarn','/tmp/candidate.patch']);}
 result.patchBefore=hash((await git(['diff','--binary','--no-ext-diff','--no-textconv',input.effectiveHead])).stdout);
 assert.equal(result.patchBefore,input.control==='candidate'?input.patchSha256:hash(''));
 result.workspaceBefore=await captureWorkspace(project);
 const tool=createBashToolDefinition(project,{exposeSessionEnvironment:false});
 for(const check of plan.checks){
  assert.equal(check.shell,'bash');const row={checkId:check.id,commandSha256:hash(check.command),source:'pi-programmatic-shell',exitCode:null,status:'unconfirmed',output:'',outputSha256:hash(''),truncated:false};
  try{
   const native=await tool.execute('control-'+randomUUID(),{command:check.command,timeout:check.timeoutSeconds},AbortSignal.timeout((check.timeoutSeconds+10)*1000));
   const value=native.structuredContent;assert.equal(typeof value?.output,'string');assert.ok(Number.isInteger(value.exit_code));
   const text=value.output,sensitive=sensitiveCommandEvidence(text),outcome=classifyCommandReceipt(check.command,text,Boolean(native.isError));
   row.exitCode=value.exit_code;row.truncated=value.truncated===true||text.length>6000;row.output=sensitive?'[Sensitive output omitted]':text.slice(0,6000);row.outputSha256=hash(text);
   if(!sensitive&&!row.truncated&&value.exit_code===0&&!native.isError&&outcome.outcome!=='failed'&&outcome.outcome!=='zero_tests')row.status='passed';
   else if(!sensitive&&!row.truncated&&value.exit_code!==0)row.status='failed';
  }catch(error){const text=error instanceof Error?error.message:String(error);row.error=sensitiveCommandEvidence(text)?'Sensitive error omitted':text.slice(0,1000);}
  result.receipts.push(row);await save();
 }
 result.workspaceAfter=await captureWorkspace(project);
 result.patchAfter=hash((await git(['diff','--binary','--no-ext-diff','--no-textconv',input.effectiveHead])).stdout);
 result.workspaceUnchanged=result.workspaceBefore.digest===result.workspaceAfter.digest&&result.workspaceBefore.scope===result.workspaceAfter.scope&&result.patchBefore===result.patchAfter;
 assert.equal(result.workspaceUnchanged,true,'Control changed workspace; no attribution');
}catch(error){result.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{result.endedAt=new Date().toISOString();await save();}
