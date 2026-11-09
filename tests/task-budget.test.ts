import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetRuntime, budgetLimitsSchema, DEFAULT_BUDGET_LIMITS, loadAgentSettings } from '../src/task/budget.js';

const limits = { ...DEFAULT_BUDGET_LIMITS, maxDurationMs: 60_000, maxModelTurns: 2, maxToolCalls: 2, maxTotalTokens: 100, maxCostUsd: 1 };

describe('host execution budgets', () => {
  it('does not silently widen a malformed persisted budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-budget-settings-'));
    await writeFile(join(home, 'web-settings.json'), JSON.stringify({ budget: { maxCostUsd: 0.1 } }));
    const settings = await loadAgentSettings(home);
    expect(settings.valid).toBe(false);
    expect(settings.diagnostic).toContain('重新保存');
    expect(settings.budget.maxCostUsd).toBe(DEFAULT_BUDGET_LIMITS.maxCostUsd);
  });

  it('counts model turns and tool calls and exposes an explicit stop reason', () => {
    const budget = new BudgetRuntime(limits);
    let aborted = 0;
    budget.setAbort(() => { aborted++; }); budget.start();
    expect(budget.recordModelTurn()).toBe(true);
    expect(budget.recordModelTurn()).toBe(true);
    expect(budget.recordModelTurn()).toBe(false);
    expect(budget.snapshot()).toMatchObject({ status: 'exceeded', modelTurns: 3, exceededReason: '任务超过模型回合上限 2' });
    expect(aborted).toBe(1);
    budget.finish('exceeded');
  });

  it('stops on reported token or cost usage and keeps a durable snapshot', () => {
    const budget = new BudgetRuntime(limits); budget.start();
    expect(budget.recordUsage({ totalTokens: 50, cost: { total: 0.25 } })).toBe(true);
    expect(budget.recordUsage({ totalTokens: 60, cost: { total: 0.25 } })).toBe(false);
    expect(budget.snapshot()).toMatchObject({ status: 'exceeded', totalTokens: 110, costUsd: 0.5, exceededReason: '任务超过显式配置的累计请求 token 上限 100（含缓存读取）' });
    budget.finish('exceeded');
  });

  it('supports live observers without replacing the controller callback', () => {
    const budget = new BudgetRuntime(limits);
    const controllerSnapshots: string[] = [];
    const liveSnapshots: number[] = [];
    budget.setOnChange((snapshot) => controllerSnapshots.push(snapshot.status));
    const stop = budget.subscribe((snapshot) => liveSnapshots.push(snapshot.modelTurns));
    budget.start();
    budget.recordModelTurn();
    stop();
    budget.recordModelTurn();
    expect(controllerSnapshots).toContain('running');
    expect(liveSnapshots).toEqual([0, 1]);
    budget.finish('completed');
  });
  it('records late in-flight usage and token categories after a limit without re-aborting or losing the original reason', () => {
    const budget = new BudgetRuntime(limits); let aborts = 0; budget.setAbort(() => aborts++); budget.start();
    budget.recordUsage({ totalTokens: 101, input: 10, output: 1, cacheRead: 90, cost: { total: 0 } }, false);
    const reason = budget.exceededReason;
    expect(budget.recordUsage({ totalTokens: 40, input: 5, output: 5, cacheRead: 30, cost: { total: 2 } }, true)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ status: 'exceeded', totalTokens: 141, costUsd: 2, costIncomplete: true, exceededReason: reason, usage: { input: 15, output: 6, cacheRead: 120, cacheWrite: 0 } });
    expect(aborts).toBe(1); budget.finish('exceeded');
  });

  it('does not stop the default run because cached request context is large', () => {
    const budget = new BudgetRuntime({ ...DEFAULT_BUDGET_LIMITS }); budget.start();
    expect(budget.recordUsage({ totalTokens: 5_000_000, input: 20_000, output: 500, cacheRead: 4_979_500, cost: { total: 0 } }, false)).toBe(true);
    expect(budget.snapshot()).toMatchObject({ status: 'running', totalTokens: 5_000_000, usage: { output: 500, cacheRead: 4_979_500 } });
    budget.finish('completed');
  });

  it('uses generated output as the default token safety guard', () => {
    const budget = new BudgetRuntime({ ...DEFAULT_BUDGET_LIMITS, maxOutputTokens: 1_000 }); budget.start();
    expect(budget.recordUsage({ totalTokens: 2_000, output: 1_000, cost: { total: 0 } })).toBe(true);
    expect(budget.recordUsage({ totalTokens: 2_000, output: 1, cost: { total: 0 } })).toBe(false);
    expect(budget.snapshot().exceededReason).toBe('任务超过生成 token 上限 1000');
    budget.finish('exceeded');
  });

  it('migrates an older saved budget by adding the output cap while keeping its explicit cumulative guard', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-budget-migration-'));
    await writeFile(join(home, 'web-settings.json'), JSON.stringify({ budget: { ...DEFAULT_BUDGET_LIMITS, maxOutputTokens: undefined, maxTotalTokens: 1_000_000 } }));
    const settings = await loadAgentSettings(home);
    expect(settings.valid).toBe(true);
    expect(settings.budget).toMatchObject({ maxTotalTokens: 1_000_000, maxOutputTokens: 200_000 });
  });

  it('accepts zero or a meaningful explicit cumulative guard, not tiny accidental limits', () => {
    expect(() => budgetLimitsSchema.parse({ ...DEFAULT_BUDGET_LIMITS, maxTotalTokens: 0 })).not.toThrow();
    expect(() => budgetLimitsSchema.parse({ ...DEFAULT_BUDGET_LIMITS, maxTotalTokens: 999 })).toThrow();
    expect(() => budgetLimitsSchema.parse({ ...DEFAULT_BUDGET_LIMITS, maxTotalTokens: 1_000 })).not.toThrow();
  });
  it('accounts for usage after cancellation without converting it into a new budget failure', () => {
    const budget = new BudgetRuntime(limits); budget.finish('aborted');
    expect(budget.recordUsage({ totalTokens: 1000, output: 1000, cost: { total: 3 } }, true)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ status: 'aborted', totalTokens: 1000, costUsd: 3, costIncomplete: false });
  });
});
