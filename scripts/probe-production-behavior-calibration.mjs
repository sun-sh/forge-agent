#!/usr/bin/env node
/** Controlled fixed-candidate qualification, NOT autonomous coding/SWE quality.
 * Parent builds first, then runs with --model provider/model --config-home DIR --output NEW_DIR.
 * No build, publication, fallback model, raw-session export, or credential inspection.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { saveHarnessEvidence } from './evaluation-evidence.mjs';

const run = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nl = String.fromCharCode(10), dq = String.fromCharCode(34);
const shell = process.platform === 'win32' ? 'powershell' : 'bash';
const limits = { maxDurationMs: 900000, maxModelTurns: 80, maxToolCalls: 180, maxTotalTokens: 0, maxOutputTokens: 80000, maxCostUsd: 12 };
const contract = '// Public API contract: normalizePoints returns a new array for flat and empty inputs and never mutates its input. Nx1 column arrays must flatten to their values.' + nl;
const initial = contract + 'exports.normalizePoints = values => { if (values.some(Array.isArray)) throw new Error(123); return values.slice(); };' + nl;
const correct = contract + 'exports.normalizePoints = values => values.map(value => Array.isArray(value) ? value[0] : value);' + nl;
const defective = contract + 'exports.normalizePoints = values => { if (values.some(Array.isArray)) throw new TypeError(456); return values.slice(); };' + nl;
const originalRequest = 'Fix normalizePoints in points.cjs: it currently throws for the Nx1 column input [[1],[2]]. It must return [1,2] for [[1],[2]], preserve ordinary flat [1,2] and empty [] inputs, and return new arrays without mutating inputs. Do not alter the existing test or package scripts. Exercise both the reported column case and valid boundary inputs before handing back.';
const brief = { version: 1, intent: 'change', goal: originalRequest, affectedPaths: ['points.cjs'], constraints: ['Do not alter the existing test or package scripts.'], unresolved: [], steps: ['Repair normalization while preserving supported shapes and protected files.'], acceptance: [
  { criterion: 'The reported Nx1 input returns [1,2].', check: 'automated', evidence: 'Execute the public API reproduction.' },
  { criterion: 'Flat and empty inputs remain valid, outputs are new arrays, and inputs remain unchanged.', check: 'automated', evidence: 'Execute boundary assertions and inspect the patch.' }
] };
const files = { 'points.cjs': initial,
  'existing.test.cjs': 'const a=require(' + dq + 'node:assert/strict' + dq + '); const {normalizePoints:n}=require(' + dq + './points.cjs' + dq + '); a.deepEqual(n([1,2]),[1,2]);' + nl,
  'package.json': JSON.stringify({ private: true, scripts: { test: 'node existing.test.cjs' } }) + nl,
  'forge-agent.json': JSON.stringify({ verify: [{ name: 'Syntax only; not behavioral acceptance', command: 'node --check points.cjs', timeoutMs: 60000 }], verifyRetries: 0, protect: ['existing.test.cjs', 'package.json'] }) + nl };
const sq = String.fromCharCode(39);
const requireApi = 'const a=require(' + sq + 'node:assert/strict' + sq + '),{normalizePoints:n}=require(' + sq + './points.cjs' + sq + ');';
const command = code => 'node -e ' + dq + code + dq;
// Deliberately host-injected; never attribute this plan to the real designer.
const controlledPlan = { version: 1, status: 'ready', summary: 'Check column normalization and empty input behavior.', checks: [
  { id: 'B1', kind: 'reproduction', requestQuote: 'It must return [1,2] for [[1],[2]]', expectation: 'Nx1 columns return [1,2].', command: command(requireApi + 'a.deepEqual(n([[1],[2]]),[1,2]);'), shell, timeoutSeconds: 30 },
  { id: 'B2', kind: 'boundary', requestQuote: 'preserve ordinary flat [1,2] and empty [] inputs, and return new arrays without mutating inputs.', expectation: 'Empty input returns the same array object.', command: command(requireApi + 'const input=[];a.strictEqual(n(input),input);'), shell, timeoutSeconds: 30 }
], assumptions: [], unresolved: [] };
const oracle = requireApi + 'for(const input of [[[1],[2]],[1,2],[]]){const saved=JSON.stringify(input),out=n(input);a.deepEqual(out,input.length?[1,2]:[]);a.notEqual(out,input);a.equal(JSON.stringify(input),saved)}';
const specs = [{ id: 'correct', candidate: 'correct' }, { id: 'defective', candidate: 'defective' }, { id: 'controlled-correction', candidate: 'correct', controlled: true }];
// Allows hermetic harness checks without importing Pi or loading configuration.
export const fixtureForChecks = { initial, correct, defective, controlledPlan, originalRequest, oracle };

export function parseOptions(args) {
  const options = {};
  if (args.length === 1 && args[0] === '--help') return { help: true };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--model', '--config-home', '--output'].includes(flag) || Object.hasOwn(options, flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid qualification arguments; use --help.');
    options[flag] = args[++i];
  }
  if (!/^[^\s/\\:]+[/][^\s\\:]+$/.test(options['--model'] ?? '')) throw new Error('Use an explicit --model provider/model; no fallback model is selected.');
  return options;
}
export function redactor(privatePaths) {
  const paths = privatePaths.filter(Boolean).flatMap(path => [path, path.replaceAll(String.fromCharCode(92), '/')]).sort((a, b) => b.length - a.length);
  return value => JSON.stringify(value, (key, item) => {
    if (/^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|baseUrl|endpoint|headers|credentials|signature)$/i.test(key)) return '[redacted]';
    if (typeof item !== 'string') return item;
    let text = item;
    for (const path of paths) { let index; while ((index = text.toLowerCase().indexOf(path.toLowerCase())) !== -1) text = text.slice(0, index) + '[private-path]' + text.slice(index + path.length); }
    return text.replace(/https?:[/][/][^\s"'<>]+/gi, '[private-url]')
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)\b/g, '[redacted]')
      .replace(/((?:api[_-]?key|authorization|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/[A-Za-z]:[\\/](?:Users|home)[\\/][^\s"'<>]+|[/](?:Users|home)[/][^\s"'<>]+/g, '[private-path]');
  }, 2) + nl;
}
const errorInfo = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 4000) });
async function save(path, value, serialize, exclusive = false) {
  const file = await open(path, exclusive ? 'wx' : 'w', 0o600);
  try { await file.writeFile(serialize(value)); await file.sync(); } finally { await file.close(); }
}
function messages(input = []) {
  return input.filter(m => ['user', 'assistant', 'toolResult'].includes(m.role)).map(m => ({ role: m.role, toolName: m.toolName, toolCallId: m.toolCallId, isError: m.isError, content: typeof m.content === 'string' ? m.content : (m.content ?? []).filter(p => ['text', 'toolCall'].includes(p.type)).map(p => p.type === 'toolCall' ? { type: p.type, id: p.id, name: p.name, arguments: p.arguments } : { type: p.type, text: p.text }) }));
}
async function builtFiles(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Code evidence refuses symbolic links.');
    if (entry.isDirectory()) result.push(...await builtFiles(join(directory, entry.name), name + '/'));
    else if (entry.isFile() && /[.](js|mjs|cjs|json|html|css)$/.test(name)) result.push(name);
  }
  return result;
}
async function fingerprint(output, serialize) {
  const built = await builtFiles(join(repository, 'dist'));
  for (const name of ['task/behavior.js', 'task/behavior-correction.js', 'task/behavior-runtime.js', 'task/controller.js', 'web/subagents.js', 'task/result.js', 'task/review-handoff.js']) if (!built.includes(name)) throw new Error('Parent must build missing module: dist/' + name);
  const names = ['scripts/probe-production-behavior-calibration.mjs', 'scripts/evaluation-evidence.mjs', 'package.json', 'package-lock.json', ...built.map(n => 'dist/' + n)].sort();
  const groups = new Map(), manifest = [];
  for (const name of names) { const source = pathToFileURL(join(repository, name)), bytes = await readFile(source), group = dirname(name).replaceAll(String.fromCharCode(92), '/'); manifest.push({ path: name, sha256: sha(bytes), bytes: bytes.length }); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(source); }
  const snapshots = [];
  // The helper uses basenames: separate directories prevent evidence collisions.
  for (const [group, sources] of groups) snapshots.push({ directory: group, fingerprint: await saveHarnessEvidence(join(output, 'code', group), sources) });
  const value = { files: manifest, snapshots }, digest = sha(JSON.stringify(value));
  await save(join(output, 'code-manifest.json'), { ...value, sha256: digest }, serialize, true);
  return { ...value, sha256: digest };
}
async function codeStable(evidence) {
  assert.deepEqual((await builtFiles(join(repository, 'dist'))).map(n => 'dist/' + n).sort(), evidence.files.filter(f => f.path.startsWith('dist/')).map(f => f.path).sort());
  for (const file of evidence.files) assert.equal(sha(await readFile(join(repository, file.path))), file.sha256, 'Code changed during qualification: ' + file.path);
}
export function assertNativeRun(plan, receipts, runId) {
  assert.ok(runId); assert.equal(receipts.length, plan.checks.length);
  for (const check of plan.checks) { const matching = receipts.filter(r => r.runId === runId && r.checkId === check.id && r.tool === check.shell && r.commandSha256 === sha(check.command)); assert.equal(matching.length, 1); const receipt = matching[0]; assert.equal(receipt.source, 'pi-builtin-shell'); assert.ok(Number.isInteger(receipt.exitCode)); assert.equal(receipt.truncated, false); assert.equal(receipt.status, receipt.exitCode === 0 ? 'passed' : 'failed'); assert.ok(receipt.toolCallId); }
}

async function qualify(spec, env) {
  const { output, root, home, model, runtime, api, frozen, report, serialize, persist } = env;
  const record = { ...spec, startedAt: new Date().toISOString(), errors: [], assertions: [], corrections: [] };
  report.results.push(record);
  const directory = join(output, spec.id), project = join(root, 'fixture-' + randomUUID());
  let parent, agents, manager, controller, budget, ready = false, implementations = 0;
  await mkdir(directory, { mode: 0o700 });
  const artifact = (name, value, exclusive = false) => save(join(directory, name), value, serialize, exclusive);
  const fail = (stage, error) => record.errors.push({ stage, ...errorInfo(error) });
  const check = (name, action) => { try { action(); record.assertions.push({ name, passed: true }); } catch (error) { record.assertions.push({ ...errorInfo(error), errorType: error.name, name, passed: false }); } };
  await persist();
  try {
    await mkdir(project, { mode: 0o700 });
    for (const [name, content] of Object.entries(files)) { const file = await open(join(project, name), 'wx', 0o600); try { await file.writeFile(content); } finally { await file.close(); } }
    const git = args => run('git', ['-c', 'core.hooksPath=', ...args], { cwd: project, windowsHide: true, timeout: 60000, maxBuffer: 1000000 });
    await git(['init', '--quiet']); await git(['add', '--', '.']);
    await git(['-c', 'user.name=Qualification Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Controlled baseline']);
    ready = true; manager = api.SessionManager.create(project, join(home, 'sessions'));
    record.parentSessionId = manager.getSessionId(); budget = new api.BudgetRuntime(limits);
    controller = new api.TaskController(task => { manager.appendCustomEntry('pforge.task', task); appendFileSync(join(directory, 'task-events.jsonl'), JSON.stringify(JSON.parse(serialize({ at: new Date().toISOString(), task }))) + nl, { mode: 0o600 }); });
    // Trust only this newly created, script-owned fixture; no trust store bypass
    // for an existing project, and no claim that project trust is an OS sandbox.
    const verifier = api.createPforgeVerification(project, { isProjectTrusted: () => true, managed: () => true });
    verifier.beginTurn(); await verifier.prepareTurn();
    const settingsManager = api.SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [], cacheWarming: 'off' }, { projectTrusted: true });
    const observe = api.behaviorExecutionExtension({ active: () => controller.active && controller.state?.phase === 'check', state: () => controller.state?.behavior, trusted: () => true, record: receipt => controller.recordBehaviorReceipt(receipt) });
    const metering = pi => {
      pi.on('turn_start', (_, ctx) => { if (!budget.recordModelTurn()) ctx.abort(); });
      pi.on('tool_call', () => { if (!budget.recordToolCall()) return { block: true, terminate: true, reason: 'Qualification parent budget exceeded' }; });
      pi.on('message_end', (event, ctx) => { if (event.message.role === 'assistant' && event.message.usage && !budget.recordUsage(event.message.usage, report.pricingKnown)) ctx.abort(); });
      pi.on('before_agent_start', (_, ctx) => budget.setAbort(() => ctx.abort()));
    };
    const loader = new api.DefaultResourceLoader({ cwd: project, agentDir: home, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'], extensionFactories: [{ name: 'qualification-receipts', factory: observe }, { name: 'qualification-budget', factory: metering }] });
    await loader.reload();
    ({ session: parent } = await api.createAgentSession({ cwd: project, agentDir: home, modelRuntime: runtime, model, thinkingLevel: 'medium', settingsManager, sessionManager: manager, resourceLoader: loader, tools: ['read', 'grep', 'find', 'ls', 'bash', 'powershell'] }));
    await parent.bindExtensions({ mode: 'rpc' });
    agents = new api.ForgeSubagents({ home, project, manager, modelRuntime: runtime, parentModel: () => model, thinkingLevel: () => 'medium', budget: () => budget, allowed: () => false, reviewAllowed: () => true, behaviorAllowed: () => true, onChange(children) { appendFileSync(join(directory, 'child-events.jsonl'), JSON.stringify(JSON.parse(serialize({ at: new Date().toISOString(), children }))) + nl, { mode: 0o600 }); } });
    const adapter = {
      async execute(phase, message, _first, signal) {
        if (phase === 'inspect') return JSON.stringify(brief);
        if (phase === 'implement') {
          if (implementations++) throw new Error('Fixed-candidate qualification forbids automatic repairs.');
          record.implementationAdmission = structuredClone(controller.state.behavior);
          const file = await open(join(project, 'points.cjs'), 'w', 0o600); try { await file.writeFile(spec.candidate === 'correct' ? correct : defective); } finally { await file.close(); }
          return 'Harness injected a fixed candidate; this scripted implementation claims no test execution.';
        }
        if (phase !== 'check') throw new Error('Unexpected qualification phase: ' + phase);
        const abort = () => { void parent.abort().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
        try { signal.throwIfAborted(); await parent.prompt(message, { expandPromptTemplates: false }); return parent.getLastAssistantText() ?? ''; } finally { signal.removeEventListener('abort', abort); }
      },
      async behaviorPlan(message, signal) {
        if (spec.controlled) {
          const design = { text: JSON.stringify(controlledPlan), sessionId: randomUUID(), model: 'controlled-fixture/no-model-designer' };
          await artifact('injected-plan.json', { provenance: 'HOST-INJECTED invalid expectation; not an independent model design', plan: controlledPlan, sha256: sha(design.text), design }, true); return design;
        }
        if (!frozen.attempted) {
          frozen.attempted = true; frozen.prompt = message;
          try { frozen.design = await agents.behaviorPlan(message, signal); frozen.plan = api.parseBehaviorPlan(frozen.design.text, originalRequest, shell); } catch (error) { frozen.error = errorInfo(error); }
          frozen.recordedAt = new Date().toISOString(); await save(join(output, 'frozen-design.json'), frozen, serialize, true);
        }
        if (!frozen.design) throw new Error('The single frozen independent design attempt failed; it will not be silently retried.');
        record.frozenPlanSha256 = frozen.plan ? sha(JSON.stringify(frozen.plan)) : undefined; return structuredClone(frozen.design);
      },
      async behaviorCorrection(message, signal) {
        const exchange = { message, startedAt: new Date().toISOString() }; record.corrections.push(exchange);
        await artifact('correction-request-' + record.corrections.length + '.json', exchange, true);
        try { exchange.response = await agents.behaviorCorrection(message, signal); return exchange.response; } catch (error) { exchange.error = errorInfo(error); throw error; }
        finally { exchange.endedAt = new Date().toISOString(); await artifact('correction-response-' + record.corrections.length + '.json', exchange, true); }
      },
      async behaviorCorrectionEvidence(plan, correction, request, signal) {
        const exchange = record.corrections.at(-1); if (!exchange) throw new Error('Source validation requires a real correction child.');
        const validation = exchange.validation = { validator: 'validateBehaviorCorrection', plan: structuredClone(plan), correction: structuredClone(correction), startedAt: new Date().toISOString() };
        await artifact('correction-validation-input-' + record.corrections.length + '.json', validation, true);
        try { validation.evidence = await api.validateBehaviorCorrection(project, plan, correction, request, signal); return validation.evidence; } catch (error) { validation.error = errorInfo(error); throw error; }
        finally { validation.endedAt = new Date().toISOString(); await artifact('correction-validation-' + record.corrections.length + '.json', validation, true); }
      },
      behaviorWorkspace: signal => api.captureWorkspace(project, signal), behaviorShell: shell,
      baseline: signal => api.captureGit(project, signal), changes: (baseline, signal) => api.compareGit(project, baseline, signal), reviewPatch: (changes, signal) => api.captureReviewPatch(project, changes, signal),
      verify: signal => verifier.verifyTrusted(signal), refreshVerification: signal => verifier.refreshEvidence(signal),
      async review(message, signal) { record.reviewHandoff = message; return agents.reviewGate('PFORGE TASK PHASE: review' + nl + message, signal); }
    };
    console.log('Controlled fixed-candidate qualification: ' + spec.id);
    record.task = await controller.run(originalRequest, 0, adapter, undefined, budget, { workflow: 'planned', mode: 'agent', behaviorRequired: true, model: model.id });
  } catch (error) { fail('product-execution', error); }
  finally {
    // All model activity stops before saving the immutable decision and oracle.
    if (agents) { try { await agents.close(); } catch (error) { fail('child-cleanup', error); } }
    if (parent) { try { await parent.abort(); parent.dispose(); } catch (error) { fail('parent-cleanup', error); } }
    record.task ??= controller?.state ? structuredClone(controller.state) : undefined;
    record.children = agents?.snapshot() ?? []; record.budget = budget?.snapshot();
    if (record.task) { try { record.result = api.taskResult(record.task); } catch (error) { fail('product-result', error); } }
    if (ready) { try { record.candidateSha256 = sha(await readFile(join(project, 'points.cjs'))); } catch (error) { fail('candidate-fingerprint', error); } }
    record.decisionRecordedAt = new Date().toISOString();
    await artifact('decision.json', { ...record, productDecisionAvailable: Boolean(record.result), oracle: 'NOT RUN; excluded from all model contexts' }, true);
    record.decisionArtifact = spec.id + '/decision.json'; await persist();
    if (manager) { try { await artifact('parent-messages.json', { messages: messages(manager.buildSessionContext().messages), limitations: 'Thinking/media omitted; paths, URLs, credential-shaped text redacted.' }); } catch (error) { fail('parent-detail', error); } }
    if (agents) for (const child of record.children) {
      try { const detail = await agents.detail(child.id); await artifact(child.purpose + '.' + child.id + '.json', { ...detail, messages: messages(detail.messages), limitations: 'Product detail API bounds history/output; thinking omitted; local redacted diagnostic.' }); } catch (error) { fail('child-detail', error); }
    }
  }
  if (ready) {
    record.oracleStartedAt = new Date().toISOString();
    try { const answer = await run(process.execPath, ['-e', oracle], { cwd: project, windowsHide: true, timeout: 10000, maxBuffer: 64000 }); record.oracle = { passed: true, exitCode: 0, output: answer.stdout }; }
    catch (error) { record.oracle = { passed: false, exitCode: Number.isInteger(error.code) ? error.code : null, output: error.stdout ?? '', error: error.stderr ?? '', diagnostic: errorInfo(error) }; }
    await artifact('oracle.json', { startedAt: record.oracleStartedAt, ...record.oracle }, true);
  }
  const task = record.task, state = task?.behavior, runs = state?.calibration?.runs ?? [];
  check('product execution and evidence retention', () => assert.equal(record.errors.length, 0));
  check('one fixed candidate without repairs', () => { assert.equal(implementations, 1); assert.equal(task.repairs, 0); assert.equal(record.candidateSha256, sha(spec.candidate === 'correct' ? correct : defective)); });
  check('oracle follows immutable decision', () => { assert.ok(record.decisionArtifact); assert.ok(record.oracleStartedAt >= record.decisionRecordedAt); assert.equal(record.oracle?.passed, spec.candidate === 'correct'); });
  check('native parent candidate receipts', () => { assert.equal(state.runPurpose, 'candidate'); assert.ok(state.checkedAt); assert.ok(state.runWorkspace?.digest); assert.equal(state.runWorkspace.digest, state.workspace?.digest); assert.equal(state.runWorkspace.scope, state.workspace?.scope); assertNativeRun(state.plan, state.receipts, state.runId); assert.ok(runs.every(r => r.runId !== state.runId)); });
  check('retained stable preimplementation baseline receipts', () => { assert.ok(runs.length); assert.equal(new Set(runs.map(r => r.runId)).size, runs.length); for (const r of runs) { assert.equal(r.status, 'observed'); assert.ok(r.before.digest); assert.equal(r.before.digest, r.after?.digest); assert.equal(r.before.scope, r.after?.scope); assertNativeRun(r.plan, r.receipts, r.runId); } assert.equal(record.implementationAdmission.calibration.runs.length, runs.length); assert.equal(record.implementationAdmission.calibration.implementationStarted, true); assert.equal(api.behaviorBaselineCurrent(state), true); });
  check('real independent final reviewer', () => { const children = record.children.filter(c => c.purpose === 'review_gate'); assert.equal(children.length, 1); assert.equal(children[0].status, 'completed'); assert.equal(children[0].activation, 1); assert.ok(children[0].budget?.usage?.output > 0); assert.equal(task.reviewer.sessionId, children[0].id); assert.notEqual(task.reviewer.sessionId, record.parentSessionId); });
  check('configured verification and protected inputs', () => { assert.equal(record.result?.checks, 'passed'); assert.equal(task.verification?.protection?.status, 'unchanged'); });
  check('product decision matches candidate, without claiming resolution', () => { assert.equal(record.result?.resolutionClaimed, false); assert.equal(record.result?.behaviorChecks, spec.candidate === 'correct' ? 'passed' : 'failed'); assert.equal(record.result?.status, spec.candidate === 'correct' ? 'implemented_unverified' : 'blocked'); if (spec.candidate === 'correct') { assert.equal(task.status, 'completed'); assert.equal(record.result.modelReview, 'passed'); } else assert.notEqual(task.status, 'completed'); });
  if (!spec.controlled) {
    check('same frozen real independent plan on both candidates', () => { assert.equal(frozen.plan?.status, 'ready'); assert.deepEqual(state.plan, frozen.plan); assert.equal(runs.length, 1); assert.deepEqual(runs[0].plan, frozen.plan); assert.ok(record.corrections.length <= 1); if (record.corrections.length) { assert.equal(state.calibration.correction.status, 'kept'); assert.equal(state.calibration.correction.result.action, 'keep'); assert.equal(record.children.filter(c => c.purpose === 'behavior_correction' && c.status === 'completed').length, 1); } assert.equal(state.designer.sessionId, frozen.design.sessionId); });
    check('exactly one real design attempt, reused without redesign', () => { const designers = record.children.filter(c => c.purpose === 'behavior_plan'); assert.equal(designers.length, spec.id === 'correct' ? 1 : 0); if (designers.length) { assert.equal(designers[0].id, frozen.design.sessionId); assert.equal(designers[0].status, 'completed'); assert.ok(designers[0].budget?.usage?.output > 0); } });
  } else {
    check('fresh real correction child and actual source validation', () => {
      const children = record.children.filter(c => c.purpose === 'behavior_correction'); assert.equal(children.length, 1); const child = children[0]; assert.equal(child.status, 'completed'); assert.equal(child.activation, 1); assert.ok(child.budget?.usage?.output > 0);
      for (const id of [record.parentSessionId, frozen.design?.sessionId, task.reviewer?.sessionId]) assert.notEqual(child.id, id);
      assert.equal(record.corrections.length, 1); assert.equal(record.corrections[0].response?.sessionId, child.id); const validation = record.corrections[0].validation; assert.equal(validation?.validator, 'validateBehaviorCorrection'); assert.ok(validation.endedAt); assert.equal(validation.error, undefined); assert.ok(validation.evidence.some(e => e.checkId === 'B2' && e.path === 'points.cjs' && e.sha256 === sha(initial))); assert.equal(state.calibration.correction.reviewer.sessionId, child.id); assert.equal(state.calibration.correction.status, 'replaced');
    });
    check('retain old and replacement plans/receipts before implementation', () => {
      assert.equal(runs.length, 2); assert.deepEqual(runs[0].plan, controlledPlan); assert.equal(runs[0].receipts.find(r => r.checkId === 'B2')?.status, 'failed'); assert.equal(runs[1].receipts.find(r => r.checkId === 'B2')?.status, 'passed'); assert.equal(runs[0].before.digest, runs[1].before.digest); assert.notEqual(sha(JSON.stringify(runs[0].plan)), sha(JSON.stringify(runs[1].plan))); assert.deepEqual(runs[1].plan, state.plan);
      for (const r of runs) { assert.equal(r.plan.checks[0].command, controlledPlan.checks[0].command); assert.equal(r.receipts.find(receipt => receipt.checkId === 'B1')?.status, 'failed'); }
      const correction = state.calibration.correction; assert.equal(correction.result.findings.find(f => f.id === 'B1')?.kind, 'expected_failure'); assert.equal(correction.result.findings.find(f => f.id === 'B2')?.kind, 'invalid_expectation'); assert.equal(record.implementationAdmission.calibration.correction.status, 'replaced');
      assert.ok(state.calibration.comparisons.some(c => c.checkId === 'B1' && c.outcome === 'changed_to_pass')); assert.ok(state.calibration.comparisons.some(c => c.checkId === 'B2' && c.outcome === 'unchanged_pass'));
    });
    check('public projection retains correction provenance', () => { const calibration = record.result?.behaviorCalibration; assert.equal(calibration?.baseline.status, 'observed'); assert.equal(calibration.baseline.runCount, 2); assert.equal(calibration.correction.status, 'replaced'); assert.equal(calibration.correction.consumed, true); assert.deepEqual(calibration.comparisons, state.calibration.comparisons); });
  }
  record.qualified = !record.errors.length && record.assertions.every(a => a.passed); record.endedAt = new Date().toISOString();
  await artifact('report.json', record); await persist();
  console.log(spec.id + ': qualification=' + (record.qualified ? 'passed' : 'failed') + '; behavior=' + (record.result?.behaviorChecks ?? 'unavailable') + '; result=' + (record.result?.status ?? 'unavailable'));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log('Controlled fixed-candidate qualification; not autonomous coding/SWE quality.' + nl + 'Usage: node scripts/probe-production-behavior-calibration.mjs --model provider/model [--config-home DIRECTORY] [--output NEW_DIRECTORY]' + nl + 'Parent builds first. This driver never builds or publishes; output must be new.'); return; }
  const output = resolve(options['--output'] ?? join(repository, '.forge-agent', 'production-behavior-calibration-' + new Date().toISOString().replaceAll(':', '-')));
  await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
  let root, serialize = redactor([homedir(), repository, output, options['--config-home'] && resolve(options['--config-home'])]);
  const report = { version: 1, protocol: 'production-behavior-calibration-fixed-candidates-v3', startedAt: new Date().toISOString(), status: 'running', scope: 'Controlled fixed-candidate qualification only; not autonomous coding quality, SWE-bench, or a model capability score.', privacy: 'Local diagnostics only. No configuration or raw session export, no automatic publication. Private paths, URLs and credential-shaped strings redacted; thinking omitted. Review tool/model text before sharing.', results: [] };
  const persist = () => save(join(output, 'report.json'), report, serialize);
  const protocol = { version: 1, id: report.protocol, registeredAt: report.startedAt, scope: report.scope, originalRequest, brief, fixtureFiles: files, candidates: { correct, defective }, cases: specs, controlledPlan,
    design: 'One actual independent preimplementation designer attempt frozen verbatim and reused for correct then defective. No redesign or plan replacement qualifies the pair. One normal production diagnosis may keep the identical frozen plan when a boundary legitimately fails before the fix; it cannot replace it for this paired control. Failed design attempts are retained without automatic retry.',
    correction: 'Separate host-injected wrong empty-array identity expectation. A fresh real behaviorCorrection child must diagnose it from actual native baseline receipts and an exact points.cjs contract quote. validateBehaviorCorrection must succeed; old and replacement plans/receipts stay retained.',
    execution: 'Actual TaskController, behaviorExecutionExtension and native parent Pi shell for all baseline/candidate commands; actual ForgeSubagents final reviewer. Candidate pre-run/settled workspace stamps must match. Scripted inspection and candidate injection. No alternative executor for model-proposed commands.',
    oracle: 'Flush immutable per-case decision.json and stop all model activity BEFORE the external oracle. Neither oracle, candidate labels nor qualification expectations enter model context.', oracleCode: oracle,
    trust: 'Only newly created harness-owned fixtures trusted. No user project trust store change; not an OS sandbox.',
    failureRetention: 'Reports, task/child journals, correction requests/responses/validator evidence retained on failures. No overwrite of existing output. Temporary auth/model copies and raw sessions removed in finally.',
    fingerprintScope: 'saveHarnessEvidence snapshots driver/helper/package lock and ALL dist runtime/UI code, grouped by source directory to avoid basename collisions. Compare exact fingerprints before every case and after the run; no inference that dist reflects unbuilt source.',
    environment: { node: process.version, platform: process.platform, expectedPi: '1.4.0' }, thinking: 'medium', shell, limitsPerCase: limits, repetitions: 1, repairAllowance: 0 };
  try {
    await persist(); report.protocolSha256 = sha(JSON.stringify(protocol));
    await save(join(output, 'protocol.json'), { ...protocol, sha256: report.protocolSha256 }, serialize, true);
    const evidence = await fingerprint(output, serialize); report.harnessFingerprint = evidence.sha256; await persist();
    // Delayed imports preserve a report even if the parent's build is absent.
    const modules = await Promise.all([import('@earendil-works/pi-coding-agent'), import('../dist/web/subagents.js'), import('../dist/task/controller.js'), import('../dist/task/budget.js'), import('../dist/task/behavior.js'), import('../dist/task/behavior-correction.js'), import('../dist/task/behavior-runtime.js'), import('../dist/task/result.js'), import('../dist/task/git.js'), import('../dist/verification/evidence.js'), import('../dist/verification/pi-extension.js'), import('../dist/pforge-home.js')]);
    const api = Object.assign({}, ...modules);
    assert.equal(api.VERSION, protocol.environment.expectedPi, 'Pinned Pi runtime required');
    assert.equal(typeof api.validateBehaviorCorrection, 'function', 'Build must expose source-backed correction validation');
    const configHome = resolve(options['--config-home'] ?? api.pforgeHome());
    root = await mkdtemp(join(tmpdir(), 'forge-production-calibration-')); await chmod(root, 0o700);
    const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
    serialize = redactor([homedir(), repository, configHome, output, root]);
    for (const name of ['auth.json', 'models.json']) {
      try { await copyFile(join(configHome, name), join(home, name)); await chmod(join(home, name), 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not prepare private temporary model configuration.'); }
    }
    for (const key of ['FORGE_AGENT_HOME', 'PFORGE_HOME', 'PI_CODING_AGENT_DIR']) process.env[key] = home;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
    const runtime = await api.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
    const model = (await runtime.getAvailable()).find(item => item.provider + '/' + item.id === options['--model']);
    if (!model) throw new Error('The selected configured model is unavailable; no fallback was invoked.');
    report.model = { provider: model.provider, id: model.id, api: model.api, pi: api.VERSION };
    report.pricingKnown = Object.values(model.cost ?? {}).some(value => typeof value === 'number' && value > 0);
    const frozen = {};
    for (const spec of specs) {
      await codeStable(evidence);
      try { await qualify(spec, { output, root, home, model, runtime, api, frozen, report, serialize, persist }); }
      catch (error) { const record = report.results.find(item => item.id === spec.id); if (record) { record.errors.push({ stage: 'case-finalization', ...errorInfo(error) }); record.qualified = false; } else report.results.push({ ...spec, qualified: false, errors: [{ stage: 'case-initialization', ...errorInfo(error) }] }); await persist(); }
    }
    await codeStable(evidence); report.codeStable = true;
    report.status = report.results.length === specs.length && report.results.every(item => item.qualified) ? 'passed' : 'failed';
  } catch (error) { report.status = 'failed'; report.fatalError = errorInfo(error); }
  finally {
    if (root) { try { await rm(root, { recursive: true, force: true }); report.temporaryHomeRemoved = true; } catch { report.temporaryHomeRemoved = false; report.cleanupError = 'Private temporary model/session home cleanup failed; no private paths or contents exported.'; report.status = 'failed'; } }
    report.endedAt = new Date().toISOString(); await persist();
  }
  if (report.status !== 'passed') process.exitCode = 1;
  console.log(JSON.stringify({ protocol: report.protocol, status: report.status, harnessFingerprint: report.harnessFingerprint, cases: report.results.map(item => ({ id: item.id, qualified: item.qualified, failedAssertions: item.assertions?.filter(a => !a.passed).map(a => a.name), errorStages: item.errors?.map(e => e.stage) })), fatalError: report.fatalError ? 'See redacted local report.' : undefined }));
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(() => { console.error('Qualification initialization failed. Use --help and a new local output directory. No private configuration or paths printed.'); process.exitCode = 1; });
}
