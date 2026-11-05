import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWebConsole } from '../src/web/server.js';

const closers: Array<() => Promise<void>> = [];
let home: string;
beforeEach(async () => {
  home = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'forge-web-tasks-home-')));
  vi.stubEnv('FORGE_AGENT_HOME', home);
  vi.stubEnv('PFORGE_HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', home);
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
});
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

describe('Web task and project file endpoints', () => {
  it('lists durable tasks and protects project files behind explicit trust', async () => {
    const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'forge-web-tasks-project-')));
    const home = process.env['FORGE_AGENT_HOME']!;
    await mkdir(join(home, 'tasks'), { recursive: true });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), 'export const answer = 42;');
    await writeFile(join(root, '.env'), 'TOKEN=private');
    const id = randomUUID(), now = new Date().toISOString();
    await writeFile(join(home, 'tasks', 'index.json'), JSON.stringify({ version: 1, tasks: [{ version: 1, id, project: root, sessionFile: join(home, 'sessions', 'task.json'), state: { version: 1, id, prompt: 'Recover the interrupted task', status: 'interrupted', phase: 'implement', startedAt: now, updatedAt: now, repairs: 0, phases: [{ phase: 'inspect', startedAt: now }], error: 'service restarted' } }] }));
    const server = await startWebConsole({ cwd: root, port: 0 }); closers.push(server.close);
    const base = new URL(server.url).origin, headers = { 'x-pforge-token': server.token };
    const tasks = await fetch(base + '/api/tasks?project=' + encodeURIComponent(root), { headers });
    expect(tasks.status).toBe(200);
    expect(await tasks.json()).toMatchObject({ tasks: [expect.objectContaining({ id, status: 'interrupted', project: root })] });
    expect((await fetch(base + '/api/files?project=' + encodeURIComponent(root), { headers })).status).toBe(403);
    const untrustedTerminal = await fetch(base + '/api/terminal', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ project: root, command: 'node --version' }) });
    expect(untrustedTerminal.status).toBe(403);
    const trusted = await fetch(base + '/api/projects/trust', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ path: root, trusted: true }) });
    expect(trusted.status).toBe(200);
    const files = await fetch(base + '/api/files?project=' + encodeURIComponent(root) + '&q=main', { headers });
    expect(files.status).toBe(200);
    expect(await files.json()).toMatchObject({ files: [expect.objectContaining({ path: 'src/main.ts' })] });
    const command = '"' + process.execPath.replaceAll('"', '\\"') + '" -e "console.log(123)"';
    const terminal = await fetch(base + '/api/terminal', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ project: root, command, timeoutMs: 10_000 }) });
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toMatchObject({ ok: true, result: { exitCode: 0, combined: expect.stringContaining('123') } });
  });
});
