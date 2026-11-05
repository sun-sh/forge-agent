#!/usr/bin/env node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startWebConsole } from '../dist/web/server.js';
import { tasks } from './eval-tasks.mjs';

const args = process.argv.slice(2), real = args.includes('--real');
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const model = option('--model', real ? undefined : 'eval/mock'), workflow = option('--workflow', 'planned');
if (!model || !['planned', 'direct'].includes(workflow)) throw new Error('Use --real --model provider/model [--workflow planned|direct], or omit --real for the isolated scripted smoke evaluation.');
const execute = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'pforge-evaluation-'));
const output = resolve(option('--output', '.forge-agent/evals/' + new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
let mock, activeTask, requests = 0;
if (!real) {
  const home = join(root, 'home'); await mkdir(home);
  process.env.FORGE_AGENT_HOME = home; process.env.PFORGE_HOME = home; process.env.PI_CODING_AGENT_DIR = home; process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
  mock = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), text = JSON.stringify(input.messages); requests++;
    const matches = [...text.matchAll(/PFORGE TASK PHASE: (\w+)/g)], phase = matches.at(-1)?.[1] ?? 'implement';
    const write = phase === 'implement' && input.messages.at(-1)?.role !== 'tool';
    const delta = write ? { role: 'assistant', tool_calls: [{ index: 0, id: 'eval-' + requests, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'solution.mjs', content: activeTask.solution }) } }] }
      : { role: 'assistant', content: phase === 'review' ? '{"verdict":"ready","summary":"Scripted fixture review; no real model judgment measured.","issues":[]}' : phase + ' fixture response' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish] of [[delta, null], [{}, write ? 'tool_calls' : 'stop']]) response.write('data: ' + JSON.stringify({ id: 'eval', object: 'chat.completion.chunk', model: 'mock', created: 1, choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((done) => mock.listen(0, '127.0.0.1', done));
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { eval: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'isolated-eval-only', models: [{ id: 'mock' }] } } }));
}
const results = [];
try {
  for (const task of tasks) {
    activeTask = task; const started = performance.now(), beforeRequests = requests, project = join(root, task.id);
    await mkdir(project); await execute('git', ['init'], { cwd: project, windowsHide: true });
    const visible = 'import assert from "node:assert/strict"; import * as mod from "./solution.mjs"; ' + task.visible + '\nconsole.log("visible assertions passed");\n';
    await writeFile(join(project, 'solution.mjs'), task.initial); await writeFile(join(project, 'verify.mjs'), visible);
    await writeFile(join(project, 'notes.txt'), 'pre-existing user work\n');
    await writeFile(join(project, 'pforge.json'), JSON.stringify({ verify: [{ name: 'visible-tests', command: 'node verify.mjs', timeoutMs: 30000 }], verifyRetries: 1 }));
    const gateway = await startWebConsole({ cwd: project, port: 0 }); const origin = new URL(gateway.url).origin;
    const api = async (path, input) => { const response = await fetch(origin + '/api/' + path, { headers: { 'content-type': 'application/json', 'x-pforge-token': gateway.token }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || String(response.status)); return data; };
    let snapshot, session, error;
    let heldOutPass = false, verificationGate = false, workspaceIntegrity = false, taskCompletion = false;
    try {
      await api('projects/trust', { path: project, trusted: true });
      session = await api('session', { project, mode: 'agent', model, title: 'Evaluation ' + task.id });
      await api('sessions/' + session.id + '/prompt', { message: task.prompt, workflow });
      const deadline = Date.now() + 180000;
      do { await new Promise((done) => setTimeout(done, 100)); snapshot = await api('sessions/' + session.id); if (Date.now() > deadline) { await api('sessions/' + session.id + '/abort', {}); throw new Error('Evaluation timed out after 180000ms'); } } while (snapshot.running);
      // The held-out evaluator lives outside the project, so rewriting visible tests cannot satisfy it.
      const evaluator = join(root, task.id + '-held-out.mjs');
      await writeFile(evaluator, 'import assert from "node:assert/strict"; import * as mod from ' + JSON.stringify(pathToFileURL(join(project, 'solution.mjs')).href) + ';\n' + task.heldOut + '\nconsole.log("held-out assertions passed");');
      await execute(process.execPath, [evaluator], { cwd: root, windowsHide: true, timeout: 30000 });
      heldOutPass = true;
      const notesIntact = await readFile(join(project, 'notes.txt'), 'utf8') === 'pre-existing user work\n';
      const verificationIntact = await readFile(join(project, 'verify.mjs'), 'utf8') === visible;
      workspaceIntegrity = notesIntact && verificationIntact;
      if (!workspaceIntegrity) throw new Error('Workspace integrity gate failed');
      verificationGate = snapshot.verification.status === 'passed';
      taskCompletion = workflow === 'planned' ? snapshot.task?.status === 'completed' : snapshot.outcome === 'completed';
      if (!verificationGate || !taskCompletion) throw new Error(snapshot.task?.error || snapshot.error || 'Completion gate did not pass');
    } catch (failure) { error = failure.message; }
    finally { await gateway.close(); }
    const qualityPass = !error && heldOutPass && verificationGate && workspaceIntegrity && taskCompletion;
    const latencyMs = Math.round(performance.now() - started);
    const result = { id: task.id, passed: qualityPass, qualityPass, heldOutPass, verificationGate, workspaceIntegrity, taskCompletion, error, durationMs: latencyMs, latencyMs, modelRequests: real ? null : requests - beforeRequests, taskStatus: snapshot?.task?.status ?? snapshot?.outcome, verification: snapshot?.verification?.status, repairs: snapshot?.task?.repairs ?? snapshot?.verification?.attempts, toolCalls: snapshot?.messages?.filter((message) => message.role === 'toolResult').length ?? 0, stats: snapshot?.state ?? null, workspace: project, sessionFile: snapshot?.sessionFile };
    results.push(result); console.log((result.passed ? 'PASS ' : 'FAIL ') + task.id + ' · ' + result.durationMs + 'ms' + (error ? ' · ' + error : ''));
    await writeFile(join(output, task.id + '.json'), JSON.stringify({ ...result, task: snapshot?.task, verification: snapshot?.verification }, null, 2));
  }
} finally { if (mock) await new Promise((done) => { mock.close(done); mock.closeAllConnections(); }); }
const report = { schemaVersion: 2, timestamp: new Date().toISOString(), kind: real ? 'real-model' : 'scripted-smoke', model, workflow, note: real ? 'Small public task suite; results are not a frontier benchmark.' : 'Known solutions are scripted by a local fixture. These results validate tool execution, evidence, completion and evaluation plumbing, not model coding ability.', metrics: { qualityPassRate: results.length ? results.filter((result) => result.qualityPass).length / results.length : 0, heldOutPassRate: results.length ? results.filter((result) => result.heldOutPass).length / results.length : 0, verificationGateRate: results.length ? results.filter((result) => result.verificationGate).length / results.length : 0, workspaceIntegrityRate: results.length ? results.filter((result) => result.workspaceIntegrity).length / results.length : 0, taskCompletionRate: results.length ? results.filter((result) => result.taskCompletion).length / results.length : 0, averageLatencyMs: results.length ? Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length) : 0, totalToolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0), totalRepairs: results.reduce((sum, result) => sum + (result.repairs || 0), 0) }, passed: results.filter((result) => result.passed).length, total: results.length, results };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(report.kind + ': ' + report.passed + '/' + report.total + ' · ' + join(output, 'report.json'));
process.exitCode = report.passed === report.total ? 0 : 1;
