import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { readFile } from 'node:fs/promises';
import { safeMarkdown, sessionOutcome } from '../src/web/ui/render.js';
import { createSseParser, readEventStream, StreamError } from '../src/web/ui/stream.js';
import { mountCustomProviders } from '../src/web/ui/providers.js';

const windows = [];
afterEach(() => { windows.splice(0).forEach((window) => { window.__app?.state.eventSource?.close(); window.close(); }); vi.unstubAllGlobals(); });

describe('safe agent output', () => {
  it('formats code and tables while treating HTML, CSS impersonation and remote images as untrusted source', () => {
    const dom = new JSDOM(''); windows.push(dom.window);
    const output = safeMarkdown('## Result\n\n**safe**\n\n```diff\n+added\n-removed\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n<p class="modal">fake</p>\n\n![remote](https://example.com/tracker)\n\n[bad](javascript:alert(1)) [good](https://example.com)', marked, createDOMPurify(dom.window));
    const node = dom.window.document.createElement('div'); node.innerHTML = output;
    expect(node.querySelector('h2')?.textContent).toBe('Result');
    expect(node.querySelector('code.language-diff')?.textContent).toContain('+added');
    expect(node.querySelector('table')).toBeTruthy();
    expect(node.querySelector('script, img, .modal, [onclick], [style]')).toBeNull();
    expect([...node.querySelectorAll('a[href]')].map((a) => a.href)).toEqual(['https://example.com/']);
    expect(node.textContent).toContain('<script>');
  });

  it('keeps failed verification, model errors and aborted runs distinct from successful completion', () => {
    expect(sessionOutcome({ outcome: 'completed', verification: { status: 'failed' } })).toMatchObject({ kind: 'failed' });
    expect(sessionOutcome({ outcome: 'completed', error: 'bad key' })).toMatchObject({ kind: 'failed' });
    expect(sessionOutcome({ outcome: 'aborted', verification: { status: 'passed' } }).label).toBe('已停止');
    expect(sessionOutcome({ outcome: 'completed', verification: { status: 'unchecked' } }).label).toContain('未配置自动验证');
    expect(sessionOutcome({ outcome: 'completed', verification: { status: 'passed' } })).toMatchObject({ kind: 'done' });
    expect(sessionOutcome({ outcome: 'completed', mode: 'plan', runMode: 'agent', verification: { status: 'passed' } }).label).toContain('验证通过');
    expect(sessionOutcome({ outcome: 'completed', mode: 'agent', runMode: 'plan', verification: { status: 'skipped' } }).label).toContain('可发送执行指令');
  });
});

describe('SSE transport', () => {
  it('parses split frames, CRLF, comments and multiple data lines', () => {
    const events = [];
    const parse = createSseParser((event) => events.push(event));
    parse(': heartbeat\r\nid: 7\r\ndata: first\r');
    parse('\ndata: second\r\n\r\nid: 8\ndata: next\n');
    expect(events).toEqual([{ id: '7', data: 'first\nsecond' }]);
    parse('\n');
    expect(events[1]).toEqual({ id: '8', data: 'next' });
  });

  it('uses authentication and resume headers without putting the token in the stream URL', async () => {
    const events = [];
    const fetcher = vi.fn(async () => new Response('id: 11\ndata: {"ok":true}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    await readEventStream('/api/sessions/abc/events', 'test-token', { after: 10, onEvent: (event) => events.push(event) });
    expect(fetcher.mock.calls[0]).toEqual(['/api/sessions/abc/events', expect.objectContaining({ headers: expect.objectContaining({ 'x-pforge-token': 'test-token', 'last-event-id': '10' }) })]);
    expect(events).toEqual([{ id: '11', data: '{"ok":true}' }]);
  });
});

const model = (id, extra = {}) => ({ key: 'mock/' + id, id, name: id, provider: 'mock', providerName: 'Mock', available: true, input: ['text'], reasoning: false, thinkingLevels: ['off'], contextWindow: 8000, ...extra });
async function client(initial = {}) {
  const html = await readFile(new URL('../src/web/ui/index.html', import.meta.url), 'utf8');
  const source = (await readFile(new URL('../src/web/ui/app.js', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gm, '');
  const dom = new JSDOM(html, { url: 'http://localhost:4328/?token=bootstrap-secret', runScripts: 'outside-only' });
  const window = dom.window; windows.push(window);
  const models = initial.models || [model('a'), model('b')];
  let defaultModel = initial.model || models[0]?.key || null;
  let thinkingLevel = initial.thinkingLevel || 'off';
  const modelThinkingLevels = { ...initial.modelThinkingLevels };
  const streams = [], requests = [];
  Object.assign(window, {
    marked, DOMPurify: createDOMPurify(window), StreamError, mountCustomProviders,
    safeMarkdown, textContent: (content) => typeof content === 'string' ? content : (content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'), sessionOutcome,
    readEventStream: (_url, _token, options) => { streams.push(options); return new Promise((resolve) => options.signal.addEventListener('abort', resolve)); },
    fetch: async (url, init = {}) => {
      requests.push({ url, ...init });
      let data = {};
      if (url.startsWith('/api/settings')) {
        if (init.method === 'POST') {
          const input = JSON.parse(init.body); defaultModel = input.model;
          const selected = models.find((item) => item.key === defaultModel);
          thinkingLevel = selected?.reasoning ? input.thinkingLevel || modelThinkingLevels[defaultModel] || 'medium' : 'off';
          if (input.thinkingLevel) modelThinkingLevels[defaultModel] = thinkingLevel;
        }
        data = { models, model: defaultModel, thinkingLevel, modelThinkingLevels, allModelCount: models.length, providers: [{ id: 'mock', name: 'Mock', availableModelCount: models.length, modelCount: models.length, auth: { configured: true } }] };
      }
      if (url === '/api/projects') data = { projects: [{ path: 'C:\\repo', name: 'repo' }] };
      if (url.startsWith('/api/projects/trust')) data = { trust: { trusted: true } };
      if (url.startsWith('/api/history')) data = { projects: [] };
      if (url.startsWith('/api/config')) data = { cwd: 'C:\\repo', verify: [], piVersion: '1.4.0' };
      if (url === '/api/credentials') data = { credentials: [] };
      if (url === '/api/session') { const input = JSON.parse(init.body); data = { id: 'created', project: 'C:\\repo', running: false, model: models.find((item) => item.key === input.model) || models[0], thinkingLevel: input.thinkingLevel || thinkingLevel, messages: [] }; }
      return { ok: true, status: 200, json: async () => data };
    }
  });
  // Exercise the actual browser entry point against an isolated DOM and API, including all event bindings.
  window.eval(source + '\nwindow.__app = { state, api, loadConfig, loadModels, resumeActiveSession, recoverAuthorization, openSettings, connect, applySnapshot, renderMessages, setModel, changeMode, changeModel, changeThinking, toggleModelPicker, closeModelPicker, setRunning, createSession, sendPrompt, sendFollowup, newConversation };');
  await vi.waitFor(() => expect(window.document.getElementById('connection-label').textContent).toContain('已连接'));
  return { window, app: window.__app, requests, streams };
}

describe('Web client integration', () => {
  it('shows the product name and readable timeout diagnostics with original verification output', async () => {
    const { window, app } = await client();
    expect(window.document.title).toBe('Forge Agent');
    expect(window.document.getElementById('connection-label').textContent).toContain('Forge Agent');
    const output = 'first line\n<untrusted-output>\nlast line';
    app.state.sessionId = 'verification-test';
    app.applySnapshot({ id: 'verification-test', project: 'C:\\repo', running: false, outcome: 'failed', messages: [], verification: { status: 'failed', attempts: 1, report: { passed: false, results: [{ command: 'npm test', exitCode: null, passed: false, durationMs: 1500, failure: 'timeout', error: 'Command timed out after 1500ms', output }] } } });
    const rendered = window.document.getElementById('verification-output');
    expect(rendered.textContent).toContain('超时');
    expect(rendered.textContent).toContain('Command timed out after 1500ms');
    expect(rendered.textContent).toContain(output);
    expect(rendered.querySelector('untrusted-output')).toBeNull();
  });
  it('ties effort to the model menu and distinguishes missing, unsupported, fixed and adjustable capabilities', async () => {
    const { window, app } = await client();
    const find = (id) => window.document.getElementById(id);
    expect(find('followup-thinking-select')).toBeNull();
    expect(find('thinking-select').closest('#model-picker')).not.toBeNull();
    app.setModel(null);
    find('model-picker-button').click();
    expect(find('thinking-description').textContent).toContain('选择模型');
    expect(find('thinking-select').classList.contains('hidden')).toBe(true);
    app.setModel(model('a')); app.setRunning(false);
    expect(find('thinking-select').disabled).toBe(true);
    expect(find('thinking-description').textContent).toContain('未启用');
    expect(find('configure-thinking').classList.contains('hidden')).toBe(false);
    app.state.thinkingLevel = 'high';
    app.setModel(model('fixed', { reasoning: true, thinkingLevels: ['high'] })); app.setRunning(false);
    expect(find('thinking-select').disabled).toBe(true);
    expect(find('thinking-description').textContent).toContain('固定使用“高”');
    app.setModel(model('a', { reasoning: true, thinkingLevels: ['low', 'high'] }));
    app.setRunning(false);
    expect([...find('thinking-select').options].map((option) => option.value)).toEqual(['low', 'high']);
    expect(find('thinking-select').disabled).toBe(false);
    expect(find('model-picker-button').textContent).toContain('高');
    find('chat-model-search').value = 'b'; find('chat-model-search').dispatchEvent(new window.Event('input'));
    expect(window.document.querySelectorAll('[data-choose-model]')).toHaveLength(1);
    find('chat-model-search').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(window.document.activeElement.dataset.chooseModel).toBe('mock/b');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(find('model-picker').classList.contains('hidden')).toBe(true);
    expect(window.document.activeElement).toBe(find('model-picker-button'));
    app.state.models = []; app.setModel(null); find('model-picker-button').click();
    expect(find('chat-model-options').textContent).toContain('先添加服务');
  });

  it('uses authoritative session capability snapshots after editing a provider instead of retaining stale catalog flags', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', model: model('a', { reasoning: true, thinkingLevels: ['low', 'high'] }), thinkingLevel: 'high', mode: 'ask', messages: [] });
    expect(app.state.models[0].reasoning).toBe(true);
    expect([...window.document.getElementById('thinking-select').options].map((option) => option.value)).toEqual(['low', 'high']);
    expect(window.document.querySelector('#followup-model-picker-button [data-effort-label]').textContent).toBe('高');
    expect(window.document.getElementById('thinking-select').value).toBe('high');
    expect(app.state.mode).toBe('ask');
  });

  it('saves per-model effort, restores it when switching back and prevents sending or competing changes while saving', async () => {
    const reasoning = model('a', { reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high'] });
    const { window, app, requests } = await client({ models: [reasoning, model('b')], thinkingLevel: 'medium' });
    const find = (id) => window.document.getElementById(id);
    find('prompt').value = 'keep draft'; find('followup-prompt').value = 'keep followup';
    const fetcher = window.fetch;
    let release;
    window.fetch = (url, init) => url === '/api/settings' && init.method === 'POST' ? new Promise((resolve) => { release = async () => resolve(await fetcher(url, init)); }) : fetcher(url, init);
    const saving = app.changeThinking('high');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(find('run-button').disabled).toBe(true);
    expect(find('thinking-select').disabled).toBe(true);
    expect(await app.sendPrompt('must not send')).toBe(false);
    expect(await app.changeModel('mock/b')).toBe(false);
    await app.changeMode('plan'); expect(app.state.mode).toBe('agent');
    expect(requests.some((request) => request.url === '/api/session')).toBe(false);
    await release(); expect(await saving).toBe(true); window.fetch = fetcher;
    expect(app.state.thinkingLevel).toBe('high');
    expect(await app.changeModel('mock/b')).toBe(true); expect(app.state.thinkingLevel).toBe('off');
    expect(await app.changeModel('mock/a')).toBe(true); expect(app.state.thinkingLevel).toBe('high');
    expect(find('thinking-select').value).toBe('high');
    expect(find('prompt').value).toBe('keep draft'); expect(find('followup-prompt').value).toBe('keep followup');
    expect(await app.sendPrompt('run with high effort')).toBe(true);
    expect(JSON.parse(requests.find((request) => request.url === '/api/session').body)).toMatchObject({ model: 'mock/a', thinkingLevel: 'high', mode: 'agent' });
  });

  it('rolls back failed effort saves without discarding drafts or mode, then applies the session response after success', async () => {
    const reasoning = model('a', { reasoning: true, thinkingLevels: ['low', 'high'] });
    const { window, app, requests } = await client({ models: [reasoning], thinkingLevel: 'low' });
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', model: reasoning, thinkingLevel: 'low', mode: 'plan', messages: [] });
    window.document.getElementById('followup-prompt').value = 'unsent plan';
    const fetcher = window.fetch;
    window.fetch = async (url, init) => url.endsWith('/thinking') ? { ok: false, status: 409, json: async () => ({ error: 'settings busy' }) } : fetcher(url, init);
    expect(await app.changeThinking('high')).toBe(false);
    expect(app.state.thinkingLevel).toBe('low');
    expect(window.document.getElementById('thinking-select').value).toBe('low');
    expect(window.document.getElementById('thinking-select').disabled).toBe(false);
    expect(window.document.getElementById('model-save-status').textContent).toContain('保存失败');
    window.fetch = async (url, init) => {
      if (!url.endsWith('/thinking')) return fetcher(url, init);
      requests.push({ url, ...init });
      return { ok: true, json: async () => ({ thinkingLevel: 'high', snapshot: { model: reasoning, thinkingLevel: 'high', mode: 'plan' } }) };
    };
    expect(await app.changeThinking('high')).toBe(true);
    expect(JSON.parse(requests.at(-1).body)).toEqual({ level: 'high', persist: true });
    expect(app.state.thinkingLevel).toBe('high');
    expect(app.state.mode).toBe('plan');
    expect(window.document.getElementById('followup-prompt').value).toBe('unsent plan');
  });

  it('exposes third-party effort capabilities and preserves provider mappings when importing an exact catalog template', async () => {
    const { window, app } = await client();
    const fetcher = window.fetch;
    let saved;
    const thinkingLevelMap = { off: null, minimal: null, low: 'vendor-low', medium: null, high: 'vendor-high', xhigh: null, max: null };
    window.fetch = async (url, init = {}) => {
      if (url === '/api/providers/custom') {
        if (init.method === 'POST') { saved = JSON.parse(init.body); return { ok: true, json: async () => ({}) }; }
        return { ok: true, json: async () => ({ providers: [{ id: 'mock', name: 'Mock', api: 'openai-completions', baseUrl: 'http://localhost/v1', editable: true, models: [{ id: 'a', name: 'A', reasoning: false, capabilityTemplates: [{ sourceName: 'Reference catalog', reasoning: true, thinkingLevelMap, contextWindow: 64000, maxTokens: 8000, input: ['text'] }] }] }] }) };
      }
      return fetcher(url, init);
    };
    await app.openSettings('provider', model('a'));
    const row = window.document.querySelector('[data-custom-model]');
    expect(row.open).toBe(true);
    expect(row.querySelector('[data-field="reasoning"]').closest('.provider-advanced')).toBeNull();
    const template = row.querySelector('[data-field="capabilityTemplate"]'); template.value = '0'; template.dispatchEvent(new window.Event('change', { bubbles: true }));
    const updated = window.document.querySelector('[data-custom-model]');
    expect(updated.querySelector('[data-field="reasoning"]').value).toBe('true');
    expect([...updated.querySelectorAll('[data-effort]:checked')].map((input) => input.dataset.effort)).toEqual(['low', 'high']);
    await window.document.getElementById('custom-provider-form').onsubmit({ preventDefault() {} });
    expect(saved.models[0]).toMatchObject({ reasoning: true, thinkingLevelMap, contextWindow: 64000 });
    expect(saved.models[0].capabilityTemplates).toBeUndefined();
  });

  it('batch selects searched provider models, retains manual IDs and leaves the active chat model unchanged', async () => {
    const { window, app, requests } = await client();
    const originalFetch = window.fetch;
    let saved;
    window.fetch = async (url, init = {}) => {
      if (url.startsWith('/api/providers/')) {
        requests.push({ url, ...init });
        let data = { providers: [] };
        if (url.endsWith('/discover')) data = { models: [{ id: 'vendor/coder', name: '<img src=x onerror=alert(1)>' }, { id: 'second-model', name: 'Second model' }] };
        if (url.endsWith('/test')) data = { ok: true, model: 'vendor/coder', latencyMs: 100 };
        if (url.endsWith('/custom') && init.method === 'POST') { saved = JSON.parse(init.body); data = { id: saved.id }; }
        return { ok: true, status: 200, json: async () => data };
      }
      return originalFetch(url, init);
    };
    app.state.sessionId = 'live'; app.state.model = model('a'); app.setModel(app.state.model);
    await app.openSettings('provider');
    await window.document.getElementById('add-custom-provider').onclick();
    const field = (id, value) => { window.document.getElementById(id).value = value; };
    field('custom-id', 'my-gateway'); field('custom-name', 'My Gateway'); field('custom-url', 'https://example.test/v1'); field('custom-key', 'private-draft-key');
    await window.document.getElementById('discover-custom-models').onclick();
    const picker = window.document.getElementById('model-multiselect');
    picker.open = true; picker.ontoggle();
    expect(window.document.querySelectorAll('[data-discovered-id]')).toHaveLength(2);
    expect(window.document.getElementById('custom-feedback').textContent).toContain('尚未测试推理');
    const search = window.document.getElementById('discovered-model-search');
    search.value = 'vendor'; search.oninput(); window.document.getElementById('select-filtered-models').click();
    search.value = 'second'; search.oninput(); window.document.getElementById('select-filtered-models').click();
    search.value = 'missing'; search.oninput();
    expect(window.document.getElementById('discovered-selection-count').textContent).toContain('2');
    expect(window.document.getElementById('select-filtered-models').disabled).toBe(true);
    window.document.getElementById('apply-discovered-models').click();
    expect(picker.open).toBe(false);
    expect(window.document.querySelector('[data-custom-model] [data-field="id"]').value).toBe('vendor/coder');
    expect(window.document.querySelector('#custom-provider-editor img')).toBeNull();
    window.document.getElementById('add-custom-model').onclick();
    window.document.querySelectorAll('[data-custom-model] [data-field="id"]')[2].value = 'manual-model';
    window.document.querySelector('[data-custom-model] [data-field="contextWindow"]').value = '64000';
    picker.open = true; picker.ontoggle();
    search.value = 'second'; search.oninput(); window.document.getElementById('clear-filtered-models').click();
    window.document.getElementById('apply-discovered-models').click();
    expect([...window.document.querySelectorAll('[data-custom-model] [data-field="id"]')].map((input) => input.value)).toEqual(['vendor/coder', 'manual-model']);
    expect(window.document.querySelector('[data-field="contextWindow"]').value).toBe('64000');
    await window.document.getElementById('test-custom-provider').onclick();
    expect(window.document.getElementById('custom-feedback').textContent).toContain('调用成功');
    expect(window.document.getElementById('custom-feedback').textContent).toContain('尚未保存');
    expect([...Array(window.localStorage.length)].map((_, index) => window.localStorage.getItem(window.localStorage.key(index))).join('')).not.toContain('private-draft-key');
    expect([...Array(window.sessionStorage.length)].map((_, index) => window.sessionStorage.getItem(window.sessionStorage.key(index))).join('')).not.toContain('private-draft-key');
    await window.document.getElementById('custom-provider-form').onsubmit({ preventDefault() {} });
    expect(saved).toMatchObject({ id: 'my-gateway', apiKey: 'private-draft-key', models: [expect.objectContaining({ id: 'vendor/coder' }), expect.objectContaining({ id: 'manual-model' })] });
    expect(requests.some((request) => request.url === '/api/settings' && request.method === 'POST')).toBe(false);
    expect(app.state.model.key).toBe('mock/a');
    expect(window.document.querySelector('#followup-model-picker-button [data-model-label]').textContent).toBe('a');
    expect(window.document.getElementById('custom-key')).toBeNull();
  });

  it('retains connection and model drafts on discovery or save failure and allows manual fallback', async () => {
    const { window, app } = await client();
    const fetcher = window.fetch;
    window.fetch = async (url, init = {}) => {
      if (url === '/api/providers/discover' || url === '/api/providers/custom' && init.method === 'POST') return { ok: false, status: 502, json: async () => ({ error: '服务不支持获取，请手动填写模型 ID' }) };
      return fetcher(url, init);
    };
    await app.openSettings('provider'); window.document.getElementById('add-custom-provider').onclick();
    window.document.getElementById('custom-name').value = 'Local model';
    window.document.getElementById('custom-url').value = 'http://localhost:11434/v1';
    window.document.getElementById('custom-no-key').checked = true; window.document.getElementById('custom-no-key').onchange();
    expect(window.document.getElementById('custom-key').disabled).toBe(true);
    window.document.querySelector('[data-field="id"]').value = 'qwen3-coder';
    await window.document.getElementById('discover-custom-models').onclick();
    expect(window.document.getElementById('custom-feedback').textContent).toContain('手动填写模型 ID');
    expect(window.document.getElementById('custom-url').value).toBe('http://localhost:11434/v1');
    expect(window.document.querySelector('[data-field="id"]').value).toBe('qwen3-coder');
    await window.document.getElementById('custom-provider-form').onsubmit({ preventDefault() {} });
    expect(window.document.getElementById('custom-name').value).toBe('Local model');
    expect(window.document.getElementById('save-custom-provider').disabled).toBe(false);
    expect(window.document.getElementById('custom-key').disabled).toBe(true);
    expect(window.document.querySelector('[data-field="id"]').value).toBe('qwen3-coder');
  });

  it('shows one connection dialog without asking for a link, preserves drafts and session identity, and does not replay failed mutations', async () => {
    const { window, app } = await client();
    const active = JSON.stringify({ id: 'old', path: 'saved-session', project: 'C:\\repo' });
    window.sessionStorage.setItem('pforge.activeSession', active);
    window.document.getElementById('prompt').value = 'unfinished draft';
    let calls = 0;
    window.fetch = async () => { calls++; return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }; };
    await expect(app.api('/api/sessions/old/prompt', { method: 'POST', body: '{"message":"task"}' })).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
    expect(await app.loadConfig()).toBe(false);
    expect(await app.resumeActiveSession()).toBe(false);
    expect(window.sessionStorage.getItem('pforge.activeSession')).toBe(active);
    expect(window.document.getElementById('prompt').value).toBe('unfinished draft');
    expect(window.document.getElementById('connection-label').textContent).toContain('需要本地授权');
    expect(window.document.querySelector('.app-shell').inert).toBe(true);
    expect(window.document.getElementById('auth-modal').classList.contains('hidden')).toBe(false);
    expect(window.document.querySelectorAll('#auth-modal')).toHaveLength(1);
    expect(window.document.getElementById('auth-link')).toBeNull();
    expect(window.document.getElementById('auth-description').textContent).toContain('自动打开');
    expect(window.document.getElementById('toast-root').textContent).not.toContain('Unauthorized');
  });

  it('recovers through an existing browser credential without manual links or granting new access', async () => {
    const { window, app } = await client();
    const fetcher = window.fetch;
    window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(app.api('/api/config')).rejects.toMatchObject({ status: 401 });
    const previous = window.sessionStorage.getItem('pforge.token');
    window.document.getElementById('prompt').value = 'keep draft';
    const reconnect = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    window.fetch = reconnect;
    expect(await app.recoverAuthorization()).toBe(false);
    expect(reconnect).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ credentials: 'same-origin' }));
    expect(window.sessionStorage.getItem('pforge.token')).toBe(previous);
    expect(window.document.getElementById('auth-error').textContent).toContain('自动打开');
    window.fetch = fetcher;
    expect(await app.recoverAuthorization()).toBe(true);
    expect(window.sessionStorage.getItem('pforge.token')).toBe(previous);
    expect(window.document.getElementById('auth-modal').classList.contains('hidden')).toBe(true);
    expect(window.document.querySelector('.app-shell').inert).toBe(false);
    expect(window.document.getElementById('prompt').value).toBe('keep draft');
    expect(app.state.authRetryTimer).toBeNull();
    expect(reconnect.mock.calls.every(([url, init]) => url === '/api/settings' && !init.method)).toBe(true);
  });

  it('quietly reconnects an existing tab on focus without resending a task', async () => {
    const { window, app, requests } = await client();
    const fetcher = window.fetch;
    window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(app.api('/api/config')).rejects.toMatchObject({ status: 401 });
    window.document.getElementById('prompt').value = 'keep this draft';
    window.fetch = fetcher;
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() => expect(app.state.authRequired).toBe(false));
    expect(window.document.getElementById('prompt').value).toBe('keep this draft');
    expect(window.document.getElementById('auth-modal').classList.contains('hidden')).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('recovers the saved Pi session after the service loses its in-memory session without resubmitting a prompt', async () => {
    const { window, app, requests } = await client();
    const fetcher = window.fetch;
    window.sessionStorage.setItem('pforge.activeSession', JSON.stringify({ id: 'old', path: 'saved-session', project: 'C:\\repo' }));
    window.document.getElementById('followup-prompt').value = 'pending followup';
    window.fetch = (url, init) => url === '/api/sessions/old' ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) : fetcher(url, init);
    expect(await app.resumeActiveSession()).toBe(true);
    expect(app.state.sessionId).toBe('created');
    expect(window.document.getElementById('followup-prompt').value).toBe('pending followup');
    expect(JSON.parse(requests.find((request) => request.url === '/api/session').body)).toMatchObject({ sessionFile: 'saved-session' });
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('connects the initial stream only after prompt submission and renders the acknowledged user message once', async () => {
    const { window, app, streams } = await client();
    const fetcher = window.fetch;
    let acceptPrompt;
    window.fetch = (url, init) => url.endsWith('/prompt') ? new Promise((resolve) => { acceptPrompt = () => resolve({ ok: true, json: async () => ({ accepted: true }) }); }) : fetcher(url, init);
    const sent = app.sendPrompt('first task');
    await vi.waitFor(() => expect(acceptPrompt).toBeTypeOf('function'));
    expect(streams).toHaveLength(0);
    expect(app.state.running).toBe(true);
    acceptPrompt();
    expect(await sent).toBe(true);
    window.fetch = fetcher;
    const snapshot = { id: 'created', running: true, messages: [{ role: 'user', content: 'first task' }] };
    streams[0].onEvent({ id: '1', data: JSON.stringify({ type: 'pforge_snapshot', snapshot }) });
    expect(window.document.querySelectorAll('.turn.user')).toHaveLength(1);
    app.state.running = false;
    expect(await app.sendFollowup('next task')).toBe(true);
    streams[0].onEvent({ id: '2', data: JSON.stringify({ type: 'message_start', message: { role: 'user', content: 'next task' } }) });
    streams[0].onEvent({ id: '2', data: JSON.stringify({ type: 'message_start', message: { role: 'user', content: 'next task' } }) });
    expect(window.document.querySelectorAll('.turn.user')).toHaveLength(2);
    expect(window.document.querySelectorAll('.turn.user')[1].textContent).toContain('next task');
  });

  it('keeps the submitted draft when the server rejects a prompt and reports errors when opening a new conversation', async () => {
    const { window, app, streams } = await client();
    const fetcher = window.fetch;
    window.fetch = (url, init) => url.endsWith('/prompt') ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'busy session' }) }) : fetcher(url, init);
    window.document.getElementById('prompt').value = 'keep my draft';
    window.document.getElementById('composer').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(window.document.getElementById('followup-prompt').value).toBe('keep my draft'));
    expect(window.document.querySelectorAll('.turn.user')).toHaveLength(0);
    expect(streams).toHaveLength(1);
    window.fetch = async () => { throw new Error('server offline'); };
    await expect(app.newConversation()).resolves.toBeUndefined();
    expect(window.document.getElementById('toast-root').textContent).toContain('无法连接本地服务');
  });

  it('keeps model selection beneath the composer and makes settings an informational inventory', async () => {
    const { window, app, requests } = await client();
    expect(window.location.search).toBe('');
    expect(window.sessionStorage.getItem('pforge.token')).toContain('bootstrap-secret');
    expect(requests.every((request) => !request.url.includes('bootstrap-secret'))).toBe(true);
    await app.openSettings('model');
    expect(window.document.getElementById('default-model')).toBeNull();
    expect(window.document.getElementById('save-model')).toBeNull();
    expect(window.document.querySelectorAll('[data-model-card]')).toHaveLength(2);
    window.document.getElementById('drawer-close').click();
    window.document.getElementById('model-picker-button').click();
    window.document.querySelector('[data-choose-model="mock/b"]').click();
    await vi.waitFor(() => expect(app.state.model.key).toBe('mock/b'));
    expect(window.document.querySelector('#followup-model-picker-button [data-model-label]').textContent).toBe('b');
    expect(requests.find((request) => request.url === '/api/settings' && request.method === 'POST').body).toContain('mock/b');
  });

  it('restores an authoritative session mode, preserves a draft, handles rejected switches and locks mode during a run', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', mode: 'plan', runMode: 'plan', messages: [], outcome: 'completed' });
    expect(window.document.getElementById('followup-mode-select').value).toBe('plan');
    expect(window.document.getElementById('run-status-label').textContent).toContain('规划完成');
    window.document.getElementById('followup-prompt').value = 'keep this question';
    const fetcher = window.fetch;
    window.fetch = async (url, init) => url.endsWith('/mode') ? { ok: false, status: 409, json: async () => ({ error: 'busy' }) } : fetcher(url, init);
    await app.changeMode('agent');
    expect(app.state.mode).toBe('plan');
    window.fetch = async (url, init) => url.endsWith('/mode') ? { ok: true, json: async () => ({ mode: JSON.parse(init.body).mode }) } : fetcher(url, init);
    await app.changeMode('ask');
    expect(window.document.getElementById('followup-mode-description').textContent).toContain('不执行命令');
    expect(window.document.getElementById('followup-prompt').value).toBe('keep this question');
    expect(window.localStorage.getItem('pforge.mode')).toBe('"ask"');
    app.setRunning(true);
    expect(window.document.getElementById('followup-mode-select').disabled).toBe(true);
    await app.changeMode('agent');
    expect(app.state.mode).toBe('ask');
    app.setRunning(false);
  });

  it('deduplicates replayed deltas and replaces the transcript with a complete snapshot', async () => {
    const { window, app, streams } = await client();
    app.state.sessionId = 'abc'; app.connect('abc');
    const delta = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } };
    streams[0].onEvent({ id: '2', data: JSON.stringify(delta) });
    streams[0].onEvent({ id: '2', data: JSON.stringify(delta) });
    expect(window.document.querySelector('.assistant.turn-text').textContent).toBe('hello');
    const snapshot = { id: 'abc', title: 'Restored', running: false, readOnly: true, outcome: 'completed', model: null, messages: [ { role: 'user', content: 'task' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: '**hello**' }, { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }] }, { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'file content' }] } ], verification: { status: 'failed', report: { results: [{ command: 'test', exitCode: 1, passed: false, output: 'failure details', durationMs: 5 }] } } };
    streams[0].onEvent({ id: '3', data: JSON.stringify({ type: 'pforge_snapshot', snapshot }) });
    expect(window.document.querySelectorAll('.turn.assistant')).toHaveLength(1);
    expect(window.document.querySelector('.turn.assistant strong').textContent).toBe('Forge');
    expect(window.document.querySelector('.turn.assistant .turn-text strong').textContent).toBe('hello');
    expect(window.document.querySelector('.thinking-block').textContent).toContain('reason');
    expect(window.document.querySelector('.tool-output').textContent).toBe('file content');
    expect(window.document.getElementById('run-status-label').textContent).toContain('验证失败');
    expect(window.document.getElementById('verification-output').textContent).toContain('FAIL test');
    expect(window.document.getElementById('followup-send').disabled).toBe(true);
  });
});
