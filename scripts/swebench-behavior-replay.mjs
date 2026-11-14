#!/usr/bin/env node
/** Host-only replay controller. Labels/grading never cross into the task container. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { frozenCaseSchema, prepareFrozenReplay, replaySha256 as sha } from './behavior-replay-protocol.mjs';
import { reviewCommandEvidence } from '../dist/task/review-evidence.js';
import { saveHarnessEvidence } from './evaluation-evidence.mjs';
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const manifest=JSON.parse(await readFile(resolve(option('--manifest','evals/swebench-lite/behavior-replay.json')),'utf8'));
const spec=frozenCaseSchema.parse(manifest.cases.find(item=>item.id===option('--case')));
const source=resolve(option('--source-run')),graded=resolve(option('--graded-run')),output=resolve(option('--output'));
const load=async path=>JSON.parse(await readFile(path,'utf8')),json=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
const safe=(base,path)=>{const target=resolve(base,path),r=relative(base,target);if(r==='..'||r.startsWith('../')||r.startsWith('..\\')||isAbsolute(r))throw new Error('Artifact path escapes root');return target;};
const execute=promisify(execFile),command=(bin,parameters,options={})=>execute(bin,parameters,{windowsHide:true,timeout:60000,maxBuffer:4_000_000,...options});
const docker=parameters=>command('docker',parameters);
await mkdir(output);let container,buildRoot;
const report={schemaVersion:1,protocol:manifest.protocol,case:spec,startedAt:new Date().toISOString(),scope:'One fixed historical patch; real original-image behavior checks and review; no new implementation or official grading',preflightOnly:args.includes('--prepare-only')};
const persist=()=>json(join(output,'report.json'),report);
async function writeContainerFile(container, target, bytes) {
 if (!/^\/tmp\/forge-home\/(?:auth|models)\.json$/.test(target)) throw new Error('Unexpected credential destination');
 // Creating the file as the actual container user avoids copying host UID 1001
 // into a capability-dropped container. No credential bytes enter argv or logs.
 await new Promise((accept, reject) => {
  const child = spawn('docker', ['exec','-i',container,'sh','-c','umask 077; cat > '+target], { stdio: ['pipe','ignore','ignore'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('Container configuration write failed: '+code)); });
  child.stdin.on('error', reject); child.stdin.end(bytes);
 });
}
async function boundedProcess(bin,parameters,path,timeout){
 return new Promise((accept,reject)=>{const log=createWriteStream(path),child=spawn(bin,parameters,{windowsHide:true,stdio:['ignore','pipe','pipe']});let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},timeout);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 child.once('error',error=>{clearTimeout(timer);log.end();reject(error)});child.once('close',code=>{clearTimeout(timer);log.end(()=>timedOut?reject(new Error('Fixed subprocess deadline exceeded')):code===0?accept():reject(new Error('Subprocess exited '+code+'; retained '+path.split(/[\\/]/).at(-1))))});});
}
try{
 const sources=[import.meta.url,...['./swebench-behavior-agent.mjs','./behavior-replay-protocol.mjs','./evaluation-evidence.mjs','../evals/swebench-lite/behavior-replay.json','../dist/task/behavior.js','../dist/task/behavior-runtime.js','../dist/task/controller.js','../dist/task/review.js','../dist/task/review-handoff.js','../dist/task/result.js','../dist/task/review-evidence.js','../dist/web/subagents.js','../dist/verification/pi-extension.js'].map(path=>new URL(path,import.meta.url))].map(path=>new URL(path));
 report.harnessFingerprint=await saveHarnessEvidence(output,sources);
 const sourceBytes=await readFile(join(source,'report.json')),gradeBytes=await readFile(join(graded,'report.json'));
 assert.equal(sha(sourceBytes),manifest.sourceReportSha256);assert.equal(sha(gradeBytes),manifest.gradedReportSha256);
 const original=JSON.parse(sourceBytes),grades=JSON.parse(gradeBytes);
 const find=report=>report.results.find(row=>row.instanceId===spec.id&&row.workflow==='planned'&&row.run===1);
 const row=find(original),grade=find(grades),directory=join(source,'executions',spec.sourceKey);
 const patch=await readFile(join(directory,'prediction.patch')),snapshot=await readFile(join(directory,'snapshot.json'));
 const request=await load(join(directory,'controller','request.json'));
 const official=await readFile(safe(join(graded,'executions',spec.sourceKey,'official'),grade.official.officialReport));
 const admitted=prepareFrozenReplay(spec,row,grade,patch,snapshot,request,official);
 const input={...admitted.worker,historicalCommands:reviewCommandEvidence(admitted.entries,admitted.originalTaskId,new Set(['bash','powershell'])),model:manifest.model.provider+'/'+manifest.model.id,thinking:manifest.model.thinking,limits:manifest.limits};
 await json(join(output,'worker-input.json'),input);await writeFile(join(output,'candidate.patch'),patch);
 report.protocolIdentity={sourceRunId:manifest.sourceRunId,gradedRunId:manifest.gradedRunId,sourceReportSha256:sha(sourceBytes),gradedReportSha256:sha(gradeBytes),manifestSha256:sha(JSON.stringify(manifest)),workerInputSha256:sha(JSON.stringify(input)),limits:manifest.limits,model:manifest.model,repairs:0};
 report.registeredAt=new Date().toISOString();await persist();
 console.log(spec.id+': original image, patch, snapshot and grading provenance validated');
 if(!args.includes('--prepare-only')){
  assert.equal(process.platform,'linux','Docker replay controller must run on Linux');
  const packagePath=resolve(option('--package')),configHome=resolve(option('--config-home'));
  report.packageSha256=sha(await readFile(packagePath));
  const node=original.nodeImage;assert.ok(node.repoDigests?.[0]?.match(/^node@sha256:[a-f0-9]{64}$/));
  report.nodeImage=node;
  await boundedProcess('docker',['pull','--platform','linux/amd64',spec.image],join(output,'image-pull.log'),900000);
  assert.equal((await docker(['image','inspect','--format','{{.Id}}',spec.image])).stdout.trim(),spec.imageId);
  await boundedProcess('docker',['pull','--platform','linux/amd64',node.repoDigests[0]],join(output,'node-pull.log'),300000);
  assert.equal((await docker(['image','inspect','--format','{{.Id}}',node.repoDigests[0]])).stdout.trim(),node.imageId);
  buildRoot=await mkdtemp(join(tmpdir(),'forge-behavior-build-'));
  await copyFile(packagePath,join(buildRoot,'forge.tgz'));await copyFile(join(root,'scripts','swebench-behavior-agent.mjs'),join(buildRoot,'agent.mjs'));
  const dockerfile='FROM '+node.repoDigests[0]+' AS forge_node\nFROM '+spec.image+'\nCOPY --from=forge_node /usr/local/bin/node /usr/local/bin/node\nCOPY --from=forge_node /usr/local/lib/node_modules/npm /opt/forge-npm\nCOPY forge.tgz /tmp/forge.tgz\nRUN node /opt/forge-npm/bin/npm-cli.js install --prefix /opt/forge --omit=dev --no-audit --no-fund /tmp/forge.tgz && rm /tmp/forge.tgz\nCOPY agent.mjs /opt/forge/behavior-agent.mjs\n';
  await writeFile(join(buildRoot,'Dockerfile'),dockerfile);report.dockerfileSha256=sha(dockerfile);
  const tag='forge-behavior-replay:'+sha(spec.imageId+report.packageSha256+report.harnessFingerprint).slice(0,24);
  await boundedProcess('docker',['build','--platform','linux/amd64','-t',tag,buildRoot],join(output,'image-build.log'),900000);
  report.runnerImageId=(await docker(['image','inspect','--format','{{.Id}}',tag])).stdout.trim();await persist();
  container=(await docker(['create','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=512','--memory=6g','--cpus=2',tag,'tail','-f','/dev/null'])).stdout.trim();
  await docker(['start',container]);await docker(['exec',container,'mkdir','-p','/tmp/forge-home','/tmp/forge-output']);
  for(const name of ['auth.json','models.json'])await writeContainerFile(container,'/tmp/forge-home/'+name,await readFile(join(configHome,name)));
  await docker(['cp',join(output,'worker-input.json'),container+':/tmp/forge-input.json']);await docker(['cp',join(output,'candidate.patch'),container+':/tmp/candidate.patch']);
  const shell="source /opt/miniconda3/bin/activate testbed && export PYTHONDONTWRITEBYTECODE=1 PYTEST_ADDOPTS='-o cache_dir=/tmp/forge-pytest-cache' FORGE_AGENT_HOME=/tmp/forge-home PFORGE_HOME=/tmp/forge-home PI_CODING_AGENT_DIR=/tmp/forge-home PI_CODING_AGENT_SESSION_DIR=/tmp/forge-home/sessions && exec node /opt/forge/behavior-agent.mjs";
  let failure;
  try{await boundedProcess('docker',['exec',container,'bash','-c',shell],join(output,'execution.log'),manifest.limits.maxDurationMs+120000);}catch(error){failure=error.message;await docker(['kill',container]).catch(()=>{});}
  await docker(['cp',container+':/tmp/forge-output/.',output]);
  report.executionFailure=failure;
  try { report.result=await load(join(output,'result.json')); } catch { throw new Error('Worker did not write result.json; preserved execution.log and subprocess failure'); }
  if(failure||report.result.error||!report.result.candidateUnchanged||report.result.protection!=='unchanged')process.exitCode=1;
  console.log(JSON.stringify({id:spec.id,behavior:report.result.task?.behavior?.status,review:report.result.task?.review?.verdict,product:report.result.product?.status,officialHistorical:spec.originalOfficialResolved,unchanged:report.result.candidateUnchanged}));
 }
}catch(error){report.error=error.message;process.exitCode=1;console.error('Replay did not produce a qualified result; retained report and process logs.');}
finally{report.endedAt=new Date().toISOString();await persist();if(container)await docker(['rm','-f',container]).catch(()=>{});if(buildRoot)await rm(buildRoot,{recursive:true,force:true});}
