import { taskStateSchema, type TaskState, type TaskStatus } from './controller.js';

export interface TimelineEntry { type: string; id?: string; timestamp?: string; customType?: string; data?: unknown; message?: unknown; }
export interface ExecutionNode {
  id: string; parentId?: string; kind: 'task' | 'phase' | 'model' | 'tool' | 'check'; label: string;
  status: TaskStatus | 'unconfirmed'; source: 'host' | 'pi';
  startedAt?: string; endedAt?: string; durationMs?: number; timing?: 'host' | 'message_interval';
  tokens?: number; attempt?: number; freshness?: string; evidenceId?: string;
}
export interface ExecutionTimeline {
  version: 1; taskId: string; nodes: ExecutionNode[];
  edges: Array<{ from: string; to: string; kind: 'contains' | 'next' | 'retry' }>;
  truncated: boolean; readOnly: true;
}

const MAX_NODES = 1600;
const date = (value: unknown): string | undefined => {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? new Date(ms).toISOString() : undefined;
};
const duration = (start?: string, end?: string) => start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : undefined;
function taskAt(entry: TimelineEntry): TaskState | undefined {
  if (entry.type !== 'custom' || entry.customType !== 'pforge.task') return undefined;
  return taskStateSchema.safeParse(entry.data).data;
}

/** Read-only projection of the active Pi branch. No second journal, dispatch or side-effect replay. */
export function executionTimeline(entries: readonly TimelineEntry[], options: { taskId?: string; activeTaskId?: string } = {}): ExecutionTimeline | undefined {
  const snapshots = entries.flatMap((entry, index) => { const task = taskAt(entry); return task ? [{ task, index }] : []; });
  const taskId = options.taskId ?? snapshots.at(-1)?.task.id;
  const history = snapshots.filter((item) => item.task.id === taskId);
  if (!history.length) return undefined;
  const task = history.at(-1)!.task;
  const active = options.activeTaskId === task.id && task.status === 'running';
  const status = task.status === 'running' && !active ? 'interrupted' : task.status;
  const result: ExecutionTimeline = { version: 1, taskId: task.id, nodes: [], edges: [], truncated: false, readOnly: true };
  const nodes = new Map<string, ExecutionNode>();
  const add = (node: ExecutionNode) => {
    const existing = nodes.get(node.id); if (existing) return existing;
    if (nodes.size >= MAX_NODES) { result.truncated = true; return undefined; }
    nodes.set(node.id, node); result.nodes.push(node);
    if (node.parentId && nodes.has(node.parentId)) result.edges.push({ from: node.parentId, to: node.id, kind: 'contains' });
    return node;
  };
  const endedAt = !active ? task.phases.at(-1)?.endedAt : undefined;
  add({ id: task.id, kind: 'task', label: 'execution', status, source: 'host', startedAt: task.startedAt, ...(endedAt ? { endedAt, durationMs: duration(task.startedAt, endedAt), timing: 'host' as const } : {}), tokens: task.budget?.totalTokens });
  const phaseId = (index: number) => task.id + ':phase:' + index;
  const attempts = new Map<string, number>();
  for (const [index, phase] of task.phases.entries()) {
    const attempt = (attempts.get(phase.phase) ?? 0) + 1; attempts.set(phase.phase, attempt);
    const last = index === task.phases.length - 1;
    const phaseStatus = phase.phase === 'complete' ? status : !last ? 'completed' : active ? 'running' : status;
    add({ id: phaseId(index), parentId: task.id, kind: 'phase', label: phase.phase, status: phaseStatus, source: 'host', startedAt: phase.startedAt, endedAt: phase.endedAt, durationMs: duration(phase.startedAt, phase.endedAt), timing: 'host', attempt });
    if (index) result.edges.push({ from: phaseId(index - 1), to: phaseId(index), kind: phase.phase === 'implement' && attempt > 1 ? 'retry' : 'next' });
  }
  // The delivery reviewer runs in a fresh Pi sub-session, so it has no
  // assistant message in the parent branch to project. Record the host-owned
  // reviewer handoff explicitly instead of pretending it was another parent
  // model turn. The durable reviewer id keeps this projection stable after a
  // restart and across repeated timeline reads.
  for (const { task: observed } of history) {
    if (!observed.reviewer) continue;
    const reviewIndex = observed.phases.reduce((latest, phase, index) => phase.phase === 'review' ? index : latest, -1);
    if (reviewIndex >= 0) {
      const reviewPhase = task.phases[reviewIndex]!;
      add({
        id: task.id + ':reviewer:' + observed.reviewer.sessionId,
        parentId: phaseId(reviewIndex),
        kind: 'model',
        label: 'independent reviewer',
        status: 'completed',
        source: 'pi',
        startedAt: reviewPhase.startedAt,
        endedAt: reviewPhase.endedAt,
        durationMs: duration(reviewPhase.startedAt, reviewPhase.endedAt),
        timing: 'host'
      });
    }
  }
  const start = history[0]!.index;
  const end = snapshots.find((item) => item.index > start && item.task.id !== task.id)?.index ?? entries.length;
  let phaseIndex = Math.max(0, history[0]!.task.phases.length - 1);
  const tools = new Map<string, ExecutionNode>();
  // Snapshot positions, rather than wall clocks, assign messages to their actual host phase.
  const byPosition = new Map(history.map((item) => [item.index, item.task]));
  for (let index = start; index < end; index++) {
    const entry = entries[index]!;
    const snapshot = byPosition.get(index);
    if (snapshot) {
      phaseIndex = Math.max(0, snapshot.phases.length - 1);
      const outcome = snapshot.verification;
      if (outcome?.report) for (const [checkIndex, check] of outcome.report.results.entries()) {
        const key = outcome.evidenceId ?? outcome.checkedAt ?? phaseId(phaseIndex);
        const node = add({ id: task.id + ':check:' + key + ':' + checkIndex, parentId: nodes.has(phaseId(phaseIndex)) ? phaseId(phaseIndex) : task.id, kind: 'check', label: (check.name ?? 'check ' + (checkIndex + 1)).slice(0, 160), status: check.passed && check.exitCode === 0 && !check.failure && !check.error ? 'completed' : 'failed', source: 'host', durationMs: check.durationMs, timing: 'host', endedAt: date(outcome.checkedAt), freshness: outcome.evidence?.freshness ?? 'unconfirmed', evidenceId: outcome.evidenceId });
        if (node) node.freshness = outcome.evidence?.freshness ?? 'unconfirmed';
        if (node?.status === 'failed' && nodes.get(node.parentId!)?.kind === 'phase') nodes.get(node.parentId!)!.status = 'failed';
      }
      if (snapshot.phase === 'review' && snapshot.review?.verdict === 'changes_requested' && nodes.has(phaseId(phaseIndex))) nodes.get(phaseId(phaseIndex))!.status = 'needs_attention';
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
    const message = entry.message as Record<string, unknown>;
    const at = date(message['timestamp']) ?? date(entry.timestamp);
    if (message['role'] === 'assistant') {
      const node = add({ id: task.id + ':message:' + (entry.id ?? index), parentId: nodes.has(phaseId(phaseIndex)) ? phaseId(phaseIndex) : task.id, kind: 'model', label: 'model', status: message['stopReason'] === 'error' ? 'failed' : message['stopReason'] === 'aborted' ? 'aborted' : 'completed', source: 'pi', endedAt: at });
      const usage = message['usage'];
      if (node && usage && typeof usage === 'object' && 'totalTokens' in usage && typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) node.tokens = usage.totalTokens;
      if (!Array.isArray(message['content'])) continue;
      for (const part of message['content']) {
        if (!part || part.type !== 'toolCall' || typeof part.id !== 'string' || part.id.length > 512 || typeof part.name !== 'string' || tools.has(part.id)) continue;
        const tool = add({ id: task.id + ':tool:' + encodeURIComponent(part.id), parentId: node?.id ?? task.id, kind: 'tool', label: part.name.slice(0, 160), status: active ? 'running' : 'interrupted', source: 'pi', startedAt: at, timing: 'message_interval' });
        if (tool) tools.set(part.id, tool);
      }
    } else if (message['role'] === 'toolResult' && typeof message['toolCallId'] === 'string') {
      const tool = tools.get(message['toolCallId']);
      if (tool && !tool.endedAt) { tool.status = message['isError'] ? 'failed' : 'completed'; tool.endedAt = at; tool.durationMs = duration(tool.startedAt, at); }
    }
  }
  for (const node of nodes.values()) if (node.kind === 'check' && node.evidenceId && node.evidenceId === task.verification?.evidenceId) node.freshness = task.verification.evidence?.freshness ?? 'unconfirmed';
  return result;
}
