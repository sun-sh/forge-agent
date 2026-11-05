export const TASK_KINDS = ['answer', 'explore', 'change', 'verify'] as const;
export type TaskKind = typeof TASK_KINDS[number];

/** Conservative host routing from the user request, never from model or repository output. */
export function taskKind(prompt: string): TaskKind {
  const text = prompt.trim();
  // Quoted code and pasted logs are evidence, not an instruction to enable execution.
  const request = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/^\s*>.*$/gm, '');
  if (/(?:不要|别|禁止|不需要|无需|不必).{0,12}(?:修改|改动|编辑|写入|执行|实现|修复)|(?:只|仅)(?:需|要)?(?:解释|分析|回答|看看|查看|阅读|调研|规划|计划)|\b(?:do not|don['’]t|without|no)\s+(?:\w+\s+){0,3}(?:changes?|modify|modifying|edit|editing|implement|implementation|execut\w*)\b|\b(?:explain|answer|read|plan)\s+only\b/i.test(request)) return 'explore';
  if (/^(?:你好|您好|嗨|谢谢|好的|明白了|hello|hi|thanks|thank you)[!！.。\s]*$/i.test(request)
    || /^(?:请问|请)?\s*(?:你|您|这个\s*agent).{0,8}(?:能(?:做|干)|会做|是什么|有哪些功能|有什么(?:功能|能力))[^，,。.;；\n]*[？?]?\s*$|^(?:what can you do|who are you|(?:describe )?your capabilities)[?!.\s]*$/i.test(request)) return 'answer';
  if (/^(?:请问|请)?\s*(?:如何|怎么|为什么|能否解释)|^(?:how (?:do|can|should|would|to)|why|what (?:is|are|does))\b/i.test(request)) return 'explore';
  const verification = /(?:运行|执行|跑一下|跑下|重新跑|检查).{0,16}(?:测试|验证|检查命令|test|check|lint|build)|\b(?:run|execute|rerun)\s+(?:the\s+|project\s+|configured\s+|all\s+)*(?:tests?|verification|checks?|lint|build)\b/i;
  // Remove command names such as "run build" before checking for mutation verbs.
  // Explicit changes take priority over the verification requested alongside them.
  const changes = request.replace(new RegExp(verification.source, 'gi'), '');
  if (/(?:修复|修改|改成|改为|改一下|新增|添加|增加|删除|移除|重构|实现|搭建|构建|开发|补齐|补充|完善|优化|升级|更新|部署|执行这个方案|开始做|动手|照做|做吧)|\b(?:fix|repair|implement|create|add|remove|delete|refactor|modify|edit|build|upgrade|update|deploy|finish|do it)\b/i.test(changes)) return 'change';
  if (verification.test(request)) return 'verify';
  // Unknown requests stay read-only. Contextual requests can be made explicit by the user.
  return 'explore';
}
