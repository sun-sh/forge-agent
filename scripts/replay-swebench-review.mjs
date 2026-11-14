#!/usr/bin/env node
/** Replay four retained upstream candidates, never regenerate patches or run hidden tests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ModelRuntime, SessionManager, VERSION } from '@earendil-works/pi-coding-agent';
import { ForgeSubagents } from '../dist/web/subagents.js';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS } from '../dist/task/budget.js';
import { REVIEW_BUDGETS } from '../dist/task/review-budget.js';
import { buildReviewHandoff } from '../dist/task/review-handoff.js';
import { reviewCommandEvidence } from '../dist/task/review-evidence.js';
import { parseReview, reviewStop, ReviewBudgetExceededError } from '../dist/task/review.js';
import { captureGit, compareGit, captureReviewPatch } from '../dist/task/git.js';
import { captureWorkspace } from '../dist/verification/evidence.js';
import { pforgeHome } from '../dist/pforge-home.js';
import { saveHarnessEvidence } from './evaluation-evidence.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const modelKey = option('--model'), output = option('--output'), sourceRun = option('--source-run'), gradedRun = option('--graded-run');
if (!modelKey?.includes('/') || !output || !sourceRun || !gradedRun) throw new Error('Build first; use --model provider/model --source-run ORIGINAL_RUN_ROOT --graded-run REGRADED_RUN_ROOT --output NEW_DIRECTORY [--prepare-only | --run-prepared]');
const paths = { output: resolve(output), source: resolve(sourceRun), graded: resolve(gradedRun), cache: resolve(option('--cache', '.forge-agent/review-replay-source-cache')) };
const configHome = resolve(option('--config-home', pforgeHome())), thinking = 'medium', repeat = 3;
const ids = ['pallets__flask-4045', 'matplotlib__matplotlib-23563', 'astropy__astropy-6938', 'sympy__sympy-18189'];
const execute = promisify(execFile), sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const load = async (path) => JSON.parse(await readFile(path, 'utf8'));
const digestFile = async (path) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
const git = (root, parameters) => execute('git', ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...parameters], { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 8_000_000 });
const safePath = (root, path) => { const target = resolve(root, path), rel = relative(root, target); if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Artifact path escapes its root'); return target; };
const schedule = Array.from({ length: repeat }, (_, index) => ids.map((_, position) => ({ id: ids[(position + index) % ids.length], run: index + 1, position: position + 1 }))).flat();
const harnessSources = [import.meta.url, ...['./swebench-review-source.py', './evaluation-evidence.mjs', '../src/task/review-handoff.ts', '../src/task/review.ts', '../src/task/review-evidence.ts', '../src/task/git.ts', '../src/task/review-budget.ts', '../src/web/subagents.ts', '../dist/task/review-handoff.js', '../dist/task/review.js', '../dist/task/review-evidence.js', '../dist/task/git.js', '../dist/task/review-budget.js', '../dist/web/subagents.js', '../dist/task/budget.js', '../dist/verification/evidence.js'].map((path) => new URL(path, import.meta.url))].map((path) => new URL(path));
let report, homeRoot;
const persist = () => json(join(paths.output, 'report.json'), report);

async function taskLayer(request) {
  const repository = request.imageRef.slice(0, request.imageRef.lastIndexOf(':'));
  assert.match(repository, /^swebench\/[a-zA-Z0-9_.-]+$/);
  const tokenResponse = await fetch('https://auth.docker.io/token?service=registry.docker.io&scope=repository:' + repository + ':pull', { signal: AbortSignal.timeout(30000) });
  if (!tokenResponse.ok) throw new Error('Anonymous registry authentication failed: ' + tokenResponse.status);
  const { token } = await tokenResponse.json();
  const fetchRegistry = (path, headers = {}) => fetch('https://registry-1.docker.io/v2/' + repository + '/' + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json', ...headers }, signal: AbortSignal.timeout(600000) });
  const manifest = async (ref) => { const response = await fetchRegistry('manifests/' + ref); if (!response.ok) throw new Error('Registry manifest failed: ' + response.status); return { value: await response.json(), digest: response.headers.get('docker-content-digest') }; };
  let selected = await manifest('latest');
  if (selected.value.manifests) {
    const architecture = selected.value.manifests.find((item) => item.platform?.os === 'linux' && item.platform.architecture === 'amd64');
    if (!architecture) throw new Error('No pinned amd64 task image');
    selected = await manifest(architecture.digest);
  }
  assert.equal(selected.value.config.digest, request.imageId, 'Registry tag no longer matches the retained image; never substitute another image');
  // Official task images put their final repository setup in the last substantive layer.
  // The materializer must additionally verify HEAD, all objects, ancestry and the full tree.
  const layer = selected.value.layers.findLast((item) => item.size > 1024);
  if (!layer || layer.size > 1_000_000_000) throw new Error('Unsupported task source layer');
  const prefix = layer.size > 100_000_000, prefixBytes = 16 * 1024 * 1024;
  const path = join(paths.cache, layer.digest.slice(7) + (prefix ? '.prefix.tar.gz' : '.tar.gz'));
  let cached = false;
  try { cached = prefix ? (await stat(path)).size === prefixBytes : await digestFile(path) === layer.digest.slice(7); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!cached) {
    console.log(request.instanceId + ': downloading pinned source ' + (prefix ? 'object prefix (' + prefixBytes : 'layer (' + layer.size) + ' bytes)');
    const response = await fetchRegistry('blobs/' + layer.digest, prefix ? { Range: 'bytes=0-' + (prefixBytes - 1) } : {});
    if (!response.ok) throw new Error('Registry layer failed: ' + response.status);
    if (prefix) assert.equal(response.status, 206, 'Registry did not honor bounded source-prefix request');
    let bytes = 0;
    const bound = prefix ? prefixBytes : layer.size;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) { bytes += chunk.length; done(bytes > bound ? new Error('Task layer exceeds descriptor') : null, chunk); } }), createWriteStream(path));
    assert.equal(bytes, bound);
  }
  if (!prefix) assert.equal(await digestFile(path), layer.digest.slice(7), 'Task layer fingerprint changed');
  return { path, imageId: request.imageId, imageRef: request.imageRef, manifestDigest: selected.digest, layerDigest: layer.digest, layerBytes: layer.size,
    sourceMode: prefix ? 'base-shallow-fetch-plus-verified-loose-objects' : 'full-task-layer', fullLayerVerified: !prefix, downloadedSourceSha256: await digestFile(path), downloadedBytes: (await stat(path)).size };
}

try {
  if (!args.includes('--run-prepared')) {
    await mkdir(paths.output); // A failed attempt cannot overwrite an earlier attempt.
    await mkdir(paths.cache, { recursive: true });
    report = { schemaVersion: 1, protocol: 'retained-upstream-review-replay-v1', startedAt: new Date().toISOString(), results: [], preparation: [],
      codeRevision: (await git(process.cwd(), ['rev-parse', 'HEAD'])).stdout.trim(), model: modelKey.slice(modelKey.indexOf('/') + 1), thinking,
      environment: { node: process.version, platform: process.platform, piVersion: VERSION },
      scope: 'Current handoff and real read-only Pi reviewer on four frozen original candidates; no implementation generation, source/test execution, fresh verification, automatic repair or official regrading.' };
    report.projectRoot = await mkdtemp(join(tmpdir(), 'forge-retained-candidates-'));
    report.harnessFingerprint = await saveHarnessEvidence(paths.output, harnessSources);
    await persist();
    const source = await load(join(paths.source, 'report.json')), graded = await load(join(paths.graded, 'report.json'));
    const published = await load(resolve('docs/evaluations/swebench-ablation-2026-11-12.json'));
    report.sourceReportSha256 = await digestFile(join(paths.source, 'report.json'));
    report.gradedReportSha256 = await digestFile(join(paths.graded, 'report.json'));
    for (const id of ids) {
      const key = id + '.planned.r1', directory = join(paths.source, 'executions', key), project = join(report.projectRoot, id);
      const row = source.results.find((item) => item.instanceId === id && item.workflow === 'planned' && item.run === 1);
      const grade = graded.results.find((item) => item.instanceId === id && item.workflow === 'planned' && item.run === 1);
      const publishedRow = published.arms.planned.results.find((item) => item.instanceId === id && item.run === 1);
      assert.ok(row && grade && publishedRow);
      assert.equal(grade.patchHash, row.patchHash); assert.equal(publishedRow.patchHash, row.patchHash);
      assert.equal(grade.officialResolved, publishedRow.officialResolved);
      assert.equal(await digestFile(join(directory, 'prediction.patch')), row.patchHash);
      assert.equal(row.integrity, true); assert.equal(row.testChanges.length, 0);
      assert.equal(row.completed, ids.indexOf(id) < 2); assert.equal(grade.officialResolved, ids.indexOf(id) >= 2);
      const officialPath = safePath(join(paths.graded, 'executions', key, 'official'), grade.official.officialReport);
      assert.equal((await load(officialPath))[id].resolved, grade.officialResolved);
      const snapshot = await load(join(directory, 'snapshot.json'));
      const request = await load(join(directory, 'controller', 'request.json'));
      const layer = await taskLayer(request);
            const sourceMetadata = join(paths.output, id + '.source.json');
      const publicRepo = { 'pallets__flask-4045': 'pallets/flask', 'matplotlib__matplotlib-23563': 'matplotlib/matplotlib', 'astropy__astropy-6938': 'astropy/astropy', 'sympy__sympy-18189': 'sympy/sympy' }[id];
      await execute(option('--python', 'python'), [fileURLToPath(new URL('./swebench-review-source.py', import.meta.url)), '--layer', layer.path, '--project', project, '--head', row.effectiveHead, '--base', row.baseCommit, '--output', sourceMetadata,
        ...(layer.fullLayerVerified ? [] : ['--source-repo', publicRepo, '--base-cache', join(paths.cache, id + '.git')])], { windowsHide: true, timeout: 900000, maxBuffer: 1_000_000 });
      const tree = await load(sourceMetadata), baseline = await captureGit(project);
      assert.equal(baseline.available, true); assert.equal(baseline.files.length, 0);
      const originalPatch = await readFile(join(directory, 'prediction.patch'), 'utf8');
      const abbreviations = [...new Set([...originalPatch.matchAll(/^index ([a-f0-9]+)\.\.([a-f0-9]+)/gm)].flatMap((match) => [match[1].length, match[2].length]))];
      assert.equal(abbreviations.length, 1, 'Original patch has nonuniform Git object abbreviations');
      // A source-only object database has fewer collisions than the historical
      // repository; preserve its original rendering width, not a changed patch.
      await git(project, ['config', 'core.abbrev', String(abbreviations[0])]);
      await git(project, ['apply', '--check', join(directory, 'prediction.patch')]);
      await git(project, ['apply', '--whitespace=nowarn', join(directory, 'prediction.patch')]);
      const exactPatch = (await git(project, ['diff', '--binary', '--no-ext-diff', '--no-textconv'])).stdout;
      assert.equal(sha(exactPatch), row.patchHash, 'Reconstructed candidate diff is not byte-identical');
      const task = structuredClone(snapshot.task);
      task.changes = await compareGit(project, baseline);
      const patch = await captureReviewPatch(project, task.changes);
      const commands = reviewCommandEvidence(snapshot.entries, task.id, new Set(['bash', 'powershell']));
      // Original successful checks remain historical observations, not a fresh attestation.
      task.verification.reason = 'Historical original-candidate check; not executed on this source-only replay host.';
      if (task.verification.evidence) task.verification.evidence.freshness = 'unconfirmed';
      const handoff = buildReviewHandoff(task, patch, undefined, commands);
      await writeFile(join(paths.output, id + '.handoff.txt'), handoff.prompt);
      const item = { id, sourceKey: key, project, expectedDefect: !grade.officialResolved, originalCompleted: row.completed,
        originalReviewVerdict: snapshot.task.review?.verdict ?? null, originalTaskError: snapshot.task.error ?? null,
        patchHash: row.patchHash, snapshotSha256: await digestFile(join(directory, 'snapshot.json')), officialReportSha256: await digestFile(officialPath),
        baseCommit: row.baseCommit, effectiveHead: row.effectiveHead, sourceTree: tree.tree, sourceFileCount: tree.files.length, symlinkPlaceholders: tree.symlinkPlaceholders, uninitializedSubmodules: tree.uninitializedSubmodules,
        sourceImage: { imageId: layer.imageId, imageRef: layer.imageRef, manifestDigest: layer.manifestDigest, layerDigest: layer.layerDigest, layerBytes: layer.layerBytes,
          sourceMode: layer.sourceMode, fullLayerVerified: layer.fullLayerVerified, downloadedSourceSha256: layer.downloadedSourceSha256, downloadedBytes: layer.downloadedBytes },
        acceptanceIds: task.plan.acceptance.map((entry) => entry.id), commandSummary: commands.summary, handoffSha256: sha(handoff.prompt), handoffCharacters: handoff.characters,
        workspace: await captureWorkspace(project) };
      assert.ok(item.workspace.digest, 'Candidate workspace fingerprint unavailable');
      report.preparation.push(item); await persist();
      console.log(id + ': exact original tree + patch validated; historical receipts=' + commands.summary.receipts);
    }
    report.protocol = { id: 'retained-upstream-review-replay-v1', registeredAt: new Date().toISOString(), codeRevision: report.codeRevision, harnessFingerprint: report.harnessFingerprint,
      cases: report.preparation, schedule, repeat, thinking, model: report.model, reviewBudget: { profile: 'standard', ...REVIEW_BUDGETS.standard }, parentBudget: DEFAULT_BUDGET_LIMITS,
      sourceReportSha256: report.sourceReportSha256, gradedReportSha256: report.gradedReportSha256,
      missingEvidencePolicy: 'insufficient_evidence, incomplete coverage, format failures and budget exhaustion are abstentions, not successful defect detections',
      freshnessPolicy: 'Original configured-check result marked historical/unconfirmed; no check or test is rerun. Historical native command receipts retain original outputs/classification.',
      selection: 'First original Planned repetition for Flask, Matplotlib, Astropy and SymPy, fixed before new model calls. Labels and prior review outcomes excluded from every handoff.',
      order: 'Rotate four-case start position by repetition; serial independent fresh reviewer sessions.' };
    report.protocolSha256 = sha(JSON.stringify(report.protocol));
    await json(join(paths.output, 'protocol.json'), { ...report.protocol, protocolSha256: report.protocolSha256 });
    report.prepared = true; await persist();
  } else {
    report = await load(join(paths.output, 'report.json'));
    assert.equal(report.prepared, true); assert.equal(report.results.length, 0, 'Never replay over recorded model decisions');
    const protocol = await load(join(paths.output, 'protocol.json'));
    const { protocolSha256, ...content } = protocol;
    assert.equal(sha(JSON.stringify(content)), protocolSha256); assert.equal(protocolSha256, report.protocolSha256);
    assert.equal(report.model, modelKey.slice(modelKey.indexOf('/') + 1));
    assert.equal(report.environment.node, process.version);
    for (const source of harnessSources) {
      const name = fileURLToPath(source).split(/[\\/]/).at(-1);
      assert.equal(sha(await readFile(source)), await digestFile(join(paths.output, 'harness', name)), 'Harness changed since preparation');
    }
  }
  if (!args.includes('--prepare-only')) {
    assert.equal(report.preparation.length, 4);
    homeRoot = await mkdtemp(join(tmpdir(), 'forge-retained-review-'));
    const home = join(homeRoot, 'home'); await mkdir(home);
    for (const name of ['models.json', 'auth.json']) {
      try { await copyFile(join(configHome, name), join(home, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const key of ['FORGE_AGENT_HOME', 'PFORGE_HOME', 'PI_CODING_AGENT_DIR']) process.env[key] = home;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
    const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
    const model = (await runtime.getAvailable()).find((item) => item.provider + '/' + item.id === modelKey);
    if (!model) throw new Error('Configured model unavailable');
    report.modelApi = model.api; report.pricingKnown = Object.values(model.cost ?? {}).some((value) => typeof value === 'number' && value > 0);
    report.modelCallsStartedAt = new Date().toISOString(); await persist();
    for (const scheduled of schedule) {
      const candidate = report.preparation.find((item) => item.id === scheduled.id), project = candidate.project;
      const handoff = await readFile(join(paths.output, candidate.id + '.handoff.txt'), 'utf8');
      assert.equal(sha(handoff), candidate.handoffSha256);
      assert.equal((await captureWorkspace(project)).digest, candidate.workspace.digest);
      const budget = new BudgetRuntime(DEFAULT_BUDGET_LIMITS); budget.start();
      const manager = SessionManager.create(project, join(home, 'sessions'));
      const agents = new ForgeSubagents({ home, project, manager, modelRuntime: runtime, parentModel: () => model, thinkingLevel: () => thinking, budget: () => budget,
        allowed: () => false, reviewAllowed: () => true, reviewBudget: () => 'standard', onChange() {} });
      const record = { ...scheduled, expectedDefect: candidate.expectedDefect, startedAt: new Date().toISOString(), tools: [] };
      const started = performance.now();
      console.log('Review ' + (report.results.length + 1) + '/12: ' + candidate.id + ' r' + scheduled.run);
      try {
        const result = await agents.reviewGate('PFORGE TASK PHASE: review\n' + handoff, new AbortController().signal);
        record.review = parseReview(result.text); record.formatRetries = result.formatRetries;
        record.reviewStop = record.review ? reviewStop(record.review, candidate.acceptanceIds) : undefined;
        const acceptance = record.review?.acceptance;
        record.coverage = Boolean(acceptance && acceptance.length === candidate.acceptanceIds.length && new Set(acceptance.map((item) => item.id)).size === acceptance.length && candidate.acceptanceIds.every((id) => acceptance.some((item) => item.id === id)));
        record.decision = !record.coverage ? 'abstained' : record.review?.verdict === 'ready' && !record.review.issues.length && acceptance.every((item) => item.status === 'met') ? 'accepted'
          : record.review?.verdict === 'changes_requested' && (record.review.issues.length > 0 || acceptance.some((item) => item.status === 'unmet')) ? 'defect_blocked' : 'abstained';
      } catch (error) {
        record.error = error.message; record.decision = 'abstained';
        record.reviewFailure = error instanceof ReviewBudgetExceededError ? 'budget_exhausted' : 'review_failed';
      } finally {
        record.children = agents.snapshot();
        for (const child of record.children) {
          const detail = await agents.detail(child.id);
          await json(join(paths.output, candidate.id + '.r' + scheduled.run + '.detail.json'), detail);
          if (detail.historyError) record.evidenceError = detail.historyError;
          record.tools.push(...detail.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'toolCall').map((part) => ({ name: part.name, arguments: part.arguments })) : []));
        }
        await agents.close(); budget.finish(record.error ? 'aborted' : 'completed');
        record.budget = budget.snapshot(); record.elapsedMs = Math.round(performance.now() - started);
      }
      record.unchanged = (await captureWorkspace(project)).digest === candidate.workspace.digest;
      record.readerPathsWithinProject = record.tools.every((tool) => {
        if (!['read', 'grep', 'find', 'ls'].includes(tool.name)) return false;
        try { const argument = JSON.parse(tool.arguments); safePath(project, argument.path ?? '.'); return true; } catch { return false; }
      });
      if (!record.unchanged || !record.readerPathsWithinProject || record.evidenceError) { record.decision = 'abstained'; record.evidenceError ??= 'Candidate changed or reader escaped the candidate root'; }
      report.results.push(record);
      await json(join(paths.output, candidate.id + '.r' + scheduled.run + '.json'), record); await persist();
      console.log(candidate.id + ' r' + scheduled.run + ': ' + record.decision + ' (' + record.budget.modelTurns + ' turns)');
    }
    report.finishedAt = new Date().toISOString();
    report.summary = {
      reviews: report.results.length,
      defectiveAccepted: report.results.filter((item) => item.expectedDefect && item.decision === 'accepted').length,
      defectiveBlocked: report.results.filter((item) => item.expectedDefect && item.decision === 'defect_blocked').length,
      correctAccepted: report.results.filter((item) => !item.expectedDefect && item.decision === 'accepted').length,
      correctBlocked: report.results.filter((item) => !item.expectedDefect && item.decision === 'defect_blocked').length,
      abstained: report.results.filter((item) => item.decision === 'abstained').length,
      requestTokens: report.results.reduce((sum, item) => sum + item.budget.totalTokens, 0),
      outputTokens: report.results.reduce((sum, item) => sum + item.budget.usage.output, 0),
      elapsedMs: report.results.reduce((sum, item) => sum + item.elapsedMs, 0),
      costUsd: report.pricingKnown ? report.results.reduce((sum, item) => sum + item.budget.costUsd, 0) : null
    };
    console.log(JSON.stringify(report.summary));
  }
} catch (error) {
  if (report) { report.fatalError = error.message; report.failedAt = new Date().toISOString(); }
  console.error(error.stack); process.exitCode = 1;
} finally {
  try { if (report) await persist(); }
  finally { if (homeRoot) await rm(homeRoot, { recursive: true, force: true }); }
}
