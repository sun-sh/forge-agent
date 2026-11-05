import { beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { changeHistory, exportSession, forkHistory, forkOrigin, historyPath, historyState, sessionTitle } from '../src/web/history.js';
import { startWebConsole } from '../src/web/server.js';

let root: string;
let home: string;
let project: string;
let manager: SessionManager;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-history-'));
  home = join(root, 'home'); project = join(root, 'project');
  await mkdir(join(home, 'sessions'), { recursive: true });
  await mkdir(project, { recursive: true });
  manager = SessionManager.create(project, join(home, 'sessions'));
  manager.appendMessage({ role: 'user', content: '修复登录问题', timestamp: 1 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '我会检查相关文件。' }], api: 'openai-completions', provider: 'mock', model: 'mock', stopReason: 'stop', timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
});

describe('web history adapter', () => {
  it('exports the persisted branch as Markdown and structured JSON without changing the source', () => {
    const before = manager.getLeafId();
    const markdown = exportSession(manager, 'markdown');
    expect(markdown.filename).toMatch(/\.md$/);
    expect(markdown.contentType).toContain('text/markdown');
    expect(markdown.body).toContain('# 修复登录问题');
    expect(markdown.body).toContain('我会检查相关文件。');
    const json = exportSession(manager, 'json');
    expect(json.filename).toMatch(/\.json$/);
    expect(JSON.parse(json.body)).toMatchObject({ version: 1, title: '修复登录问题', entries: expect.any(Array) });
    expect(manager.getLeafId()).toBe(before);
  });

  it('persists title and lifecycle state through Pi custom/session entries', async () => {
    const path = manager.getSessionFile()!;
    expect(sessionTitle(manager)).toBe('修复登录问题');
    changeHistory(manager, 'rename', '登录修复 · 第一版');
    changeHistory(manager, 'pin');
    changeHistory(manager, 'archive');
    expect(historyState(manager)).toEqual({ version: 1, pinned: true, status: 'archived' });
    const reopened = SessionManager.open(path);
    expect(reopened.getSessionName()).toBe('登录修复 · 第一版');
    expect(historyState(reopened)).toEqual({ version: 1, pinned: true, status: 'archived' });
    changeHistory(reopened, 'restore'); changeHistory(reopened, 'trash');
    expect(historyState(SessionManager.open(path))).toEqual({ version: 1, pinned: false, status: 'trashed' });
    await access(path);
  });

  it('rejects missing, malformed, and outside paths before opening them', async () => {
    const sessions = join(home, 'sessions');
    await expect(historyPath(join(sessions, '..', 'secret.jsonl'), sessions)).rejects.toMatchObject({ status: 400 });
    await expect(historyPath(join(sessions, 'missing.jsonl'), sessions)).rejects.toMatchObject({ status: 404 });
    const malformed = join(sessions, 'malformed.jsonl');
    await writeFile(malformed, '{"type":"not-a-session"}\n', 'utf8');
    await expect(historyPath(malformed, sessions)).rejects.toMatchObject({ status: 400 });
    const empty = join(sessions, 'empty.jsonl');
    await writeFile(empty, '');
    await expect(historyPath(empty, sessions)).rejects.toMatchObject({ status: 400 });
    expect(await readFile(empty, 'utf8')).toBe('');
  });

  it('creates a Pi branched session without mutating the source branch', async () => {
    const sourcePath = manager.getSessionFile()!;
    const sourceBytes = await readFile(sourcePath, 'utf8');
    const sourceLeaf = manager.getLeafId();
    const sourceEntry = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user')!;
    const result = forkHistory(manager, sourceEntry.id);
    expect(result.origin.kind).toBe('edit');
    expect(result.draft).toBe('修复登录问题');
    expect(await stat(result.path)).toBeTruthy();
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
    expect(manager.getLeafId()).toBe(sourceLeaf);
    const forked = SessionManager.open(result.path);
    expect(forkOrigin(forked)).toMatchObject({ sourcePath, entryId: sourceEntry.id, kind: 'edit' });
    expect(forked.getSessionName()).toContain('分支');
    expect(forked.buildSessionContext().messages.some((message: any) => message.role === 'user' && message.content === '修复登录问题')).toBe(false);
    expect(resolve(forked.getCwd())).toBe(resolve(project));

    changeHistory(manager, 'pin'); changeHistory(manager, 'archive');
    manager.appendCustomEntry('pforge.task', { status: 'completed' });
    manager.appendCustomEntry('pforge.verification', { status: 'passed', attempts: 3 });
    const assistantEntry = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'assistant')!;
    const continuation = forkHistory(manager, assistantEntry.id);
    expect(continuation.origin.kind).toBe('continue');
    expect(continuation.draft).toBe('');
    const continued = SessionManager.open(continuation.path);
    expect(forkOrigin(continued)).toMatchObject({ entryId: assistantEntry.id, kind: 'continue' });
    expect(historyState(continued)).toEqual({ version: 1, status: 'active', pinned: false });
    const custom = continued.getBranch().filter((entry) => entry.type === 'custom');
    expect([...custom].reverse().find((entry) => entry.customType === 'pforge.task')?.data).toEqual({ cleared: true });
    expect([...custom].reverse().find((entry) => entry.customType === 'pforge.verification')?.data).toEqual({ status: 'unchecked', attempts: 0 });
    expect(forkHistory.bind(null, manager, 'missing-entry')).toThrow('只能从当前对话');
  });

  it('serves history actions and read-only forks without requiring model credentials', async () => {
    const previous = { forge: process.env['FORGE_AGENT_HOME'], pforge: process.env['PFORGE_HOME'], pi: process.env['PI_CODING_AGENT_DIR'], sessions: process.env['PI_CODING_AGENT_SESSION_DIR'] };
    process.env['FORGE_AGENT_HOME'] = home;
    delete process.env['PFORGE_HOME']; delete process.env['PI_CODING_AGENT_DIR']; delete process.env['PI_CODING_AGENT_SESSION_DIR'];
    let server: Awaited<ReturnType<typeof startWebConsole>> | undefined;
    try {
      server = await startWebConsole({ cwd: project, port: 0 });
      const base = new URL(server.url).origin;
      const headers = { 'x-pforge-token': server.token, 'content-type': 'application/json' };
      const path = manager.getSessionFile()!;
      const history = await fetch(base + '/api/history', { headers });
      expect(await history.json()).toMatchObject({ projects: [ { sessions: [expect.objectContaining({ title: '修复登录问题', status: 'active' })] } ] });
      const markdownExport = await fetch(base + '/api/history/export?path=' + encodeURIComponent(path) + '&format=markdown', { headers });
      expect(markdownExport.status).toBe(200);
      expect(markdownExport.headers.get('content-disposition')).toContain('attachment');
      expect(await markdownExport.text()).toContain('# 修复登录问题');
      const jsonExport = await fetch(base + '/api/history/export?path=' + encodeURIComponent(path) + '&format=json', { headers });
      const jsonBody = await jsonExport.json() as any;
      expect(jsonBody.entries).toBeInstanceOf(Array);
      const pin = await fetch(base + '/api/history', { method: 'POST', headers, body: JSON.stringify({ path, action: 'pin' }) });
      expect(pin.status).toBe(200);
      const archived = await fetch(base + '/api/history', { method: 'POST', headers, body: JSON.stringify({ path, action: 'archive' }) });
      expect(await archived.json()).toMatchObject({ history: { status: 'archived', pinned: true } });
      const opened = await fetch(base + '/api/session', { method: 'POST', headers, body: JSON.stringify({ project, sessionFile: path }) });
      const snapshot = await opened.json() as { id: string; readOnly: boolean; forkableEntries: string[] };
      expect(opened.status).toBe(201); expect(snapshot.readOnly).toBe(true); expect(snapshot.forkableEntries.length).toBeGreaterThanOrEqual(1);
      const fork = await fetch(base + '/api/sessions/' + snapshot.id + '/fork', { method: 'POST', headers, body: JSON.stringify({ entryId: snapshot.forkableEntries[0] }) });
      expect(fork.status).toBe(201);
      const forkBody = await fork.json() as { path: string };
      expect(forkBody.path).not.toBe(path);
      const restored = await fetch(base + '/api/history', { method: 'POST', headers, body: JSON.stringify({ path, action: 'restore' }) });
      expect(await restored.json()).toMatchObject({ history: { status: 'active', pinned: true } });
      const outside = await fetch(base + '/api/history', { method: 'POST', headers, body: JSON.stringify({ path: join(home, 'outside.jsonl'), action: 'pin' }) });
      expect(outside.status).toBe(400);
      await rename(project, project + '-moved');
      const missingProjectHistory = await fetch(base + '/api/history', { headers });
      expect(JSON.stringify(await missingProjectHistory.json())).toContain('修复登录问题');
      const managedMissingProject = await fetch(base + '/api/history', { method: 'POST', headers, body: JSON.stringify({ path, action: 'trash' }) });
      expect(managedMissingProject.status).toBe(200);
    } finally {
      if (server) await server.close();
      for (const [key, value] of Object.entries(previous)) {
        const envKey = key === 'forge' ? 'FORGE_AGENT_HOME' : key === 'pforge' ? 'PFORGE_HOME' : key === 'pi' ? 'PI_CODING_AGENT_DIR' : 'PI_CODING_AGENT_SESSION_DIR';
        if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
      }
    }
  });
});
