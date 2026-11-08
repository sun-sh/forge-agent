import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startWebConsole } from '../src/web/server.js';
import { TaskQueue } from '../src/task/queue.js';
import { AgentSession } from '@earendil-works/pi-coding-agent';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function answer(res: ServerResponse, content = 'Explained.') {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [{ delta: { role: 'assistant', content }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, ...choice }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

it('runs queued Web sessions in different projects concurrently, sequences one project and cancels only one running job', async () => {
  let beforeExecute = async () => {};
  const nativeOpen = TaskQueue.open;
  vi.spyOn(TaskQueue, 'open').mockImplementation((queueHome, execute, ready) => nativeOpen(queueHome, async (job, signal) => { await beforeExecute(); await execute(job, signal); }, ready));
  const home = await mkdtemp(join(tmpdir(), 'forge-web-queue-home-')), a = await mkdtemp(join(tmpdir(), 'forge-web-queue-a-')), b = await mkdtemp(join(tmpdir(), 'forge-web-queue-b-'));
  for (const [key, value] of Object.entries({ FORGE_AGENT_HOME: home, PFORGE_HOME: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions') })) vi.stubEnv(key, value);
  const held = new Map<string, ServerResponse>();
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw), last = input.messages.filter((message: any) => message.role === 'user').at(-1);
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
    const marker = /queue-(a1|a2|b1)/.exec(text)?.[1];
    if (marker) held.set(marker, res); else answer(res);
  });
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
  closers.push(async () => { held.forEach((res) => answer(res)); model.closeAllConnections(); await new Promise<void>((done) => model.close(() => done())); });
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mock: { api: 'openai-completions', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, models: [{ id: 'test', contextWindow: 16000, maxTokens: 1024 }] } } }));
  const gateway = await startWebConsole({ cwd: a, port: 0 });
  closers.push(async () => { held.forEach((res) => answer(res)); await gateway.close(); });
  const base = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
  const post = async (path: string, body: unknown) => { const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }); const result = await response.json() as any; expect(response.ok, JSON.stringify(result)).toBe(true); return result; };
  const jobs = async () => (await (await fetch(base + '/api/jobs', { headers })).json() as any).jobs as any[];
  const sessions: string[] = [];
  for (const project of [a, b]) {
    await post('/api/projects/trust', { path: project, trusted: true });
    const session = await post('/api/session', { project, model: 'mock/test', mode: 'agent' }); sessions.push(session.id);
    await post(`/api/sessions/${session.id}/prompt`, { message: 'Explain the project name.', workflow: 'direct' });
    await vi.waitFor(async () => expect((await (await fetch(base + `/api/sessions/${session.id}`, { headers })).json() as any).running).toBe(false), { timeout: 15000 });
  }
  const one = await post('/api/jobs', { session: sessions[0], message: 'Explain queue-a1', workflow: 'direct', model: 'mock/test' });
  const two = await post('/api/jobs', { session: sessions[0], message: 'Explain queue-a2', workflow: 'direct', model: 'mock/test' });
  const other = await post('/api/jobs', { session: sessions[1], message: 'Explain queue-b1', workflow: 'direct', model: 'mock/test' });
  await vi.waitFor(() => { expect(held.has('a1')).toBe(true); expect(held.has('b1')).toBe(true); }, { timeout: 15000 });
  expect(held.has('a2')).toBe(false);
  await post(`/api/jobs/${one.job.id}/cancel`, {});
  expect((await jobs()).find((job) => job.id === one.job.id).status).toBe('cancelled');
  expect((await jobs()).find((job) => job.id === other.job.id).status).toBe('running');
  await vi.waitFor(() => expect(held.has('a2')).toBe(true), { timeout: 15000 });
  answer(held.get('a2')!); answer(held.get('b1')!);
  await vi.waitFor(async () => {
    const result = await jobs(); expect(result.find((job) => job.id === two.job.id).status).toBe('completed'); expect(result.find((job) => job.id === other.job.id).status).toBe('completed');
  }, { timeout: 15000 });

  // A settings request acquires this idle session after queue readiness but before
  // execution. Deferral must not release another request's preparation lock.
  let releaseModel: (() => void) | undefined, changeRequest: Promise<Response> | undefined, raced = false;
  const nativeSetModel = AgentSession.prototype.setModel;
  vi.spyOn(AgentSession.prototype, 'setModel').mockImplementationOnce(async function (this: AgentSession, ...args) {
    await new Promise<void>((done) => { releaseModel = done; }); return nativeSetModel.apply(this, args);
  });
  closers.push(async () => { releaseModel?.(); await changeRequest; });
  beforeExecute = async () => {
    if (raced) return; raced = true;
    changeRequest = fetch(base + `/api/sessions/${sessions[0]}/model`, { method: 'POST', headers, body: JSON.stringify({ model: 'mock/test' }) });
    await vi.waitFor(() => expect(releaseModel).toBeTypeOf('function'));
  };
  const race = await post('/api/jobs', { session: sessions[0], message: 'Explain readiness race', model: 'mock/test' });
  await vi.waitFor(async () => { expect(raced).toBe(true); expect((await jobs()).find((job) => job.id === race.job.id)).toMatchObject({ status: 'queued', waiting: expect.any(String) }); }, { timeout: 10000 });
  const blocked = await fetch(base + `/api/sessions/${sessions[0]}/prompt`, { method: 'POST', headers, body: JSON.stringify({ message: 'Explain another foreground request.' }) });
  expect(blocked.status).toBe(409);
  await post(`/api/jobs/${race.job.id}/cancel`, {}); releaseModel!(); expect((await changeRequest!).ok).toBe(true);
}, 90000);
