import { randomUUID } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointStore, checkpointGit, checkpointTarget, safeCheckpointPath } from '../src/task/checkpoints.js';
import { WorkerWorktrees } from '../src/task/worktrees.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'forge-checkpoint-home-')), project = await mkdtemp(join(tmpdir(), 'forge-checkpoint-project-'));
  const git = (args: string[]) => checkpointGit(project, args);
  await git(['init']); await git(['config', 'core.autocrlf', 'false']);
  await writeFile(join(project, 'base.txt'), 'committed\n'); await writeFile(join(project, 'delete.txt'), 'keep this\n');
  await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  return { home, project, git, session: randomUUID(), store: new CheckpointStore(home) };
}
describe('task-owned working file checkpoints', () => {
  it('refuses hard-linked destinations and Windows ambiguous file aliases', async () => {
    const f = await fixture();
    await link(join(f.project, 'base.txt'), join(f.project, 'linked.txt'));
    await expect(checkpointTarget(f.project, 'linked.txt')).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(f.project, 'base.txt'), 'utf8')).toBe('committed\n');
    if (process.platform === 'win32') for (const path of ['.git./config', 'folder /file', 'NUL.txt', 'file.']) expect(safeCheckpointPath(path), path).toBe(false);
  });
  it('restores exact preexisting dirty and staged content, additions and deletions without resetting the index', async () => {
    const f = await fixture(); await writeFile(join(f.project, 'base.txt'), 'user staged\n'); await f.git(['add', 'base.txt']);
    await writeFile(join(f.project, 'base.txt'), 'user working\n');
    const index = await f.git(['ls-files', '--stage']);
    const id = await f.store.begin(f.project, f.session, 'task');
    await writeFile(join(f.project, 'base.txt'), 'agent edit\n'); await unlink(join(f.project, 'delete.txt'));
    await writeFile(join(f.project, 'new & file.txt'), Buffer.from([0, 1, 2]));
    const view = await f.store.seal(id, f.project, f.session);
    expect(view.files).toHaveLength(3); expect(view.files.every((file) => file.eligible), JSON.stringify(view)).toBe(true);
    expect((await f.store.diff(id, f.project, f.session, 'base.txt')).diff).toContain('-user working');
    await f.store.apply(id, f.project, f.session, view.files.map((file) => file.path), view.revision);
    expect(await readFile(join(f.project, 'base.txt'), 'utf8')).toBe('user working\n');
    expect(await readFile(join(f.project, 'delete.txt'), 'utf8')).toBe('keep this\n');
    await expect(readFile(join(f.project, 'new & file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.git(['ls-files', '--stage'])).toBe(index);
    expect((await f.store.view(id, f.project, f.session)).files.every((file) => file.applied)).toBe(true);
  });
  it('rejects later edits, stale revisions and foreign ownership before writing any selected file', async () => {
    const f = await fixture(), id = await f.store.begin(f.project, f.session, 'task');
    await writeFile(join(f.project, 'base.txt'), 'agent'); await writeFile(join(f.project, 'delete.txt'), 'agent too');
    const view = await f.store.seal(id, f.project, f.session);
    await writeFile(join(f.project, 'base.txt'), 'later user edit');
    await expect(f.store.apply(id, f.project, f.session, ['base.txt', 'delete.txt'], view.revision)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(f.project, 'delete.txt'), 'utf8')).toBe('agent too');
    await expect(f.store.apply(id, f.project, f.session, ['delete.txt'], 'stale')).rejects.toMatchObject({ status: 409 });
    await expect(f.store.view(id, f.project, randomUUID())).rejects.toMatchObject({ status: 403 });
    const current = await f.store.view(id, f.project, f.session);
    await f.store.apply(id, f.project, f.session, ['delete.txt'], current.revision);
    expect(await readFile(join(f.project, 'base.txt'), 'utf8')).toBe('later user edit');
  });
  it('refuses automatic rollback after the task stages files or HEAD moves', async () => {
    const f = await fixture(), id = await f.store.begin(f.project, f.session, 'task');
    await writeFile(join(f.project, 'base.txt'), 'agent'); await f.git(['add', 'base.txt']);
    const view = await f.store.seal(id, f.project, f.session);
    expect(view.reason).toContain('暂存区');
    await expect(f.store.apply(id, f.project, f.session, ['base.txt'], view.revision)).rejects.toMatchObject({ status: 409 });
    await f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'moved']);
    expect((await f.store.view(id, f.project, f.session)).reason).toContain('HEAD');
  });
  it('excludes credentials, ignored files and oversized content, and rejects traversal paths', async () => {
    const f = await fixture(); await writeFile(join(f.project, '.env'), 'do-not-store');
    await writeFile(join(f.project, 'large.bin'), Buffer.alloc(2_000_001));
    const id = await f.store.begin(f.project, f.session, 'task'); await writeFile(join(f.project, 'base.txt'), 'change');
    const view = await f.store.seal(id, f.project, f.session);
    expect(view.skipped).toBe(2);
    expect(await readFile(join(f.home, 'checkpoints', id, 'manifest.json'), 'utf8')).not.toContain('do-not-store');
    for (const path of ['../file', '.git/config', '.pi/settings.json', 'a/../../b', 'C:/outside', 'a\\b', '.env']) expect(safeCheckpointPath(path)).toBe(false);
    await expect(f.store.diff(id, f.project, f.session, '.env')).rejects.toMatchObject({ status: 404 });
  });
  it('does not follow a directory junction introduced after a task', async () => {
    const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'forge-checkpoint-outside-'));
    await mkdir(join(f.project, 'src')); await writeFile(join(f.project, 'src', 'a.txt'), 'before');
    const id = await f.store.begin(f.project, f.session, 'task'); await writeFile(join(f.project, 'src', 'a.txt'), 'after');
    const view = await f.store.seal(id, f.project, f.session);
    await rename(join(f.project, 'src'), join(f.project, 'old-src')); await writeFile(join(outside, 'a.txt'), 'after');
    await symlink(outside, join(f.project, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.store.apply(id, f.project, f.session, ['src/a.txt'], view.revision)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('after');
  });
  it('keeps unfinished and interrupted write journals unavailable for automatic replay', async () => {
    const f = await fixture(), id = await f.store.begin(f.project, f.session, 'task');
    expect((await f.store.view(id, f.project, f.session)).reason).toContain('未封存');
    await writeFile(join(f.project, 'base.txt'), 'after'); await f.store.seal(id, f.project, f.session);
    const path = join(f.home, 'checkpoints', id, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.status = 'applying'; await writeFile(path, JSON.stringify(manifest));
    const view = await new CheckpointStore(f.home).view(id, f.project, f.session);
    expect(view.reason).toContain('中断'); expect(view.files[0]?.eligible).toBe(false);
  });
  it('supports an unborn repository and file names that match object properties', async () => {
    const f = await fixture(), empty = await mkdtemp(join(tmpdir(), 'forge-unborn-checkpoint-'));
    await checkpointGit(empty, ['init']); const id = await f.store.begin(empty, f.session, 'first change');
    await writeFile(join(empty, 'constructor'), 'content'); const view = await f.store.seal(id, empty, f.session);
    expect(view.files[0]).toMatchObject({ path: 'constructor', operation: 'add', eligible: true });
    await f.store.apply(id, empty, f.session, ['constructor'], view.revision);
    await expect(readFile(join(empty, 'constructor'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('isolated writable subagent proposals', () => {
  it('seeds dirty work into a detached worktree and applies only reviewed conflict-free files', async () => {
    const f = await fixture(), worker = randomUUID(), worktrees = new WorkerWorktrees(f.home, f.store);
    await writeFile(join(f.project, 'base.txt'), 'user work\n'); await unlink(join(f.project, 'delete.txt'));
    const worktree = await worktrees.create(f.project, f.session, worker, 'worker change');
    expect(await readFile(join(worktree.path, 'base.txt'), 'utf8')).toBe('user work\n');
    await expect(readFile(join(worktree.path, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(worktree.path, 'base.txt'), 'worker edit\n'); await writeFile(join(worktree.path, 'new.txt'), 'new');
    expect(await readFile(join(f.project, 'base.txt'), 'utf8')).toBe('user work\n');
    const proposal = await f.store.seal(worktree.checkpoint, f.project, f.session, worktree.path);
    expect(proposal.files).toHaveLength(2);
    await writeFile(join(f.project, 'base.txt'), 'later edit');
    await expect(f.store.apply(proposal.id, f.project, f.session, ['base.txt', 'new.txt'], proposal.revision)).rejects.toMatchObject({ status: 409 });
    await f.store.apply(proposal.id, f.project, f.session, ['new.txt'], proposal.revision);
    expect(await readFile(join(f.project, 'new.txt'), 'utf8')).toBe('new');
    await worktrees.remove(f.project, f.session, worker);
    expect((await f.store.view(proposal.id, f.project, f.session)).files.find((file) => file.path === 'new.txt')?.applied).toBe(true);
  });
});
