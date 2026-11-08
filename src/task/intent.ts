export const TASK_KINDS = ['answer', 'explore', 'change', 'verify', 'undetermined'] as const;
export type TaskKind = typeof TASK_KINDS[number];
export interface TaskIntentContext { previousUserPrompts?: readonly string[]; pendingKind?: TaskKind; }

// A scoped preservation rule is not a prohibition on the requested change.
// Remove only recognizable file/test lists; unknown or global restrictions
// remain in the request and keep the conservative read-only routing below.
function withoutScopedPreservation(request: string): string {
  const scoped = (target: string) => !target
    .replace(/[\w@*./\\-]+\.[a-z\d]{1,12}\b/gi, '')
    .replace(/\b(?:(?:existing|protected|unrelated)\s+)*(?:tests?|test\s+(?:files?|cases?)|package\s+files?|lock\s*files?|dependency\s+files?|documentation)\b/gi, '')
    .replace(/(?:现有|已有|原有|受保护的?|无关的?)*(?:测试(?:文件|用例|代码)?|锁文件|依赖配置|文档)/g, '')
    .replace(/\b(?:the\s+)?(?:production\s+)?(?:database|user data)\b/gi, '')
    .replace(/(?:生产)?数据库|数据表|用户数据/g, '')
    .replace(/\b(?:the|or|and)\b|[和及或、，,\s]/gi, '').trim();
  return request
    .replace(/\b(?:do not|don['’]t)\s+(?:modify|edit|change|touch|write|delete|remove)\s+(.+?)(?=\.(?:\s|$)|[;!?\n]|$)/gi,
      (constraint, target: string) => scoped(target) ? '' : constraint)
    .replace(/(?:不要|别|禁止|不需要|无需|不必)(?:去)?(?:修改|改动|编辑|写入|删除|触碰)([^，。！？;；\n]+)/g,
      (constraint, target: string) => scoped(target) ? '' : constraint);
}

/** Conservative host routing from the user request, never from model or repository output. */
export function taskKind(prompt: string, context: TaskIntentContext = {}): TaskKind {
  const text = prompt.trim();
  // Quoted code and pasted logs are evidence, not an instruction to enable execution.
  const request = withoutScopedPreservation(text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/^\s*>.*$/gm, ''));
  if (/(?:不要|别|禁止|不需要|无需|不必).{0,12}(?:修改|改动|编辑|写入|执行|实现|修复|删除|移除|触碰|覆盖)|(?:只|仅)(?:需|要)?(?:解释|分析|回答|看看|查看|阅读|调研|规划|计划)|\b(?:do not|don['’]t|without|no)\s+(?:\w+\s+){0,3}(?:changes?|modify|modifying|edit|editing|implement|implementation|execut\w*|writ\w*|delet\w*|remov\w*|touch\w*)\b|\b(?:explain|answer|read|plan)\s+only\b/i.test(request)) return 'explore';
  if (/^(?:你好|您好|嗨|谢谢|好的|明白了|hello|hi|thanks|thank you)[!！.。\s]*$/i.test(request)
    || /^(?:请问|请)?\s*(?:你|您|这个\s*agent).{0,8}(?:能(?:做|干)|会做|是什么|有哪些功能|有什么(?:功能|能力))[^，,。.;；\n]*[？?]?\s*$|^(?:what can you do|who are you|(?:describe )?your capabilities)[?!.\s]*$/i.test(request)) return 'answer';
  if (/^(?:请问|请)?\s*(?:如何|怎么|为什么|能否解释)|^(?:how (?:do|can|should|would|to)|why|what (?:is|are|does))\b/i.test(request)) return 'explore';
  if (/^(?:explain|describe)\s+(?:how|why|what)\b/i.test(request)) return 'explore';
  if (/^(?:(?:你|您)(?:再)?(?:觉得|认为)|还有(?:什么|哪些)|(?:我们|这个项目|这个agent).{0,8}(?:还缺什么|有什么不足))|^(?:what (?:else|should|could)|any (?:other |further )?(?:issues|suggestions|improvements))\b/i.test(request)) return 'explore';
  if (/^(?:(?:那|请|你|我们|再|接着|先)\s*)*(?:继续|接着做|继续做|继续执行|按(?:照)?(?:刚才|之前|上述|这个|那个|你的)?(?:的)?(?:方案|计划)(?:去)?(?:处理|执行|做|实现)|continue|resume|go ahead|proceed)(?:吧|一下|执行|做)?[!！.。\s]*$/i.test(request)) {
    const previous = context.pendingKind ?? (context.previousUserPrompts ?? []).slice(-8).reduce<TaskKind | undefined>((kind, item) => taskKind(item, { pendingKind: kind }), undefined);
    if (!previous) return 'undetermined';
    if (/(?:方案|计划).*(?:处理|执行|做|实现)|go ahead|proceed/i.test(request)) return 'change';
    return previous;
  }
  const verification = /(?:运行|执行|跑一下|跑下|重新跑|检查).{0,16}(?:测试|验证|检查命令|test|check|lint|build)|\b(?:run|execute|rerun)\s+(?:the\s+|project\s+|configured\s+|all\s+)*(?:tests?|verification|checks?|lint|build)\b/i;
  // Remove command names such as "run build" before checking for mutation verbs.
  // Explicit changes take priority over the verification requested alongside them.
  const changes = request.replace(new RegExp(verification.source, 'gi'), '');
  if (/(?:修复|修改|改成|改为|改一下|新增|添加|增加|扩展|删除|移除|重构|实现|搭建|构建|开发|补齐|补充|完善|优化|升级|更新|部署|执行这个方案|开始做|动手|照做|做吧)|\b(?:fix|repair|implement|extend|create|add|remove|delete|refactor|modify|edit|build|upgrade|update|deploy|finish|do it)\b/i.test(changes)) return 'change';
  if (verification.test(request)) {
    const remainder = request.replace(new RegExp(verification.source, 'gi'), '').replace(/\b(?:please|and|then|again|now)\b|(?:请|帮我|一下|一遍|重新)|[\s,.!?:;，。！？；：]/gi, '');
    if (!remainder) return 'verify';
    // Verification mentioned beside an unfamiliar change is not a verification-only task.
    return 'undetermined';
  }
  if (/^(?:请|帮我|你|再|先|please\s+)*(?:解释|分析|看看|查看|看(?:报错|错误|日志)|阅读|调研|评估|评价|explain\b|describe\b|review\b|analyze\b|inspect\b|summarize\b)/i.test(request)
    && !/(?:然后|并且|并|以及)|\b(?:and|then|also)\b/i.test(request)) return 'explore';
  // Routing never expands the user's selected mode or Pi project trust.
  // An unknown expression is not proof that the user only asked for research.
  // Planned execution resolves this hint in its read-only inspection handoff.
  return 'undetermined';
}
