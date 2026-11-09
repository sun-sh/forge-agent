import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { ForgeSubagents } from '../src/web/subagents.js';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS } from '../src/task/budget.js';
import { startWebConsole } from '../src/web/server.js';
import { checkpointGit } from '../src/task/checkpoints.js';
import { ReviewFormatError } from '../src/task/review.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
const text = (input: any) => JSON.stringify(input.messages);
function answer(res: ServerResponse, input: any, content: string, call?: { name: string; args: unknown }) {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + Math.random().toString(16).slice(2), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content };
  const send = (data: any) => res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, ...data }] }) + '\n\n');
  send({ delta, finish_reason: null });
  send({ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' });
  res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: input.model, choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
async function fixture(handler: (input: any, res: ServerResponse) => void | Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'forge-subagent-home-')), project = await mkdtemp(join(tmpdir(), 'forge-subagent-project-'));
  for (const [key, value] of Object.entries({ FORGE_AGENT_HOME: home, PFORGE_HOME: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions') })) vi.stubEnv(key, value);
  const requests: any[] = [];
  const modelServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    // An abort can close a request before the body arrives. It is expected
    // during child cancellation and must not become an unhandled test error.
    if (!raw.trim()) { res.destroy(); return; }
    const input = JSON.parse(raw); requests.push(input);
    try { await handler(input, res); } catch (error) { if (!res.destroyed) res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>((done) => modelServer.listen(0, '127.0.0.1', done));
  closers.push(async () => { modelServer.closeAllConnections(); await new Promise<void>((done) => modelServer.close(() => done())); });
  const address = modelServer.address() as { port: number };
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mock: { api: 'openai-completions', apiKey: 'test', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: 'test', contextWindow: 16000, maxTokens: 1024 }] } } }));
  await writeFile(join(project, 'sample.txt'), 'file-evidence\n');
  const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json') });
  const manager = SessionManager.create(project, join(home, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'PARENT-SECRET-NOT-FOR-CHILD', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'parent context' }], api: 'openai-completions', provider: 'mock', model: 'test', stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const budget = new BudgetRuntime({ ...DEFAULT_BUDGET_LIMITS }); budget.start();
  let allowed = true;
  const options = { home, project, manager, modelRuntime: runtime, parentModel: () => runtime.getModel('mock', 'test'), thinkingLevel: () => 'off' as const, budget: () => budget, allowed: () => allowed, reviewAllowed: () => allowed, onChange: () => {} };
  const agents = new ForgeSubagents(options); budget.setAbort(() => { void agents.cancelAll(); });
  closers.push(async () => { await agents.close(); budget.finish('aborted'); });
  return { home, project, runtime, manager, agents, budget, requests, options, setAllowed: (value: boolean) => { allowed = value; } };
}
const task = (title = '检查实现', prompt = 'Read sample.txt and report evidence.') => ({ title, prompt, role: 'explorer' as const });

describe('managed Pi subagents', () => {
  it('runs the host review gate in a fresh read-only child context', async () => {
    const f = await fixture((input, res) => answer(res, input, '{"verdict":"ready","summary":"Independent","issues":[],"acceptance":[]}'));
    const review = await f.agents.reviewGate('Original goal: inspect sample.txt. Evidence: current changes.', new AbortController().signal);
    expect(review.model).toBe('mock/test');
    expect(review.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.requests).toHaveLength(1);
    expect(text(f.requests[0])).not.toContain('PARENT-SECRET-NOT-FOR-CHILD');
    expect(text(f.requests[0])).toContain('Return exactly the structured review JSON');
    expect(text(f.requests[0])).not.toContain('result with explicit sections');
    expect(f.requests[0].tools.map((tool: any) => tool.function.name).sort()).toEqual(['find', 'grep', 'ls', 'read']);
    expect(f.agents.snapshot()[0]).toMatchObject({ purpose: 'review_gate', role: 'reviewer', status: 'completed', collectedAt: expect.any(String) });
    await expect(f.agents.delegate([{ title: 'continue gate', role: 'reviewer', prompt: 'continue', id: review.sessionId }], 'follow-up')).rejects.toThrow('交付审阅不能续问');
  });
  it('carries a structured scope and acceptance handoff into an independent child', async () => {
    const f = await fixture((input, res) => answer(res, input, 'Completed: inspected sample.txt. Unverified: parent must run tests. Next: compare the result with acceptance.'));
    const scope = { files: ['src/login.ts', 'test/login.test.ts'], deliverables: ['a focused implementation note'], acceptance: ['preserve the public API'], dependencies: ['the configured test command'] };
    const [child] = await f.agents.delegate([{ ...task('Structured handoff'), scope }], 'structured-handoff');
    expect(child).toMatchObject({ status: 'completed', scope });
    expect(text(f.requests[0])).toContain('preserve the public API');
    expect(text(f.requests[0])).toContain('HOST STRUCTURED HANDOFF');
    expect(text(f.requests[0])).toContain('what the parent must do next');
    expect((await f.agents.detail(child!.id)).agent).toMatchObject({ scope });
  });
  it('retries malformed review JSON once in the same child session, charging both turns to the parent', async () => {
    let calls = 0;
    const f = await fixture((input, res) => answer(res, input, ++calls === 1 ? 'My review is ready but not JSON.' : '{"verdict":"ready","summary":"Corrected JSON","issues":[],"acceptance":[]}'));
    const review = await f.agents.reviewGate('Review the supplied goal and evidence.', new AbortController().signal);
    expect(review).toMatchObject({ formatRetries: 1, text: expect.stringContaining('Corrected JSON') });
    expect(f.requests).toHaveLength(2); expect(text(f.requests[1])).toContain('My review is ready but not JSON.');
    expect(text(f.requests[1])).toContain('only format retry'); expect(text(f.requests[1])).not.toContain('PARENT-SECRET-NOT-FOR-CHILD');
    expect(f.agents.snapshot()).toHaveLength(1); expect(f.agents.snapshot()[0]).toMatchObject({ id: review.sessionId, activation: 1, formatRetries: 1, status: 'completed' });
    expect(f.budget.snapshot().modelTurns).toBe(2);
  });
  it('does not retry malformed JSON more than once or exceed the parent turn budget', async () => {
    const f = await fixture((input, res) => answer(res, input, 'not JSON'));
    await expect(f.agents.reviewGate('Review evidence.', new AbortController().signal)).rejects.toBeInstanceOf(ReviewFormatError);
    expect(f.requests).toHaveLength(2); expect(f.agents.snapshot()[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_review', formatRetries: 1, collectedAt: expect.any(String) });
    f.agents.beginPrompt(); const before = f.requests.length; f.budget.limits.maxModelTurns = 3;
    await expect(f.agents.reviewGate('Review other evidence.', new AbortController().signal)).rejects.toThrow();
    expect(f.requests.length - before).toBe(1); expect(f.budget.snapshot().status).toBe('exceeded');
  });
  it('never certifies an unread result when collection persistence fails', async () => {
    const f = await fixture((input, res) => answer(res, input, 'Result ready.'));
    const [child] = await f.agents.start([task()], 'async-result');
    await vi.waitFor(() => expect(f.agents.status([child!.id])[0]?.status).toBe('completed'), { timeout: 10000 });
    expect(() => f.agents.assertCollected()).toThrow('尚未汇总');
    const spy = vi.spyOn(f.manager, 'appendCustomEntry').mockImplementationOnce(() => { throw new Error('Result could not be persisted'); });
    try { expect(() => f.agents.results([child!.id])).toThrow('could not be persisted'); expect(() => f.agents.assertCollected()).toThrow('尚未汇总'); }
    finally { spy.mockRestore(); }
    f.agents.results([child!.id]); expect(() => f.agents.assertCollected()).not.toThrow();
  });
  const pathAliases = ['~/forge-worker-boundary.txt', '@sample.txt', 'file:///forge-worker-boundary.txt', 'new\u00a0file.txt'];
  if (process.platform === 'win32') pathAliases.push('/c/forge-worker-boundary.txt', '/mnt/c/forge-worker-boundary.txt', '.git./config');
  it.each(pathAliases)('blocks the Pi-expanded path alias %s before a writable tool can run', async (path) => {
    const f = await fixture((input, res) => {
      if (input.messages.at(-1).role === 'tool') return answer(res, input, 'Write blocked.');
      answer(res, input, '', { name: 'write', args: { path, content: 'must never write' } });
    });
    await checkpointGit(f.project, ['init']); await checkpointGit(f.project, ['add', '.']);
    await checkpointGit(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
    const [child] = await f.agents.delegate([{ title: 'Path boundary', role: 'worker', prompt: 'Attempt a special path write.' }], 'worker-path');
    const detail = await f.agents.detail(child!.id);
    expect(JSON.stringify(detail.messages), path).toContain('只能修改独立 worktree');
    expect((detail.proposal as any).files, path).toEqual([]);
    await f.agents.discardWorkspace(child!.id);
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('file-evidence\n');
  });
  it('executes a writable worker in a worktree, exposes a reviewable proposal and refuses writes outside it', async () => {
    const f = await fixture((input, res) => {
      if (input.messages.at(-1).role === 'tool') return answer(res, input, 'Proposed an isolated change; parent verification is still required.');
      answer(res, input, '', { name: 'write', args: { path: 'sample.txt', content: 'worker proposal\n' } });
    });
    await checkpointGit(f.project, ['init']); await checkpointGit(f.project, ['add', '.']);
    await checkpointGit(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
    const [child] = await f.agents.delegate([{ title: 'Isolated edit', role: 'worker', prompt: 'Edit sample.txt.' }], 'worker-call');
    expect(child).toMatchObject({ status: 'completed', role: 'worker', proposal: expect.any(String) });
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('file-evidence\n');
    const detail = await f.agents.detail(child!.id);
    expect(detail.proposal).toMatchObject({ kind: 'proposal', files: [{ path: 'sample.txt', eligible: true }] });
    await f.agents.applyProposal(child!.id, ['sample.txt'], (detail.proposal as any).revision);
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('worker proposal\n');
    await f.agents.discardWorkspace(child!.id);
    expect((await f.agents.detail(child!.id)).agent?.worktreeRemoved).toBe(true);
    expect(f.requests[0].tools.map((tool: any) => tool.function.name).sort()).toEqual(['edit', 'find', 'grep', 'ls', 'read', 'write']);
  });
  it('blocks an isolated worker from writing an absolute path in the parent project', async () => {
    let parent = '';
    const f = await fixture((input, res) => {
      if (input.messages.at(-1).role === 'tool') return answer(res, input, 'Write blocked.');
      answer(res, input, '', { name: 'write', args: { path: join(parent, 'sample.txt'), content: 'must never write' } });
    }); parent = f.project;
    await checkpointGit(f.project, ['init']); await checkpointGit(f.project, ['add', '.']); await checkpointGit(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
    const [child] = await f.agents.delegate([{ title: 'Boundary', role: 'worker', prompt: 'Attempt a parent write.' }], 'worker-call');
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('file-evidence\n');
    expect(JSON.stringify((await f.agents.detail(child!.id)).messages)).toContain('只能修改独立 worktree');
    await f.agents.discardWorkspace(child!.id);
  });
  it('runs independent Pi contexts in parallel, gathers evidence, persists and continues owned children', async () => {
    let inFlight = 0, maximum = 0;
    const f = await fixture(async (input, res) => {
      const last = input.messages.at(-1);
      if (last.role === 'tool') return answer(res, input, 'Evidence: sample.txt:1 contains file-evidence.');
      inFlight++; maximum = Math.max(maximum, inFlight);
      await new Promise((done) => setTimeout(done, 70)); inFlight--;
      answer(res, input, '', { name: 'read', args: { path: 'sample.txt' } });
    });
    const results = await f.agents.delegate([task('探索'), { ...task('审阅'), role: 'reviewer' }], 'parent-call');
    expect(maximum).toBe(2); expect(results.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(results[0]?.result).toContain('file-evidence');
    for (const request of f.requests) {
      expect(text(request)).not.toContain('PARENT-SECRET-NOT-FOR-CHILD');
      expect(text(request)).toContain('independent context');
      expect(request.tools.map((tool: any) => tool.function.name).sort()).toEqual(['find', 'grep', 'ls', 'read']);
    }
    expect(f.budget.snapshot().modelTurns).toBe(4);
    expect(f.budget.snapshot().totalTokens).toBeGreaterThan(0);
    const history = await SessionManager.listAll(join(f.home, 'sessions'));
    expect(history).toHaveLength(1);
    const detail = await f.agents.detail(results[0]!.id);
    expect(JSON.stringify(detail.messages)).toContain('file-evidence');
    const continued = await f.agents.delegate([{ ...task('续问', 'Follow up: check that evidence again.'), id: results[0]!.id }], 'follow-up');
    expect(continued[0]).toMatchObject({ id: results[0]!.id, activation: 2, status: 'completed' });
    expect(text(f.requests.at(-1))).toContain('Read sample.txt and report evidence.');
    const restored = new ForgeSubagents({ ...f.options, manager: SessionManager.open(f.manager.getSessionFile()!) });
    expect(restored.snapshot()).toHaveLength(2);
    expect(restored.snapshot()[0]).toMatchObject({ status: 'completed', activation: 2 });
    await restored.close();
  });

  it('rejects denied admission, foreign child ids, oversized batches and per-prompt exhaustion before model calls', async () => {
    const f = await fixture((input, res) => answer(res, input, 'done'));
    f.setAllowed(false); await expect(f.agents.delegate([task()], 'call')).rejects.toThrow('不允许');
    f.setAllowed(true);
    await expect(f.agents.delegate([task(), task(), task(), task()], 'call')).rejects.toThrow();
    await expect(f.agents.delegate([{ ...task(), id: '11111111-1111-4111-8111-111111111111' }], 'call')).rejects.toThrow('拥有');
    expect(f.requests).toHaveLength(0);
    for (let i = 0; i < 4; i++) await f.agents.delegate([task(), task(), task()], 'call');
    await expect(f.agents.delegate([task()], 'exhausted')).rejects.toThrow('最多委派');
    f.agents.beginPrompt(); await expect(f.agents.delegate([task()], 'new-prompt')).resolves.toHaveLength(1);
  });

  it('returns asynchronous handles before completion, bounds waits, validates ownership and durably collects results', async () => {
    let release: (() => void) | undefined;
    const f = await fixture((input, res) => { release = () => answer(res, input, 'Background evidence.'); });
    const [started] = await f.agents.start([task()], 'async-start');
    expect(['starting', 'running']).toContain(started!.status);
    expect(() => f.agents.beginPrompt()).toThrow('尚未收尾');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const timed = await f.agents.wait([started!.id], 0);
    expect(timed[0]!.status).toBe('running'); expect(timed[0]!.collectedAt).toBeUndefined();
    await expect(f.agents.wait(['11111111-1111-4111-8111-111111111111'], 0)).rejects.toThrow('不属于');
    await expect(f.agents.wait([started!.id], 30001)).rejects.toThrow('等待时限');
    release!();
    const [done] = await f.agents.wait([started!.id]);
    expect(done).toMatchObject({ status: 'completed', result: 'Background evidence.', collectedAt: expect.any(String) });
    const restored = new ForgeSubagents({ ...f.options, manager: SessionManager.open(f.manager.getSessionFile()!) });
    expect(restored.snapshot()[0]!.collectedAt).toBe(done!.collectedAt); await restored.close();
  });

  it('keeps parent cancellation attached after asynchronous start returns', async () => {
    const f = await fixture((_input, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held\n\n'); });
    const controller = new AbortController(), [child] = await f.agents.start([task()], 'async-cancel', controller.signal);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); controller.abort();
    const [cancelled] = await f.agents.wait([child!.id]);
    expect(cancelled).toMatchObject({ status: 'cancelled', collectedAt: expect.any(String) });
    expect(f.budget.snapshot().status).toBe('running');
  });

  it('blocks attempted writes and never executes project extensions in restricted workers', async () => {
    const f = await fixture((input, res) => answer(res, input, '', { name: 'write', args: { path: 'sample.txt', content: 'corrupt' } }));
    // A restricted child must reach the model without resolving or installing this package.
    vi.stubEnv('npm_config_offline', 'true');
    await writeFile(join(f.home, 'settings.json'), JSON.stringify({ packages: ['npm:@forge-agent-test/missing-readonly@0.0.0'] }));
    await mkdir(join(f.project, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(f.project, '.pi', 'extensions', 'unsafe.js'), "import { writeFileSync } from 'node:fs'; export default () => writeFileSync('extension-marker', 'executed');");
    const results = await f.agents.delegate([task()], 'call');
    expect(results[0]?.status).not.toBe('completed');
    expect(f.requests.length).toBeGreaterThan(0);
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('file-evidence\n');
    await expect(access(join(f.project, 'extension-marker'))).rejects.toThrow();
  });

  it('reserves capacity through startup and cancels every child without reporting success', async () => {
    const f = await fixture(async (input, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': held\n\n');
    });
    const pending = f.agents.delegate([task(), task(), task()], 'call');
    await expect(f.agents.delegate([task()], 'overflow')).rejects.toThrow('最多同时');
    await vi.waitFor(() => expect(f.requests).toHaveLength(3));
    await f.agents.cancelAll();
    const results = await pending;
    expect(results.every((row) => row.status === 'cancelled')).toBe(true);
    expect(results.every((row) => row.endedAt)).toBe(true);
    await expect(f.agents.delegate([{ ...task(), id: results[0]!.id }], 'retry', AbortSignal.abort())).rejects.toThrow();
  });

  it('keeps a completed child completed when idle Pi abort rejects during cleanup', async () => {
    const f = await fixture((input, res) => answer(res, input, 'Evidence collected.'));
    try {
      vi.spyOn(AgentSession.prototype, 'abort').mockRejectedValue(new Error('no active turn'));
      const [result] = await f.agents.delegate([task()], 'call');
      expect(result).toMatchObject({ status: 'completed', result: 'Evidence collected.' });
    } finally { vi.restoreAllMocks(); }
  });

  it('marks active persisted children interrupted after restart, and does not inherit ownership on a normal fork', async () => {
    const f = await fixture((input, res) => answer(res, input, 'done'));
    const [result] = await f.agents.delegate([task()], 'call');
    const entry = [...f.manager.getBranch()].reverse().find((e) => e.type === 'custom' && e.customType === 'forge.subagent');
    if (!entry || entry.type !== 'custom') throw new Error('missing durable subagent entry');
    f.manager.appendCustomEntry('forge.subagent', { ...(entry.data as object), status: 'running', endedAt: undefined });
    const restored = new ForgeSubagents(f.options);
    expect(restored.snapshot()[0]).toMatchObject({ id: result!.id, status: 'interrupted' });
    const before = f.requests.length; await new Promise((done) => setTimeout(done, 20)); expect(f.requests).toHaveLength(before);
    const forkPath = f.manager.createBranchedSession(f.manager.getLeafId()!);
    const fork = new ForgeSubagents({ ...f.options, manager: SessionManager.open(forkPath!) });
    expect(fork.snapshot()).toEqual([]);
    await expect(fork.detail(result!.id)).rejects.toThrow('不属于');
    await restored.close(); await fork.close();
  });

  it('charges child turns to the parent budget and returns failures when the tree exceeds its limit', async () => {
    const f = await fixture((input, res) => answer(res, input, '', { name: 'read', args: { path: 'sample.txt' } }));
    f.budget.limits.maxModelTurns = 1;
    const results = await f.agents.delegate([task(), task()], 'call');
    expect(f.budget.snapshot().status).toBe('exceeded');
    expect(results.every((row) => row.status === 'failed')).toBe(true);
    expect(results.some((row) => row.error?.includes('模型回合'))).toBe(true);
  });
});

describe('Web subagent integration', () => {
  it('lets the parent work while a child runs, then returns unread results through Pi before verification', async () => {
    let release: (() => void) | undefined, parentStep = 0, synthesis = false;
    const f = await fixture((input, res) => {
      if (text(input).includes('delegated explorer')) { release = () => answer(res, input, 'ASYNC-CHILD-EVIDENCE'); return; }
      if (text(input).includes('Delegated results are now available.')) { synthesis = true; return answer(res, input, 'Combined parent and ASYNC-CHILD-EVIDENCE.'); }
      if (parentStep++ === 0) return answer(res, input, '', { name: 'subagent', args: { action: 'start', tasks: [task()] } });
      if (parentStep === 2) return answer(res, input, '', { name: 'write', args: { path: 'parent-work.txt', content: 'independent work' } });
      return answer(res, input, 'Parent work finished; waiting for delegated evidence.');
    });
    await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'gate', command: 'node --version' }] }));
    const gateway = await startWebConsole({ cwd: f.project, port: 0 }); closers.push(gateway.close);
    const origin = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
    const api = async (path: string, input?: unknown): Promise<any> => { const r = await fetch(origin + '/api/' + path, { headers, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) }); expect(r.ok).toBe(true); return r.json(); };
    await api('projects/trust', { path: f.project, trusted: true });
    const session = await api('session', { project: f.project, model: 'mock/test' });
    await api(`sessions/${session.id}/prompt`, { message: 'Implement an independent parent file and explore with a background child.' });
    await vi.waitFor(async () => { expect(await readFile(join(f.project, 'parent-work.txt'), 'utf8')).toBe('independent work'); expect(release).toBeTypeOf('function'); }, { timeout: 12000 });
    const waiting = await api(`sessions/${session.id}`);
    expect(waiting.running).toBe(true); expect(waiting.verification.status).not.toBe('passed'); expect(synthesis).toBe(false);
    release!(); let done: any;
    await vi.waitFor(async () => { done = await api(`sessions/${session.id}`); expect(done.running).toBe(false); }, { timeout: 12000 });
    expect(synthesis).toBe(true); expect(done.task.status).toBe('completed');
    expect(done.subagents[0]).toMatchObject({ status: 'completed', collectedAt: expect.any(String) });
    expect(done.verification.evidence.freshness).toBe('current');
  });

  it('stops child Pi requests with the parent and releases project ownership after cleanup', async () => {
    const f = await fixture((input, res) => {
      if (text(input).includes('delegated explorer')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
      answer(res, input, '', { name: 'subagent', args: { tasks: [task(), task()] } });
    });
    const gateway = await startWebConsole({ cwd: f.project, port: 0 }); closers.push(gateway.close);
    const origin = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
    const api = async (path: string, input?: unknown) => fetch(origin + path, { headers, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
    await api('/api/projects/trust', { path: f.project, trusted: true });
    const session = await (await api('/api/session', { project: f.project, model: 'mock/test' })).json() as any;
    await api(`/api/sessions/${session.id}/prompt`, { message: 'Inspect in parallel.' });
    await vi.waitFor(() => expect(f.requests).toHaveLength(3), { timeout: 12000 });
    expect((await api(`/api/sessions/${session.id}/abort`, {})).status).toBe(200);
    const snapshot = await (await api(`/api/sessions/${session.id}`)).json() as any;
    expect(snapshot).toMatchObject({ running: false, outcome: 'aborted' });
    expect(snapshot.subagents).toHaveLength(2);
    expect(snapshot.subagents.every((child: any) => child.status === 'cancelled')).toBe(true);
    expect((await api('/api/projects/trust', { path: f.project, trusted: false })).status).toBe(200);
  });

  it('cannot use delegation to expand Ask mode or untrusted-project permissions', async () => {
    const f = await fixture((input, res) => {
      if (input.messages.some((m: any) => m.role === 'tool')) return answer(res, input, 'Delegation was blocked.');
      answer(res, input, '', { name: 'subagent', args: { tasks: [task()] } });
    });
    const gateway = await startWebConsole({ cwd: f.project, port: 0 }); closers.push(gateway.close);
    const origin = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
    const api = async (path: string, input?: unknown) => fetch(origin + path, { headers, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
    await api('/api/projects/trust', { path: f.project, trusted: false });
    for (const mode of ['agent', 'ask']) {
      const session = await (await api('/api/session', { project: f.project, model: 'mock/test', mode })).json() as any;
      await api(`/api/sessions/${session.id}/prompt`, { message: 'Attempt delegated exploration.' });
      await vi.waitFor(async () => { const state = await (await api(`/api/sessions/${session.id}`)).json() as any; expect(state.running).toBe(false); expect(state.subagents).toEqual([]); }, { timeout: 12000 });
    }
    expect(f.requests.every((input) => !text(input).includes('delegated explorer'))).toBe(true);
  });

  it('lets a real Pi parent collect delegated results and exposes only parent-owned child details', async () => {
    const f = await fixture((input, res) => {
      if (text(input).includes('delegated explorer')) return answer(res, input, 'Child evidence: sample.txt:1');
      if (input.messages.some((m: any) => m.role === 'tool')) return answer(res, input, 'Parent synthesis: sample.txt:1');
      answer(res, input, '', { name: 'subagent', args: { tasks: [task()] } });
    });
    const gateway = await startWebConsole({ cwd: f.project, port: 0 }); closers.push(gateway.close);
    const origin = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
    const api = async (path: string, input?: unknown) => fetch(origin + path, { headers, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
    expect((await api('/api/projects/trust', { path: f.project, trusted: true })).status).toBe(200);
    const opened = await api('/api/session', { project: f.project, model: 'mock/test' }); expect(opened.status).toBe(201);
    const session = await opened.json() as any;
    expect((await api(`/api/sessions/${session.id}/prompt`, { message: 'Explore implementation using an independent child.' })).status).toBe(202);
    let snapshot: any;
    await vi.waitFor(async () => { snapshot = await (await api(`/api/sessions/${session.id}`)).json(); expect(snapshot.running).toBe(false); expect(snapshot.subagents).toHaveLength(1); }, { timeout: 12000 });
    expect(snapshot.subagents[0], JSON.stringify(snapshot.subagents)).toMatchObject({ status: 'completed', result: 'Child evidence: sample.txt:1' });
    expect(snapshot.messages.at(-1).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Parent synthesis: sample.txt:1' })]));
    const childId = snapshot.subagents[0].id;
    expect((await api(`/api/sessions/${session.id}/subagents?agent=${childId}`)).status).toBe(200);
    const other = await (await api('/api/session', { project: f.project, model: 'mock/test' })).json() as any;
    expect((await api(`/api/sessions/${other.id}/subagents?agent=${childId}`)).status).toBe(404);
    expect((await api(`/api/sessions/${other.id}/subagents`, { action: 'stop', id: childId })).status).toBe(404);
    const history = await (await api('/api/history')).json() as any;
    expect(JSON.stringify(history)).not.toContain(childId);
  });
});
