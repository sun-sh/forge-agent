/** Runs inside an official task image with Forge installed at /opt/forge. No gold/tests/grader are present. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startWebConsole } from '/opt/forge/node_modules/forge-agent/dist/web/server.js';
import { captureProtectedPaths, compareProtectedPaths } from '/opt/forge/node_modules/forge-agent/dist/verification/protected.js';
const execute = promisify(execFile), project = '/testbed', output = '/tmp/forge-output';
const input = JSON.parse(await readFile('/tmp/forge-input.json', 'utf8'));
const git = (args, env = {}) => execute('git', ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { cwd: project, env: { ...process.env, ...env }, timeout: 30000, maxBuffer: 8_000_000 });
const testPath = (path) => /(^|\/)(?:tests?|testing)(\/|$)|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$|(^|\/)conftest\.py$/.test(path);
const internal = ['forge-agent.json', 'pforge.json', 'pforge.yaml', 'pforge.yml', 'forge-agent.yaml', 'forge-agent.yml'];
const tracked = (await git(['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
const expectedHead = input.environmentSetupCommit || input.baseCommit;
if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== expectedHead) throw new Error('Task image checkout does not match environment_setup_commit');
// Reduce directories to avoid thousands of redundant literal protection entries.
const roots = [...new Set(tracked.filter(testPath).map((path) => {
  const parts = path.split('/'), index = parts.findIndex((part) => /^(tests?|testing)$/.test(part));
  return index >= 0 ? parts.slice(0, index + 1).join('/') : path;
}))].sort();
const protectedPaths = [...roots.filter((path, index) => !roots.some((parent, prior) => prior !== index && path.startsWith(parent + '/'))), ...internal];
if (protectedPaths.length > 200) throw new Error('Test protection exceeds host bounds; use a reviewed cohort adaptation');
const syntax = `import py_compile,subprocess,os\npaths=subprocess.check_output(['git','diff','--name-only','-z',${JSON.stringify(expectedHead)}]).decode().split('\\0')+subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z']).decode().split('\\0')\nfor p in sorted(set(paths)):\n if p.endswith('.py') and os.path.isfile(p): py_compile.compile(p,doraise=True)\nprint('Changed Python syntax checked; hidden acceptance remains external.')\n`;
await writeFile('/tmp/forge-visible.py', syntax);
// Existing Forge-specific config in a benchmark repository is an invalid setup, not an override.
for (const path of internal) try { await lstat(join(project, path)); throw new Error('Repository contains evaluator configuration: ' + path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: input.visibleCommand ? 'reviewed-visible-check' : 'changed-python-syntax', command: input.visibleCommand || 'python /tmp/forge-visible.py', timeoutMs: 600000 }], verifyRetries: 1, protect: protectedPaths }));
await writeFile('/tmp/forge-home/web-settings.json', JSON.stringify({ budget: input.limits }));
const before = await captureProtectedPaths(project, protectedPaths);
if (!before.complete) throw new Error('Protection baseline unavailable');
let gateway, snapshot, failure, started;
try {
  gateway = await startWebConsole({ cwd: project, port: 0, evaluation: { allowReviewAblation: true } });
  const origin = new URL(gateway.url).origin;
  const api = async (path, data) => { const response = await fetch(origin + '/api/' + path, { headers: { 'x-pforge-token': gateway.token, 'content-type': 'application/json' }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(120000) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status); return result; };
  await api('projects/trust', { path: project, trusted: true });
  const session = await api('session', { project, model: input.model, thinkingLevel: input.thinking, mode: 'agent' });
  if (session.thinkingLevel !== input.thinking) throw new Error('Requested reasoning effort is unsupported; refusing an unmatched comparison');
  started = performance.now();
  await api('sessions/' + session.id + '/prompt', { message: input.prompt + '\n\nEvaluation policy: implement the issue in the existing repository; preserve existing tests, test configuration and Forge verification configuration. The configured visible check only checks changed Python syntax unless an explicit repository check was supplied. Run any relevant existing tests yourself. Final acceptance is performed externally; do not search for issue solutions or reference patches online.', workflow: input.workflow === 'direct' ? 'direct' : 'planned', ...(input.workflow === 'planned-no-review' ? { review: false } : {}) });
  const deadline = Date.now() + input.limits.maxDurationMs + 60000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    snapshot = await api('sessions/' + session.id);
    if (Date.now() > deadline) { await api('sessions/' + session.id + '/abort', {}); throw new Error('Fixed execution deadline exceeded'); }
  } while (snapshot.running);
} catch (error) { failure = error.message; }
finally { await gateway?.close(); }
const protection = compareProtectedPaths(before, await captureProtectedPaths(project, protectedPaths));
const indexRoot = await mkdtemp('/tmp/forge-patch-index-');
let prediction = '', changed = [], patchError;
try {
  const env = { GIT_INDEX_FILE: join(indexRoot, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  await git(['read-tree', expectedHead], env);
  await git(['add', '-A', '--', '.'], env);
  // Internal config belongs to the harness, never to the submitted prediction.
  await git(['reset', '-q', expectedHead, '--', ...internal], env);
  changed = (await git(['diff', '--cached', '--name-only', '-z', expectedHead], env)).stdout.split('\0').filter(Boolean);
  prediction = (await git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', expectedHead], env)).stdout;
  if (Buffer.byteLength(prediction) > 5_000_000) throw new Error('Prediction exceeds 5 MB');
} catch (error) { patchError = error.message; }
finally { await rm(indexRoot, { recursive: true, force: true }); }
const testChanges = changed.filter(testPath);
const result = { instanceId: input.instanceId, workflow: input.workflow, completed: snapshot?.task?.status === 'completed', taskStatus: snapshot?.task?.status ?? snapshot?.outcome ?? 'failed',
  error: failure || patchError, executionMs: started ? Math.round(performance.now() - started) : null,
  integrity: protection.status === 'unchanged' && !testChanges.length && !patchError,
  protection: protection.status, testChanges, changed, emptyPatch: !prediction.trim(), patchHash: createHash('sha256').update(prediction).digest('hex'),
  budget: snapshot?.budget, thinkingLevel: snapshot?.thinkingLevel, verification: snapshot?.verification?.status,
  reviewCalls: snapshot?.subagents?.filter((child) => child.purpose === 'review_gate').length ?? 0,
  verificationScope: input.visibleCommand ? 'explicit-reviewed-repository-command' : 'changed-python-syntax-only' };
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
await writeFile(join(output, 'prediction.patch'), prediction);
await writeFile(join(output, 'snapshot.json'), JSON.stringify(snapshot ?? null));
console.log(JSON.stringify({ taskStatus: result.taskStatus, executionMs: result.executionMs, integrity: result.integrity }));
