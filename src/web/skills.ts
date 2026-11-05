import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DefaultPackageManager, loadSkills, SettingsManager, type PackageSource, type ResolvedResource, type ResourceDiagnostic } from '@earendil-works/pi-coding-agent';

type Scope = 'global' | 'project';
const MAX_CONTENT = 256 * 1024;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const posix = (value: string) => value.split(sep).join('/');
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const within = (child: string, parent: string) => { const rest = relative(parent, child); return rest === '' || rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest); };
const isPattern = (value: string) => /^[!+-]/.test(value) || /[*?]/.test(value);

export class SkillError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'SkillError'; }
}
export interface SkillView {
  id: string; name: string; description: string; filePath: string; scope: Scope; source: string;
  origin: string; enabled: boolean; effective: boolean; valid: boolean; manualOnly: boolean;
  diagnostics: ResourceDiagnostic[];
}
interface Catalog {
  project: string; projectTrusted: boolean; revision: string; skills: SkillView[];
  diagnostics: ResourceDiagnostic[]; paths: { global: string; project: string; shared: string };
  sources: Array<{ id: string; path: string; scope: Scope }>;
}

/** A settings adapter over Pi discovery. Listing never loads extensions or installs packages. */
export class SkillsControl {
  constructor(private readonly home: string) {}

  private async settings(project: string, trusted: boolean) {
    const manager = SettingsManager.create(project, this.home, { projectTrusted: trusted });
    await manager.reload();
    if (manager.drainErrors().length) throw new SkillError(500, '无法读取技能设置，请检查 settings.json 的格式与文件权限');
    return manager;
  }

  private revision(manager: SettingsManager) {
    const global = manager.getGlobalSettings(), project = manager.getProjectSettings();
    return hash([global.skills, global.packages, project.skills, project.packages, manager.isProjectTrusted()]);
  }

  private requireRevision(manager: SettingsManager, revision: unknown) {
    if (typeof revision !== 'string' || revision !== this.revision(manager)) throw new SkillError(409, '技能设置已变更，请刷新列表后重试');
  }

  private scope(value: unknown, trusted: boolean): Scope {
    if (value !== 'global' && value !== 'project') throw new SkillError(400, '请选择全局或当前项目');
    if (value === 'project' && !trusted) throw new SkillError(403, '请先信任当前项目，再修改项目技能');
    return value;
  }

  private async resolve(manager: SettingsManager, project: string) {
    const diagnostics: ResourceDiagnostic[] = [];
    const paths = await new DefaultPackageManager({ cwd: project, agentDir: this.home, settingsManager: manager }).resolve(async () => {
      diagnostics.push({ type: 'warning', message: '部分已配置资源包未安装，未在浏览时自动安装。请安装后刷新。' });
      return 'skip';
    });
    return { resources: paths.skills, diagnostics };
  }

  private id(resource: ResolvedResource) { return hash([resource.path, resource.metadata.scope, resource.metadata.source]); }

  private async catalog(manager: SettingsManager, project: string): Promise<Catalog & { resources: ResolvedResource[] }> {
    const { resources, diagnostics } = await this.resolve(manager, project);
    const skills: SkillView[] = [];
    const readable: ResolvedResource[] = [];
    for (const resource of resources) {
      let problem: string | undefined;
      try { const info = await stat(resource.path); if (!info.isFile() || info.size > MAX_CONTENT) problem = '技能文件必须是小于 256 KB 的普通文件'; }
      catch { problem = '技能文件不可读，请检查路径与权限'; }
      const loaded = problem ? { skills: [], diagnostics: [{ type: 'warning' as const, message: problem, path: resource.path }] } : loadSkills({ cwd: project, agentDir: this.home, skillPaths: [resource.path], includeDefaults: false });
      const skill = loaded.skills[0];
      diagnostics.push(...loaded.diagnostics);
      if (skill && resource.enabled) readable.push(resource);
      skills.push({ id: this.id(resource), name: skill?.name ?? (basename(resource.path) === 'SKILL.md' ? basename(dirname(resource.path)) : basename(resource.path)),
        description: skill?.description ?? '技能格式无效，查看诊断后修正文件。', filePath: resource.path,
        scope: resource.metadata.scope === 'project' ? 'project' : 'global', source: resource.metadata.source, origin: resource.metadata.origin,
        enabled: resource.enabled, effective: false, valid: Boolean(skill), manualOnly: skill?.disableModelInvocation ?? false, diagnostics: loaded.diagnostics });
    }
    // Pi decides name collisions and symlink duplicates, exactly as it does for a session.
    const active = loadSkills({ cwd: project, agentDir: this.home, skillPaths: readable.map((resource) => resource.path), includeDefaults: false });
    const winners = new Set(active.skills.map((skill) => skill.filePath));
    diagnostics.push(...active.diagnostics.filter((item) => item.type === 'collision'));
    for (const skill of skills) skill.effective = skill.enabled && winners.has(skill.filePath);
    const sources = (['global', 'project'] as const).flatMap((scope) => {
      const settings = scope === 'global' ? manager.getGlobalSettings() : manager.getProjectSettings();
      return (settings.skills ?? []).filter((path) => !isPattern(path)).map((path) => ({ id: hash([scope, path]), path, scope }));
    });
    return { project, projectTrusted: manager.isProjectTrusted(), revision: this.revision(manager), skills, diagnostics,
      paths: { global: join(this.home, 'skills'), project: join(project, '.pi', 'skills'), shared: join(process.env['HOME'] || homedir(), '.agents', 'skills') }, sources, resources };
  }

  async snapshot(project: string, trusted: boolean): Promise<Catalog> {
    const { resources: _resources, ...catalog } = await this.catalog(await this.settings(project, trusted), project);
    return catalog;
  }

  async content(project: string, trusted: boolean, id: unknown) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new SkillError(400, '无效的技能标识');
    const { resources } = await this.catalog(await this.settings(project, trusted), project);
    const resource = resources.find((item) => this.id(item) === id);
    if (!resource) throw new SkillError(404, '技能已移除或当前项目无权访问，请刷新列表');
    const path = await realpath(resource.path).catch(() => { throw new SkillError(404, '技能文件已不存在'); });
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CONTENT) throw new SkillError(413, '技能内容超过 256 KB，或不是普通文件');
      const buffer = Buffer.alloc(MAX_CONTENT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CONTENT) throw new SkillError(413, '技能内容超过 256 KB');
      if (!samePath(path, await realpath(resource.path))) throw new SkillError(409, '技能路径已变更，请刷新后重试');
      return { content: buffer.subarray(0, bytesRead).toString('utf8'), filePath: resource.path };
    } finally { await file.close(); }
  }

  private async save(manager: SettingsManager) {
    await manager.flush();
    if (manager.drainErrors().length) throw new SkillError(500, '技能设置保存失败，请检查文件权限');
  }

  private setPaths(manager: SettingsManager, scope: Scope, paths: string[]) {
    if (scope === 'global') manager.setSkillPaths(paths); else manager.setProjectSkillPaths(paths);
  }

  private withoutExactRules(paths: string[], target: string, base: string) {
    return paths.filter((entry) => {
      if (!/^[+-]/.test(entry)) return true;
      const value = entry.slice(1), expanded = value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? join(process.env['HOME'] || homedir(), value.slice(2)) : resolve(base, value);
      return !samePath(expanded, target) && !(basename(target) === 'SKILL.md' && samePath(expanded, dirname(target)));
    });
  }

  async toggle(project: string, trusted: boolean, input: Record<string, unknown>) {
    if (typeof input['enabled'] !== 'boolean') throw new SkillError(400, 'enabled 必须是布尔值');
    const manager = await this.settings(project, trusted); this.requireRevision(manager, input['revision']);
    const catalog = await this.catalog(manager, project);
    const resource = catalog.resources.find((item) => this.id(item) === input['id']);
    if (!resource) throw new SkillError(404, '未找到技能，请刷新列表');
    const scope = this.scope(resource.metadata.scope === 'project' ? 'project' : 'global', trusted);
    if (input['scope'] !== scope) throw new SkillError(400, '技能配置范围不匹配，请刷新列表');
    const settings = scope === 'global' ? manager.getGlobalSettings() : manager.getProjectSettings();
    const enabled = input['enabled'];
    if (resource.metadata.origin === 'package') {
      const packages: PackageSource[] = [...settings.packages ?? []];
      const index = packages.findIndex((pkg) => (typeof pkg === 'string' ? pkg : pkg.source) === resource.metadata.source);
      if (index < 0 || !resource.metadata.baseDir) throw new SkillError(409, '资源包配置已变更，请刷新列表');
      const pkg = packages[index]!, config = typeof pkg === 'string' ? { source: pkg } : { ...pkg };
      let patterns = this.withoutExactRules(config.skills ?? [], resource.path, resource.metadata.baseDir);
      // [] means no package skills; preserve that baseline when enabling just one.
      if (config.skills?.length === 0 && enabled && config.autoload !== false) patterns = ['!*'];
      config.skills = [...patterns, (enabled ? '+' : '-') + posix(relative(resource.metadata.baseDir, resource.path))];
      packages[index] = config;
      if (scope === 'global') manager.setPackages(packages); else manager.setProjectPackages(packages);
    } else {
      const base = scope === 'global' ? this.home : join(project, '.pi');
      this.setPaths(manager, scope, [...this.withoutExactRules(settings.skills ?? [], resource.path, base), (enabled ? '+' : '-') + posix(resource.path)]);
    }
    await this.save(manager);
    return { scope };
  }

  async addSource(project: string, trusted: boolean, input: Record<string, unknown>) {
    const scope = this.scope(input['scope'], trusted);
    if (typeof input['path'] !== 'string' || !input['path'].trim() || input['path'].length > 4096 || /[\0\r\n*?]/.test(input['path']) || /^[!+-]|^[a-z]+:\/\//i.test(input['path'].trim())) throw new SkillError(400, '请输入本机技能目录或 Markdown 文件路径');
    const value = input['path'].trim();
    const expanded = value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? join(process.env['HOME'] || homedir(), value.slice(2)) : resolve(project, value);
    const path = await realpath(expanded).catch(() => { throw new SkillError(400, '本机路径不存在'); });
    if (!trusted && within(path, await realpath(project))) throw new SkillError(403, '请先信任当前项目，再导入其中的技能');
    const info = await stat(path);
    if (!info.isDirectory() && (!info.isFile() || !path.toLowerCase().endsWith('.md') || info.size > MAX_CONTENT)) throw new SkillError(400, '请选择技能目录或小于 256 KB 的 Markdown 文件');
    const loaded = loadSkills({ cwd: project, agentDir: this.home, skillPaths: [path], includeDefaults: false });
    if (!loaded.skills.length) throw new SkillError(400, '这个路径中没有有效技能，请检查 SKILL.md 的 name 和 description');
    const manager = await this.settings(project, trusted); this.requireRevision(manager, input['revision']);
    const settings = scope === 'global' ? manager.getGlobalSettings() : manager.getProjectSettings();
    const paths = settings.skills ?? [];
    const base = scope === 'global' ? this.home : join(project, '.pi');
    if (!paths.some((entry) => !isPattern(entry) && samePath(resolve(base, entry), path))) this.setPaths(manager, scope, [...paths, posix(path)]);
    await this.save(manager); return { scope };
  }

  async removeSource(project: string, trusted: boolean, input: Record<string, unknown>) {
    const scope = this.scope(input['scope'], trusted), manager = await this.settings(project, trusted);
    this.requireRevision(manager, input['revision']);
    const settings = scope === 'global' ? manager.getGlobalSettings() : manager.getProjectSettings();
    const paths = settings.skills ?? [], retained = paths.filter((path) => isPattern(path) || hash([scope, path]) !== input['id']);
    if (retained.length === paths.length) throw new SkillError(404, '技能目录已移除，请刷新列表');
    this.setPaths(manager, scope, retained); await this.save(manager);
    return { scope };
  }
}
