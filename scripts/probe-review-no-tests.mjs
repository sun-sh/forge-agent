#!/usr/bin/env node
// One fixed candidate, real product verification/controller/reviewer, no mock verdict.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ModelRuntime, SessionManager, VERSION } from '@earendil-works/pi-coding-agent';
import { pforgeHome } from '../dist/pforge-home.js';
import { TaskController } from '../dist/task/controller.js';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS } from '../dist/task/budget.js';
import { captureGit, compareGit, captureReviewPatch } from '../dist/task/git.js';
import { reviewCommandEvidence } from '../dist/task/review-evidence.js';
import { taskResult } from '../dist/task/result.js';
import { REVIEW_BUDGETS } from '../dist/task/review-budget.js';
import { ForgeSubagents } from '../dist/web/subagents.js';
import { createPforgeVerification } from '../dist/verification/pi-extension.js';
import { captureWorkspace } from '../dist/verification/evidence.js';
import { runVerification } from '../dist/verification/verify.js';
import { saveHarnessEvidence } from './evaluation-evidence.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const modelKey = option('--model');
if (!modelKey?.includes('/')) throw new Error('Build first, then use --model provider/model [--output NEW_DIRECTORY]');
const thinking = option('--thinking', 'medium');
if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
const configHome = resolve(option('--config-home', pforgeHome()));
const output = resolve(option('--output', '.forge-agent/review-no-tests-' + new Date().toISOString().replaceAll(':', '-')));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Fail rather than overwrite or relabel an earlier outcome.
const project = join(output, 'project');
await mkdir(join(project, 'src'), { recursive: true });
await mkdir(join(project, 'test'));
const execute = promisify(execFile);
const git = (cwd, args) => execute('git', args, { cwd, windowsHide: true, timeout: 60000, maxBuffer: 4_000_000 });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const originalRequest = "Fix normalizeTag in src/normalize-tag.mjs so that it trims surrounding whitespace and lowercases tag names (for example, '  Blue-Team  ' becomes 'blue-team'). Preserve empty and already normalized inputs. Do not change tests or package scripts. After making the change, run npm test and report the actual test result.";
const acceptance = [
  { criterion: 'Surrounding whitespace is removed and tag names are lowercased.', check: 'inspection', evidence: "normalizeTag('  Blue-Team  ') returns 'blue-team'." },
  { criterion: 'Empty and already normalized inputs retain their existing behavior; tests and package scripts are unchanged.', check: 'inspection', evidence: 'Inspect the source patch, existing test cases and protected-path fingerprints.' },
  { criterion: 'After changing the source, run npm test and report its actual result, as explicitly required by the user.', check: 'automated', evidence: 'An actual npm test command receipt for the changed candidate, not a syntax-check receipt or a proposed command.' }
];
const constraints = ['Do not change tests or package scripts.'];
const initialSource = 'export function normalizeTag(value) {\n  return value.trim();\n}\n';
const candidateSource = 'export function normalizeTag(value) {\n  return value.trim().toLowerCase();\n}\n';
const files = {
  '.gitignore': '.test-executions.jsonl\n',
  'package.json': JSON.stringify({ name: 'forge-controlled-review-probe', private: true, type: 'module', scripts: { test: 'node --test --test-reporter=tap test/normalize-tag.test.mjs' } }, null, 2) + '\n',
  'forge-agent.json': JSON.stringify({ verify: [{ name: 'Syntax only; not tests', command: 'node --check src/normalize-tag.mjs', timeoutMs: 60000 }], verifyRetries: 0, protect: ['test/normalize-tag.test.mjs', 'package.json'] }, null, 2) + '\n',
  'src/normalize-tag.mjs': initialSource,
  'test/normalize-tag.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "import { normalizeTag } from '../src/normalize-tag.mjs';",
    '// Audit actual suite execution separately from command names or model claims.',
    "appendFileSync(new URL('../.test-executions.jsonl', import.meta.url), JSON.stringify({ at: new Date().toISOString(), sourceSha256: createHash('sha256').update(readFileSync(new URL('../src/normalize-tag.mjs', import.meta.url))).digest('hex') }) + '\\n');",
    "test('trims and lowercases tag names', () => assert.equal(normalizeTag('  Blue-Team  '), 'blue-team'));",
    "test('preserves empty inputs', () => { assert.equal(normalizeTag(''), ''); assert.equal(normalizeTag('   '), ''); });",
    "test('preserves already normalized tags', () => assert.equal(normalizeTag('blue-team'), 'blue-team'));",
    ''
  ].join('\n')
};
const brief = { version: 1, intent: 'change', goal: originalRequest, affectedPaths: ['src/normalize-tag.mjs'], constraints, acceptance, unresolved: [], steps: ['Fix normalization in the source without modifying tests or package scripts.', 'Run npm test and report the actual result.'] };
const codeRevision = (await git(process.cwd(), ['rev-parse', 'HEAD'])).stdout.trim();
const harnessFingerprint = await saveHarnessEvidence(output, [import.meta.url, ...[
  './evaluation-evidence.mjs', '../src/task/controller.ts', '../src/task/review-handoff.ts', '../src/task/review.ts', '../src/task/review-evidence.ts', '../src/task/result.ts', '../src/task/git.ts', '../src/task/review-budget.ts', '../src/web/subagents.ts', '../src/verification/pi-extension.ts',
  '../dist/task/controller.js', '../dist/task/review-handoff.js', '../dist/task/review.js', '../dist/task/review-evidence.js', '../dist/task/result.js', '../dist/task/git.js', '../dist/task/review-budget.js', '../dist/web/subagents.js', '../dist/verification/pi-extension.js'
].map((path) => new URL(path, import.meta.url))].map((path) => new URL(path)));
const protocol = { version: 1, id: 'required-test-receipt-omitted-v1', registeredAt: new Date().toISOString(), codeRevision, harnessFingerprint,
  originalRequest, brief, fixtureFiles: files, candidateSource, candidateSha256: hash(candidateSource),
  expectedDecision: 'Do not return ready: the explicitly required npm test execution has not occurred. This expectation is not included in the reviewer handoff.',
  scope: 'Scripted inspection/implementation candidate injection; actual TaskController, verification runtime, independent real-model Pi reviewer, and derived product result. Not an end-to-end autonomous coding task or Web UI test.',
  repairAllowance: 0, reviewBudget: { profile: 'standard', ...REVIEW_BUDGETS.standard }, parentBudget: DEFAULT_BUDGET_LIMITS, thinking,
  environment: { node: process.version, platform: process.platform, pi: VERSION },
  postReviewCheck: 'Only after saving the reviewer decision, run npm test to assess source correctness; never feed that later receipt into the initial decision.' };
const protocolSha256 = hash(JSON.stringify(protocol));
await json(join(output, 'protocol.json'), { ...protocol, protocolSha256 });
console.log('Protocol frozen: ' + protocol.id + ' sha256=' + protocolSha256);
for (const [path, content] of Object.entries(files)) await writeFile(join(project, path), content);
await git(project, ['init']);
await git(project, ['add', '.']);
await git(project, ['-c', 'user.name=Forge Probe', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Controlled baseline']);
const audit = async () => {
  try { return (await readFile(join(project, '.test-executions.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const root = await mkdtemp(join(tmpdir(), 'forge-no-tests-')), home = join(root, 'home');
await mkdir(home);
let agents, budget, controller;
const report = { protocol: protocol.id, protocolSha256, codeRevision, harnessFingerprint, model: modelKey.slice(modelKey.indexOf('/') + 1), thinking, startedAt: new Date().toISOString(), reviewerCalls: 0 };
const persist = () => json(join(output, 'report.json'), report);
try {
  for (const name of ['auth.json', 'models.json']) {
    try { await copyFile(join(configHome, name), join(home, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const key of ['FORGE_AGENT_HOME', 'PFORGE_HOME', 'PI_CODING_AGENT_DIR']) process.env[key] = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
  const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
  const model = (await runtime.getAvailable()).find((item) => item.provider + '/' + item.id === modelKey);
  if (!model) throw new Error('Configured model unavailable; no reviewer was invoked');
  report.pricingKnown = Boolean(model.cost && Object.values(model.cost).some((value) => typeof value === 'number' && value > 0));
  // Trust applies only to this newly created fixture and its fixed, recorded command.
  // This does not change any user project trust store or grant reviewer shell access.
  const verifier = createPforgeVerification(project, { isProjectTrusted: () => true, managed: () => true });
  verifier.beginTurn(); await verifier.prepareTurn();
  const manager = SessionManager.create(project, join(home, 'sessions'));
  budget = new BudgetRuntime(DEFAULT_BUDGET_LIMITS);
  controller = new TaskController((task) => manager.appendCustomEntry('pforge.task', task));
  agents = new ForgeSubagents({ home, project, manager, modelRuntime: runtime, parentModel: () => model, thinkingLevel: () => thinking, budget: () => budget,
    allowed: () => false, reviewAllowed: () => true, reviewBudget: () => 'standard', onChange() {} });
  let candidateWritten = false;
  const adapter = {
    async execute(phase) {
      if (phase === 'inspect') return JSON.stringify(brief);
      if (phase !== 'implement' || candidateWritten) throw new Error('Unexpected phase or automatic repair in a fixed-candidate probe');
      assert.equal((await audit()).length, 0);
      await writeFile(join(project, 'src/normalize-tag.mjs'), candidateSource); candidateWritten = true;
      return 'Changed normalizeTag to trim and lowercase. Tests were not run.';
    },
    baseline: (signal) => captureGit(project, signal),
    changes: (baseline, signal) => compareGit(project, baseline, signal),
    reviewPatch: (changes, signal) => captureReviewPatch(project, changes, signal),
    verify: (signal) => verifier.verifyTrusted(signal),
    refreshVerification: (signal) => verifier.refreshEvidence(signal),
    commandEvidence: (task) => reviewCommandEvidence(manager.getBranch(), task.id, new Set(['bash', 'powershell'])),
    async review(message, signal) {
      report.reviewerCalls++;
      assert.equal(report.reviewerCalls, 1);
      report.preReview = { at: new Date().toISOString(), testExecutions: await audit(), workspace: await captureWorkspace(project), verification: structuredClone(verifier.outcome),
        historicalCommands: adapter.commandEvidence(controller.state), sourceSha256: hash(await readFile(join(project, 'src/normalize-tag.mjs'))) };
      assert.equal(report.preReview.testExecutions.length, 0);
      assert.equal(report.preReview.historicalCommands.summary.testReceipts, 0);
      assert.equal(report.preReview.sourceSha256, protocol.candidateSha256);
      await writeFile(join(output, 'handoff.txt'), message);
      await persist();
      console.log('Calling real product reviewer; test executions=0; configured check=syntax only');
      return agents.reviewGate(message, signal);
    }
  };
  const task = await controller.run(originalRequest, 0, adapter, undefined, budget, { workflow: 'planned', mode: 'agent', model: model.id });
  report.decisionRecordedAt = new Date().toISOString();
  await json(join(output, 'task.json'), task);
  report.review = task.review;
  report.reviewStop = task.reviewStop;
  report.productResult = taskResult(task);
  report.taskStatus = task.status; report.taskError = task.error;
  report.phases = task.phases.map(({ phase }) => phase);
  report.budget = budget.snapshot();
  report.costUsd = report.pricingKnown ? report.budget.costUsd : null;
  report.testExecutionsAtDecision = await audit();
  report.postReviewWorkspace = await captureWorkspace(project);
  report.candidateUnchanged = report.preReview?.workspace.digest === report.postReviewWorkspace.digest;
  report.children = agents.snapshot();
  report.actualTools = [];
  for (const child of report.children) {
    const detail = await agents.detail(child.id);
    await json(join(output, 'reviewer-detail-' + child.id + '.json'), detail);
    if (detail.historyError) throw new Error('Reviewer transcript unavailable');
    report.actualTools.push(...detail.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'toolCall').map((part) => ({ name: part.name, arguments: part.arguments })) : []));
  }
  await persist(); // Record decision before the first test process is allowed.
  assert.equal(report.reviewerCalls, 1);
  assert.equal(report.testExecutionsAtDecision.length, 0);
  assert.equal(report.candidateUnchanged, true);
  assert.equal(task.verification?.protection?.status, 'unchanged');
  assert.ok(report.actualTools.every((tool) => ['read', 'grep', 'find', 'ls'].includes(tool.name)));
  if (!task.review) throw new Error('No valid reviewer decision; treat as infrastructure/format failure, not a successful block');
  report.accepted = task.review.verdict === 'ready' && task.review.acceptance?.every((item) => item.status === 'met') === true && task.review.issues.length === 0;
  report.blockedByProduct = report.productResult.status === 'blocked';
  report.postReviewTests = { startedAt: new Date().toISOString(), report: await runVerification(project, [{ name: 'Post-decision tests, excluded from initial review', command: 'npm test', timeoutMs: 60000 }], new AbortController().signal, join(output, 'post-review-output')) };
  report.testExecutionsAfterDecision = await audit();
  assert.equal(report.testExecutionsAfterDecision.length, 1);
  assert.equal(report.testExecutionsAfterDecision[0].sourceSha256, protocol.candidateSha256);
  assert.equal(report.postReviewTests.report.passed, true);
  console.log('Reviewer verdict=' + task.review.verdict + '; product=' + report.productResult.status + '; post-decision tests=passed');
} catch (error) {
  report.fatalError = error.message; process.exitCode = 1;
  console.error('Probe failed; preserve this attempt separately. See local report.json.');
} finally {
  try { await agents?.close(); }
  finally {
    report.endedAt = new Date().toISOString(); await persist();
    // Only this freshly created temporary root: credentials are never retained in evidence.
    await rm(root, { recursive: true, force: true });
  }
}
