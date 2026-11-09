import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** Inspect output metadata only. Private reasoning is never copied into recovery prompts. */
export function incompleteModelOutput(message: unknown): 'length' | 'empty' | undefined {
  const value = message as { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (value?.role !== 'assistant') return;
  if (value.stopReason === 'length') return 'length';
  if (value.stopReason === 'stop' && Array.isArray(value.content) && !value.content.some((part) => part.type === 'toolCall' || part.type === 'text' && part.text?.trim())) return 'empty';
}

export class ModelOutputIncompleteError extends Error {}

/** One bounded settlement extension; Pi still owns every model/tool continuation. */
export function createModelOutputGuard(options: {
  executionId(): string | undefined;
  active(): boolean;
  phase(): string | undefined;
  onFailure(message: string): void;
}) {
  let execution: string | undefined, retries = 0, failure: string | undefined;
  let incomplete: 'length' | 'empty' | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', () => {
      const id = options.executionId();
      if (id !== execution) { execution = id; retries = 0; failure = undefined; }
      incomplete = undefined;
    });
    pi.on('message_end', ({ message }) => {
      if (options.active() && message.role === 'assistant') incomplete = incompleteModelOutput(message);
    });
    pi.on('agent_before_settle', (event, ctx) => {
      if (!options.active() || event.outcome !== 'completed' || event.continue || ctx.signal?.aborted || !incomplete) return;
      if (retries >= 2) {
        failure = incomplete === 'length'
          ? '模型达到单次回复输出上限，自动续接 2 次后仍未完成输出。实现未完成；请降低思考程度、调整模型最大输出或继续任务。'
          : '模型未返回正文或工具调用，自动续接 2 次后仍为空。实现未完成，请检查模型兼容性后继续。';
        options.onFailure(failure);
        pi.appendEntry('forge.output_incomplete', { reason: incomplete, retries, phase: options.phase() });
        return;
      }
      retries++;
      pi.appendEntry('forge.output_recovery', { reason: incomplete, attempt: retries, phase: options.phase() });
      ctx.ui.notify(incomplete === 'length' ? `单次模型输出被截断，正在续接（${retries}/2）…` : `模型输出为空，正在重试（${retries}/2）…`, 'warning');
      return {
        continue: true,
        entries: [{ type: 'custom_message' as const, customType: 'forge.output_recovery', display: false,
          content: `HOST OUTPUT RECOVERY ${retries}/2. Your previous response ${incomplete === 'length' ? 'hit its single-response output limit' : 'contained no visible text or tool call'}; it did not complete this phase. Keep the current user goal, selected model/effort, permissions and phase. Do not repeat the plan or claim completion. In an implementation phase, make the next small concrete tool call now: create a minimal working file first, then edit it in bounded chunks rather than planning the entire source in one response. In a read-only phase, return the required concise handoff using only allowed tools. Preserve already written content and do not replay successful calls. This continuation shares the original task budget and repair allowance.` }]
      };
    });
  };
  return { extension, get error() { return failure; }, assertComplete() { if (failure) throw new ModelOutputIncompleteError(failure); } };
}
