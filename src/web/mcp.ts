import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  CONFIG_DIR_NAME, createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionUIContext, type McpServerConfig, type McpServerEntry, type ModelRuntime
} from '@earendil-works/pi-coding-agent';
import { McpRuntimeView, type McpToolView } from './mcp-runtime.js';

type RecordValue = Record<string, unknown>;
export type McpScope = 'global' | 'project';
export class McpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'McpError'; }
}
interface ConfigFile { path: string; source?: string; value: RecordValue; servers: RecordValue; }
interface Entry extends McpServerEntry { scope: McpScope; raw: RecordValue; revision: string; active: boolean; overridesGlobal: boolean; inactiveReason?: 'untrusted' | 'conflict' | 'overridden'; }
export interface McpProbeResult {
  status: 'connected' | 'failed' | 'needs-auth' | 'timeout';
  checkedAt: string;
  latencyMs: number;
  tools: Array<{ name: string; description: string; rawName?: string; exposure?: string }>;
  message?: string;
}
export interface McpInput {
  project: string;
  scope: McpScope;
  name: string;
  config?: unknown;
  revision?: unknown;
}
export interface McpSaveInput extends McpInput { config: unknown; override?: boolean; }
export interface McpAuthView {
  id: string; project: string; scope: McpScope; name: string;
  state: 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  startedAt: string; expiresAt: string; authorizationUrl?: string; message?: string; action: 'login' | 'logout';
}
interface AuthJob { view: McpAuthView; abort: AbortController; done: Promise<void>; redirect?: (value: string | undefined) => void; }

const MAX_CONFIG_BYTES = 2_000_000;
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const namespace = (name: string) => name.replaceAll('-', '_');
const partial = (value: RecordValue) => value['command'] === undefined && value['url'] === undefined && value['type'] === undefined;
function serverName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new McpError(400, '服务名称只能包含 1 至 80 个字母、数字、下划线或连字符');
  return value;
}
function requireScope(value: unknown): asserts value is McpScope {
  if (value !== 'global' && value !== 'project') throw new McpError(400, '配置范围必须为 global 或 project');
}
function assertRevision(value: unknown, previous: unknown) {
  if (previous !== undefined ? value !== revision(previous) : value !== undefined) throw new McpError(409, '服务配置已存在或已被其他窗口修改，请刷新后重新编辑');
}
async function sourceAt(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new McpError(500, '无法读取 MCP 配置，请检查本机文件权限'); }
}
async function readConfig(path: string): Promise<ConfigFile> {
  const source = await sourceAt(path);
  if (source === undefined) return { path, value: {}, servers: {} };
  let parsed: unknown;
  try { parsed = source.length <= MAX_CONFIG_BYTES ? JSON.parse(source.replace(/^\uFEFF/, '')) : undefined; }
  catch { /* JSON parser messages may contain credential snippets. */ }
  if (!object(parsed) || (parsed['mcpServers'] !== undefined && !object(parsed['mcpServers']))) throw new McpError(409, 'MCP 配置文件格式无效；请修复 mcp.json，原文件未被覆盖');
  return { path, source, value: parsed, servers: object(parsed['mcpServers']) ? parsed['mcpServers'] : {} };
}

/** Pi validates through its public extension API; no deep imports or copied protocol logic. */
async function validateWithPi(project: string, home: string, values: Array<{ name: string; value: unknown }>) {
  const valid = new Map<string, McpServerConfig>(), errors = new Map<string, string>();
  let api: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd: project, agentDir: home, settingsManager: SettingsManager.create(project, home, { projectTrusted: false }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'forge-mcp-validation', factory: (pi) => {
      api = pi;
      for (const { name, value } of values) {
        try {
          serverName(name);
          if (!object(value)) throw new McpError(400, '服务配置必须是对象');
          if (typeof value['command'] === 'string' && !value['command'].trim()) throw new McpError(400, '启动命令不能为空');
          pi.registerMcpServer(name, value as unknown as McpServerConfig);
        } catch (error) {
          const message = error instanceof Error ? error.message.replace(/^Invalid MCP server registered by extension "[^"]+": /, '') : 'MCP 配置校验失败';
          errors.set(name, redact(message, object(value) ? value : {}));
        }
      }
    } }]
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new McpError(500, '无法运行 Pi MCP 配置校验');
  // Registrations commit after the extension factory returns.
  for (const entry of api?.getMcpServers() ?? []) {
    valid.set(entry.name, entry.config);
    api!.unregisterMcpServer(entry.name);
  }
  return { valid, errors };
}
function secrets(config: RecordValue): string[] {
  const result: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value !== 'string') return;
    result.push(value);
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const resolved = process.env[match[1]!]; if (resolved) result.push(resolved);
    }
  };
  for (const key of ['env', 'headers']) if (object(config[key])) Object.values(config[key]).forEach(collect);
  if (object(config['oauth'])) collect(config['oauth']['clientSecret']);
  return result.filter(Boolean).sort((a, b) => b.length - a.length);
}
function redact(message: string, config: RecordValue) {
  for (const secret of secrets(config)) message = message.split(secret).join('[redacted]');
  return message.replace(/\b(Bearer\s+)[^\s,;]+/ig, '$1[redacted]').slice(0, 2000);
}
function viewConfig(entry: Entry) {
  const config = structuredClone(entry.config) as unknown as RecordValue;
  for (const key of ['env', 'headers']) if (object(config[key])) config[key] = Object.keys(config[key]).map((key) => ({ key, configured: true }));
  if (object(config['oauth'])) {
    if (config['oauth']['clientSecret'] !== undefined) config['oauth']['clientSecretConfigured'] = true;
    delete config['oauth']['clientSecret'];
  }
  const fields = ['command', 'args', 'cwd', 'url', 'env', 'headers', 'oauth', 'auth', 'description', 'timeout', 'toolExposure'];
  const result: RecordValue = { type: 'url' in entry.config ? 'http' : 'stdio', enabled: entry.config.enabled !== false, exposure: entry.config.exposure ?? 'codemode' };
  for (const key of fields) if (config[key] !== undefined) result[key] = config[key];
  return result;
}
function mergeSecrets(input: unknown, previous?: RecordValue): RecordValue {
  if (!object(input)) throw new McpError(400, 'config 必须是对象');
  const raw = { ...previous, ...input };
  for (const key of ['env', 'headers']) {
    const rows = input[key];
    if (rows === undefined) continue;
    if (Array.isArray(rows)) {
      if (rows.length > 200) throw new McpError(400, '环境变量或 Headers 最多 200 行');
      const old = object(previous?.[key]) ? previous[key] : {};
      const values: Record<string, string> = Object.create(null);
      for (const row of rows) {
        if (!object(row) || typeof row['key'] !== 'string' || !row['key'].trim() || row['key'].length > 200) throw new McpError(400, '环境变量或 Header 名称无效');
        const name = row['key'];
        if (Object.hasOwn(values, name)) throw new McpError(400, '环境变量或 Header 名称不能重复');
        if (row['remove'] === true) continue;
        const value = row['value'];
        if ((value === '' || value === undefined) && typeof old[name] === 'string') values[name] = old[name];
        else if (typeof value === 'string') values[name] = value;
        else throw new McpError(400, '新增环境变量或 Header 需要填写值');
      }
      raw[key] = values;
    } else if (!object(rows)) throw new McpError(400, '环境变量或 Headers 格式无效');
  }
  if (object(input['oauth'])) {
    const previousOAuth = object(previous?.['oauth']) ? previous['oauth'] : {};
    const next = { ...input['oauth'] };
    if (next['clientSecret'] === '' || next['clientSecret'] === undefined) next['clientSecret'] = previousOAuth['clientSecret'];
    if (next['clientSecret'] === null) delete next['clientSecret'];
    for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === null) delete next[key];
    raw['oauth'] = next;
  }
  for (const key of ['cwd', 'timeout', 'description', 'auth', 'oauth', 'toolExposure']) if (raw[key] === null) delete raw[key];
  // A changed destination must never silently inherit credentials from the old one.
  const targetPart = (config: RecordValue, key: string) => config[key] ?? (key === 'args' ? [] : '');
  if (previous && ['command', 'args', 'cwd', 'url'].some((key) => JSON.stringify(targetPart(raw, key)) !== JSON.stringify(targetPart(previous, key)))) {
    for (const key of ['env', 'headers']) {
      const old = previous[key], supplied = input[key];
      if (!object(old)) continue;
      const retained = Object.keys(old).some((name) => supplied === undefined || Array.isArray(supplied) && supplied.some((row: unknown) => object(row) && row['key'] === name && row['remove'] !== true && !row['value']));
      if (retained) throw new McpError(409, '修改启动命令、参数、工作目录或 URL 时，请重新填写要保留的环境变量与 Header 值');
    }
    if (object(previous['oauth']) && previous['oauth']['clientSecret'] && object(raw['oauth']) && raw['oauth']['clientSecret'] && (!object(input['oauth']) || !input['oauth']['clientSecret'])) throw new McpError(409, '修改连接地址时，请重新填写或删除原 OAuth Client Secret');
  }
  return raw;
}

/** File editing, project overlays and short-lived Pi sessions form the Web control plane. */
export class McpControlPlane {
  private readonly probes = new Map<string, McpProbeResult>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private readonly authJobs = new Map<string, AuthJob>();
  constructor(private readonly home: string) {}
  paths(project: string) { return { global: join(this.home, 'mcp.json'), project: join(resolve(project), CONFIG_DIR_NAME, 'mcp.json') }; }
  private key(project: string, entry: Entry) { return revision([resolve(project), entry.scope, entry.name, entry.config]); }

  private async entries(project: string, trusted: boolean) {
    const paths = this.paths(project), errors: string[] = [];
    const read = async (path: string): Promise<ConfigFile> => {
      try { return await readConfig(path); }
      catch (error) { errors.push(path + ': ' + (error as Error).message); return { path, value: {}, servers: {} }; }
    };
    const [global, local] = await Promise.all([read(paths.global), read(paths.project)]);
    const entries: Entry[] = [];
    for (const scope of ['global', 'project'] as const) {
      const file = scope === 'global' ? global : local;
      const candidates = Object.entries(file.servers);
      const bases = new Map<string, McpServerConfig>(), namespaces = new Set<string>();
      for (const entry of entries) if (entry.scope === 'global' && !namespaces.has(namespace(entry.name))) {
        bases.set(entry.name, entry.config); namespaces.add(namespace(entry.name));
      }
      const prepared = candidates.flatMap(([name, raw]) => {
        if (scope === 'project' && object(raw) && partial(raw)) {
          const base = bases.get(name);
          if (!object(base) || Object.keys(raw).some((key) => !OVERRIDE_KEYS.includes(key))) {
            errors.push(file.path + ': ' + name + ' 的覆盖项只能设置 enabled、exposure、toolExposure，并需要同名全局服务'); return [];
          }
          return [{ name, value: { ...base, ...raw } }];
        }
        if (scope === 'project' && object(raw) && raw['auth'] !== undefined) {
          errors.push(file.path + ': ' + name + '：auth.provider 只允许写在全局配置'); return [];
        }
        return [{ name, value: raw }];
      });
      if (!prepared.length) continue;
      const validated = await validateWithPi(project, this.home, prepared);
      for (const [name, raw] of candidates) {
        const config = validated.valid.get(name);
        if (!config) { const error = validated.errors.get(name); if (error) errors.push(file.path + ': ' + error); continue; }
        entries.push({ name, config, raw: raw as RecordValue, revision: revision(raw), source: file.path, scope,
          active: scope === 'global' || trusted, overridesGlobal: scope === 'project' && Object.hasOwn(global.servers, name) });
      }
    }
    // Apply in file order, matching Pi: conflicting namespaces do not replace accepted entries.
    const active = new Map<string, Entry>();
    for (const entry of entries) {
      entry.active = false;
      if (entry.scope === 'project' && !trusted) { entry.inactiveReason = 'untrusted'; continue; }
      const other = [...active.values()].find((item) => item.name !== entry.name && namespace(item.name) === namespace(entry.name));
      if (other) { entry.inactiveReason = 'conflict'; errors.push('MCP 命名冲突：' + entry.name + ' / ' + other.name); continue; }
      const replaced = active.get(entry.name);
      if (replaced) { replaced.active = false; replaced.inactiveReason = 'overridden'; }
      entry.active = true; active.set(entry.name, entry);
    }
    return { entries, errors, paths, projectConfigExists: local.source !== undefined };
  }

  async snapshot(project: string, trusted: boolean) {
    const loaded = await this.entries(project, trusted);
    return {
      project: resolve(project), projectTrusted: trusted, requiresTrust: !trusted && loaded.projectConfigExists, paths: loaded.paths, errors: loaded.errors,
      servers: loaded.entries.map((entry) => ({
        name: entry.name, scope: entry.scope, source: entry.source, revision: entry.revision, effective: entry.active, inactiveReason: entry.inactiveReason,
        override: entry.scope === 'project' && partial(entry.raw), overridesGlobal: entry.overridesGlobal,
        config: viewConfig(entry), probe: this.probes.get(this.key(project, entry))
      })),
      authorizations: [...this.authJobs.values()].filter((job) => resolve(job.view.project) === resolve(project)).map((job) => ({ ...job.view }))
    };
  }

  private async edit(input: McpInput, assertIdle: () => void, edit: (file: ConfigFile) => Promise<void>) {
    serverName(input.name); requireScope(input.scope);
    const path = this.paths(input.project)[input.scope];
    await mkdir(dirname(path), { recursive: true });
    let release: (() => Promise<void>) | undefined, staged: string | undefined;
    try {
      try { release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 50, maxTimeout: 150 } }); }
      catch { throw new McpError(409, 'MCP 配置正在被其他进程修改，请稍后重试'); }
      this.shutdown.signal.throwIfAborted(); assertIdle();
      const file = await readConfig(path);
      assertRevision(input.revision, Object.hasOwn(file.servers, input.name) ? file.servers[input.name] : undefined);
      await edit(file);
      file.value['mcpServers'] = file.servers;
      const indent = file.source?.match(/^([ \t]+)\S/m)?.[1] ?? '  ';
      staged = path + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
      await writeFile(staged, JSON.stringify(file.value, null, indent) + '\n', { mode: 0o600, flag: 'wx' });
      if (await sourceAt(path) !== file.source) throw new McpError(409, 'mcp.json 已被外部程序修改，请刷新后重试');
      this.shutdown.signal.throwIfAborted(); assertIdle();
      await rename(staged, path); staged = undefined;
      this.probes.clear();
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(500, '无法保存 MCP 配置，请检查本机文件权限；原配置会保留');
    } finally {
      if (staged) await rm(staged, { force: true });
      if (release) await release();
    }
  }

  async save(input: McpSaveInput, assertIdle: () => void) {
    await this.edit(input, assertIdle, async (file) => {
      const old = file.servers[input.name];
      const previous = object(old) ? old : undefined;
      const override = input.scope === 'project' && input.override;
      const previousFields = override && previous ? Object.fromEntries(Object.entries(previous).filter(([key]) => OVERRIDE_KEYS.includes(key))) : previous;
      const raw = mergeSecrets(input.config, previousFields);
      let validation: unknown = raw;
      if (input.scope === 'project' && input.override) {
        if (Object.keys(raw).some((key) => !OVERRIDE_KEYS.includes(key))) throw new McpError(400, '项目覆盖只允许修改启用状态与工具暴露方式');
        const global = await readConfig(this.paths(input.project).global);
        const base = global.servers[input.name];
        if (!object(base)) throw new McpError(400, '请先配置同名全局 MCP 服务');
        const checkedBase = await validateWithPi(input.project, this.home, [{ name: input.name, value: base }]);
        if (!checkedBase.valid.has(input.name)) throw new McpError(400, '同名全局服务配置无效，请先修复全局配置');
        validation = { ...checkedBase.valid.get(input.name), ...raw };
      } else if (input.scope === 'project' && raw['auth'] !== undefined) throw new McpError(400, 'auth.provider 只允许写在全局配置');
      const validated = await validateWithPi(input.project, this.home, [{ name: input.name, value: validation }]);
      if (validated.errors.size) throw new McpError(400, validated.errors.get(input.name)!);
      const clash = Object.keys(file.servers).find((name) => name !== input.name && namespace(name) === namespace(input.name));
      if (clash) throw new McpError(400, '服务名称与已有服务冲突：' + clash);
      file.servers[input.name] = raw;
    });
  }

  async remove(input: McpInput, assertIdle: () => void) {
    await this.edit(input, assertIdle, async (file) => {
      if (!Object.hasOwn(file.servers, input.name)) throw new McpError(404, 'MCP 服务不存在');
      delete file.servers[input.name];
    });
  }

  async toggle(input: McpInput & { enabled: boolean }, assertIdle: () => void) {
    if (typeof input.enabled !== 'boolean') throw new McpError(400, 'enabled 必须是布尔值');
    await this.edit(input, assertIdle, async (file) => {
      const previous = file.servers[input.name];
      if (!object(previous)) throw new McpError(404, 'MCP 服务不存在');
      file.servers[input.name] = { ...previous, enabled: input.enabled };
    });
  }

  async updateTools(input: McpInput & { changes: unknown }, assertIdle: () => void) {
    if (!object(input.changes) || Object.keys(input.changes).length > 500) throw new McpError(400, '工具设置必须是对象，最多 500 项');
    const changes = input.changes;
    await this.edit(input, assertIdle, async (file) => {
      const previous = file.servers[input.name];
      if (!object(previous)) throw new McpError(404, 'MCP 服务不存在');
      let inherited: RecordValue | undefined;
      if (input.scope === 'project' && partial(previous)) {
        const global = await readConfig(this.paths(input.project).global);
        const base = global.servers[input.name];
        if (!object(base)) throw new McpError(409, '同名全局服务已被移除');
        const validated = await validateWithPi(input.project, this.home, [{ name: input.name, value: base }]);
        if (!validated.valid.has(input.name)) throw new McpError(409, '同名全局服务配置无效');
        inherited = base;
      }
      const previousRules = previous['toolExposure'] ?? inherited?.['toolExposure'];
      const rules = Object.assign(Object.create(null), object(previousRules) ? previousRules : {});
      for (const [name, exposure] of Object.entries(changes)) {
        if (!name || name.length > 200 || /[\x00-\x1f]/.test(name)) throw new McpError(400, '工具名或匹配规则无效');
        if (exposure === null) delete rules[name];
        else if (['direct', 'deferred', 'codemode', 'hidden'].includes(exposure as string)) rules[name] = exposure;
        else throw new McpError(400, '工具暴露方式无效');
      }
      const raw = { ...previous, toolExposure: rules };
      const config: unknown = inherited ? { ...inherited, ...raw } : raw;
      const validated = await validateWithPi(input.project, this.home, [{ name: input.name, value: config }]);
      if (!validated.valid.has(input.name)) throw new McpError(400, validated.errors.get(input.name) ?? '工具设置无效');
      file.servers[input.name] = raw;
    });
  }

  async liveTools(project: string, trusted: boolean, tools: McpToolView[]) {
    const loaded = await this.entries(project, trusted);
    return tools.map((tool) => {
      const entry = loaded.entries.find((entry) => entry.active && entry.name === tool.server);
      return { ...tool, description: entry ? redact(tool.description, entry.raw) : '' };
    });
  }

  auth(id: string) {
    const job = this.authJobs.get(id);
    if (!job) throw new McpError(404, '授权流程不存在或已过期');
    return { ...job.view };
  }
  cancelAuth(id: string) { this.auth(id); this.authJobs.get(id)!.abort.abort(); }
  redirectAuth(id: string, value: unknown) {
    this.auth(id); const job = this.authJobs.get(id)!;
    if (job.view.state !== 'waiting' || !job.redirect) throw new McpError(409, '当前没有等待中的授权');
    if (typeof value !== 'string' || value.length > 8192) throw new McpError(400, '回调 URL 无效');
    job.redirect(value);
  }

  async startAuth(input: McpInput, trusted: boolean, runtime: ModelRuntime, action: 'login' | 'logout' = 'login') {
    serverName(input.name); requireScope(input.scope);
    if (input.scope === 'project' && !trusted) throw new McpError(403, '请先信任当前项目再授权项目级 MCP');
    if ([...this.authJobs.values()].some((job) => ['starting', 'waiting'].includes(job.view.state))) throw new McpError(409, '已有 MCP 正在授权，请完成或取消后重试');
    const loaded = await this.entries(input.project, trusted);
    const entry = loaded.entries.find((entry) => entry.name === input.name && entry.scope === input.scope);
    if (!entry || !entry.active || entry.config.enabled === false) throw new McpError(409, '请先启用当前生效的服务再授权');
    assertRevision(input.revision, entry.raw);
    if (!('url' in entry.config) || entry.config.auth || Object.keys(entry.config.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')) throw new McpError(400, '此服务使用其他认证方式，无需 MCP OAuth 登录');
    while (this.authJobs.size >= 30) this.authJobs.delete(this.authJobs.keys().next().value!);
    const started = Date.now();
    const job: AuthJob = { view: { id: randomBytes(16).toString('hex'), project: resolve(input.project), scope: input.scope, name: input.name, action, state: 'starting', startedAt: new Date(started).toISOString(), expiresAt: new Date(started + 300_000).toISOString() }, abort: new AbortController(), done: Promise.resolve() };
    this.authJobs.set(job.view.id, job);
    job.done = this.authorize(input.project, entry, runtime, job);
    this.pending.add(job.done);
    void job.done.finally(() => this.pending.delete(job.done));
    return { view: { ...job.view }, done: job.done };
  }

  private async authorize(project: string, entry: Entry, runtime: ModelRuntime, job: AuthJob) {
    let agent: AgentSession | undefined, closing: Promise<void> | undefined;
    const view = new McpRuntimeView();
    const stop = () => closing ??= (async () => { if (agent) { try { await agent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } finally { agent.dispose(); } } })();
    const abort = () => { job.redirect?.(undefined); if (agent) void stop(); };
    const shutdown = () => job.abort.abort();
    this.shutdown.signal.addEventListener('abort', shutdown, { once: true });
    job.abort.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => job.abort.abort('timeout'), 300_000);
    const settings = SettingsManager.create(project, this.home, { projectTrusted: false });
    let signedIn = false;
    try {
      this.shutdown.signal.throwIfAborted(); job.abort.signal.throwIfAborted();
      const loader = new DefaultResourceLoader({ cwd: project, agentDir: this.home, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [{ name: 'forge-mcp-auth', factory: view.factory({
          loadConfig: () => ({ servers: [entry], errors: [], autoEnableCodemode: false }),
          openUrl: (value) => {
            const url = new URL(value);
            if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('无效的授权 URL');
            job.view.state = 'waiting'; job.view.authorizationUrl = url.href;
          }
        }) }]
      });
      await loader.reload();
      ({ session: agent } = await createAgentSession({ cwd: project, agentDir: this.home, modelRuntime: runtime, settingsManager: settings, sessionManager: SessionManager.inMemory(project), resourceLoader: loader, noTools: 'builtin' }));
      await agent.bindExtensions({ mode: 'rpc', uiContext: { notify: () => {}, input: async () => undefined } as unknown as ExtensionUIContext });
      view.bind(agent, false);
      job.abort.signal.throwIfAborted();
      await view.run(job.view.action + ' ' + entry.name, {
        notify: (message) => { if (job.view.action === 'login' ? message.startsWith('Signed in to MCP server ') : message.startsWith('Signed out of MCP server ') || message.startsWith('No stored credentials for MCP server ')) signedIn = true; },
        input: (_title, _placeholder, options) => new Promise<string | undefined>((done) => {
          const finish = (value?: string) => { options?.signal?.removeEventListener('abort', onAbort); job.redirect = undefined; done(value); };
          const onAbort = () => finish();
          job.redirect = finish;
          if (options?.signal?.aborted || job.abort.signal.aborted) finish();
          else options?.signal?.addEventListener('abort', onAbort, { once: true });
        })
      });
      job.view.state = job.abort.signal.aborted ? job.abort.signal.reason === 'timeout' ? 'timeout' : 'cancelled' : signedIn ? 'succeeded' : 'failed';
    } catch {
      job.view.state = job.abort.signal.aborted ? job.abort.signal.reason === 'timeout' ? 'timeout' : 'cancelled' : 'failed';
    } finally {
      clearTimeout(timeout); this.shutdown.signal.removeEventListener('abort', shutdown); job.abort.signal.removeEventListener('abort', abort);
      job.redirect?.(undefined); delete job.view.authorizationUrl;
      job.view.message = job.view.state === 'succeeded' ? job.view.action === 'logout' ? '已移除此服务在本机保存的 OAuth 授权' : '授权成功，凭据已由 Pi 保存在本机' : job.view.state === 'cancelled' ? '已取消授权' : job.view.state === 'timeout' ? '授权已超时，请重新开始' : '授权未完成，请检查服务、OAuth 参数或重新尝试';
      await stop();
    }
  }

  async test(input: McpInput, trusted: boolean, runtime: ModelRuntime): Promise<McpProbeResult> {
    serverName(input.name); requireScope(input.scope);
    if (input.scope === 'project' && !trusted) throw new McpError(403, '请先在项目设置中信任当前项目，再测试项目级 MCP');
    const loaded = await this.entries(input.project, trusted);
    const existing = loaded.entries.find((item) => item.scope === input.scope && item.name === input.name);
    let entry: Entry;
    if (input.config !== undefined) {
      if (existing) assertRevision(input.revision, existing.raw);
      const raw = mergeSecrets(input.config, existing?.raw);
      if (input.scope === 'project' && raw['auth'] !== undefined) throw new McpError(400, 'auth.provider 只允许写在全局配置');
      const validated = await validateWithPi(input.project, this.home, [{ name: input.name, value: raw }]);
      const config = validated.valid.get(input.name);
      if (!config) throw new McpError(400, validated.errors.get(input.name) ?? 'MCP 配置无效');
      entry = { name: input.name, config, raw, scope: input.scope, source: this.paths(input.project)[input.scope], active: true, overridesGlobal: false, revision: revision(raw) };
    } else {
      if (!existing) throw new McpError(404, 'MCP 服务不存在');
      if (!existing.active) throw new McpError(409, '此配置因覆盖或命名冲突未生效，请测试当前生效的配置');
      entry = existing;
    }
    this.shutdown.signal.throwIfAborted();
    const task = this.probe(input.project, entry, runtime);
    this.pending.add(task);
    try {
      const result = await task;
      if (input.config === undefined) {
        if (this.probes.size >= 500) this.probes.delete(this.probes.keys().next().value!);
        this.probes.set(this.key(input.project, entry), result);
      }
      return result;
    } finally { this.pending.delete(task); }
  }

  private async probe(project: string, entry: Entry, modelRuntime: ModelRuntime): Promise<McpProbeResult> {
    const started = Date.now(), notices: string[] = [];
    const view = new McpRuntimeView();
    const settings = SettingsManager.create(project, this.home, { projectTrusted: false });
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir: this.home, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: 'forge-mcp-probe', factory: view.factory({ loadConfig: () => ({ servers: [{ ...entry, config: { ...entry.config, enabled: true } }], errors: [], autoEnableCodemode: false }), openUrl: () => {} }) }]
    });
    let agent: AgentSession | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => cancel?.('timeout');
    let cancel: ((value: 'timeout') => void) | undefined;
    const cancelled = new Promise<'timeout'>((done) => { cancel = done; timeout = setTimeout(() => done('timeout'), 15_000); });
    this.shutdown.signal.addEventListener('abort', onAbort, { once: true });
    try {
      this.shutdown.signal.throwIfAborted();
      await loader.reload();
      ({ session: agent } = await createAgentSession({ cwd: project, agentDir: this.home, modelRuntime, settingsManager: settings, sessionManager: SessionManager.inMemory(project), resourceLoader: loader, noTools: 'builtin' }));
      await agent.bindExtensions({ mode: 'rpc', uiContext: { notify: (message: string) => { notices.push(message); } } as ExtensionUIContext });
      // The local /mcp command waits for Pi's connections, including servers with zero tools.
      // This adapter targets pinned Pi 1.4 output and never sends a model request.
      const completion = await Promise.race([agent.prompt('/mcp').then(() => 'ready' as const), cancelled]);
      let status: McpProbeResult['status'] = 'failed';
      const report = [...notices].reverse().find((message) => message.startsWith(entry.name + ':')) ?? '';
      const state = report.split('\n')[0]?.slice(entry.name.length + 2) ?? '';
      if (completion === 'timeout') status = 'timeout';
      else if (state.startsWith('connected')) status = 'connected';
      else if (state.startsWith('needs sign-in')) status = 'needs-auth';
      // Raw server stderr or command-derived secrets are kept out of the HTTP response.
      const message = status === 'needs-auth' ? '此 HTTP 服务需要 OAuth 授权，请点击“登录授权”'
        : status === 'timeout' ? '连接测试超过 15 秒，请检查启动命令和网络后重试'
        : status === 'failed' ? /ENOENT|not found/i.test(notices.join('\n')) ? '找不到启动命令，请检查程序是否已安装及 PATH'
          : /401|403/i.test(notices.join('\n')) ? '认证失败，请检查 Header、环境变量或 Provider 凭据'
          : 'Pi 未能连接服务，请检查配置、程序和网络；详细诊断保存在本机 MCP 日志'
        : undefined;
      const tools = view.catalog().filter((tool) => tool.server === entry.name).map((tool) => ({ name: tool.name, rawName: tool.rawName, exposure: tool.exposure, description: redact(tool.description, entry.raw) }));
      return { status, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, tools: status === 'connected' ? tools : [], ...(message ? { message } : {}) };
    } catch {
      return { status: 'failed', checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, tools: [], message: 'Pi MCP 测试无法完成，请检查本机配置与日志' };
    } finally {
      clearTimeout(timeout);
      this.shutdown.signal.removeEventListener('abort', onAbort);
      if (agent) { try { await agent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } finally { agent.dispose(); } }
    }
  }

  async close() { this.shutdown.abort(); for (const job of this.authJobs.values()) job.abort.abort(); await Promise.allSettled([...this.pending]); }
}
