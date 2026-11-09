import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { checkoutRepositoryRevision, loadRepositorySuite } from './repository-suite.mjs';
import { saveHarnessEvidence } from './evaluation-evidence.mjs';
import { CommandExecutionError, executeCommand } from '../dist/tools/command.js';
import { checkpointTarget } from '../dist/task/checkpoints.js';

const args = process.argv.slice(2), option = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const suitePath = option('--suite');
if (!suitePath || !args.includes('--trust-suite')) throw new Error('Use --suite path/to/suite.json --trust-suite [--repeat 3] [--output path]. Review pinned sources, setup commands, reference patches and oracles first. No model is used.');
const loaded = await loadRepositorySuite(suitePath), { suite, directory, oracles, testPatches, referencePatches, fingerprint } = loaded;
const repeat = Number(option('--repeat', '1'));
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('Repeat must be an integer in 1..20.');
const output = resolve(option('--output', '.forge-agent/repository-validation/' + new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const harnessFingerprint = await saveHarnessEvidence(output, [import.meta.url, './repository-suite.mjs', './evaluation-evidence.mjs', '../dist/task/checkpoints.js', '../dist/tools/command.js'].map((path) => new URL(path, import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'forge-repo-validate-')), execute = promisify(execFile), results = [], startedAt = new Date().toISOString();
const quote = (value) => process.platform === 'win32' ? '"' + value.replaceAll('"', '""') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function run(command, cwd, id, timeoutMs) {
  try { return await executeCommand({ command, cwd, timeoutMs, signal: new AbortController().signal, outputDir: join(output, 'logs'), outputId: id }); }
  catch (error) { if (error instanceof CommandExecutionError) return error.result; throw error; }
}
function logEvidence(result) { return { exitCode: result.exitCode, failure: result.failure, durationMs: result.durationMs, log: result.outputPath ? 'logs/' + result.outputPath.split(/[\\/]/).at(-1) : undefined, sha256: result.outputPath ? undefined : sha(result.combined) }; }
async function variant(task, iteration, kind) {
  const id = `${task.id}.${kind}.r${iteration}`, project = join(root, id), oracle = join(root, id + '.oracle.mjs');
  let cleanup;
  const record = { kind, iteration, setup: [] };
  try {
    const source = /^https:\/\//i.test(task.source) || isAbsolute(task.source) ? task.source : resolve(directory, task.source);
    cleanup = await checkoutRepositoryRevision(source, task.revision, project);
    for (const [index, command] of task.setup.entries()) {
      const result = await run(command.command, project, id + '.setup-' + index, command.timeoutMs); record.setup.push(logEvidence(result));
      if (result.exitCode !== 0 || result.failure) throw new Error('Setup failed: ' + command.name);
    }
    for (const [path, content] of Object.entries(task.dirtyFiles)) { const target = await checkpointTarget(project, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
    const apply = async (bytes, suffix) => {
      if (!bytes) return;
      const file = join(root, id + suffix); await writeFile(file, bytes);
      await execute('git', ['-c', 'core.hooksPath=', 'apply', '--check', '--whitespace=nowarn', '--', file], { cwd: project, windowsHide: true, timeout: 120_000 });
      await execute('git', ['-c', 'core.hooksPath=', 'apply', '--whitespace=nowarn', '--', file], { cwd: project, windowsHide: true, timeout: 120_000 });
    };
    if (kind === 'reference') await apply(referencePatches.get(task.id), '.reference.patch');
    await apply(testPatches.get(task.id), '.held-out.patch');
    await writeFile(oracle, oracles.get(task.id), { mode: 0o600 });
    const result = await run(quote(process.execPath) + ' ' + quote(oracle) + ' ' + quote(project), root, id + '.oracle', task.oracleTimeoutMs);
    record.oracle = logEvidence(result);
    if (result.failure || result.exitCode === null) throw new Error(kind + ' oracle infrastructure failure: ' + (result.failure ?? 'no exit code'));
    record.passed = result.exitCode === 0;
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally {
    if (cleanup) { try { await cleanup(); } catch (error) { record.cleanupError = 'Workspace cleanup failed: ' + (error instanceof Error ? error.message : String(error)); } }
  }
  return record;
}
const report = () => ({ schemaVersion: 3, kind: 'pinned-repository-baseline-reference-validation', suite: suite.name, suiteFingerprint: fingerprint, harnessFingerprint, repeat,
  startedAt, finishedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch },
  total: suite.tasks.length, valid: results.filter((result) => result.valid).length, results });
try {
  for (const task of suite.tasks) {
    const item = { id: task.id, revision: task.revision, valid: false, runs: [] };
    if (!referencePatches.has(task.id)) item.error = 'A known-correct referencePatch is required; no code or model was run for this task.';
    else {
      for (let iteration = 1; iteration <= repeat; iteration++) {
        console.log('VALIDATE ' + task.id + ' · r' + iteration);
        const baseline = await variant(task, iteration, 'baseline'), reference = await variant(task, iteration, 'reference');
        item.runs.push({ iteration, baseline, reference });
      }
      item.baselineFails = item.runs.every(({ baseline }) => !baseline.error && !baseline.cleanupError && baseline.passed === false);
      item.referencePasses = item.runs.every(({ reference }) => !reference.error && !reference.cleanupError && reference.passed === true);
      item.valid = item.baselineFails && item.referencePasses;
      item.error = item.valid ? undefined : item.runs.flatMap(({ baseline, reference }) => [baseline.error, reference.error, baseline.cleanupError, reference.cleanupError]).find(Boolean) ?? (!item.baselineFails ? 'Baseline oracle did not fail in every repetition.' : 'Known-correct reference oracle did not pass in every repetition.');
    }
    results.push(item);
    await writeFile(join(output, task.id + '.json'), JSON.stringify(item, null, 2));
    await writeFile(join(output, 'cohort-validation.json'), JSON.stringify(report(), null, 2));
    console.log((item.valid ? 'VALID ' : 'INVALID ') + task.id + (item.error ? ' · ' + item.error : ''));
  }
} finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
await writeFile(join(output, 'cohort-validation.json'), JSON.stringify(report(), null, 2));
console.log('Validated ' + results.filter((result) => result.valid).length + '/' + suite.tasks.length + ' · ' + join(output, 'cohort-validation.json'));
process.exitCode = results.length === suite.tasks.length && results.every((result) => result.valid) ? 0 : 1;
