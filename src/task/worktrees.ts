import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { checkpointGit, CheckpointStore } from './checkpoints.js';

/** Only Git worktrees in this home-owned namespace may be created/removed. */
export class WorkerWorktrees {
  constructor(private home: string, private checkpoints: CheckpointStore) {}
  async path(parentId: string, childId: string) {
    z.uuid().parse(parentId); z.uuid().parse(childId);
    await mkdir(join(this.home, 'worktrees'), { recursive: true });
    const root = await realpath(join(this.home, 'worktrees'));
    await mkdir(join(root, parentId), { recursive: true });
    const parent = await realpath(join(root, parentId)), rest = relative(root, parent);
    if (!rest || rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest)) throw new Error('子任务 worktree 路径无效');
    return join(parent, childId);
  }
  async create(project: string, parentId: string, childId: string, label: string) {
    const path = await this.path(parentId, childId);
    const checkpoint = await this.checkpoints.begin(project, parentId, label, 'proposal');
    await checkpointGit(project, ['worktree', 'add', '--detach', path, 'HEAD']);
    try { await this.checkpoints.seed(checkpoint, project, parentId, path); return { path, checkpoint }; }
    catch (error) { await checkpointGit(project, ['worktree', 'remove', '--force', path]).catch(() => {}); throw error; }
  }
  async remove(project: string, parentId: string, childId: string) {
    const path = await this.path(parentId, childId);
    const target = await realpath(path), info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || relative(path, target) !== '') throw new Error('worktree 路径已被替换，已拒绝递归清理');
    await checkpointGit(project, ['worktree', 'remove', '--force', path]);
  }
}
