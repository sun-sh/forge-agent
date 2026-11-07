import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { directoryKey } from '../project-identity.js';

const projectSchema = z.object({
  path: z.string().min(1).refine(isAbsolute), name: z.string().min(1).max(120),
  kind: z.enum(['managed', 'external']), createdAt: z.string().datetime(),
  requestId: z.string().min(1).max(100).optional()
}).strict();
const projectPathSchema = z.string().min(1).refine(isAbsolute);
const registrySchema = z.object({ version: z.literal(1), projects: z.array(projectSchema), removedPaths: z.array(projectPathSchema).default([]) }).strict();
export type WebProject = z.infer<typeof projectSchema>;
export class ProjectError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ProjectError'; }
}

/** Workspace discovery only. Pi remains the owner of session storage and trust. */
export class WebProjects {
  readonly managedRoot: string;
  private readonly file: string;
  private projects: WebProject[] = [];
  private removedPaths: string[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private readonly home: string) {
    this.managedRoot = join(resolve(home), 'projects');
    this.file = join(home, 'web', 'projects.json');
  }
  static async open(home: string): Promise<WebProjects> {
    const registry = new WebProjects(home);
    let raw: string;
    try { raw = await readFile(registry.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registry; throw error; }
    try { const data = registrySchema.parse(JSON.parse(raw)); registry.projects = data.projects; registry.removedPaths = data.removedPaths; }
    catch { throw new ProjectError(409, '项目索引无法读取，请先修复 web/projects.json；原文件已保留'); }
    return registry;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
  private async persist(projects: WebProject[], removedPaths = this.removedPaths) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, projects, removedPaths }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
      this.projects = projects;
      this.removedPaths = removedPaths;
    } finally { await rm(temporary, { force: true }); }
  }
  async list() {
    await this.pending;
    const removed = new Set(this.removedPaths.map(directoryKey));
    return Promise.all(this.projects.filter((project) => !removed.has(directoryKey(project.path))).map(async (project) => {
      const available = await stat(project.path).then((info) => info.isDirectory(), () => false);
      const { requestId: _requestId, ...view } = project;
      return { ...view, available };
    }));
  }
  /** Filter discovery without touching Pi sessions or files in the workspace. */
  async visible<T extends { path: string }>(items: T[]): Promise<T[]> {
    await this.pending;
    const removed = new Set(this.removedPaths.map(directoryKey));
    const paths = await Promise.all(items.map((item) => realpath(item.path).catch(() => resolve(item.path))));
    return items.filter((_item, index) => !removed.has(directoryKey(paths[index]!)));
  }
  async removed(): Promise<string[]> { await this.pending; return [...this.removedPaths]; }
  async remove(path: string): Promise<string> {
    if (!projectPathSchema.safeParse(path).success) throw new ProjectError(400, '请指定完整的项目路径');
    return this.serialize(async () => {
      const canonical = await realpath(path).catch(() => resolve(path));
      const key = directoryKey(canonical);
      const removed = this.removedPaths.filter((item) => directoryKey(item) !== key);
      await this.persist(this.projects, [...removed, canonical]);
      return canonical;
    });
  }
  async register(path: string): Promise<WebProject> {
    return this.serialize(async () => {
      let canonical: string;
      try { canonical = await realpath(resolve(path)); if (!(await stat(canonical)).isDirectory()) throw new Error(); }
      catch { throw new ProjectError(400, '文件夹不存在或无法访问，请选择本机已有的文件夹'); }
      const existing = this.projects.find((item) => directoryKey(item.path) === directoryKey(canonical));
      const removed = this.removedPaths.filter((item) => directoryKey(item) !== directoryKey(canonical));
      if (existing) {
        if (removed.length !== this.removedPaths.length) await this.persist(this.projects, removed);
        return { ...existing };
      }
      const project: WebProject = { path: canonical, name: basename(canonical) || canonical, kind: 'external', createdAt: new Date().toISOString() };
      await this.persist([...this.projects, project], removed);
      return { ...project };
    });
  }
  async create(name = '新项目', requestId?: string): Promise<WebProject> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f]/.test(name)) throw new ProjectError(400, '项目名称应为 1–120 个可显示字符');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))) throw new ProjectError(400, '项目创建标识无效');
    return this.serialize(async () => {
      const existing = requestId && this.projects.find((item) => item.requestId === requestId && item.kind === 'managed' && !this.removedPaths.some((path) => directoryKey(path) === directoryKey(item.path)));
      await mkdir(this.home, { recursive: true });
      await mkdir(this.managedRoot, { recursive: true });
      const rootInfo = await lstat(this.managedRoot);
      const canonicalHome = await realpath(this.home);
      const canonicalRoot = await realpath(this.managedRoot);
      const rest = relative(canonicalHome, canonicalRoot);
      if (rootInfo.isSymbolicLink() || !rest || rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest)) throw new ProjectError(409, '项目存储目录必须位于 Forge 数据目录内，不能指向外部位置');
      if (existing) {
        let available = false;
        try {
          const info = await lstat(existing.path);
          const canonical = await realpath(existing.path);
          available = info.isDirectory() && !info.isSymbolicLink() && directoryKey(dirname(canonical)) === directoryKey(canonicalRoot);
        } catch { /* A removed or redirected project must be selected again explicitly. */ }
        if (!available) throw new ProjectError(409, '自动创建的项目目录已移动或重定向，请重新选择项目');
        return { ...existing };
      }
      const title = name.trim();
      const slug = title.replace(/[<>:"/\\|?*\s.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'new';
      const path = join(canonicalRoot, 'project-' + slug + '-' + randomUUID().slice(0, 8));
      await mkdir(path); // Exclusive: never reuse or overwrite an existing folder.
      const project: WebProject = { path, name: title, kind: 'managed', createdAt: new Date().toISOString(), ...(requestId ? { requestId } : {}) };
      // If persistence fails, preserve the empty directory for recovery rather than deleting user files.
      await this.persist([...this.projects, project]);
      return { ...project };
    });
  }
}
