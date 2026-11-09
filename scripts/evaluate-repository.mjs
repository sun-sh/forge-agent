#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { checkoutRepositoryRevision, loadRepositorySuite } from './repository-suite.mjs';
import { modelEvaluationMetadata, saveEvaluationEvidence, saveHarnessEvidence } from './evaluation-evidence.mjs';
import { summarizeWorkflows } from './evaluation-metrics.mjs';

const args = process.argv.slice(2), option = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const suitePath = option('--suite'); if (!suitePath) throw new Error('Use --suite path/to/suite.json --prepare, or --model provider/model --trust-suite [--workflow direct|planned|planned-no-review|both|ablation] [--repeat N]');
const loaded = await loadRepositorySuite(suitePath), { suite, directory, oracles, testPatches, fingerprint } = loaded;
const model = option('--model'), workflow = option('--workflow', 'both'), workflows = workflow === 'ablation' ? ['direct', 'planned', 'planned-no-review'] : workflow === 'both' ? ['direct', 'planned'] : [workflow], repeat = Number(option('--repeat', '1'));
const thinking = option('--thinking');
const validationPath = option('--validation');
function validateCohortArtifact(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Validation cohort must be a JSON object');
  if (candidate.suiteFingerprint !== fingerprint) throw new Error('Validation cohort fingerprint does not match the selected suite');
  const results = candidate.results;
  const expectedIds = suite.tasks.map((task) => task.id), resultIds = Array.isArray(results) ? results.map((item) => item?.id) : [];
  if (candidate.total !== expectedIds.length || resultIds.length !== expectedIds.length || new Set(resultIds).size !== expectedIds.length || resultIds.some((id) => !expectedIds.includes(id))) throw new Error('Validation cohort must contain exactly one result for every suite task');
  if (results.some((item) => typeof item?.valid !== 'boolean')) throw new Error('Validation cohort results must declare valid');
  const valid = results.filter((item) => item.valid).length;
  if (candidate.valid !== valid) throw new Error('Validation cohort valid count does not match its results');
  return candidate;
}
const validation = validationPath ? validateCohortArtifact(JSON.parse(await readFile(resolve(validationPath), 'utf8'))) : undefined;
const validationById = validation ? new Map((validation.results ?? []).map((item) => [item.id, item])) : undefined;
if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
if (workflows.some((item) => !['direct', 'planned', 'planned-no-review'].includes(item)) || !Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('Invalid workflow (direct|planned|planned-no-review|both|ablation) or repeat (1..20)');
if (args.includes('--prepare')) {
  console.log(JSON.stringify({ suite: suite.name, fingerprint, workflows, repeat, tasks: suite.tasks.map(({ id, source, revision, setup, verify, testPatch, protected: protectedFiles }) => ({ id, source, revision, setup, verify, heldOutTestPatch: Boolean(testPatch), protected: protectedFiles })) }, null, 2));
} else {
  if (!model?.includes('/') || !args.includes('--trust-suite')) throw new Error('Running repository code requires explicit --model provider/model and --trust-suite. Review pinned sources, setup/verification commands and oracles first with --prepare.');
  const { ModelRuntime, VERSION } = await import('@earendil-works/pi-coding-agent');
  const { startWebConsole } = await import('../dist/web/server.js');
  const { isVerified } = await import('../dist/verification/pi-extension.js');
  const { pforgeHome } = await import('../dist/pforge-home.js');
  const { executeCommand, CommandExecutionError } = await import('../dist/tools/command.js');
  const { loadConfig } = await import('../dist/config.js');
  const { checkpointTarget } = await import('../dist/task/checkpoints.js');
  const { captureProtectedPaths, compareProtectedPaths } = await import('../dist/verification/protected.js');
  const { budgetLimitsSchema, DEFAULT_BUDGET_LIMITS } = await import('../dist/task/budget.js');
  const budgetFile = option('--budget');
  const limits = budgetLimitsSchema.parse(budgetFile ? JSON.parse(await readFile(resolve(budgetFile), 'utf8')) : DEFAULT_BUDGET_LIMITS);
  const sourceHome = resolve(option('--config-home', pforgeHome())), root = await mkdtemp(join(tmpdir(), 'forge-repo-eval-'));
  const output = resolve(option('--output', '.forge-agent/repository-evals/' + new Date().toISOString().replaceAll(':', '-')));
  await mkdir(output, { recursive: true });
  const harnessFingerprint = await saveHarnessEvidence(output, [import.meta.url, ...['./repository-suite.mjs', './evaluation-evidence.mjs', './evaluation-metrics.mjs', '../dist/config.js', '../dist/task/controller.js', '../dist/task/git.js', '../dist/task/review.js', '../dist/task/plan.js', '../dist/task/timeline.js', '../dist/task/lifecycle.js', '../dist/task/registry.js', '../dist/task/budget.js', '../dist/task/intent.js', '../dist/task/progress.js', '../dist/task/context.js', '../dist/task/queue.js', '../dist/verification/pi-extension.js', '../dist/verification/evidence.js', '../dist/verification/protected.js', '../dist/tools/command.js', '../dist/web/server.js', '../dist/web/subagents.js', '../dist/web/memory.js'].map((path) => new URL(path, import.meta.url))].map((source) => new URL(source)));
  const home = join(root, 'home'); await mkdir(home);
  const execute = promisify(execFile), results = [], startedAt = new Date().toISOString();
  let modelMetadata;
  let revision = 'source-archive';
  let reportWritten = false;
  let fatalError;
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const quoted = (value) => process.platform === 'win32' ? '"' + value.replaceAll('"', '""') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
  const run = async (command, cwd, id, timeoutMs = 120000) => {
    try { return await executeCommand({ command, cwd, timeoutMs, signal: new AbortController().signal, outputDir: join(output, 'logs'), outputId: id }); }
    catch (error) { if (error instanceof CommandExecutionError) return error.result; throw error; }
  };
  const withHeldOutTests = async (project, patchBytes, id, callback) => {
    if (!patchBytes) return callback();
    const patchFile = join(root, id + '.held-out.patch');
    await writeFile(patchFile, patchBytes, { mode: 0o600 });
    try {
      await execute('git', ['apply', '--check', '--whitespace=nowarn', '--', patchFile], { cwd: project, windowsHide: true, timeout: 120000 });
      await execute('git', ['apply', '--whitespace=nowarn', '--', patchFile], { cwd: project, windowsHide: true, timeout: 120000 });
      try { return await callback(); }
      finally { await execute('git', ['apply', '-R', '--whitespace=nowarn', '--', patchFile], { cwd: project, windowsHide: true, timeout: 120000 }); }
    } finally { await rm(patchFile, { force: true }); }
  };
  try { revision = (await execute('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(); } catch { revision = 'source-archive'; }
  const writeReport = async (failure) => {
    const latencies = results.filter((item) => !item.skipped).map((item) => item.latencyMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const metadata = modelMetadata ?? {
      provider: model.split('/')[0], id: model.slice(model.indexOf('/') + 1), api: undefined,
      contextWindow: undefined, pricingKnown: false, configuredPrices: undefined
    };
    const report = { schemaVersion: 2, kind: 'pinned-repository-model-evaluation', suite: suite.name, fingerprint, harnessFingerprint, model, modelMetadata: metadata, requestedThinkingLevel: thinking, limits, workflows, repeat, startedAt, finishedAt: new Date().toISOString(), gitRevision: revision,
      environment: { pi: VERSION, node: process.version, platform: process.platform },
      validation: validation ? { suiteFingerprint: validation.suiteFingerprint, valid: validation.valid, total: validation.total } : undefined,
      byWorkflow: summarizeWorkflows(results, workflows, metadata.pricingKnown),
      note: 'Repository code and oracles run with the launching user permissions. Public test tasks and model review do not prove general coding quality.',
      ...(failure ? { fatalError: failure } : {}),
      metrics: { passed: results.filter((item) => item.passed).length, total: results.length, executed: results.filter((item) => !item.skipped).length, validationSkipped: results.filter((item) => item.skipped).length, falseCompletions: results.filter((item) => item.falseCompletion).length, infrastructureFailures: results.filter((item) => item.infrastructureFailure).length,
        p50LatencyMs: latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : undefined, p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : undefined,
        tokens: results.reduce((sum, item) => sum + (item.budget?.totalTokens || 0), 0), costUsd: metadata.pricingKnown ? results.reduce((sum, item) => sum + (item.budget?.costUsd || 0), 0) : null }, results };
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    reportWritten = true;
    return report;
  };
  try {
    for (const name of ['models.json', 'auth.json']) {
      try { await copyFile(join(sourceHome, name), join(home, name)); await chmod(join(home, name), 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to prepare isolated model configuration'); }
    }
    process.env.FORGE_AGENT_HOME = home; process.env.PFORGE_HOME = home; process.env.PI_CODING_AGENT_DIR = home; process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
    const runtime = await ModelRuntime.create({ modelsPath: join(home, 'models.json'), authPath: join(home, 'auth.json'), refreshOnCreate: false });
    const selectedModel = (await runtime.getAvailable()).find((item) => item.provider + '/' + item.id === model);
    if (!selectedModel) throw new Error('Selected model is unavailable in the isolated configuration; no tasks have run.');
    modelMetadata = modelEvaluationMetadata(selectedModel);
    // Explicit per-execution limits; no source sessions, skills, global MCP or extensions are copied.
    await writeFile(join(home, 'web-settings.json'), JSON.stringify({ budget: limits }));
    for (let iteration = 1; iteration <= repeat; iteration++) for (const flow of workflows) for (const task of suite.tasks) {
      const id = `${task.id}.${flow}.r${iteration}`, project = join(root, id), started = performance.now();
      console.log('START ' + id + ' · pinned ' + task.revision.slice(0, 12));
      const cohortResult = validationById?.get(task.id);
      if (validationById && !cohortResult?.valid) {
        const result = {
          id: task.id, workflow: flow, iteration, revision: task.revision, skipped: true,
          baselineFails: false, heldOutPass: false, workspaceIntegrity: false, completed: false,
          verification: false, passed: false, infrastructureFailure: true, falseCompletion: false,
          latencyMs: 0, error: cohortResult?.error ?? 'Task was not validated by the pinned baseline/reference cohort.'
        };
        results.push(result);
        await writeFile(join(output, id + '.json'), JSON.stringify(result, null, 2));
        console.log('SKIP ' + id + ' · validation cohort did not pass');
        continue;
      }
      let gateway, cleanupProject, snapshot, evidence, setupMs, executionMs, baselineFails = false, heldOutPass = false, integrity = false, error, cleanupError, infrastructureFailure = false;
      const oraclePath = join(root, id + '.oracle.mjs'); await writeFile(oraclePath, oracles.get(task.id), { mode: 0o600 });
      const heldOutPatch = testPatches.get(task.id);
      try {
        const source = /^https:\/\//i.test(task.source) || isAbsolute(task.source) ? task.source : resolve(directory, task.source);
        cleanupProject = await checkoutRepositoryRevision(source, task.revision, project);
        const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: project, windowsHide: true })).stdout.trim();
        if (actual !== task.revision) throw new Error('Pinned revision mismatch');
        for (const [index, setup] of task.setup.entries()) { const result = await run(setup.command, project, id + '.setup-' + index, setup.timeoutMs); if (result.exitCode !== 0 || result.failure) throw new Error('Setup failed: ' + setup.name); }
        for (const [path, content] of Object.entries(task.dirtyFiles)) { const target = await checkpointTarget(project, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
        const protectedFiles = [...new Set([...task.protected, 'forge-agent.json'])];
        const expectedConfig = JSON.stringify({ verify: task.verify, verifyRetries: 1, protect: protectedFiles });
        await writeFile(await checkpointTarget(project, 'forge-agent.json'), expectedConfig);
        const effective = loadConfig(project);
        if (effective.warnings.length || JSON.stringify(effective.config) !== expectedConfig) throw new Error('Repository configuration overrides the suite verification commands');
        const before = await captureProtectedPaths(project, protectedFiles);
        if (!before.complete) throw new Error('Cannot observe initial protected paths: ' + before.reason);
        const oracleCommand = quoted(process.execPath) + ' ' + quoted(oraclePath) + ' ' + quoted(project);
        const baseline = await withHeldOutTests(project, heldOutPatch, id + '.baseline', () => run(oracleCommand, root, id + '.baseline', task.oracleTimeoutMs));
        if (baseline.failure) throw new Error('Baseline oracle infrastructure failed: ' + baseline.failure);
        baselineFails = baseline.exitCode !== 0;
        if (!baselineFails) throw new Error('Invalid task: oracle already passes at the pinned revision');
        setupMs = Math.round(performance.now() - started);
        console.log('READY ' + id + ' · baseline oracle failed as required · setup ' + setupMs + 'ms');
        gateway = await startWebConsole({ cwd: project, port: 0, evaluation: { allowReviewAblation: true } });
        const origin = new URL(gateway.url).origin;
        const api = async (path, input) => { const response = await fetch(origin + '/api/' + path, { headers: { 'x-pforge-token': gateway.token, 'content-type': 'application/json' }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status); return data; };
        // --trust-suite is the user's explicit authorization for these pinned projects.
        await api('projects/trust', { path: project, trusted: true });
        const session = await api('session', { project, model, mode: 'agent', ...(thinking ? { thinkingLevel: thinking } : {}), title: task.id + ' · ' + flow });
        const executionStarted = performance.now();
        await api('sessions/' + session.id + '/prompt', { message: task.prompt, workflow: flow === 'planned-no-review' ? 'planned' : flow, ...(flow === 'planned-no-review' ? { review: false } : {}) });
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
        const evaluated = await withHeldOutTests(project, heldOutPatch, id + '.oracle', () => run(oracleCommand, root, id + '.oracle', task.oracleTimeoutMs));
        heldOutPass = evaluated.exitCode === 0 && !evaluated.failure;
        integrity = compareProtectedPaths(before, await captureProtectedPaths(project, protectedFiles)).status === 'unchanged'
          && sha(await readFile(oraclePath)) === sha(oracles.get(task.id)) && JSON.stringify(loadConfig(project).config) === expectedConfig;
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); infrastructureFailure = !baselineFails; }
      finally {
        try { if (snapshot) evidence = await saveEvaluationEvidence(output, id, project, snapshot); }
        catch (failure) { cleanupError = '保存评测证据失败：' + (failure instanceof Error ? failure.message : String(failure)); }
        try { if (gateway) await gateway.close(); }
        catch (failure) { cleanupError ??= '关闭评测网关失败：' + (failure instanceof Error ? failure.message : String(failure)); }
        // Pi's Windows command backend may finish the model turn before the
        // OS has released the child process cwd. Give the process tree a
        // bounded grace period; cleanup failures remain infrastructure data.
        await delay(process.platform === 'win32' ? 5000 : 0);
        try { if (cleanupProject) await cleanupProject(); }
        catch (failure) { cleanupError ??= '清理评测工作区失败：' + (failure instanceof Error ? failure.message : String(failure)); }
      }
      if (cleanupError) { infrastructureFailure = true; error ??= cleanupError; }
      const complete = snapshot?.task ? snapshot.task.status === 'completed' : snapshot?.outcome === 'completed';
      const verification = isVerified(snapshot?.verification);
      const passed = !error && baselineFails && heldOutPass && integrity && complete && verification;
      const result = { id: task.id, workflow: flow, iteration, revision: task.revision, baselineFails, heldOutPass, workspaceIntegrity: integrity, completed: complete, verification, passed, infrastructureFailure, falseCompletion: Boolean(complete && (!heldOutPass || !integrity || !verification)),
        latencyMs: Math.round(performance.now() - started), setupMs, executionMs, thinkingLevel: snapshot?.thinkingLevel, evidence, cleanupError,
        budget: snapshot?.budget, repairs: snapshot?.task?.repairs ?? snapshot?.verification?.attempts,
        reviewRequired: snapshot?.task?.reviewRequired, reviewCalls: snapshot?.subagents?.filter((child) => child.purpose === 'review_gate').length ?? 0,
        reviewRepairs: snapshot?.task?.phases?.filter((phase, index, phases) => phase.phase === 'implement' && phases[index - 1]?.phase === 'review').length ?? 0,
        reviewFormatRetries: snapshot?.subagents?.filter((child) => child.purpose === 'review_gate').reduce((sum, child) => sum + (child.formatRetries ?? 0), 0) ?? 0, error };
      results.push(result); await writeFile(join(output, id + '.json'), JSON.stringify(result, null, 2));
      console.log((passed ? 'PASS ' : 'FAIL ') + id + (error ? ' · ' + error : ''));
    }
    const report = await writeReport();
    console.log(join(output, 'report.json')); process.exitCode = results.every((item) => item.passed) ? 0 : 1;
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    try { await writeReport(fatalError); console.error(join(output, 'report.json')); }
    catch (reportError) { console.error('评测总报告写入失败：' + (reportError instanceof Error ? reportError.message : String(reportError))); }
    console.error('评测未正常完成：' + fatalError);
    process.exitCode = 1;
  } finally {
    if (!reportWritten) {
      try { await writeReport(fatalError ?? '评测在完成前被中断。'); }
      catch (reportError) { console.error('评测总报告写入失败：' + (reportError instanceof Error ? reportError.message : String(reportError))); }
    }
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) { console.error('评测临时目录清理失败：' + (error instanceof Error ? error.message : String(error))); }
  }
}
