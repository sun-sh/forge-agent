import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWebConsole } from '../src/web/server.js';

const closers: Array<() => Promise<void>> = [];
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'forge-web-budget-home-'));
  vi.stubEnv('FORGE_AGENT_HOME', home); vi.stubEnv('PFORGE_HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', home); vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(home, 'sessions'));
});
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

describe('Web host controls', () => {
  it('persists strict execution budget settings without changing project config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-budget-project-'));
    const gateway = await startWebConsole({ cwd: root, port: 0 }); closers.push(gateway.close);
    const origin = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
    const initial = await fetch(origin + '/api/settings', { headers });
    expect(initial.status).toBe(200);
    const initialPayload = await initial.json() as { budget?: { maxModelTurns?: number } };
    expect(initialPayload.budget).toMatchObject({ maxModelTurns: 240 });
    const invalid = await fetch(origin + '/api/settings/budget', { method: 'POST', headers, body: JSON.stringify({ budget: { maxModelTurns: 0 } }) });
    expect(invalid.status).toBe(400);
    const limits = { maxDurationMs: 120000, maxModelTurns: 7, maxToolCalls: 20, maxTotalTokens: 30000, maxOutputTokens: 50000, maxCostUsd: 2.5 };
    const saved = await fetch(origin + '/api/settings/budget', { method: 'POST', headers, body: JSON.stringify({ budget: limits }) });
    expect(saved.status).toBe(200); expect(await saved.json()).toEqual({ budget: limits });
    expect(JSON.parse(await readFile(join(home, 'web-settings.json'), 'utf8'))).toEqual({ budget: limits });
  });

  it('rejects a second terminal command for the same project while the first is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-terminal-project-'));
    const gateway = await startWebConsole({ cwd: root, port: 0 }); closers.push(gateway.close);
    const origin = new URL(gateway.url).origin, headers = { 'x-pforge-token': gateway.token, 'content-type': 'application/json' };
    const trusted = await fetch(origin + '/api/projects/trust', { method: 'POST', headers, body: JSON.stringify({ path: root, trusted: true }) });
    expect(trusted.status).toBe(200);
    const command = '"' + process.execPath.replaceAll('"', '\\"') + '" -e "setTimeout(() => console.log(\'done\'), 600)"';
    const first = fetch(origin + '/api/terminal', { method: 'POST', headers, body: JSON.stringify({ project: root, command, timeoutMs: 5000 }) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await fetch(origin + '/api/terminal', { method: 'POST', headers, body: JSON.stringify({ project: root, command }) });
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });
});
