#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { ModelRuntime, SessionManager, VERSION } from '@earendil-works/pi-coding-agent';
import { ForgeSubagents } from '../dist/web/subagents.js';
import { BudgetRuntime, budgetLimitsSchema, DEFAULT_BUDGET_LIMITS } from '../dist/task/budget.js';
import { createExecutionState } from '../dist/task/controller.js';
import { buildReviewHandoff } from '../dist/task/review-handoff.js';
import { parseReview, reviewStop } from '../dist/task/review.js';
import { captureGit, captureReviewPatch, compareGit } from '../dist/task/git.js';
import { captureWorkspace } from '../dist/verification/evidence.js';
import { pforgeHome } from '../dist/pforge-home.js';
import { reviewCases, legacyReviewPrompt } from './review-cases.mjs';
import { evaluationSchedule, reviewConfusion } from './evaluation-protocol.mjs';
import { saveHarnessEvidence, modelEvaluationMetadata } from './evaluation-evidence.mjs';

const args = process.argv.slice(2), real = args.includes('--real'), validateOnly = args.includes('--validate-only');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const modelKey = option('--model', real ? undefined : 'eval/mock'), thinking = option('--thinking', 'medium');
if (real && !modelKey) throw new Error('Use --real --model provider/model [--repeat 3] [--budget path]');
if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking effort');
const repeat = Number(option('--repeat', '1'));
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('repeat must be 1..20');
const processTimeoutMs = Number(option('--process-timeout-ms', '10000'));
if (!Number.isInteger(processTimeoutMs) || processTimeoutMs < 1000 || processTimeoutMs > 120000) throw new Error('process-timeout-ms must be 1000..120000');
const limits = budgetLimitsSchema.parse(option('--budget') ? JSON.parse(await readFile(resolve(option('--budget')), 'utf8')) : DEFAULT_BUDGET_LIMITS);
const configHome = resolve(option('--config-home', pforgeHome())), output = resolve(option('--output', '.forge-agent/reviewer-evals/' + new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'forge-reviewer-eval-')), home = join(root, 'home'); await mkdir(home);
const execute = promisify(execFile), results = [], validation = [];
const selectedCases = option('--case') ? reviewCases.filter((task) => option('--case').split(',').includes(task.id)) : reviewCases;
if (!selectedCases.length) throw new Error('No reviewer cases selected');
const cases = selectedCases.flatMap((task) => ['correct', 'defective'].map((candidate) => ({ ...task, candidate })));
const policies = ['baseline-v1', 'focused-v2'], schedule = evaluationSchedule(cases, policies, repeat);
const suiteFingerprint = createHash('sha256').update(JSON.stringify(selectedCases)).digest('hex');
const harnessFingerprint = await saveHarnessEvidence(output, [import.meta.url, ...[
  './review-cases.mjs', './evaluation-protocol.mjs', './evaluation-evidence.mjs', '../dist/task/review-handoff.js', '../dist/task/review.js',
  '../dist/task/controller.js', '../dist/task/plan.js', '../dist/task/git.js', '../dist/task/budget.js', '../dist/task/review-budget.js', '../dist/web/subagents.js'
].map((path) => new URL(path, import.meta.url))].map((path) => new URL(path)));
const writeFiles = async (project, files) => { for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(project, path)), { recursive: true }); await writeFile(join(project, path), content); } };
let runtime, model, mock, mockTask, fatalError;
const report = () => ({ schemaVersion: 1, protocol: 'paired-candidate-review-v1', kind: validateOnly ? 'oracle-validation' : real ? 'real-model-review-diagnostic' : 'scripted-review-smoke',
  timestamp: new Date().toISOString(), suiteFingerprint, harnessFingerprint, model: modelKey, modelMetadata: model ? modelEvaluationMetadata(model) : undefined,
  thinking, limits, repeat, processTimeoutMs, order: 'counterbalanced-cyclic-v1', environment: { node: process.version, platform: process.platform, piVersion: VERSION }, validation, fatalError,
  byPolicy: Object.fromEntries(policies.map((policy) => {
    const runs = results.filter((run) => run.policy === policy), costKnown = !real || Boolean(model && modelEvaluationMetadata(model).pricingKnown);
    return [policy, { ...reviewConfusion(runs), tokens: runs.reduce((sum, run) => sum + (run.budget?.totalTokens ?? 0), 0),
      outputTokens: runs.reduce((sum, run) => sum + (run.budget?.usage?.output ?? 0), 0), modelTurns: runs.reduce((sum, run) => sum + (run.budget?.modelTurns ?? 0), 0),
      elapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0), promptCharacters: runs.reduce((sum, run) => sum + run.promptCharacters, 0),
      costUsd: costKnown ? runs.reduce((sum, run) => sum + (run.budget?.costUsd ?? 0), 0) : null }];
  })), results,
  note: 'Paired fixed correct/defective candidates. Labels and external oracles never enter reviewer context. baseline-v1 reconstructs the earlier verbose prompt; both policies use the current read-only Pi child runtime and identical budgets. This measures review decisions, not end-to-end coding success.' });
const persist = () => writeFile(join(output, 'report.json'), JSON.stringify(report(), null, 2));
try {
  // Each candidate gets its own process and external oracle before any model request.
  for (const task of cases) {
    const project = join(root, 'validate-' + task.id + '-' + task.candidate); await mkdir(project);
    await writeFiles(project, task.candidate === 'correct' ? task.correctFiles : task.defectiveFiles);
    const imports = 'import assert from "node:assert/strict"; import * as mod from ' + JSON.stringify(pathToFileURL(join(project, task.entry)).href) + ';\n';
    const visible = join(root, 'visible.mjs'), oracle = join(root, 'oracle.mjs');
    await writeFile(visible, imports + task.visible); await writeFile(oracle, imports + task.oracle);
    const pass = async (path) => { try { await execute(process.execPath, [path], { windowsHide: true, timeout: processTimeoutMs }); return true; } catch (e) { if (e.code === 1) return false; throw new Error('Oracle subprocess infrastructure failure: code=' + (e.code ?? 'none') + ', signal=' + (e.signal ?? 'none') + ', killed=' + Boolean(e.killed)); } };
    const visiblePass = await pass(visible), oraclePass = await pass(oracle);
    validation.push({ id: task.id, candidate: task.candidate, visiblePass, oraclePass, valid: visiblePass && oraclePass === (task.candidate === 'correct') });
  }
  await persist();
  if (validation.some((item) => !item.valid)) throw new Error('Candidate oracle validation failed; no model requests were made');
  if (!validateOnly) {
    if (real) for (const name of ['models.json', 'auth.json']) { try { await copyFile(join(configHome, name), join(home, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    else {
      mock = createServer(async (req, res) => {
        for await (const _ of req) { /* fixed local fixture, no model judgment */ }
        const review = { verdict: mockTask.candidate === 'defective' ? 'changes_requested' : 'ready', summary: 'Scripted fixture', issueKinds: mockTask.candidate === 'defective' ? ['code_defect'] : [], issues: mockTask.candidate === 'defective' ? ['Fixture defect'] : [],
          acceptance: mockTask.acceptance.map((item) => ({ id: item.id, status: mockTask.candidate === 'defective' ? 'unmet' : 'met', evidence: 'Scripted fixture evidence' })) };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(review) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      }); await new Promise((done) => mock.listen(0, '127.0.0.1', done));
      await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { eval: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', apiKey: 'fixture-only', models: [{ id: 'mock' }] } } }));
    }
    for (const key of ['FORGE_AGENT_HOME', 'PFORGE_HOME', 'PI_CODING_AGENT_DIR']) process.env[key] = home;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
    runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
    model = (await runtime.getAvailable()).find((item) => item.provider + '/' + item.id === modelKey);
    if (!model) throw new Error('Selected model unavailable');
    for (const { task: candidate, workflow: policy, run, position } of schedule) {
      mockTask = candidate;
      const project = join(root, 'candidate-' + randomUUID()); await mkdir(project);
      await writeFiles(project, candidate.initialFiles);
      const git = (args) => execute('git', args, { cwd: project, windowsHide: true, timeout: processTimeoutMs });
      await git(['init']); await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline']);
      const baseline = await captureGit(project);
      await writeFiles(project, candidate.candidate === 'correct' ? candidate.correctFiles : candidate.defectiveFiles);
      const task = createExecutionState(candidate.prompt, { workflow: 'planned', mode: 'agent' });
      task.requirements = { goal: candidate.prompt, constraints: ['Preserve unrelated files and the public interface'], acceptance: candidate.acceptance, affectedPaths: Object.keys(candidate.correctFiles), unresolved: [] };
      task.brief = { version: 1, intent: 'change', ...task.requirements };
      task.plan = { version: 1, summary: candidate.prompt, constraints: task.requirements.constraints, affectedPaths: task.requirements.affectedPaths, acceptance: candidate.acceptance, steps: ['Implement the requested behavior'] };
      task.verification = { status: 'passed', attempts: 0, report: { passed: true, summary: 'Visible check passed', results: [{ command: 'fixture-visible-check', passed: true, exitCode: 0, output: 'visible assertions passed', durationMs: 1 }] } };
      task.changes = await compareGit(project, baseline);
      const patch = await captureReviewPatch(project, task.changes);
      const prompt = policy === 'focused-v2' ? buildReviewHandoff(task, patch).prompt : legacyReviewPrompt(task, patch);
      const before = await captureWorkspace(project), budget = new BudgetRuntime(limits); budget.start();
      const manager = SessionManager.create(project, join(home, 'sessions'));
      const agents = new ForgeSubagents({ home, project, manager, modelRuntime: runtime, parentModel: () => model, thinkingLevel: () => real ? thinking : 'off', budget: () => budget, allowed: () => false, reviewAllowed: () => true, onChange() {} });
      const started = performance.now(); let review, error, valid = false, blocking;
      try {
        const result = await agents.reviewGate('PFORGE TASK PHASE: review\n' + prompt, new AbortController().signal);
        review = parseReview(result.text);
        const coverage = review?.acceptance?.length === candidate.acceptance.length && new Set(review.acceptance.map((item) => item.id)).size === candidate.acceptance.length && candidate.acceptance.every((item) => review.acceptance.some((finding) => finding.id === item.id));
        valid = Boolean(review && coverage && !review.acceptance.some((item) => item.status === 'unconfirmed') && (review.verdict === 'ready' ? !review.issues.length && review.acceptance.every((item) => item.status === 'met') : review.issues.length));
        blocking = valid ? review.verdict === 'changes_requested' : undefined;
      } catch (e) { error = e.message; }
      finally { await agents.close(); budget.finish(error ? 'aborted' : 'completed'); }
      const after = await captureWorkspace(project), unchanged = Boolean(before.digest && before.digest === after.digest);
      if (!unchanged) { valid = false; error = 'Review modified the candidate workspace'; }
      const record = { id: candidate.id, candidate: candidate.candidate, expectedDefect: candidate.candidate === 'defective', policy, run, position, valid, blocking, unchanged,
        verdict: review?.verdict, reviewStop: review ? reviewStop(review, candidate.acceptance.map((item) => item.id)) : undefined,
        provenance: candidate.provenance ?? 'paired-fixture', error, elapsedMs: Math.round(performance.now() - started), promptCharacters: prompt.length, budget: budget.snapshot() };
      results.push(record);
      await writeFile(join(output, candidate.id + '.' + candidate.candidate + '.' + policy + '.r' + run + '.json'), JSON.stringify({ ...record, review }, null, 2));
      await persist(); console.log(candidate.id + ' · ' + candidate.candidate + ' · ' + policy + ' · ' + (valid ? blocking ? 'blocked' : 'accepted' : 'abstained'));
    }
  }
} catch (e) { fatalError = e.message; }
finally {
  await persist();
  if (mock) { mock.closeAllConnections(); await new Promise((done) => mock.close(done)); }
  // Only this freshly created, task-owned temporary root is removed.
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ protocol: report().protocol, validation: validation.filter((item) => item.valid).length + '/' + validation.length, byPolicy: report().byPolicy, fatalError }));
process.exitCode = fatalError || results.some((run) => !run.valid) ? 1 : 0;
