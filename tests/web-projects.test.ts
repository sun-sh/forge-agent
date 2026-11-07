import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { WebProjects } from '../src/web/projects.js';

const temporary: string[] = [];
async function fixture() { const path = await mkdtemp(join(tmpdir(), 'forge-projects-')); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Forge Web workspace registry', () => {
  it('starts empty without registering cwd or allocating project folders', async () => {
    const home = await fixture();
    const projects = await WebProjects.open(home);
    expect(await projects.list()).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it('creates independent, durable managed projects with safe names and idempotent retries', async () => {
    const home = await fixture(), projects = await WebProjects.open(home);
    const [first, repeated, second] = await Promise.all([
      projects.create('../../CON:< hello', 'request-a'), projects.create('retry', 'request-a'), projects.create('../../CON:< hello', 'request-b')
    ]);
    expect(first.path).toBe(repeated.path);
    expect(first.path).not.toBe(second.path);
    expect(first.kind).toBe('managed');
    expect(relative(await realpath(home), first.path).split(sep)).toHaveLength(2);
    expect(await stat(first.path).then((info) => info.isDirectory())).toBe(true);
    expect(await readdir(first.path)).toEqual([]); // No fabricated Pi trust or resource files.
    expect((await projects.list())).toHaveLength(2);
    const restored = await WebProjects.open(home);
    expect(await restored.list()).toEqual(await projects.list());
    expect((await restored.create('later retry', 'request-a')).path).toBe(first.path);
    expect((await readdir(join(home, 'web'))).filter((path) => path.endsWith('.tmp'))).toEqual([]);
  });

  it('registers external folders in place and deduplicates filesystem aliases', async () => {
    const home = await fixture(), external = await fixture(), projects = await WebProjects.open(home);
    await writeFile(join(external, 'keep.txt'), 'untouched');
    const first = await projects.register(external);
    const alias = join(home, 'external-alias');
    try { await symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    expect((await projects.register(alias)).path).toBe(first.path);
    expect(first).toMatchObject({ kind: 'external', path: await realpath(external) });
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(await projects.list()).toHaveLength(1);
    expect((await WebProjects.open(home)).managedRoot).toBe(join(home, 'projects'));
  });

  it('reports missing external folders without losing registry history', async () => {
    const home = await fixture(), external = await fixture(), projects = await WebProjects.open(home);
    await projects.register(external);
    await rm(external, { recursive: true });
    expect(await (await WebProjects.open(home)).list()).toMatchObject([{ available: false, kind: 'external' }]);
    await expect(projects.register(external)).rejects.toThrow('不存在');
  });

  it('durably removes projects from discovery and restores managed metadata on explicit reopen', async () => {
    const home = await fixture(), projects = await WebProjects.open(home);
    const managed = await projects.create('My project', 'original-request');
    await writeFile(join(managed.path, 'keep.txt'), 'source must stay');
    await projects.remove(managed.path);
    expect(await projects.list()).toEqual([]);
    expect(await projects.visible([{ path: managed.path, sessions: ['saved-session'] }])).toEqual([]);
    expect(await readFile(join(managed.path, 'keep.txt'), 'utf8')).toBe('source must stay');
    const restored = await WebProjects.open(home);
    expect(await restored.list()).toEqual([]);
    expect(await restored.removed()).toEqual([managed.path]);
    const next = await restored.create('New first message', 'original-request');
    expect(next.path).not.toBe(managed.path); // An old request retry must not reopen a removed project.
    expect(await restored.register(managed.path)).toEqual(managed);
    expect(await restored.removed()).toEqual([]);
    expect(await restored.visible([{ path: managed.path, sessions: ['saved-session'] }])).toHaveLength(1);
    expect(await (await WebProjects.open(home)).list()).toHaveLength(2);
  });

  it('removes legacy history-only projects and filesystem aliases without deleting a workspace', async () => {
    const home = await fixture(), external = await fixture(), projects = await WebProjects.open(home);
    await writeFile(join(external, 'keep.txt'), 'untouched');
    await projects.remove(external); // A project discovered only from Pi history has no registry row yet.
    expect(await projects.visible([{ path: external }])).toEqual([]);
    const alias = join(home, 'history-alias');
    try { await symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    expect(await projects.visible([{ path: alias }])).toEqual([]);
    await projects.remove(alias);
    expect(await projects.removed()).toHaveLength(1);
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('untouched');
    await projects.register(alias);
    expect(await projects.removed()).toEqual([]);
    expect(await projects.list()).toHaveLength(1);
    await expect(projects.remove('../relative')).rejects.toThrow('完整');
  });

  it('rejects invalid input before filesystem changes and preserves a corrupt index', async () => {
    const home = await fixture(), projects = await WebProjects.open(home);
    await expect(projects.create('bad\nname')).rejects.toThrow('项目名称');
    await expect(projects.create('ok', '../bad')).rejects.toThrow('标识');
    expect(await readdir(home)).toEqual([]);
    await mkdir(join(home, 'web'));
    await writeFile(join(home, 'web', 'projects.json'), '{broken');
    await expect(WebProjects.open(home)).rejects.toThrow('原文件已保留');
    expect(await readFile(join(home, 'web', 'projects.json'), 'utf8')).toBe('{broken');
  });

  it('refuses a managed project directory redirected outside the Forge home', async () => {
    const home = await fixture(), external = await fixture(), projects = await WebProjects.open(home);
    try { await symlink(external, join(home, 'projects'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    await expect(projects.create('must stay local')).rejects.toThrow('不能指向外部');
    expect(await readdir(external)).toEqual([]);
    expect(await projects.list()).toEqual([]);
  });

  it('does not reuse an automatic project redirected after its original creation', async () => {
    const home = await fixture(), external = await fixture(), projects = await WebProjects.open(home);
    const original = await projects.create('first message', 'retry-request');
    await rm(original.path, { recursive: true });
    try { await symlink(external, original.path, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    await expect(projects.create('retry', 'retry-request')).rejects.toThrow('重定向');
    expect(await readdir(external)).toEqual([]);
    expect((await projects.list())).toHaveLength(1);
  });
});
