import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkpointGit, CheckpointStore } from '../src/task/checkpoints.js';
import { startWebConsole } from '../src/web/server.js';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'forge-web-evidence-'));
  const home = await mkdtemp(join(tmpdir(), 'forge-web-evidence-home-'));
  for (const key of ['FORGE_AGENT_HOME', 'PFORGE_HOME', 'PI_CODING_AGENT_DIR']) vi.stubEnv(key, home);
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
  await writeFile(join(project, 'sample.txt'), 'before\n');
  await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'gate', command: 'node --version' }], verifyRetries: 0 }));
  await checkpointGit(project, ['init', '-q']); await checkpointGit(project, ['add', '.']);
  await checkpointGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'baseline']);
  let operation: 'answer' | 'edit' | 'delegate' = 'answer', count = 0;
  const upstream = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); count++;
    const child = JSON.stringify(input.messages).includes("delegated worker");
    let call: { name: string; arguments: unknown } | undefined;
    if (child && input.messages.at(-1)?.role !== 'tool') call = { name: 'write', arguments: { path: 'sample.txt', content: 'worker proposal\n' } };
    else if (!child && operation !== 'answer') {
      call = operation === 'edit' ? { name: 'write', arguments: { path: 'sample.txt', content: 'after\n' } } : { name: 'subagent', arguments: { tasks: [{ title: 'Isolated edit', role: 'worker', prompt: 'Change sample.txt to worker proposal.' }] } };
      operation = 'answer';
    }
    const phase = [...JSON.stringify(input).matchAll(/PFORGE TASK PHASE: (\w+)/g)].at(-1)?.[1];
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + count, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: phase === 'review' ? JSON.stringify({ verdict: 'ready', summary: 'Reviewed', issues: [], acceptance: handoff.acceptance }) : phase === 'plan' ? JSON.stringify(handoff.plan) : phase === 'inspect' ? JSON.stringify(handoff.brief) : 'Task response.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']]) response.write('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-test', models: [{ id: 'model' }] } } }));
  let server = await startWebConsole({ cwd: project, port: 0 }); closers.push(() => server.close());
  const request = (path: string, input?: unknown) => fetch(new URL(server.url).origin + '/api/' + path, { headers: { 'x-pforge-token': server.token, 'content-type': 'application/json' }, ...(input !== undefined ? { method: 'POST', body: JSON.stringify(input) } : {}) });
  const api = async (path: string, input?: unknown): Promise<any> => {
    const response = await request(path, input);
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBeLessThan(400); return value;
  };
  await api('projects/trust', { path: project, trusted: true });
  const open = () => api('session', { project, model: 'fixture/model', mode: 'agent' });
  const snapshot = (id: string) => api('sessions/' + id);
  const run = async (id: string, message = 'Run configured verification', workflow = 'planned') => {
    await api('sessions/' + id + '/prompt', { message, workflow });
    let state: any; await vi.waitFor(async () => { state = await snapshot(id); expect(state.running, JSON.stringify({ phase: state.task?.phase, status: state.task?.status, children: state.subagents?.map((child: any) => ({ status: child.status, error: child.error })) })).toBe(false); }, { timeout: 45000 }); return state;
  };
  return { project, home, api, request, modelRequests: () => count, open, run, snapshot, setOperation(value: typeof operation) { operation = value; }, async restart(forgetTaskIndex = false) { await server.close(); if (forgetTaskIndex) await writeFile(join(home, 'tasks', 'index.json'), JSON.stringify({ version: 1, tasks: [] })); server = await startWebConsole({ cwd: project, port: 0 }); } };
}

describe('Web verification evidence across workspace mutations', { timeout: 60000 }, () => {
  it.each(['direct', 'planned'])('keeps %s session, task index and recovered history failed when checkpoint sealing fails', async (workflow) => {
    const f = await fixture(), parent = await f.open();
    const seal = vi.spyOn(CheckpointStore.prototype, 'seal').mockRejectedValueOnce(new Error('injected checkpoint seal failure'));
    try {
      const done = await f.run(parent.id, 'Fix the login error while preserving existing tests.', workflow);
      expect(done).toMatchObject({ outcome: 'failed', running: false, task: { status: 'failed', finalization: 'failed', verification: { status: 'passed' } } });
      expect(done.task.error).toContain('injected checkpoint seal failure');
      const index = await f.api('tasks'); expect(index.tasks.find((task: any) => task.id === done.task.id)?.status).toBe('failed');
      await f.restart(); const restored = await f.api('session', { project: f.project, sessionFile: done.sessionFile });
      expect(restored.task).toMatchObject({ status: 'failed', finalization: 'failed' });
    } finally { seal.mockRestore(); }
  });
  it.each([true, false])('applies selected worker files and verifies the main project without model requests (pass=%s)', async (pass) => {
    const f = await fixture(), parent = await f.open(); f.setOperation('delegate');
    const proposed = await f.run(parent.id, 'Implement the sample.txt update with an isolated worker.', 'direct');
    const child = proposed.subagents[0], route = 'sessions/' + parent.id + '/subagents';
    if (!pass) await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'proposal gate', command: 'node -e "console.error(\'proposal gate failure\');process.exit(7)"' }], verifyRetries: 0 }));
    const detail = await f.api(route + '?agent=' + child.id), before = f.modelRequests();
    const response = await f.request(route, { action: 'apply-verify', id: child.id, paths: ['sample.txt'], revision: detail.proposal.revision });
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ verificationStarted: true });
    let done: any; await vi.waitFor(async () => { done = await f.snapshot(parent.id); expect(done.running).toBe(false); }, { timeout: 20000 });
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('worker proposal\n');
    expect(done.workflow).toBe('direct'); expect(f.modelRequests()).toBe(before);
    expect(done.task, JSON.stringify({ error: done.task.error, verification: done.task.verification })).toMatchObject({ kind: 'verify', status: pass ? 'completed' : 'failed' });
    expect(done.task.verification.status).toBe(pass ? 'passed' : 'failed');
    if (pass) expect(done.task.verification.evidence.freshness).toBe('current');
    else expect(JSON.stringify(done.task.verification.report)).toContain('proposal gate failure');
  });
  it('refuses apply-and-verify before changing files when verification is missing or project trust is revoked', async () => {
    const f = await fixture(), parent = await f.open(); f.setOperation('delegate');
    const proposed = await f.run(parent.id, 'Implement the sample.txt update with an isolated worker.', 'direct');
    const child = proposed.subagents[0], route = 'sessions/' + parent.id + '/subagents', detail = await f.api(route + '?agent=' + child.id);
    await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ verify: [] }));
    const input = { action: 'apply-verify', id: child.id, paths: ['sample.txt'], revision: detail.proposal.revision };
    expect((await f.request(route, input)).status).toBe(409);
    await f.api('projects/trust', { path: f.project, trusted: false });
    expect((await f.request(route, input)).status).toBe(403);
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('before\n');
  });
  it('invalidates both sessions and durable tasks after checkpoint undo, and preserves the result on restart', async () => {
    const f = await fixture(), first = await f.open(); f.setOperation('edit');
    const completed = await f.run(first.id, 'Modify sample.txt to after', 'direct');
    expect(completed.task).toMatchObject({ status: 'completed', verification: { evidence: { freshness: 'current' } } });
    expect(completed.task.review).toBeUndefined();
    const second = await f.open(); const verified = await f.run(second.id);
    const views = await f.api('sessions/' + first.id + '/checkpoints');
    const view = views.checkpoints.find((item: any) => item.files.some((file: any) => file.path === 'sample.txt' && file.eligible));
    expect(view).toBeDefined();
    await f.api('sessions/' + first.id + '/checkpoints', { id: view.id, paths: ['sample.txt'], revision: view.revision });
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('before\n');
    for (const [session, previous] of [[first, completed], [second, verified]]) {
      const state = await f.snapshot(session.id);
      expect(state.task).toMatchObject({ status: 'needs_attention', verification: { evidence: { freshness: 'stale' } } });
      expect(state.verification.report).toEqual(previous.verification.report);
      expect((await f.api('tasks/' + previous.task.id)).verification.evidence.freshness).toBe('stale');
    }
    const exported = await f.api('history/export?format=json&path=' + encodeURIComponent(completed.sessionFile));
    expect(exported.assessment).toMatchObject({ task: { status: 'needs_attention' }, verification: { evidence: { freshness: 'stale' } } });
    await f.restart();
    const reopened = await f.api('session', { project: f.project, sessionFile: completed.sessionFile });
    expect(reopened.task.status).toBe('needs_attention'); expect(reopened.verification.evidence.freshness).toBe('stale');
  });
  it('invalidates on a partially failing terminal command and on external edits after reopening', async () => {
    const f = await fixture(), session = await f.open(); const completed = await f.run(session.id);
    const terminal = await f.api('terminal', { project: f.project, command: 'node -e "require(\'node:fs\').writeFileSync(\'sample.txt\', \'terminal change\'); process.exitCode=7"' });
    expect(terminal.ok).toBe(false);
    expect((await f.snapshot(session.id)).task).toMatchObject({ status: 'needs_attention', verification: { evidence: { freshness: 'stale' } } });
    const rechecked = await f.run(session.id); expect(rechecked.verification.evidence.freshness).toBe('current');
    await writeFile(join(f.project, 'sample.txt'), 'external edit\n'); await f.restart(true);
    const exported = await f.api('history/export?format=json&path=' + encodeURIComponent(completed.sessionFile));
    expect(exported.assessment.task.status).toBe('needs_attention');
    expect(exported.assessment.verification.evidence.freshness).toBe('unconfirmed');
    const reopened = await f.api('session', { project: f.project, sessionFile: completed.sessionFile });
    expect(reopened.verification.evidence.freshness).toBe('stale'); expect(reopened.task.status).toBe('needs_attention');
    expect((await f.api('tasks/' + rechecked.task.id)).verification.evidence.freshness).toBe('stale');
  });
  it('keeps worker proposals pending, invalidates evidence on apply and requires fresh verification', async () => {
    const f = await fixture(), session = await f.open(); f.setOperation('delegate');
    const completed = await f.run(session.id, 'Implement the change using an isolated worker', 'direct');
    expect(completed.task.status).toBe('needs_attention'); expect(completed.task.error).toContain('提案');
    expect(completed.verification.evidence.freshness).toBe('current');
    const child = completed.subagents.find((item: any) => item.role === 'worker'); expect(child.status).toBe('completed');
    const detail = await f.api('sessions/' + session.id + '/subagents?agent=' + child.id);
    expect(detail.proposal.files).toMatchObject([{ path: 'sample.txt', eligible: true }]);
    await f.api('sessions/' + session.id + '/subagents', { action: 'apply', id: child.id, paths: ['sample.txt'], revision: detail.proposal.revision });
    expect((await f.snapshot(session.id)).verification.evidence.freshness).toBe('stale');
    expect(await readFile(join(f.project, 'sample.txt'), 'utf8')).toBe('worker proposal\n');
    const checked = await f.run(session.id); expect(checked.task.status).toBe('completed'); expect(checked.verification.evidence.freshness).toBe('current');
  });
});
