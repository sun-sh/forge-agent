import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { basename, join } from 'node:path';
import { AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { startWebConsole } from '../src/web/server.js';
import { loadWebToken } from '../src/web/auth.js';
import { MemoryStore } from '../src/web/memory.js';
import * as taskGit from '../src/task/git.js';
import { CheckpointStore, checkpointGit } from '../src/task/checkpoints.js';

const closers: Array<() => Promise<void>> = [];
const streamClosers: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'pforge-lifecycle-home-'));
  vi.stubEnv('FORGE_AGENT_HOME', home);
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

describe('project removal', () => {
  it('does not inherit checkpoint ownership when a saved conversation is forked', async () => {
    const { root, home, api } = await fixture();
    await checkpointGit(root, ['init']); await writeFile(join(root, 'sample.txt'), 'before');
    await api('api/projects/trust', { path: root, trusted: true });
    const path = await savedSession(root, home), manager = SessionManager.open(path);
    const store = new CheckpointStore(home), id = await store.begin(root, manager.getSessionId(), 'parent change');
    await writeFile(join(root, 'sample.txt'), 'after'); await store.seal(id, root, manager.getSessionId());
    manager.appendCustomEntry('forge.checkpoint', { id, sessionId: manager.getSessionId(), status: 'sealed' });
    const forkPath = manager.createBranchedSession(manager.getLeafId()!);
    const opened = await (await api('api/session', { project: root, sessionFile: forkPath })).json() as any;
    expect(opened.checkpoint).toBeUndefined();
    const response = await api('api/sessions/' + opened.id + '/checkpoints');
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ checkpoints: [] });
    expect((await api('api/sessions/' + opened.id + '/checkpoints?id=' + id)).status).toBe(404);
    const source = await (await api('api/session', { project: root, sessionFile: path })).json() as any;
    await api('api/sessions/' + source.id + '/mode', { mode: 'plan' });
    const current = await store.view(id, root, SessionManager.open(path).getSessionId());
    expect((await api('api/sessions/' + source.id + '/checkpoints', { id, paths: ['sample.txt'], revision: current.revision })).status).toBe(403);
    expect(await readFile(join(root, 'sample.txt'), 'utf8')).toBe('after');
  });
  it('removes a history-only project across restarts, preserves source and Pi history, and recovers on reopen', async () => {
    const { root, home, server, base, headers, api } = await fixture();
    const path = await savedSession(root, home), original = await readFile(path, 'utf8');
    await writeFile(join(root, 'keep.txt'), 'workspace source');
    expect((await (await api('api/history')).json() as any).projects).toHaveLength(1);
    expect((await fetch(base + 'api/projects', { method: 'DELETE', body: JSON.stringify({ path: root }) })).status).toBe(401);
    expect((await fetch(base + 'api/projects', { method: 'DELETE', headers, body: JSON.stringify({ path: '../relative' }) })).status).toBe(400);
    expect((await fetch(base + 'api/projects', { method: 'DELETE', headers, body: JSON.stringify({ path: root }) })).status).toBe(200);
    expect(await (await api('api/history')).json()).toEqual({ projects: [] });
    expect(await (await api('api/projects')).json()).toMatchObject({ projects: [], removedPaths: [expect.any(String)] });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('workspace source');
    await server.close();
    const restarted = await startWebConsole({ cwd: root, port: 0 }); closers.push(restarted.close);
    const origin = restarted.url.split('?')[0]!, auth = { 'x-pforge-token': restarted.token, 'content-type': 'application/json' };
    expect(await (await fetch(origin + 'api/history', { headers: auth })).json()).toEqual({ projects: [] });
    expect((await fetch(origin + 'api/projects', { method: 'POST', headers: auth, body: JSON.stringify({ path: root }) })).status).toBe(201);
    expect((await (await fetch(origin + 'api/history', { headers: auth })).json() as any).projects[0].sessions).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('rejects removal while a project is running or a session is opening', async () => {
    const { root, api, base, headers } = await fixture({ model: true, extension: 'export default (pi) => { pi.registerCommand("web-pending", { description: "test", handler: async (_args, ctx) => { await ctx.ui.confirm("Pending", "test"); } }); };' });
    await api('api/projects/trust', { path: root, trusted: true });
    const remove = () => fetch(base + 'api/projects', { method: 'DELETE', headers, body: JSON.stringify({ path: root }) });
    const originalReload = DefaultResourceLoader.prototype.reload;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(DefaultResourceLoader.prototype, 'reload').mockImplementationOnce(async function(this: DefaultResourceLoader) { entered(); await gate; return originalReload.call(this); });
    const creating = api('api/session', { project: root, model: 'mock/mock' });
    await ready;
    try { expect((await remove()).status).toBe(409); } finally { release(); }
    const session = await (await creating).json() as any;
    await api('api/sessions/' + session.id + '/prompt', { message: '/web-pending' });
    await vi.waitFor(async () => expect((await (await api('api/sessions/' + session.id)).json() as any).pendingUiRequests).toHaveLength(1));
    expect((await remove()).status).toBe(409);
    await api('api/sessions/' + session.id + '/abort', {});
    await vi.waitFor(async () => expect((await (await api('api/sessions/' + session.id)).json() as any).running).toBe(false));
    expect((await remove()).status).toBe(200);
  });
});

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
    },
    async nextType(type: string): Promise<{ id: number; event: any }> {
      for (;;) {
        const next = await this.next();
        if (next.event?.type === type) return next;
      }
    }
  };
}

describe('Web lifecycle regressions', () => {
  it('returns a failed preparation to idle when the direct task baseline cannot be captured', async () => {
    const { root, api } = await fixture({ model: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    const prompt = vi.spyOn(AgentSession.prototype, 'prompt');
    vi.spyOn(taskGit, 'captureGit').mockRejectedValueOnce(new Error('baseline unavailable'));

    const failed = await api('api/sessions/' + created.id + '/prompt', { message: 'fix the current file' });
    expect(failed.status).toBe(500);
    expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false, outcome: 'failed', error: 'baseline unavailable' });
    expect(prompt).not.toHaveBeenCalled();

    // The failed preparation must release the project lease and allow a new
    // user prompt without requiring a gateway restart.
    prompt.mockResolvedValueOnce(undefined);
    const accepted = await api('api/sessions/' + created.id + '/prompt', { message: 'retry after the preparation failure' });
    expect(accepted.status).toBe(202);
    await vi.waitFor(async () => expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false }), { timeout: 10_000 });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('authorizes skill management and reloads Pi commands in idle sessions without changing the readonly mode', async () => {
    const { root, api, base, headers } = await fixture({ model: true });
    await mkdir(join(root, '.pi', 'skills', 'managed-review'), { recursive: true });
    await writeFile(join(root, '.pi', 'skills', 'managed-review', 'SKILL.md'), '---\nname: managed-review\ndescription: Managed review\n---\nPrivate instructions');
    expect((await fetch(base + 'api/skills')).status).toBe(401);
    expect((await fetch(base + 'api/skills/toggle', { method: 'POST', headers: { ...headers, origin: 'https://example.com' }, body: '{}' })).status).toBe(403);
    const initial = await (await api('api/skills')).json() as any;
    expect(initial.skills.some((item: any) => item.name === 'managed-review')).toBe(false);
    expect((await api('api/skills/sources', { project: root, scope: 'project', path: root, revision: initial.revision })).status).toBe(403);
    await api('api/projects/trust', { path: root, trusted: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock', mode: 'ask' })).json() as any;
    const prompt = vi.spyOn(AgentSession.prototype, 'prompt');
    let catalog = await (await api('api/skills')).json() as any;
    const skill = catalog.skills.find((item: any) => item.name === 'managed-review');
    expect((await api('api/skills/content?id=' + skill.id)).status).toBe(200);
    expect((await api('api/skills/content?id=' + encodeURIComponent(join(root, 'secret.txt')))).status).toBe(400);
    const result = await api('api/skills/toggle', { project: root, scope: 'project', id: skill.id, enabled: false, revision: catalog.revision });
    expect(result.status).toBe(200);
    catalog = (await result.json() as any).snapshot;
    let session = await (await api('api/sessions/' + created.id)).json() as any;
    expect(session).toMatchObject({ mode: 'ask', running: false, readOnly: false });
    expect(session.commands.some((item: any) => item.name === 'skill:managed-review')).toBe(false);
    const enabled = await api('api/skills/toggle', { project: root, scope: 'project', id: skill.id, enabled: true, revision: catalog.revision });
    expect(enabled.status).toBe(200);
    session = await (await api('api/sessions/' + created.id)).json() as any;
    expect(session.commands.some((item: any) => item.name === 'skill:managed-review')).toBe(true);
    expect((await api('api/sessions/' + created.id + '/prompt', { command: true, message: '/skill:managed-review test' })).status).toBe(409);
    expect(prompt).not.toHaveBeenCalled();
    expect((await fetch(base + 'skills.js', { headers })).status).toBe(200);
  });

  it('keeps skill persistence unchanged when a session is busy and serializes a resource reload against prompts', async () => {
    const { root, api, home } = await fixture({ model: true });
    await mkdir(join(home, 'skills', 'managed-review'), { recursive: true });
    await writeFile(join(home, 'skills', 'managed-review', 'SKILL.md'), '---\nname: managed-review\ndescription: Managed review\n---\nInstructions');
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    const catalog = await (await api('api/skills')).json() as any, skill = catalog.skills.find((item: any) => item.name === 'managed-review');
    let release!: () => void, started = false;
    const pending = new Promise<void>((done) => { release = done; });
    vi.spyOn(AgentSession.prototype, 'prompt').mockImplementation(async () => { started = true; await pending; });
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'hold' })).status).toBe(202);
    await vi.waitFor(() => expect(started).toBe(true));
    expect((await api('api/skills/toggle', { project: root, scope: 'global', id: skill.id, enabled: false, revision: catalog.revision })).status).toBe(409);
    expect((await (await api('api/skills')).json() as any).revision).toBe(catalog.revision);
    release();
    await vi.waitFor(async () => expect((await (await api('api/sessions/' + created.id)).json() as any).running).toBe(false));
    const original = AgentSession.prototype.reload;
    let reloadStarted = false, finishReload!: () => void;
    const waiting = new Promise<void>((done) => { finishReload = done; });
    vi.spyOn(AgentSession.prototype, 'reload').mockImplementation(async function (this: AgentSession, ...args) { reloadStarted = true; await waiting; return original.apply(this, args); });
    const toggle = api('api/skills/toggle', { project: root, scope: 'global', id: skill.id, enabled: false, revision: catalog.revision });
    await vi.waitFor(() => expect(reloadStarted).toBe(true));
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'must not race' })).status).toBe(409);
    finishReload(); expect((await toggle).status).toBe(200);
  });

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
    expect(first.title).toBe('historical task');
    expect(first.entries).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'compaction', summary: 'compaction summary kept' }), expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'toolResult' }) })]));
    expect(JSON.stringify(first.entries)).toContain('reasoning kept');
    expect((await api('api/sessions/' + first.id + '/prompt', { message: 'continue' })).status).toBe(409);
  });

  it('canonicalizes session aliases before opening or mutating the live runtime', async () => {
    vi.spyOn(ModelRuntime.prototype, 'getAvailable').mockResolvedValue([]);
    const { root, home, api } = await fixture();
    const file = await savedSession(root, home);
    const aliasRoot = join(home, 'sessions-alias');
    await symlink(join(home, 'sessions'), aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasFile = join(aliasRoot, basename(file));
    const responses = await Promise.all([
      api('api/session', { project: root, sessionFile: file }),
      api('api/session', { project: root, sessionFile: aliasFile })
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const [canonical, alias] = await Promise.all(responses.map((response) => response.json())) as any[];
    expect(alias.id).toBe(canonical.id);
    const archived = await api('api/history', { path: aliasFile, action: 'archive' });
    expect(archived.status).toBe(200);
    expect(await (await api('api/sessions/' + canonical.id)).json()).toMatchObject({ history: { status: 'archived' } });
    expect((await api('api/sessions/' + canonical.id + '/prompt', { message: 'blocked' })).status).toBe(409);
  });

  it('shares project trust, resources, session memory and MCP state across directory aliases', async () => {
    const { root, home, api } = await fixture({ model: true, extension: 'export default (pi) => { pi.registerCommand("alias-check", { description: "fixture", handler: async () => {} }); };' });
    const alias = join(home, 'project-alias');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await api('api/projects/trust', { path: alias, trusted: false })).status).toBe(200);
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    expect(created.trust.trusted).toBe(false);
    expect(created.commands.some((item: any) => item.name === 'alias-check')).toBe(false);
    expect((await api('api/projects/trust', { path: alias, trusted: true })).status).toBe(200);
    expect((await api('api/sessions/' + created.id + '/model', { model: 'mock/mock' })).status).toBe(200);
    const ready = await (await api('api/sessions/' + created.id)).json() as any;
    expect(ready.trust.trusted).toBe(true);
    expect(ready.commands.some((item: any) => item.name === 'alias-check')).toBe(true);
    expect((await api('api/memory', { project: alias, session: created.id, layer: 'session', items: [{ text: 'Same project through an alias' }] })).status).toBe(200);
    const memory = await (await api('api/memory?project=' + encodeURIComponent(root) + '&session=' + created.id)).json() as any;
    expect(memory.session.items[0].text).toBe('Same project through an alias');
    for (const path of [root, alias]) {
      const runtime = await (await api('api/mcp/runtime?project=' + encodeURIComponent(path))).json() as any;
      expect(runtime.sessions.map((session: any) => session.id)).toEqual([created.id]);
    }
  });

  it('blocks history writes and forks during a model turn and requires restore before continuing', async () => {
    const { root, home, api } = await fixture({ model: true });
    const path = await savedSession(root, home);
    const created = await (await api('api/session', { project: root, sessionFile: path, model: 'mock/mock' })).json() as any;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const prompt = vi.spyOn(AgentSession.prototype, 'prompt').mockImplementation(async () => { await gate; });
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'working' })).status).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    try {
      expect((await api('api/history', { path: created.sessionFile, action: 'archive' })).status).toBe(409);
      expect((await api('api/sessions/' + created.id + '/fork', { entryId: 'any' })).status).toBe(409);
    } finally { release(); }
    await vi.waitFor(async () => expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false }));
    expect((await api('api/history', { path, action: 'archive' })).status).toBe(200);
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'blocked' })).status).toBe(409);
    expect((await api('api/sessions/' + created.id + '/resume-task', {})).status).toBe(409);
    expect(prompt).toHaveBeenCalledOnce();
    expect((await api('api/history', { path, action: 'restore' })).status).toBe(200);
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'allowed' })).status).toBe(202);
    await vi.waitFor(async () => expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false }));
  });

  it('persists adaptive execution budget while the model turn is still running', async () => {
    const { root, api } = await fixture({ model: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    vi.spyOn(AgentSession.prototype, 'prompt').mockImplementationOnce(async () => { started = true; await pending; });
    try {
      expect((await api('api/sessions/' + created.id + '/prompt', { message: 'fix the current file' })).status).toBe(202);
      await vi.waitFor(() => expect(started).toBe(true));
      const running = await (await api('api/sessions/' + created.id)).json() as any;
      expect(running.task).toMatchObject({ status: 'running', workflow: 'direct', budget: { status: 'running', modelTurns: 0, toolCalls: 0 } });
      expect(running.budget).toMatchObject({ status: 'running', limits: expect.any(Object) });
    } finally {
      release();
    }
    await vi.waitFor(async () => expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false }));
  });

  it('allows a read-only historical session to continue after selecting a currently available Pi model', async () => {
    const { root, home, api, base, headers } = await fixture({ model: true });
    const file = await savedSession(root, home);
    const created = await (await api('api/session', { project: root, sessionFile: file })).json() as any;
    expect(created.readOnly).toBe(true);
    const events = await stream(base + 'api/sessions/' + created.id + '/events', headers);
    await events.next();
    expect((await api('api/sessions/' + created.id + '/model', { model: 'mock/mock' })).status).toBe(200);
    let changed: { id: number; event: any } | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const next = await events.next();
      if (next.event.type === 'pforge_snapshot') { changed = next; break; }
    }
    expect(changed?.event.snapshot).toMatchObject({ readOnly: false, model: { key: 'mock/mock' } });
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
    expect(created.context).toMatchObject({ compacting: false, usage: { tokens: 0, percent: 0 }, compactions: 0 });
    expect(created.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'web-burst', source: 'extension' })]));
    expect((await api('api/sessions/' + created.id + '/prompt', { message: '/web-burst' })).status).toBe(202);
    await vi.waitFor(async () => { expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ running: false }); });
    const stale = await stream(base + 'api/sessions/' + created.id + '/events', { ...headers, 'last-event-id': '1' });
    const event = await stale.next();
    expect(event.id).toBeGreaterThan(500);
    expect(event.event.type).toBe('pforge_snapshot');
  });

  it('keeps runtime commands behind the Web mode boundary and exposes the command asset', async () => {
    const { root, api, base, headers } = await fixture({ model: true, extension: 'export default (pi) => { pi.registerCommand("web-safe", { description: "test", handler: async () => {} }); };' });
    await api('api/projects/trust', { path: root, trusted: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    expect(created.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'web-safe', source: 'extension' })]));
    expect((await api('api/sessions/' + created.id + '/mode', { mode: 'plan' })).status).toBe(200);
    const blocked = await api('api/sessions/' + created.id + '/prompt', { message: '/web-safe', command: true, workflow: 'direct' });
    expect(blocked.status).toBe(409);
    const asset = await fetch(base + 'commands.js', { headers });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('builtinCommands');
  });

  it('discovers loaded prompt resources without exposing their content and dispatches known commands without orchestration', async () => {
    const { root, api } = await fixture({ model: true, extension: 'export default (pi) => { pi.registerCommand("web-safe", { description: "test", handler: async (args) => { pi.appendEntry("command-result", { args }); } }); };' });
    await mkdir(join(root, '.pi', 'skills', 'review'), { recursive: true });
    await mkdir(join(root, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(root, '.pi', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nskill-private-body');
    await writeFile(join(root, '.pi', 'prompts', 'check.md'), '---\ndescription: Check code\n---\ntemplate-private-body $ARGUMENTS');
    await api('api/projects/trust', { path: root, trusted: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    expect(created.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'skill:review', source: 'skill' }),
      expect.objectContaining({ name: 'check', source: 'template' })
    ]));
    expect(JSON.stringify(created.commands)).not.toMatch(/private-body/);
    const prompt = 'api/sessions/' + created.id + '/prompt';
    expect((await api('api/sessions/' + created.id + '/workflow', { workflow: 'planned' })).status).toBe(200);
    expect((await api(prompt, { message: '/missing', command: true })).status).toBe(400);
    expect((await api(prompt, { message: '/web-safe\nargs', command: true })).status).toBe(400);
    expect((await api(prompt, { message: '/web-safe', command: true, workflow: 'planned' })).status).toBe(400);
    expect((await api(prompt, { message: '/web-safe preserved args', command: true, workflow: 'direct' })).status).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await (await api('api/sessions/' + created.id)).json() as any;
      expect(snapshot.running).toBe(false);
      expect(snapshot.workflow).toBe('planned');
      expect(snapshot.entries).toContainEqual(expect.objectContaining({ type: 'custom', customType: 'command-result', data: { args: 'preserved args' } }));
      expect(snapshot.finishedAt).toBeGreaterThanOrEqual(snapshot.runningSince);
    });
    await api('api/projects/trust', { path: root, trusted: false });
    expect(await (await api('api/sessions/' + created.id)).json()).toMatchObject({ commands: [], readOnly: true });
  });

  it('serializes manual compaction with prompts and settings, propagates errors and unlocks after cancellation', async () => {
    const { root, api } = await fixture({ model: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    const prefix = 'api/sessions/' + created.id;
    expect((await api(prefix + '/compact', { instructions: 1 })).status).toBe(400);
    let cancel!: (error: Error) => void;
    const compact = vi.spyOn(AgentSession.prototype, 'compact').mockImplementationOnce(async () => await new Promise((_resolve, reject) => { cancel = reject; }));
    const abort = vi.spyOn(AgentSession.prototype, 'abortCompaction').mockImplementationOnce(() => cancel(new Error('Compaction cancelled')));
    const pending = api(prefix + '/compact', { instructions: 'keep decisions' });
    await vi.waitFor(() => expect(compact).toHaveBeenCalledWith('keep decisions'));
    expect(await (await api(prefix)).json()).toMatchObject({ context: { compacting: true } });
    for (const [action, input] of [['prompt', { message: 'blocked' }], ['model', { model: 'mock/mock' }], ['mode', { mode: 'ask' }], ['compact', {}]] as const) expect((await api(prefix + '/' + action, input)).status).toBe(409);
    expect((await api('api/projects/trust', { path: root, trusted: false })).status).toBe(409);
    expect((await api(prefix + '/abort-compact', {})).status).toBe(200);
    expect(abort).toHaveBeenCalledOnce();
    const response = await pending; expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Compaction cancelled' });
    expect(await (await api(prefix)).json()).toMatchObject({ running: false, context: { compacting: false, error: 'Compaction cancelled' } });
    expect((await api(prefix + '/name', { name: 'unlocked' })).status).toBe(200);
  });

  it('scopes global, project and session memory and exposes Pi compaction settings', async () => {
    const { root, api } = await fixture({ model: true });
    const other = await mkdtemp(join(tmpdir(), 'pforge-memory-project-'));
    const global = await api('api/memory', { project: root, layer: 'global', items: [{ text: 'Prefer concise answers', kind: 'preference' }] });
    expect(global.status).toBe(200);
    const globalSnapshot = await (await api('api/memory?project=' + encodeURIComponent(root))).json() as any;
    expect(globalSnapshot.global.items[0].text).toBe('Prefer concise answers');
    await api('api/memory', { project: root, layer: 'project', items: [{ text: 'Use pnpm here', kind: 'constraint' }] });
    await api('api/memory', { project: other, layer: 'project', items: [{ text: 'Other project only', kind: 'fact' }] });
    const isolated = await (await api('api/memory?project=' + encodeURIComponent(other))).json() as any;
    expect(isolated.project.items.map((item: any) => item.text)).toEqual(['Other project only']);
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    await api('api/memory', { project: root, session: created.id, layer: 'session', items: [{ text: 'Keep this conversation focused', kind: 'decision' }] });
    const sessionMemory = await (await api('api/memory?project=' + encodeURIComponent(root) + '&session=' + created.id)).json() as any;
    expect(sessionMemory.session.items[0].text).toBe('Keep this conversation focused');
    const sessionSnapshot = await (await api('api/sessions/' + created.id)).json() as any;
    expect(sessionSnapshot.context.memory.sessionItems).toBe(1);
    const settings = await (await api('api/settings')).json() as any;
    expect(settings.compaction).toMatchObject({ enabled: true, reserveTokens: expect.any(Number), keepRecentTokens: expect.any(Number) });
    expect((await api('api/settings/compaction', { enabled: false })).status).toBe(200);
    const disabledSnapshot = await (await api('api/sessions/' + created.id)).json() as any;
    expect(disabledSnapshot.context.autoCompaction).toBe(false);
    expect((await api('api/settings/compaction', { enabled: true })).status).toBe(200);
    const enabledSnapshot = await (await api('api/sessions/' + created.id)).json() as any;
    expect(enabledSnapshot.context.autoCompaction).toBe(true);
  });

  it('serializes memory writes against other edits and model prompts', async () => {
    const { root, api } = await fixture({ model: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    const original = MemoryStore.prototype.replace;
    let release!: () => void, started = false;
    const gate = new Promise<void>((done) => { release = done; });
    vi.spyOn(MemoryStore.prototype, 'replace').mockImplementationOnce(async function (this: MemoryStore, ...args) {
      started = true; await gate; return original.apply(this, args);
    });
    const input = { project: root, session: created.id, layer: 'session', items: [{ text: 'Persist once' }] };
    const saving = api('api/memory', input);
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect((await api('api/memory', input)).status).toBe(409);
      expect((await api('api/sessions/' + created.id + '/prompt', { message: 'must wait for memory' })).status).toBe(409);
    } finally { release(); }
    expect((await saving).status).toBe(200);
    const memory = await (await api('api/memory?project=' + encodeURIComponent(root) + '&session=' + created.id)).json() as any;
    expect(memory.session.items.map((item: any) => item.text)).toEqual(['Persist once']);
  });

  it('rejects memory edits while the affected session is running', async () => {
    const { root, api } = await fixture({ model: true });
    const created = await (await api('api/session', { project: root, model: 'mock/mock' })).json() as any;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(AgentSession.prototype, 'prompt').mockImplementationOnce(async () => { await pending; });
    expect((await api('api/sessions/' + created.id + '/prompt', { message: 'hold' })).status).toBe(202);
    await vi.waitFor(async () => {
      const runningSnapshot = await (await api('api/sessions/' + created.id)).json() as any;
      expect(runningSnapshot.running).toBe(true);
    });
    expect((await api('api/memory', { project: root, session: created.id, layer: 'session', items: [{ text: 'blocked' }] })).status).toBe(409);
    release();
    await vi.waitFor(async () => {
      const finishedSnapshot = await (await api('api/sessions/' + created.id)).json() as any;
      expect(finishedSnapshot.running).toBe(false);
    });
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
    const request = await events.nextType('extension_ui_request');
    expect(request.event.type).toBe('extension_ui_request');
    const closed = await events.nextType('extension_ui_closed');
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
