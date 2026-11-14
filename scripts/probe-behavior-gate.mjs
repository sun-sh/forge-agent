#!/usr/bin/env node
/** Fixed candidates, real independent designer, native parent Pi execution, real final reviewer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, VERSION } from '@earendil-works/pi-coding-agent';
import { ForgeSubagents } from '../dist/web/subagents.js';
import { TaskController } from '../dist/task/controller.js';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS } from '../dist/task/budget.js';
import { behaviorExecutionExtension } from '../dist/task/behavior-runtime.js';
import { taskResult } from '../dist/task/result.js';
import { captureGit, compareGit, captureReviewPatch } from '../dist/task/git.js';
import { captureWorkspace } from '../dist/verification/evidence.js';
import { createPforgeVerification } from '../dist/verification/pi-extension.js';
import { pforgeHome } from '../dist/pforge-home.js';
import { saveHarnessEvidence } from './evaluation-evidence.mjs';
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const modelKey = option('--model'), output = resolve(option('--output', '.forge-agent/behavior-probe-' + new Date().toISOString().replaceAll(':', '-')));
if (!modelKey?.includes('/')) throw new Error('Build first and use --model provider/model --output NEW_DIRECTORY');
const configHome = resolve(option('--config-home', pforgeHome()));
await mkdir(output); const root = await mkdtemp(join(tmpdir(), 'forge-behavior-probe-')), home = join(root, 'home'); await mkdir(home);
const run = promisify(execFile), sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const originalRequest = 'Fix normalizePoints in points.cjs: it currently throws for the Nx1 column input [[1],[2]]. It must return [1,2] for [[1],[2]], preserve ordinary flat [1,2] and empty [] inputs, and return new arrays without mutating inputs. Do not alter the existing test or package scripts. Exercise both the reported column case and valid boundary inputs before handing back.';
const initial = "exports.normalizePoints = values => { if (values.some(Array.isArray)) throw new Error('column shape rejected'); return values.slice(); };\n";
const correct = "exports.normalizePoints = values => values.map(value => Array.isArray(value) ? value[0] : value);\n";
const defective = "exports.normalizePoints = values => { if (values.some(Array.isArray)) throw new Error('only flat inputs supported'); return values.slice(); };\n";
const acceptance = [{ criterion: 'The originally reported Nx1 input works without rejecting supported inputs.', check: 'automated', evidence: 'Execute a focused reproduction through the public API.' }, { criterion: 'Flat and empty inputs remain valid, returned arrays are new, inputs remain unchanged.', check: 'automated', evidence: 'Execute boundary assertions and inspect the small patch.' }];
const brief = { version: 1, intent: 'change', goal: originalRequest, affectedPaths: ['points.cjs'], constraints: ['Do not modify existing tests or package scripts'], acceptance, unresolved: [], steps: ['Repair point normalization and preserve supported shapes'] };
const protocol = { version: 1, id: 'frozen-native-behavior-gate-v1', registeredAt: new Date().toISOString(), originalRequest, initial, correct, defective,
  scope: 'Scripted fixed inspection/implementation; one real independent pre-implementation check designer; same frozen plan on both candidates; real parent Pi command execution; real independent final review. Not autonomous coding quality or SWE-bench.',
  shell: process.platform === 'win32' ? 'powershell' : 'bash', thinking: 'medium', order: ['correct', 'defective'], repetitions: 1, limits: DEFAULT_BUDGET_LIMITS, oracleExposure: 'External assertions run only after each product decision; excluded from model context', environment: { node: process.version, pi: VERSION, platform: process.platform } };
const sources = [import.meta.url, ...['../dist/task/behavior.js','../dist/task/behavior-runtime.js','../dist/task/controller.js','../dist/task/review.js','../dist/task/review-handoff.js','../dist/task/result.js','../dist/web/subagents.js','../dist/verification/pi-extension.js','../dist/task/review-evidence.js'].map(path => new URL(path, import.meta.url))].map(path => new URL(path));
const report = { protocol, protocolSha256: sha(JSON.stringify(protocol)), harnessFingerprint: await saveHarnessEvidence(output, sources), results: [] };
await json(join(output, 'protocol.json'), report);
let frozenDesign;
try {
  for (const name of ['auth.json', 'models.json']) { try { await copyFile(join(configHome, name), join(home, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  for (const key of ['FORGE_AGENT_HOME','PFORGE_HOME','PI_CODING_AGENT_DIR']) process.env[key] = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
  const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
  const model = (await runtime.getAvailable()).find(item => item.provider + '/' + item.id === modelKey);
  if (!model) throw new Error('Configured model unavailable');
  report.model = model.id; report.modelApi = model.api; report.pricingKnown = Object.values(model.cost ?? {}).some(value => value > 0);
  for (const candidate of protocol.order) {
    const project = join(root, 'candidate'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'points.cjs'), initial);
    await writeFile(join(project, 'existing.test.cjs'), "const assert=require('node:assert/strict'); const {normalizePoints}=require('./points.cjs');assert.deepEqual(normalizePoints([1,2]),[1,2]);\n");
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node existing.test.cjs' } }));
    await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'Syntax only', command: 'node --check points.cjs' }], protect: ['existing.test.cjs', 'package.json'], verifyRetries: 0 }));
    const git = parameters => run('git', parameters, { cwd: project, windowsHide: true, timeout: 60000 });
    if (candidate === 'correct') { await git(['init']); await git(['add','.']); await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','controlled baseline']); }
    const budget = new BudgetRuntime(DEFAULT_BUDGET_LIMITS), manager = SessionManager.create(project, join(home,'sessions'));
    const controller = new TaskController(task => manager.appendCustomEntry('pforge.task',task));
    const verifier = createPforgeVerification(project, { isProjectTrusted: () => true, managed: () => true });
    verifier.beginTurn(); await verifier.prepareTurn();
    const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [], cacheWarming: 'off' }, { projectTrusted: true });
    const extension = behaviorExecutionExtension({ active: () => controller.active && controller.state?.phase === 'check', state: () => controller.state?.behavior, trusted: () => true, record: receipt => controller.recordBehaviorReceipt(receipt) });
    const budgetExtension = pi => { pi.on('turn_start',(_,ctx)=>{if(!budget.recordModelTurn())ctx.abort()});pi.on('tool_call',()=>{if(!budget.recordToolCall())return{block:true,terminate:true,reason:'Parent budget exceeded'}});pi.on('message_end',(event,ctx)=>{if(event.message.role==='assistant'&&event.message.usage&&!budget.recordUsage(event.message.usage,report.pricingKnown))ctx.abort()});pi.on('before_agent_start',(_,ctx)=>budget.setAbort(()=>ctx.abort())); };
    const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: home, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ['mcp','codemode','tool-search'], extensionFactories: [{ name:'behavior-probe-execution',factory:extension },{name:'behavior-probe-budget',factory:budgetExtension}] });
    await resourceLoader.reload();
    const {session:parent}=await createAgentSession({cwd:project,agentDir:home,modelRuntime:runtime,model,thinkingLevel:'medium',settingsManager,sessionManager:manager,resourceLoader,tools:['read','grep','find','ls','bash','powershell']});
    await parent.bindExtensions({mode:'rpc'});
    const agents=new ForgeSubagents({home,project,manager,modelRuntime:runtime,parentModel:()=>model,thinkingLevel:()=> 'medium',budget:()=>budget,allowed:()=>false,reviewAllowed:()=>true,behaviorAllowed:()=>true,onChange(){}});
    const record={candidate,expectedDefect:candidate==='defective',startedAt:new Date().toISOString()};
    try {
      const adapter={
        async execute(phase,message){
          if(phase==='inspect')return JSON.stringify(brief);
          if(phase==='implement'){await writeFile(join(project,'points.cjs'),candidate==='correct'?correct:defective);return 'Fixed candidate injected; no test execution claimed.';}
          if(phase==='check'){await parent.prompt(message,{expandPromptTemplates:false});return parent.getLastAssistantText()??'';}
          throw new Error('Unexpected phase '+phase);
        },
        async behaviorPlan(message,signal){if(!frozenDesign){frozenDesign=await agents.behaviorPlan(message,signal);await json(join(output,'frozen-design.json'),frozenDesign);}return frozenDesign;},
        behaviorWorkspace:signal=>captureWorkspace(project,signal),behaviorShell:protocol.shell,
        verify:signal=>verifier.verifyTrusted(signal),refreshVerification:signal=>verifier.refreshEvidence(signal),
        baseline:signal=>captureGit(project,signal),changes:(baseline,signal)=>compareGit(project,baseline,signal),reviewPatch:(changes,signal)=>captureReviewPatch(project,changes,signal),
        review: (message,signal)=>agents.reviewGate('PFORGE TASK PHASE: review\n'+message,signal)
      };
      console.log('Real behavioral gate: '+candidate);
      const task=await controller.run(originalRequest,0,adapter,undefined,budget,{workflow:'planned',mode:'agent',behaviorRequired:true,model:model.id});
      record.decisionRecordedAt=new Date().toISOString();record.task=task;record.result=taskResult(task);
      record.parentMessages=manager.buildSessionContext().messages; record.children=agents.snapshot();
      for(const child of record.children)await json(join(output,candidate+'.'+child.purpose+'.detail.json'),await agents.detail(child.id));
      await json(join(output,candidate+'.json'),record); // Before external oracle.
      const oracle="const a=require('node:assert/strict'),{normalizePoints:n}=require('./points.cjs'); for(const input of [[[1],[2]],[1,2],[]]){const saved=JSON.stringify(input),out=n(input);a.deepEqual(out,input.length?[1,2]:[]);a.notEqual(out,input);a.equal(JSON.stringify(input),saved)} console.log('External assertions passed');";
      try { const answer=await run(process.execPath,['-e',oracle],{cwd:project,windowsHide:true,timeout:10000});record.oracle={passed:true,output:answer.stdout}; } catch(error){record.oracle={passed:false,output:error.stdout??'',error:error.stderr??error.message};}
      record.codeSha256=sha(await readFile(join(project,'points.cjs')));record.budget=budget.snapshot();
      assert.equal(record.oracle.passed,candidate==='correct');
      if(candidate==='correct'){assert.equal(task.behavior?.status,'passed');assert.equal(task.status,'completed');}
      else {assert.equal(task.behavior?.status,'failed');assert.notEqual(task.status,'completed');assert.equal(record.result.status,'blocked');}
      console.log(candidate+': behavior='+task.behavior?.status+'; product='+record.result.status+'; external='+record.oracle.passed);
    } catch(error){record.error=error.message;process.exitCode=1;}
    finally{await agents.close();await parent.abort().catch(()=>{});parent.dispose();record.endedAt=new Date().toISOString();report.results.push(record);await json(join(output,candidate+'.json'),record);await json(join(output,'report.json'),report);}
  }
} catch(error){report.fatalError=error.message;process.exitCode=1;}
finally{report.endedAt=new Date().toISOString();await json(join(output,'report.json'),report);await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({cases:report.results.map(x=>({candidate:x.candidate,behavior:x.task?.behavior?.status,result:x.result?.status,error:x.error})),fatalError:report.fatalError}));
