import { describe, expect, it } from "vitest";
import { MetricsCollector, estimateCost, formatMetrics } from "../src/observability/metrics.js";

describe("run metrics", () => {
  it("accumulates usage and estimates known model cost", () => {
    const collector = new MetricsCollector();
    collector.addUsage("anthropic/claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 });
    expect(collector.metrics.usage.inputTokens).toBe(1_000_000);
    expect(collector.metrics.usage.estimatedCostUsd).toBeCloseTo(4.65, 4);
    expect(estimateCost("unknown-model", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it("counts events and failed tools", () => {
    const collector = new MetricsCollector();
    collector.record({ type: "turn_start", turn: 1 });
    collector.record({ type: "tool_call_start", callId: "1", name: "shell", input: {} });
    collector.record({ type: "tool_call_end", callId: "1", name: "shell", durationMs: 4, result: { isError: true, content: [] } });
    const metrics = collector.finish();
    expect(metrics.turns).toBe(1);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.failedToolCalls).toBe(1);
    expect(formatMetrics(metrics)).toContain("tools 1 (1 failed)");
  });
});
