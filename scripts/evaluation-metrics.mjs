/** Keep every attempted run visible; unknown pricing must remain unknown. */
export function summarizeWorkflows(results, workflows, pricingKnown) {
  return Object.fromEntries(workflows.map((workflow) => {
    const runs = results.filter((item) => item.workflow === workflow), executed = runs.filter((item) => !item.skipped);
    const completed = executed.filter((item) => item.completed ?? item.taskCompletion).length;
    const falseCompletions = executed.filter((item) => item.falseCompletion).length;
    const latencies = executed.map((item) => item.executionMs ?? item.latencyMs ?? item.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const sum = (field) => executed.reduce((total, item) => total + (item[field] ?? 0), 0);
    const budgetSum = (field) => executed.reduce((total, item) => total + (item.budget?.[field] ?? item.executionBudget?.[field] ?? item[field] ?? 0), 0);
    return [workflow, {
      total: runs.length, executed: executed.length, validationSkipped: runs.length - executed.length,
      passed: executed.filter((item) => item.passed ?? item.qualityPass).length, completed,
      falseCompletions, falseCompletionRate: completed ? falseCompletions / completed : null,
      infrastructureFailures: executed.filter((item) => item.infrastructureFailure).length,
      p50ExecutionMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      p95ExecutionMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * .95))] : null,
      totalTokens: budgetSum('totalTokens'), outputTokens: executed.reduce((sum, item) => sum + (item.budget?.usage?.output ?? item.executionBudget?.usage?.output ?? item.outputTokens ?? item.budget?.outputTokens ?? item.executionBudget?.outputTokens ?? 0), 0),
      costUsd: pricingKnown ? budgetSum('costUsd') : null,
      reviewCalls: sum('reviewCalls'), reviewRepairs: sum('reviewRepairs'), reviewFormatRetries: sum('reviewFormatRetries')
    }];
  }));
}
