import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);

async function removeWithRetry(path, attempts = 20) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) { failure = error; await delay(Math.min(2000, 250 * (attempt + 1))); }
  }
  throw failure;
}

const command = z.object({ name: z.string().min(1).max(100), command: z.string().min(1).max(10_000), timeoutMs: z.number().int().min(1000).max(600_000).default(120_000) }).strict();
const safePath = z.string().min(1).max(4096).refine((path) => !isAbsolute(path) && !/[\\\0:]/.test(path) && !path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git'));
export const repositorySuiteSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(200),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), source: z.string().min(1).max(4096), revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    prompt: z.string().min(1).max(100_000), setup: z.array(command).max(10).default([]), verify: z.array(command).min(1).max(10),
    oracle: safePath, oracleTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    // Held-out tests are applied only to the post-model oracle workspace and
    // are removed before the agent workspace is inspected or reported.
    testPatch: safePath.optional(),
    // Used only by the model-free validator, never applied during agent runs.
    referencePatch: safePath.optional(),
    protected: z.array(safePath).min(1).max(100),
    dirtyFiles: z.record(safePath, z.string().max(1_000_000)).default({})
  }).strict()).min(1).max(100)
}).strict().refine((suite) => new Set(suite.tasks.map((task) => task.id)).size === suite.tasks.length, 'Task ids must be unique');

/**
 * Prepare a pinned repository without asking Git to repack every object in a
 * partial source mirror. Local mirrors use a temporary worktree, which keeps
 * the checkout exact while avoiding the promisor-object failure caused by
 * cloning a blob-filtered mirror. Remote sources retain the ordinary clone
 * path. The returned cleanup is idempotent and must be awaited by callers.
 */
export async function checkoutRepositoryRevision(source, revision, project) {
  const isRemote = /^https:\/\//i.test(source);
  if (!isRemote) {
    const localSource = await realpath(resolve(source));
    await execute('git', ['-c', 'core.hooksPath=', '-C', localSource, 'worktree', 'add', '--detach', '--no-checkout', project, revision], { windowsHide: true, timeout: 120_000 });
    try {
      await execute('git', ['-c', 'core.hooksPath=', '-C', project, 'checkout', '--detach', revision], { windowsHide: true, timeout: 120_000 });
    } catch (error) {
      await execute('git', ['-c', 'core.hooksPath=', '-C', localSource, 'worktree', 'remove', '--force', project], { windowsHide: true, timeout: 120_000 }).catch(() => {});
      await removeWithRetry(project);
      throw error;
    }
    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      try { await execute('git', ['-c', 'core.hooksPath=', '-C', localSource, 'worktree', 'remove', '--force', project], { windowsHide: true, timeout: 120_000 }); }
      finally { await removeWithRetry(project); }
    };
  }
  await execute('git', ['-c', 'core.hooksPath=', 'clone', '--no-local', '--no-hardlinks', '--no-checkout', '--', source, project], { windowsHide: true, timeout: 120_000, maxBuffer: 1_000_000 });
  try {
    await execute('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', 'checkout', '--detach', revision], { cwd: project, windowsHide: true, timeout: 120_000 });
  } catch (error) {
    await removeWithRetry(project);
    throw error;
  }
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    await removeWithRetry(project);
  };
}

export async function loadRepositorySuite(path) {
  const file = await realpath(resolve(path)), directory = dirname(file), suite = repositorySuiteSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const oracles = new Map(), testPatches = new Map(), referencePatches = new Map();
  for (const task of suite.tasks) {
    if (/^[a-z][a-z\d+.-]*:/i.test(task.source) && !isAbsolute(task.source) && !/^https:\/\//i.test(task.source)) throw new Error('Repository sources must be local paths or HTTPS URLs');
    const oraclePath = await realpath(resolve(directory, task.oracle)), rest = relative(directory, oraclePath);
    if (rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest)) throw new Error('Oracle must be inside the suite directory');
    const bytes = await readFile(oraclePath); if (bytes.length > 1_000_000) throw new Error('Oracle exceeds 1 MB');
    if (!/\.m?js$/i.test(task.oracle)) throw new Error('Oracle must be a standalone Node .js/.mjs script taking workspace as argv[2]');
    oracles.set(task.id, bytes);
    if (task.testPatch) {
      const patchPath = await realpath(resolve(directory, task.testPatch)), patchRest = relative(directory, patchPath);
      if (patchRest === '..' || patchRest.startsWith('..' + sep) || isAbsolute(patchRest)) throw new Error('Held-out test patch must be inside the suite directory');
      const patchBytes = await readFile(patchPath); if (patchBytes.length > 5_000_000) throw new Error('Held-out test patch exceeds 5 MB');
      testPatches.set(task.id, patchBytes);
    }
    if (task.referencePatch) {
      const referencePath = await realpath(resolve(directory, task.referencePatch)), rest = relative(directory, referencePath);
      if (rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest)) throw new Error('Reference patch must be inside the suite directory');
      const bytes = await readFile(referencePath); if (bytes.length > 5_000_000) throw new Error('Reference patch exceeds 5 MB');
      referencePatches.set(task.id, bytes);
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(suite));
  for (const [id, bytes] of oracles) fingerprint.update(id).update(bytes);
  for (const [id, bytes] of testPatches) fingerprint.update('test-patch:' + id).update(bytes);
  for (const [id, bytes] of referencePatches) fingerprint.update('reference-patch:' + id).update(bytes);
  return { suite, directory, oracles, testPatches, referencePatches, fingerprint: fingerprint.digest('hex') };
}
