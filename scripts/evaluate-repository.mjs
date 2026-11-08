#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRepositorySuite } from './repository-suite.mjs';
import { modelEvaluationMetadata, saveEvaluationEvidence, saveHarnessEvidence } from './evaluation-evidence.mjs';

const args = process.argv.slice(2), option = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const suitePath = option('--suite'); if (!suitePath) throw new Error('Use --suite path/to/suite.json --prepare, or --model provider/model --trust-suite [--workflow direct|planned|both] [--repeat N]');
const loaded = await loadRepositorySuite(suitePath), { suite, directory, oracles, fingerprint } = loaded;
const model = option('--model'), workflow = option('--workflow', 'both'), workflows = workflow === 'both' ? ['direct', 'planned'] : [workflow], repeat = Number(option('--repeat', '1'));
const thinking = option('--thinking');
if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
if (workflows.some((item) => !['direct', 'planned'].includes(item)) || !Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('Invalid workflow or repeat (1..20)');
if (args.includes('--prepare')) {
  console.log(JSON.stringify({ suite: suite.name, fingerprint, workflows, repeat, tasks: suite.tasks.map(({ id, source, revision, setup, verify, protected: protectedFiles }) => ({ id, source, revision, setup, verify, protected: protectedFiles })) }, null, 2));
} else {
  if (!model?.includes('/') || !args.includes('--trust-suite')) throw new Error('Running repository code requires explicit --model provider/model and --trust-suite. Review pinned sources, setup/verification commands and oracles first with --prepare.');
  const { ModelRuntime, VERSION } = await import('@earendil-works/pi-coding-agent');
  const { startWebConsole } = await import('../dist/web/server.js');
  const { pforgeHome } = await import('../dist/pforge-home.js');
  const { executeCommand, CommandExecutionError } = await import('../dist/tools/command.js');
  const { loadConfig } = await import('../dist/config.js');
  const { checkpointTarget } = await import('../dist/task/checkpoints.js');
  const { budgetLimitsSchema } = await import('../dist/task/budget.js');
  const budgetFile = option('--budget');
  const limits = budgetLimitsSchema.parse(budgetFile ? JSON.parse(await readFile(resolve(budgetFile), 'utf8')) : { maxDurationMs: 600000, maxModelTurns: 50, maxToolCalls: 300, maxTotalTokens: 750000, maxCostUsd: 2 });
  const sourceHome = resolve(option('--config-home', pforgeHome())), root = await mkdtemp(join(tmpdir(), 'forge-repo-eval-'));
  const output = resolve(option('--output', '.forge-agent/repository-evals/' + new Date().toISOString().replaceAll(':', '-')));
  await mkdir(output, { recursive: true });
  const harnessFingerprint = await saveHarnessEvidence(output, [import.meta.url, ...['./repository-suite.mjs', './evaluation-evidence.mjs', '../dist/task/controller.js', '../dist/task/intent.js', '../dist/web/server.js'].map((path) => new URL(path, import.meta.url))].map((source) => new URL(source)));
  const home = join(root, 'home'); await mkdir(home);
  const execute = promisify(execFile), results = [], startedAt = new Date().toISOString();
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const quoted = (value) => process.platform === 'win32' ? '"' + value.replaceAll('"', '""') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
  const run = async (command, cwd, id, timeoutMs = 120000) => {
    try { return await executeCommand({ command, cwd, timeoutMs, signal: new AbortController().signal, outputDir: join(output, 'logs'), outputId: id }); }
    catch (error) { if (error instanceof CommandExecutionError) return error.result; throw error; }
  };
  let revision;
  try { revision = (await execute('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(); } catch { revision = 'source-archive'; }
  try {
    for (const name of ['models.json', 'auth.json']) {
      try { await copyFile(join(sourceHome, name), join(home, name)); await chmod(join(home, name), 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to prepare isolated model configuration'); }
    }
    process.env.FORGE_AGENT_HOME = home; process.env.PFORGE_HOME = home; process.env.PI_CODING_AGENT_DIR = home; process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
    const runtime = await ModelRuntime.create({ modelsPath: join(home, 'models.json'), authPath: join(home, 'auth.json'), refreshOnCreate: false });
    const selectedModel = (await runtime.getAvailable()).find((item) => item.provider + '/' + item.id === model);
    if (!selectedModel) throw new Error('Selected model is unavailable in the isolated configuration; no tasks have run.');
    const modelMetadata = modelEvaluationMetadata(selectedModel);
    // Explicit per-execution limits; no source sessions, skills, global MCP or extensions are copied.
    await writeFile(join(home, 'web-settings.json'), JSON.stringify({ budget: limits }));
    for (let iteration = 1; iteration <= repeat; iteration++) for (const flow of workflows) for (const task of suite.tasks) {
      const id = `${task.id}.${flow}.r${iteration}`, project = join(root, id), started = performance.now();
      console.log('START ' + id + ' · pinned ' + task.revision.slice(0, 12));
      let gateway, snapshot, evidence, setupMs, executionMs, baselineFails = false, heldOutPass = false, integrity = false, error, infrastructureFailure = false;
      const oraclePath = join(root, id + '.oracle.mjs'); await writeFile(oraclePath, oracles.get(task.id), { mode: 0o600 });
      try {
        const source = /^https:\/\//i.test(task.source) || isAbsolute(task.source) ? task.source : resolve(directory, task.source);
        await execute('git', ['-c', 'core.hooksPath=', 'clone', '--no-local', '--no-hardlinks', '--no-checkout', '--', source, project], { windowsHide: true, timeout: 120000, maxBuffer: 1_000_000 });
        await execute('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', 'checkout', '--detach', task.revision], { cwd: project, windowsHide: true, timeout: 120000 });
        const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: project, windowsHide: true })).stdout.trim();
        if (actual !== task.revision) throw new Error('Pinned revision mismatch');
        for (const [index, setup] of task.setup.entries()) { const result = await run(setup.command, project, id + '.setup-' + index, setup.timeoutMs); if (result.exitCode !== 0 || result.failure) throw new Error('Setup failed: ' + setup.name); }
        for (const [path, content] of Object.entries(task.dirtyFiles)) { const target = await checkpointTarget(project, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
        await writeFile(await checkpointTarget(project, 'forge-agent.json'), JSON.stringify({ verify: task.verify, verifyRetries: 1 }));
        const expectedConfig = JSON.stringify({ verify: task.verify, verifyRetries: 1 });
        const effective = loadConfig(project);
        if (effective.warnings.length || JSON.stringify(effective.config) !== expectedConfig) throw new Error('Repository configuration overrides the suite verification commands');
        const protectedFiles = [...new Set([...task.protected, 'forge-agent.json'])];
        const before = new Map(await Promise.all(protectedFiles.map(async (path) => [path, sha(await readFile(await checkpointTarget(project, path)))])));
        const oracleCommand = quoted(process.execPath) + ' ' + quoted(oraclePath) + ' ' + quoted(project);
        const baseline = await run(oracleCommand, root, id + '.baseline', task.oracleTimeoutMs);
        if (baseline.failure) throw new Error('Baseline oracle infrastructure failed: ' + baseline.failure);
        baselineFails = baseline.exitCode !== 0;
        if (!baselineFails) throw new Error('Invalid task: oracle already passes at the pinned revision');
        setupMs = Math.round(performance.now() - started);
        console.log('READY ' + id + ' · baseline oracle failed as required · setup ' + setupMs + 'ms');
        gateway = await startWebConsole({ cwd: project, port: 0 });
        const origin = new URL(gateway.url).origin;
        const api = async (path, input) => { const response = await fetch(origin + '/api/' + path, { headers: { 'x-pforge-token': gateway.token, 'content-type': 'application/json' }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status); return data; };
        // --trust-suite is the user's explicit authorization for these pinned projects.
        await api('projects/trust', { path: project, trusted: true });
        const session = await api('session', { project, model, mode: 'agent', ...(thinking ? { thinkingLevel: thinking } : {}), title: task.id + ' · ' + flow });
        const executionStarted = performance.now();
        await api('sessions/' + session.id + '/prompt', { message: task.prompt, workflow: flow });
        const deadline = Date.now() + limits.maxDurationMs + 60000;
        let nextProgressAt = Date.now() + 30000;
        do {
          await delay(200); snapshot = await api('sessions/' + session.id);
          if (snapshot.running && Date.now() >= nextProgressAt) {
            console.log('RUNNING ' + id + ' · ' + (snapshot.task?.phase ?? 'implement') + ' · turns ' + (snapshot.budget?.modelTurns ?? 0) + ' · tools ' + (snapshot.budget?.toolCalls ?? 0));
            nextProgressAt = Date.now() + 30000;
          }
          if (Date.now() > deadline) { await api('sessions/' + session.id + '/abort', {}); snapshot = await api('sessions/' + session.id); throw new Error('Execution deadline exceeded'); }
        } while (snapshot.running);
        executionMs = Math.round(performance.now() - executionStarted);
        const evaluated = await run(oracleCommand, root, id + '.oracle', task.oracleTimeoutMs);
        heldOutPass = evaluated.exitCode === 0 && !evaluated.failure;
        integrity = (await Promise.all([...before].map(async ([path, digest]) => sha(await readFile(await checkpointTarget(project, path))) === digest))).every(Boolean)
          && sha(await readFile(oraclePath)) === sha(oracles.get(task.id)) && JSON.stringify(loadConfig(project).config) === expectedConfig;
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); infrastructureFailure = !baselineFails; }
      finally {
        try { if (snapshot) evidence = await saveEvaluationEvidence(output, id, project, snapshot); }
        finally { if (gateway) await gateway.close(); }
      }
      const complete = snapshot?.task ? snapshot.task.status === 'completed' : snapshot?.outcome === 'completed';
      const verification = snapshot?.verification?.status === 'passed';
      const passed = !error && baselineFails && heldOutPass && integrity && complete && verification;
      const result = { id: task.id, workflow: flow, iteration, revision: task.revision, baselineFails, heldOutPass, workspaceIntegrity: integrity, completed: complete, verification, passed, infrastructureFailure, falseCompletion: Boolean(complete && (!heldOutPass || !integrity || !verification)),
        latencyMs: Math.round(performance.now() - started), setupMs, executionMs, thinkingLevel: snapshot?.thinkingLevel, evidence,
        budget: snapshot?.budget, repairs: snapshot?.task?.repairs ?? snapshot?.verification?.attempts, error };
      results.push(result); await writeFile(join(output, id + '.json'), JSON.stringify(result, null, 2));
      console.log((passed ? 'PASS ' : 'FAIL ') + id + (error ? ' · ' + error : ''));
    }
    const latencies = results.map((item) => item.latencyMs).sort((a, b) => a - b);
    const report = { schemaVersion: 2, kind: 'pinned-repository-model-evaluation', suite: suite.name, fingerprint, harnessFingerprint, model, modelMetadata, requestedThinkingLevel: thinking, limits, workflows, repeat, startedAt, gitRevision: revision,
      environment: { pi: VERSION, node: process.version, platform: process.platform },
      note: 'Repository code and oracles run with the launching user permissions. Public test tasks and model self-review do not prove general coding quality.',
      metrics: { passed: results.filter((item) => item.passed).length, total: results.length, falseCompletions: results.filter((item) => item.falseCompletion).length, infrastructureFailures: results.filter((item) => item.infrastructureFailure).length,
        p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)], p95LatencyMs: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
        tokens: results.reduce((sum, item) => sum + (item.budget?.totalTokens || 0), 0), costUsd: modelMetadata.pricingKnown ? results.reduce((sum, item) => sum + (item.budget?.costUsd || 0), 0) : null }, results };
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(join(output, 'report.json')); process.exitCode = results.every((item) => item.passed) ? 0 : 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
