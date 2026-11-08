import { createHash } from 'node:crypto';
import { z } from 'zod';

export const progressSnapshotSchema = z.object({
  version: z.literal(1), status: z.enum(['active', 'warned', 'stalled']),
  observations: z.number().int().min(0), unchanged: z.number().int().min(0), warnings: z.number().int().min(0),
  reason: z.string().max(1000).optional()
}).strict();
export type ProgressSnapshot = z.infer<typeof progressSnapshotSchema>;
export class TaskStalledError extends Error {}
const NOTICE = 'Repeated tool calls have returned unchanged evidence. Stop rereading the same inputs. State the unresolved question and change the search, hypothesis or implementation strategy. Do not invent progress or passing verification.';
// Stable fingerprints stay in memory only; snapshots contain no tool arguments or output.
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}

/** Detect repeated evidence, never infer a stall from elapsed time alone. */
export class TaskProgress {
  private state: ProgressSnapshot = { version: 1, status: 'active', observations: 0, unchanged: 0, warnings: 0 };
  private seen = new Set<string>();
  private phase?: string;
  constructor(private readonly changed: (snapshot: ProgressSnapshot) => void = () => {}) {}
  snapshot(): ProgressSnapshot { return structuredClone(this.state); }
  begin(publish = true) { this.state = { version: 1, status: 'active', observations: 0, unchanged: 0, warnings: 0 }; this.seen.clear(); this.phase = undefined; if (publish) this.changed(this.snapshot()); }
  check() { if (this.state.status === 'stalled') throw new TaskStalledError(this.state.reason); }
  observe(event: { toolName: string; input: unknown; content: unknown; structuredContent?: unknown; isError: boolean }, phase = '') {
    if (this.state.status === 'stalled') return;
    if (phase !== this.phase) { this.phase = phase; this.seen.clear(); this.state.unchanged = 0; this.state.status = 'active'; delete this.state.reason; }
    this.state.observations++;
    {
      const key = createHash('sha256').update(stable([event.toolName, event.input, event.isError, event.content, event.structuredContent])).digest('hex');
      if (this.seen.has(key)) this.state.unchanged++;
      else { this.state.unchanged = 0; this.state.status = 'active'; delete this.state.reason; }
      this.seen.add(key); if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
      // Different successful writes are evidence of a changed strategy. Identical shell/edit
      // successes are still repetitions; success alone must not erase the observation history.
      if (this.state.unchanged === 6) {
        this.state.status = 'warned'; this.state.warnings++;
        this.state.reason = '多次工具调用没有产生新证据，已提醒模型调整策略。';
        this.changed(this.snapshot()); return NOTICE;
      }
      if (this.state.unchanged >= 12) { this.state.status = 'stalled'; this.state.reason = '连续重复相同证据或错误，提醒后仍未调整策略。已停止本次执行，请检查后重新继续。'; }
    }
    this.changed(this.snapshot());
  }
}
