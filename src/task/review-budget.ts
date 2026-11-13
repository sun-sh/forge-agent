import { z } from 'zod';

export const reviewBudgetProfileSchema = z.enum(['standard', 'extended']);
export type ReviewBudgetProfile = z.infer<typeof reviewBudgetProfileSchema>;
/** Standard remains the measured historical ceiling; larger losses require opt-in. */
export const REVIEW_BUDGETS = {
  standard: { maxDurationMs: 300_000, maxModelTurns: 24, maxToolCalls: 120, maxOutputTokens: 32_000, maxCostUsd: 4 },
  extended: { maxDurationMs: 480_000, maxModelTurns: 40, maxToolCalls: 160, maxOutputTokens: 48_000, maxCostUsd: 6 }
} as const;
