import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CustomProviders, normalizeProviderUrl } from '../src/web/providers.js';
import { startWebConsole } from '../src/web/server.js';

let home: string, project: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pforge-provider-home-'));
  project = await mkdtemp(join(tmpdir(), 'pforge-provider-project-'));
  vi.stubEnv('FORGE_AGENT_HOME', home); vi.stubEnv('PFORGE_HOME', home); vi.stubEnv('PI_CODING_AGENT_DIR', home); vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
});
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}
async function gateway() {
  const server = await startWebConsole({ cwd: project, port: 0 }); closers.push(server.close);
  const origin = new URL(server.url).origin;
  const request = async (path: string, input?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { 'x-pforge-token': server.token, 'content-type': 'application/json', ...extraHeaders }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { server, origin, request };
}
function service(baseUrl = 'http://127.0.0.1:9/v1', more: Record<string, unknown> = {}) {
  return { id: 'third-party', name: 'My gateway', baseUrl, api: 'openai-completions', apiKey: 'literal-test-key', models: [{ id: 'coder', name: 'Coder', contextWindow: 32000, maxTokens: 4096 }], ...more };
}
async function providers() {
  const runtime = await ModelRuntime.create({ modelsPath: join(home, 'models.json'), authPath: join(home, 'auth.json') });
  return { runtime, editor: new CustomProviders(home, runtime) };
}
async function mockService() {
  const requests: Array<{ path: string; auth: string | undefined; body: any }> = [];
  const origin = await listen(createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url || '', auth: request.headers.authorization || request.headers['x-api-key'] as string | undefined, body: JSON.parse(raw || '{}') });
    const route = request.url?.split('?')[0] || '';
    if (route.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'coder', name: 'Coder' }, { id: 'coder' }, { id: 'other-model' }] })); return; }
    if (route.endsWith('/chat/completions')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of [{ delta: { role: 'assistant', content: 'OK from custom provider.' } }, { delta: {}, finish_reason: 'stop' }]) response.write('data: ' + JSON.stringify({ id: 'custom-test', object: 'chat.completion.chunk', created: 1, model: 'coder', choices: [{ index: 0, ...chunk }] }) + '\n\n');
      response.end('data: [DONE]\n\n'); return;
    }
    if (route.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const message = { type: 'message', id: 'message-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      const result = { id: 'response-1', object: 'response', created_at: 1, status: 'completed', model: 'coder', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      for (const event of [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'OK' }, { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response: result }]) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end(); return;
    }
    if (route.endsWith('/messages')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', content: [], model: 'coder', usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: null, stop_sequence: null } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end(); return;
    }
    response.writeHead(404).end();
  }));
  return { origin, requests };
}

describe('Pi third-party provider configuration', () => {
  it('does not offer or execute built-in models enabled only by inherited environment credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-test-key');
    const web = await gateway();
    const catalog = (await web.request('/api/models')).body;
    const inherited = catalog.models.find((item: any) => item.provider === 'anthropic');
    expect(inherited).toBeDefined();
    expect(inherited.available).toBe(false);
    expect(catalog.providers.find((item: any) => item.id === 'anthropic').auth).toMatchObject({ configured: false, hasCredential: false });
    expect((await web.request('/api/settings')).body).toMatchObject({ models: [], model: null });
    expect((await web.request('/api/settings', { model: inherited.key })).status).toBe(400);
    expect((await web.request('/api/session', { project, model: inherited.key })).status).toBe(503);
    expect((await web.request('/api/session', { requestId: 'unconfigured-first-message' })).status).toBe(503);
    expect(await readdir(home)).not.toContain('projects');
    expect(await readFile(join(home, 'auth.json'), 'utf8').catch(() => '')).not.toContain('inherited-test-key');
  });

  it('keeps configured models across refresh and restart without selecting inherited defaults', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-test-key');
    await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { 'third-party': {
      baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'explicit-test-key', models: [{ id: 'coder-a' }, { id: 'coder-b' }, { id: 'coder-c' }]
    } } }));
    const web = await gateway();
    const inherited = (await web.request('/api/models')).body.models.find((item: any) => item.provider === 'anthropic');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: inherited.id }));
    const expected = ['third-party/coder-a', 'third-party/coder-b', 'third-party/coder-c'];
    const settings = (await web.request('/api/settings')).body;
    expect(settings.models.map((item: any) => item.key)).toEqual(expected);
    expect(settings.model).toBe(expected[0]);
    const session = await web.request('/api/session', { project });
    expect(session.status).toBe(201);
    expect(session.body.model.provider).toBe('third-party');
    expect((await web.request('/api/session', { project, model: inherited.key })).status).toBe(409);
    expect((await web.request('/api/sessions/' + session.body.id + '/model', { model: inherited.key })).status).toBe(400);
    const originalRefresh = ModelRuntime.prototype.refresh;
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh').mockImplementation(function (this: ModelRuntime, options) {
      return originalRefresh.call(this, { ...options, allowNetwork: false });
    });
    expect((await web.request('/api/models/refresh', {})).body.models.map((item: any) => item.key)).toEqual(expected);
    expect(refresh.mock.calls.find(([options]) => options?.force)?.[0]?.providers).toEqual(['third-party']);
    refresh.mockRestore();
    await web.server.close();
    const restarted = await gateway();
    expect((await restarted.request('/api/settings')).body.models.map((item: any) => item.key)).toEqual(expected);
  });

  it('preserves explicitly configured environment references in models.json', async () => {
    vi.stubEnv('FORGE_EXPLICIT_TEST_KEY', 'explicit-environment-test-key');
    await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { 'third-party': {
      baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: '$FORGE_EXPLICIT_TEST_KEY', models: [{ id: 'coder' }]
    } } }));
    const web = await gateway();
    const settings = (await web.request('/api/settings')).body;
    expect(settings.models.map((item: any) => item.key)).toEqual(['third-party/coder']);
    expect(settings.providers.find((item: any) => item.id === 'third-party').auth.configured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('explicit-environment-test-key');
  });

  it('enables deliberately saved built-in credentials and removes their models after logout even if environment keys remain', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-test-key');
    const web = await gateway();
    const saved = await web.request('/api/credentials', { provider: 'anthropic', apiKey: 'explicitly-saved-test-key' });
    expect(saved.status).toBe(200);
    expect(saved.body.models.some((item: any) => item.provider === 'anthropic')).toBe(true);
    const response = await fetch(web.origin + '/api/credentials?provider=anthropic', { method: 'DELETE', headers: { 'x-pforge-token': web.server.token } });
    expect(response.status).toBe(200);
    expect((await response.json() as any).models).toEqual([]);
    expect((await web.request('/api/settings')).body.models).toEqual([]);
  });

  it('retains explicit discovery metadata and offers exact catalog templates without guessing capabilities from names', async () => {
    const map = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null };
    const origin = await listen(createServer((_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [
      { id: 'declared-reasoner', reasoning: true, thinkingLevelMap: map, input: ['text', 'image'], contextWindow: 64000, maxTokens: 8000, headers: { 'x-private': 'never-return-me' } },
      { id: 'unknown-thinking-reasoning-model' },
      { id: 'deepseek/deepseek-v4.1-flash' }
    ] }))));
    const web = await gateway(), config = service(origin + '/v1');
    const discovered = await web.request('/api/providers/discover', config);
    expect(discovered.status).toBe(200);
    expect(discovered.body.models.find((model: any) => model.id === 'declared-reasoner')).toMatchObject({ reasoning: true, thinkingLevelMap: map, input: ['text', 'image'], contextWindow: 64000, maxTokens: 8000 });
    expect(discovered.body.models.find((model: any) => model.id === 'unknown-thinking-reasoning-model').reasoning).toBeUndefined();
    const exact = discovered.body.models.find((model: any) => model.id === 'deepseek/deepseek-v4.1-flash');
    expect(exact.reasoning).toBeUndefined();
    expect(exact.capabilityTemplates).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'openrouter', reasoning: true })]));
    expect(JSON.stringify(discovered.body)).not.toContain('never-return-me');
    expect((await web.request('/api/providers/custom', { ...config, models: [discovered.body.models.find((model: any) => model.id === 'declared-reasoner')] })).status).toBe(200);
    const listed = await web.request('/api/providers/custom');
    expect(listed.body.providers[0].models[0]).toMatchObject({ reasoning: true, thinkingLevelMap: map });
    await web.server.close(); const restarted = await gateway();
    const model = (await restarted.request('/api/settings')).body.models.find((item: any) => item.id === 'declared-reasoner');
    expect(model.thinkingLevels).toEqual(['low', 'high']);
    expect(model.thinkingLevelMap).toEqual(map);
  });

  it('rejects malformed or empty reasoning mappings without writing provider or credential files', async () => {
    const web = await gateway();
    for (const thinkingLevelMap of [[], { invented: 'high' }, { high: { injected: true } }, { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null }]) {
      const result = await web.request('/api/providers/custom', service(undefined, { models: [{ id: 'coder', reasoning: true, thinkingLevelMap }] }));
      expect(result.status).toBe(400);
    }
    expect(await readFile(join(home, 'models.json'), 'utf8').catch(() => '')).toBe('');
    expect(await readFile(join(home, 'auth.json'), 'utf8').catch(() => '')).not.toContain('literal-test-key');
  });

  it.each(['openai-responses', 'anthropic-messages'])('discovers and invokes %s through Pi with its protocol-specific URL and authentication', async (api) => {
    const mock = await mockService(); const web = await gateway();
    const config = service(mock.origin + '/v1', { api });
    expect((await web.request('/api/providers/discover', config)).status).toBe(200);
    const tested = await web.request('/api/providers/test', { ...config, model: config.models[0] });
    expect(tested).toMatchObject({ status: 200, body: { ok: true } });
    expect(mock.requests.map((request) => request.path.split('?')[0])).toEqual(api === 'anthropic-messages' ? ['/v1/models', '/v1/messages'] : ['/v1/models', '/v1/responses']);
    expect(mock.requests.every((request) => request.auth === (api === 'anthropic-messages' ? config.apiKey : 'Bearer ' + config.apiKey))).toBe(true);
  });
  it('discovers, tests, saves and immediately uses a custom model through Pi, including after restart', async () => {
    const mock = await mockService();
    const web = await gateway();
    const config = service(mock.origin + '/v1/chat/completions');
    expect(await web.request('/api/providers/discover', config)).toMatchObject({ status: 200, body: { models: [{ id: 'coder' }, { id: 'other-model' }], baseUrl: mock.origin + '/v1' } });
    expect(await web.request('/api/providers/test', { ...config, model: config.models[0] })).toMatchObject({ status: 200, body: { ok: true, model: 'coder' } });
    expect((await readdir(home)).some((path) => path.startsWith('.models-'))).toBe(false);
    expect(await readFile(join(home, 'auth.json'), 'utf8').catch(() => '')).not.toContain(config.apiKey);
    const saved = await web.request('/api/providers/custom', config);
    expect(saved).toMatchObject({ status: 200, body: { id: config.id, baseUrl: mock.origin + '/v1' } });
    expect(JSON.stringify(saved.body)).not.toContain(config.apiKey);
    const models = await web.request('/api/settings');
    expect(models.body.models).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'third-party/coder', available: true })]));
    await web.request('/api/settings', { model: 'third-party/coder', thinkingLevel: 'off' });
    expect(await readFile(join(home, 'models.json'), 'utf8')).not.toContain(config.apiKey);
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toMatchObject({ 'third-party': { type: 'api_key', key: config.apiKey } });
    const created = await web.request('/api/session', { project, model: 'third-party/coder' });
    expect(created.status).toBe(201);
    expect((await web.request('/api/sessions/' + created.body.id + '/prompt', { message: 'Say OK' })).status).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await web.request('/api/sessions/' + created.body.id + '/state');
      expect(snapshot.body.running).toBe(false);
      expect(snapshot.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'OK from custom provider.' })]) })]));
    }, { timeout: 15000 });
    expect(mock.requests.filter((request) => request.path.endsWith('/chat/completions'))).toHaveLength(2);
    expect(mock.requests.every((request) => request.auth === 'Bearer ' + config.apiKey)).toBe(true);
    await web.server.close();
    const restarted = await gateway();
    expect((await restarted.request('/api/settings')).body).toMatchObject({ model: 'third-party/coder', models: expect.arrayContaining([expect.objectContaining({ key: 'third-party/coder' })]) });
  });

  it('keeps API keys literal, including a leading !, and omits all credentials and advanced headers from responses', async () => {
    const { origin, requests } = await mockService();
    const web = await gateway();
    const config = service(origin + '/v1', { apiKey: '!this-is-a-literal-key' });
    expect((await web.request('/api/providers/custom', config)).status).toBe(200);
    const stored = JSON.parse(await readFile(join(home, 'models.json'), 'utf8'));
    stored.providers['third-party'].headers = { 'x-secret': 'hidden-header-value' };
    await writeFile(join(home, 'models.json'), JSON.stringify(stored));
    const list = await web.request('/api/providers/custom');
    expect(JSON.stringify(list.body)).not.toContain(config.apiKey);
    expect(JSON.stringify(list.body)).not.toContain('hidden-header-value');
    expect((await web.request('/api/providers/discover', { ...config, apiKey: '' })).status).toBe(200);
    expect(requests[0]?.auth).toBe('Bearer ' + config.apiKey);
  });

  it('preserves comments, other providers and advanced Pi model fields while editing', async () => {
    const source = '{\n // personal models\n "providers": {\n  "third-party": {"baseUrl":"http://127.0.0.1:9/v1","api":"openai-completions","apiKey":"$CUSTOM_API_KEY","compat":{"supportsStore":false},"models":[{"id":"coder","samplingParams":{"temperature":0.5},"cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}}]},\n // keep this provider\n "other": {"baseUrl":"http://localhost:9/v1","api":"openai-completions","apiKey":"other","models":[{"id":"local"}]}\n }}';
    await writeFile(join(home, 'models.json'), source);
    const { editor } = await providers();
    const existing = (await editor.list()).find((provider) => provider.id === 'third-party')!;
    await editor.save(service(undefined, { revision: existing.revision }));
    const saved = await readFile(join(home, 'models.json'), 'utf8');
    expect(saved).toContain('// personal models'); expect(saved).toContain('// keep this provider');
    expect(parseJsonc(saved).providers['third-party']).toMatchObject({ apiKey: '$CUSTOM_API_KEY', compat: { supportsStore: false }, models: [expect.objectContaining({ samplingParams: { temperature: 0.5 }, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })] });
    expect(saved).toContain('"other": {"baseUrl":"http://localhost:9/v1"');
    expect((await editor.list()).find((provider) => provider.id === 'third-party')?.models[0]).toMatchObject({ id: 'coder', contextWindow: 32000 });
  });

  it('rejects malformed existing configuration, invalid inputs and built-in collisions without changing files', async () => {
    const web = await gateway();
    for (const change of [{ id: 'openai' }, { id: '__proto__' }, { baseUrl: 'file:///tmp/models' }, { baseUrl: 'https://example.com/v1?key=hidden' }, { models: [{ id: 'coder', maxTokens: -1 }] }, { models: [{ id: 'same' }, { id: 'same' }] }, { api: 'invented-api' }]) {
      expect([400, 409]).toContain((await web.request('/api/providers/custom', service(undefined, change))).status);
    }
    expect(await readFile(join(home, 'models.json'), 'utf8').catch(() => '')).toBe('');
    await writeFile(join(home, 'models.json'), '{ broken config // must stay');
    expect((await web.request('/api/providers/custom', service())).status).toBe(409);
    expect(await readFile(join(home, 'models.json'), 'utf8')).toBe('{ broken config // must stay');
    expect((await web.request('/api/providers/custom')).status).toBe(409);
  });

  it('serializes concurrent provider saves and detects stale edits', async () => {
    const { editor, runtime } = await providers();
    await Promise.all([editor.save(service(undefined, { id: 'first' })), editor.save(service(undefined, { id: 'second' }))]);
    expect((await editor.list()).map((provider) => provider.id).sort()).toEqual(['first', 'second']);
    await runtime.refresh({ allowNetwork: false });
    expect((await runtime.getAvailable()).filter((model) => model.provider === 'first' || model.provider === 'second')).toHaveLength(2);
    const original = (await editor.list()).find((provider) => provider.id === 'first')!;
    await editor.save(service(undefined, { id: 'first', revision: original.revision, name: 'Updated' }));
    await expect(editor.save(service(undefined, { id: 'first', revision: original.revision, name: 'Stale' }))).rejects.toMatchObject({ status: 409 });
    expect((await editor.list()).find((provider) => provider.id === 'first')?.name).toBe('Updated');
  });

  it('never sends an existing key to a changed endpoint or through a redirect', async () => {
    const mock = await mockService(); let forwarded = 0;
    const destination = await listen(createServer((_request, response) => { forwarded++; response.writeHead(200).end('{"data":[{"id":"coder"}]}'); }));
    const redirect = await listen(createServer((_request, response) => { response.writeHead(307, { location: destination + '/models' }).end(); }));
    const web = await gateway(); const config = service(mock.origin + '/v1');
    expect((await web.request('/api/providers/custom', config)).status).toBe(200);
    const existing = (await web.request('/api/providers/custom')).body.providers[0];
    const changed = { ...config, baseUrl: destination + '/v1', apiKey: '', revision: existing.revision };
    expect((await web.request('/api/providers/discover', changed)).status).toBe(400);
    expect((await web.request('/api/providers/test', { ...changed, model: config.models[0] })).status).toBe(400);
    expect((await web.request('/api/providers/custom', changed)).status).toBe(400);
    expect((await web.request('/api/providers/discover', { ...config, baseUrl: redirect + '/v1' })).status).toBe(502);
    expect((await web.request('/api/providers/test', { ...config, baseUrl: redirect + '/v1', model: config.models[0] })).status).toBe(502);
    expect(forwarded).toBe(0);
    expect((await web.request('/api/providers/custom')).body.providers[0].baseUrl).toBe(mock.origin + '/v1');
  });

  it('supports explicit local keyless services and manual models when discovery is unavailable', async () => {
    const origin = await listen(createServer((_request, response) => response.writeHead(404).end('secret-that-must-not-be-echoed')));
    const web = await gateway(); const config = service(origin + '/v1', { noKey: true, apiKey: '' });
    const discovery = await web.request('/api/providers/discover', config);
    expect(discovery.status).toBe(502); expect(JSON.stringify(discovery.body)).not.toContain('secret-that-must-not-be-echoed');
    expect((await web.request('/api/providers/custom', config)).status).toBe(200);
    expect((await web.request('/api/providers/custom')).body.providers[0]).toMatchObject({ noKey: true, authConfigured: true });
    expect((await web.request('/api/settings')).body.models).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'third-party/coder' })]));
    const existing = (await web.request('/api/providers/custom')).body.providers[0];
    expect((await web.request('/api/providers/custom', { ...config, noKey: false, revision: existing.revision })).status).toBe(400);
  });

  it('reports an upstream HTTP failure without echoing a credential or error response body', async () => {
    const origin = await listen(createServer((_request, response) => response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'literal-test-key private upstream detail', type: 'invalid_request_error' } }))));
    const web = await gateway(); const config = service(origin + '/v1');
    const failed = await web.request('/api/providers/test', { ...config, model: config.models[0] });
    expect(failed.status).toBe(502); expect(failed.body.error).toContain('HTTP 401');
    expect(JSON.stringify(failed.body)).not.toContain(config.apiKey); expect(JSON.stringify(failed.body)).not.toContain('private upstream detail');
  });

  it('requires local Web authorization and rejects cross-origin writes for every new endpoint', async () => {
    const web = await gateway();
    for (const path of ['/api/providers/custom', '/api/providers/discover', '/api/providers/test']) {
      expect((await fetch(web.origin + path, { method: 'POST', body: JSON.stringify(service()) })).status).toBe(401);
      expect((await web.request(path, service(), { origin: 'https://other.example' })).status).toBe(403);
    }
    expect((await fetch(web.origin + '/api/providers/custom')).status).toBe(401);
  });

  it('does not change connections or credentials while a Pi task is running', async () => {
    let arrived = false;
    const streams: import('node:http').ServerResponse[] = [];
    const origin = await listen(createServer((request, response) => { if (request.url?.endsWith('/chat/completions')) { arrived = true; streams.push(response); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); } else response.writeHead(404).end(); }));
    closers.push(async () => { streams.forEach((response) => response.end()); });
    const web = await gateway(); const config = service(origin + '/v1');
    expect((await web.request('/api/providers/custom', config)).status).toBe(200);
    const created = await web.request('/api/session', { project, model: 'third-party/coder' });
    expect((await web.request('/api/sessions/' + created.body.id + '/prompt', { message: 'wait' })).status).toBe(202);
    await vi.waitFor(() => expect(arrived).toBe(true));
    const original = await readFile(join(home, 'models.json'), 'utf8');
    expect((await web.request('/api/providers/custom', service(undefined, { id: 'another-provider' }))).status).toBe(409);
    expect((await web.request('/api/credentials', { provider: 'third-party', apiKey: 'changed-while-running' })).status).toBe(409);
    expect(await readFile(join(home, 'models.json'), 'utf8')).toBe(original);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).not.toContain('changed-while-running');
    expect((await web.request('/api/sessions/' + created.body.id + '/abort', {})).status).toBe(200);
  });

  it('refreshes idle session endpoints together with credentials and makes a removed model read-only', async () => {
    const previous = await mockService(), replacement = await mockService();
    const web = await gateway(); const config = service(previous.origin + '/v1');
    expect((await web.request('/api/providers/custom', config)).status).toBe(200);
    const created = await web.request('/api/session', { project, model: 'third-party/coder' });
    expect(created.status).toBe(201);
    const existing = (await web.request('/api/providers/custom')).body.providers[0];
    expect((await web.request('/api/providers/custom', { ...config, baseUrl: replacement.origin + '/v1', apiKey: 'replacement-only-key', revision: existing.revision })).status).toBe(200);
    expect((await web.request('/api/sessions/' + created.body.id + '/prompt', { message: 'use the updated connection' })).status).toBe(202);
    await vi.waitFor(async () => { expect((await web.request('/api/sessions/' + created.body.id + '/state')).body.running).toBe(false); });
    expect(previous.requests).toHaveLength(0);
    expect(replacement.requests).toEqual([expect.objectContaining({ path: '/v1/chat/completions', auth: 'Bearer replacement-only-key' })]);
    const changed = (await web.request('/api/providers/custom')).body.providers[0];
    expect((await web.request('/api/providers/custom', { ...config, baseUrl: replacement.origin + '/v1', apiKey: '', revision: changed.revision, models: [{ id: 'other-model' }] })).status).toBe(200);
    expect((await web.request('/api/sessions/' + created.body.id + '/state')).body).toMatchObject({ model: null, readOnly: true });
    expect((await web.request('/api/sessions/' + created.body.id + '/prompt', { message: 'must choose a model' })).status).toBe(409);
  });

  it('rolls back Pi credentials and retains the original file if saving cannot commit', async () => {
    const { editor, runtime } = await providers();
    await editor.save(service());
    const original = await readFile(join(home, 'models.json'), 'utf8');
    const existing = (await editor.list())[0]!;
    let calls = 0;
    await expect(editor.save(service(undefined, { apiKey: 'changed-key', revision: existing.revision }), () => { if (++calls === 3) throw new Error('commit deliberately cancelled'); })).rejects.toMatchObject({ status: 500 });
    expect(await readFile(join(home, 'models.json'), 'utf8')).toBe(original);
    expect((await runtime.getAuth('third-party'))?.auth.apiKey).toBe('literal-test-key');
    expect((await readdir(home)).some((path) => path.startsWith('.models-'))).toBe(false);
    calls = 0;
    await expect(editor.save(service(undefined, { id: 'new-uncommitted-provider' }), () => { if (++calls === 3) throw new Error('commit deliberately cancelled'); })).rejects.toMatchObject({ status: 500 });
    expect(await readFile(join(home, 'auth.json'), 'utf8')).not.toContain('new-uncommitted-provider');
    expect(await readFile(join(home, 'models.json'), 'utf8')).toBe(original);
  });

  it('normalizes protocol-specific endpoint URLs', () => {
    expect(normalizeProviderUrl('https://example.com/v1/chat/completions', 'openai-completions')).toBe('https://example.com/v1');
    expect(normalizeProviderUrl('https://example.com/v1/responses', 'openai-responses')).toBe('https://example.com/v1');
    expect(normalizeProviderUrl('https://example.com/proxy/v1/messages', 'anthropic-messages')).toBe('https://example.com/proxy');
  });
});
