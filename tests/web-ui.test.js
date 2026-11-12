import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtinCommands, filterCommands, parseCommand } from '../src/web/ui/commands.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { readFile } from 'node:fs/promises';
import { safeMarkdown, sessionOutcome, verificationLabel } from '../src/web/ui/render.js';
import { createSseParser, readEventStream, StreamError } from '../src/web/ui/stream.js';
import { mountCustomProviders } from '../src/web/ui/providers.js';
import { mountMcp } from '../src/web/ui/mcp.js';
import { mountSkills } from '../src/web/ui/skills.js';
import { lifecycleUI } from '../src/web/ui/lifecycle.js';

const windows = [];
afterEach(() => { windows.splice(0).forEach((window) => { window.__app?.state.eventSource?.close(); window.close(); }); vi.unstubAllGlobals(); });

describe('reviewing host-owned changes', () => {
  function fixture(handler) {
    const dom = new JSDOM('<details id="review"></details>'); windows.push(dom.window);
    let session = 'parent'; const api = vi.fn(handler), toast = vi.fn(), changed = vi.fn();
    dom.window.confirm = vi.fn(() => true);
    const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const ui = lifecycleUI({ api, esc, toast, changed, currentSession: () => session, running: () => false, readOnly: () => false });
    return { window: dom.window, container: dom.window.document.getElementById('review'), api, ui, changed, setSession: (value) => { session = value; } };
  }
  const view = { id: 'checkpoint', label: 'An execution', kind: 'task', createdAt: new Date().toISOString(), revision: 'reviewed-revision', files: [{ path: 'safe.txt', operation: 'modify', eligible: true }, { path: 'later.txt', operation: 'modify', eligible: false, conflict: true }] };
  it('requires confirmation and submits only eligible selected files with the reviewed revision', async () => {
    const f = fixture(async (_url, input) => input ? {} : { checkpoints: [view] });
    await f.ui.loadCheckpoints(f.container);
    expect(f.container.querySelector('[value="later.txt"]').disabled).toBe(true);
    f.window.confirm.mockReturnValueOnce(false); f.container.querySelector('[data-checkpoint-apply]').click();
    expect(f.api).toHaveBeenCalledTimes(1);
    f.container.querySelector('[data-checkpoint-apply]').click();
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce());
    const mutation = f.api.mock.calls.find(([_url, init]) => init?.method === 'POST');
    expect(JSON.parse(mutation[1].body)).toEqual({ id: 'checkpoint', paths: ['safe.txt'], revision: 'reviewed-revision' });
  });
  it('keeps conflict feedback visible without claiming a successful rollback', async () => {
    const f = fixture(async (_url, input) => { if (input) throw new Error('Files changed after review'); return { checkpoints: [view] }; });
    await f.ui.loadCheckpoints(f.container); f.container.querySelector('[data-checkpoint-apply]').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Files changed after review'));
    expect(f.changed).not.toHaveBeenCalled(); expect(f.container.querySelector('[data-checkpoint-apply]').disabled).toBe(false);
  });
  it('applies and verifies only selected proposal files, while preventing an old session control from acting', async () => {
    const f = fixture(async () => ({ verificationStarted: true }));
    f.ui.proposal(f.container, { ...view, kind: 'proposal' }, 'parent', 'child', vi.fn());
    f.container.querySelector('[data-checkpoint-verify]').click();
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce());
    const post = f.api.mock.calls.find(([_url, init]) => init?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({ action: 'apply-verify', id: 'child', paths: ['safe.txt'], revision: 'reviewed-revision' });
    expect(f.container.textContent).not.toContain('验证通过');
    f.setSession('other'); f.container.querySelector('[data-checkpoint-verify]').click(); expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('prevents stale checkpoint and memory controls from acting after a session switch', async () => {
    const f = fixture(async () => ({ checkpoints: [view] }));
    await f.ui.loadCheckpoints(f.container); f.setSession('fork'); f.container.querySelector('[data-checkpoint-apply]').click();
    expect(f.api).toHaveBeenCalledTimes(1);
    f.ui.candidates(f.container, [{ id: 'candidate', status: 'pending', layer: 'project', text: '<script>bad</script>', evidence: '<img src=x>', revision: 'memory-revision' }], vi.fn());
    expect(f.container.querySelector('script,img')).toBeNull();
    f.setSession('another'); f.container.querySelector('[data-action="accept"]').click();
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('discards a late checkpoint response for the previously open session', async () => {
    let release; const f = fixture(() => new Promise((resolve) => { release = resolve; }));
    const loading = f.ui.loadCheckpoints(f.container); f.setSession('fork'); release({ checkpoints: [view] }); await loading;
    expect(f.container.querySelector('[data-checkpoint-apply]')).toBeNull();
  });
});

describe('safe agent output', () => {
  it('keeps subagent navigation compact and displays child output safely in a separate panel', async () => {
    const { window, app, requests, reviewMedia } = await client();
    const doc = window.document;
    app.state.sessionId = 'abc';
    app.applySnapshot({ id: 'abc', messages: [], subagents: [{ id: 'child-1', title: '审查输入校验', role: 'reviewer', status: 'completed', model: 'mock/a', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), budget: { totalTokens: 420 } }] });
    const button = doc.getElementById('subagents-button');
    expect(button.classList.contains('hidden')).toBe(false);
    expect(button.getAttribute('aria-label')).toContain('子任务 1');
    expect(doc.querySelectorAll('#timeline .subagent-row')).toHaveLength(0);
    button.click();
    const row = doc.querySelector('[data-subagent-open]');
    expect(row.textContent).toContain('审查输入校验');
    expect(row.textContent).toContain('420 tokens');
    const priorFetch = window.fetch;
    window.fetch = async (url, init) => url.includes('/subagents?') ? new Response(JSON.stringify({ agent: app.state.subagents[0], prompt: '<img src=x onerror=alert(1)>', messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'private process' }, { type: 'text', text: '**Evidence**\n\n<script>bad</script>' }] }] }), { status: 200 }) : priorFetch(url, init);
    row.click();
    await vi.waitFor(() => expect(doc.getElementById('subagent-detail').textContent).toContain('Evidence'));
    expect(doc.querySelector('#subagent-detail strong')?.textContent).toBe('Evidence');
    expect(doc.querySelector('#subagent-detail script, #subagent-detail img')).toBeNull();
    expect(doc.querySelector('#subagent-detail .subagent-process').open).toBe(false);
    expect(doc.getElementById('subagent-panel').classList.contains('hidden')).toBe(false);
    reviewMedia.matches = true; reviewMedia.dispatchEvent(new window.Event('change'));
    expect(doc.getElementById('subagent-panel').getAttribute('aria-modal')).toBe('true');
    expect(doc.getElementById('chat-pane').inert).toBe(true);
    expect(doc.getElementById('sidebar').inert).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc.getElementById('subagent-panel').classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('chat-pane').inert).toBe(false);
    expect(doc.activeElement).toBe(button);
  });

  it('retains subtask counts from SSE without mixing outputs into the parent chat, and clears them for a new session', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'abc';
    app.applySnapshot({ id: 'abc', messages: [], subagents: [] });
    const child = { id: 'child-1', title: '<unsafe>', role: 'explorer', status: 'running', model: 'mock/a', startedAt: new Date().toISOString() };
    app.handleEvent({ type: 'forge_subagents', agents: [child] });
    expect(window.document.getElementById('subagents-count').textContent).toBe('1 / 1');
    expect(window.document.querySelector('#subagent-list unsafe')).toBeNull();
    expect(window.document.getElementById('timeline').textContent).not.toContain('<unsafe>');
    await app.newConversation();
    expect(window.document.getElementById('subagents-button').classList.contains('hidden')).toBe(true);
    expect(window.document.getElementById('subagent-menu').classList.contains('hidden')).toBe(true);
    expect(app.state.subagents).toEqual([]);
  });
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
    expect(sessionOutcome({ outcome: 'completed', verification: { status: 'unchecked' } }).label).toContain('未执行自动验证');
    expect(sessionOutcome({ outcome: 'completed', verification: { status: 'passed' } }).label).toContain('当前版本未确认');
    expect(sessionOutcome({ outcome: 'completed', mode: 'plan', runMode: 'agent', verification: { status: 'passed' } }).label).not.toContain('验证通过');
    expect(sessionOutcome({ outcome: 'completed', mode: 'agent', runMode: 'plan', verification: { status: 'skipped' } }).label).toContain('可发送执行指令');
  });
  it('does not invent verification or review for completed adaptive tasks and distinguishes historical evidence', () => {
    const task = { kind: 'change', workflow: 'direct', status: 'completed' };
    expect(sessionOutcome({ task }).label).toContain('未执行自动验证');
    expect(sessionOutcome({ task }).label).toContain('需求未验收');
    const verification = { status: 'passed', evidenceId: 'v1', evidence: { freshness: 'current', workspace: { digest: 'a'.repeat(64) } }, report: { passed: true, results: [{ passed: true, exitCode: 0 }] } };
    expect(sessionOutcome({ task: { ...task, verification } }).label).toBe('已实现 · 需求未验收 · 配置检查通过 · 未进行模型审阅');
    expect(sessionOutcome({ task: { ...task, workflow: 'planned', verification } }).kind).toBe('failed');
    expect(sessionOutcome({ task: { ...task, verification } }).kind).toBe('unverified');
    const review = { verdict: 'ready', issues: [], freshness: 'current', evidenceId: 'v1' };
    expect(sessionOutcome({ task: { ...task, workflow: 'planned', verification, review } }).label).toContain('模型审阅通过');
    expect(sessionOutcome({ task: { ...task, verification: { ...verification, evidence: { freshness: 'stale' } }, review } })).toMatchObject({ kind: 'failed', label: expect.stringContaining('证据已过期') });
    expect(sessionOutcome({ task: { ...task, verification: { status: 'passed' } } }).kind).toBe('failed');
    expect(verificationLabel({ status: 'passed' })).toContain('当前版本未确认');
    expect(verificationLabel({ ...verification, report: { passed: true, results: [{ passed: true, exitCode: 0, failure: 'timeout' }] } })).not.toBe('配置检查通过');
  });
  it('does not turn syntax checks or stale delivery flags into acceptance evidence', async () => {
    const { window, app } = await client(), doc = window.document;
    app.state.sessionId = 'syntax-only';
    const verification = { status: 'passed', evidenceId: 'v1', evidence: { freshness: 'current', workspace: { digest: 'a'.repeat(64) } }, report: { passed: true, results: [{ command: 'python -m py_compile app.py', passed: true, exitCode: 0 }] } };
    const task = { id: 'syntax', kind: 'change', workflow: 'direct', status: 'completed', phase: 'complete', validation: 'verified', repairs: 0, phases: [], artifacts: [{ path: 'app.py', operation: 'edit' }], verification };
    app.applySnapshot({ id: 'syntax-only', outcome: 'completed', task, verification, messages: [] });
    expect(doc.getElementById('run-status-label').textContent).toContain('需求未验收');
    expect(doc.getElementById('run-status-dot').classList.contains('done')).toBe(false);
    expect(doc.getElementById('verification-summary').textContent).toContain('配置检查通过');
    expect(doc.getElementById('verification-output').textContent).toContain('python -m py_compile app.py');
    expect(doc.getElementById('delivery-validation').textContent).toContain('检查范围由配置的命令决定');
    expect(doc.getElementById('delivery-title').textContent).toBe('文件已生成 · 需求未验收');
    const stale = { ...verification, evidence: { ...verification.evidence, freshness: 'stale' } };
    app.applySnapshot({ id: 'syntax-only', outcome: 'completed', task: { ...task, verification: stale }, verification: stale, messages: [] });
    expect(doc.getElementById('delivery-validation').textContent).toContain('证据已过期');
    expect(doc.getElementById('delivery-validation').textContent).not.toContain('检查通过');
    expect(doc.getElementById('delivery-title').textContent).toContain('任务尚未完成');
    for (const status of ['changed', 'unconfirmed']) {
      const protectedCheck = { ...verification, protection: { status } };
      expect(sessionOutcome({ task: { ...task, verification: protectedCheck } }).kind).toBe('failed');
    }
  });
  it('shows written artifacts and removes continuation for an implementation with no verify commands', async () => {
    const { window, app } = await client(), find = (id) => window.document.getElementById(id);
    app.state.sessionId = 'delivery'; app.state.project = { path: 'C:\\repo', name: 'repo' };
    const verification = { status: 'skipped', reason: 'No verification commands configured.' };
    app.applySnapshot({ id: 'delivery', running: false, outcome: 'completed', task: { id: 'task-1', kind: 'change', workflow: 'planned', status: 'completed', phase: 'complete', validation: 'unconfigured', artifacts: [{ path: 'index.html', operation: 'write' }], repairs: 0, phases: [], verification }, verification, messages: [] });
    expect(find('delivery-card').classList.contains('hidden')).toBe(false);
    expect(find('delivery-title').textContent).toBe('文件已生成 · 需求未验收');
    expect(find('delivery-artifacts').textContent).toContain('index.html');
    expect(find('delivery-validation').textContent).toContain('未配置');
    expect(find('task-review').textContent).toContain('未启用独立审阅');
    expect(find('task-review').textContent).not.toContain('尚未完成');
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    find('delivery-artifacts').querySelector('[data-open-artifact]').click();
    expect(app.state.changes.open).toBe(true);
    expect(app.state.changes.reviewView).toBe('files');
  });
  it('does not add an empty file delivery card to an ordinary capability answer', async () => {
    const {window,app}=await client();app.state.sessionId='answer-only';
    app.applySnapshot({id:'answer-only',running:false,outcome:'completed',task:{id:'answer',kind:'undetermined',workflow:'direct',status:'completed',phase:'complete',repairs:0,phases:[],changes:{available:false,files:[]}},messages:[{role:'user',content:'你可以联网吗'},{role:'assistant',content:[{type:'text',text:'可以读取官方文档。'}]}]});
    expect(window.document.getElementById('delivery-card').classList.contains('hidden')).toBe(true);
    expect(window.document.getElementById('timeline').textContent).toContain('可以读取官方文档');
  });
  it('does not hide a blocked review or finalization failure behind missing verification', async () => {
    const { window, app } = await client(); app.state.sessionId = 'blocked';
    const verification = { status: 'skipped', reason: 'No verification commands configured.' };
    for (const status of ['needs_attention', 'failed', 'budget_exceeded']) {
      const task = { id: 'task', kind: 'change', workflow: 'planned', phase: 'review', status, validation: 'unconfigured', verification, repairs: 0, phases: [], artifacts: [{ path: 'main.js', operation: 'write' }], review: { verdict: 'changes_requested', issues: ['Missing requirement'] } };
      app.applySnapshot({ id: 'blocked', running: false, outcome: 'failed', task, messages: [] });
      expect(sessionOutcome({ task }).kind).toBe('failed');
      expect(window.document.getElementById('resume-task-button').classList.contains('hidden')).toBe(false);
      expect(window.document.getElementById('delivery-title').textContent).not.toBe('实现已完成');
    }
  });
  it.each(['ask', 'plan'])('uses the executed %s permission mode for unknown or implementation intent labels', (mode) => {
    for (const kind of ['undetermined', 'change']) {
      const task = { kind, workflow: 'direct', status: 'completed', mode };
      expect(sessionOutcome({ task, outcome: 'completed' })).toEqual({ label: '回答结束 · 未执行修改', kind: 'done' });
      expect(sessionOutcome({ task: { ...task, mode: 'agent' }, runMode: mode, mode: 'agent', outcome: 'completed' }).label).toContain('未执行修改');
      expect(sessionOutcome({ task: { ...task, status: 'failed' }, outcome: 'failed' }).kind).toBe('failed');
    }
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
  const reviewMedia = new window.EventTarget(); reviewMedia.matches = Boolean(initial.narrow);
  for (const [key, value] of Object.entries(initial.localStorage || {})) window.localStorage.setItem(key, JSON.stringify(value));
  // Most legacy UI cases exercise an already selected project. First-run cases
  // opt out explicitly so the production default remains unselected.
  if (!initial.firstRun && !Object.prototype.hasOwnProperty.call(initial.localStorage || {}, 'forge.selectedProject.v1')) window.localStorage.setItem('forge.selectedProject.v1', JSON.stringify('C:\\repo'));
  const models = initial.models || [model('a'), model('b')];
  let defaultModel = initial.model || models[0]?.key || null;
  let thinkingLevel = initial.thinkingLevel || 'off';
  const modelThinkingLevels = { ...initial.modelThinkingLevels };
  const streams = [], requests = [];
  Object.assign(window, {
    TextDecoder,
    matchMedia: () => reviewMedia,
    marked, DOMPurify: createDOMPurify(window), StreamError, mountCustomProviders, mountMcp, mountSkills, lifecycleUI,
    builtinCommands, filterCommands, parseCommand,
    safeMarkdown, textContent: (content) => typeof content === 'string' ? content : (content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'), sessionOutcome, verificationLabel,
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
      if (url.startsWith('/api/mcp')) data = { project: 'C:\\repo', projectTrusted: true, servers: [], errors: [], paths: {} };
      if (url.startsWith('/api/skills')) data = { project: 'C:\\repo', projectTrusted: true, skills: [], diagnostics: [], sources: [], paths: {}, revision: 'initial' };
      if (url === '/api/credentials') data = { credentials: [] };
      if (url === '/api/session') { const input = JSON.parse(init.body); data = { id: 'created', project: 'C:\\repo', running: false, mode: input.mode || 'agent', workflow: input.workflow || 'direct', model: models.find((item) => item.key === input.model) || models[0], thinkingLevel: input.thinkingLevel || thinkingLevel, messages: [] }; }
      if (/\/api\/sessions\/[^/]+\/workflow$/.test(url) && init.method === 'POST') data = { workflow: JSON.parse(init.body).workflow };
      if (/\/api\/sessions\/[^/]+\/mode$/.test(url) && init.method === 'POST') data = { mode: JSON.parse(init.body).mode, workflow: 'direct' };
      if (/\/api\/sessions\/[^/]+\/model$/.test(url) && init.method === 'POST') {
        const selected = models.find((item) => item.key === JSON.parse(init.body).model);
        data = { snapshot: { model: selected, thinkingLevel: selected.reasoning ? modelThinkingLevels[selected.key] || selected.thinkingLevels[0] : 'off' } };
      }
      if (/\/api\/sessions\/[^/]+\/thinking$/.test(url) && init.method === 'POST') data = { thinkingLevel: JSON.parse(init.body).level };
      return { ok: true, status: 200, json: async () => data };
    }
  });
  // Exercise the actual browser entry point against an isolated DOM and API, including all event bindings.
  window.eval(source + '\nwindow.__app = { state, api, loadConfig, loadModels, resumeActiveSession, recoverAuthorization, openSettings, connect, applySnapshot, renderMessages, setModel, changeMode, changeModeSelection, changeWorkflow, openSession, changeModel, changeThinking, toggleModelPicker, closeModelPicker, setRunning, createSession, sendPrompt, sendFollowup, newConversation, loadChanges, loadChangeDiff, stopExecution, resumeExecution, handleEvent, compactContext, updateElapsed };');
  await vi.waitFor(() => expect(window.document.getElementById('connection-label').textContent).toContain('已连接'));
  return { window, app: window.__app, requests, streams, reviewMedia };
}

function streamText(app, delta) { app.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }); }

describe('History navigation', () => {
  it('keeps a first-run composer unbound until the first message is sent', async () => {
    const { window, app } = await client({ firstRun: true });
    expect(app.state.project).toBeNull();
    expect(window.document.getElementById('project-selector-label').textContent).toContain('自动创建');
    expect(window.document.getElementById('current-project-path').textContent).toContain('发送时自动创建');
  });

  it('offers uploads before project selection and sends attachment-only first messages into a managed project', async () => {
    const { window, app, requests } = await client({ firstRun: true });
    const doc = window.document;
    expect(doc.querySelector('[data-upload-picker="prompt"]').disabled).toBe(false);
    expect(doc.querySelector('[data-file-picker="prompt"]').disabled).toBe(true);
    const upload = new window.File(['export const value = 42;'], 'example.ts', { type: 'text/plain' });
    const credential = new window.File(['must stay local'], '.env', { type: 'text/plain' });
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [upload, credential], types: ['Files'] } });
    doc.getElementById('composer').dispatchEvent(drop);
    await vi.waitFor(() => expect(app.state.attachmentReading).toBe(false));
    expect(app.state.attachments).toMatchObject([{ type: 'upload', name: 'example.ts', text: 'export const value = 42;' }]);
    expect(doc.getElementById('prompt-attachments').textContent).toContain('example.ts');
    expect(doc.getElementById('toast-root').textContent).toContain('凭据');
    expect(await app.sendPrompt('')).toBe(true);
    const session = JSON.parse(requests.find((request) => request.url === '/api/session').body);
    expect(session).not.toHaveProperty('project');
    expect(session.requestId).toBeTruthy();
    const prompt = JSON.parse(requests.find((request) => request.url === '/api/sessions/created/prompt').body);
    expect(prompt.message).toContain('附件');
    expect(prompt.attachments).toMatchObject([{ type: 'upload', name: 'example.ts' }]);
    expect(app.state.attachments).toEqual([]);
  });

  it('previews pasted images, supports removal, and keeps unsent attachments out of other conversations', async () => {
    const { window, app } = await client({ firstRun: true });
    const doc = window.document;
    const image = new window.File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], 'clipboard.png', { type: 'image/png' });
    const paste = () => {
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: image.type, getAsFile: () => image }] } });
      doc.getElementById('prompt').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    paste();
    await vi.waitFor(() => expect(app.state.attachments).toHaveLength(1));
    expect(doc.querySelector('#prompt-attachments img').getAttribute('src')).toContain('data:image/png;base64,');
    doc.querySelector('#prompt-attachments [data-remove-attachment]').click();
    expect(app.state.attachments).toHaveLength(0);
    paste();
    await vi.waitFor(() => expect(app.state.attachments).toHaveLength(1));
    await app.newConversation();
    expect(app.state.attachments).toHaveLength(0);
    expect(doc.querySelector('#prompt-attachments img')).toBeNull();
  });

  it('preserves the composed message and local uploads when choosing a different project', async () => {
    const { window, app } = await client();
    const doc = window.document;
    doc.getElementById('prompt').value = 'Use this file in a new project';
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new window.File(['export const answer = 42;'], 'draft.ts')], types: ['Files'] } });
    doc.getElementById('composer').dispatchEvent(drop);
    await vi.waitFor(() => expect(app.state.attachmentReading).toBe(false));
    app.state.attachments.push({ type: 'file', path: 'old-project.ts' });
    doc.getElementById('project-selector').click();
    doc.getElementById('folder-auto').click();
    await vi.waitFor(() => expect(app.state.project).toBeNull());
    expect(doc.getElementById('prompt').value).toBe('Use this file in a new project');
    expect(app.state.attachments).toMatchObject([{ type: 'upload', name: 'draft.ts' }]);
    expect(doc.getElementById('prompt-attachments').textContent).not.toContain('old-project.ts');
  });

  it('keeps first-message attachments available after a rejected prompt and sends them on retry', async () => {
    const { window, app, requests } = await client({ firstRun: true });
    const originalFetch = window.fetch;
    let rejectPrompt = true;
    window.fetch = async (url, init) => {
      if (url.endsWith('/prompt') && rejectPrompt) return { ok: false, status: 503, json: async () => ({ error: 'Temporarily unavailable' }) };
      return originalFetch(url, init);
    };
    app.state.attachments = [{ type: 'upload', name: 'retry.ts', text: 'export const retry = true;', size: 26 }];
    expect(await app.sendPrompt('Analyze this file')).toBe(false);
    expect(app.state.attachments).toMatchObject([{ type: 'upload', name: 'retry.ts' }]);
    expect(window.document.getElementById('followup-attachments').textContent).toContain('retry.ts');
    rejectPrompt = false;
    expect(await app.sendFollowup('Analyze this file')).toBe(true);
    const request = requests.find((item) => item.url.endsWith('/prompt'));
    expect(JSON.parse(request.body).attachments).toMatchObject([{ type: 'upload', name: 'retry.ts' }]);
    expect(app.state.attachments).toEqual([]);
  });

  it('keeps empty projects visible and places history operations in a keyboard accessible menu', async () => {
    const { window, app, requests } = await client(), doc = window.document;
    expect(doc.querySelector('[data-project-toggle] .project-icon svg')).not.toBeNull();
    expect(doc.querySelector('.empty-sessions').textContent).toContain('还没有对话');
    app.state.sessionId = 'source';
    app.applySnapshot({ id: 'source', title: 'Current session', sessionFile: 'C:\\sessions\\source.jsonl', running: false, history: { status: 'active', pinned: false }, forkableEntries: ['user'], messages: [] });
    doc.getElementById('conversation-menu-button').click();
    const menu = doc.getElementById('session-menu');
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(doc.activeElement.dataset.historyAction).toBe('rename');
    menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(doc.activeElement.dataset.historyAction).toBe('pin');
    menu.querySelector('[data-history-action="rename"]').click();
    expect(doc.getElementById('name-modal').classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('session-name').value).toBe('Current session');
    expect(doc.querySelector('.conversation-header #rename-button')).toBeNull();
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('removes a selected project and clears stale navigation while retaining its conversation draft', async () => {
    const { window, app, requests } = await client(), doc = window.document;
    app.state.sessionId = 'source';
    app.applySnapshot({ id: 'source', project: 'C:\\repo', sessionFile: 'C:\\sessions\\source.jsonl', running: false, messages: [] });
    doc.getElementById('followup-prompt').value = 'Keep this unsent draft';
    let removed = false;
    const originalFetch = window.fetch;
    window.fetch = async (url, init = {}) => {
      if (url === '/api/projects' && init.method === 'DELETE') {
        requests.push({ url, ...init }); removed = true;
        return { ok: true, json: async () => ({ path: 'C:\\repo', removed: true }) };
      }
      if (removed && url === '/api/projects') return { ok: true, json: async () => ({ projects: [], removedPaths: ['C:\\repo'] }) };
      return originalFetch(url, init);
    };
    const more = doc.querySelector('[data-project-menu]'); more.click();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(doc.getElementById('session-menu').getAttribute('aria-label')).toBe('项目操作');
    doc.querySelector('[data-project-action="remove"]').click();
    await vi.waitFor(() => expect(app.state.historyBusy).toBe(false));
    expect(removed).toBe(true);
    expect(app.state.project).toBeNull(); expect(app.state.sessionId).toBeNull();
    expect(doc.querySelector('[data-project-menu]')).toBeNull();
    expect(window.localStorage.getItem('forge.selectedProject.v1')).toBeNull();
    expect(window.sessionStorage.getItem('pforge.activeSession')).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem('pforge.draft.C:\\sessions\\source.jsonl'))).toBe('Keep this unsent draft');
    // A stale recent-project cache from an older tab must not rediscover the project.
    window.localStorage.setItem('pforge.recentProjects', JSON.stringify([{ path: 'C:\\repo', name: 'repo' }]));
    await app.loadConfig();
    expect(doc.querySelector('[data-project-menu]')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('pforge.recentProjects'))).toEqual([]);
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('keeps the current project and draft when project removal is rejected', async () => {
    const { window, app } = await client(), doc = window.document;
    const originalFetch = window.fetch;
    window.fetch = async (url, init = {}) => url === '/api/projects' && init.method === 'DELETE'
      ? { ok: false, status: 409, json: async () => ({ error: '请先停止此项目正在执行的任务' }) }
      : originalFetch(url, init);
    doc.getElementById('prompt').value = 'Unsent';
    doc.querySelector('[data-project-menu]').click(); doc.querySelector('[data-project-action="remove"]').click();
    await vi.waitFor(() => expect(app.state.historyBusy).toBe(false));
    expect(app.state.project.path).toBe('C:\\repo');
    expect(doc.getElementById('prompt').value).toBe('Unsent');
    expect(doc.querySelector('[data-project-menu]')).not.toBeNull();
    expect(doc.getElementById('toast-root').textContent).toContain('先停止');
  });

  it('starts answer forks with an empty draft and preserves the source draft without sending a model prompt', async () => {
    const { window, app, requests } = await client(), doc = window.document;
    app.state.sessionId = 'source';
    const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Saved answer' }] };
    app.applySnapshot({ id: 'source', title: 'Source', sessionFile: 'C:\\sessions\\source.jsonl', running: false, history: { status: 'active', pinned: false }, forkableEntries: ['answer'], entries: [{ id: 'answer', type: 'message', message }] });
    doc.getElementById('followup-prompt').value = 'Only belongs to the source';
    const originalFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (url.endsWith('/fork')) {
        expect(JSON.parse(init.body)).toEqual({ entryId: 'answer' });
        return { ok: true, json: async () => ({ path: 'C:\\sessions\\fork.jsonl', project: 'C:\\repo', draft: '', origin: { kind: 'continue', sourceTitle: 'Source' } }) };
      }
      return originalFetch(url, init);
    };
    doc.querySelector('[data-fork-entry="answer"]').click();
    await vi.waitFor(() => expect(app.state.sessionId).toBe('created'));
    await vi.waitFor(() => expect(app.state.loadingSession).toBe(false));
    expect(doc.getElementById('followup-prompt').value).toBe('');
    expect(JSON.parse(window.sessionStorage.getItem('pforge.draft.C:\\sessions\\source.jsonl'))).toBe('Only belongs to the source');
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });
});

describe('Composer commands and context', () => {
  function type(window, value, id = 'prompt') {
    const input = window.document.getElementById(id); input.value = value; input.focus(); input.setSelectionRange(value.length, value.length); input.dispatchEvent(new window.Event('input', { bubbles: true })); return input;
  }
  function key(window, input, value, extra = {}) { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })); }

  it('opens skill management from the skills category without adding a peer command or sending the draft', async () => {
    const { window, app, requests } = await client(), doc = window.document;
    app.state.sessionId = 'created';
    type(window, '/', 'followup-prompt'); doc.querySelector('[data-command-category="skill"]').click();
    expect(doc.getElementById('manage-skills').classList.contains('hidden')).toBe(false);
    doc.getElementById('manage-skills').click();
    await vi.waitFor(() => expect(doc.getElementById('skills-settings')).not.toBeNull());
    expect(doc.querySelector('[data-settings-tab="skills"]').getAttribute('aria-pressed')).toBe('true');
    expect(doc.getElementById('followup-prompt').value).toBe('/');
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    expect(doc.querySelector('[data-command-name="skills"]')).toBeNull();
  });

  it('discovers commands, filters, navigates and opens controls without sending model prompts', async () => {
    const { window, requests } = await client(); const doc = window.document;
    const input = type(window, '/');
    expect(doc.getElementById('command-picker').classList.contains('hidden')).toBe(false);
    key(window, input, 'ArrowDown');
    expect(doc.getElementById(input.getAttribute('aria-activedescendant')).textContent).toContain('/model');
    key(window, input, 'Enter');
    expect(doc.getElementById('model-picker').classList.contains('hidden')).toBe(false);
    expect(input.value).toBe('');
    expect(requests.some((request) => request.url === '/api/session' || request.url.endsWith('/prompt'))).toBe(false);
    const mode = type(window, '/mode'); key(window, mode, 'Tab');
    expect(mode.value).toBe('/mode ');
    expect(doc.getElementById('command-picker').classList.contains('hidden')).toBe(true);
    const help = type(window, '/help'); key(window, help, 'Escape');
    expect(help.value).toBe('/help');
    key(window, help, 'Enter');
    await vi.waitFor(() => expect(doc.getElementById('help-modal').classList.contains('hidden')).toBe(false));
    key(window, doc.getElementById('help-close'), 'Escape');
    expect(doc.activeElement).toBe(input);
  });

  it('keeps drafts and IME input, leaves filesystem paths as text and rejects unknown commands locally', async () => {
    const { window, requests } = await client(); const doc = window.document;
    let input = type(window, 'existing draft'); doc.getElementById('commands-button').click(); expect(input.value).toBe('existing draft');
    input = type(window, '/help'); key(window, input, 'Enter', { isComposing: true });
    expect(doc.getElementById('help-modal').classList.contains('hidden')).toBe(true);
    expect(input.value).toBe('/help');
    input = type(window, '/unknown option'); doc.getElementById('composer').requestSubmit();
    await vi.waitFor(() => expect(doc.getElementById('toast-root').textContent).toContain('没有 /unknown'));
    expect(input.value).toBe('/unknown option');
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    expect(parseCommand('/src/app.ts')).toBeNull(); expect(parseCommand('explain /context')).toBeNull();
  });

  it('keeps mouse-opened model and mode pickers visible, focuses them, and makes an actual model choice', async () => {
    const { window, app, requests } = await client(); const doc = window.document;
    const input = type(window, '/model');
    const modelOption = doc.querySelector('[data-command-name="model"]');
    expect(doc.querySelectorAll('#command-options [role=option]')).toHaveLength(1);
    expect(modelOption.textContent).toContain('切换模型');
    modelOption.click();
    expect(doc.getElementById('model-picker').classList.contains('hidden')).toBe(false);
    expect(doc.activeElement).toBe(doc.getElementById('chat-model-search'));
    expect(input.value).toBe('');
    const alternate = doc.querySelector('[data-choose-model="mock/b"]');
    alternate.checked = true; alternate.dispatchEvent(new window.Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(app.state.model.key).toBe('mock/b'));
    expect(requests.some((request) => request.url === '/api/settings' && request.method === 'POST')).toBe(true);
    type(window, '/mode');
    expect(doc.querySelectorAll('#command-options [role=option]')).toHaveLength(1);
    expect(doc.querySelector('[data-command-name="mode"]').textContent).toContain('工作模式');
    doc.querySelector('[data-command-name="mode"]').click();
    expect(doc.getElementById('mode-picker').classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('model-picker').classList.contains('hidden')).toBe(true);
    expect(requests.some((request) => request.url === '/api/session' || request.url.endsWith('/prompt'))).toBe(false);
  });

  it('keeps skills in a category without a peer skills action, deduplicates commands and preserves Pi dispatch', async () => {
    const { window, app, requests } = await client(); const doc = window.document; app.state.sessionId = 'created';
    app.applySnapshot({ id: 'created', mode: 'agent', running: false, messages: [], commands: [
      { name: 'model', source: 'extension', description: 'Conflicting command' },
      { name: 'skill:review', source: 'skill', description: 'Review changes' },
      { name: 'skill:review', source: 'skill', description: 'Duplicate skill' },
      { name: 'check', source: 'template', description: 'Check the project' }
    ] });
    const input = type(window, '/', 'followup-prompt');
    expect(doc.querySelectorAll('[data-command-name="model"]')).toHaveLength(1);
    expect(doc.querySelector('[data-command-name="skills"]')).toBeNull();
    expect(doc.querySelectorAll('[data-command-name="skill:review"]')).toHaveLength(1);
    expect(doc.querySelectorAll('.command-group-title')).toHaveLength(3);
    doc.querySelector('[data-command-category="skill"]').click();
    expect(doc.querySelectorAll('#command-options [role=option]')).toHaveLength(1);
    expect(doc.querySelector('[data-command-category="skill"]').getAttribute('aria-pressed')).toBe('true');
    expect(doc.getElementById('command-picker-help').textContent).toContain('附加任务后发送');
    doc.querySelector('[data-command-name="skill:review"]').click();
    expect(input.value).toBe('/skill:review ');
    expect(doc.activeElement).toBe(input);
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    input.value += 'src/index.ts'; key(window, input, 'Enter');
    await vi.waitFor(() => expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(true));
    expect(JSON.parse(requests.find((request) => request.url.endsWith('/prompt')).body)).toEqual({ message: '/skill:review src/index.ts', command: true, workflow: 'direct' });
  });

  it('loads the skill category before the first prompt and preserves closing it during discovery', async () => {
    const { window, app, requests } = await client(); const doc = window.document;
    const originalFetch = window.fetch; let release;
    window.fetch = (url, init) => url === '/api/session' ? new Promise((resolve) => { release = () => resolve({ ok: true, status: 201, json: async () => ({ id: 'created', project: 'C:\\repo', mode: 'agent', messages: [], commands: [{ name: 'skill:review', source: 'skill', description: 'Review' }] }) }); }) : originalFetch(url, init);
    const input = type(window, '/'); doc.querySelector('[data-command-category="skill"]').click();
    expect(doc.getElementById('command-picker').textContent).toContain('正在加载');
    expect(app.state.loadingSession).toBe(true);
    key(window, input, 'Escape'); release();
    await vi.waitFor(() => expect(app.state.loadingSession).toBe(false));
    expect(doc.getElementById('command-picker').classList.contains('hidden')).toBe(true);
    type(window, '/skills', 'followup-prompt'); key(window, doc.getElementById('followup-prompt'), 'Enter');
    await vi.waitFor(() => expect(doc.querySelector('[data-command-name="skill:review"]')).not.toBeNull());
    expect(app.state.commandCategory).toBe('skill');
    expect(doc.querySelector('[data-command-name="skills"]')).toBeNull();
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('keeps the skill category and keyboard focus after loading resources, with an explicit empty state', async () => {
    const { window, app, requests } = await client(); const doc = window.document;
    type(window, '/'); doc.querySelector('[data-command-category="skill"]').click();
    await vi.waitFor(() => expect(app.state.sessionId).toBe('created'));
    expect(doc.getElementById('command-picker').classList.contains('hidden')).toBe(false);
    expect(doc.querySelector('[data-command-category="skill"]').getAttribute('aria-pressed')).toBe('true');
    expect(doc.activeElement).toBe(doc.getElementById('followup-prompt'));
    expect(doc.getElementById('command-options').textContent).toContain('未加载可用技能');
    doc.querySelector('[data-command-category="local"]').click();
    key(window, doc.getElementById('followup-prompt'), 'ArrowDown');
    key(window, doc.getElementById('followup-prompt'), 'Enter');
    expect(doc.getElementById('model-picker').classList.contains('hidden')).toBe(false);
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('offers loaded skills and templates, preserves arguments, and dispatches them directly through Pi', async () => {
    const { window, app, requests } = await client(); app.state.sessionId = 'created';
    app.applySnapshot({ id: 'created', running: false, mode: 'agent', workflow: 'planned', messages: [], commands: [{ name: 'skill:review', source: 'skill', description: '<script>unsafe</script> Review changes' }, { name: 'custom', source: 'template', description: 'Template' }] });
    const input = type(window, '/skill:', 'followup-prompt');
    expect(window.document.querySelector('#command-options script')).toBeNull();
    key(window, input, 'Enter'); expect(input.value).toBe('/skill:review ');
    input.value += 'src/index.ts'; window.document.getElementById('followup-form').requestSubmit();
    await vi.waitFor(() => expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(true));
    expect(JSON.parse(requests.find((request) => request.url.endsWith('/prompt')).body)).toEqual({ message: '/skill:review src/index.ts', command: true, workflow: 'direct' });
    expect(app.state.workflow).toBe('planned');
  });

  it('blocks runtime commands in read-only modes and preserves disabled input while allowing model choices during a run', async () => {
    const { window, app, requests } = await client(); app.state.sessionId = 'created';
    app.applySnapshot({ id: 'created', mode: 'plan', running: false, messages: [], commands: [{ name: 'dangerous', source: 'extension', description: 'Test' }] });
    const input = type(window, '/dangerous ', 'followup-prompt'); window.document.getElementById('followup-form').requestSubmit();
    await vi.waitFor(() => expect(window.document.getElementById('toast-root').textContent).toContain('需要先切换 Agent'));
    expect(input.value).toBe('/dangerous '); expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    app.setRunning(true); type(window, '/compact', 'followup-prompt');
    expect(window.document.querySelector('#command-options [aria-disabled=true]')).toBeTruthy();
    const choose = type(window, '/model', 'followup-prompt'); key(window, choose, 'Enter');
    expect(window.document.getElementById('model-picker').classList.contains('hidden')).toBe(false);
    expect(app.state.mode).toBe('plan');
  });

  it('shows actual context estimates beneath the composer and clears stale usage after compaction', async () => {
    const { window, app } = await client(); app.state.sessionId = 'created';
    const doc = window.document;
    app.applySnapshot({ id: 'created', running: false, messages: [], context: { usage: { tokens: 1600, contextWindow: 8000, percent: 20 }, autoCompaction: true, compactions: 0, stats: { tokens: { input: 10000, output: 500, cacheRead: 200, cacheWrite: 0 }, cost: 0.012 } } });
    expect(doc.getElementById('followup-context-button').textContent).toContain('1.6k / 8k · 20%');
    expect(doc.getElementById('compact-button').closest('form').id).toBe('followup-form');
    expect(doc.querySelector('.conversation-header #compact-button')).toBeNull();
    doc.getElementById('followup-context-button').click();
    expect(doc.getElementById('context-details').textContent).toContain('已开启');
    expect(doc.getElementById('context-details').textContent).toContain('10,000');
    app.handleEvent({ type: 'pforge_context', context: { usage: { tokens: null, percent: null, contextWindow: 8000 }, compactions: 1 } });
    expect(doc.getElementById('followup-context-button').textContent).toContain('— / 8k');
    expect(doc.getElementById('followup-context-button').textContent).not.toContain('20%');
    expect(doc.getElementById('context-explanation').textContent).toContain('下一次模型回复');
    app.handleEvent({ type: 'pforge_context', context: { usage: { tokens: 7400, percent: 92.5, contextWindow: 8000 } } });
    expect(doc.getElementById('followup-context-button').dataset.level).toBe('high');
    app.handleEvent({ type: 'pforge_context', context: { usage: { tokens: 2, percent: 0.025, contextWindow: 8000 } } });
    expect(doc.getElementById('followup-context-button').textContent).toContain('<0.1%');
    await app.newConversation(); expect(doc.getElementById('context-button').textContent).not.toContain('7.4k');
  });

  it('locks compaction against sending or duplicate operations, supports cancellation and preserves failed commands', async () => {
    const { window, app, requests } = await client(); app.state.sessionId = 'created';
    const doc = window.document, originalFetch = window.fetch; let release;
    window.fetch = (url, init) => url.endsWith('/compact') ? new Promise((resolve) => { release = resolve; }) : originalFetch(url, init);
    const input = type(window, '/compact keep decisions', 'followup-prompt'); doc.getElementById('followup-form').requestSubmit();
    await vi.waitFor(() => expect(app.state.compacting).toBe(true));
    expect(doc.getElementById('followup-send').disabled).toBe(true);
    expect(doc.getElementById('followup-model-picker-button').disabled).toBe(true);
    expect(await app.sendFollowup('do not run')).toBe(false); expect(await app.compactContext()).toBe(false);
    doc.getElementById('cancel-compact-button').click();
    await vi.waitFor(() => expect(requests.some((request) => request.url.endsWith('/abort-compact'))).toBe(true));
    release({ ok: false, status: 400, json: async () => ({ error: 'Compaction cancelled' }) });
    await vi.waitFor(() => expect(app.state.compacting).toBe(false));
    expect(input.value).toBe('/compact keep decisions');
    expect(doc.getElementById('followup-send').disabled).toBe(false);
    expect(doc.getElementById('context-operation-note').textContent).toContain('原有上下文仍然保留');
  });

  it('freezes completed elapsed time across snapshots and subsequent renders', async () => {
    const { window, app } = await client(); app.state.sessionId = 'created';
    app.applySnapshot({ id: 'created', running: false, messages: [], runningSince: Date.now() - 600000, finishedAt: Date.now() - 593000 });
    expect(window.document.getElementById('run-elapsed').textContent).toBe('0:07');
    app.updateElapsed(); expect(window.document.getElementById('run-elapsed').textContent).toBe('0:07');
    app.applySnapshot({ id: 'created', running: false, messages: [] });
    expect(window.document.getElementById('run-elapsed').textContent).toBe('');
  });
});

describe('Streaming answer rendering', () => {
  it('formats incomplete Markdown before completion and preserves completed blocks and expanding code controls', async () => {
    const { window, app } = await client();
    streamText(app, '## Live answer\n\n**bo');
    const node = window.document.querySelector('.turn.assistant .turn-text');
    await vi.waitFor(() => expect(node.querySelector('h2')?.textContent).toBe('Live answer'));
    expect(node.querySelector('strong')).toBeNull();
    const heading = node.querySelector('h2');
    streamText(app, 'ld**\n\n- one\n- two\n\n| Name | State |\n| --- | --- |\n| stream | on |\n\n```diff\n-old\n+new');
    await vi.waitFor(() => expect(node.querySelector('code.language-diff')?.textContent).toContain('+new'));
    expect(node.querySelector('strong').textContent).toBe('bold');
    expect(node.querySelectorAll('li')).toHaveLength(2);
    expect(node.querySelector('td').textContent).toBe('stream');
    expect(node.querySelector('.diff-add').textContent).toContain('+new');
    expect(node.dataset.raw).not.toMatch(/```$/);
    const table = node.querySelector('table'), pre = node.querySelector('pre'), button = node.querySelector('.copy-code');
    pre.scrollLeft = 45; pre.scrollTop = 12;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    streamText(app, '\n+more\n```\n\n[Docs](https://example.com)');
    await vi.waitFor(() => expect(node.querySelector('a')?.textContent).toBe('Docs'));
    expect(node.querySelector('h2')).toBe(heading);
    expect(node.querySelector('table')).toBe(table);
    expect(node.querySelector('pre')).toBe(pre);
    expect(node.querySelector('.copy-code')).toBe(button);
    expect(pre.scrollLeft).toBe(45); expect(pre.scrollTop).toBe(12);
    expect(node.querySelector('a').rel).toBe('noopener noreferrer');
    button.click(); expect(writeText).toHaveBeenCalledWith('-old\n+new\n+more\n');
    const html = node.innerHTML;
    app.handleEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: node.dataset.raw }], stopReason: 'stop' } });
    expect(node.innerHTML).toBe(html);
    expect(node.querySelector('pre')).toBe(pre);
    expect(node.querySelectorAll('.copy-code')).toHaveLength(1);
  });

  it('batches token bursts and immediately gives the authoritative final answer precedence over queued fragments', async () => {
    const { window, app } = await client();
    const sanitize = vi.spyOn(window.DOMPurify, 'sanitize');
    streamText(app, '## ');
    const initialRenders = sanitize.mock.calls.length;
    for (const token of ['Live', ' ', 'answer', '\n\n', '**', 'done', '**']) streamText(app, token);
    expect(sanitize).toHaveBeenCalledTimes(initialRenders);
    const node = window.document.querySelector('.turn.assistant .turn-text');
    await vi.waitFor(() => expect(node.querySelector('strong')?.textContent).toBe('done'));
    expect(sanitize).toHaveBeenCalledTimes(initialRenders + 1);
    streamText(app, '\n\nstale pending fragment');
    app.handleEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '## Final answer\n\n**Authoritative**' }] } });
    expect(node.querySelector('h2').textContent).toBe('Final answer');
    const finalRenders = sanitize.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    expect(sanitize).toHaveBeenCalledTimes(finalRenders);
    expect(node.textContent).not.toContain('stale');
    expect(node.dataset.raw).toBe('## Final answer\n\n**Authoritative**');
  });

  it('continues a formatted partial snapshot and cancels queued work when replacing or leaving a conversation', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'first';
    app.applySnapshot({ id: 'first', running: true, messages: [], partialMessage: { role: 'assistant', content: [{ type: 'text', text: '## Reconnected\n\n**first** ' }] } });
    const node = window.document.querySelector('.turn.assistant .turn-text'), heading = node.querySelector('h2');
    streamText(app, 'and `next`');
    await vi.waitFor(() => expect(node.querySelector('code')?.textContent).toBe('next'));
    expect(node.querySelector('h2')).toBe(heading);
    expect(node.dataset.raw).toBe('## Reconnected\n\n**first** and `next`');
    streamText(app, ' stale fragment');
    app.state.sessionId = 'other';
    app.applySnapshot({ id: 'other', running: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: '**Fresh session**' }] }] });
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    expect(node.textContent).not.toContain('stale');
    expect(window.document.querySelector('#timeline .turn-text strong').textContent).toBe('Fresh session');
    streamText(app, 'pending before new conversation');
    await app.newConversation();
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    expect(window.document.getElementById('timeline').textContent).toBe('');
  });

  it('sanitizes every streamed prefix, including split raw HTML, remote images and unsafe links', async () => {
    const { window, app } = await client();
    const sanitize = vi.spyOn(window.DOMPurify, 'sanitize');
    for (const delta of ['## Safe\n\n<script onload=', '"alert(1)">bad</script>\n\n![remote](https://example.com/pixel)\n\n[unsafe](java', 'script:alert(1))\n\n[good](https://example.com)\n\n<p class="modal">fake</p>']) {
      streamText(app, delta);
      const renders = sanitize.mock.calls.length;
      await vi.waitFor(() => expect(sanitize.mock.calls.length).toBeGreaterThan(renders));
      const node = window.document.querySelector('.turn.assistant .turn-text');
      expect(node.querySelector('script, img, .modal, [onclick], [onload], [style], a[href^="javascript:"]')).toBeNull();
    }
    const node = window.document.querySelector('.turn.assistant .turn-text');
    expect(node.querySelector('h2').textContent).toBe('Safe');
    expect([...node.querySelectorAll('a[href]')].map((a) => a.href)).toEqual(['https://example.com/']);
    expect(node.textContent).toContain('<script');
  });

  it('follows growing output only while the reader is near the end', async () => {
    const { window, app } = await client();
    streamText(app, '## Live\n\nStart\n\n');
    const node = window.document.querySelector('.turn.assistant .turn-text');
    await vi.waitFor(() => expect(node.querySelector('h2')).toBeTruthy());
    const timeline = window.document.getElementById('timeline');
    Object.defineProperties(timeline, { clientHeight: { value: 200, configurable: true }, scrollHeight: { get: () => 2000 + node.textContent.length, configurable: true } });
    timeline.scrollTop = 200;
    streamText(app, '- reading history\n');
    await vi.waitFor(() => expect(node.querySelector('li')).toBeTruthy());
    expect(timeline.scrollTop).toBe(200);
    timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
    streamText(app, '- ' + 'growing '.repeat(50));
    await vi.waitFor(() => expect(node.querySelectorAll('li')).toHaveLength(2));
    expect(timeline.scrollTop).toBe(timeline.scrollHeight);
  });
});

async function reviewClient(initial = {}) {
  const fixture = await client(initial), { window, app, requests } = fixture;
  const review = { available: true, files: [
    { path: 'src/a.ts', status: ' M', fingerprint: 'a1', preexisting: true, observed: false },
    { path: 'src/b.ts', status: '??', fingerprint: 'b1', preexisting: false, observed: true }
  ] };
  const diffs = { 'src/a.ts': '@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n', 'src/b.ts': '+second file\n' };
  const projectFiles = [
    { path: 'src/a.ts', size: 64, kind: 'text' },
    { path: 'README.md', size: 28, kind: 'text' }
  ];
  const fetcher = window.fetch;
  window.fetch = async (url, init) => {
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname === '/api/files') { requests.push({ url, ...init }); const query = parsed.searchParams.get('q') || ''; return { ok: true, status: 200, json: async () => ({ files: projectFiles.filter((file) => file.path.includes(query)) }) }; }
    if (parsed.pathname === '/api/files/content') { requests.push({ url, ...init }); const path = parsed.searchParams.get('path'); return { ok: true, status: 200, json: async () => ({ path, size: 24, text: path === 'README.md' ? '# Forge\n' : 'export const value = 42;\n' }) }; }
    if (parsed.pathname === '/api/terminal') { requests.push({ url, ...init }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { exitCode: 0, combined: 'tests passed\n', durationMs: 12, truncated: false } }) }; }
    if (!parsed.pathname.endsWith('/changes')) return fetcher(url, init);
    requests.push({ url, ...init });
    const path = parsed.searchParams.get('path');
    return { ok: true, status: 200, json: async () => path ? { path, diff: diffs[path] } : { ...review } };
  };
  await app.createSession(undefined, 'Review');
  return { ...fixture, review, diffs, projectFiles };
}

describe('Git review workspace', () => {
  it('opens a separate review panel during a run and safely previews the first file', async () => {
    const { window, app } = await reviewClient(), find = (id) => window.document.getElementById(id);
    expect(find('changes-panel').closest('#conversation-view')).toBeNull();
    expect(find('changes-panel').parentElement).toBe(find('workspace-body'));
    expect(find('changes-panel').classList.contains('hidden')).toBe(true);
    expect(find('toggle-changes').classList.contains('hidden')).toBe(false);
    app.setRunning(true);
    find('toggle-changes').click();
    await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    expect(find('toggle-changes').getAttribute('aria-expanded')).toBe('true');
    expect(find('changes-count').textContent).toBe('2');
    expect(find('changes-file-name').textContent).toBe('src/a.ts');
    expect(find('changes-diff').textContent).toBe('@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n');
    expect(find('changes-diff').querySelector('img')).toBeNull();
    expect(find('changes-diff').querySelectorAll('.diff-add')).toHaveLength(1);
    expect(find('changes-files').textContent).toContain('已有修改');
    expect(find('changes-files').textContent).toContain('期间变化');
    expect(find('refresh-changes').disabled).toBe(false);
    find('changes-close').click();
    expect(find('changes-panel').classList.contains('hidden')).toBe(true);
    expect(window.document.activeElement).toBe(find('toggle-changes'));
    app.setRunning(false);
  });

  it('preserves the selected file, focus and diff position across snapshots and explicit refreshes', async () => {
    const { window, app, requests, review, diffs } = await reviewClient(), find = (id) => window.document.getElementById(id);
    find('toggle-changes').click();
    await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    await app.loadChangeDiff('src/b.ts');
    const button = window.document.querySelector('[data-change-path="src/b.ts"]'), diff = find('changes-diff');
    button.focus(); diff.scrollTop = 80; diff.scrollLeft = 24; find('changes-files').scrollTop = 30;
    const previousDiffRequests = requests.filter((request) => request.url.includes('/changes?')).length;
    app.applySnapshot({ id: 'created', running: false, messages: [] });
    await vi.waitFor(() => expect(find('refresh-changes').disabled).toBe(false));
    expect(requests.filter((request) => request.url.includes('/changes?'))).toHaveLength(previousDiffRequests);
    expect(window.document.activeElement.dataset.changePath).toBe('src/b.ts');
    expect(diff.scrollTop).toBe(80); expect(diff.scrollLeft).toBe(24); expect(find('changes-files').scrollTop).toBe(30);
    expect(diff.textContent).toBe('+second file\n');
    review.files[1].fingerprint = 'b2'; diffs['src/b.ts'] = '+updated second file\n';
    find('refresh-changes').click();
    await vi.waitFor(() => expect(diff.textContent).toBe('+updated second file\n'));
    expect(window.document.querySelector('.change-file.selected').dataset.changePath).toBe('src/b.ts');
    expect(diff.scrollTop).toBe(80); expect(diff.scrollLeft).toBe(24);
  });

  it('ignores late file responses when a newer selection is still loading', async () => {
    const { window, app } = await reviewClient(), find = (id) => window.document.getElementById(id);
    find('toggle-changes').click(); await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    const fetcher = window.fetch, pending = new Map();
    window.fetch = (url, init) => url.includes('/changes?') ? new Promise((resolve) => pending.set(new URL(url, window.location.origin).searchParams.get('path'), resolve)) : fetcher(url, init);
    const second = app.loadChangeDiff('src/b.ts'), first = app.loadChangeDiff('src/a.ts');
    pending.get('src/b.ts')({ ok: true, json: async () => ({ diff: '+stale second' }) }); await second;
    expect(find('changes-file-name').textContent).toBe('src/a.ts');
    expect(find('changes-diff').textContent).toBe('正在读取差异…');
    expect(find('changes-preview').getAttribute('aria-busy')).toBe('true');
    pending.get('src/a.ts')({ ok: true, json: async () => ({ diff: '+latest first' }) }); await first;
    expect(find('changes-diff').textContent).toBe('+latest first');
    expect(find('changes-preview').getAttribute('aria-busy')).toBe('false');
  });

  it('invalidates outstanding lists and diffs when switching sessions or starting a new conversation', async () => {
    const { window, app, review } = await reviewClient(), find = (id) => window.document.getElementById(id);
    find('toggle-changes').click(); await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    const fetcher = window.fetch; let releaseDiff, releaseList;
    window.fetch = (url, init) => {
      if (url.startsWith('/api/sessions/created/changes?')) return new Promise((resolve) => { releaseDiff = resolve; });
      if (url === '/api/sessions/created/changes') return new Promise((resolve) => { releaseList = resolve; });
      return fetcher(url, init);
    };
    const staleDiff = app.loadChangeDiff('src/b.ts'), staleList = app.loadChanges();
    review.files = [];
    app.state.sessionId = 'other'; app.applySnapshot({ id: 'other', running: false, messages: [] });
    await vi.waitFor(() => expect(find('changes-count').textContent).toBe('0'));
    releaseDiff({ ok: true, json: async () => ({ diff: '+previous session' }) });
    releaseList({ ok: true, json: async () => ({ available: true, files: [{ path: 'stale.ts', status: ' M' }] }) });
    await Promise.all([staleDiff, staleList]);
    expect(find('changes-files').textContent).toContain('工作区没有未提交变更');
    expect(find('changes-diff').textContent).not.toContain('previous session');
    expect(find('changes-file-name').textContent).toBe('文件差异');
    expect(find('refresh-changes').disabled).toBe(false);
    let releaseOther;
    window.fetch = (url, init) => url === '/api/sessions/other/changes' ? new Promise((resolve) => { releaseOther = resolve; }) : fetcher(url, init);
    const pending = app.loadChanges(); await app.newConversation();
    releaseOther({ ok: true, json: async () => ({ available: true, files: [{ path: 'late.ts', status: ' M' }] }) }); await pending;
    expect(find('changes-panel').classList.contains('hidden')).toBe(true);
    expect(find('toggle-changes').classList.contains('hidden')).toBe(true);
    expect(find('changes-files').textContent).toBe('');
    expect(app.state.changes.selectedPath).toBeNull();
  });

  it('clears a removed selection and recovers from unavailable repositories and read errors', async () => {
    const { window, app, review } = await reviewClient(), find = (id) => window.document.getElementById(id);
    find('toggle-changes').click(); await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    review.files = []; await app.loadChanges();
    expect(app.state.changes.selectedPath).toBeNull();
    expect(find('changes-diff').textContent).toContain('工作区没有未提交变更');
    review.available = false; review.reason = '当前文件夹未初始化 Git'; await app.loadChanges();
    expect(find('changes-note').textContent).toBe(review.reason);
    expect(find('changes-count').textContent).toBe('');
    const fetcher = window.fetch;
    window.fetch = async (url, init) => url.endsWith('/changes') ? { ok: false, status: 500, json: async () => ({ error: 'git read failed' }) } : fetcher(url, init);
    await app.loadChanges();
    expect(find('changes-note').textContent).toContain('git read failed');
    expect(find('refresh-changes').disabled).toBe(false);
    review.available = true; review.files = [{ path: 'src/b.ts', status: '??', fingerprint: 'b2' }];
    window.fetch = async (url, init) => url.includes('/changes?') ? { ok: false, status: 500, json: async () => ({ error: 'diff read failed' }) } : fetcher(url, init);
    await app.loadChanges();
    expect(find('changes-diff').textContent).toContain('diff read failed');
    expect(find('changes-preview').getAttribute('aria-busy')).toBe('false');
    expect(find('refresh-changes').disabled).toBe(false);
    window.fetch = fetcher; await app.loadChanges(true);
    expect(find('changes-diff').textContent).toBe('+second file\n');
  });

  it('uses a modal drawer on narrow screens, traps focus, and releases the chat when closed or widened', async () => {
    const { window, app, reviewMedia } = await reviewClient({ narrow: true }), find = (id) => window.document.getElementById(id);
    find('toggle-changes').click(); await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    expect(find('changes-panel').getAttribute('aria-modal')).toBe('true');
    expect(find('changes-backdrop').classList.contains('hidden')).toBe(false);
    expect(find('chat-pane').inert).toBe(true); expect(find('workspace-header').inert).toBe(true); expect(find('sidebar').inert).toBe(true);
    expect(window.document.activeElement).toBe(find('changes-close'));
    find('changes-diff').focus(); find('changes-diff').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(window.document.activeElement).toBe(find('refresh-changes'));
    find('refresh-changes').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(window.document.activeElement).toBe(find('changes-diff'));
    find('changes-diff').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(find('changes-panel').classList.contains('hidden')).toBe(true);
    expect(find('chat-pane').inert).toBe(false); expect(window.document.activeElement).toBe(find('toggle-changes'));
    find('toggle-changes').click(); reviewMedia.matches = false; reviewMedia.dispatchEvent(new window.Event('change'));
    expect(find('changes-panel').getAttribute('aria-modal')).toBeNull();
    expect(find('chat-pane').inert).toBe(false); expect(find('changes-backdrop').classList.contains('hidden')).toBe(true);
    reviewMedia.matches = true; reviewMedia.dispatchEvent(new window.Event('change')); find('changes-backdrop').click();
    expect(find('chat-pane').inert).toBe(false); expect(find('sidebar').inert).toBe(false);
    expect(window.document.activeElement).toBe(find('toggle-changes'));
  });

  it('switches between Git changes, safe project files and the user-controlled terminal', async () => {
    const { window, app, requests } = await reviewClient(), find = (id) => window.document.getElementById(id);
    find('toggle-changes').click(); await vi.waitFor(() => expect(app.state.changes.diffStatus).toBe('ready'));
    find('changes-tabs').querySelector('[data-review-view="files"]').click();
    await vi.waitFor(() => expect(find('review-file-content').textContent).toContain('export const value = 42'));
    expect(find('review-file-list').textContent).toContain('src/a.ts');
    find('review-file-list').querySelector('[data-project-file-path="README.md"]').click();
    await vi.waitFor(() => expect(find('review-file-content').textContent).toContain('# Forge'));
    find('review-file-search').value = 'README'; find('review-file-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(find('review-file-list').querySelectorAll('[data-project-file-path]')).toHaveLength(1));
    find('changes-tabs').querySelector('[data-review-view="terminal"]').click();
    find('review-terminal-command').value = 'npm test'; find('review-terminal-form').requestSubmit();
    await vi.waitFor(() => expect(find('review-terminal-output').textContent).toContain('tests passed'));
    expect(JSON.parse(requests.find((request) => request.url === '/api/terminal').body)).toMatchObject({ project: 'C:\\repo', command: 'npm test', timeoutMs: 30000 });
    expect(find('review-terminal-output').textContent).toContain('退出码 0');
  });
});

describe('Task center scope', () => {
  it('enqueues against the captured session and settings while preserving a later draft and stopping only the selected job', async () => {
    const { window, app, requests } = await client(), find = (id) => window.document.getElementById(id);
    await app.createSession(undefined, 'Queue'); app.state.pendingModelKey = 'mock/b'; app.state.pendingThinkingLevel = 'off';
    const originalFetch = window.fetch; let release;
    window.fetch = async (url, init = {}) => {
      if (url === '/api/jobs' && init.method === 'POST') { requests.push({ url, ...init }); return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({}) }); }); }
      if (url.startsWith('/api/jobs') && !init.method) return { ok: true, json: async () => ({ scheduler: { concurrency: 3, running: 2, queued: 1 }, jobs: [{ id: 'one', status: 'running', project: 'C:\\repo', model: 'mock/a', title: 'First' }, { id: 'two', status: 'running', project: 'C:\\other', model: 'mock/b', title: 'Second' }] }) };
      return originalFetch(url, init);
    };
    find('tasks-button').click(); await vi.waitFor(() => expect(find('queue-summary').textContent).toContain('2/3'));
    find('queue-task-input').value = 'Fix the first project';
    const event = new window.Event('submit', { bubbles: true, cancelable: true }); find('queue-task-form').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(find('queue-task-submit').disabled).toBe(true);
    const posted = requests.find((request) => request.url === '/api/jobs' && request.method === 'POST');
    expect(JSON.parse(posted.body)).toEqual({ session: 'created', message: 'Fix the first project', model: 'mock/b', thinkingLevel: 'off', workflow: 'direct' });
    app.state.sessionId = 'another'; find('queue-task-input').value = 'Keep this new draft'; release();
    await vi.waitFor(() => expect(find('queue-task-submit').disabled).toBe(false)); expect(find('queue-task-input').value).toBe('Keep this new draft');
    find('queue-list').querySelector('[data-cancel-job="one"]').click();
    await vi.waitFor(() => expect(requests.some((request) => request.url === '/api/jobs/one/cancel')).toBe(true));
    expect(requests.some((request) => request.url === '/api/jobs/two/cancel')).toBe(false);
    window.fetch = async (url, init = {}) => url === '/api/jobs' && init.method === 'POST' ? { ok: false, status: 409, json: async () => ({ error: 'Session is unavailable' }) } : originalFetch(url, init);
    find('queue-task-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(find('toast-root').textContent).toContain('Session is unavailable'));
    expect(find('queue-task-input').value).toBe('Keep this new draft');
  });
  it('switches between current-project and all-project task discovery', async () => {
    const { window, requests } = await client(), find = (id) => window.document.getElementById(id);
    find('tasks-button').click();
    await vi.waitFor(() => expect(find('tasks-panel').classList.contains('hidden')).toBe(false));
    expect(requests.some((request) => request.url.startsWith('/api/tasks?project='))).toBe(true);
    find('tasks-scope').value = 'all'; find('tasks-scope').dispatchEvent(new window.Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests.some((request) => request.url === '/api/tasks')).toBe(true));
    expect(find('tasks-note').textContent).toContain('还没有持久化任务');
  });
});

describe('Composer run controls', () => {
  it('keeps send, stop and continuation in the composer and waits for a confirmed stop', async () => {
    const { window, app, requests } = await client(), find = (id) => window.document.getElementById(id);
    await app.createSession(undefined, 'Stop');
    expect(find('stop-button').closest('#followup-form')).not.toBeNull();
    expect(find('resume-task-button').closest('#followup-form')).not.toBeNull();
    expect(window.document.querySelector('.conversation-header #stop-button, #task-panel #resume-task-button')).toBeNull();
    app.applySnapshot({ id: 'created', running: true, outcome: 'running', messages: [] });
    expect(find('stop-button').classList.contains('hidden')).toBe(false);
    expect(find('followup-send').classList.contains('hidden')).toBe(true);
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    app.state.sending = true; app.setRunning(true);
    expect(find('stop-button').disabled).toBe(true);
    app.state.sending = false; app.setRunning(true);
    expect(find('stop-button').disabled).toBe(false);
    find('followup-prompt').value = 'retain my draft';
    const fetcher = window.fetch; let release;
    window.fetch = (url, init) => {
      if (url.endsWith('/abort')) { requests.push({ url, ...init }); return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ ok: true }) }); }); }
      if (url.endsWith('/state')) return Promise.resolve({ ok: true, json: async () => ({ id: 'created', running: false, outcome: 'aborted', messages: [] }) });
      return fetcher(url, init);
    };
    const stopping = app.stopExecution();
    expect(find('stop-button').disabled).toBe(true);
    expect(find('composer-control-status').textContent).toBe('正在停止…');
    expect(await app.stopExecution()).toBe(false);
    app.handleEvent({ type: 'agent_settled', aborted: true, taskRunning: false });
    expect(find('stop-button').classList.contains('hidden')).toBe(false);
    expect(await app.resumeExecution()).toBe(false);
    expect(await app.sendFollowup('competing prompt')).toBe(false);
    release(); expect(await stopping).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/abort'))).toHaveLength(1);
    expect(find('followup-prompt').value).toBe('retain my draft');
    expect(find('followup-send').classList.contains('hidden')).toBe(false);
    find('followup-prompt').value = ''; find('followup-prompt').dispatchEvent(new window.Event('input'));
    expect(find('stop-button').classList.contains('hidden')).toBe(true);
    expect(find('resume-task-button').classList.contains('hidden')).toBe(false);
    expect(find('resume-task-button').disabled).toBe(false);
    expect(find('composer-control-status').classList.contains('hidden')).toBe(true);
  });

  it('continues an interrupted ordinary turn in the same conversation and applies staged model settings first', async () => {
    const first = model('a', { reasoning: true, thinkingLevels: ['low', 'high'] }), second = model('b', { reasoning: true, thinkingLevels: ['low', 'high'] });
    const { window, app, requests } = await client({ models: [first, second], thinkingLevel: 'low' }), find = (id) => window.document.getElementById(id);
    await app.createSession(undefined, 'Resume');
    app.applySnapshot({ id: 'created', running: true, outcome: 'running', model: first, thinkingLevel: 'low', messages: [] });
    await app.changeModel('mock/b'); await app.changeThinking('high');
    app.handleEvent({ type: 'agent_settled', aborted: true, taskRunning: false });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(false);
    const fetcher = window.fetch; let release;
    window.fetch = (url, init) => {
      if (url.endsWith('/prompt')) { requests.push({ url, ...init }); return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ accepted: true }) }); }); }
      if (url.endsWith('/state')) return Promise.resolve({ ok: true, json: async () => ({ id: 'created', running: true, outcome: 'running', messages: [] }) });
      return fetcher(url, init);
    };
    const resuming = app.resumeExecution();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(find('resume-task-label').textContent).toBe('继续中…');
    expect(await app.resumeExecution()).toBe(false);
    expect(await app.sendFollowup('duplicate')).toBe(false);
    release(); expect(await resuming).toBe(true);
    const changes = requests.filter((request) => request.method === 'POST' && request.url.startsWith('/api/sessions/'));
    expect(changes.map((request) => request.url)).toEqual(['/api/sessions/created/model', '/api/sessions/created/thinking', '/api/sessions/created/prompt']);
    expect(JSON.parse(changes.at(-1).body)).toMatchObject({ workflow: 'direct', message: expect.stringContaining('继续刚才中断') });
    expect(requests.some((request) => request.url.endsWith('/resume-task'))).toBe(false);
    expect(find('stop-button').classList.contains('hidden')).toBe(false);
    app.setRunning(false);
  });

  it('uses explicit task continuation for interrupted workflows while new text remains an ordinary prompt', async () => {
    const { window, app, requests } = await client(), find = (id) => window.document.getElementById(id);
    await app.createSession(undefined, 'Planned');
    const interrupted = { id: 'task-1', kind: 'change', status: 'interrupted', phase: 'implement', repairs: 0, phases: [] };
    app.applySnapshot({ id: 'created', running: false, outcome: 'idle', workflow: 'planned', task: interrupted, messages: [] });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(false);
    expect(find('resume-task-button').title).toContain('重新检查');
    find('followup-prompt').value = 'new instructions'; find('followup-prompt').dispatchEvent(new window.Event('input'));
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    expect(find('followup-send').classList.contains('hidden')).toBe(false);
    const fetcher = window.fetch;
    window.fetch = (url, init) => url.endsWith('/state') ? Promise.resolve({ ok: true, json: async () => ({ id: 'created', running: true, task: { ...interrupted, status: 'running', phase: 'inspect' }, messages: [] }) }) : fetcher(url, init);
    find('followup-prompt').value = ''; find('followup-prompt').dispatchEvent(new window.Event('input'));
    find('followup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.filter((request) => request.url.endsWith('/resume-task'))).toHaveLength(1));
    await vi.waitFor(() => expect(app.state.runControl).toBeNull());
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    expect(app.state.running).toBe(true);
    app.setRunning(false);
  });

  it('does not show continuation for completed, read-only or incompatible task modes', async () => {
    const { window, app } = await client(), find = (id) => window.document.getElementById(id);
    await app.createSession(undefined, 'States');
    const task = { kind: 'change', phase: 'implement', status: 'aborted', phases: [] };
    app.applySnapshot({ id: 'created', running: false, outcome: 'completed', messages: [] });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    expect(await app.resumeExecution()).toBe(false);
    app.applySnapshot({ id: 'created', running: false, outcome: 'aborted', readOnly: true, messages: [] });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    app.applySnapshot({ id: 'created', running: false, outcome: 'aborted', readOnly: false, mode: 'plan', task, messages: [] });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    app.applySnapshot({ id: 'created', running: false, mode: 'agent', task, messages: [] });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(false);
    app.applySnapshot({ id: 'created', running: true, outcome: 'running', task: { ...task, status: 'running' }, messages: [] });
    expect(find('resume-task-button').classList.contains('hidden')).toBe(true);
    app.setRunning(false);
  });

  it('recovers button states on stop or continuation errors without losing the draft or replaying a request', async () => {
    const { window, app, requests } = await client(), find = (id) => window.document.getElementById(id);
    await app.createSession(undefined, 'Errors');
    app.applySnapshot({ id: 'created', running: true, outcome: 'running', messages: [] });
    const fetcher = window.fetch;
    window.fetch = (url, init) => url.endsWith('/abort') || url.endsWith('/prompt') ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'still busy' }) }) : url.endsWith('/state') ? Promise.resolve({ ok: true, json: async () => ({ id: 'created', running: false, outcome: 'aborted', messages: [] }) }) : fetcher(url, init);
    expect(await app.stopExecution()).toBe(false);
    expect(app.state.running).toBe(true); expect(find('stop-button').disabled).toBe(false);
    app.applySnapshot({ id: 'created', running: false, outcome: 'aborted', messages: [] });
    find('followup-prompt').value = 'retain this draft';
    expect(await app.resumeExecution()).toBe(false);
    expect(find('followup-prompt').value).toBe('retain this draft');
    expect(app.state.runControl).toBeNull(); expect(app.state.sending).toBe(false);
    expect(window.document.getElementById('toast-root').textContent).toContain('继续失败');
    expect(requests.filter((request) => request.url === '/api/session')).toHaveLength(1);
  });
});

describe('Web client integration', () => {
  it('provides visible network settings, a real diagnostic action and explicit failure feedback without sending a model prompt', async () => {
    const {window,app,requests}=await client({firstRun:true});
    const fetcher=window.fetch;
    window.fetch=(url,init)=>url==='/api/network/check'?Promise.resolve({ok:true,json:async()=>({ok:false,message:'HTTP 429: connection rate limited'})}):fetcher(url,init);
    await app.openSettings('tools');
    const doc=window.document;
    expect(doc.querySelector('[data-settings-tab="tools"]').getAttribute('aria-pressed')).toBe('true');
    expect(doc.getElementById('network-enabled').checked).toBe(true);
    expect(doc.querySelector('[data-settings-panel="tools"]').textContent).toContain('web_search');
    doc.getElementById('network-enabled').checked=false;doc.getElementById('save-network').click();
    await vi.waitFor(()=>expect(doc.getElementById('save-network').disabled).toBe(false));
    expect(JSON.parse(requests.find(r=>r.url==='/api/settings/network').body)).toEqual({enabled:false});
    doc.getElementById('check-network').click();
    await vi.waitFor(()=>expect(doc.getElementById('network-diagnostic').textContent).toContain('HTTP 429'));
    expect(requests.some(r=>r.url.endsWith('/prompt'))).toBe(false);
  });

  it('keeps committed-deletion diagnostics visible after the settings tree is remounted', async () => {
    const { window, app } = await client(); let deleted = false;
    const fetcher = window.fetch;
    window.fetch = async (url, init = {}) => {
      if (url === '/api/providers/custom') return new Response(JSON.stringify({ providers: deleted ? [] : [{ id: 'third-party', name: 'Gateway', models: [], editable: true, revision: 'provider-revision' }] }), { status: 200 });
      if (url === '/api/providers/custom/third-party' && init.method === 'DELETE') { deleted = true; return new Response(JSON.stringify({ removed: true, diagnostic: '服务已删除，但目录刷新失败，请重启服务' }), { status: 200 }); }
      return fetcher(url, init);
    };
    await app.openSettings('provider'); window.document.querySelector('[data-delete-custom]').click();
    await vi.waitFor(() => expect(window.document.querySelector('#toast-root').textContent).toContain('目录刷新失败'));
    expect(window.document.querySelector('[data-delete-custom]')).toBeNull();
  });
  it('opens the MCP settings entry and preserves a configuration draft across change notifications', async () => {
    const { window, app, streams } = await client();
    app.state.sessionId = 'mcp-session'; app.connect('mcp-session');
    await app.openSettings('mcp');
    expect(window.document.querySelectorAll('[data-settings-tab]')).toHaveLength(8);
    const root = window.document.getElementById('mcp-settings');
    root.querySelector('[data-action="add"]').click();
    const name = root.querySelector('[name="name"]'); name.value = 'unsaved-service';
    streams[0].onEvent({ id: '1', data: JSON.stringify({ type: 'pforge_mcp_changed' }) });
    expect(root.querySelector('[name="name"]')).toBe(name);
    expect(name.value).toBe('unsaved-service');
  });
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

  it('restores an explicitly chosen session workflow without expanding the strategy menu or carrying it into a new conversation', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', mode: 'agent', workflow: 'planned', messages: [], running: false });
    expect(app.state.workflow).toBe('planned');
    expect(window.document.getElementById('mode-select').value).toBe('agent:planned');
    expect(window.document.querySelector('[data-choose-mode="agent:planned"] .mode-check').textContent).toBe('✓');
    expect(window.document.querySelector('#followup-mode-picker-button [data-mode-label]').textContent).toBe('Agent');
    expect(window.document.querySelector('#followup-mode-picker-button [data-workflow-label]').classList.contains('hidden')).toBe(false);
    window.document.getElementById('followup-mode-picker-button').click();
    expect(window.document.getElementById('agent-strategies').classList.contains('hidden')).toBe(true);
    await app.newConversation();
    expect(app.state.workflow).toBe('direct');
    expect(window.document.getElementById('mode-select').value).toBe('agent:direct');
    expect(window.document.querySelector('#mode-picker-button [data-workflow-label]').classList.contains('hidden')).toBe(true);
    expect(window.document.getElementById('mode-picker').classList.contains('hidden')).toBe(true);
  });

  it('defaults to adaptive despite a legacy planned preference and opts into staged execution only after selecting it', async () => {
    const { window, app, requests } = await client({ localStorage: { 'pforge.workflow': 'planned' } });
    const find = (id) => window.document.getElementById(id);
    expect(app.state.workflow).toBe('direct');
    expect(find('mode-description').classList.contains('hidden')).toBe(true);
    expect(find('mode-picker-button').getAttribute('aria-label')).toContain('自适应（默认）');
    find('mode-picker-button').click();
    expect(find('mode-agent-toggle').getAttribute('aria-expanded')).toBe('false');
    find('mode-agent-toggle').click();
    expect(find('agent-strategies').classList.contains('hidden')).toBe(false);
    expect(app.state.workflow).toBe('direct');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    window.document.querySelector('[data-choose-mode="agent:planned"]').click();
    await vi.waitFor(() => expect(app.state.workflow).toBe('planned'));
    expect(find('mode-picker').classList.contains('hidden')).toBe(true);
    expect(find('mode-agent-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(await app.sendPrompt('Implement this change')).toBe(true);
    expect(JSON.parse(requests.find((request) => request.url === '/api/session').body).workflow).toBe('planned');
    expect(JSON.parse(requests.find((request) => request.url.endsWith('/prompt')).body).workflow).toBe('planned');
    app.setRunning(false);
    await app.newConversation();
    expect(app.state.workflow).toBe('direct');
    expect(await app.sendPrompt('Implement another change')).toBe(true);
    expect(JSON.parse(requests.filter((request) => request.url.endsWith('/prompt')).at(-1).body).workflow).toBe('direct');
  });

  it('returns to adaptive from the primary Agent option and keeps strategy keyboard navigation separate from selection', async () => {
    const { window, app, requests } = await client();
    const find = (id) => window.document.getElementById(id);
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', mode: 'agent', workflow: 'planned', messages: [], running: false });
    find('followup-mode-picker-button').click();
    const agent = window.document.querySelector('[data-choose-mode="agent"]');
    agent.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(window.document.activeElement.dataset.chooseMode).toBe('agent:planned');
    window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(find('agent-strategies').classList.contains('hidden')).toBe(true);
    expect(find('mode-picker').classList.contains('hidden')).toBe(false);
    expect(app.state.workflow).toBe('planned');
    agent.click();
    await vi.waitFor(() => expect(JSON.parse(requests.find((request) => request.url.endsWith('/workflow')).body)).toEqual({ workflow: 'direct' }));
    expect(app.state.workflow).toBe('direct');
    expect(find('followup-mode-picker-button').getAttribute('aria-label')).toContain('自适应（默认）');
    find('followup-mode-picker-button').click();
    expect(find('agent-strategies').classList.contains('hidden')).toBe(true);
    window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(find('mode-picker').classList.contains('hidden')).toBe(true);
    expect(window.document.activeElement).toBe(find('followup-mode-picker-button'));
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

  it('uses nested Agent strategies and stages model and effort changes while a run is active', async () => {
    const first = model('a', { reasoning: true, thinkingLevels: ['off', 'low', 'high'] });
    const second = model('b', { reasoning: true, thinkingLevels: ['off', 'low', 'high'] });
    const { window, app, requests } = await client({ models: [first, second] });
    const mode = window.document.getElementById('mode-select');
    expect([...mode.options].map((option) => option.value)).toEqual(['agent:direct', 'agent:planned', 'plan', 'ask']);
    mode.value = 'agent:planned'; mode.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(app.state.mode).toBe('agent');
    expect(app.state.workflow).toBe('planned');
    expect(window.document.getElementById('mode-description').textContent).toContain('复杂修改先规划');

    app.state.sessionId = 'live'; app.state.activeModelKey = first.key; app.state.activeThinkingLevel = 'off'; app.state.model = first;
    app.setRunning(true);
    expect(window.document.getElementById('mode-select').disabled).toBe(false);
    expect(window.document.getElementById('model-picker-button').disabled).toBe(false);
    window.document.getElementById('model-picker-button').click();
    window.document.querySelector('[data-choose-model="mock/b"]').click();
    expect(app.state.pendingModelKey).toBe('mock/b');
    expect(requests.some((request) => request.url.endsWith('/model') || request.url.endsWith('/settings') && request.method === 'POST')).toBe(false);
    const effort = window.document.getElementById('thinking-select');
    effort.value = 'high'; effort.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(app.state.pendingThinkingLevel).toBe('high');
    expect(window.document.getElementById('model-save-status').textContent).toContain('下一条消息');
    app.setRunning(false);
  });

  it('folds execution details while keeping the implementation answer prominent', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', running: false, task: { kind: 'change', status: 'completed', phase: 'complete', repairs: 0, phases: [] }, messages: [
      { role: 'user', content: 'Implement the change' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal reasoning' }, { type: 'text', text: 'Implementation finished.' }, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'a.ts' } }] },
      { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'file content' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] }
    ] });
    const process = window.document.querySelector('.execution-details');
    expect(process).not.toBeNull();
    expect(process.open).toBe(false);
    expect(window.document.querySelectorAll('#timeline > .turn.assistant')).toHaveLength(1);
    expect(window.document.querySelector('#timeline > .turn.assistant').textContent).toContain('Final answer.');
    expect(window.document.querySelector('.thinking-block').closest('.execution-details')).not.toBeNull();
    expect(window.document.querySelector('.tool-row').closest('.execution-details')).not.toBeNull();
  });
  it('fills a long-task budget without saving or changing the cost ceiling until explicitly saved', async () => {
    const { window, app, requests } = await client();
    await app.openSettings();
    window.document.querySelector('[data-settings-tab="system"]').click();
    const cost = window.document.getElementById('budget-cost').value;
    window.document.querySelector('[data-budget-preset="long"]').click();
    expect(window.document.getElementById('budget-duration').value).toBe('240');
    expect(window.document.getElementById('budget-turns').value).toBe('400');
    expect(window.document.getElementById('budget-tools').value).toBe('800');
    expect(window.document.getElementById('budget-output-tokens').value).toBe('500000');
    expect(window.document.getElementById('budget-cost').value).toBe(cost);
    expect(requests.some((item) => item.url === '/api/settings/budget' && item.method === 'POST')).toBe(false);
  });
  it('keeps the task summary collapsed, preserves explicit expansion, and exposes the stop reason beside Continue', async () => {
    const { window, app } = await client(); app.state.sessionId = 'compact-status';
    const task = { id: 'phase-1', workflow: 'planned', kind: 'change', phase: 'inspect', status: 'needs_attention', repairs: 0, phases: [], error: 'Specific handoff error <img src=x>' };
    app.applySnapshot({ id: 'compact-status', running: false, outcome: 'failed', task, messages: [] });
    const panel = window.document.getElementById('task-panel');
    expect(panel.tagName).toBe('DETAILS'); expect(panel.open).toBe(false);
    expect(window.document.getElementById('composer-run-note').classList.contains('hidden')).toBe(false);
    expect(window.document.getElementById('composer-run-detail').textContent).toBe(task.error);
    expect(window.document.getElementById('composer-run-note').querySelector('img')).toBeNull();
    panel.open = true; app.handleEvent({ type: 'pforge_task', task: { ...task } }); expect(panel.open).toBe(true);
    app.handleEvent({ type: 'pforge_task', task: { ...task, id: 'phase-2' } }); expect(panel.open).toBe(false);
    app.applySnapshot({ id: 'compact-status', running: true, outcome: 'running', task: { ...task, status: 'running' }, messages: [] });
    expect(window.document.getElementById('composer-run-note').classList.contains('hidden')).toBe(true);
  });
  it('shows review notes separately from blocking findings and renders them as untrusted text', async () => {
    const { window, app } = await client(); app.state.sessionId = 'review-notes';
    const review = { verdict: 'ready', summary: 'Required checks passed', issues: [], notes: ['Optional: <img src=x onerror=alert(1)>'] };
    app.applySnapshot({ id: 'review-notes', running: false, task: { kind: 'change', workflow: 'planned', status: 'completed', phase: 'complete', repairs: 0, phases: [], review }, messages: [] });
    const result = window.document.getElementById('task-review');
    expect(result.textContent).toContain('审阅备注（非阻断）'); expect(result.textContent).toContain(review.notes[0]);
    expect(result.textContent).not.toContain('待处理问题：'); expect(result.querySelector('img')).toBeNull();
    expect(window.document.getElementById('task-note').textContent).toContain('完成证据不完整');
  });
  it('opens acceptance and tool history in the right execution tab and preserves expanded phases on refresh', async () => {
    const { window, app } = await client(); app.state.sessionId = 'run';
    const nodes = [
      { id: 'task', kind: 'task' }, { id: 'phase', parentId: 'task', kind: 'phase', label: 'implement', status: 'completed', durationMs: 1000, attempt: 2 },
      { id: 'model', parentId: 'phase', kind: 'model', status: 'completed', tokens: 42 },
      { id: 'reviewer', parentId: 'phase', kind: 'model', label: 'independent reviewer', status: 'completed' },
      { id: 'tool', parentId: 'model', kind: 'tool', label: '<img src=x>', status: 'interrupted', durationMs: 500, timing: 'message_interval' }
    ];
    const original = window.fetch;
    window.fetch = (url, init) => url.includes('/timeline?') ? Promise.resolve({ ok: true, json: async () => ({ timeline: { nodes, readOnly: true } }) }) : original(url, init);
    app.applySnapshot({ id: 'run', task: { id: 'task', kind: 'change', workflow: 'planned', phase: 'implement', status: 'interrupted', phases: [], plan: { summary: 'A small change', acceptance: [{ id: 'A1', criterion: 'Preserve API <img src=x>', evidence: 'Inspect exported types' }] } }, messages: [] });
    expect(window.document.querySelector('[data-review-panel="execution"]').classList.contains('hidden')).toBe(true);
    window.document.getElementById('open-execution').click();
    const timeline = window.document.getElementById('execution-timeline');
    await vi.waitFor(() => expect(timeline.textContent).toContain('第 2 次'));
    expect(app.state.changes.reviewView).toBe('execution'); expect(timeline.textContent).toContain('42 tokens');
    expect(timeline.textContent).toContain('独立交付审阅');
    expect(timeline.textContent).toContain('已中断 · 约 0.5s'); expect(timeline.querySelector('img')).toBeNull();
    expect(window.document.getElementById('task-plan').textContent).toContain('A1'); expect(window.document.getElementById('task-plan').querySelector('img')).toBeNull();
    timeline.querySelector('details').open = true;
    window.document.getElementById('refresh-changes').click();
    await vi.waitFor(() => expect(timeline.querySelector('details').open).toBe(true));
  });
  it('rejects late timeline data after switching to a different execution', async () => {
    const { window, app } = await client(); app.state.sessionId = 'first';
    let release; const original = window.fetch;
    window.fetch = (url, init) => url.includes('/timeline?') ? new Promise((resolve) => { release = resolve; }) : original(url, init);
    app.applySnapshot({ id: 'first', task: { id: 'first-task', kind: 'change', phase: 'implement', status: 'running', phases: [] }, messages: [] });
    window.document.getElementById('open-execution').click();
    app.state.sessionId = 'second'; app.applySnapshot({ id: 'second', messages: [] });
    release({ ok: true, json: async () => ({ timeline: { nodes: [{ id: 'old', kind: 'phase', label: 'PRIVATE_OLD_PHASE', status: 'completed' }] } }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.document.getElementById('execution-timeline').textContent).not.toContain('PRIVATE_OLD_PHASE');
  });
  it('shows stale evidence, original output and unknown model pricing without a fresh completion claim', async () => {
    const { window, app } = await client(); app.state.sessionId = 'stale';
    const verification = { status: 'passed', evidence: { freshness: 'stale', reason: '检查点恢复后需要重新验证' }, report: { passed: true, results: [{ command: 'npm test', passed: true, exitCode: 0, durationMs: 1, output: 'raw\n$original\n<img src=x>' }] } };
    const budget = { startedAt: new Date().toISOString(), status: 'completed', totalTokens: 100, modelTurns: 1, toolCalls: 2, costUsd: 0, costIncomplete: true, usage: { input: 10, output: 20, cacheRead: 70, cacheWrite: 0 }, limits: {} };
    app.applySnapshot({ id: 'stale', running: false, verification, budget, task: { kind: 'change', workflow: 'direct', status: 'needs_attention', phase: 'complete', phases: [], verification, budget }, messages: [] });
    expect(window.document.getElementById('verification-summary').textContent).toContain('证据已过期');
    expect(window.document.getElementById('verification-output').textContent).toContain('raw\n$original\n<img src=x>');
    expect(window.document.getElementById('verification-output').querySelector('img')).toBeNull();
    expect(window.document.getElementById('task-budget').textContent).toContain('费用未知');
    expect(window.document.getElementById('task-budget').textContent).toContain('缓存读取 70');
    expect(window.document.getElementById('task-review').textContent).toContain('未进行模型审阅');
  });

  it('applies staged model and reasoning before exactly one next prompt and retains them across snapshots', async () => {
    const first = model('a', { reasoning: true, thinkingLevels: ['low', 'high'] });
    const second = model('b', { reasoning: true, thinkingLevels: ['low', 'high'] });
    const { window, app, requests } = await client({ models: [first, second], thinkingLevel: 'high' });
    app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', model: first, thinkingLevel: 'high', running: true, messages: [] });
    await app.changeModel('mock/b'); await app.changeThinking('high');
    app.applySnapshot({ id: 'live', model: first, thinkingLevel: 'high', running: false, messages: [] });
    expect(app.state.model.key).toBe('mock/b'); expect(app.state.thinkingLevel).toBe('high');
    expect(window.document.getElementById('followup-model-picker-button').title).toContain('下一条消息');
    // Editing the staged model after settling must not send a reasoning request
    // against the still-active model on the server.
    await app.changeThinking('low');
    expect(requests.some((request) => request.url.endsWith('/thinking'))).toBe(false);
    const fetcher = window.fetch; let release;
    window.fetch = (url, init) => url.endsWith('/model') ? new Promise((resolve) => { release = () => resolve(fetcher(url, init)); }) : fetcher(url, init);
    const sent = app.sendFollowup('next turn');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await app.sendFollowup('duplicate')).toBe(false);
    release(); expect(await sent).toBe(true);
    const mutations = requests.filter((request) => request.method === 'POST' && request.url.startsWith('/api/sessions/'));
    expect(mutations.map((request) => request.url)).toEqual(['/api/sessions/live/model', '/api/sessions/live/prompt']);
    expect(app.state.activeModelKey).toBe('mock/b'); expect(app.state.thinkingLevel).toBe('low');
    expect(app.state.pendingModelKey).toBeNull(); expect(app.state.pendingThinkingLevel).toBeNull();
    expect(window.document.getElementById('followup-model-picker-button').title).not.toContain('下一条消息');
    app.setRunning(false);
  });

  it('retains a failed staged save and draft without sending a prompt', async () => {
    const { window, app, requests } = await client();
    app.state.sessionId = 'live'; app.applySnapshot({ id: 'live', model: model('a'), thinkingLevel: 'off', running: true, messages: [] });
    await app.changeModel('mock/b'); app.setRunning(false);
    const fetcher = window.fetch;
    window.fetch = (url, init) => url.endsWith('/model') ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'busy model' }) }) : fetcher(url, init);
    window.document.getElementById('followup-prompt').value = 'keep draft';
    expect(await app.sendFollowup('keep draft')).toBe(false);
    expect(app.state.pendingModelKey).toBe('mock/b');
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
    expect(window.document.getElementById('followup-prompt').value).toBe('keep draft');
  });

  it('cancels staged choices when selecting the active model again', async () => {
    const reasoning = model('a', { reasoning: true, thinkingLevels: ['low', 'high'] });
    const { app, requests } = await client({ models: [reasoning, model('b')], thinkingLevel: 'high' });
    app.state.sessionId = 'live'; app.applySnapshot({ id: 'live', model: reasoning, thinkingLevel: 'high', running: true, messages: [] });
    await app.changeModel('mock/b'); expect(app.state.thinkingLevel).toBe('off');
    await app.changeModel('mock/a');
    expect(app.state.pendingModelKey).toBeNull(); expect(app.state.pendingThinkingLevel).toBeNull();
    expect(app.state.thinkingLevel).toBe('high');
    expect(requests.some((request) => request.method === 'POST')).toBe(false); app.setRunning(false);
  });

  it('restores per-turn process folds and task kinds in mixed historical conversations', async () => {
    const { window, app } = await client();
    app.state.sessionId = 'live';
    const assistant = (text, thinking) => ({ type: 'message', message: { role: 'assistant', content: [...(thinking ? [{ type: 'thinking', thinking }] : []), { type: 'text', text }] } });
    const user = (content) => ({ type: 'message', message: { role: 'user', content } });
    const task = (kind, phase) => ({ type: 'custom', customType: 'pforge.task', data: { kind, phase } });
    app.applySnapshot({ id: 'live', running: false, task: { kind: 'answer', phase: 'complete', status: 'completed' }, entries: [
      { type: 'custom', customType: 'pforge.task', data: { cleared: true } }, user('first'), assistant('reading', 'first thoughts'), assistant('first result'),
      task('change', 'inspect'), user('fix it'), assistant('inspection'), task('change', 'plan'), assistant('plan'),
      task('change', 'implement'), assistant('implementation result'), task('change', 'review'), assistant('{"summary":"reviewed","issues":[]}'),
      task('answer', 'inspect'), user('What can you do?'), assistant('capability answer', 'third thoughts')
    ] });
    expect([...window.document.querySelectorAll('#timeline > .turn.assistant .turn-text')].map((node) => node.textContent.trim())).toEqual(['first result', 'implementation result', 'capability answer']);
    const folds = [...window.document.querySelectorAll('.execution-details')];
    expect(folds).toHaveLength(3); expect(folds.every((node) => !node.open)).toBe(true);
    expect(folds[0].textContent).toContain('first thoughts'); expect(folds[1].textContent).toContain('inspection');
    expect(folds[2].textContent).toContain('third thoughts');
  });

  it('sends on Enter and preserves a newline on Shift+Enter', async () => {
    const { window, app } = await client();
    const prompt = window.document.getElementById('prompt');
    const submit = vi.spyOn(window.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
    app.state.running = true;
    prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockClear();
    prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
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

  it('manages scoped memory and Pi automatic compaction from one settings surface', async () => {
    const { window, app, requests } = await client();
    app.state.sessionId = 'memory-session'; app.state.readOnly = false;
    app.applySnapshot({ id: 'memory-session', project: 'C:\\repo', running: false, outcome: 'completed', history: { status: 'active', pinned: false }, messages: [], context: { autoCompaction: true, compactions: 2 } });
    const fetcher = window.fetch;
    const memoryWrites = [];
    window.fetch = async (url, init = {}) => {
      if (url.startsWith('/api/memory')) { if (init.method === 'POST') memoryWrites.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ document: { layer: 'project', items: [] }, global: { layer: 'global', items: [{ id: 'global-1', text: 'Prefer concise answers', kind: 'preference', enabled: true }] }, project: { layer: 'project', items: [] }, session: { layer: 'session', items: [] }, compaction: { count: 2 } }) }; }
      if (url === '/api/settings/compaction') { requests.push({ url, ...init }); return { ok: true, status: 200, json: async () => ({ enabled: JSON.parse(init.body).enabled }) }; }
      return fetcher(url, init);
    };
    await app.openSettings('memory');
    expect(window.document.querySelectorAll('[data-settings-tab]')).toHaveLength(8);
    expect(window.document.querySelectorAll('[data-memory-layer]')).toHaveLength(3);
    expect(window.document.querySelector('[data-memory-layer="global"] textarea').value).toBe('Prefer concise answers');
    const project = window.document.querySelector('[data-memory-layer="project"]');
    project.querySelector('[data-memory-new-text]').value = 'Keep generated files untouched';
    project.querySelector('[data-memory-add]').click();
    project.querySelector('[data-memory-save]').click();
    await vi.waitFor(() => expect(memoryWrites.some((request) => request.layer === 'project')).toBe(true));
    const toggle = window.document.getElementById('memory-auto-compaction'); toggle.click();
    await vi.waitFor(() => expect(requests.some((request) => request.url === '/api/settings/compaction')).toBe(true));
    expect(window.document.querySelector('.memory-summary').textContent).toContain('三层记忆');
  });

  it('offers edit retry for failed sessions by branching the last user request', async () => {
    const { window, app, requests } = await client();
    app.state.sessionId = 'failed-session';
    app.applySnapshot({ id: 'failed-session', title: 'Failed task', project: 'C:\\repo', sessionFile: 'C:\\sessions\\failed.jsonl', running: false, outcome: 'failed', error: 'verification failed', history: { status: 'active', pinned: false }, lastUserEntryId: 'failed-user', forkableEntries: ['failed-user'], entries: [{ id: 'failed-user', type: 'message', message: { role: 'user', content: 'Fix the failing test' } }], messages: [{ role: 'user', content: 'Fix the failing test' }] });
    const button = window.document.getElementById('edit-retry-button');
    expect(button.classList.contains('hidden')).toBe(false);
    const fetcher = window.fetch;
    window.fetch = async (url, init = {}) => url.endsWith('/fork') ? { ok: true, status: 201, json: async () => ({ path: 'C:\\sessions\\retry.jsonl', project: 'C:\\repo', draft: 'Fix the failing test', origin: { kind: 'edit', sourceTitle: 'Failed task' } }) } : fetcher(url, init);
    button.click();
    await vi.waitFor(() => expect(app.state.sessionId).toBe('created'));
    await vi.waitFor(() => expect(window.document.getElementById('followup-prompt').value).toBe('Fix the failing test'));
    expect(requests.some((request) => request.url.endsWith('/prompt'))).toBe(false);
  });

  it('restores an authoritative session mode, preserves a draft, handles rejected switches and stages mode during a run', async () => {
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
    expect(window.document.getElementById('followup-mode-select').disabled).toBe(false);
    await app.changeMode('agent');
    expect(app.state.mode).toBe('agent');
    expect(app.state.pendingMode).toBe('agent');
    expect(app.state.activeMode).toBe('ask');
    app.setRunning(false);
  });

  it('deduplicates replayed deltas and replaces the transcript with a complete snapshot', async () => {
    const { window, app, streams } = await client();
    app.state.sessionId = 'abc'; app.connect('abc');
    const delta = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } };
    streams[0].onEvent({ id: '2', data: JSON.stringify(delta) });
    streams[0].onEvent({ id: '2', data: JSON.stringify(delta) });
    await vi.waitFor(() => expect(window.document.querySelector('.assistant.turn-text').textContent.trim()).toBe('hello'));
    expect(window.document.querySelector('.assistant.turn-text').dataset.raw).toBe('hello');
    const snapshot = { id: 'abc', title: 'Restored', running: false, readOnly: true, outcome: 'completed', model: null, messages: [ { role: 'user', content: 'task' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'Reading the file.' }, { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }] }, { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'file content' }] }, { role: 'assistant', content: [{ type: 'text', text: '**hello**' }] } ], verification: { status: 'failed', report: { results: [{ command: 'test', exitCode: 1, passed: false, output: 'failure details', durationMs: 5 }] } } };
    streams[0].onEvent({ id: '3', data: JSON.stringify({ type: 'pforge_snapshot', snapshot }) });
    expect(window.document.querySelectorAll('#timeline > .turn.assistant')).toHaveLength(1);
    expect(window.document.querySelector('#timeline > .turn.assistant strong').textContent).toBe('Forge');
    expect(window.document.querySelector('#timeline > .turn.assistant .turn-text strong').textContent).toBe('hello');
    expect(window.document.querySelector('.thinking-block').textContent).toContain('reason');
    expect(window.document.querySelector('.tool-output').textContent).toBe('file content');
    expect(window.document.getElementById('run-status-label').textContent).toContain('验证失败');
    expect(window.document.getElementById('verification-output').textContent).toContain('FAIL test');
    expect(window.document.getElementById('followup-send').disabled).toBe(true);
  });
});

function skillsEditor(initial = {}, onChanged = () => {}) {
  const dom = new JSDOM('<div id="skills-root"></div>', { url: 'http://localhost/' }); windows.push(dom.window);
  const root = dom.window.document.getElementById('skills-root'), requests = [];
  const snapshot = { project: 'C:\\repo', projectTrusted: true, revision: 'rev-1', skills: [
    { id: 'review', name: 'review', description: 'Review changes', filePath: 'C:\\skills\\review\\SKILL.md', scope: 'global', source: 'auto', enabled: true, effective: true, valid: true, manualOnly: false },
    { id: 'manual', name: 'manual', description: 'Explicit use only', filePath: 'C:\\repo\\.pi\\skills\\manual\\SKILL.md', scope: 'project', source: 'auto', enabled: true, effective: true, valid: true, manualOnly: true }
  ], paths: { global: 'C:\\skills' }, sources: [], diagnostics: [], ...initial };
  let failure;
  const api = vi.fn(async (url, init = {}) => {
    const input = init.body ? JSON.parse(init.body) : undefined; requests.push({ url, input });
    if (failure) throw new Error(failure);
    if (url.startsWith('/api/skills/content')) return { content: '<script>window.skillExecuted=true</script>\n## Instructions', filePath: 'C:\\skills\\review\\SKILL.md' };
    if (url.endsWith('/toggle')) { const target = snapshot.skills.find((skill) => skill.id === input.id); target.enabled = input.enabled; target.effective = input.enabled; snapshot.revision = 'rev-2'; }
    return init.method ? { snapshot } : snapshot;
  });
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
  const controller = mountSkills(root, { api, esc, projectPath: snapshot.project, onChanged });
  return { root, window: dom.window, controller, requests, api, snapshot, fail(value) { failure = value; } };
}

describe('Skills settings interactions', () => {
  it('searches by scope, distinguishes manual invocation, previews untrusted instructions as text and persists a real toggle', async () => {
    const changed = vi.fn(); const f = skillsEditor({}, changed);
    await vi.waitFor(() => expect(f.root.querySelectorAll('.skill-card')).toHaveLength(2));
    expect(f.root.textContent).toContain('仅手动调用');
    f.root.querySelector('[data-skill-id="review"] [data-skill-action="detail"]').click();
    await vi.waitFor(() => expect(f.root.querySelector('#skill-detail pre').textContent).toContain('<script>'));
    expect(f.root.querySelector('#skill-detail script')).toBeNull(); expect(f.window.skillExecuted).toBeUndefined();
    f.root.querySelector('[data-skill-id="review"] [role="switch"]').click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-skill-id="review"] [role="switch"]').getAttribute('aria-checked')).toBe('false'));
    expect(f.requests.find((request) => request.url.endsWith('/toggle')).input).toEqual({ project: 'C:\\repo', revision: 'rev-1', id: 'review', enabled: false, scope: 'global' });
    expect(changed).toHaveBeenCalledOnce();
    const filter = f.root.querySelector('#skills-scope'); filter.value = 'project'; filter.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    expect(f.root.querySelectorAll('.skill-card')).toHaveLength(1);
    const search = f.root.querySelector('#skills-search'); search.value = 'missing'; search.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    expect(f.root.textContent).toContain('没有匹配的技能');
  });

  it('preserves import drafts on conflicts, recovers controls and can retry a failed initial load', async () => {
    const f = skillsEditor(); await vi.waitFor(() => expect(f.root.querySelectorAll('.skill-card')).toHaveLength(2));
    f.root.querySelector('#skills-import').open = true;
    const form = f.root.querySelector('#skills-source-form'); form.elements.path.value = 'C:\\extra-skills'; f.fail('配置已变更，请刷新');
    form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.root.querySelector('#skills-feedback').textContent).toContain('请刷新'));
    expect(form.elements.path.value).toBe('C:\\extra-skills'); expect(form.elements.path.disabled).toBe(false);
    expect(f.root.querySelector('[data-skill-id="review"] [role="switch"]').getAttribute('aria-checked')).toBe('true');
    expect(f.root.querySelector('[data-skill-action="refresh"]').disabled).toBe(false);
    f.fail(null); form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(form.elements.path.value).toBe(''));
    expect(f.requests.filter((request) => request.url.endsWith('/sources'))).toHaveLength(2);
  });

  it('keeps project imports unavailable before trust and ignores late content after disposal', async () => {
    const f = skillsEditor({ projectTrusted: false }); await vi.waitFor(() => expect(f.root.querySelectorAll('.skill-card')).toHaveLength(2));
    expect(f.root.querySelector('#skills-source-form [value="project"]').disabled).toBe(true);
    expect(f.root.querySelector('[data-skill-id="manual"] [role="switch"]').disabled).toBe(true);
    let release;
    f.api.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ content: 'late' }); }));
    f.root.querySelector('[data-skill-id="review"] [data-skill-action="detail"]').click();
    f.controller.dispose(); release(); await Promise.resolve();
    expect(f.root.querySelector('#skill-detail pre').textContent).toContain('正在读取');
  });
});

function mcpEditor(initial = {}, onChanged = () => {}, options = {}) {
  const dom = new JSDOM('<div id="mcp-root"></div>', { url: 'http://localhost/' }); windows.push(dom.window);
  const root = dom.window.document.getElementById('mcp-root'), requests = [];
  const snapshot = { project: 'C:\\repo', projectTrusted: true, servers: [], errors: [], ...initial };
  let rejected = false;
  const api = vi.fn(async (url, init = {}) => {
    const input = init.body ? JSON.parse(init.body) : undefined; requests.push({ url, input, method: init.method });
    if (rejected && init.method === 'POST') throw new Error('配置已被其他窗口修改，请刷新');
    if (url.endsWith('/test')) return { status: 'connected', tools: [{ name: 'mcp__docs__read' }] };
    return snapshot;
  });
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
  const controller = mountMcp(root, { api, esc, initial: snapshot, projectPath: snapshot.project, onChanged, ...options });
  return { root, window: dom.window, requests, api, controller, snapshot, field: (name) => root.querySelector('[name="' + name + '"]'), click: (action) => root.querySelector('[data-action="' + action + '"]').click(), reject() { rejected = true; } };
}

describe('MCP settings interactions', () => {
  it('edits original tool names and preserves pattern rules while allowing an override to be cleared', async () => {
    const f = mcpEditor({ servers: [{ name: 'docs', scope: 'global', revision: 'rev', effective: true, config: { type: 'stdio', command: 'node', toolExposure: { '*write*': 'hidden', 'read/file': 'direct' } }, probe: { tools: [{ name: 'mcp__docs__read_file', rawName: 'read/file', description: 'Read a file.' }] } }] });
    f.click('tools');
    const select = f.root.querySelector('[data-tool-name="read/file"]').closest('.mcp-tool-rule').querySelector('select');
    expect(select.value).toBe('direct'); select.value = '';
    f.root.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.requests.some((request) => request.url.endsWith('/tools'))).toBe(true));
    expect(f.requests[0].input).toMatchObject({ revision: 'rev', changes: { 'read/file': null, '*write*': 'hidden' } });
    expect(f.requests[0].input.changes).not.toHaveProperty('read_file');
  });
  it('shows a safe OAuth link when popups are blocked and supports cancellation without storing authorization data', async () => {
    const f = mcpEditor({ servers: [{ name: 'docs', scope: 'global', revision: 'rev', effective: true, config: { type: 'http', url: 'https://example.com/mcp' } }] });
    vi.spyOn(f.window, 'open').mockReturnValue(null);
    let cancelled = false;
    const job = { id: 'a'.repeat(32), name: 'docs', action: 'login', state: 'waiting', authorizationUrl: 'https://auth.example.com/authorize?state=local-flow-state' };
    f.api.mockImplementation(async (url, init = {}) => {
      if (url.endsWith('/login')) return { ...job, state: 'starting', authorizationUrl: undefined };
      if (url.endsWith('/cancel')) { cancelled = true; return {}; }
      if (url.includes('/mcp/auth/')) return { ...job, state: cancelled ? 'cancelled' : 'waiting', message: cancelled ? '已取消授权' : undefined };
      return f.snapshot;
    });
    f.click('login');
    await vi.waitFor(() => expect(f.root.querySelector('.mcp-auth-panel a')?.href).toContain('https://auth.example.com/authorize'));
    expect(f.root.querySelector('.mcp-auth-panel a').rel).toContain('noopener');
    expect(Object.values(f.window.localStorage).join('') + Object.values(f.window.sessionStorage).join('')).not.toContain('local-flow-state');
    f.click('cancel-auth'); await vi.waitFor(() => expect(f.root.textContent).toContain('已取消授权'));
    f.controller.dispose();
  });
  it('polls actual session state without rebuilding an open tool or configuration editor, and stops on disposal', async () => {
    const f = mcpEditor({}, () => {}, { runtimeEnabled: true });
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(0));
    f.api.mockResolvedValue({ sessions: [{ id: 'a1', title: 'Live conversation', mode: 'plan', supported: true, servers: [{ name: 'docs', state: 'disconnected', toolCount: 0 }] }] });
    await f.controller.refreshRuntime();
    expect(f.root.textContent).toContain('已断开');
    f.click('add'); f.field('name').value = 'unsaved-draft';
    await f.controller.refreshRuntime(); expect(f.field('name').value).toBe('unsaved-draft');
    f.controller.dispose(); const calls = f.api.mock.calls.length;
    await f.controller.refreshRuntime(); expect(f.api.mock.calls.length).toBe(calls);
  });
  it('keeps an unsaved service draft when OAuth finishes in the background', async () => {
    const f = mcpEditor({ servers: [{ name: 'docs', scope: 'global', revision: 'rev', effective: true, config: { type: 'http', url: 'https://example.com/mcp' } }] });
    vi.spyOn(f.window, 'open').mockReturnValue(null);
    let reads = 0;
    const job = { id: 'b'.repeat(32), name: 'docs', action: 'login' };
    f.api.mockImplementation(async (url) => {
      if (url.endsWith('/login')) return { ...job, state: 'starting' };
      if (url.includes('/mcp/auth/')) return ++reads === 1 ? { ...job, state: 'waiting', authorizationUrl: 'https://auth.example.com/authorize' } : { ...job, state: 'succeeded', message: '授权成功' };
      return f.snapshot;
    });
    f.click('login'); await vi.waitFor(() => expect(f.root.querySelector('.mcp-auth-panel a')).not.toBeNull());
    f.click('add'); f.field('name').value = 'unsaved-service';
    await vi.waitFor(() => expect(f.root.querySelector('#mcp-feedback').textContent).toContain('授权已更新'), { timeout: 3000 });
    expect(f.field('name').value).toBe('unsaved-service'); f.controller.dispose();
  });
  it('keeps the saved form locked until parent state refresh finishes, so the new list is immediately interactive', async () => {
    let release, entered = false;
    const waiting = new Promise((done) => { release = done; });
    const f = mcpEditor({}, async () => { entered = true; await waiting; });
    f.click('add'); f.field('name').value = 'local'; f.field('command').value = 'node';
    f.root.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(f.root.querySelector('[data-action="save"]').disabled).toBe(true);
    expect(f.root.querySelector('[data-action="add"]')).toBeNull();
    release(); await vi.waitFor(() => expect(f.root.querySelector('#mcp-form')).toBeNull());
    f.click('add'); expect(f.root.querySelector('#mcp-form')).not.toBeNull();
  });
  it('switches HTTP/stdio validation and submits only the visible transport with blank secrets preserved', async () => {
    const f = mcpEditor(); f.click('add');
    f.field('name').value = 'docs'; f.field('transport').value = 'http'; f.field('transport').dispatchEvent(new f.window.Event('change', { bubbles: true }));
    f.field('url').value = 'https://example.com/mcp';
    expect(f.field('command').closest('fieldset').disabled).toBe(true);
    expect(f.root.querySelector('form').checkValidity()).toBe(true);
    f.click('add-row');
    // The first map is stdio and is inactive; HTTP data is independent.
    f.root.querySelector('[data-map-name="headers"]').click();
    const row = f.root.querySelector('[data-map="headers"] .mcp-map-row');
    row.querySelector('[data-key]').value = 'Authorization'; row.querySelector('[data-value]').value = 'Bearer private-ui-secret';
    f.click('test-draft');
    await vi.waitFor(() => expect(f.root.textContent).toContain('连接成功'));
    expect(f.requests[0].input.config).toMatchObject({ type: 'http', url: 'https://example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer private-ui-secret' }] });
    expect(f.requests[0].input.config).not.toHaveProperty('command');
    f.root.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.root.querySelector('#mcp-form')).toBeNull());
    expect(f.requests.find((request) => request.url === '/api/mcp/servers').input.config).toEqual(f.requests[0].input.config);
    expect(Object.values(f.window.localStorage).join('') + Object.values(f.window.sessionStorage).join('')).not.toContain('private-ui-secret');
  });
  it('edits redacted values, clears optional fields, and keeps the form on a rejected update', async () => {
    const f = mcpEditor({ servers: [{ name: 'docs', scope: 'global', revision: 'revision-1', effective: true, config: { type: 'http', url: 'https://example.com/mcp', timeout: 90, auth: { provider: 'github' }, headers: [{ key: 'Authorization', configured: true }], oauth: { clientId: 'old-client', clientSecretConfigured: true } } }] });
    f.click('edit');
    expect(f.root.querySelector('[data-value]').value).toBe('');
    expect(f.field('clientSecret').value).toBe('');
    f.field('clientId').value = ''; f.field('authProvider').value = ''; f.field('timeout').value = '';
    f.reject(); f.root.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.root.textContent).toContain('其他窗口修改'));
    expect(f.requests[0].input).toMatchObject({ revision: 'revision-1', config: { auth: null, timeout: null, oauth: {}, headers: [{ key: 'Authorization', value: '' }] } });
    expect(f.field('url').value).toBe('https://example.com/mcp');
    expect(f.root.querySelector('[data-action="save"]').disabled).toBe(false);
  });
  it('imports one selected service with tool exposure and uses the same configuration for test and save', async () => {
    const f = mcpEditor(); f.click('add');
    f.root.querySelector('#mcp-import-json').value = JSON.stringify({ mcpServers: { first: { command: 'node' }, docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer import-secret' }, toolExposure: { '*write*': 'hidden' } } } });
    f.click('read-import'); f.root.querySelector('#mcp-import-server').value = 'docs'; f.click('apply-import');
    expect(f.field('name').value).toBe('docs');
    f.click('test-draft'); await vi.waitFor(() => expect(f.root.textContent).toContain('连接成功'));
    f.root.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.root.querySelector('#mcp-form')).toBeNull());
    const inputs = f.requests.filter((request) => request.method === 'POST').map((request) => request.input.config);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0].toolExposure).toEqual({ '*write*': 'hidden' });
    expect(inputs[0].headers).toEqual([{ key: 'Authorization', value: 'Bearer import-secret' }]);
    expect(f.root.innerHTML).not.toContain('import-secret');
  });
  it('requires delete confirmation and blocks testing an untrusted project configuration', async () => {
    const f = mcpEditor({ projectTrusted: false, servers: [{ name: 'local', scope: 'project', revision: 'rev', effective: false, config: { type: 'stdio', command: 'node' } }] });
    expect(f.root.querySelector('[data-action="test"]').disabled).toBe(true);
    f.click('edit'); expect(f.root.querySelector('[data-action="test-draft"]').disabled).toBe(true);
    f.click('cancel'); f.click('delete'); expect(f.requests).toHaveLength(0);
    f.click('confirm-delete');
    await vi.waitFor(() => expect(f.requests.some((request) => request.method === 'DELETE' && request.url.includes('revision=rev'))).toBe(true));
  });
});


describe('background conversation navigation', () => {
  it('switches away from a running chat, retains its staged choices and draft, and ignores its late SSE', async () => {
    const reasoning = model('b', { reasoning: true, thinkingLevels: ['low', 'high'] });
    const { window, app, requests, streams } = await client({ models: [model('a'), reasoning] });
    const doc = window.document, paths = { a: 'C:\\sessions\\a.jsonl', b: 'C:\\sessions\\b.jsonl' };
    const snapshot = (id) => ({ id, sessionFile: paths[id], project: 'C:\\repo', model: model('a'), thinkingLevel: 'off', mode: id === 'a' ? 'agent' : 'plan', workflow: 'direct', running: id === 'a', outcome: id === 'a' ? 'running' : 'completed', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Answer ' + id }] }] });
    const fetcher = window.fetch;
    window.fetch = async (url, init) => {
      const result = await fetcher(url, init);
      if (url === '/api/session') return { ok: true, json: async () => snapshot(JSON.parse(init.body).sessionFile === paths.a ? 'a' : 'b') };
      return result;
    };
    app.state.sessionId = 'a'; app.applySnapshot(snapshot('a')); app.connect('a');
    const oldStream = streams.at(-1);
    await app.changeModel('mock/b'); await app.changeThinking('high'); await app.changeModeSelection('ask');
    doc.getElementById('followup-prompt').value = 'A unsent draft';
    app.state.attachments = [{ type: 'file', path: 'a.txt' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'draft.png' }];
    expect(doc.getElementById('project-list').inert).toBe(false);
    app.state.uiRequest = { requestId: 'A-pending-approval' };
    app.state.uiQueue = [{ requestId: 'A-queued-approval', method: 'confirm', title: 'OLD APPROVAL' }];
    await app.openSession(paths.b, 'C:\\repo');
    expect(app.state.sessionId).toBe('b'); expect(app.state.running).toBe(false);
    expect(app.state.uiQueue).toEqual([]); expect(app.state.uiRequest).toBeNull();
    expect(doc.getElementById('approval-modal').classList.contains('hidden')).toBe(true);
    expect(app.state.mode).toBe('plan'); expect(app.state.model.key).toBe('mock/a');
    expect(app.state.attachments).toEqual([]); expect(doc.getElementById('followup-prompt').value).toBe('');
    expect(doc.getElementById('followup-mode-picker-button').disabled).toBe(false);
    await app.changeMode('agent');
    expect(requests.some((item) => item.url === '/api/sessions/b/mode')).toBe(true);
    doc.getElementById('followup-prompt').value = 'B unsent draft';
    oldStream.onEvent({ id: '100', data: JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'WRONG CHAT OUTPUT' } }) });
    expect(doc.getElementById('timeline').textContent).not.toContain('WRONG CHAT OUTPUT');
    expect(doc.getElementById('followup-prompt').value).toBe('B unsent draft');
    await app.openSession(paths.a, 'C:\\repo');
    expect(app.state.running).toBe(true); expect(app.state.activeMode).toBe('agent'); expect(app.state.mode).toBe('ask');
    expect(app.state.pendingMode).toBe('ask'); expect(app.state.model.key).toBe('mock/b'); expect(app.state.thinkingLevel).toBe('high');
    expect(app.state.attachments).toHaveLength(2); expect(doc.getElementById('followup-prompt').value).toBe('A unsent draft');
    expect(requests.some((item) => item.url === '/api/sessions/a/mode' || item.url.endsWith('/abort'))).toBe(false);
  });
  it('stages mode and execution strategy through snapshots, applying them only before the next prompt', async () => {
    const { window, app, requests } = await client(); app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', mode: 'ask', workflow: 'direct', runMode: 'ask', running: true, messages: [] });
    await app.changeModeSelection('agent:planned');
    expect(app.state.activeMode).toBe('ask'); expect(app.state.mode).toBe('agent');
    expect(requests.filter((item) => item.method === 'POST')).toHaveLength(0);
    app.applySnapshot({ id: 'live', mode: 'ask', workflow: 'direct', runMode: 'ask', running: false, messages: [] });
    expect(app.state.mode).toBe('agent'); expect(app.state.workflow).toBe('planned');
    expect(window.document.getElementById('followup-mode-picker-button').title).toContain('下一条消息');
    expect(await app.sendFollowup('Implement the approved change')).toBe(true);
    const posts = requests.filter((item) => item.method === 'POST');
    expect(posts.map((item) => item.url)).toEqual(['/api/sessions/live/mode', '/api/sessions/live/workflow', '/api/sessions/live/prompt']);
    expect(JSON.parse(posts.at(-1).body).workflow).toBe('planned');
    expect(app.state.pendingMode).toBeNull(); expect(app.state.pendingWorkflow).toBeNull();
  });
  it('retains a staged mode and draft when the host rejects its application', async () => {
    const { window, app, requests } = await client(); app.state.sessionId = 'live';
    app.applySnapshot({ id: 'live', mode: 'ask', workflow: 'direct', running: true, messages: [] });
    await app.changeModeSelection('agent:planned'); app.setRunning(false);
    const fetcher = window.fetch;
    window.fetch = (url, init) => url.endsWith('/mode') ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'still busy' }) }) : fetcher(url, init);
    window.document.getElementById('followup-prompt').value = 'Keep my request';
    expect(await app.sendFollowup('Keep my request')).toBe(false);
    expect(app.state.pendingMode).toBe('agent'); expect(app.state.workflow).toBe('planned');
    expect(window.document.getElementById('followup-prompt').value).toBe('Keep my request');
    expect(requests.some((item) => item.url.endsWith('/prompt'))).toBe(false);
  });
  it('opens a fresh conversation while the previous one continues, without leaking its pending configuration', async () => {
    const { window, app, requests } = await client(); app.state.sessionId = 'a';
    app.applySnapshot({ id: 'a', sessionFile: 'a.jsonl', mode: 'agent', running: true, messages: [] });
    await app.changeModel('mock/b'); await app.changeMode('ask');
    expect(window.document.getElementById('new-chat-button').disabled).toBe(false);
    await app.newConversation();
    expect(app.state.sessionId).toBeNull(); expect(app.state.pendingModelKey).toBeNull(); expect(app.state.pendingMode).toBeNull();
    expect(app.state.sessionChoices.get('a.jsonl')).toMatchObject({ pendingModelKey: 'mock/b', pendingMode: 'ask' });
    expect(requests.some((item) => item.url.endsWith('/abort'))).toBe(false);
  });
});


describe('background compaction navigation', () => {
  it('can leave a compacting conversation and ignores its late compaction response', async () => {
    const { window, app } = await client(); app.state.sessionId = 'compact-a';
    app.applySnapshot({ id: 'compact-a', running: false, mode: 'agent', context: { compacting: false }, messages: [] });
    const fetcher = window.fetch; let release;
    window.fetch = (url, init) => url.endsWith('/compact') ? new Promise((resolve) => { release = resolve; }) : fetcher(url, init);
    const pending = app.compactContext();
    expect(app.state.compactRequest).toBe(true);
    expect(window.document.getElementById('new-chat-button').disabled).toBe(false);
    await app.newConversation();
    window.document.getElementById('prompt').value = 'New draft';
    release({ ok: true, json: async () => ({ context: { compacting: false, compactions: 99 } }) });
    expect(await pending).toBe(false);
    expect(app.state.sessionId).toBeNull(); expect(app.state.context).toBeNull(); expect(app.state.compactRequest).toBe(false);
    expect(window.document.getElementById('prompt').value).toBe('New draft');
    expect(window.document.getElementById('run-button').disabled).toBe(false);
  });
});


describe('late stop acknowledgements', () => {
  it('does not clear a newer stop operation after navigating away and back to the same conversation', async () => {
    const { window, app } = await client(); app.state.sessionId = 'a';
    app.applySnapshot({ id: 'a', running: true, mode: 'agent', messages: [] });
    const fetcher = window.fetch, acknowledgements = [];
    window.fetch = (url, init) => url.endsWith('/abort') ? new Promise((resolve) => acknowledgements.push(() => resolve({ ok: true, json: async () => ({ ok: true }) }))) : fetcher(url, init);
    const first = app.stopExecution();
    await app.newConversation();
    app.state.sessionId = 'a'; app.applySnapshot({ id: 'a', running: true, mode: 'agent', messages: [] });
    const second = app.stopExecution();
    acknowledgements[0](); await first;
    expect(window.document.getElementById('stop-button').getAttribute('aria-busy')).toBe('true');
    expect(app.state.runControl).toBe('stopping');
    acknowledgements[1](); await second;
    expect(app.state.runControl).toBeNull();
  });
});
