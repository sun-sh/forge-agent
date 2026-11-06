import { describe, expect, it } from 'vitest';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS } from '../src/task/budget.js';

const limits = { ...DEFAULT_BUDGET_LIMITS, maxDurationMs: 60_000, maxModelTurns: 2, maxToolCalls: 2, maxTotalTokens: 100, maxCostUsd: 1 };

describe('host execution budgets', () => {
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
});
