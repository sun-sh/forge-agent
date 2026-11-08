#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ModelRuntime, VERSION } from '@earendil-works/pi-coding-agent';
import { startWebConsole } from '../dist/web/server.js';
import { isVerified } from '../dist/verification/pi-extension.js';
import { pforgeHome } from '../dist/pforge-home.js';
import { tasks } from './eval-tasks.mjs';
import { modelEvaluationMetadata, saveEvaluationEvidence, saveHarnessEvidence } from './evaluation-evidence.mjs';

const args = process.argv.slice(2), real = args.includes('--real');
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const workflowArg = option('--workflow', 'planned');
const workflows = workflowArg === 'both' ? ['direct', 'planned'] : [workflowArg];
const repeat = Math.max(1, Math.min(20, Number(option('--repeat', '1')) || 1));
const model = option('--model', real ? undefined : 'eval/mock');
const taskFilter = option('--task');
const selectedTasks = taskFilter ? tasks.filter((task) => task.id === taskFilter) : tasks;
if (!selectedTasks.length) throw new Error('Unknown task: ' + taskFilter);
const thinking = option('--thinking');
if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
if (!model || workflows.some((workflow) => !['planned', 'direct'].includes(workflow))) throw new Error('Use --real --model provider/model [--workflow direct|planned|both] [--repeat N], or omit --real for the isolated scripted smoke evaluation.');

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'forge-evaluation-'));
const output = resolve(option('--output', '.forge-agent/evals/' + new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const harnessFingerprint = await saveHarnessEvidence(output, [import.meta.url, ...['./eval-tasks.mjs', './evaluation-evidence.mjs', '../tests/fixtures/task-handoff.json', '../dist/task/controller.js', '../dist/task/plan.js', '../dist/task/timeline.js', '../dist/task/lifecycle.js', '../dist/task/registry.js', '../dist/task/budget.js', '../dist/task/intent.js', '../dist/task/progress.js', '../dist/task/context.js', '../dist/task/queue.js', '../dist/verification/pi-extension.js', '../dist/verification/evidence.js', '../dist/web/server.js', '../dist/web/subagents.js', '../dist/web/memory.js'].map((path) => new URL(path, import.meta.url))].map((source) => new URL(source)));
const evalHome = resolve(option('--home', join(root, 'home')));
await mkdir(evalHome, { recursive: true });
const explicitHome = args.includes('--home');
const configHome = resolve(option('--config-home', pforgeHome()));
process.env.FORGE_AGENT_HOME = evalHome; process.env.PFORGE_HOME = evalHome;
process.env.PI_CODING_AGENT_DIR = evalHome; process.env.PI_CODING_AGENT_SESSION_DIR = join(evalHome, 'sessions');
let mock;

// The default evaluation home is inside the temporary workspace, so copied
// credentials and session data disappear with it. An explicitly supplied
// --home is retained for inspection, but the generated task workspace is
// still removed after the run.
const evalHomeIsInsideGeneratedRoot = evalHome === root || evalHome.startsWith(root + '\\') || evalHome.startsWith(root + '/');
const removeGeneratedRoot = !explicitHome || !evalHomeIsInsideGeneratedRoot;
let cleanupStarted = false;
async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (mock) await new Promise((done) => { mock.close(done); mock.closeAllConnections(); }).catch(() => {});
  if (removeGeneratedRoot) await rm(root, { recursive: true, force: true }).catch(() => {});
}
process.once('exit', () => {
  // The hook covers failures during model preflight, before the main
  // evaluation try/finally is entered. Normal completion uses awaited cleanup
  // below so recursive deletion is allowed to finish.
  if (cleanupStarted) return;
  mock?.closeAllConnections?.();
  if (removeGeneratedRoot) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort during process exit */ }
  }
});

async function copyIfPresent(name) {
  try {
    // Only the model catalog and credential store cross the evaluation
    // boundary. Sessions, tasks, MCP state and projects remain isolated.
    await copyFile(join(configHome, name), join(evalHome, name));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`无法复制评测配置 ${name}：${error.message}`);
  }
}

if (real && (!explicitHome || args.includes('--config-home'))) {
  await copyIfPresent('models.json');
  await copyIfPresent('auth.json');
}

let gitRevision = 'unavailable';
try { gitRevision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), windowsHide: true })).stdout.trim() || gitRevision; } catch { /* evaluation can run from a source archive */ }
const suiteVersion = 'forge-eval-small-repo-v5';
const suiteFingerprint = createHash('sha256').update(JSON.stringify(selectedTasks)).digest('hex').slice(0, 16);
let modelMetadata;
let activeTask, requests = 0;
if (!real) {
  mock = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), text = JSON.stringify(input.messages); requests++;
    const matches = [...text.matchAll(/PFORGE TASK PHASE: (\w+)/g)], phase = matches.at(-1)?.[1] ?? 'implement';
    const write = phase === 'implement' && input.messages.at(-1)?.role !== 'tool';
    const solutionFiles = activeTask.solutionFiles ?? { [activeTask.entry ?? 'solution.mjs']: activeTask.solution };
    const calls = Object.entries(solutionFiles).map(([path, content], index) => ({ index, id: 'eval-' + requests + '-' + index, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path, content }) } }));
    const handoff = JSON.parse(await readFile(new URL('../tests/fixtures/task-handoff.json', import.meta.url), 'utf8'));
    const delta = write ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: phase === 'review' ? JSON.stringify({ verdict: 'ready', summary: 'Scripted fixture review; no real model judgment measured.', issues: [], acceptance: handoff.acceptance }) : phase === 'plan' ? JSON.stringify(handoff.plan) : phase === 'inspect' ? JSON.stringify(handoff.brief) : phase + ' fixture response' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish] of [[delta, null], [{}, write ? 'tool_calls' : 'stop']]) response.write('data: ' + JSON.stringify({ id: 'eval', object: 'chat.completion.chunk', model: 'mock', created: 1, choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((done) => mock.listen(0, '127.0.0.1', done));
  await writeFile(join(evalHome, 'models.json'), JSON.stringify({ providers: { eval: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'isolated-eval-only', models: [{ id: 'mock' }] } } }));
}

if (real) {
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : '';
  const modelId = slash > 0 ? model.slice(slash + 1) : '';
  if (!provider || !modelId) throw new Error(`模型标识无效：${model}。请使用 provider/model，并用 --config-home 指向包含 models.json 与认证信息的 Forge 数据目录。`);
  let runtime;
  try {
    runtime = await ModelRuntime.create({ authPath: join(evalHome, 'auth.json'), modelsPath: join(evalHome, 'models.json'), refreshOnCreate: false });
    const available = await runtime.getAvailable();
    const selected = available.find((item) => item.provider === provider && item.id === modelId);
    if (!selected) {
      const credentials = await runtime.listCredentials();
      let configured = credentials.some((item) => item.providerId === provider);
      try { configured ||= Boolean(runtime.getProviderAuthStatus(provider).configured); } catch { /* Unknown providers are reported below without leaking config. */ }
      throw new Error(configured
        ? `模型不可用：${model}。请检查 ${provider} 的 models.json 模型 ID、接口配置或认证状态。`
        : `没有可用的模型认证：${model}。评测使用隔离副本，请设置 --config-home 指向包含已配置 models.json/auth.json 的数据目录。`);
    }
    modelMetadata = modelEvaluationMetadata(selected);
  } catch (error) {
    throw new Error(`真实模型评测启动检查失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

const results = [];
const textFile = async (path) => readFile(path, 'utf8');
const writeFixture = async (project, path, content) => { const target = join(project, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); };
try {
  for (let run = 1; run <= repeat; run++) for (const workflow of workflows) for (const task of selectedTasks) {
    activeTask = task;
    const started = performance.now(), beforeRequests = requests;
    const project = join(root, `${task.id}-${workflow}-r${run}`);
    await mkdir(project); await execute('git', ['init'], { cwd: project, windowsHide: true });
    const entry = task.entry ?? 'solution.mjs';
    const initialFiles = task.initialFiles ?? { [entry]: task.initial };
    for (const [path, content] of Object.entries(initialFiles)) await writeFixture(project, path, content);
    const visible = 'import assert from "node:assert/strict"; import * as mod from ' + JSON.stringify('./' + entry) + '; ' + task.visible + '\nconsole.log("visible assertions passed");\n';
    await writeFixture(project, 'verify.mjs', visible);
    await writeFixture(project, 'notes.txt', 'pre-existing user work\n');
    await writeFixture(project, 'pforge.json', JSON.stringify({ verify: [{ name: 'visible-tests', command: 'node verify.mjs', timeoutMs: 30000 }], verifyRetries: 1 }));
    const protectedFiles = task.protectedFiles ?? ['notes.txt', 'verify.mjs'];
    const protectedBefore = new Map(await Promise.all(protectedFiles.map(async (path) => [path, await textFile(join(project, path))])));
    const gateway = await startWebConsole({ cwd: project, port: 0 });
    const origin = new URL(gateway.url).origin;
    const api = async (path, input) => { const response = await fetch(origin + '/api/' + path, { headers: { 'content-type': 'application/json', 'x-pforge-token': gateway.token }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || String(response.status)); return data; };
    let snapshot, session, error, evidence;
    let heldOutPass = false, verificationGate = false, workspaceIntegrity = false, taskCompletion = false;
    try {
      await api('projects/trust', { path: project, trusted: true });
      session = await api('session', { project, mode: 'agent', model, ...(thinking ? { thinkingLevel: thinking } : {}), title: 'Evaluation ' + task.id + ' · ' + workflow + ' · r' + run });
      await api('sessions/' + session.id + '/prompt', { message: task.prompt, workflow });
      const deadline = Date.now() + 180000;
      do { await new Promise((done) => setTimeout(done, 100)); snapshot = await api('sessions/' + session.id); if (Date.now() > deadline) { await api('sessions/' + session.id + '/abort', {}); throw new Error('Evaluation timed out after 180000ms'); } } while (snapshot.running);
      const evaluator = join(root, `${task.id}-${workflow}-r${run}-held-out.mjs`);
      const heldOutImport = JSON.stringify(pathToFileURL(join(project, entry)).href);
      await writeFile(evaluator, 'import assert from "node:assert/strict"; import * as mod from ' + heldOutImport + ';\n' + task.heldOut + '\nconsole.log("held-out assertions passed");');
      verificationGate = isVerified(snapshot.verification);
      taskCompletion = snapshot.task?.status === 'completed';
      try {
        await execute(process.execPath, [evaluator], { cwd: root, windowsHide: true, timeout: 30000 });
        heldOutPass = true;
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      workspaceIntegrity = (await Promise.all([...protectedBefore].map(async ([path, value]) => (await textFile(join(project, path))) === value))).every(Boolean);
      if (!workspaceIntegrity) throw new Error('Workspace integrity gate failed');
      if (!verificationGate || !taskCompletion) throw new Error(snapshot.task?.error || snapshot.error || 'Completion gate did not pass');
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally {
      try { evidence = await saveEvaluationEvidence(output, `${task.id}.${workflow}.r${run}`, project, snapshot); }
      finally { await gateway.close(); }
    }
    const stats = snapshot?.state ?? null;
    // Pi's session stats describe the parent transcript. The host budget is
    // scoped to this execution and includes child-agent turns/tool calls, so
    // use it as the evaluation total whenever it is available.
    const executionBudget = snapshot?.budget ?? null;
    const qualityPass = !error && heldOutPass && verificationGate && workspaceIntegrity && taskCompletion;
    const latencyMs = Math.round(performance.now() - started);
    const result = {
      id: task.id, run, workflow, thinkingLevel: snapshot?.thinkingLevel ?? session?.thinkingLevel, passed: qualityPass, qualityPass, heldOutPass, verificationGate, workspaceIntegrity, taskCompletion,
      falseCompletion: Boolean(taskCompletion && (!heldOutPass || !verificationGate || !workspaceIntegrity)), error, evidence,
      durationMs: latencyMs, latencyMs, modelRequests: executionBudget?.modelTurns ?? (real ? stats?.assistantMessages ?? null : requests - beforeRequests),
      tokenUsage: executionBudget ? { total: executionBudget.totalTokens } : stats?.tokens ?? null,
      costUsd: real && !modelMetadata?.pricingKnown ? null : executionBudget?.costUsd ?? (typeof stats?.cost === 'number' ? stats.cost : null),
      taskStatus: snapshot?.task?.status ?? snapshot?.outcome, verification: snapshot?.verification?.status,
      repairs: snapshot?.task?.repairs ?? snapshot?.verification?.attempts, toolCalls: executionBudget?.toolCalls ?? stats?.toolCalls ?? snapshot?.messages?.filter((message) => message.role === 'toolResult').length ?? 0,
      executionBudget,
      stats, workspace: project, sessionFile: snapshot?.sessionFile
    };
    results.push(result);
    console.log((result.passed ? 'PASS ' : 'FAIL ') + result.id + ' · ' + workflow + ' · r' + run + ' · ' + result.durationMs + 'ms' + (error ? ' · ' + error : ''));
    await writeFile(join(output, `${task.id}.${workflow}.r${run}.json`), JSON.stringify({ ...result, task: snapshot?.task, verification: snapshot?.verification }, null, 2));
  }
} finally { await cleanup(); }

const sortedLatencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
const percentile = (value) => sortedLatencies.length ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor((value / 100) * sortedLatencies.length))] : 0;
const report = {
  schemaVersion: 4, timestamp: new Date().toISOString(), kind: real ? 'real-model' : 'scripted-smoke', suiteVersion, suiteFingerprint, harnessFingerprint,
  model, modelMetadata, requestedThinkingLevel: thinking, workflows, repeat, environment: { node: process.version, platform: process.platform, arch: process.arch, piVersion: VERSION, gitRevision },
  isolation: { home: evalHome, workspaceRoot: root, explicitHome: args.includes('--home') },
  note: real ? 'Small public repository task suite; this is an engineering harness, not a frontier benchmark. Compare repeated runs with fixed model/provider settings.' : 'Known solutions are scripted by an isolated local fixture. These results validate tool execution, evidence, completion and evaluation plumbing, not model coding ability.',
  metrics: {
    falseCompletions: results.filter((result) => result.falseCompletion).length,
    qualityPassRate: results.length ? results.filter((result) => result.qualityPass).length / results.length : 0,
    heldOutPassRate: results.length ? results.filter((result) => result.heldOutPass).length / results.length : 0,
    verificationGateRate: results.length ? results.filter((result) => result.verificationGate).length / results.length : 0,
    workspaceIntegrityRate: results.length ? results.filter((result) => result.workspaceIntegrity).length / results.length : 0,
    taskCompletionRate: results.length ? results.filter((result) => result.taskCompletion).length / results.length : 0,
    averageLatencyMs: results.length ? Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length) : 0,
    p50LatencyMs: percentile(50), p95LatencyMs: percentile(95), totalToolCalls: results.reduce((sum, result) => sum + (result.toolCalls || 0), 0),
    totalRepairs: results.reduce((sum, result) => sum + (result.repairs || 0), 0), totalTokens: results.reduce((sum, result) => sum + (result.tokenUsage?.total ?? 0), 0),
    totalCostUsd: real && !modelMetadata?.pricingKnown ? null : results.reduce((sum, result) => sum + (result.costUsd || 0), 0)
  },
  passed: results.filter((result) => result.passed).length, total: results.length, results
};
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(report.kind + ': ' + report.passed + '/' + report.total + ' · ' + join(output, 'report.json'));
process.exitCode = report.passed === report.total ? 0 : 1;
