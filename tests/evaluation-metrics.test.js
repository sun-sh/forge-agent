import { describe, expect, it } from 'vitest';
import { summarizeWorkflows } from '../scripts/evaluation-metrics.mjs';

describe('workflow ablation metrics', () => {
  it('keeps failed and skipped runs visible, uses completed runs for false-completion rate and retains unknown cost', () => {
    const report = summarizeWorkflows([
      { workflow: 'direct', completed: true, falseCompletion: true, passed: false, latencyMs: 200, budget: { totalTokens: 12, outputTokens: 3, costUsd: 0 } },
      { workflow: 'direct', completed: false, passed: false, infrastructureFailure: true, latencyMs: 100 },
      { workflow: 'direct', skipped: true, infrastructureFailure: true },
      { workflow: 'planned', taskCompletion: true, qualityPass: true, durationMs: 400, reviewCalls: 2, reviewRepairs: 1, reviewFormatRetries: 1, executionBudget: { totalTokens: 40, outputTokens: 8 } },
      { workflow: 'planned-no-review', passed: true, completed: true, executionMs: 250 }
    ], ['direct', 'planned', 'planned-no-review'], false);
    expect(report.direct).toMatchObject({ total: 3, executed: 2, validationSkipped: 1, completed: 1, falseCompletions: 1, falseCompletionRate: 1, infrastructureFailures: 1, totalTokens: 12, outputTokens: 3, costUsd: null });
    expect(report.planned).toMatchObject({ passed: 1, reviewCalls: 2, reviewRepairs: 1, reviewFormatRetries: 1, totalTokens: 40, outputTokens: 8, p50ExecutionMs: 400 });
    expect(report['planned-no-review']).toMatchObject({ passed: 1, reviewCalls: 0, falseCompletionRate: 0 });
    expect(summarizeWorkflows([], ['planned'], true).planned).toMatchObject({ executed: 0, falseCompletionRate: null, p50ExecutionMs: null, costUsd: 0 });
  });
});
