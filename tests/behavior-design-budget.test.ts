import { describe, expect, it } from 'vitest';
import { BudgetRuntime, DEFAULT_BUDGET_LIMITS } from '../src/task/budget.js';
import { capDesignPayload, designAllowance } from '../src/task/behavior-design-budget.js';
const budget = () => new BudgetRuntime({ ...DEFAULT_BUDGET_LIMITS, maxOutputTokens: 16_000, maxModelTurns: 12 }).snapshot();
describe('behavioral designer output headroom', () => {
  it('closes on observed output while keeping the hard ledgers unchanged', () => {
    const local = budget(), parent = budget();
    expect(designAllowance(local, parent)).toEqual({ close: false, remaining: 16_000, response: 2_000 });
    local.usage!.output = 8_000;
    expect(designAllowance(local, parent)).toEqual({ close: true, remaining: 8_000, response: 6_000 });
    expect(local.limits.maxOutputTokens).toBe(16_000);
  });
  it('respects the smaller parent remainder and leaves model turns for finalization', () => {
    const local = budget(), parent = budget(); parent.usage!.output = 14_500;
    expect(designAllowance(local, parent)).toEqual({ close: true, remaining: 1_500, response: 1_500 });
    parent.usage!.output = 0; local.modelTurns = 11;
    expect(designAllowance(local, parent).close).toBe(true);
    local.modelTurns = 0; parent.modelTurns = 11;
    expect(designAllowance(local, parent).close).toBe(true);
    parent.modelTurns = 0; local.toolCalls = 10;
    expect(designAllowance(local, parent).close).toBe(true);
  });
  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])('clamps an existing %s without raising a smaller Provider ceiling', key => {
    const payload = { [key]: 32_768, messages: [{ role: 'user', content: 'task' }], thinking_token_budget: 8_192 };
    expect(capDesignPayload(payload, 2_000)).toEqual({ ...payload, [key]: 2_000, thinking_token_budget: 1_488 });
    expect(payload[key]).toBe(32_768);
    expect(capDesignPayload({ [key]: 1_024, thinking_token_budget: 8_192 }, 2_000)).toEqual({ [key]: 1_024, thinking_token_budget: 512 });
    expect(capDesignPayload({ [key]: 10_000, tools: ['stale'], tool_choice: 'required' }, 2_000, true)).toEqual({ [key]: 2_000 });
    expect(() => capDesignPayload({ [key]: 10_000 }, 0)).toThrow('no remaining output');
  });
  it('does not invent wire fields for other protocols or exceed observed remaining output', () => {
    const payload = { generationConfig: { maxOutputTokens: 10_000 } };
    expect(capDesignPayload(payload, 2_000)).toBe(payload);
    const local = budget(), parent = budget(); local.usage!.output = 16_100;
    expect(designAllowance(local, parent)).toEqual({ close: true, remaining: 0, response: 0 });
  });
});
