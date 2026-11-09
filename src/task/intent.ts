export const TASK_KINDS = ['answer', 'explore', 'change', 'verify', 'undetermined'] as const;
export type TaskKind = typeof TASK_KINDS[number];
export interface TaskIntentContext { previousUserPrompts?: readonly string[]; pendingKind?: TaskKind; }

/** Coarse telemetry only. Never grants permissions, selects stages or skips implementation. */
export function intentHint(prompt: string, context: TaskIntentContext = {}): TaskKind {
  const text = prompt.trim().replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '');
  if (/^(?:继续|continue|resume)[!！.。\s]*$/i.test(text)) return context.pendingKind ?? 'undetermined';
  if (/^(?:你好|您好|hello|hi|thanks|谢谢)[!！.。\s]*$/i.test(text)
    || /^(?:你能干什么|你会什么|what can you do|who are you)[？?!!。\s]*$/i.test(text)) return 'answer';
  if (/^(?:如何|怎么|为什么|解释|分析|调研|评估|请看|看看|查看|阅读|review|inspect|explain|describe|what\b|how\b|why\b)/i.test(text)
    || /^(?:你觉得|还有什么|有什么不足|不要|别|禁止|无需|不必|do not\b|don't\b)/i.test(text)) return 'explore';
  if (/(?:修复|修改|实现|新增|重构|完善)|\b(?:fix|implement|add|refactor|extend)\b/i.test(text)) return 'change';
  if (/^(?:运行|执行|run\b|rerun\b|execute\b).{0,40}(?:测试|验证|构建|检查|tests?\b|verification\b|build\b|check\b)/i.test(text)
    || /^(?:run|rerun|execute)\s+(?:the\s+)?(?:build|tests?|checks?|verification|lint)\b/i.test(text)) return 'verify';
  return 'undetermined';
}

/** Compatibility name for existing telemetry consumers. */
export const taskKind = intentHint;
