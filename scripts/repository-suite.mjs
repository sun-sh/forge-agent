import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const command = z.object({ name: z.string().min(1).max(100), command: z.string().min(1).max(10_000), timeoutMs: z.number().int().min(1000).max(600_000).default(120_000) }).strict();
const safePath = z.string().min(1).max(4096).refine((path) => !isAbsolute(path) && !/[\\\0:]/.test(path) && !path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git'));
export const repositorySuiteSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(200),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), source: z.string().min(1).max(4096), revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    prompt: z.string().min(1).max(100_000), setup: z.array(command).max(10).default([]), verify: z.array(command).min(1).max(10),
    oracle: safePath, oracleTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    protected: z.array(safePath).min(1).max(100),
    dirtyFiles: z.record(safePath, z.string().max(1_000_000)).default({})
  }).strict()).min(1).max(100)
}).strict().refine((suite) => new Set(suite.tasks.map((task) => task.id)).size === suite.tasks.length, 'Task ids must be unique');
export async function loadRepositorySuite(path) {
  const file = await realpath(resolve(path)), directory = dirname(file), suite = repositorySuiteSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const oracles = new Map();
  for (const task of suite.tasks) {
    if (/^[a-z][a-z\d+.-]*:/i.test(task.source) && !isAbsolute(task.source) && !/^https:\/\//i.test(task.source)) throw new Error('Repository sources must be local paths or HTTPS URLs');
    const oraclePath = await realpath(resolve(directory, task.oracle)), rest = relative(directory, oraclePath);
    if (rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest)) throw new Error('Oracle must be inside the suite directory');
    const bytes = await readFile(oraclePath); if (bytes.length > 1_000_000) throw new Error('Oracle exceeds 1 MB');
    if (!/\.m?js$/i.test(task.oracle)) throw new Error('Oracle must be a standalone Node .js/.mjs script taking workspace as argv[2]');
    oracles.set(task.id, bytes);
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(suite));
  for (const [id, bytes] of oracles) fingerprint.update(id).update(bytes);
  return { suite, directory, oracles, fingerprint: fingerprint.digest('hex') };
}
