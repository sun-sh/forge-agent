// Independent acceptance script. argv[2] is the isolated repository workspace.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = process.argv[2];
// Pi 1.4.0 exposes its public SDK only under the ESM import condition.
const { ModelRuntime } = await import(pathToFileURL(join(project, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')).href);
const { CustomProviders } = await import(pathToFileURL(join(project, 'dist/web/providers.js')).href);
const home = await mkdtemp(join(tmpdir(), 'forge-provider-oracle-'));
try {
  const runtime = await ModelRuntime.create({ modelsPath: join(home, 'models.json'), authPath: join(home, 'auth.json'), refreshOnCreate: false });
  const editor = new CustomProviders(home, runtime);
  assert.equal(typeof editor.remove, 'function', 'CustomProviders.remove must exist');
  const provider = (id) => ({ id, name: id, api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'oracle-dummy-' + id, models: [{ id: 'coder', contextWindow: 32000, maxTokens: 1024 }] });
  await editor.save(provider('removable'));
  await editor.save(provider('preserved'));
  const before = JSON.parse(await readFile(join(home, 'models.json'), 'utf8'));
  const entry = (await editor.list()).find((item) => item.id === 'removable');
  assert.ok(entry?.revision, 'Revision must be available');
  await assert.rejects(editor.remove('removable', 'stale-revision'), (error) => error.status === 409);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'models.json'), 'utf8')), before, 'Stale deletion must preserve configuration');
  const removed = await editor.remove('removable', entry.revision);
  assert.equal(removed.id, 'removable'); assert.equal(removed.removed, true);
  const after = JSON.parse(await readFile(join(home, 'models.json'), 'utf8'));
  assert.equal(Object.hasOwn(after.providers, 'removable'), false);
  assert.deepEqual(after.providers.preserved, before.providers.preserved, 'Unrelated provider must survive');
  assert.equal((await editor.list()).some((item) => item.id === 'removable'), false);
  const credentials = await readFile(join(home, 'auth.json'), 'utf8').catch(() => '');
  assert.equal(credentials.includes('oracle-dummy-removable'), false, 'Deleted credentials must not survive');
  const restored = await ModelRuntime.create({ modelsPath: join(home, 'models.json'), authPath: join(home, 'auth.json'), refreshOnCreate: false });
  assert.equal(restored.getProvider('removable'), undefined);
  assert.ok(restored.getProvider('preserved'));
  console.log('PASS provider deletion, stale revision, credential removal and preservation');
} finally { await rm(home, { recursive: true, force: true }); }
