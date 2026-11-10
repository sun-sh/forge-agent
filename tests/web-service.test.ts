import * as serviceFiles from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearService, saveService, serviceStatus, startService, stopService } from '../src/web/service.js';
import { loadWebToken } from '../src/web/auth.js';
import { startWebConsole } from '../src/web/server.js';
import { CheckpointStore, checkpointGit } from '../src/task/checkpoints.js';

vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readFile: vi.fn(actual.readFile) }; });

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('independent local service', () => {
  it('retries transient record sharing errors but rejects malformed records', async () => {
    const home=await mkdtemp(join(tmpdir(),'forge-service-sharing-'));
    await saveService(home,'http://127.0.0.1:9',randomUUID());
    vi.spyOn(serviceFiles,'readFile').mockRejectedValueOnce(Object.assign(new Error('sharing'),{code:'EPERM'})).mockRejectedValueOnce(Object.assign(new Error('sharing'),{code:'EACCES'}));
    expect((await serviceStatus(home)).running).toBe(false);
    await writeFile(join(home,'web','service.json'),'{invalid');
    await expect(serviceStatus(home)).rejects.toThrow('记录不可读');
  });

  it('binds control to a live instance rather than trusting a saved PID', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-service-state-')), instance = randomUUID();
    const server = createServer((_request, response) => response.setHeader('content-type', 'application/json').end(JSON.stringify({ ok: true, instance })));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    await saveService(home, 'http://127.0.0.1:' + (server.address() as { port: number }).port, instance);
    expect((await serviceStatus(home)).running).toBe(true);
    await saveService(home, 'http://127.0.0.1:' + (server.address() as { port: number }).port, randomUUID());
    expect((await serviceStatus(home)).running).toBe(false);
    const record = JSON.parse(await readFile(join(home, 'web', 'service.json'), 'utf8')); record.origin = 'https://external.invalid/';
    await writeFile(join(home, 'web', 'service.json'), JSON.stringify(record));
    await expect(serviceStatus(home)).rejects.toThrow('地址无效');
  });
  it('starts a detached gateway, survives the starting command and stops through authenticated instance control', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-service-home-')), project = await mkdtemp(join(tmpdir(), 'forge-service-project-'));
    const reservation = createServer(); await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const port = (reservation.address() as { port: number }).port; await new Promise<void>((done) => reservation.close(() => done()));
    cleanups.push(() => stopService(home));
    const state = await startService(home, project, fileURLToPath(new URL('../dist/pi-cli.js', import.meta.url)), port);
    expect(state.running).toBe(true); expect((await serviceStatus(home)).running).toBe(true);
    const token = await loadWebToken(home);
    expect(await readFile(join(home, 'web', 'service.log'), 'utf8')).not.toContain(token);
    await stopService(home); expect((await serviceStatus(home)).running).toBe(false);
  }, 60000);
});
describe('Web queue control', () => {
  it('keeps queued model settings and requires trusted Agent mode, then executes through Pi', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-web-home-')), project = await mkdtemp(join(tmpdir(), 'forge-queue-web-project-'));
    for (const [key, value] of Object.entries({ FORGE_AGENT_HOME: home, PFORGE_HOME: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions') })) vi.stubEnv(key, value);
    const requests: any[] = [];
    const model = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw); requests.push(input);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of [{ delta: { role: 'assistant', content: 'Queue answer.' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) response.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, ...part }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => model.listen(0, '127.0.0.1', done)); cleanups.push(() => new Promise<void>((done) => { model.closeAllConnections(); model.close(() => done()); }));
    await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { test: { api: 'openai-completions', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:' + (model.address() as { port: number }).port + '/v1', models: [{ id: 'mock' }] } } }));
    const gateway = await startWebConsole({ cwd: project, port: 0 }); cleanups.push(gateway.close);
    const origin = new URL(gateway.url).origin;
    const api = async (path: string, input?: unknown) => { const response = await fetch(origin + path, { headers: { 'content-type': 'application/json', 'x-pforge-token': gateway.token }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) }); return { status: response.status, data: await response.json() as any }; };
    await api('/api/projects/trust', { path: project, trusted: false });
    const opened = await api('/api/session', { project, mode: 'ask', model: 'test/mock' }); expect(opened.status, JSON.stringify(opened.data)).toBe(201);
    const session = opened.data;
    expect(session.model, JSON.stringify(session)).toMatchObject({ key: 'test/mock' });
    expect((await api('/api/jobs', { session: session.id, message: 'Explain the project' })).status).toBe(409);
    const changed = await api('/api/sessions/' + session.id + '/mode', { mode: 'agent' }); expect(changed.data, JSON.stringify(changed)).toMatchObject({ mode: 'agent' });
    const denied = await api('/api/jobs', { session: session.id, message: 'Untrusted task' }); expect(denied.status, JSON.stringify(denied.data)).toBe(403);
    await api('/api/projects/trust', { path: project, trusted: true });
    expect((await api('/api/sessions/' + session.id + '/model', { model: 'test/mock' })).status).toBe(200);
    await checkpointGit(project, ['init']);
    let entered!: () => void, release!: () => void;
    const sealing = new Promise<void>((done) => { entered = done; }), gate = new Promise<void>((done) => { release = done; });
    const originalSeal = CheckpointStore.prototype.seal;
    vi.spyOn(CheckpointStore.prototype, 'seal').mockImplementationOnce(async function(this: CheckpointStore, ...args: Parameters<CheckpointStore['seal']>) { entered(); await gate; return originalSeal.apply(this, args); });
    const stream = await fetch(origin + '/api/sessions/' + session.id + '/events', { headers: { 'x-pforge-token': gateway.token } });
    const reader = stream.body!.getReader();
    try {
      const hello = await api('/api/sessions/' + session.id + '/prompt', { message: 'Hello' }); expect(hello.status, JSON.stringify(hello.data)).toBe(202);
      await sealing;
      expect((await api('/api/sessions/' + session.id)).data.running).toBe(true);
      let events = ''; const decoder = new TextDecoder();
      while (!events.includes('"type":"agent_settled"')) { const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended before settlement'); events += decoder.decode(chunk.value, { stream: true }); }
      expect(events).toContain('"taskRunning":true');
    } finally { release(); await reader.cancel(); }
    await vi.waitFor(async () => expect((await api('/api/sessions/' + session.id)).data.running).toBe(false), { timeout: 10000 });
    const accepted = await api('/api/jobs', { session: session.id, message: 'What is 2 + 2?', model: 'test/mock', workflow: 'direct' });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(202);
    await vi.waitFor(async () => expect((await api('/api/jobs')).data.jobs[0]?.status).toBe('completed'), { timeout: 15000 });
    expect(requests).toHaveLength(2); expect(requests[0].model).toBe('mock');
    const stored = JSON.parse(await readFile(join(home, 'tasks', 'queue.json'), 'utf8')); expect(stored.jobs[0]).toMatchObject({ prompt: 'What is 2 + 2?', status: 'completed', model: 'test/mock' });
    expect((await api('/api/jobs/' + accepted.data.job.id + '/retry', {})).status).toBe(409);
  });
});
