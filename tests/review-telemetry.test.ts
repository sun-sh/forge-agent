import { describe, expect, it } from 'vitest';
import { newReviewTelemetry, ReviewCallTelemetry, reviewCallSchema, reviewTelemetrySchema, summarizeReviewTelemetry } from '../src/task/review-telemetry.js';

describe('observed reviewer provider-call timing', () => {
  it('measures distinct milestones with monotonic time and never retains input content', () => {
    let now = 100; const saved: unknown[] = [], log = newReviewTelemetry(123);
    const timer = new ReviewCallTelemetry(log, call => saved.push(call), () => now);
    timer.start(1, { messages: ['DO_NOT_STORE_INPUT'], apiKey: 'DO_NOT_STORE_CREDENTIAL', endpoint: 'DO_NOT_STORE_ENDPOINT' });
    now += 10; timer.headers(200); now += 20; timer.stream(); now += 40; timer.stream(true);
    now += 930; timer.finish('completed', { input: 20, output: 10, cacheRead: 5, cacheWrite: 0 });
    expect(log.calls[0]).toMatchObject({ sequence: 1, turn: 1, outcome: 'completed', elapsedMs: 1000, durationMs: 1000, headersMs: 10, firstStreamMs: 30, firstContentMs: 70, usage: { output: 10 } });
    expect(log.calls[0]!.payloadBytes).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toMatch(/DO_NOT_STORE/);
    expect(reviewTelemetrySchema.safeParse(log).success).toBe(true);
  });
  it('excludes tool/setup gaps and computes an ordinary even-sample median', () => {
    let now = 0; const log = newReviewTelemetry(1), timer = new ReviewCallTelemetry(log, () => {}, () => now);
    for (const duration of [50_000, 80_000]) { timer.start(log.calls.length + 1, {}); now += duration; timer.finish('completed'); now += 900_000; }
    expect(summarizeReviewTelemetry(log)).toMatchObject({ observedCalls: 2, successful: { count: 2, medianMs: 65_000, p90Ms: 80_000 }, priority: 'investigate_call_latency' });
    expect(log.calls.map(call => call.durationMs)).toEqual([50_000, 80_000]);
  });
  it.each(['cancelled', 'budget_exhausted', 'superseded', 'interrupted'] as const)('retains %s as censored, not a completed slow call', reason => {
    let now = 0; const log = newReviewTelemetry(1), timer = new ReviewCallTelemetry(log, () => {}, () => now);
    timer.start(1, {}); now = 200_000; timer.finish(reason);
    expect(log.calls[0]).toMatchObject({ outcome: reason, elapsedMs: 200_000, durationMs: null });
    expect(summarizeReviewTelemetry(log)).toMatchObject({ successful: { count: 0, medianMs: null }, censoredCalls: 1, longCensoredCalls: 1, priority: 'collect_more_data' });
  });
  it('keeps errors out of the successful-call distribution and preserves a superseded request', () => {
    let now = 0; const log = newReviewTelemetry(1), timer = new ReviewCallTelemetry(log, () => {}, () => now);
    timer.start(1, {}); now += 1; timer.headers(429); timer.finish('error');
    timer.start(2, {}); now += 100; timer.start(2, {}); now += 61_000; timer.finish('completed');
    expect(log.calls.map(call => call.outcome)).toEqual(['error', 'superseded', 'completed']);
    expect(summarizeReviewTelemetry(log)).toMatchObject({ errors: { count: 1, medianMs: 1 }, successful: { count: 1, medianMs: 61_000 }, censoredCalls: 1, priority: 'investigate_call_latency' });
  });
  it('does not reconstruct old timings or call an exactly-60s median slow', () => {
    expect(summarizeReviewTelemetry(undefined)).toBeUndefined();
    let now = 0; const log = newReviewTelemetry(1), timer = new ReviewCallTelemetry(log, () => {}, () => now);
    timer.start(1, {}); now = 60_000; timer.finish('completed');
    expect(summarizeReviewTelemetry(log)?.priority).toBe('no_slow_call_signal');
  });
  it('bounds diagnostic history without altering the model budget', () => {
    const log = newReviewTelemetry(1), timer = new ReviewCallTelemetry(log, () => {}, () => 0);
    for (let index = 0; index < 260; index++) { timer.start(index + 1, {}); timer.finish('completed'); }
    expect(log.calls).toHaveLength(256); expect(log.droppedCalls).toBe(4);
    expect(summarizeReviewTelemetry(log)?.priority).toBe('collect_more_data');
    expect(reviewCallSchema.safeParse({ ...log.calls[0], outcome: 'budget_exhausted', durationMs: 0 }).success).toBe(false);
    expect(reviewCallSchema.safeParse({ ...log.calls[0], headers: { authorization: 'not allowed' } }).success).toBe(false);
  });
});
