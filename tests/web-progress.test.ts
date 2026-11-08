import { createServer } from 'node:http';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startWebConsole } from '../src/web/server.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
it.each([{ workflow: 'direct', tool: 'read' }, { workflow: 'planned', tool: 'read' }, { workflow: 'direct', tool: 'bash' }])('stops unchanged Pi tool cycles in $workflow execution using $tool, preserves evidence and allows a new user prompt', async ({ workflow, tool }) => {
  const home = await mkdtemp(join(tmpdir(), 'forge-progress-home-')), project = await mkdtemp(join(tmpdir(), 'forge-progress-project-'));
  for (const [key, value] of Object.entries({ FORGE_AGENT_HOME: home, PFORGE_HOME: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions') })) vi.stubEnv(key, value);
  let requests = 0, warned = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests++; warned ||= JSON.stringify(input.messages).includes('Forge progress notice');
    const newPrompt = JSON.stringify(input.messages.filter((message: any) => message.role === 'user').at(-1)).includes('fresh question');
    const call = !newPrompt && requests < 20;
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'tool-' + requests, type: 'function', function: { name: tool, arguments: JSON.stringify(tool === 'read' ? { path: 'sample.txt' } : { command: 'echo unchanged source evidence' }) } }] } : { role: 'assistant', content: 'Answered the fresh question.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, ...choice }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  closers.push(async () => { provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); });
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mock: { api: 'openai-completions', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`, models: [{ id: 'test', contextWindow: 64000, maxTokens: 1024 }] } } }));
  await writeFile(join(project, 'sample.txt'), 'unchanged source evidence\n');
  await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'must-not-run', command: 'node -e "require(\'fs\').writeFileSync(\'verification-marker\',\'ran\')"' }] }));
  const gateway = await startWebConsole({ cwd: project, port: 0 }); closers.push(gateway.close);
  const base = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
  const api = async (path: string, input?: unknown) => { const res = await fetch(base + path, { headers, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) }); const data = await res.json() as any; expect(res.ok, JSON.stringify(data)).toBe(true); return data; };
  await api('/api/projects/trust', { path: project, trusted: true });
  const session = await api('/api/session', { project, mode: 'agent', model: 'mock/test' });
  await api(`/api/sessions/${session.id}/prompt`, { message: 'Implement a fix for sample.txt by examining the relevant evidence.', workflow });
  let final: any;
  await vi.waitFor(async () => { final = await api(`/api/sessions/${session.id}`); expect(final.running).toBe(false); }, { timeout: 20000 });
  expect(final.task).toMatchObject({ status: 'needs_attention', repairs: 0, progress: { status: 'stalled', warnings: 1, unchanged: 12 } });
  // Shell adapters may include a distinct first result envelope. Assert bounded
  // termination rather than depending on one transport's exact request count.
  expect(requests).toBeGreaterThanOrEqual(13); expect(requests).toBeLessThanOrEqual(15);
  expect(warned).toBe(true); await expect(access(join(project, 'verification-marker'))).rejects.toBeTruthy();
  const outputs = final.messages.filter((message: any) => message.role === 'toolResult');
  expect(JSON.stringify(outputs)).toContain('unchanged source evidence');
  await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [] }));
  await api(`/api/sessions/${session.id}/prompt`, { message: 'Answer this fresh question briefly.', workflow: 'direct' });
  await vi.waitFor(async () => { final = await api(`/api/sessions/${session.id}`); expect(final.running).toBe(false); }, { timeout: 15000 });
  expect(final.task).toMatchObject({ status: 'completed', progress: { status: 'active', warnings: 0 } });
}, 60000);
