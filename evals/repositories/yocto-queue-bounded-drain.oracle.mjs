// Independent held-out acceptance checks. The evaluator runs this outside the agent workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(process.argv[2]);
const { default: Queue } = await import(pathToFileURL(join(project, 'index.js')).href);
const make = (values) => { const queue = new Queue(); for (const value of values) queue.enqueue(value); return queue; };
const queue = make([1, undefined, 3, 4]);
assert.deepEqual([...queue.drain(0)], []);
assert.equal(queue.size, 4);
const iterator = queue.drain(2);
assert.equal(queue.size, 4, 'drain must remain lazy');
assert.deepEqual(iterator.next(), { value: 1, done: false });
assert.equal(queue.size, 3);
assert.deepEqual(iterator.next(), { value: undefined, done: false });
assert.equal(queue.size, 2);
assert.equal(iterator.next().done, true);
assert.deepEqual([...queue], [3, 4]);
assert.equal(queue.peek(), 3);
const early = queue.drain(Infinity); assert.equal(early.next().value, 3); early.return();
assert.deepEqual([...queue], [4]);
assert.deepEqual([...queue.drain()], [4]); assert.equal(queue.size, 0);
queue.enqueue('after'); assert.equal(queue.peek(), 'after'); assert.equal(queue.dequeue(), 'after'); assert.equal(queue.size, 0);
for (const invalid of [-1, 0.5, NaN, -Infinity]) for (const values of [[], [1, 2]]) {
  const sample = make(values); assert.throws(() => [...sample.drain(invalid)], RangeError); assert.deepEqual([...sample], values); assert.equal(sample.size, values.length);
}
for (const invalid of ['2', null, {}, true]) {
  const sample = make([1, 2]); assert.throws(() => [...sample.drain(invalid)], TypeError); assert.deepEqual([...sample], [1, 2]);
}
assert.deepEqual([...make([1, 2]).drain(100)], [1, 2]);
const dynamic = make([1]), live = dynamic.drain(3); assert.equal(live.next().value, 1); dynamic.enqueue(2); assert.equal(live.next().value, 2); assert.equal(live.next().done, true);

const directory = await mkdtemp(join(tmpdir(), 'forge-queue-oracle-types-'));
try {
  const source = join(directory, 'acceptance.ts');
  await writeFile(source, 'import Queue from ' + JSON.stringify(join(project, 'index.js').replaceAll('\\', '/')) + ';\nconst queue = new Queue<number>();\nconst iterator: IterableIterator<number> = queue.drain(2);\nqueue.drain(); queue.drain(Infinity);\n// @ts-expect-error limit must be numeric\nqueue.drain("2");\nvoid iterator;\n');
  // This browser-neutral declaration needs no ambient Node types. Upstream has
  // no lockfile and may install @types/node newer than its TypeScript compiler.
  const config = join(directory, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2018', module: 'commonjs', types: [] }, files: [source] }));
  try {
    execFileSync(process.execPath, [join(project, 'node_modules', 'typescript', 'lib', 'tsc.js'), '--project', config], { cwd: project, windowsHide: true, timeout: 20000, stdio: 'pipe', encoding: 'utf8' });
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    throw new Error('Public declaration failed external TypeScript acceptance.');
  }
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Held-out bounded lazy drain, queue integrity and declaration checks passed.');
