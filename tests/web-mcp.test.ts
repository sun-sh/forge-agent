import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { startWebConsole } from '../src/web/server.js';
import { AgentSession } from '@earendil-works/pi-coding-agent';
// @ts-expect-error Local JavaScript fixture shared with the browser harness.
import { startOAuthFixture } from './fixtures/oauth-mcp-server.mjs';

const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-mcp-home-'));
  vi.stubEnv('FORGE_AGENT_HOME', home); vi.stubEnv('PFORGE_HOME', home); vi.stubEnv('PI_CODING_AGENT_DIR', home); vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
});
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(model = false) {
  const root = await mkdtemp(join(tmpdir(), 'forge-mcp-project-')), home = process.env['FORGE_AGENT_HOME']!;
  if (model) await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mock: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'isolated-test', models: [{ id: 'mock' }] } } }));
  const web = await startWebConsole({ cwd: root, port: 0 }); closers.push(web.close);
  const api = async (path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST') => {
    const response = await fetch(new URL(web.url).origin + '/api/' + path, { method, headers: { 'x-pforge-token': web.token, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const snapshot = async () => (await api('mcp?project=' + encodeURIComponent(root))).body;
  const save = (name: string, config: unknown, extra: Record<string, unknown> = {}) => api('mcp/servers', { project: root, name, scope: 'global', config, ...extra });
  return { root, home, api, snapshot, save, close: web.close };
}
describe('MCP Web control plane using Pi', () => {
  it('edits exact tool names and patterns with revisions, preserving inherited rules and global secrets', async () => {
    const f = await fixture();
    await f.save('tools', { url: 'https://example.com/mcp', headers: { Authorization: 'PRIVATE-TOOL-SECRET' }, toolExposure: { '*write*': 'hidden', 'read/file': 'direct' } });
    await f.save('tools', { enabled: false }, { scope: 'project', override: true });
    const item = (await f.snapshot()).servers.find((entry: any) => entry.scope === 'project');
    const input = { project: f.root, scope: 'project', revision: item.revision, changes: { 'read/file': 'deferred', 'other': 'direct' } };
    expect((await f.api('mcp/servers/tools/tools', input)).status).toBe(200);
    const stored = JSON.parse(await readFile(join(f.root, '.pi', 'mcp.json'), 'utf8')).mcpServers.tools;
    expect(stored).toEqual({ enabled: false, toolExposure: { '*write*': 'hidden', 'read/file': 'deferred', other: 'direct' } });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-TOOL-SECRET');
    expect((await f.api('mcp/servers/tools/tools', input)).status).toBe(409);
    const latest = (await f.snapshot()).servers.find((entry: any) => entry.scope === 'project');
    expect((await f.api('mcp/servers/tools/tools', { ...input, revision: latest.revision, changes: { other: null } })).status).toBe(200);
    expect((await f.api('mcp/servers/tools/tools', { ...input, revision: (await f.snapshot()).servers.find((entry: any) => entry.scope === 'project').revision, changes: { bad: 'model-only' } })).status).toBe(400);
  });
  it('reports real session state, reconnects only idle sessions, and applies per-tool hiding while remaining in Plan', async () => {
    const f = await fixture(true);
    await f.save('live', { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp-server.mjs'), join(f.root, 'called')], exposure: 'direct' });
    const session = (await f.api('session', { project: f.root, model: 'mock/mock', mode: 'plan' })).body;
    const live = async () => (await f.api('mcp/runtime?project=' + encodeURIComponent(f.root))).body.sessions[0];
    await vi.waitFor(async () => expect((await live()).servers).toContainEqual({ name: 'live', state: 'connected', toolCount: 1 }), { timeout: 15000 });
    expect((await live()).tools).toContainEqual(expect.objectContaining({ name: 'mcp__live__echo', rawName: 'echo', server: 'live' }));
    expect((await f.api('mcp/sessions/' + session.id + '/servers/live/reconnect', {})).status).toBe(200);
    const item = (await f.snapshot()).servers[0];
    expect((await f.api('mcp/servers/live/tools', { project: f.root, scope: 'global', revision: item.revision, changes: { echo: 'hidden' } })).status).toBe(200);
    await vi.waitFor(async () => expect((await live()).tools[0]?.exposure).toBe('hidden'), { timeout: 15000 });
    expect((await f.api('sessions/' + session.id)).body.mode).toBe('plan');
    await expect(access(join(f.root, 'called'))).rejects.toThrow();
  });
  it('completes browser OAuth through Pi with PKCE and keeps tokens out of every Web response', async () => {
    const f = await fixture(true), oauth = await startOAuthFixture(); closers.push(oauth.close);
    await f.save('oauth', { url: oauth.origin + '/mcp', exposure: 'direct' });
    const session = (await f.api('session', { project: f.root, model: 'mock/mock' })).body;
    const item = (await f.snapshot()).servers[0];
    const started = await f.api('mcp/servers/oauth/login', { project: f.root, scope: 'global', revision: item.revision });
    expect(started.status).toBe(202);
    const status = async () => (await f.api('mcp/auth/' + started.body.id)).body;
    let auth: any;
    await vi.waitFor(async () => { auth = await status(); expect(auth.state).toBe('waiting'); }, { timeout: 15000 });
    expect(new URL(auth.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
    expect((await f.save('blocked', { command: 'node', enabled: false })).status).toBe(409);
    expect((await f.api('projects/trust', { path: f.root, trusted: true })).status).toBe(409);
    expect((await fetch(auth.authorizationUrl)).ok).toBe(true);
    await vi.waitFor(async () => expect((await status()).state).toBe('succeeded'), { timeout: 15000 });
    expect(oauth.grants).toBe(1); expect(oauth.calls).toBe(0);
    await vi.waitFor(async () => {
      const live = (await f.api('mcp/runtime?project=' + encodeURIComponent(f.root))).body.sessions.find((entry: any) => entry.id === session.id);
      expect(live.servers).toContainEqual({ name: 'oauth', state: 'connected', toolCount: 1 });
      expect(live.tools[0].rawName).toBe('read/file');
    }, { timeout: 15000 });
    expect(JSON.stringify([await status(), await f.snapshot(), (await f.api('mcp/runtime?project=' + encodeURIComponent(f.root))).body])).not.toContain(oauth.secret);
    await access(join(f.home, 'mcp-auth.json'));
    const logout = await f.api('mcp/servers/oauth/logout', { project: f.root, scope: 'global', revision: item.revision });
    expect(logout.status).toBe(202);
    await vi.waitFor(async () => expect((await f.api('mcp/auth/' + logout.body.id)).body.state).toBe('succeeded'), { timeout: 15000 });
    await vi.waitFor(async () => expect((await f.api('mcp/runtime?project=' + encodeURIComponent(f.root))).body.sessions[0].servers[0]?.state).toBe('needs-auth'), { timeout: 15000 });
  }, 45000);
  it('cancels OAuth and closes the loopback callback on gateway shutdown', async () => {
    const f = await fixture(), oauth = await startOAuthFixture(); closers.push(oauth.close);
    await f.save('oauth', { url: oauth.origin + '/mcp' });
    let item = (await f.snapshot()).servers[0];
    const begin = () => f.api('mcp/servers/oauth/login', { project: f.root, scope: 'global', revision: item.revision });
    const first = (await begin()).body;
    await vi.waitFor(async () => expect((await f.api('mcp/auth/' + first.id)).body.state).toBe('waiting'), { timeout: 15000 });
    expect((await f.api('mcp/auth/' + first.id + '/cancel', {})).status).toBe(200);
    await vi.waitFor(async () => expect((await f.api('mcp/auth/' + first.id)).body.state).toBe('cancelled'));
    const second = (await begin()).body;
    let callback = '';
    await vi.waitFor(async () => { const state = (await f.api('mcp/auth/' + second.id)).body; expect(state.state).toBe('waiting'); callback = new URL(state.authorizationUrl).searchParams.get('redirect_uri')!; }, { timeout: 15000 });
    await f.close();
    await expect(fetch(callback)).rejects.toThrow();
    expect(oauth.grants).toBe(0);
  }, 45000);
  it('rejects an OAuth redirect from another flow without exchanging a token', async () => {
    const f = await fixture(), oauth = await startOAuthFixture(); closers.push(oauth.close);
    await f.save('oauth', { url: oauth.origin + '/mcp' });
    const item = (await f.snapshot()).servers[0];
    const started = (await f.api('mcp/servers/oauth/login', { project: f.root, scope: 'global', revision: item.revision })).body;
    let auth: any;
    await vi.waitFor(async () => { auth = (await f.api('mcp/auth/' + started.id)).body; expect(auth.state).toBe('waiting'); }, { timeout: 15000 });
    const callback = new URL(new URL(auth.authorizationUrl).searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'local-fixture-code'); callback.searchParams.set('state', 'another-flow');
    expect((await f.api('mcp/auth/' + started.id + '/redirect', { url: callback.href })).status).toBe(200);
    await vi.waitFor(async () => expect((await f.api('mcp/auth/' + started.id)).body.state).toBe('failed'));
    expect(oauth.grants).toBe(0);
  });
  it('bounds OAuth authorization time and releases configuration locks after expiry', async () => {
    const f = await fixture(), oauth = await startOAuthFixture(); closers.push(oauth.close);
    const original = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 300_000 && !expire) expire = () => handler(...args);
      return original(handler, delay, ...args);
    }) as typeof globalThis.setTimeout);
    await f.save('oauth', { url: oauth.origin + '/mcp' });
    const item = (await f.snapshot()).servers[0];
    const started = (await f.api('mcp/servers/oauth/login', { project: f.root, scope: 'global', revision: item.revision })).body;
    await vi.waitFor(async () => expect((await f.api('mcp/auth/' + started.id)).body.state).toBe('waiting'), { timeout: 15000 });
    expect(expire).toBeTypeOf('function'); expire!();
    await vi.waitFor(async () => expect((await f.api('mcp/auth/' + started.id)).body.state).toBe('timeout'));
    await vi.waitFor(async () => expect((await f.save('after-timeout', { command: 'node', enabled: false })).status).toBe(200));
    expect(oauth.grants).toBe(0);
  });
  it('requires project trust, current revisions, and an OAuth-eligible HTTP target before authorizing', async () => {
    const f = await fixture();
    await f.save('project-http', { url: 'https://example.com/mcp' }, { scope: 'project' });
    const projectItem = (await f.snapshot()).servers[0];
    expect((await f.api('mcp/servers/project-http/login', { project: f.root, scope: 'project', revision: projectItem.revision })).status).toBe(403);
    await f.save('header', { url: 'https://example.com/mcp', headers: { AUTHORIZATION: 'private-test-key' } });
    const header = (await f.snapshot()).servers.find((entry: any) => entry.name === 'header');
    expect((await f.api('mcp/servers/header/login', { project: f.root, scope: 'global', revision: 'stale' })).status).toBe(409);
    const rejected = await f.api('mcp/servers/header/login', { project: f.root, scope: 'global', revision: header.revision });
    expect(rejected.status).toBe(400); expect(JSON.stringify(rejected)).not.toContain('private-test-key');
    expect((await f.snapshot()).authorizations).toEqual([]);
  });
  it('adds stdio and HTTP services while redacting credentials and preserving unrelated JSON', async () => {
    const f = await fixture();
    await writeFile(join(f.home, 'mcp.json'), JSON.stringify({ autoEnableCodemode: false, custom: { retained: true }, mcpServers: {} }));
    expect((await f.save('local', { command: 'node', args: ['mcp.mjs'], env: { SECRET: 'private-env-value' }, enabled: false })).status).toBe(200);
    expect((await f.save('http', { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private-header-value' }, oauth: { clientId: 'public-id', clientSecret: 'private-client-secret' }, enabled: false })).status).toBe(200);
    const view = await f.snapshot();
    expect(view.servers).toHaveLength(2);
    expect(view.servers[0].config.env).toEqual([{ key: 'SECRET', configured: true }]);
    expect(view.servers[1].config.oauth).toMatchObject({ clientId: 'public-id', clientSecretConfigured: true });
    for (const secret of ['private-env-value', 'private-header-value', 'private-client-secret']) expect(JSON.stringify(view)).not.toContain(secret);
    expect(JSON.parse(await readFile(join(f.home, 'mcp.json'), 'utf8'))).toMatchObject({ autoEnableCodemode: false, custom: { retained: true } });
  });
  it('retains blank secret fields, deletes removed rows, and rejects stale updates', async () => {
    const f = await fixture();
    await f.save('local', { command: 'node', env: { KEEP: 'private-keep', REMOVE: 'private-remove' } });
    const item = (await f.snapshot()).servers[0];
    const updated = await f.save('local', { command: 'node', env: [{ key: 'KEEP', value: '' }] }, { revision: item.revision });
    expect(updated.status).toBe(200);
    const config = JSON.parse(await readFile(join(f.home, 'mcp.json'), 'utf8')).mcpServers.local;
    expect(config.env).toEqual({ KEEP: 'private-keep' });
    expect((await f.save('local', { command: 'node' }, { revision: item.revision })).status).toBe(409);
    const latest = (await f.snapshot()).servers[0];
    const toggle = await f.api('mcp/servers/local/toggle', { project: f.root, scope: 'global', enabled: false, revision: latest.revision });
    expect(toggle.status).toBe(200); expect(toggle.body.snapshot.servers[0].config.enabled).toBe(false);
    const current = toggle.body.snapshot.servers[0];
    expect((await f.api('mcp/servers/local?' + new URLSearchParams({ project: f.root, scope: 'global', revision: current.revision }), undefined, 'DELETE')).status).toBe(200);
    expect((await f.snapshot()).servers).toEqual([]);
  });
  it('uses trusted project overrides without copying global credentials into the project', async () => {
    const f = await fixture();
    await f.save('shared', { url: 'https://example.com/mcp', auth: { provider: 'github' } });
    expect((await f.save('shared', { enabled: false, exposure: 'direct' }, { scope: 'project', override: true })).status).toBe(200);
    let view = await f.snapshot();
    expect(view.projectTrusted).toBe(false);
    expect(view.servers.find((item: any) => item.scope === 'global').effective).toBe(true);
    expect(view.servers.find((item: any) => item.scope === 'project').effective).toBe(false);
    expect((await f.api('mcp/servers/shared/test', { project: f.root, scope: 'project' })).status).toBe(403);
    expect(JSON.parse(await readFile(join(f.root, '.pi', 'mcp.json'), 'utf8')).mcpServers.shared).toEqual({ enabled: false, exposure: 'direct' });
    await f.api('projects/trust', { path: f.root, trusted: true });
    view = await f.snapshot();
    expect(view.servers.find((item: any) => item.scope === 'global').effective).toBe(false);
    expect(view.servers.find((item: any) => item.scope === 'project')).toMatchObject({ effective: true, override: true, config: { enabled: false, exposure: 'direct', auth: { provider: 'github' } } });
    expect((await f.save('bad', { url: 'https://example.com/mcp', auth: { provider: 'github' } }, { scope: 'project' })).status).toBe(400);
  });
  it('clears optional fields while preserving only the hidden OAuth secret', async () => {
    const f = await fixture();
    expect((await f.save('oauth', { url: 'https://example.com/mcp', auth: { provider: 'github' }, timeout: 90, oauth: { clientId: 'old', callbackPort: 8080, clientSecret: 'PRIVATE-OAUTH' } })).status).toBe(200);
    let item = (await f.snapshot()).servers[0];
    expect((await f.save('oauth', { url: item.config.url, auth: null, timeout: null, oauth: {} }, { revision: item.revision })).status).toBe(200);
    const stored = JSON.parse(await readFile(join(f.home, 'mcp.json'), 'utf8')).mcpServers.oauth;
    expect(stored).toEqual({ url: 'https://example.com/mcp', oauth: { clientSecret: 'PRIVATE-OAUTH' } });
    item = (await f.snapshot()).servers[0];
    expect((await f.save('oauth', { oauth: { clientSecret: null } }, { revision: item.revision })).status).toBe(200);
    expect(JSON.stringify(await f.snapshot())).not.toContain('clientSecretConfigured');
  });
  it('converts a full project service into an explicit partial override without retaining project credentials', async () => {
    const f = await fixture();
    await f.save('shared', { command: 'node', enabled: false });
    await f.save('shared', { command: 'other', env: { LOCAL_SECRET: 'PROJECT-PRIVATE' }, enabled: false }, { scope: 'project' });
    const item = (await f.snapshot()).servers.find((item: any) => item.scope === 'project');
    expect((await f.save('shared', { enabled: false, exposure: 'hidden' }, { scope: 'project', override: true, revision: item.revision })).status).toBe(200);
    expect(JSON.parse(await readFile(join(f.root, '.pi', 'mcp.json'), 'utf8')).mcpServers.shared).toEqual({ enabled: false, exposure: 'hidden' });
  });
  it('requires new credential values when changing a connection target, including draft tests', async () => {
    const f = await fixture();
    await f.save('http', { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer PRIVATE-DESTINATION' } });
    const item = (await f.snapshot()).servers[0];
    const changed = { url: 'https://other.example.com/mcp', headers: [{ key: 'Authorization', value: '' }] };
    expect((await f.save('http', changed, { revision: item.revision })).status).toBe(409);
    expect((await f.api('mcp/servers/http/test', { project: f.root, scope: 'global', revision: item.revision, config: changed })).status).toBe(409);
    expect(JSON.parse(await readFile(join(f.home, 'mcp.json'), 'utf8')).mcpServers.http.url).toBe('https://example.com/mcp');
    expect((await f.save('http', { ...changed, headers: [{ key: 'Authorization', value: 'Bearer NEW-DESTINATION' }] }, { revision: item.revision })).status).toBe(200);
  });
  it.each([
    ['invalid name', { command: 'node' }],
    ['invalid', { command: '' }],
    ['invalid', { type: 'sse', url: 'https://example.com/mcp' }],
    ['invalid', { url: 'file:///private' }],
    ['invalid', { url: 'http://example.com/mcp', auth: { provider: 'github' } }],
    ['invalid', { url: 'https://example.com/mcp', oauth: { callbackUrl: 'https://example.com/callback' } }]
  ])('rejects invalid configuration through Pi (%s, %j)', async (name, config) => {
    const f = await fixture();
    expect((await f.save(name as string, config)).status).toBe(400);
    await expect(access(join(f.home, 'mcp.json'))).rejects.toThrow();
  });
  it('does not echo broken JSON credential snippets or overwrite malformed files', async () => {
    const f = await fixture(), source = '{"mcpServers":{"x":{"headers":{"Authorization":"PRIVATE-JSON-SECRET" BROKEN}}';
    await writeFile(join(f.home, 'mcp.json'), source);
    const view = await f.snapshot(); expect(view.errors).toHaveLength(1); expect(JSON.stringify(view)).not.toContain('PRIVATE-JSON-SECRET');
    const result = await f.save('safe', { command: 'node' }); expect(result.status).toBe(409); expect(JSON.stringify(result)).not.toContain('PRIVATE-JSON-SECRET');
    expect(await readFile(join(f.home, 'mcp.json'), 'utf8')).toBe(source);
  });
  it('serializes concurrent writes and preserves each service', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => f.save('fixture-' + index, { command: 'node', enabled: false })));
    expect(results.map((item) => item.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await f.snapshot()).servers).toHaveLength(5);
    expect((await f.save('fixture_0', { command: 'node' })).status).toBe(400);
  });
  it('marks a conflicting project namespace inactive in the same order as Pi', async () => {
    const f = await fixture();
    await f.save('shared-tools', { command: 'node', enabled: false });
    await f.save('shared_tools', { command: 'node', enabled: false }, { scope: 'project' });
    await f.api('projects/trust', { path: f.root, trusted: true });
    const view = await f.snapshot();
    expect(view.servers.find((item: any) => item.scope === 'global').effective).toBe(true);
    expect(view.servers.find((item: any) => item.scope === 'project')).toMatchObject({ effective: false, inactiveReason: 'conflict' });
    expect(view.errors.join('\n')).toContain('命名冲突');
    expect((await f.api('mcp/servers/shared_tools/test', { project: f.root, scope: 'project' })).status).toBe(409);
  });
  it('does not let a partial project override turn an invalid global entry into an effective service', async () => {
    const f = await fixture();
    await writeFile(join(f.home, 'mcp.json'), JSON.stringify({ mcpServers: { invalid: { command: 'node', exposure: 'invalid' } } }));
    expect((await f.save('invalid', { exposure: 'direct' }, { scope: 'project', override: true })).status).toBe(400);
    await mkdir(join(f.root, '.pi'), { recursive: true });
    await writeFile(join(f.root, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { invalid: { exposure: 'direct' } } }));
    await f.api('projects/trust', { path: f.root, trusted: true });
    const view = await f.snapshot();
    expect(view.servers).toEqual([]); expect(view.errors.length).toBeGreaterThanOrEqual(2);
  });
  it('tests stdio through Pi without a model request and terminates the child after probing', async () => {
    const f = await fixture(), marker = join(f.root, 'called'), pidFile = join(f.root, 'pid');
    await f.save('fixture', { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp-server.mjs'), marker, pidFile], exposure: 'direct' });
    const result = await f.api('mcp/servers/fixture/test', { project: f.root, scope: 'global' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'connected', tools: [{ name: 'mcp__fixture__echo' }] });
    const pid = Number(await readFile(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10000 });
    await expect(access(marker)).rejects.toThrow();
    expect((await f.snapshot()).servers[0].probe.status).toBe('connected');
  });
  it('connects a resource-only HTTP service and sends saved secret headers through Pi', async () => {
    const f = await fixture(), observed: string[] = [];
    const upstream = createServer(async (request, response) => {
      observed.push(request.headers['x-fixture-secret'] as string);
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = raw ? JSON.parse(raw) : {};
      if (input.id === undefined) { response.writeHead(202).end(); return; }
      const result = input.method === 'initialize' ? { protocolVersion: input.params.protocolVersion, capabilities: { resources: {} }, serverInfo: { name: 'resources-only', version: '1' } } : {};
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    closers.push(() => new Promise<void>((done) => { upstream.close(() => done()); upstream.closeAllConnections(); }));
    const port = (upstream.address() as { port: number }).port;
    await f.save('resources', { url: 'http://127.0.0.1:' + port + '/mcp', headers: { 'x-fixture-secret': 'PRIVATE-HTTP-SECRET' } });
    const result = await f.api('mcp/servers/resources/test', { project: f.root, scope: 'global' });
    expect(result.body).toMatchObject({ status: 'connected', tools: [] }); expect(observed).toContain('PRIVATE-HTTP-SECRET');
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE-HTTP-SECRET');
  });
  it('classifies failed connections without exposing stderr credentials', async () => {
    const f = await fixture();
    await f.save('failed', { command: process.execPath, args: ['-e', 'process.stderr.write(process.env.TOP_SECRET);process.exit(1)'], env: { TOP_SECRET: 'SECRET-IN-STDERR' }, timeout: 0.3 });
    const result = await f.api('mcp/servers/failed/test', { project: f.root, scope: 'global' });
    expect(result.body.status).toBe('failed'); expect(JSON.stringify(result.body)).not.toContain('SECRET-IN-STDERR');
  });
  it('loads saved MCP into existing idle Pi sessions and closes it when disabled', async () => {
    const f = await fixture(true);
    await f.api('projects/trust', { path: f.root, trusted: true });
    const session = (await f.api('session', { project: f.root, model: 'mock/mock' })).body;
    const pidFile = join(f.root, 'live-pid');
    await f.save('live', { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp-server.mjs'), join(f.root, 'called'), pidFile], exposure: 'direct' });
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0); });
    const item = (await f.snapshot()).servers[0];
    expect((await f.api('mcp/servers/live/toggle', { project: f.root, scope: 'global', revision: item.revision, enabled: false })).status).toBe(200);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10000 });
    expect((await f.api('sessions/' + session.id)).body).toMatchObject({ id: session.id, readOnly: false, mode: 'agent' });
  });
  it('locks session changes and trust while applying configuration, then closes after the reload', async () => {
    const f = await fixture(true);
    const session = (await f.api('session', { project: f.root, model: 'mock/mock' })).body;
    const original = AgentSession.prototype.reload;
    let release!: () => void, entered = false;
    const gate = new Promise<void>((done) => { release = done; });
    vi.spyOn(AgentSession.prototype, 'reload').mockImplementation(async function(this: AgentSession) { entered = true; await gate; return original.call(this); });
    const saving = f.save('disabled', { command: 'node', enabled: false });
    await vi.waitFor(() => expect(entered).toBe(true));
    try {
      expect((await f.api('projects/trust', { path: f.root, trusted: true })).status).toBe(409);
      expect((await f.api('session', { project: f.root })).status).toBe(409);
      for (const action of ['prompt', 'mode', 'model', 'compact']) expect((await f.api('sessions/' + session.id + '/' + action, { message: 'blocked', mode: 'plan', model: 'mock/mock' })).status).toBe(409);
      expect((await f.api('credentials', { provider: 'mock', apiKey: 'blocked' })).status).toBe(409);
      const closing = f.close();
      release();
      expect((await saving).status).toBe(200);
      await closing;
    } finally { release(); await saving; }
  });
  it('cancels a pending probe on shutdown and prevents configuration or trust changes during a probe', async () => {
    const f = await fixture();
    const pidFile = join(f.root, 'hanging-pid');
    await f.save('hanging', { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', pidFile], timeout: 60 });
    const testing = f.api('mcp/servers/hanging/test', { project: f.root, scope: 'global' });
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0); });
    expect((await f.save('blocked', { command: 'node', enabled: false })).status).toBe(409);
    expect((await f.api('projects/trust', { path: f.root, trusted: true })).status).toBe(409);
    expect((await f.api('providers/custom', {})).status).toBe(409);
    await f.close();
    expect((await testing).body.status).toBe('timeout');
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10000 });
  });
});
