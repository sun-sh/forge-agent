/** Fixed-candidate execution inside the pinned task image; no labels/hidden tests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, VERSION } from '/opt/forge/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { TaskController } from '/opt/forge/node_modules/forge-agent/dist/task/controller.js';
import { BudgetRuntime } from '/opt/forge/node_modules/forge-agent/dist/task/budget.js';
import { behaviorExecutionExtension } from '/opt/forge/node_modules/forge-agent/dist/task/behavior-runtime.js';
import { taskResult } from '/opt/forge/node_modules/forge-agent/dist/task/result.js';
import { captureGit, compareGit, captureReviewPatch } from '/opt/forge/node_modules/forge-agent/dist/task/git.js';
import { captureWorkspace } from '/opt/forge/node_modules/forge-agent/dist/verification/evidence.js';
import { createPforgeVerification } from '/opt/forge/node_modules/forge-agent/dist/verification/pi-extension.js';
import { ForgeSubagents } from '/opt/forge/node_modules/forge-agent/dist/web/subagents.js';
const execute = promisify(execFile), project = '/testbed', home = '/tmp/forge-home', output = '/tmp/forge-output';
const input = JSON.parse(await readFile('/tmp/forge-input.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execute('git', ['--no-pager','-c','core.hooksPath=','-c','core.fsmonitor=false',...args], { cwd: project, timeout: 30000, maxBuffer: 8_000_000 });
const json = (file, value) => writeFile(join(output,file), JSON.stringify(value,null,2)+'\n');
const head = (await git(['rev-parse','HEAD'])).stdout.trim(); assert.equal(head,input.effectiveHead);
await git(['merge-base','--is-ancestor',input.baseCommit,head]);
assert.equal((await git(['status','--porcelain','--untracked-files=no'])).stdout,'');
const patch = await readFile('/tmp/candidate.patch'); assert.equal(hash(patch),input.patchSha256);
const internal=['forge-agent.json','forge-agent.yaml','forge-agent.yml','pforge.json','pforge.yaml','pforge.yml'];
const testPath=path=>/(^|\/)(?:tests?|testing)(\/|$)|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$|(^|\/)conftest\.py$/.test(path);
const tracked=(await git(['ls-files','-z'])).stdout.split('\0').filter(Boolean);
const roots=[...new Set(tracked.filter(testPath).map(path=>{const p=path.split('/'),i=p.findIndex(x=>/^(tests?|testing)$/.test(x));return i<0?path:p.slice(0,i+1).join('/');}))];
const protect=[...roots.filter(path=>!roots.some(parent=>parent!==path&&path.startsWith(parent+'/'))),...internal];
assert.ok(protect.length<=200);assert.ok(internal.every(path=>!tracked.includes(path)));
await writeFile('/tmp/forge-visible.py',"import py_compile,subprocess,os\npaths=subprocess.check_output(['git','diff','--name-only','-z']).decode().split('\\0')\nfor p in paths:\n if p.endswith('.py') and os.path.isfile(p): py_compile.compile(p,doraise=True)\nprint('Changed Python syntax checked; behavioral acceptance remains unverified.')\n");
await writeFile(join(project,'forge-agent.json'),JSON.stringify({verify:[{name:'changed-python-syntax',command:'python /tmp/forge-visible.py',timeoutMs:120000}],verifyRetries:0,protect}));
const runtime=await ModelRuntime.create({authPath:join(home,'auth.json'),modelsPath:join(home,'models.json'),refreshOnCreate:false});
const model=(await runtime.getAvailable()).find(m=>m.provider+'/'+m.id===input.model);if(!model)throw new Error('Configured model unavailable');
const manager=SessionManager.create(project,join(home,'sessions'));
const controller=new TaskController(task=>manager.appendCustomEntry('pforge.task',task));
const budget=new BudgetRuntime(input.limits),verifier=createPforgeVerification(project,{isProjectTrusted:()=>true,managed:()=>true});
verifier.beginTurn();await verifier.prepareTurn();
const pricingKnown=Object.values(model.cost??{}).some(price=>price>0);
const settingsManager=SettingsManager.inMemory({packages:[],extensions:[],skills:[],prompts:[],themes:[],cacheWarming:'off'},{projectTrusted:true});
const policy=behaviorExecutionExtension({active:()=>controller.active&&controller.state?.phase==='check',state:()=>controller.state?.behavior,trusted:()=>true,record:receipt=>controller.recordBehaviorReceipt(receipt)});
const metering=pi=>{pi.on('before_agent_start',(_,ctx)=>budget.setAbort(()=>ctx.abort()));pi.on('turn_start',(_,ctx)=>{if(!budget.recordModelTurn())ctx.abort()});pi.on('tool_call',()=>{if(!budget.recordToolCall())return{block:true,terminate:true,reason:'Shared task budget exhausted'}});pi.on('message_end',(e,ctx)=>{if(e.message.role==='assistant'&&e.message.usage&&!budget.recordUsage(e.message.usage,pricingKnown))ctx.abort()});};
const resourceLoader=new DefaultResourceLoader({cwd:project,agentDir:home,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,disabledBuiltinExtensions:['mcp','codemode','tool-search'],extensionFactories:[{name:'behavior-execution',factory:policy},{name:'replay-budget',factory:metering}]});await resourceLoader.reload();
const {session:parent}=await createAgentSession({cwd:project,agentDir:home,modelRuntime:runtime,model,thinkingLevel:input.thinking,settingsManager,sessionManager:manager,resourceLoader,tools:['read','grep','find','ls','bash']});await parent.bindExtensions({mode:'rpc'});
const agents=new ForgeSubagents({home,project,manager,modelRuntime:runtime,parentModel:()=>model,thinkingLevel:()=>input.thinking,budget:()=>budget,allowed:()=>false,reviewAllowed:()=>true,behaviorAllowed:()=>true,onChange(){}});
const result={schemaVersion:1,protocol:input.protocol,instanceId:input.instanceId,patchSha256:input.patchSha256,effectiveHead:head,startedAt:new Date().toISOString(),environment:{node:process.version,pi:VERSION,platform:process.platform},model:model.id,api:model.api,pricingKnown};
const fingerprint=createHash('sha256');async function hashDist(directory,prefix=''){for(const entry of (await (await import('node:fs/promises')).readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.isDirectory())await hashDist(join(directory,entry.name),prefix+entry.name+'/');else{fingerprint.update(prefix+entry.name).update(await readFile(join(directory,entry.name)));}}}await hashDist('/opt/forge/node_modules/forge-agent/dist');result.runtimeFingerprint=fingerprint.digest('hex');
try{
 const adapter={
  async execute(phase,message){
   if(phase==='inspect')return JSON.stringify(input.brief);
   if(phase==='plan')return JSON.stringify(input.originalPlan);
   if(phase==='implement'){await git(['apply','--check','/tmp/candidate.patch']);await git(['apply','--whitespace=nowarn','/tmp/candidate.patch']);const actual=(await git(['diff','--binary','--no-ext-diff','--no-textconv',head])).stdout;assert.equal(hash(actual),input.patchSha256);result.injectedAt=new Date().toISOString();return 'Applied fixed original patch; implementation was not regenerated.';}
   if(phase==='check'){console.log('Executing frozen behavioral checks');await parent.prompt(message,{expandPromptTemplates:false});return parent.getLastAssistantText()??'';}
   throw new Error('Unexpected fixed-candidate phase');
  },
  async behaviorPlan(message,signal){console.log('Designing independent behavioral checks from original request');await writeFile(join(output,'designer-input.txt'),message);const design=await agents.behaviorPlan(message,signal);await json('frozen-design.json',design);result.designCompletedAt=new Date().toISOString();return design;},
  behaviorWorkspace:signal=>captureWorkspace(project,signal),behaviorShell:'bash',verify:signal=>verifier.verifyTrusted(signal),refreshVerification:signal=>verifier.refreshEvidence(signal),baseline:signal=>captureGit(project,signal),changes:(baseline,signal)=>compareGit(project,baseline,signal),reviewPatch:(changes,signal)=>captureReviewPatch(project,changes,signal),commandEvidence:()=>input.historicalCommands,
  async review(message,signal){console.log('Reviewing fixed patch and actual receipts');await writeFile(join(output,'review-input.txt'),message);return agents.reviewGate('PFORGE TASK PHASE: review\n'+message,signal);}
 };
 result.task=await controller.run(input.originalRequest,0,adapter,undefined,budget,{workflow:'planned',mode:'agent',behaviorRequired:true,model:model.id});result.product=taskResult(result.task);
 result.parentMessages=manager.buildSessionContext().messages;result.children=agents.snapshot();for(const child of result.children)await json(child.purpose+'.detail.json',await agents.detail(child.id));
 const actual=(await git(['diff','--binary','--no-ext-diff','--no-textconv',head])).stdout;result.finalPatchSha256=hash(actual);result.candidateUnchanged=result.finalPatchSha256===input.patchSha256;result.protection=verifier.outcome.protection?.status;
 await writeFile(join(output,'observed.patch'),actual);result.budget=budget.snapshot();result.costUsd=pricingKnown?result.budget.costUsd:null;
 console.log(JSON.stringify({instanceId:input.instanceId,behavior:result.task.behavior?.status,review:result.task.review?.verdict,product:result.product.status,candidateUnchanged:result.candidateUnchanged}));
}catch(error){result.error=error.message;result.task=controller.state;process.exitCode=1;}
finally{await agents.close();await parent.abort().catch(()=>{});parent.dispose();result.endedAt=new Date().toISOString();await json('result.json',result);}
