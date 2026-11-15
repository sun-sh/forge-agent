import { z } from 'zod';

const ms = z.number().finite().min(0);
const count = z.number().int().min(0);
export const REVIEW_CALL_ENTRY = 'forge.review_call';
export const REVIEW_SLOW_CALL_MS = 60_000;
export const reviewCallSchema = z.object({
  sequence: count.min(1).max(256), turn: count, startedAt: z.iso.datetime(),
  outcome: z.enum(['running', 'completed', 'error', 'cancelled', 'budget_exhausted', 'interrupted', 'superseded']),
  elapsedMs: ms, durationMs: ms.nullable(), headersMs: ms.nullable(), firstStreamMs: ms.nullable(), firstContentMs: ms.nullable(),
  payloadBytes: count.nullable(), httpStatus: z.number().int().min(100).max(599).optional(),
  usage: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }).strict().optional()
}).strict().superRefine((call, ctx) => {
  const finished = ['completed', 'error'].includes(call.outcome);
  if (finished !== (call.durationMs !== null) || call.durationMs !== null && call.durationMs !== call.elapsedMs
    || [call.headersMs, call.firstStreamMs, call.firstContentMs].some(value => value !== null && value > call.elapsedMs))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent observed call timing' });
});
export type ReviewCall = z.infer<typeof reviewCallSchema>;
export const reviewTelemetrySchema = z.object({
  version: z.literal(1), source: z.literal('pi-provider-hooks'), handoffCharacters: count,
  droppedCalls: count, calls: z.array(reviewCallSchema).max(256)
}).strict();
export type ReviewTelemetry = z.infer<typeof reviewTelemetrySchema>;
export const reviewCallEntrySchema = z.object({ version: z.literal(1), parentId: z.uuid(), childId: z.uuid(), call: reviewCallSchema }).strict();
export function newReviewTelemetry(handoffCharacters: number): ReviewTelemetry {
  return { version: 1, source: 'pi-provider-hooks', handoffCharacters, droppedCalls: 0, calls: [] };
}

/** Observe Pi requests; never wrap/retry transport or retain payload/header/content values. */
export class ReviewCallTelemetry {
  private active?: { call: ReviewCall; start: number };
  constructor(readonly log: ReviewTelemetry, private save: (call: ReviewCall) => void, private clock = () => performance.now()) {}
  private elapsed() { return Math.max(0, Math.round(this.clock() - this.active!.start)); }
  private emit() { if (this.active) this.save(structuredClone(reviewCallSchema.parse(this.active.call))); }
  start(turn: number, payload: unknown) {
    this.finish('superseded');
    if (this.log.calls.length === 256) { this.log.droppedCalls++; return; }
    let payloadBytes: number | null = null;
    try { const serialized = JSON.stringify(payload); if (serialized !== undefined) payloadBytes = Buffer.byteLength(serialized, 'utf8'); } catch { /* Size unavailable; never persist the payload. */ }
    const call: ReviewCall = { sequence: this.log.calls.length + 1, turn, startedAt: new Date().toISOString(), outcome: 'running',
      elapsedMs: 0, durationMs: null, headersMs: null, firstStreamMs: null, firstContentMs: null, payloadBytes };
    this.log.calls.push(call); this.active = { call, start: this.clock() }; this.emit();
  }
  headers(status: number) {
    if (!this.active) return;
    const call = this.active.call; call.elapsedMs = this.elapsed(); call.headersMs ??= call.elapsedMs;
    if (Number.isInteger(status) && status >= 100 && status <= 599) call.httpStatus ??= status;
    this.emit();
  }
  stream(content = false) {
    if (!this.active) return;
    const call = this.active.call;
    if (call.firstStreamMs !== null && (!content || call.firstContentMs !== null)) return;
    call.elapsedMs = this.elapsed(); call.firstStreamMs ??= call.elapsedMs;
    if (content) call.firstContentMs ??= call.elapsedMs;
    this.emit();
  }
  finish(outcome: Exclude<ReviewCall['outcome'], 'running'>, usage?: unknown) {
    if (!this.active) return;
    const call = this.active.call; call.elapsedMs = this.elapsed(); call.outcome = outcome;
    call.durationMs = outcome === 'completed' || outcome === 'error' ? call.elapsedMs : null;
    if (usage && typeof usage === 'object') {
      const source = usage as Record<string, unknown>;
      const parsed = reviewCallSchema.shape.usage.safeParse({ input: source['input'], output: source['output'], cacheRead: source['cacheRead'], cacheWrite: source['cacheWrite'] });
      if (parsed.success) call.usage = parsed.data;
    }
    this.emit(); this.active = undefined;
  }
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, medianMs: !n ? null : n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2,
    p90Ms: n ? sorted[Math.ceil(n * .9) - 1]! : null, maxMs: n ? sorted[n - 1]! : null };
}
export function summarizeReviewTelemetry(log: ReviewTelemetry | undefined) {
  if (!log) return undefined; // Never infer per-call observations from old total durations/turn counts.
  const completed = log.calls.filter(call => call.outcome === 'completed');
  const successful = distribution(completed.map(call => call.durationMs!));
  const censored = log.calls.filter(call => !['completed', 'error'].includes(call.outcome));
  return { source: log.source, observedCalls: log.calls.length, droppedCalls: log.droppedCalls, successful,
    errors: distribution(log.calls.filter(call => call.outcome === 'error').map(call => call.durationMs!)),
    headers: distribution(log.calls.flatMap(call => call.headersMs === null ? [] : [call.headersMs])),
    firstContent: distribution(log.calls.flatMap(call => call.firstContentMs === null ? [] : [call.firstContentMs])),
    censoredCalls: censored.length, longCensoredCalls: censored.filter(call => call.elapsedMs > REVIEW_SLOW_CALL_MS).length,
    priority: successful.medianMs !== null && successful.medianMs > REVIEW_SLOW_CALL_MS ? 'investigate_call_latency' as const
      : !successful.count || censored.length || log.droppedCalls ? 'collect_more_data' as const : 'no_slow_call_signal' as const };
}
