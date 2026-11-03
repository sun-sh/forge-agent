import type { RuntimeEvent, Usage } from "../protocol.js";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

export interface RunMetrics {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  approvalRequests: number;
  usage: UsageTotals;
  completedSteps: number;
  blockedSteps: number;
}

const MODEL_PRICES: Array<{ match: RegExp; input: number; output: number; cacheRead?: number }> = [
  { match: /gpt-5|codex/i, input: 1.25, output: 10, cacheRead: 0.125 },
  { match: /opus/i, input: 15, output: 75, cacheRead: 1.5 },
  { match: /sonnet/i, input: 3, output: 15, cacheRead: 0.3 },
  { match: /deepseek/i, input: 0.28, output: 0.42, cacheRead: 0.028 },
  { match: /gemini.*pro/i, input: 1.25, output: 10, cacheRead: 0.31 }
];

function price(model: string): { input: number; output: number; cacheRead: number } {
  const found = MODEL_PRICES.find((entry) => entry.match.test(model));
  return found ? { input: found.input, output: found.output, cacheRead: found.cacheRead ?? found.input } : { input: 0, output: 0, cacheRead: 0 };
}

export function estimateCost(model: string, usage: Usage): number {
  const value = price(model);
  return (usage.inputTokens / 1_000_000) * value.input
    + (usage.outputTokens / 1_000_000) * value.output
    + ((usage.cacheReadTokens ?? 0) / 1_000_000) * value.cacheRead;
}

export class MetricsCollector {
  private readonly started = performance.now();
  readonly metrics: RunMetrics = {
    startedAt: new Date().toISOString(),
    turns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    approvalRequests: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    completedSteps: 0,
    blockedSteps: 0
  };

  addUsage(model: string, usage: Usage): void {
    this.metrics.usage.inputTokens += usage.inputTokens;
    this.metrics.usage.outputTokens += usage.outputTokens;
    this.metrics.usage.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.metrics.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.metrics.usage.estimatedCostUsd += estimateCost(model, usage);
  }

  record(event: RuntimeEvent): void {
    switch (event.type) {
      case "turn_start": this.metrics.turns++; break;
      case "tool_call_start": this.metrics.toolCalls++; break;
      case "tool_call_end": if (event.result.isError) this.metrics.failedToolCalls++; break;
      case "approval_request": this.metrics.approvalRequests++; break;
      default: break;
    }
  }

  finish(): RunMetrics {
    this.metrics.finishedAt = new Date().toISOString();
    this.metrics.durationMs = Math.round(performance.now() - this.started);
    this.metrics.usage.estimatedCostUsd = Number(this.metrics.usage.estimatedCostUsd.toFixed(6));
    return structuredClone(this.metrics);
  }
}

export function formatMetrics(metrics: RunMetrics): string {
  const usage = metrics.usage;
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return [
    `time ${((metrics.durationMs ?? 0) / 1000).toFixed(1)}s`,
    `turns ${metrics.turns}`,
    `tools ${metrics.toolCalls}${metrics.failedToolCalls ? ` (${metrics.failedToolCalls} failed)` : ""}`,
    `tokens ${tokens} (in ${usage.inputTokens}, out ${usage.outputTokens}, cache ${usage.cacheReadTokens})`,
    usage.estimatedCostUsd > 0 ? `est. $${usage.estimatedCostUsd.toFixed(4)}` : "est. cost n/a"
  ].join(" · ");
}
