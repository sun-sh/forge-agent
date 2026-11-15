import type { BudgetSnapshot } from './budget.js';

export const DESIGN_READ_LIMIT = 10;
export const DESIGN_EXPLORATION_OUTPUT = 8_000;
export const DESIGN_RESPONSE_OUTPUT = 2_000;
export const DESIGN_FINAL_OUTPUT = 6_000;

/** Soft collection boundary inside the existing hard ledgers, not another loop. */
export function designAllowance(local: BudgetSnapshot, parent: BudgetSnapshot) {
  const remaining = Math.max(0, Math.min(local.limits.maxOutputTokens - (local.usage?.output ?? 0), parent.limits.maxOutputTokens - (parent.usage?.output ?? 0)));
  const close = local.toolCalls >= DESIGN_READ_LIMIT || (local.usage?.output ?? 0) >= DESIGN_EXPLORATION_OUTPUT
    || local.modelTurns >= local.limits.maxModelTurns - 1 || parent.modelTurns >= parent.limits.maxModelTurns - 1
    || remaining <= DESIGN_FINAL_OUTPUT;
  return { close, remaining, response: Math.min(remaining, close ? DESIGN_FINAL_OUTPUT : DESIGN_RESPONSE_OUTPUT) };
}

/** Only clamp fields already emitted by Pi's OpenAI-compatible adapters. */
export function capDesignPayload(payload: unknown, maximum: number, finalize = false, api = 'openai-completions'): unknown {
  if (!['openai-completions', 'openai-responses'].includes(api)) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const value = payload as Record<string, unknown>;
  const keys = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) > 0);
  if (!keys.length) return payload; // Other protocols retain native limits; no invented wire fields.
  const result = { ...value };
  if (finalize) { delete result['tools']; delete result['tool_choice']; delete result['parallel_tool_calls']; }
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error('Behavioral designer has no remaining output allowance; no Provider request was sent.');
  const cap = Math.min(Math.floor(maximum), ...keys.map(key => value[key] as number));
  for (const key of keys) result[key] = Math.min(value[key] as number, cap);
  // Pi-compatible services may expose an explicit reasoning allowance as well.
  if (typeof result['thinking_token_budget'] === 'number') result['thinking_token_budget'] = Math.min(result['thinking_token_budget'], Math.max(0, cap - 512));
  return result;
}
