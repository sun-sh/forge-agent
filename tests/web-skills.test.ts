import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent';
import { SkillsControl } from '../src/web/skills.js';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forge-skills-'));
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(join(project, '.pi'), { recursive: true }); await mkdir(join(project, '.git')); await mkdir(home);
  return { project, home, control: new SkillsControl(home) };
}
async function skill(root: string, name: string, extra = '', body = 'Review local changes.') {
  const file = join(root, name, 'SKILL.md'); await mkdir(join(root, name), { recursive: true });
  await writeFile(file, '---\nname: ' + name + '\ndescription: Review local changes\n' + extra + '---\n' + body);
  return file;
}

describe('Pi skill settings adapter', () => {
  it('uses Pi discovery and collision resolution without loading extensions or installing missing packages', async () => {
    const { home, project, control } = await fixture();
    await skill(join(home, 'skills'), 'review');
    await skill(join(project, '.pi', 'skills'), 'review', 'disable-model-invocation: true\n');
    const marker = join(project, 'extension-ran');
    await mkdir(join(project, '.pi', 'extensions'));
    await writeFile(join(project, '.pi', 'extensions', 'unsafe.js'), 'import {writeFileSync} from "node:fs";writeFileSync(' + JSON.stringify(marker) + ',"executed");export default () => {};');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ packages: ['git:github.com/example/not-installed-forge-skills'] }));
    const install = vi.spyOn(DefaultPackageManager.prototype, 'install');
    const untrusted = await control.snapshot(project, false);
    expect(untrusted.skills.some((item) => item.scope === 'project')).toBe(false);
    expect(untrusted.skills.find((item) => item.name === 'review')).toMatchObject({ scope: 'global', effective: true });
    const catalog = await control.snapshot(project, true);
    expect(catalog.skills.find((item) => item.name === 'review' && item.scope === 'project')).toMatchObject({ effective: true, enabled: true, manualOnly: true });
    expect(catalog.skills.find((item) => item.name === 'review' && item.scope === 'global')).toMatchObject({ effective: false, enabled: true });
    expect(catalog.diagnostics.some((item) => item.type === 'collision')).toBe(true);
    expect(catalog.diagnostics.some((item) => item.message.includes('未安装'))).toBe(true);
    expect(install).not.toHaveBeenCalled(); await expect(access(marker)).rejects.toThrow();
  });

  it('persists exact Pi exclusions in the owning scope and restores the inherited name after disabling an override', async () => {
    const { home, project, control } = await fixture();
    const globalFile = await skill(join(home, 'skills'), 'review');
    const projectFile = await skill(join(project, '.pi', 'skills'), 'review');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ defaultProvider: 'keep', skills: ['!**/optional/**'] }));
    let catalog = await control.snapshot(project, true);
    const target = catalog.skills.find((item) => item.filePath === projectFile)!;
    await control.toggle(project, true, { id: target.id, enabled: false, scope: 'project', revision: catalog.revision });
    catalog = await new SkillsControl(home).snapshot(project, true);
    expect(catalog.skills.find((item) => item.filePath === projectFile)).toMatchObject({ enabled: false, effective: false });
    expect(catalog.skills.find((item) => item.filePath === globalFile)).toMatchObject({ enabled: true, effective: true });
    const saved = JSON.parse(await readFile(join(project, '.pi', 'settings.json'), 'utf8'));
    expect(saved.skills).toContain('-' + projectFile.replaceAll('\\', '/'));
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toMatchObject({ defaultProvider: 'keep', skills: ['!**/optional/**'] });
    await control.toggle(project, true, { id: target.id, enabled: true, scope: 'project', revision: catalog.revision });
    expect((await control.snapshot(project, true)).skills.find((item) => item.filePath === projectFile)).toMatchObject({ effective: true });
  });

  it('enables only the selected skill when a Pi package has an empty skill allowlist', async () => {
    const { home, project, control } = await fixture();
    const pkg = join(home, 'test-package');
    const first = await skill(join(pkg, 'skills'), 'first'), second = await skill(join(pkg, 'skills'), 'second');
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', pi: { skills: ['skills'], extensions: ['extension.js'], prompts: ['prompts'] } }));
    await writeFile(join(home, 'settings.json'), JSON.stringify({ packages: [{ source: pkg, skills: [], extensions: [], prompts: [] }] }));
    let catalog = await control.snapshot(project, true);
    const target = catalog.skills.find((item) => item.filePath === first)!;
    expect(target).toMatchObject({ origin: 'package', enabled: false });
    await control.toggle(project, true, { id: target.id, enabled: true, scope: 'global', revision: catalog.revision });
    catalog = await control.snapshot(project, true);
    expect(catalog.skills.find((item) => item.filePath === first)).toMatchObject({ enabled: true, effective: true });
    expect(catalog.skills.find((item) => item.filePath === second)).toMatchObject({ enabled: false });
    const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    expect(settings.packages[0]).toMatchObject({ extensions: [], prompts: [], skills: ['!*', '+skills/first/SKILL.md'] });
  });

  it('imports and removes native path references, preserving files and unrelated settings', async () => {
    const { home, project, control } = await fixture();
    const source = join(home, 'extra'); const file = await skill(source, 'imported');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ defaultModel: 'keep-model' }));
    let catalog = await control.snapshot(project, true);
    await control.addSource(project, true, { path: source, scope: 'global', revision: catalog.revision });
    catalog = await control.snapshot(project, true);
    expect(catalog.skills.find((item) => item.name === 'imported')).toMatchObject({ source: 'local', effective: true });
    expect(catalog.sources).toHaveLength(1);
    const imported = catalog.sources[0]!;
    await control.removeSource(project, true, { id: imported.id, scope: imported.scope, revision: catalog.revision });
    expect((await control.snapshot(project, true)).skills.some((item) => item.name === 'imported')).toBe(false);
    await expect(access(file)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toMatchObject({ defaultModel: 'keep-model', skills: [] });
  });

  it('rejects stale revisions, mismatched scopes and project writes/imports before trust', async () => {
    const { home, project, control } = await fixture();
    await skill(join(project, '.pi', 'skills'), 'project-review'); await skill(join(home, 'skills'), 'global-review');
    let catalog = await control.snapshot(project, true);
    const projectSkill = catalog.skills.find((item) => item.name === 'project-review')!, globalSkill = catalog.skills.find((item) => item.name === 'global-review')!;
    await expect(control.toggle(project, true, { id: globalSkill.id, scope: 'project', enabled: false, revision: catalog.revision })).rejects.toMatchObject({ status: 400 });
    await expect(control.toggle(project, false, { id: projectSkill.id, scope: 'project', enabled: false, revision: catalog.revision })).rejects.toBeTruthy();
    await expect(control.addSource(project, false, { path: project, scope: 'project', revision: catalog.revision })).rejects.toMatchObject({ status: 403 });
    await expect(control.addSource(project, false, { path: join(project, '.pi', 'skills'), scope: 'global', revision: catalog.revision })).rejects.toMatchObject({ status: 403 });
    await control.toggle(project, true, { id: globalSkill.id, scope: 'global', enabled: false, revision: catalog.revision });
    await expect(control.toggle(project, true, { id: globalSkill.id, scope: 'global', enabled: true, revision: catalog.revision })).rejects.toMatchObject({ status: 409 });
    catalog = await control.snapshot(project, true);
    expect(catalog.skills.find((item) => item.id === globalSkill.id)?.enabled).toBe(false);
    await expect(access(join(project, '.pi', 'settings.json'))).rejects.toThrow();
  });

  it('only previews discovered skill IDs, bounds file content and reports malformed skills', async () => {
    const { home, project, control } = await fixture();
    const file = await skill(join(home, 'skills'), 'preview', '', '<script>not executable</script>');
    const privateFile = join(home, 'private.txt'); await writeFile(privateFile, 'not-a-skill');
    await mkdir(join(home, 'skills', 'broken')); await writeFile(join(home, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nmissing description');
    const catalog = await control.snapshot(project, true), target = catalog.skills.find((item) => item.filePath === file)!;
    expect(await control.content(project, true, target.id)).toMatchObject({ content: expect.stringContaining('<script>not executable</script>') });
    expect(catalog.skills.find((item) => item.name === 'broken')).toMatchObject({ valid: false, effective: false });
    await expect(control.content(project, true, privateFile)).rejects.toMatchObject({ status: 400 });
    await expect(control.content(project, true, 'a'.repeat(64))).rejects.toMatchObject({ status: 404 });
    await writeFile(file, 'x'.repeat(256 * 1024 + 1));
    await expect(control.content(project, true, target.id)).rejects.toMatchObject({ status: 413 });
  });
});
