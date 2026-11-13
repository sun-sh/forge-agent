import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { replaceMetadataFile } from './persistence.js';
import { reviewBudgetProfileSchema, type ReviewBudgetProfile } from './review-budget.js';

export const budgetLimitsSchema = z.object({
  maxDurationMs: z.number().int().min(60_000).max(86_400_000),
  maxModelTurns: z.number().int().min(1).max(1000),
  maxToolCalls: z.number().int().min(1).max(10_000),
  // Zero disables the optional cumulative request-token guard (includes cache reads).
  maxTotalTokens: z.number().int().min(0).max(100_000_000),
  maxOutputTokens: z.number().int().min(1_000).max(10_000_000).default(200_000),
  maxCostUsd: z.number().finite().min(0).max(100_000)
}).strict().refine((limits) => limits.maxTotalTokens === 0 || limits.maxTotalTokens >= 1_000, {
  message: '累计 token 上限只能为 0（关闭）或至少 1000'
});
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxDurationMs: 90 * 60 * 1000,
  maxModelTurns: 240,
  maxToolCalls: 500,
  maxTotalTokens: 0,
  maxOutputTokens: 300_000,
  maxCostUsd: 40
};

export type BudgetStatus = 'running' | 'completed' | 'aborted' | 'exceeded';
export interface BudgetSnapshot {
  version: 1;
  status: BudgetStatus;
  startedAt: string;
  endedAt?: string;
  limits: BudgetLimits;
  modelTurns: number;
  toolCalls: number;
  totalTokens: number;
  costUsd: number;
  costIncomplete?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  exceededReason?: string;
}
export const budgetSnapshotSchema = z.object({
  version: z.literal(1), status: z.enum(['running', 'completed', 'aborted', 'exceeded']),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().optional(), limits: budgetLimitsSchema,
  modelTurns: z.number().int().min(0), toolCalls: z.number().int().min(0), totalTokens: z.number().int().min(0),
  costUsd: z.number().finite().min(0), exceededReason: z.string().max(1000).optional(),
  costIncomplete: z.boolean().optional(), usage: z.object({ input: z.number().int().min(0), output: z.number().int().min(0), cacheRead: z.number().int().min(0), cacheWrite: z.number().int().min(0) }).strict().optional()
}).strict();

const settingsSchema = z.object({ budget: budgetLimitsSchema, reviewBudget: reviewBudgetProfileSchema.default('standard') }).strict();
export interface AgentSettings {
  budget: BudgetLimits;
  reviewBudget?: ReviewBudgetProfile;
  /** Missing settings are normal; a malformed existing file is not. */
  valid: boolean;
  diagnostic?: string;
}

function defaultSettings(): AgentSettings {
  return { budget: { ...DEFAULT_BUDGET_LIMITS }, reviewBudget: 'standard', valid: true };
}

export async function loadAgentSettings(home: string): Promise<AgentSettings> {
  const path = join(home, 'web-settings.json');
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const parsed = settingsSchema.safeParse(raw);
    if (parsed.success) return { ...parsed.data, valid: true };
    return {
      budget: { ...DEFAULT_BUDGET_LIMITS },
      valid: false,
      diagnostic: '执行预算配置无效，已暂停使用该配置。请在设置中重新保存预算后再开始任务。'
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultSettings();
    return {
      budget: { ...DEFAULT_BUDGET_LIMITS },
      valid: false,
      diagnostic: '无法读取执行预算配置，已暂停使用该配置。请检查文件权限或在设置中重新保存预算。'
    };
  }
}

export async function saveAgentSettings(home: string, settings: Pick<AgentSettings, 'budget' | 'reviewBudget'>): Promise<void> {
  const parsed = settingsSchema.parse(settings);
  const path = join(home, 'web-settings.json');
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(parsed, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); await replaceMetadataFile(temporary, path); }
  finally { const { rm } = await import('node:fs/promises'); await rm(temporary, { force: true }); }
}

export class BudgetExceededError extends Error {
  constructor(reason: string) { super(reason); this.name = 'BudgetExceededError'; }
}

export class BudgetRuntime {
  private snapshotValue: BudgetSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: () => void;
  private onChange?: (snapshot: BudgetSnapshot) => void;
  private readonly observers = new Set<(snapshot: BudgetSnapshot) => void>();
  readonly limits: BudgetLimits;
  constructor(limits: BudgetLimits, onChange?: (snapshot: BudgetSnapshot) => void) {
    // Persisted settings are parsed by budgetLimitsSchema. The small merge here
    // also keeps programmatic callers and older test/integration adapters safe
    // when they construct a runtime from a pre-output-cap object.
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits, maxOutputTokens: Number.isInteger((limits as Partial<BudgetLimits>).maxOutputTokens)
      ? (limits as Partial<BudgetLimits>).maxOutputTokens! : DEFAULT_BUDGET_LIMITS.maxOutputTokens };
    this.onChange = onChange;
    this.snapshotValue = { version: 1, status: 'running', startedAt: new Date().toISOString(), limits: { ...this.limits }, modelTurns: 0, toolCalls: 0, totalTokens: 0, costUsd: 0, costIncomplete: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  start() {
    this.timer = setTimeout(() => this.exceed(`任务超过总时限 ${Math.round(this.limits.maxDurationMs / 60000)} 分钟`), this.limits.maxDurationMs);
    this.timer.unref?.();
    this.changed();
  }
  setAbort(abort: (() => void) | undefined) { this.abort = abort; if (this.snapshotValue.status === 'exceeded') abort?.(); }
  setOnChange(onChange: ((snapshot: BudgetSnapshot) => void) | undefined) { this.onChange = onChange; }
  /** Observe live usage without taking ownership of the controller callback. */
  subscribe(observer: (snapshot: BudgetSnapshot) => void): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }
  private changed() {
    const snapshot = this.snapshot();
    this.onChange?.(snapshot);
    for (const observer of this.observers) observer(structuredClone(snapshot));
  }
  private exceed(reason: string) {
    if (this.snapshotValue.status === 'exceeded') return;
    this.snapshotValue.status = 'exceeded'; this.snapshotValue.exceededReason = reason; this.snapshotValue.endedAt = new Date().toISOString();
    this.changed(); this.abort?.();
  }
  recordModelTurn(): boolean {
    if (this.snapshotValue.status !== 'running') return false;
    this.snapshotValue.modelTurns++;
    if (this.snapshotValue.modelTurns > this.limits.maxModelTurns) this.exceed(`任务超过模型回合上限 ${this.limits.maxModelTurns}`);
    this.changed(); return this.snapshotValue.status === 'running';
  }
  recordToolCall(): boolean {
    if (this.snapshotValue.status !== 'running') return false;
    this.snapshotValue.toolCalls++;
    if (this.snapshotValue.toolCalls > this.limits.maxToolCalls) this.exceed(`任务超过工具调用上限 ${this.limits.maxToolCalls}`);
    this.changed(); return this.snapshotValue.status === 'running';
  }
  recordUsage(usage: { totalTokens?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } }, pricingKnown?: boolean) {
    // Responses already in flight remain billable after cancellation or a limit.
    // Account for them without reopening the run or replacing its stop reason.
    const tokens = typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) ? Math.max(0, usage.totalTokens) : 0;
    const cost = typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total) ? Math.max(0, usage.cost.total) : 0;
    this.snapshotValue.totalTokens += Math.round(tokens); this.snapshotValue.costUsd += cost;
    if (pricingKnown === false || (tokens > 0 && pricingKnown === undefined && cost === 0)) this.snapshotValue.costIncomplete = true;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const count = usage[key];
      this.snapshotValue.usage![key] += typeof count === 'number' && Number.isFinite(count) ? Math.round(Math.max(0, count)) : 0;
    }
    if (this.snapshotValue.status === 'running') {
      if (this.limits.maxTotalTokens > 0 && this.snapshotValue.totalTokens > this.limits.maxTotalTokens) this.exceed(`任务超过显式配置的累计请求 token 上限 ${this.limits.maxTotalTokens}（含缓存读取）`);
      else if (this.snapshotValue.usage!.output > this.limits.maxOutputTokens) this.exceed(`任务超过生成 token 上限 ${this.limits.maxOutputTokens}`);
      else if (this.snapshotValue.costUsd > this.limits.maxCostUsd) this.exceed(`任务超过费用上限 $${this.limits.maxCostUsd}`);
    }
    this.changed(); return this.snapshotValue.status === 'running';
  }
  check() { if (this.snapshotValue.status === 'exceeded') throw new BudgetExceededError(this.snapshotValue.exceededReason!); }
  finish(status: 'completed' | 'aborted' | 'exceeded') {
    if (this.timer) clearTimeout(this.timer);
    if (this.snapshotValue.status !== 'exceeded') this.snapshotValue.status = status;
    this.snapshotValue.endedAt ??= new Date().toISOString(); this.changed();
  }
  snapshot(): BudgetSnapshot { return structuredClone(this.snapshotValue); }
  get exceededReason() { return this.snapshotValue.exceededReason; }
}
