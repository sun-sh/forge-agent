import { respondBehaviorFixture, fixturePhase } from '../scripts/test-behavior-protocol.mjs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWebConsole } from '../src/web/server.js';
import { checkpointGit } from '../src/task/checkpoints.js';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const end of close.splice(0).reverse()) await end(); vi.unstubAllEnvs(); });

async function fixture(alwaysTruncated = false, empty = false) {
  const project = await mkdtemp(join(tmpdir(), 'forge-output-project-')), home = await mkdtemp(join(tmpdir(), 'forge-output-home-'));
  for (const name of ['FORGE_AGENT_HOME', 'PFORGE_HOME', 'PI_CODING_AGENT_DIR']) vi.stubEnv(name, home);
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
  await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'node', command: 'node --version' }], verifyRetries: 0 }));
  await checkpointGit(project, ['init', '-q']); await checkpointGit(project, ['add', '.']);
  await checkpointGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'baseline']);
  let truncated = false, calls = 0;
  const upstream = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); calls++;
    if (respondBehaviorFixture(input, response)) return;
    const phase = fixturePhase(input);
    let delta: unknown, finish = 'stop';
    if (phase === 'inspect') delta = { content: JSON.stringify(handoff.brief) };
    else if (phase === 'plan') delta = { content: JSON.stringify(handoff.plan) };
    else if (phase === 'review') delta = { content: JSON.stringify({ verdict: 'ready', summary: 'Reviewed actual code', issues: [], acceptance: handoff.acceptance }) };
    else if (!truncated || alwaysTruncated) {
      truncated = true; delta = { reasoning_content: 'fixture-only reasoning that must never imply a finished implementation' };
      finish = empty ? 'stop' : 'length';
    } else if (input.messages.at(-1)?.role !== 'tool') {
      delta = { tool_calls: [{ index: 0, id: 'create-' + calls, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'index.html', content: '<!doctype html><html><body><svg><circle r="10"/></svg></body></html>' }) } }] };
      finish = 'tool_calls';
    } else delta = { content: 'Saved index.html.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta as object }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 500, completion_tokens: 128, total_tokens: 628 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((ready) => upstream.listen(0, '127.0.0.1', ready));
  close.push(() => new Promise<void>((ready) => { upstream.closeAllConnections(); upstream.close(() => ready()); }));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: 'model', maxTokens: 128, contextWindow: 128000, reasoning: true }] } } }));
  const server = await startWebConsole({ cwd: project, port: 0 }); close.push(server.close);
  const api = async (path: string, input?: object): Promise<any> => {
    const response = await fetch(new URL(server.url).origin + '/api/' + path, { headers: { 'x-pforge-token': server.token, 'content-type': 'application/json' }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
    const data = await response.json(); expect(response.ok, JSON.stringify(data)).toBe(true); return data;
  };
  await api('projects/trust', { path: project, trusted: true });
  const session = await api('session', { project, model: 'fixture/model', mode: 'agent' });
  const run = async (workflow: string) => {
    await api('sessions/' + session.id + '/prompt', { message: 'Create index.html using inline SVG.', workflow });
    let result: any;
    await vi.waitFor(async () => { result = await api('sessions/' + session.id); expect(result.running, JSON.stringify({ phase: result.task?.phase, status: result.task?.status, finalization: result.task?.finalization, error: result.error, activeTools: result.activeTools?.map((tool: any) => tool.toolName) })).toBe(false); }, { timeout: 45000 });
    return result;
  };
  return { project, api, run, calls: () => calls };
}

describe('incomplete model output delivery boundary', () => {
  it.each(['direct', 'planned'])('continues a reasoning-only length stop and really writes the file in %s', async (workflow) => {
    const f = await fixture(); const done = await f.run(workflow);
    expect(done).toMatchObject({ outcome: 'completed', task: { status: 'completed' }, verification: { status: 'passed' } });
    expect(await readFile(join(f.project, 'index.html'), 'utf8')).toContain('<svg>');
    expect(done.entries.filter((entry: any) => entry.type === 'custom' && entry.customType === 'forge.output_recovery')).toHaveLength(1);
    expect(done.messages.filter((message: any) => message.role === 'user')).toHaveLength(1);
  }, 60000);
  it('charges truncation continuation to the existing parent model-turn budget', async () => {
    const f = await fixture(true);
    await f.api('settings/budget', { budget: { maxDurationMs: 60000, maxModelTurns: 1, maxToolCalls: 10, maxTotalTokens: 0, maxOutputTokens: 1000, maxCostUsd: 1 } });
    const done = await f.run('direct');
    expect(done.task.status).toBe('budget_exceeded');
    expect(done.budget.limits.maxModelTurns).toBe(1);
    expect(done.budget.modelTurns).toBeGreaterThan(1);
    expect(f.calls()).toBe(1);
    expect(done.verification.report).toBeUndefined();
  }, 60000);
  it.each([false, true])('fails before verification after two incomplete-output recoveries (empty=%s)', async (empty) => {
    const f = await fixture(true, empty); const done = await f.run('planned');
    expect(done).toMatchObject({ outcome: 'failed', task: { status: 'failed', phase: 'implement' } });
    expect(done.error).toContain(empty ? '未返回正文' : '输出上限');
    expect(done.task.phases.some((phase: any) => phase.phase === 'verify')).toBe(false);
    expect(done.verification.report).toBeUndefined();
    await expect(readFile(join(f.project, 'index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls()).toBe(6); // inspect + plan + independent check design + original output + two recoveries
  }, 60000);
});
