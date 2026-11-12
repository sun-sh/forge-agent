#!/usr/bin/env node
/** SWE-bench control plane. Official records and grading never enter Forge's agent workspace. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { parseDataset, makeManifest, loadBundle, validateCohort, gradeObservation, summarize, sha256, assertResumeIdentity, canReuseExecution, PROTOCOL, HARNESS_COMMIT } from './swebench-protocol.mjs';
import { evaluationSchedule } from './evaluation-protocol.mjs';
import { startSmokeModel } from './swebench-smoke-model.mjs';
const execute = promisify(execFile), args = process.argv.slice(2), command = args[0];
const option = (key, fallback) => { const index = args.indexOf(key); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value: ' + key); return args[index + 1]; };
const repo = dirname(dirname(fileURLToPath(import.meta.url))), python = option('--python', process.platform === 'win32' ? 'python' : 'python3');
const backend = join(repo, 'scripts/swebench-backend.py'), backendHash = sha256(await readFile(backend));
const trust = () => { if (!args.includes('--trust-suite')) throw new Error('Use --trust-suite after reviewing the frozen cohort and official image provenance'); };
const integer = (key, fallback, min, max) => { const value = Number(option(key, String(fallback))); if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + key); return value; };
const stamp = () => new Date().toISOString().replaceAll(':', '-');
async function save(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = path + '.' + randomUUID() + '.tmp'; try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); } }
async function createOutput(fallback) {
  const path = resolve(option('--output', fallback));
  // Never reuse official logs or overwrite an earlier measurement.
  await mkdir(dirname(path), { recursive: true }); await mkdir(path); return path;
}
async function callBackend(action, input, output, { allowNotReady = false } = {}) {
  await mkdir(output, { recursive: true });
  const inputFile = join(output, 'request.json'), resultFile = join(output, 'backend-result.json');
  await save(inputFile, { action, ...input });
  const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(join(output, 'controller.log'), { flags: 'w', mode: 0o600 }));
  const status = await new Promise((accept, reject) => {
    const child = spawn(python, [backend, inputFile, resultFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { child.kill('SIGTERM'); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.stdout.on('data', (chunk) => { log.write(chunk); if (action === 'validate') process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => log.write(chunk));
    child.once('error', reject); child.once('close', (code, signal) => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); accept({ code, signal }); });
  }).finally(() => new Promise((done) => log.end(done)));
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  if (status.code !== 0 && !allowNotReady) throw new Error(result.error || result.errors?.join('; ') || 'SWE-bench backend failed');
  return result;
}
async function recordCode(output) {
  const sources = ['scripts/swebench-lite.mjs', 'scripts/swebench-protocol.mjs', 'scripts/swebench-backend.py', 'scripts/swebench-agent.mjs', 'scripts/swebench-provider-preflight.mjs', 'scripts/evaluation-protocol.mjs', 'evals/swebench-lite/harness-requirements.txt', 'scripts/download-swebench-lite.py', 'scripts/swebench-smoke-model.mjs'];
  const hash = createHash('sha256'); await mkdir(join(output, 'harness'), { recursive: true });
  for (const path of sources) { const bytes = await readFile(join(repo, path)); hash.update(path).update(bytes); await writeFile(join(output, 'harness', path.replaceAll('/', '__')), bytes); }
  return hash.digest('hex');
}
async function prepare() {
  const bundle = await loadBundle(resolve(option('--bundle', '.forge-agent/swebench-lite-20')));
  console.log(JSON.stringify({ ...bundle.manifest, note: 'Prepared, not evaluated; hidden reference patches and tests remain in private control-plane records.' }, null, 2));
}
async function importCohort() {
  const raw = await readFile(resolve(option('--dataset')), 'utf8'), records = parseDataset(raw);
  const cohort = option('--cohort') ? JSON.parse(await readFile(resolve(option('--cohort')), 'utf8')) : undefined;
  if (cohort && cohort.exportSha256 !== sha256(raw)) throw new Error('Frozen cohort does not match dataset export hash');
  const explicit = option('--instance')?.split(',') ?? cohort?.instances;
  if (cohort && option('--instance')) {
    const allowed = new Set(cohort.instances ?? []);
    if (explicit.some((instanceId) => !allowed.has(instanceId))) throw new Error('Explicit instance is outside the frozen cohort');
  }
  const manifest = makeManifest(records, raw, { count: explicit ? explicit.length : integer('--limit', 20, 1, 300), explicit, seed: option('--seed'), revision: option('--revision', cohort?.datasetRevision) });
  const output = await createOutput('.forge-agent/swebench-lite-20');
  await mkdir(join(output, 'records'));
  for (const task of manifest.tasks) await save(join(output, 'records', task.instanceId + '.json'), records.find((record) => record.instance_id === task.instanceId));
  await save(join(output, 'manifest.json'), manifest);
  console.log(JSON.stringify({ output, fingerprint: manifest.fingerprint, tasks: manifest.tasks.length, repositories: new Set(manifest.tasks.map((task) => task.repo)).size }));
}
async function runValidation() {
  trust(); const bundle = await loadBundle(resolve(option('--bundle', '.forge-agent/swebench-lite-20')));
  const output = await createOutput('.forge-agent/swebench-validation/' + stamp());
  await recordCode(output);
  const readiness = await callBackend('doctor', {}, join(output, 'preflight'), { allowNotReady: true });
  await save(join(output, 'preflight.json'), readiness);
  if (!readiness.ready) { await save(join(output, 'report.json'), { protocol: PROTOCOL, cohortFingerprint: bundle.manifest.fingerprint, infrastructureBlocked: true, scheduled: bundle.manifest.tasks.length, modelCalls: 0, reason: readiness.errors }); process.exitCode = 2; console.log('Infrastructure blocked; no tasks/models run. See ' + join(output, 'report.json')); return; }
  const report = await callBackend('validate', { bundle: bundle.root, output, backendHash, repeat: integer('--repeat', 1, 1, 3), timeout: integer('--timeout', 1800, 60, 7200) }, join(output, 'controller'));
  console.log('Validated ' + report.valid + '/' + report.total + ': ' + join(output, 'cohort-validation.json'));
  if (report.valid !== report.total) process.exitCode = 1;
}
async function buildPackage(output) {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Use npm run eval:swebench so the package command has an npm CLI');
  await execute(process.execPath, [join(repo, 'scripts/build.mjs')], { cwd: repo, windowsHide: true, maxBuffer: 2000000 });
  const packed = await execute(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: repo, windowsHide: true, timeout: 120000, maxBuffer: 2000000 });
  const [metadata] = JSON.parse(packed.stdout), path = join(output, metadata.filename);
  return { path, sha256: sha256(await readFile(path)) };
}
async function runEvaluation() {
  trust();
  if (!option('--model')?.includes('/') || !option('--validation') || !option('--budget')) throw new Error('evaluate requires --model provider/model --validation path --budget path');
  const bundle = await loadBundle(resolve(option('--bundle', '.forge-agent/swebench-lite-20')));
  const validation = JSON.parse(await readFile(resolve(option('--validation')), 'utf8'));
  const valid = validateCohort(validation, bundle.manifest, backendHash);
  const workflow = option('--workflow', 'ablation'), workflows = workflow === 'ablation' ? ['direct', 'planned', 'planned-no-review'] : [workflow];
  if (workflows.some((flow) => !['direct', 'planned', 'planned-no-review'].includes(flow))) throw new Error('Unknown workflow');
  const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).parse(option('--thinking', 'medium'));
  const rawLimits = JSON.parse(await readFile(resolve(option('--budget')), 'utf8'));
  const schedule = evaluationSchedule(bundle.manifest.tasks, workflows, integer('--repeat', 1, 1, 5));
  const resumeRoot = option('--resume-from') ? resolve(option('--resume-from')) : null;
  const previousReport = resumeRoot ? JSON.parse(await readFile(join(resumeRoot, 'report.json'), 'utf8')) : null;
  const output = await createOutput('.forge-agent/swebench-runs/' + stamp());
  const harnessFingerprint = await recordCode(output);
  const report = { protocol: PROTOCOL, cohortFingerprint: bundle.manifest.fingerprint, harnessCommit: HARNESS_COMMIT, harnessFingerprint, backendHash, model: option('--model'), thinking, limits: rawLimits,
    validationFingerprint: sha256(JSON.stringify(validation)), startedAt: new Date().toISOString(), expectedExecutions: schedule.length, validation: { valid: validation.valid, total: validation.total, harness: validation.harness }, workflows,
    schedule: schedule.map((item) => ({ instanceId: item.task.instanceId, workflow: item.workflow, run: item.run, position: item.position })),
    results: [], note: 'Subset ablation using official grading on fresh containers, restricted privileges and test preservation. No full-Lite or competitor claim. Visible checks default to changed-Python syntax, not hidden tests. Network access exists for model/package traffic; solution lookup is prohibited by instruction, not an egress filter.' };
  const persist = async () => save(join(output, 'report.json'), { ...report, byWorkflow: summarize(report.results, workflows), finishedAt: new Date().toISOString() });
  await persist();
  let credentialHome;
  try {
    const readiness = await callBackend('doctor', {}, join(output, 'preflight'), { allowNotReady: true });
    if (!readiness.ready) throw new Error(readiness.errors.join('; '));
    if (readiness.harness.sourceHash !== validation.harness?.sourceHash) throw new Error('Installed official harness differs from validation');
    let packed;
    if (previousReport) {
      assertResumeIdentity(previousReport, report);
      const metadata = JSON.parse(await readFile(join(resumeRoot, 'package-identity.json'), 'utf8'));
      if (!/^[a-zA-Z0-9_.-]+\.tgz$/.test(metadata.filename)) throw new Error('Invalid retained package name');
      const bytes = await readFile(join(resumeRoot, metadata.filename));
      if (sha256(bytes) !== previousReport.packageHash) throw new Error('Retained package fingerprint changed');
      await writeFile(join(output, metadata.filename), bytes);
      packed = { path: join(output, metadata.filename), sha256: previousReport.packageHash };
      report.parentRun = resumeRoot; report.previousAttempts = previousReport.results;
      await save(join(output, 'package-identity.json'), metadata);
    } else {
      packed = await buildPackage(output);
      await save(join(output, 'package-identity.json'), { filename: packed.path.split(/[\\/]/).at(-1), sha256: packed.sha256 });
    }
    report.packageHash = packed.sha256;
    report.visibleCommand = option('--verify-command', null);
    if (previousReport && previousReport.visibleCommand !== report.visibleCommand) throw new Error('Resume visible-check policy mismatch');
    const { budgetLimitsSchema } = await import(pathToFileURL(join(repo, 'dist/task/budget.js')));
    const { pforgeHome } = await import(pathToFileURL(join(repo, 'dist/pforge-home.js')));
    const limits = budgetLimitsSchema.parse(rawLimits), configHome = resolve(option('--config-home', pforgeHome()));
    // Preflight availability with Pi without serializing credential values into reports.
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ modelsPath: join(configHome, 'models.json'), authPath: join(configHome, 'auth.json'), refreshOnCreate: false });
    const model = (await runtime.getAvailable()).find((item) => item.provider + '/' + item.id === report.model);
    if (!model) throw new Error('Selected model unavailable; no alternative selected');
    if (runtime.isUsingOAuth(model.provider)) throw new Error('Benchmark container credentials currently support API-key/keyless providers; configure a dedicated evaluation provider');
    const identity = { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat: model.compat, cost: model.cost, thinkingLevelMap: model.thinkingLevelMap };
    report.modelConfigurationHash = sha256(JSON.stringify(identity));
    if (previousReport && previousReport.modelConfigurationHash !== report.modelConfigurationHash) throw new Error('Resume model/provider configuration mismatch');
    const resolved = await runtime.getAuth(model);
    if (!resolved) throw new Error('Selected provider authentication could not be resolved');
    credentialHome = await mkdtemp(join(tmpdir(), 'forge-swebench-auth-'));
    const original = JSON.parse(await readFile(join(configHome, 'models.json'), 'utf8').catch(() => '{}'));
    const declaration = original.providers?.[model.provider] ?? {};
    const declaredModel = declaration.models?.find((item) => item.id === model.id);
    const selected = declaredModel ?? Object.fromEntries(['id', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost', 'compat', 'thinkingLevelMap'].filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
    await save(join(credentialHome, 'models.json'), { providers: { [model.provider]: { ...declaration, api: model.api, baseUrl: resolved.auth.baseUrl ?? model.baseUrl, apiKey: resolved.auth.apiKey ?? '', headers: { ...declaration.headers, ...resolved.auth.headers }, models: [selected] } } });
    // Only one resolved provider crosses into the worker. The temporary file is never a report artifact.
    report.pricingKnown = Boolean(model.cost && Object.values(model.cost).some((price) => price > 0));
    const node = await callBackend('node-image', previousReport?.nodeImage ? { expected: previousReport.nodeImage } : {}, join(output, 'node-image')); report.nodeImage = node;
    const agentScript = join(repo, 'scripts/swebench-agent.mjs'), agentHash = sha256(await readFile(agentScript));
    for (const entry of schedule) {
      const key = entry.task.instanceId, previous = valid.get(key), runKey = key + '.' + entry.workflow + '.r' + entry.run;
      const result = { instanceId: key, workflow: entry.workflow, run: entry.run, position: entry.position };
      const old = previousReport?.results.find((row) => row.instanceId === key && row.workflow === entry.workflow && row.run === entry.run);
      if (canReuseExecution(old)) { report.results.push({ ...old, reusedFrom: old.reusedFrom ?? resumeRoot }); await persist(); console.log('REUSE ' + runKey); continue; }
      if (!previous.valid) { Object.assign(result, { skipped: true, infrastructureFailure: true, reason: 'baseline_reference_invalid' }); report.results.push(result); await persist(); continue; }
      const executionRoot = join(output, 'executions', runKey); await mkdir(executionRoot, { recursive: true });
      console.log('START ' + runKey);
      try {
        const record = bundle.records.find((row) => row.instance_id === key);
        const agent = await callBackend('agent', { executionId: 'forge-' + randomUUID(), instanceId: key, baseCommit: record.base_commit, environmentSetupCommit: record.environment_setup_commit, prompt: record.problem_statement,
          model: report.model, thinking, workflow: entry.workflow, limits, visibleCommand: option('--verify-command', null),
          package: packed.path, packageHash: packed.sha256, agentScript, agentHash, nodeImageId: node.imageId, nodeImageRef: node.imageRef, imageId: previous.imageId, imageRef: record.image, configHome: credentialHome, output: executionRoot }, join(executionRoot, 'controller'));
        Object.assign(result, agent);
        if (!report.pricingKnown && result.budget) result.budget.costIncomplete = true;
        if (agent.error) {
          Object.assign(result, { infrastructureFailure: true, officialResolved: null, accepted: false, falseCompletion: null, reason: agent.error });
          report.results.push(result); await save(join(executionRoot, 'execution.json'), result); await persist();
          console.log('INFRA ' + runKey + ' · ' + agent.error);
          continue;
        }
        const bytes = await readFile(join(executionRoot, 'prediction.patch'));
        if (sha256(bytes) !== agent.patchHash) throw new Error('Collected prediction fingerprint mismatch');
        await save(join(executionRoot, 'prediction.json'), { instance_id: key, model_name_or_path: 'forge-' + entry.workflow, model_patch: bytes.toString('utf8') });
        const official = await callBackend('grade', { record: join(bundle.root, 'records', key + '.json'), patch: join(executionRoot, 'prediction.patch'), imageId: previous.imageId, output: join(executionRoot, 'official'), timeout: integer('--timeout', 1800, 60, 7200) }, join(executionRoot, 'grading-controller'));
        result.official = official;
        Object.assign(result, gradeObservation({ official, completed: result.completed, integrity: result.integrity, emptyPatch: result.emptyPatch, patchRejected: official.patchRejected === true }));
      } catch (error) { result.infrastructureFailure = true; result.error = error.message; result.officialResolved ??= null; result.falseCompletion ??= null; }
      report.results.push(result); await save(join(executionRoot, 'execution.json'), result); await persist();
      console.log((result.accepted ? 'PASS ' : result.infrastructureFailure ? 'INFRA ' : 'FAIL ') + runKey);
    }
  } catch (error) { report.infrastructureBlocked = true; report.error = error.message; process.exitCode = 2; }
  finally { try { await persist(); } finally { if (credentialHome) await rm(credentialHome, { recursive: true, force: true }); } }
  console.log('Report: ' + join(output, 'report.json'));
  if (!report.infrastructureBlocked && report.results.some((row) => !row.accepted)) process.exitCode = 1;
}
async function runSmoke() {
  trust();
  const bundle = await loadBundle(resolve(option('--bundle')));
  if (bundle.manifest.tasks.length !== 1) throw new Error('The cloud smoke run is limited to exactly one frozen instance');
  const output = await createOutput('.forge-agent/swebench-smoke/' + stamp());
  const identity = await recordCode(output), record = bundle.records[0];
  const summary = { protocol: PROTOCOL, kind: 'official-container-and-scripted-agent-smoke', harnessFingerprint: identity, harnessCommit: HARNESS_COMMIT,
    cohortFingerprint: bundle.manifest.fingerprint, instanceId: record.instance_id, realModelRequests: 0, startedAt: new Date().toISOString(), passed: false,
    note: 'Baseline and gold use official grading. The no-key scripted agent deliberately leaves the issue unresolved; this checks execution/patch/false-completion plumbing, not coding quality.' };
  let fixture, configHome;
  const persist = () => save(join(output, 'summary.json'), { ...summary, finishedAt: new Date().toISOString() });
  await persist();
  try {
    const ready = await callBackend('doctor', {}, join(output, 'preflight'), { allowNotReady: true });
    summary.environment = ready;
    if (!ready.ready) throw new Error(ready.errors.join('; '));
    const validationRoot = join(output, 'validation'); await mkdir(validationRoot);
    const validation = await callBackend('validate', { bundle: bundle.root, output: validationRoot, backendHash, repeat: 1, timeout: integer('--timeout', 600, 60, 1200) }, join(validationRoot, 'controller'));
    summary.validation = validation;
    if (validation.valid !== 1) throw new Error('Baseline/gold did not qualify; scripted agent was not started');
    const validated = validation.results[0];
    const packed = await buildPackage(output); summary.packageHash = packed.sha256;
    const node = await callBackend('node-image', {}, join(output, 'node-image')); summary.nodeImage = node;
    fixture = await startSmokeModel();
    configHome = await mkdtemp(join(tmpdir(), 'forge-swebench-smoke-auth-'));
    await save(join(configHome, 'models.json'), { providers: { 'swebench-fixture': { api: 'openai-completions', apiKey: 'public-synthetic-fixture-key',
      baseUrl: 'http://host.docker.internal:' + fixture.port + '/v1', models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2000, reasoning: false }] } } });
    const executionRoot = join(output, 'execution'); await mkdir(executionRoot);
    const agentScript = join(repo, 'scripts/swebench-agent.mjs');
    const agent = await callBackend('agent', { executionId: 'forge-smoke-' + randomUUID(), instanceId: record.instance_id, baseCommit: record.base_commit, environmentSetupCommit: record.environment_setup_commit,
      prompt: 'Integration fixture only: create forge-smoke.txt containing the fixture marker. Do not modify source code or tests. Do not claim the benchmark issue was repaired.',
      model: 'swebench-fixture/fixture', thinking: 'off', workflow: 'direct', visibleCommand: null,
      limits: { maxDurationMs: 120000, maxModelTurns: 8, maxToolCalls: 12, maxTotalTokens: 0, maxOutputTokens: 4000, maxCostUsd: 1 },
      package: packed.path, packageHash: packed.sha256, agentScript, agentHash: sha256(await readFile(agentScript)), nodeImageId: node.imageId, nodeImageRef: node.imageRef,
      imageId: validated.imageId, imageRef: record.image, configHome, fixtureModelHostGateway: true, output: executionRoot }, join(executionRoot, 'controller'));
    summary.agent = agent; summary.scriptedRequests = fixture.calls();
    const prediction = await readFile(join(executionRoot, 'prediction.patch'));
    if (sha256(prediction) !== agent.patchHash) throw new Error('Scripted prediction fingerprint mismatch');
    const official = await callBackend('grade', { record: join(bundle.root, 'records', record.instance_id + '.json'), patch: join(executionRoot, 'prediction.patch'), imageId: validated.imageId,
      output: join(executionRoot, 'official'), timeout: integer('--timeout', 600, 60, 1200) }, join(executionRoot, 'grading-controller'));
    summary.official = official;
    summary.gates = { baselineFails: validated.baseline.baselineExpectedFailure === true, goldResolves: validated.reference.resolved === true,
      forgeCompleted: agent.completed === true, actualWrite: agent.changed?.includes('forge-smoke.txt') === true && !agent.emptyPatch,
      testsPreserved: agent.integrity === true, issueStillUnresolved: official.valid === true && official.resolved === false,
      falseCompletionDetected: gradeObservation({ official, completed: agent.completed, integrity: agent.integrity, emptyPatch: agent.emptyPatch }).falseCompletion === true,
      boundedFixture: fixture.calls() >= 2 && fixture.calls() <= 8 };
    summary.passed = Object.values(summary.gates).every(Boolean);
    if (!summary.passed) { process.exitCode = 1; summary.error = 'One or more integration gates failed'; }
  } catch (error) { summary.error = error.message; process.exitCode = 1; }
  finally { try { await persist(); } finally { await fixture?.close(); if (configHome) await rm(configHome, { recursive: true, force: true }); } }
  console.log(JSON.stringify({ passed: summary.passed, gates: summary.gates, error: summary.error, summary: join(output, 'summary.json'), realModelRequests: 0 }));
}

const help = `Forge SWE-bench Lite (Linux x86_64 + Docker; fixed official harness)\n\nCommands:\n  import --dataset file.jsonl [--cohort evals/swebench-lite/lite-20.json] --output NEW_DIR\n  prepare --bundle DIR\n  doctor [--python .venv/bin/python]\n  validate --bundle DIR --trust-suite --output NEW_DIR\n  evaluate --bundle DIR --validation FILE --model provider/model --budget FILE --workflow ablation --trust-suite --output NEW_DIR\n\nUse --resume-from PRIOR_OUTPUT to retain assessed successes and failures under identical code/package/budget/cohort identity, retrying only unfinished or infrastructure-failed executions.\nUse --python to select the Python venv with the pinned harness. Gold/test records stay outside the model's clean task container. Each measurement needs a new output directory. See docs/evaluations/swebench-lite-2026-11-10.md.`;
try {
  if (command === 'import') await importCohort();
  else if (command === 'prepare') await prepare();
  else if (command === 'doctor') {
    const output = await createOutput('.forge-agent/swebench-preflight/' + stamp());
    const result = await callBackend('doctor', {}, output, { allowNotReady: true }); console.log(JSON.stringify(result, null, 2)); if (!result.ready) process.exitCode = 2;
  } else if (command === 'smoke') await runSmoke();
  else if (command === 'validate') await runValidation();
  else if (command === 'evaluate') await runEvaluation();
  else { console.log(help); if (command && command !== '--help') process.exitCode = 1; }
} catch (error) { console.error('SWE-bench: ' + error.message); process.exitCode = 1; }
