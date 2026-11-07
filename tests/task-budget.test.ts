import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS, loadAgentSettings } from '../src/task/budget.js';

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
    expect(budget.snapshot()).toMatchObject({ status: 'exceeded', totalTokens: 110, costUsd: 0.5, exceededReason: '任务超过 token 上限 100' });
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
});
