import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureGit, compareGit, readGitDiff } from '../src/task/git.js';
const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pforge-git-'));
  const git = (args: string[]) => exec('git', args, { cwd: root, windowsHide: true });
  await git(['init']); await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(root, 'base.txt'), 'before\n'); await git(['add', '.']); await git(['commit', '-m', 'fixture']);
  return { root, git };
}
describe('Git task evidence', () => {
  it('distinguishes existing dirty work and new observed changes, and previews staged/unstaged/untracked files', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'base.txt'), 'existing user work\n');
    const baseline = await captureGit(f.root);
    await f.git(['add', 'base.txt']); await writeFile(join(f.root, 'base.txt'), 'later change\n');
    await writeFile(join(f.root, 'new & name.txt'), 'new\n');
    const changes = await compareGit(f.root, baseline);
    expect(changes.files.find((file) => file.path === 'base.txt')).toMatchObject({ preexisting: true, observed: true });
    expect(changes.files.find((file) => file.path === 'new & name.txt')).toMatchObject({ preexisting: false, observed: true });
    const diff = await readGitDiff(f.root, 'base.txt'); expect(diff.diff).toContain('existing user work'); expect(diff.diff).toContain('later change');
    expect((await readGitDiff(f.root, 'new & name.txt')).diff).toContain('+new');
  });
  it('supports unborn repositories and reports non-Git directories honestly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pforge-unborn-'));
    expect((await captureGit(root)).available).toBe(false);
    await exec('git', ['init'], { cwd: root }); await writeFile(join(root, 'new.txt'), 'new');
    expect(await captureGit(root)).toMatchObject({ available: true, files: [{ path: 'new.txt' }] });
    expect((await readGitDiff(root, 'new.txt')).diff).toContain('+new');
  });
  it('does not expose sensitive files, path traversal or an external directory junction', async () => {
    const f = await fixture(); await writeFile(join(f.root, '.env.local'), 'TOKEN=do-not-preview');
    expect((await readGitDiff(f.root, '.env.local')).diff).not.toContain('do-not-preview');
    for (const path of ['../outside', '.git/config', join(tmpdir(), 'absolute'), 'base.txt\0bad']) await expect(readGitDiff(f.root, path)).rejects.toThrow();
    const outside = await mkdtemp(join(tmpdir(), 'pforge-git-outside-')); await writeFile(join(outside, 'secret.txt'), 'outside-content');
    await symlink(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readGitDiff(f.root, 'linked/secret.txt')).rejects.toThrow();
    const inner = join(f.root, 'nested'); await mkdir(inner); expect((await captureGit(inner)).available).toBe(false);
  });
  it('blocks diff previews for both current and legacy local data directories', async () => {
    const f = await fixture();
    for (const directory of ['.forge-agent', '.pforge']) {
      await mkdir(join(f.root, directory));
      const path = directory + '/local-data.txt';
      await writeFile(join(f.root, path), 'local-session-content');
      expect((await readGitDiff(f.root, path)).diff).not.toContain('local-session-content');
    }
  });
});
