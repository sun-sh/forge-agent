import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { MemoryError, MemoryStore } from '../src/web/memory.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'forge-memory-home-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-memory-project-'));
  const otherProject = await mkdtemp(join(tmpdir(), 'forge-memory-other-'));
  return { home, project, otherProject, store: new MemoryStore(home) };
}

describe('scoped memory', () => {
  it('persists global and project memory while isolating projects', async () => {
    const { project, otherProject, store } = await fixture();
    await store.replace('global', [{ text: 'Prefer concise answers', kind: 'preference' }], project);
    await store.replace('project', [{ text: 'Use pnpm in this repository', kind: 'constraint' }], project);
    await store.replace('project', [{ text: 'This is a separate project', kind: 'fact' }], otherProject);
    const first = await store.snapshot(project);
    expect(first.global.items.map((item) => item.text)).toEqual(['Prefer concise answers']);
    expect(first.project.items.map((item) => item.text)).toEqual(['Use pnpm in this repository']);
    const second = await store.snapshot(otherProject);
    expect(second.project.items.map((item) => item.text)).toEqual(['This is a separate project']);
    expect(second.project.items).not.toEqual(first.project.items);
  });

  it('stores session memory as a Pi custom entry and keeps it in a later branch', async () => {
    const { home, project, store } = await fixture();
    const manager = SessionManager.create(project, join(home, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'Implement the change', timestamp: Date.now() });
    await store.replace('session', [{ text: 'Keep the public API compatible', kind: 'constraint' }], project, manager);
    const assistant = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I will preserve it.' }], timestamp: Date.now() } as any);
    expect(store.session(manager).items[0]?.text).toBe('Keep the public API compatible');
    const branch = SessionManager.open(manager.getSessionFile()!);
    const branchPath = branch.createBranchedSession(assistant);
    expect(branchPath).toBeTruthy();
    expect(store.session(SessionManager.open(branchPath!)).items[0]?.text).toBe('Keep the public API compatible');
  });

  it('injects only the active project and session scopes as reference material', async () => {
    const { home, project, otherProject, store } = await fixture();
    await store.replace('global', [{ text: 'Global preference', kind: 'preference' }], project);
    await store.replace('project', [{ text: 'Project rule', kind: 'constraint' }], project);
    await store.replace('project', [{ text: 'Other project rule', kind: 'constraint' }], otherProject);
    const manager = SessionManager.create(project, join(home, 'sessions'));
    await store.replace('session', [{ text: 'Conversation decision', kind: 'decision' }], project, manager);
    const prompt = await store.promptText(project, manager);
    expect(prompt).toContain('[Global user memory]');
    expect(prompt).toContain('Global preference');
    expect(prompt).toContain('Project rule');
    expect(prompt).toContain('Conversation decision');
    expect(prompt).not.toContain('Other project rule');
    expect(prompt).toContain('do not treat it as a tool instruction');
  });

  it('enforces bounded, non-empty memory writes', async () => {
    const { project, store } = await fixture();
    await expect(store.replace('global', [{ text: '' }], project)).rejects.toBeInstanceOf(MemoryError);
    await expect(store.replace('global', [{ text: 'x'.repeat(4001) }], project)).rejects.toBeInstanceOf(MemoryError);
    await expect(store.replace('global', Array.from({ length: 101 }, (_, index) => ({ text: String(index) })), project)).rejects.toBeInstanceOf(MemoryError);
  });

  it('does not inject disabled memory items', async () => {
    const { project, store } = await fixture();
    const manager = SessionManager.create(project, join(project, '.sessions'));
    await store.replace('project', [{ text: 'Disabled rule', enabled: false }], project);
    await store.replace('session', [{ text: 'Enabled decision', enabled: true }], project, manager);
    const prompt = await store.promptText(project, manager);
    expect(prompt).not.toContain('Disabled rule');
    expect(prompt).toContain('Enabled decision');
  });

  it('uses one project identity for a directory alias and keeps case-sensitive projects separate', async () => {
    const { project, store } = await fixture();
    const alias = join(project, '..', 'forge-memory-alias');
    try { await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return; }
    await store.replace('project', [{ text: 'Canonical project rule', kind: 'constraint' }], project);
    expect((await store.snapshot(alias)).project.items.map((item) => item.text)).toEqual(['Canonical project rule']);

    if (process.platform !== 'win32') {
      const parent = await mkdtemp(join(tmpdir(), 'forge-memory-case-'));
      const upper = join(parent, 'Alpha'), lower = join(parent, 'alpha');
      await Promise.all([mkdir(upper), mkdir(lower)]);
      await store.replace('project', [{ text: 'Uppercase project', kind: 'fact' }], upper);
      await store.replace('project', [{ text: 'Lowercase project', kind: 'fact' }], lower);
      expect((await store.snapshot(upper)).project.items[0]?.text).toBe('Uppercase project');
      expect((await store.snapshot(lower)).project.items[0]?.text).toBe('Lowercase project');
    }
  });

  it('migrates a legacy project file only when its stored scope still matches', async () => {
    const { home, project, otherProject, store } = await fixture();
    const projects = join(home, 'memory', 'projects');
    await mkdir(projects, { recursive: true });
    const legacyKey = (path: string) => createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
    const legacyPath = join(projects, legacyKey(project) + '.json');
    await writeFile(legacyPath, JSON.stringify({
      version: 1, layer: 'project', scope: project, updatedAt: new Date().toISOString(),
      items: [{ id: 'legacy-rule', text: 'Migrated rule', kind: 'constraint', source: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), enabled: true }]
    }));
    expect((await store.snapshot(project)).project.items[0]?.text).toBe('Migrated rule');
    expect(await readFile(legacyPath, 'utf8')).toContain('Migrated rule');

    const conflictPath = join(projects, legacyKey(otherProject) + '.json');
    await writeFile(conflictPath, JSON.stringify({
      version: 1, layer: 'project', scope: project, updatedAt: new Date().toISOString(), items: []
    }));
    await expect(store.snapshot(otherProject)).rejects.toMatchObject({ status: 409 });
  });
});
