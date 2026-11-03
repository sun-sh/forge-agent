import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DefaultResourceLoader, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { startWebConsole } from '../src/web/server.js';
import { loadWebToken } from '../src/web/auth.js';

const closers: Array<() => Promise<void>> = [];
const streamClosers: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'pforge-lifecycle-home-'));
  vi.stubEnv('PFORGE_HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', home);
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
});
afterEach(async () => {
  for (const close of streamClosers.splice(0)) await close();
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture({ model = false, extension = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pforge-lifecycle-project-'));
  const home = process.env['PFORGE_HOME']!;
  await mkdir(join(home, 'sessions'), { recursive: true });
  if (model) await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock' }] } } }));
  if (extension) {
    await mkdir(join(root, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(root, '.pi', 'extensions', 'web-test.js'), extension);
  }
  const server = await startWebConsole({ cwd: root, port: 0 }); closers.push(server.close);
  const base = server.url.split('?')[0]!;
  const headers = { 'x-pforge-token': server.token, 'content-type': 'application/json' };
  const api = (path: string, input?: unknown) => fetch(base + path, { headers, ...(input !== undefined ? { method: 'POST', body: JSON.stringify(input) } : {}) });
  return { root, home, server, base, headers, api };
}

async function savedSession(root: string, home: string) {
  const manager = SessionManager.create(root, join(home, 'sessions'));
  manager.appendModelChange('missing', 'historical-model');
  const first = manager.appendMessage({ role: 'user', content: 'historical task', timestamp: 1 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning kept' }, { type: 'text', text: 'result kept' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }], api: 'openai-completions', provider: 'missing', model: 'historical-model', stopReason: 'toolUse', timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
  manager.appendMessage({ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'tool output kept' }], isError: false, timestamp: 3 });
  manager.appendCompaction('compaction summary kept', first, 100);
  return manager.getSessionFile()!;
}

async function stream(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const close = () => reader.cancel().catch(() => {}); streamClosers.push(close);
  return {
    close,
    async next(): Promise<{ id: number; event: any }> {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) return { id: Number(frame.split('\n').find((line) => line.startsWith('id: '))?.slice(4)), event: JSON.parse(data.slice(6)) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream ended before the expected event');
        buffer += decoder.decode(value, { stream: true });
      }
    }
  };
}

describe('Web lifecycle regressions', () => {
  it('keeps the gateway credential and browser session valid across service restarts', async () => {
    const { root, server, base } = await fixture();
    const token = server.token;
    const page = await fetch(server.url);
    const cookieHeader = page.headers.get('set-cookie')!;
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Strict');
    const cookie = cookieHeader.split(';')[0]!;
    await server.close();
    const restarted = await startWebConsole({ cwd: root, port: Number(new URL(base).port) });
    closers.push(restarted.close);
    expect(restarted.token).toBe(token);
    const response = await fetch(base + 'api/config', { headers: { cookie, 'x-pforge-token': 'outdated-tab-token' } });
    expect(response.status).toBe(200);
  });

  it('never issues access from public pages or invalid links and rejects foreign origins even with a valid cookie', async () => {
    const { server, base, headers } = await fixture();
    expect((await fetch(base)).headers.get('set-cookie')).toBeNull();
    expect((await fetch(base + '?token=invalid')).headers.get('set-cookie')).toBeNull();
    expect((await fetch(base + 'api/config')).status).toBe(401);
    const page = await fetch(server.url);
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(base + 'api/config', { headers: { cookie } })).status).toBe(200);
    expect((await fetch(base + 'api/config', { headers: { ...headers, cookie, origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(base + 'api/config', { headers: { cookie, origin: new URL(base).origin.replace('127.0.0.1', 'localhost') } })).status).toBe(403);
    expect((await fetch(base + 'api/config', { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(new URL(base + 'api/config'), { headers: { ...headers, host: 'untrusted.example:' + new URL(base).port } }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)); });
      request.once('error', reject); request.end();
    });
    expect(wrongHost).toBe(421);
    const rejected = await fetch(base + 'api/auth', { method: 'POST', headers: { cookie, 'x-pforge-token': 'invalid' } });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('set-cookie')).toBeNull();
    const authorized = await fetch(base + 'api/auth', { method: 'POST', headers });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await fetch(base + 'web/access-token', { headers })).status).toBe(404);
  });

  it('atomically creates one private access credential for concurrent startup and never silently replaces an invalid file', async () => {
    const home = process.env['PFORGE_HOME']!;
    const tokens = await Promise.all(Array.from({ length: 8 }, () => loadWebToken(home)));
    expect(new Set(tokens).size).toBe(1);
    const path = join(home, 'web', 'access-token');
    expect((await readFile(path, 'utf8')).trim()).toBe(tokens[0]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    const another = await mkdtemp(join(tmpdir(), 'pforge-separate-home-'));
    expect(await loadWebToken(another)).not.toBe(tokens[0]);
    await writeFile(path, 'invalid-file\n');
    await expect(loadWebToken(home)).rejects.toThrow('Invalid local Web access file');
    expect(await readFile(path, 'utf8')).toBe('invalid-file\n');
  });

  it('opens full history without credentials and reuses one runtime for concurrent opens of the same Pi session', async () => {
    vi.spyOn(ModelRuntime.prototype, 'getAvailable').mockResolvedValue([]);
    const { root, home, api } = await fixture();
    const file = await savedSession(root, home);
    const responses = await Promise.all([api('api/session', { project: root, sessionFile: file }), api('api/session', { project: root, sessionFile: file })]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const [first, second] = await Promise.all(responses.map((response) => response.json())) as any[];
    expect(first.id).toBe(second.id);
    expect(first.readOnly).toBe(true);
    expect(first.entries).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'compaction', summary: 'compaction summary kept' }), expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'toolResult' }) })]));
    expect(JSON.stringify(first.entries)).toContain('reasoning kept');
    expect((await api('api/sessions/' + first.id + '/prompt', { message: 'continue' })).status).toBe(409);
  });

  it('allows a read-only historical session to continue after selecting a currently available Pi model', async () => {
    const { root, home, api, base, headers } = await fixture({ model: true });
    const file = await savedSession(root, home);
    const created = await (await api('api/session', { project: root, sessionFile: file })).json() as any;
    expect(created.readOnly).toBe(true);
    const events = await stream(base + 'api/sessions/' + created.id + '/events', headers);
    await events.next();
    expect((await api('api/sessions/' + created.id + '/model', { model: 'mock/mock' })).status).toBe(200);
    expect((await events.next()).event.snapshot).toMatchObject({ readOnly: false, model: { key: 'mock/mock' } });
    const state = await (await api('api/sessions/' + created.id)).json() as any;
    expect(state).toMatchObject({ readOnly: false, model: { key: 'mock/mock' } });
    expect(JSON.stringify(state.entries)).toContain('tool output kept');
  });

  it('resumes SSE after the supplied event id and sends a current snapshot instead of replaying the whole transcript', async () => {
    const { root, home, api, base, headers } = await fixture();
    const created = await (await api('api/session', { project: root, sessionFile: await savedSession(root, home) })).json() as any;
    const first = await stream(base + 'api/sessions/' + created.id + '/events', headers);
    const initial = await first.next(); expect(initial.event.type).toBe('pforge_snapshot');
    await api('api/sessions/' + created.id + '/name', { name: 'First name' });
    const named = await first.next(); expect(named.id).toBeGreaterThan(initial.id); await first.close();
    await api('api/sessions/' + created.id + '/name', { name: 'Second name' });
    const resumed = await stream(base + 'api/sessions/' + created.id + '/events', { ...headers, 'last-event-id': String(named.id) });
    const next = await resumed.next();
    expect(next.id).toBe(named.id + 1);
    expect(next.event.snapshot.title).toBe('Second name');
  });

  it('recovers from a cursor older than the bounded event cache', async () => {
    const { root, api, base, headers } = await fixture({ model: true, extension: 'export default (pi) => { pi.registerCommand("web-burst", { description: "test", handler: async (_args, ctx) => { for (let i=0;i<700;i++) ctx.ui.setStatus("burst", String(i)); } }); };' });
    await api('api/projects/trust', { path: root, trusted: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    expect((await api('api/sessions/' + created.id + '/prompt', { message: '/web-burst' })).status).toBe(202);
    await vi.waitFor(async () => { expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false }); });
    const stale = await stream(base + 'api/sessions/' + created.id + '/events', { ...headers, 'last-event-id': '1' });
    const event = await stale.next();
    expect(event.id).toBeGreaterThan(500);
    expect(event.event.type).toBe('pforge_snapshot');
  });

  it('rejects invalid input with specific HTTP status codes and serves all browser dependencies with a CSP', async () => {
    const { root, home, base, headers, api } = await fixture();
    for (const raw of ['{bad', 'null', '[]']) expect((await fetch(base + 'api/session', { method: 'POST', headers, body: raw })).status).toBe(400);
    expect((await api('api/session', { project: root, sessionFile: join(root, 'outside.jsonl') })).status).toBe(400);
    expect((await api('api/session', { project: root, sessionFile: join(home, 'sessions', 'missing.jsonl') })).status).toBe(404);
    expect((await api('api/sessions/abc/state')).status).toBe(404);
    const other = await mkdtemp(join(tmpdir(), 'pforge-other-project-'));
    await writeFile(join(other, 'pforge.json'), JSON.stringify({ verify: [{ name: 'other', command: 'node --version' }] }));
    expect(await (await api('api/config?project=' + encodeURIComponent(other))).json()).toMatchObject({ cwd: other, verify: [{ name: 'other' }] });
    for (const file of ['app.js', 'render.js', 'stream.js', 'vendor/marked.js', 'vendor/purify.js']) {
      const response = await fetch(base + file); expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('javascript');
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
  });

  it('never loads untrusted project extensions and unloads an existing runtime when trust is revoked', async () => {
    const marker = join(process.env['PFORGE_HOME']!, 'extension-loaded');
    const extension = 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "loaded"); export default () => {};';
    const { root, api } = await fixture({ model: true, extension });
    await api('api/projects/trust', { path: root, trusted: false });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    await expect(access(marker)).rejects.toBeTruthy();
    await api('api/projects/trust', { path: root, trusted: true });
    await api('api/sessions/' + created.id + '/model', { model: 'mock/mock' });
    await expect(access(marker)).resolves.toBeUndefined();
    expect((await api('api/projects/trust', { path: root, trusted: false })).status).toBe(200);
    expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ readOnly: true, model: null, trust: { trusted: false } });
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'run' })).status).toBe(409);
  });

  it('locks project trust while loading resources and cannot attach a runtime after shutdown', async () => {
    const { root, server, api } = await fixture({ model: true });
    await api('api/projects/trust', { path: root, trusted: true });
    const original = DefaultResourceLoader.prototype.reload;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(DefaultResourceLoader.prototype, 'reload').mockImplementationOnce(async function (this: DefaultResourceLoader) { entered(); await gate; return original.call(this); });
    const creating = api('api/session', { project: root, model: 'mock/mock' });
    await ready;
    try { expect((await api('api/projects/trust', { path: root, trusted: false })).status).toBe(409); }
    finally { release(); }
    const created = await (await creating).json() as any;
    expect(created).toMatchObject({ readOnly: false, trust: { trusted: true } });

    let releaseShutdown!: () => void, enteredShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const shutdownReady = new Promise<void>((resolve) => { enteredShutdown = resolve; });
    vi.spyOn(DefaultResourceLoader.prototype, 'reload').mockImplementationOnce(async function (this: DefaultResourceLoader) { enteredShutdown(); await shutdownGate; return original.call(this); });
    const interrupted = api('api/session', { project: root, model: 'mock/mock' });
    await shutdownReady;
    const closing = server.close();
    releaseShutdown();
    expect((await interrupted).status).toBe(503);
    await closing;
    await server.close();
  });

  it('requires boolean confirmation values, rejects trust changes during a pending request, and aborts without leaving UI promises behind', async () => {
    const { root, api } = await fixture({ model: true, extension: 'export default (pi) => { pi.registerCommand("web-confirm", { description: "test", handler: async (_args, ctx) => { const value = await ctx.ui.confirm("Confirm", "test", { timeout: 5000 }); pi.appendEntry("test-confirm", { value }); } }); };' });
    await api('api/projects/trust', { path: root, trusted: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    await api('api/sessions/' + created.id + '/prompt', { message: '/web-confirm' });
    let requestId = '';
    await vi.waitFor(async () => { const state = await (await api('api/sessions/' + created.id)).json() as any; requestId = state.pendingUiRequests[0]?.requestId; expect(requestId).toBeTruthy(); });
    expect((await api('api/projects/trust', { path: root, trusted: false })).status).toBe(409);
    expect((await api('api/sessions/' + created.id + '/ui', { action: 'response', requestId, value: 'false' })).status).toBe(400);
    expect((await api('api/sessions/' + created.id + '/abort', {})).status).toBe(200);
    await vi.waitFor(async () => { expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false, pendingUiRequests: [] }); });
    expect((await api('api/sessions/' + created.id + '/ui', { action: 'response', requestId, value: true })).status).toBe(404);
  });

  it('expires unanswered UI requests, rejects late approvals and closes a pending request with its SSE connection on shutdown', async () => {
    const extension = 'export default (pi) => { pi.registerCommand("web-expire", { description: "test", handler: async (_args, ctx) => { const value = await ctx.ui.confirm("Confirm", "test", { timeout: 300 }); pi.appendEntry("expired-confirm", { value }); } }); pi.registerCommand("web-pending", { description: "test", handler: async (_args, ctx) => { await ctx.ui.confirm("Pending", "test"); } }); };';
    const { root, server, api, base, headers } = await fixture({ model: true, extension });
    await api('api/projects/trust', { path: root, trusted: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    const events = await stream(base + 'api/sessions/' + created.id + '/events', headers);
    await events.next();
    await api('api/sessions/' + created.id + '/prompt', { message: '/web-expire' });
    const request = await events.next();
    expect(request.event.type).toBe('extension_ui_request');
    const closed = await events.next();
    expect(closed.event).toMatchObject({ type: 'extension_ui_closed', reason: 'timeout', requestId: request.event.requestId });
    await vi.waitFor(async () => {
      const state = await (await api('api/sessions/' + created.id)).json() as any;
      expect(state).toMatchObject({ running: false, pendingUiRequests: [] });
      expect(state.entries).toContainEqual(expect.objectContaining({ type: 'custom', customType: 'expired-confirm', data: { value: false } }));
    });
    expect((await api('api/sessions/' + created.id + '/ui', { action: 'response', requestId: request.event.requestId, value: true })).status).toBe(404);
    await api('api/sessions/' + created.id + '/prompt', { message: '/web-pending' });
    await vi.waitFor(async () => { expect((await (await api('api/sessions/' + created.id)).json() as any).pendingUiRequests).toHaveLength(1); });
    await server.close();
    await expect(fetch(base, { headers })).rejects.toThrow();
  });
});
