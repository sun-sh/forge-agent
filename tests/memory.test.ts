import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { MemoryError, MemoryStore, memoryRevision } from '../src/web/memory.js';
import { createExecutionState } from '../src/task/controller.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'forge-memory-home-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-memory-project-'));
  const otherProject = await mkdtemp(join(tmpdir(), 'forge-memory-other-'));
  return { home, project, otherProject, store: new MemoryStore(home) };
}

describe('scoped memory', () => {
  it('retrieves relevant English/path and Chinese memories ahead of unrelated facts while retaining explicit constraints', async () => {
    const { home, project, otherProject, store } = await fixture(), manager = SessionManager.create(project, join(home, 'sessions'));
    const document = await store.replace('project', [
      ...Array.from({ length: 40 }, (_, index) => ({ text: 'Unrelated marketing calendar ' + index + ' ' + 'calendar '.repeat(30), kind: 'fact' })),
      { text: 'src/config/normalize.ts preserves unknown settings in normalizeConfig.', kind: 'fact' },
      { text: '支付回调必须使用幂等键处理重复通知。', kind: 'decision' },
      { text: 'Do not change the public API.', kind: 'constraint' },
      { text: 'normalizeConfig disabled obsolete behavior', kind: 'fact', enabled: false }
    ], project);
    await store.replace('project', [{ text: 'Other project normalizeConfig secret', kind: 'fact' }], otherProject);
    await store.propose(project, manager, { layer: 'project', kind: 'fact', text: 'normalizeConfig unaccepted candidate', evidence: 'model suggestion' });
    const plan = await store.promptPlan(project, manager, 'Fix src/config/normalize.ts normalizeConfig validation');
    expect(plan.text).toContain('preserves unknown settings'); expect(plan.text).toContain('Do not change the public API');
    expect(plan.text).not.toMatch(/marketing|Other project|unaccepted|disabled obsolete/);
    expect(plan.layers.find((layer) => layer.layer === 'project')).toMatchObject({ includedItems: 2, omittedItems: 41 });
    expect(plan.layers.find((layer) => layer.layer === 'project')?.selected).toEqual(expect.arrayContaining([{ id: document.items[40]!.id, reason: 'relevant' }, { id: document.items[42]!.id, reason: 'constraint' }]));
    const chinese = await store.promptPlan(project, manager, '修复支付回调幂等问题');
    expect(chinese.text).toContain('幂等键处理重复通知'); expect(chinese.text).not.toContain('normalizeConfig');
    expect(plan.text.length).toBeLessThanOrEqual(plan.maxChars);
  });
  it('rebuilds bounded original-goal context after compaction and uses that goal instead of an internal phase prompt for recall', async () => {
    const { home, project, store } = await fixture(), manager = SessionManager.create(project, join(home, 'sessions'));
    const task = createExecutionState('Fix normalizeConfig in src/config.ts\n' + 'context '.repeat(700) + '\nPROTECTED_TAIL: preserve unknown keys and never modify auth.ts', { workflow: 'planned' });
    task.phase = 'implement'; task.phases.push({ phase: 'inspect', startedAt: task.startedAt, endedAt: task.startedAt, summary: 'Relevant evidence: src/config.ts' });
    await store.replace('project', [{ text: 'normalizeConfig must keep unknown keys.', kind: 'fact' }, { text: 'Unrelated color preference for logo.', kind: 'fact' }], project);
    const hooks = new Map<string, any>();
    store.extension(project, manager, () => task)({ registerTool() {}, on(name: string, callback: any) { hooks.set(name, callback); } } as any);
    const event = { messageType: 'custom', systemPromptOptions: { sections: {} as Record<string, string> } };
    await hooks.get('before_agent_start')(event);
    expect(event.systemPromptOptions.sections['forge_memory']).toContain('keep unknown keys');
    expect(event.systemPromptOptions.sections['forge_memory']).not.toContain('logo');
    const checkpoint = event.systemPromptOptions.sections['forge_task_checkpoint']!;
    const payload = JSON.parse(checkpoint.slice(checkpoint.indexOf('\n') + 1));
    expect(payload.goal).toContain('Fix normalizeConfig in src/config.ts');
    expect(payload.goal).toContain('PROTECTED_TAIL: preserve unknown keys and never modify auth.ts');
    expect(payload.originalRequest).toMatchObject({ taskId: task.id, characters: task.prompt.length, excerptOnly: true });
    manager.appendCustomEntry('pforge.task', task); manager.appendCompaction('Very short summary without the goal.', manager.getLeafId()!, 10000);
    const reopened = SessionManager.open(manager.getSessionFile()!), rebuilt = new Map<string, any>();
    store.extension(project, reopened, () => task)({ registerTool() {}, on(name: string, callback: any) { rebuilt.set(name, callback); } } as any);
    const after = { messageType: 'custom', systemPromptOptions: { sections: {} as Record<string, string> } };
    await rebuilt.get('before_agent_start')(after);
    expect(after.systemPromptOptions.sections['forge_task_checkpoint']).toBe(checkpoint);
    expect(after.systemPromptOptions.sections['forge_task_checkpoint']).toContain('Fix normalizeConfig');
    expect(after.systemPromptOptions.sections['forge_task_checkpoint']).toContain('PROTECTED_TAIL: preserve unknown keys and never modify auth.ts');
    expect(after.systemPromptOptions.sections['forge_task_checkpoint']!.length).toBeLessThan(7000);
    task.status = 'completed'; await rebuilt.get('before_agent_start')(after);
    expect(after.systemPromptOptions.sections['forge_task_checkpoint']).toBeUndefined();
  });
  it('keeps model proposals out of the prompt until explicit review and records provenance', async () => {
    const { home, project, store } = await fixture(), manager = SessionManager.create(project, join(home, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'Prefer pnpm for this project', timestamp: Date.now() });
    const candidate = await store.propose(project, manager, { layer: 'project', kind: 'preference', text: 'Use pnpm for this project', evidence: 'The user explicitly requested pnpm in this conversation.' });
    expect(await store.promptText(project, manager)).not.toContain('Use pnpm');
    const views = await store.candidateViews(project, manager);
    await store.resolveCandidate(project, manager, candidate.id, 'accept', views[0]!.revision);
    expect(await store.promptText(project, manager)).toContain('Use pnpm');
    expect((await store.project(project)).items[0]).toMatchObject({ source: 'agent', provenance: { candidateId: candidate.id, sessionId: manager.getSessionId() } });
    expect(new MemoryStore(home).candidates(SessionManager.open(manager.getSessionFile()!))[0]?.status).toBe('accepted');
    await expect(store.resolveCandidate(project, manager, candidate.id, 'accept', views[0]!.revision)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects duplicate proposals and stale acceptance, and preserves edits when a replacement conflicts', async () => {
    const { home, project, store } = await fixture(), manager = SessionManager.create(project, join(home, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'change preferences', timestamp: Date.now() });
    const original = await store.replace('project', [{ text: 'Use npm' }], project);
    const proposal = await store.propose(project, manager, { layer: 'project', kind: 'preference', text: 'Use pnpm', evidence: 'user request', supersedes: original.items[0]!.id });
    await expect(store.propose(project, manager, { layer: 'project', kind: 'preference', text: '  Use   PNPM ', evidence: 'duplicate' })).rejects.toMatchObject({ status: 409 });
    await store.replace('project', [{ ...original.items[0], text: 'Use yarn' }], project);
    await expect(store.resolveCandidate(project, manager, proposal.id, 'accept', proposal.baseRevision)).rejects.toMatchObject({ status: 409 });
    await expect(store.resolveCandidate(project, manager, proposal.id, 'accept', memoryRevision(await store.project(project)))).rejects.toThrow('原记忆已经改变');
    expect((await store.project(project)).items[0]?.text).toBe('Use yarn');
    await store.resolveCandidate(project, manager, proposal.id, 'reject');
    expect(store.candidates(manager)[0]?.status).toBe('rejected');
  });
  it('does not give a fork ownership of pending memory candidates or write rejected proposals', async () => {
    const { home, project, store } = await fixture(), manager = SessionManager.create(project, join(home, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'remember later', timestamp: Date.now() });
    const candidate = await store.propose(project, manager, { layer: 'session', kind: 'decision', text: 'Keep API stable', evidence: 'user constraint' });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Candidate ready for review.' }], timestamp: Date.now() } as any);
    const entry = manager.appendMessage({ role: 'user', content: 'branch here', timestamp: Date.now() });
    const branch = SessionManager.open(manager.getSessionFile()!).createBranchedSession(entry)!;
    expect(store.candidates(SessionManager.open(branch))).toEqual([]);
    await store.resolveCandidate(project, manager, candidate.id, 'reject');
    expect(await store.promptText(project, manager)).not.toContain('Keep API stable');
  });
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

  it('reserves prompt space for project and session layers when global memory is large', async () => {
    const { home, project, store } = await fixture();
    await store.replace('global', Array.from({ length: 5 }, (_, index) => ({ text: `global-${index}-` + 'g'.repeat(3990) })) , project);
    await store.replace('project', [{ text: 'PROJECT_RULE_SENTINEL', kind: 'constraint' }], project);
    const manager = SessionManager.create(project, join(home, 'sessions'));
    await store.replace('session', [{ text: 'SESSION_RULE_SENTINEL', kind: 'decision' }], project, manager);
    const plan = await store.promptPlan(project, manager);
    expect(plan.text).toContain('PROJECT_RULE_SENTINEL');
    expect(plan.text).toContain('SESSION_RULE_SENTINEL');
    expect(plan.layers.find((layer) => layer.layer === 'global')).toMatchObject({ truncated: true });
    expect(plan.layers.find((layer) => layer.layer === 'project')).toMatchObject({ truncated: false, includedItems: 1 });
    expect(plan.layers.find((layer) => layer.layer === 'session')).toMatchObject({ truncated: false, includedItems: 1 });
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
