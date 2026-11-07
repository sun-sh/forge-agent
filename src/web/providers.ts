import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import lockfile from 'proper-lockfile';
import { ModelRuntime, readStoredCredential } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import { Type } from 'typebox';

// This edits Pi's configuration. Pi still owns authentication and all model requests.
export const CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
const LOCAL_KEY = 'pforge-local-no-key';
const MAX_CONFIG = 2_000_000;
type JsonObject = Record<string, any>;
type CustomApi = typeof CUSTOM_APIS[number];
export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ProviderError'; }
}
function object(value: unknown): value is JsonObject { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ProviderError(400, label + '格式不正确');
  return value.trim();
}
function providerId(value: unknown): string {
  const id = text(value, '服务 ID', 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) throw new ProviderError(400, '服务 ID 只能包含小写字母、数字、短横线和下划线');
  return id;
}
function protocol(value: unknown): CustomApi {
  if (!CUSTOM_APIS.includes(value as CustomApi)) throw new ProviderError(400, '请选择支持的接口协议');
  return value as CustomApi;
}
export function normalizeProviderUrl(value: unknown, api: CustomApi): string {
  let url: URL;
  try { url = new URL(text(value, '接口地址', 2048)); } catch { throw new ProviderError(400, '接口地址必须是完整的 http 或 https URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError(400, '接口地址不支持用户密码、查询参数或片段，请填写服务的 Base URL');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '');
  // Anthropic's SDK appends /v1/messages, whereas OpenAI appends /chat/completions.
  if (api === 'anthropic-messages') path = path.replace(/\/v1$/, '');
  url.pathname = path;
  return url.toString().replace(/\/+$/, '');
}
function modelInput(value: unknown): JsonObject {
  if (!object(value)) throw new ProviderError(400, '模型配置格式不正确');
  const result: JsonObject = { id: text(value['id'], '模型 ID', 300) };
  if (value['name'] !== undefined) result['name'] = text(value['name'], '模型名称');
  for (const key of ['contextWindow', 'maxTokens']) {
    const number = value[key];
    if (number !== undefined) {
      if (!Number.isSafeInteger(number) || number < 1 || number > 100_000_000) throw new ProviderError(400, '上下文和最大输出必须为正整数');
      result[key] = number;
    }
  }
  if ((result['maxTokens'] ?? 16384) > (result['contextWindow'] ?? 128000)) throw new ProviderError(400, '最大输出不能超过上下文长度');
  if (value['reasoning'] !== undefined) {
    if (typeof value['reasoning'] !== 'boolean') throw new ProviderError(400, '推理能力必须为布尔值');
    result['reasoning'] = value['reasoning'];
  }
  const map = thinkingLevelMap(value['thinkingLevelMap'], true);
  if (map) result['thinkingLevelMap'] = map;
  if (result['reasoning'] && !getSupportedThinkingLevels(result as any).length) throw new ProviderError(400, '请为推理模型保留至少一个可用档位');
  if (value['input'] !== undefined) {
    if (!Array.isArray(value['input']) || !value['input'].includes('text') || value['input'].some((item: unknown) => item !== 'text' && item !== 'image')) throw new ProviderError(400, '模型输入类型不正确');
    result['input'] = [...new Set(value['input'])];
  }
  return result;
}
function connectionInput(value: unknown) {
  if (!object(value)) throw new ProviderError(400, '服务配置格式不正确');
  const id = providerId(value['id']);
  const api = protocol(value['api']);
  const baseUrl = normalizeProviderUrl(value['baseUrl'], api);
  if (value['apiKey'] !== undefined && typeof value['apiKey'] !== 'string') throw new ProviderError(400, 'API Key 格式不正确');
  const apiKey = (value['apiKey'] as string | undefined)?.trim() || '';
  if (apiKey.length > 16_000 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new ProviderError(400, 'API Key 格式不正确');
  if (value['noKey'] !== undefined && typeof value['noKey'] !== 'boolean') throw new ProviderError(400, '认证方式格式不正确');
  if (apiKey && value['noKey']) throw new ProviderError(400, '请在 API Key 和无需密钥中选择一种认证方式');
  return { id, api, baseUrl, apiKey, noKey: value['noKey'] === true };
}
function revision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function thinkingLevelMap(value: unknown, strict = false): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) {
    if (strict) throw new ProviderError(400, '推理档位映射格式不正确');
    return undefined;
  }
  const result: Record<string, string | null> = {};
  for (const [key, mapped] of Object.entries(value)) {
    if (!MODEL_THINKING_LEVELS.includes(key as typeof MODEL_THINKING_LEVELS[number])) {
      if (strict) throw new ProviderError(400, '推理档位映射包含未知档位');
      continue;
    }
    if (mapped !== null && (typeof mapped !== 'string' || mapped.length > 100 || /[\u0000-\u001f\u007f]/.test(mapped))) {
      if (strict) throw new ProviderError(400, '推理档位映射值格式不正确');
      continue;
    }
    result[key] = mapped;
  }
  return Object.keys(result).length ? result : undefined;
}
function safeModel(value: JsonObject) {
  return { id: value['id'], name: value['name'] || value['id'], contextWindow: value['contextWindow'] ?? 128000, maxTokens: value['maxTokens'] ?? 16384, reasoning: Boolean(value['reasoning']), thinkingLevelMap: thinkingLevelMap(value['thinkingLevelMap']), input: value['input'] ?? ['text'] };
}

export class CustomProviders {
  private readonly path: string;
  private readonly authPath: string;
  constructor(private readonly home: string, private readonly runtime: ModelRuntime) { this.path = join(home, 'models.json'); this.authPath = join(home, 'auth.json'); }

  private capabilityTemplates(api: string, excludeProvider: string) {
    const matches = new Map<string, JsonObject[]>();
    for (const provider of this.runtime.getProviders()) {
      if (provider.id === excludeProvider) continue;
      for (const model of this.runtime.getModels(provider.id)) {
        if (model.api !== api) continue;
        const list = matches.get(model.id) ?? [];
        if (list.length < 8) list.push({ ...safeModel(model), source: provider.id, sourceName: provider.name || provider.id });
        matches.set(model.id, list);
      }
    }
    return matches;
  }

  private async read() {
    let source: string;
    try { source = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source: '{\n  "providers": {}\n}\n', config: { providers: {} } as JsonObject };
      throw new ProviderError(500, '无法读取 Pi 的 models.json，请检查文件权限');
    }
    const errors: ParseError[] = [];
    const config: unknown = parse(source.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: false });
    if (source.length > MAX_CONFIG || errors.length || !object(config) || !object(config['providers'])) throw new ProviderError(409, '现有 models.json 无法解析，请先修复文件；未覆盖原配置');
    return { source: source.replace(/^\uFEFF/, ''), config };
  }

  async configuredProviderIds(): Promise<string[]> {
    const { config } = await this.read();
    return Object.keys(config['providers']);
  }

  async list() {
    const { config } = await this.read();
    return Object.entries(config['providers'] as JsonObject).map(([id, value]) => {
      const entry = object(value) ? value : {};
      const credential = readStoredCredential(id, this.authPath);
      const models = Array.isArray(entry['models']) ? entry['models'].filter(object) : [];
      const templates = this.capabilityTemplates(entry['api'] || '', id);
      return {
        id, name: entry['name'] || id, baseUrl: entry['baseUrl'] || '', api: entry['api'] || models[0]?.['api'] || '',
        models: models.map((model) => ({ ...safeModel(model), capabilityTemplates: templates.get(model['id']) ?? [] })), revision: revision(entry),
        authConfigured: this.runtime.hasConfiguredAuth(id), noKey: credential?.type === 'api_key' && credential.key === LOCAL_KEY,
        editable: CUSTOM_APIS.includes(entry['api']) && typeof entry['baseUrl'] === 'string' && !entry['oauth'],
        advanced: Boolean(entry['headers'] || entry['compat'] || entry['modelOverrides'] || models.some((model: JsonObject) => model['headers'] || model['baseUrl'] || model['api']))
      };
    });
  }

  private ensureDestination(entry: JsonObject | undefined, input: ReturnType<typeof connectionInput>) {
    const same = entry && entry['api'] === input.api && normalizeProviderUrl(entry['baseUrl'], input.api) === input.baseUrl;
    if (!same && !input.apiKey && !input.noKey) throw new ProviderError(400, '添加服务或更改接口地址后，请重新填写 API Key，或明确选择无需密钥');
    if (!same && entry && (entry['headers'] || (entry['models'] || []).some((model: JsonObject) => model['headers'] || model['baseUrl'] || model['api']) || entry['oauth'])) throw new ProviderError(409, '此服务包含高级请求配置，请在 models.json 中修改接口地址，或创建一个新服务');
    return Boolean(same);
  }

  private async requestKey(input: ReturnType<typeof connectionInput>): Promise<string> {
    const { config } = await this.read();
    const entry = Object.hasOwn(config['providers'], input.id) ? config['providers'][input.id] as JsonObject : undefined;
    this.ensureDestination(entry, input);
    if (input.noKey) return LOCAL_KEY;
    if (input.apiKey) return input.apiKey;
    const credential = readStoredCredential(input.id, this.authPath);
    if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key) return credential.key;
    throw new ProviderError(400, '请填写 API Key 进行获取或测试；已保存的高级认证配置仍由 Pi 使用');
  }

  async discover(value: unknown) {
    const input = connectionInput(value);
    const key = await this.requestKey(input);
    const endpoint = input.baseUrl + (input.api === 'anthropic-messages' ? '/v1/models' : '/models');
    const headers: Record<string, string> = input.api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + key };
    let response: Response | undefined;
    try {
      response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new ProviderError(502, '获取模型列表失败（HTTP ' + response.status + '）。请核对地址和 Key；不支持列表接口的服务可手动填写模型 ID。');
      if (Number(response.headers.get('content-length')) > MAX_CONFIG) throw new ProviderError(502, '模型列表过大，请手动填写模型 ID');
      const reader = response.body?.getReader();
      let size = 0; const chunks: Uint8Array[] = [];
      if (reader) try { for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.length; if (size > MAX_CONFIG) throw new ProviderError(502, '模型列表过大，请手动填写模型 ID'); chunks.push(chunk); } } finally { await reader.cancel().catch(() => {}); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const entries: unknown[] = object(payload) && Array.isArray(payload['data']) ? payload['data'] : Array.isArray(payload) ? payload : [];
      const templates = this.capabilityTemplates(input.api, input.id);
      const models = new Map<string, JsonObject>();
      for (const entry of entries) {
        if (!object(entry) || typeof entry['id'] !== 'string' || !entry['id'].trim() || entry['id'].length > 300 || /[\u0000-\u001f\u007f]/.test(entry['id'])) continue;
        const id = entry['id'].trim();
        const name = typeof entry['name'] === 'string' ? entry['name'] : typeof entry['display_name'] === 'string' ? entry['display_name'] : id;
        const discovered: JsonObject = { id, name: name.slice(0, 200) };
        // Only explicit capability metadata is evidence; a name alone is not.
        if (typeof entry['reasoning'] === 'boolean') discovered['reasoning'] = entry['reasoning'];
        const map = thinkingLevelMap(entry['thinkingLevelMap']);
        if (map) discovered['thinkingLevelMap'] = map;
        if (Array.isArray(entry['input']) && entry['input'].includes('text') && entry['input'].every((item: unknown) => item === 'text' || item === 'image')) discovered['input'] = [...new Set(entry['input'])];
        if (Number.isSafeInteger(entry['contextWindow']) && entry['contextWindow'] > 0) discovered['contextWindow'] = entry['contextWindow'];
        if (Number.isSafeInteger(entry['maxTokens']) && entry['maxTokens'] > 0) discovered['maxTokens'] = entry['maxTokens'];
        discovered['capabilityTemplates'] = templates.get(id) ?? [];
        models.set(id, discovered);
        if (models.size >= 1000) break;
      }
      if (!models.size) throw new ProviderError(502, '接口未返回可识别的模型列表，请手动填写模型 ID');
      return { models: [...models.values()].sort((a, b) => a['id'].localeCompare(b['id'])), baseUrl: input.baseUrl };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(502, '无法获取模型列表。请检查服务是否运行、Base URL 和 Key 是否正确，或手动填写模型 ID。');
    } finally { await response?.body?.cancel().catch(() => {}); }
  }

  private async stage(source: string) {
    await mkdir(this.home, { recursive: true });
    const path = join(this.home, '.models-' + randomBytes(12).toString('hex') + '.tmp');
    await writeFile(path, source, { mode: 0o600, flag: 'wx' });
    return path;
  }

  async save(value: unknown, assertIdle: () => void = () => {}) {
    const input = connectionInput(value);
    if (!object(value)) throw new ProviderError(400, '服务配置格式不正确');
    const name = text(value['name'], '服务名称');
    if (!Array.isArray(value['models']) || value['models'].length < 1 || value['models'].length > 200) throw new ProviderError(400, '请添加 1 至 200 个模型');
    const models = value['models'].map(modelInput);
    if (new Set(models.map((model) => model['id'])).size !== models.length) throw new ProviderError(400, '模型 ID 不能重复');
    await mkdir(this.home, { recursive: true });
    let release: (() => Promise<void>) | undefined;
    let staged: string | undefined;
    let authChanged = false;
    let oldCredential: ReturnType<typeof readStoredCredential>;
    let validation: ModelRuntime | undefined;
    try {
      try { release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 20, minTimeout: 50, maxTimeout: 200 } }); }
      catch { throw new ProviderError(409, '模型配置正在保存，请稍后重试'); }
      assertIdle();
      oldCredential = readStoredCredential(input.id, this.authPath);
      const { source, config } = await this.read();
      const previous: JsonObject | undefined = Object.hasOwn(config['providers'], input.id) ? config['providers'][input.id] : undefined;
      if (!previous && this.runtime.getProvider(input.id)) throw new ProviderError(409, '这个服务 ID 已被内置 Provider 使用，请换一个 ID');
      if (previous && (!value['revision'] || value['revision'] !== revision(previous))) throw new ProviderError(409, '服务已存在或被其他窗口修改，请重新打开编辑');
      if (!previous && value['revision']) throw new ProviderError(409, '服务配置已变化，请重新打开设置');
      const same = this.ensureDestination(previous, input);
      if (previous?.['oauth']) throw new ProviderError(409, 'OAuth 服务请使用 Pi 的 /login 管理');
      if (!input.apiKey && !input.noKey && !this.runtime.hasConfiguredAuth(input.id) && !previous?.['apiKey']) throw new ProviderError(400, '请填写 API Key 或选择无需密钥');
      if (!input.apiKey && !input.noKey && oldCredential?.type === 'api_key' && oldCredential.key === LOCAL_KEY) throw new ProviderError(400, '已取消无需密钥，请填写 API Key');
      if ((input.apiKey || input.noKey) && oldCredential && oldCredential.type !== 'api_key') throw new ProviderError(409, '此服务已有 OAuth 凭据，请先在 Pi 中管理登录，或创建新服务');
      const oldModels: JsonObject[] = Array.isArray(previous?.['models']) ? previous['models'] : [];
      const mergedModels = models.map((model) => ({ ...(oldModels.find((old) => old['id'] === model['id']) ?? {}), ...model }));
      let candidate = source;
      const fields: JsonObject = { name, baseUrl: input.baseUrl, api: input.api, models: mergedModels };
      if (!previous) candidate = applyEdits(candidate, modify(candidate, ['providers', input.id], fields, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      else for (const [field, fieldValue] of Object.entries(fields)) candidate = applyEdits(candidate, modify(candidate, ['providers', input.id, field], fieldValue, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      staged = await this.stage(candidate);
      validation = await ModelRuntime.create({ authPath: this.authPath, modelsPath: staged, refreshOnCreate: false });
      if (validation.getError() || !validation.getProvider(input.id)) throw new ProviderError(400, '配置未通过 Pi 验证，请检查模型参数及现有 models.json；未覆盖原配置');
      assertIdle();
      if (input.apiKey || input.noKey) {
        authChanged = true;
        const nextKey = input.noKey ? LOCAL_KEY : input.apiKey;
        await validation.login(input.id, 'api_key', { prompt: async () => nextKey, notify: () => {} });
      }
      // Other editors which do not use our lock must not be silently overwritten either.
      const latest = await this.read();
      if (latest.source !== source) throw new ProviderError(409, 'models.json 已被外部程序修改，请重新打开编辑');
      assertIdle();
      await rename(staged, this.path); staged = undefined; authChanged = false;
      await this.runtime.refresh({ allowNetwork: false, providers: [input.id], signal: AbortSignal.timeout(15_000) });
      return { id: input.id, models: models.map((model) => input.id + '/' + model['id']), baseUrl: input.baseUrl, changedEndpoint: Boolean(previous) && !same };
    } catch (error) {
      if (authChanged) {
        try {
          const credentialRuntime = validation ?? this.runtime;
          if (oldCredential?.type === 'api_key' && oldCredential.key) { const previousKey = oldCredential.key; await credentialRuntime.login(input.id, 'api_key', { prompt: async () => previousKey, notify: () => {} }); }
          else await credentialRuntime.logout(input.id);
        } catch { throw new ProviderError(500, '保存失败，凭据回退未完成；请重新保存此服务的 API Key'); }
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(500, '保存服务失败，请检查本机文件权限后重试');
    } finally { if (staged) await rm(staged, { force: true }); if (release) await release(); }
  }

  async remove(value: unknown, expectedRevision: unknown, assertIdle: () => void = () => {}) {
    const id = providerId(value);
    if (typeof expectedRevision !== 'string' || !expectedRevision) throw new ProviderError(400, '删除服务需要最新的配置版本');
    await mkdir(this.home, { recursive: true });
    let release: (() => Promise<void>) | undefined;
    let staged: string | undefined;
    let authRemoved = false;
    let committed = false;
    let oldCredential: ReturnType<typeof readStoredCredential> | undefined;
    try {
      try { release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 20, minTimeout: 50, maxTimeout: 200 } }); }
      catch { throw new ProviderError(409, '模型配置正在保存，请稍后重试'); }
      assertIdle();
      oldCredential = readStoredCredential(id, this.authPath);
      if (oldCredential?.type === 'oauth') throw new ProviderError(409, '此服务使用 OAuth，请先在 Pi 中完成登出');
      const { source, config } = await this.read();
      const previous: JsonObject | undefined = Object.hasOwn(config['providers'], id) ? config['providers'][id] : undefined;
      if (!previous) throw new ProviderError(404, '自定义服务不存在或已经删除');
      if (expectedRevision !== revision(previous)) throw new ProviderError(409, '服务已被其他窗口修改，请重新打开设置');
      if (previous['oauth'] || !CUSTOM_APIS.includes(previous['api'])) throw new ProviderError(409, '此服务由高级配置管理，不能从 Web 设置删除');
      const candidate = applyEdits(source, modify(source, ['providers', id], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      staged = await this.stage(candidate);
      const validation = await ModelRuntime.create({ authPath: this.authPath, modelsPath: staged, refreshOnCreate: false });
      if (validation.getError() || validation.getProvider(id)) throw new ProviderError(400, '删除后的 models.json 未通过 Pi 验证，原配置未改变');
      const latest = await this.read();
      if (latest.source !== source) throw new ProviderError(409, 'models.json 已被外部程序修改，请重新打开设置');
      assertIdle();
      if (oldCredential || this.runtime.hasConfiguredAuth(id)) { authRemoved = true; await this.runtime.logout(id); }
      assertIdle();
      await rename(staged, this.path); staged = undefined; committed = true;
      let diagnostic: string | undefined;
      try { await this.runtime.refresh({ allowNetwork: false, providers: [id], signal: AbortSignal.timeout(15_000) }); }
      catch { diagnostic = '服务配置和凭据已删除，但模型目录刷新失败；请重启本地服务后重新检查。'; }
      return { id, removed: true, diagnostic };
    } catch (error) {
      const previousKey = oldCredential?.type === 'api_key' && typeof oldCredential.key === 'string' ? oldCredential.key : undefined;
      if (!committed && authRemoved && previousKey) {
        try { await this.runtime.login(id, 'api_key', { prompt: async () => previousKey, notify: () => {} }); }
        catch { throw new ProviderError(500, '删除失败，凭据回退未完成；请重新保存此服务的 API Key'); }
      }
      if (error instanceof ProviderError) throw error;
      if (committed) throw new ProviderError(500, '服务配置和凭据已删除，但运行时刷新失败；请重启本地服务后重新检查');
      throw new ProviderError(500, '删除服务失败，请检查本机文件权限后重试');
    } finally { if (staged) await rm(staged, { force: true }); if (release) await release(); }
  }

  async test(value: unknown) {
    const input = connectionInput(value);
    if (!object(value)) throw new ProviderError(400, '服务配置格式不正确');
    const model = modelInput(value['model']);
    const key = await this.requestKey(input);
    const staged = await this.stage(JSON.stringify({ providers: { [input.id]: { baseUrl: input.baseUrl, api: input.api, models: [model] } } }));
    const signal = AbortSignal.timeout(20_000);
    let status: number | undefined;
    const started = Date.now();
    try {
      const runtime = await ModelRuntime.create({ modelsPath: staged, authPath: this.authPath, refreshOnCreate: false });
      await runtime.setRuntimeApiKey(input.id, key, { signal });
      const selected = runtime.getModel(input.id, model['id']);
      if (!selected) throw new ProviderError(400, '模型配置未通过 Pi 验证');
      const result = await runtime.completeSimple(selected, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, {
        maxTokens: Math.min(32, selected.maxTokens), reasoning: undefined, maxRetries: 0, timeoutMs: 20_000, signal,
        fetch: async (request, init) => { const response = await fetch(request, { ...init, redirect: 'error', signal }); status = response.status; return response; },
        onResponse: (response) => { status = response.status; }
      });
      if (signal.aborted) throw new ProviderError(502, '模型测试超时，请检查服务状态或稍后重试');
      if (result.stopReason === 'error' || result.stopReason === 'aborted' || !result.content.some((part) => part.type === 'text' && part.text.trim())) throw new ProviderError(502, '模型未返回有效文本' + (status ? '（HTTP ' + status + '）' : '') + '，请检查模型 ID、协议和 Key');
      const checks: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; message?: string }> = [{ name: 'streaming-text', status: 'passed' }];
      if (value['capabilities'] === true) {
        const nonce = randomBytes(8).toString('hex');
        const user = { role: 'user' as const, content: 'Call forge_probe with value ' + nonce + '. This is a harmless compatibility test; the tool has no side effects.', timestamp: Date.now() };
        const tools = [{ name: 'forge_probe', description: 'Return the probe value supplied by the caller.', parameters: Type.Object({ value: Type.String() }) }];
        const options = { maxTokens: Math.min(256, selected.maxTokens), maxRetries: 0, timeoutMs: 20_000, signal,
          fetch: async (request: string | URL | Request, init?: RequestInit) => { const response = await fetch(request, { ...init, redirect: 'error', signal }); status = response.status; return response; } };
        const called = await runtime.completeSimple(selected, { messages: [user], tools }, { ...options, toolChoice: 'auto' });
        const call = called.content.find((part) => part.type === 'toolCall' && part.name === 'forge_probe');
        if (called.stopReason === 'error' || !call || call.type !== 'toolCall' || call.arguments['value'] !== nonce) {
          checks.push({ name: 'tool-call', status: 'failed', message: '服务未返回符合工具定义的调用；请检查协议和模型的工具能力。' }, { name: 'tool-result', status: 'skipped' });
        } else {
          checks.push({ name: 'tool-call', status: 'passed' });
          const final = await runtime.completeSimple(selected, { tools, messages: [user, called,
            { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'Probe completed. Reply with the exact value: ' + nonce }], isError: false, timestamp: Date.now() }] }, { ...options, toolChoice: 'none' });
          checks.push({ name: 'tool-result', status: final.stopReason !== 'error' && final.stopReason !== 'aborted' && final.content.some((part) => part.type === 'text' && part.text.includes(nonce)) ? 'passed' : 'failed', message: '检查服务能否接收工具结果并继续生成文本。' });
        }
      }
      return { ok: true, model: model['id'], latencyMs: Date.now() - started, checks, codingCompatible: value['capabilities'] === true ? checks.every((check) => check.status === 'passed') : undefined };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(502, signal.aborted ? '模型测试超时，请检查服务状态或稍后重试' : '模型调用失败' + (status ? '（HTTP ' + status + '）' : '') + '，请核对 Base URL、协议、模型 ID 和 API Key');
    } finally { await rm(staged, { force: true }); }
  }
}
