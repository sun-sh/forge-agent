import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('accepts a valid drain despite unrelated malformed ambient types, but rejects wrong runtime and declarations', async () => {
  const project = await mkdtemp(join(tmpdir(), 'forge-oracle-regression-'));
  const execute = promisify(execFile), oracle = resolve('evals/repositories/yocto-queue-bounded-drain.oracle.mjs');
  const declaration = 'export default class Queue<T> implements Iterable<T> { enqueue(value:T):void; dequeue():T|undefined; peek():T|undefined; get size():number; drain(limit?:number):IterableIterator<T>; [Symbol.iterator]():IterableIterator<T>; }\n';
  // Deliberately uses an array instead of the target repository's linked list.
  const implementation = 'export default class Queue { values=[]; enqueue(value){this.values.push(value);} dequeue(){return this.values.shift();} peek(){return this.values[0];} get size(){return this.values.length;} *[Symbol.iterator](){yield* this.values;} *drain(limit=Infinity){if(typeof limit!=="number")throw new TypeError();if(limit!==Infinity&&(!Number.isInteger(limit)||limit<0))throw new RangeError();for(let n=0;n<limit&&this.size;n++)yield this.dequeue();} }\n';
  const run = () => execute(process.execPath, [oracle, project], { windowsHide: true, timeout: 30000 });
  try {
    await mkdir(join(project, 'node_modules', '@types', 'broken'), { recursive: true });
    await symlink(resolve('node_modules/typescript'), join(project, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(project, 'node_modules', '@types', 'broken', 'index.d.ts'), 'type UnrelatedBrokenAmbient = ;\n');
    await writeFile(join(project, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(project, 'index.d.ts'), declaration);
    await writeFile(join(project, 'index.js'), implementation);
    expect((await run()).stdout).toContain('Held-out bounded lazy drain');
    await writeFile(join(project, 'index.js'), implementation.replace('*drain(limit=Infinity){', '*drain(limit=Infinity){limit=Infinity;'));
    await expect(run()).rejects.toMatchObject({ code: 1 });
    await writeFile(join(project, 'index.js'), implementation);
    await writeFile(join(project, 'index.d.ts'), declaration.replace('limit?:number', 'limit?:string'));
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Public declaration failed external TypeScript acceptance') });
  } finally { await rm(project, { recursive: true, force: true }); }
}, 60000);
