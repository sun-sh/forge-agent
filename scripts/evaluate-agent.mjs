#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { startWebConsole } from '../dist/web/server.js';
import { tasks } from './eval-tasks.mjs';

const args = process.argv.slice(2), real = args.includes('--real');
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const workflowArg = option('--workflow', 'planned');
const workflows = workflowArg === 'both' ? ['direct', 'planned'] : [workflowArg];
const repeat = Math.max(1, Math.min(20, Number(option('--repeat', '1')) || 1));
const model = option('--model', real ? undefined : 'eval/mock');
if (!model || workflows.some((workflow) => !['planned', 'direct'].includes(workflow))) throw new Error('Use --real --model provider/model [--workflow direct|planned|both] [--repeat N], or omit --real for the isolated scripted smoke evaluation.');

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'forge-evaluation-'));
const output = resolve(option('--output', '.forge-agent/evals/' + new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const evalHome = resolve(option('--home', join(root, 'home')));
await mkdir(evalHome, { recursive: true });
process.env.FORGE_AGENT_HOME = evalHome; process.env.PFORGE_HOME = evalHome;
process.env.PI_CODING_AGENT_DIR = evalHome; process.env.PI_CODING_AGENT_SESSION_DIR = join(evalHome, 'sessions');

let gitRevision = 'unavailable';
try { gitRevision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), windowsHide: true })).stdout.trim() || gitRevision; } catch { /* evaluation can run from a source archive */ }
const suiteVersion = 'forge-eval-small-repo-v3';
const suiteFingerprint = createHash('sha256').update(JSON.stringify(tasks)).digest('hex').slice(0, 16);
let mock, activeTask, requests = 0;
if (!real) {
  mock = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), text = JSON.stringify(input.messages); requests++;
    const matches = [...text.matchAll(/PFORGE TASK PHASE: (\w+)/g)], phase = matches.at(-1)?.[1] ?? 'implement';
    const write = phase === 'implement' && input.messages.at(-1)?.role !== 'tool';
    const solutionFiles = activeTask.solutionFiles ?? { [activeTask.entry ?? 'solution.mjs']: activeTask.solution };
    const calls = Object.entries(solutionFiles).map(([path, content], index) => ({ index, id: 'eval-' + requests + '-' + index, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path, content }) } }));
    const delta = write ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: phase === 'review' ? '{"verdict":"ready","summary":"Scripted fixture review; no real model judgment measured.","issues":[]}' : phase + ' fixture response' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish] of [[delta, null], [{}, write ? 'tool_calls' : 'stop']]) response.write('data: ' + JSON.stringify({ id: 'eval', object: 'chat.completion.chunk', model: 'mock', created: 1, choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((done) => mock.listen(0, '127.0.0.1', done));
  await writeFile(join(evalHome, 'models.json'), JSON.stringify({ providers: { eval: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'isolated-eval-only', models: [{ id: 'mock' }] } } }));
}

const results = [];
const textFile = async (path) => readFile(path, 'utf8');
const writeFixture = async (project, path, content) => { const target = join(project, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); };
try {
  for (let run = 1; run <= repeat; run++) for (const workflow of workflows) for (const task of tasks) {
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
    let snapshot, session, error;
    let heldOutPass = false, verificationGate = false, workspaceIntegrity = false, taskCompletion = false;
    try {
      await api('projects/trust', { path: project, trusted: true });
      session = await api('session', { project, mode: 'agent', model, title: 'Evaluation ' + task.id + ' · ' + workflow + ' · r' + run });
      await api('sessions/' + session.id + '/prompt', { message: task.prompt, workflow });
      const deadline = Date.now() + 180000;
      do { await new Promise((done) => setTimeout(done, 100)); snapshot = await api('sessions/' + session.id); if (Date.now() > deadline) { await api('sessions/' + session.id + '/abort', {}); throw new Error('Evaluation timed out after 180000ms'); } } while (snapshot.running);
      const evaluator = join(root, `${task.id}-${workflow}-r${run}-held-out.mjs`);
      const heldOutImport = JSON.stringify(pathToFileURL(join(project, entry)).href);
      await writeFile(evaluator, 'import assert from "node:assert/strict"; import * as mod from ' + heldOutImport + ';\n' + task.heldOut + '\nconsole.log("held-out assertions passed");');
      await execute(process.execPath, [evaluator], { cwd: root, windowsHide: true, timeout: 30000 });
      heldOutPass = true;
      workspaceIntegrity = (await Promise.all([...protectedBefore].map(async ([path, value]) => (await textFile(join(project, path))) === value))).every(Boolean);
      if (!workspaceIntegrity) throw new Error('Workspace integrity gate failed');
      verificationGate = snapshot.verification?.status === 'passed';
      taskCompletion = workflow === 'planned' ? snapshot.task?.status === 'completed' : snapshot.outcome === 'completed';
      if (!verificationGate || !taskCompletion) throw new Error(snapshot.task?.error || snapshot.error || 'Completion gate did not pass');
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { await gateway.close(); }
    const stats = snapshot?.state ?? null;
    const qualityPass = !error && heldOutPass && verificationGate && workspaceIntegrity && taskCompletion;
    const latencyMs = Math.round(performance.now() - started);
    const result = {
      id: task.id, run, workflow, passed: qualityPass, qualityPass, heldOutPass, verificationGate, workspaceIntegrity, taskCompletion, error,
      durationMs: latencyMs, latencyMs, modelRequests: real ? stats?.assistantMessages ?? null : requests - beforeRequests,
      tokenUsage: stats?.tokens ?? null, costUsd: typeof stats?.cost === 'number' ? stats.cost : null,
      taskStatus: snapshot?.task?.status ?? snapshot?.outcome, verification: snapshot?.verification?.status,
      repairs: snapshot?.task?.repairs ?? snapshot?.verification?.attempts, toolCalls: stats?.toolCalls ?? snapshot?.messages?.filter((message) => message.role === 'toolResult').length ?? 0,
      stats, workspace: project, sessionFile: snapshot?.sessionFile
    };
    results.push(result);
    console.log((result.passed ? 'PASS ' : 'FAIL ') + result.id + ' · ' + workflow + ' · r' + run + ' · ' + result.durationMs + 'ms' + (error ? ' · ' + error : ''));
    await writeFile(join(output, `${task.id}.${workflow}.r${run}.json`), JSON.stringify({ ...result, task: snapshot?.task, verification: snapshot?.verification }, null, 2));
  }
} finally { if (mock) await new Promise((done) => { mock.close(done); mock.closeAllConnections(); }); }

const sortedLatencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
const percentile = (value) => sortedLatencies.length ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor((value / 100) * sortedLatencies.length))] : 0;
const report = {
  schemaVersion: 3, timestamp: new Date().toISOString(), kind: real ? 'real-model' : 'scripted-smoke', suiteVersion, suiteFingerprint,
  model, workflows, repeat, environment: { node: process.version, platform: process.platform, arch: process.arch, piVersion: VERSION, gitRevision },
  isolation: { home: evalHome, workspaceRoot: root, explicitHome: args.includes('--home') },
  note: real ? 'Small public repository task suite; this is an engineering harness, not a frontier benchmark. Compare repeated runs with fixed model/provider settings.' : 'Known solutions are scripted by an isolated local fixture. These results validate tool execution, evidence, completion and evaluation plumbing, not model coding ability.',
  metrics: {
    qualityPassRate: results.length ? results.filter((result) => result.qualityPass).length / results.length : 0,
    heldOutPassRate: results.length ? results.filter((result) => result.heldOutPass).length / results.length : 0,
    verificationGateRate: results.length ? results.filter((result) => result.verificationGate).length / results.length : 0,
    workspaceIntegrityRate: results.length ? results.filter((result) => result.workspaceIntegrity).length / results.length : 0,
    taskCompletionRate: results.length ? results.filter((result) => result.taskCompletion).length / results.length : 0,
    averageLatencyMs: results.length ? Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length) : 0,
    p50LatencyMs: percentile(50), p95LatencyMs: percentile(95), totalToolCalls: results.reduce((sum, result) => sum + (result.toolCalls || 0), 0),
    totalRepairs: results.reduce((sum, result) => sum + (result.repairs || 0), 0), totalTokens: results.reduce((sum, result) => sum + (result.tokenUsage?.total ?? 0), 0),
    totalCostUsd: results.reduce((sum, result) => sum + (result.costUsd || 0), 0)
  },
  passed: results.filter((result) => result.passed).length, total: results.length, results
};
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(report.kind + ': ' + report.passed + '/' + report.total + ' · ' + join(output, 'report.json'));
process.exitCode = report.passed === report.total ? 0 : 1;
