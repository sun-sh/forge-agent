import { withTaskEvidence, type TaskState } from './controller.js';
import { isVerified } from '../verification/pi-extension.js';

export interface ExecutionSignals { outcome: string; error?: string; }

/** Do not publish a terminal success before checkpoint and persistence finalization. */
export function pendingExecutionState(task: TaskState | undefined, running: boolean): TaskState | undefined {
  return task?.status === 'completed' && running && task.finalization !== 'succeeded' && task.finalization !== 'failed'
    ? { ...task, status: 'running', finalization: 'pending' } : task;
}

/** One terminal result for the session, queue and durable index. Historical checks stay intact. */
export function executionResult(input: TaskState, signals: ExecutionSignals, options: { finalizationError?: string; pendingProposals?: boolean } = {}): TaskState {
  let task = structuredClone(input);
  if (options.finalizationError) { task.status = 'failed'; task.error = options.finalizationError; task.finalization = 'failed'; }
  else {
    task.finalization = 'succeeded';
    if (task.budget?.status === 'exceeded') { task.status = 'budget_exceeded'; task.error = task.budget.exceededReason; }
    else if (task.progress?.status === 'stalled') { task.status = 'needs_attention'; task.error = task.progress.reason; }
    else if (signals.outcome === 'aborted') { task.status = 'aborted'; task.error ??= '任务已停止。'; }
    else if (signals.error || signals.outcome === 'failed' || task.verification?.status === 'failed') {
      if (task.status === 'running' || task.status === 'completed') task.status = 'failed';
      task.error ??= signals.error ?? task.verification?.error ?? '执行失败。';
    } else if (task.workflow === 'direct' || task.status === 'running') {
      task.status = 'completed'; task.phase = 'complete'; task.error = undefined;
      if (task.kind === 'verify' && (!task.verification || !isVerified(task.verification))) { task.status = 'needs_attention'; task.error = task.verification?.reason ?? '没有有效的自动验证通过证据。'; }
    }
    if (task.verification) task = withTaskEvidence(task, task.verification);
    if (task.status === 'completed' && options.pendingProposals) { task.status = 'needs_attention'; task.error = '还有子任务变更提案待处理。请审阅应用或放弃后，重新验证主项目。'; }
  }
  task.updatedAt = new Date().toISOString();
  const phase = task.phases.at(-1); if (phase && !phase.endedAt) phase.endedAt = task.updatedAt;
  return task;
}

export interface ExecutionFinalizer {
  current(): TaskState | undefined;
  signals(): ExecutionSignals;
  prepare(): Promise<void>;
  pendingProposals(): Promise<boolean>;
  seal(): Promise<void>;
  restore(): void;
  persist(task: TaskState): void;
  flush(): Promise<void>;
}

/** Host finalization stays outside Pi's model/tool loop; the caller always releases ownership. */
export async function finalizeExecution(host: ExecutionFinalizer): Promise<{ task?: TaskState; error?: string }> {
  let error: string | undefined, pendingProposals = false;
  try { await host.prepare(); pendingProposals = await host.pendingProposals(); await host.seal(); }
  catch (cause) { error = '任务收尾失败：' + (cause instanceof Error ? cause.message : String(cause)); }
  try { host.restore(); }
  catch (cause) { error ??= '执行模式恢复失败：' + (cause instanceof Error ? cause.message : String(cause)); }
  const current = host.current(); if (!current) return { error };
  let task = executionResult(current, host.signals(), { finalizationError: error, pendingProposals });
  try { host.persist(task); await host.flush(); }
  catch (cause) {
    error = '任务收尾保存失败：' + (cause instanceof Error ? cause.message : String(cause));
    task = executionResult(task, host.signals(), { finalizationError: error });
    // Persist failure if storage recovers; a permanent failure stays explicit in live state.
    try { host.persist(task); await host.flush(); } catch { /* The caller publishes the failed live result. */ }
  }
  return { task, error };
}
