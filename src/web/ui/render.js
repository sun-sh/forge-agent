// The parser and sanitizer are mature libraries injected by the client (and security tests).
export function safeMarkdown(source, parser, purifier) {
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const renderer = new parser.Renderer();
  // Raw HTML is displayed as source, so untrusted class names cannot borrow application UI styles.
  renderer.html = ({ text }) => escape(text);
  renderer.image = ({ text }) => escape('[图片：' + text + ']');
  const html = parser.parse(String(source ?? ''), { gfm: true, breaks: true, async: false, renderer });
  return purifier.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'start'],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:)/i,
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true
  });
}

export function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n') : '';
}

export function sessionOutcome(data) {
  if (data.task) {
    const labels = { inspect: '调研', plan: '规划', implement: '实现', verify: '验证', review: '审阅', complete: '完成' };
    if (['answer', 'explore'].includes(data.task.kind)) {
      if (data.running) return { label: '正在回答', kind: 'running' };
      if (data.task.status === 'aborted') return { label: '回答已停止', kind: 'failed' };
      if (data.error || data.outcome === 'failed' || data.task.status === 'failed' || data.task.status === 'needs_attention') return { label: '回答失败 · 需要检查', kind: 'failed' };
      if (data.task.status === 'completed') return { label: '回答结束 · 未执行修改', kind: 'done' };
    }
    if (data.running) return { label: '正在' + (labels[data.task.phase] || '运行'), kind: 'running' };
    if (data.task.status === 'budget_exceeded') return { label: '执行预算已用尽 · 可重新检查', kind: 'failed' };
    if (data.task.status === 'interrupted') return { label: '任务中断 · 等待明确继续', kind: 'failed' };
    if (data.task.status === 'needs_attention') return { label: '需要检查 · 尚未通过完成门槛', kind: 'failed' };
    if (data.task.status === 'failed') return { label: data.task.verification?.status === 'failed' ? '验证失败 · 任务未通过' : '任务失败', kind: 'failed' };
    if (data.task.status === 'aborted') return { label: '任务已停止', kind: 'failed' };
    if (data.task.status === 'completed') return { label: data.task.kind === 'verify' ? '验证完成 · 验证通过' : '任务完成 · 验证通过 · 已审阅', kind: 'done' };
  }
  if (data.running) return { label: '正在运行', kind: 'running' };
  if (data.outcome === 'aborted') return { label: '已停止', kind: 'failed' };
  if (data.error || data.outcome === 'failed' || data.verification?.status === 'failed') return { label: data.verification?.status === 'failed' ? '验证失败 · 任务未通过' : '运行失败', kind: 'failed' };
  if (data.readOnly) return { label: '历史记录 · 选择可用模型后继续', kind: '' };
  if (data.outcome === 'completed' && data.runMode === 'plan') return { label: data.mode === 'agent' ? '规划完成 · 可发送执行指令' : '规划完成 · 等待切换 Agent 执行', kind: 'done' };
  if (data.outcome === 'completed' && data.runMode === 'ask') return { label: '问答结束 · 未执行修改', kind: 'done' };
  if (data.verification?.status === 'passed') return { label: '任务完成 · 验证通过', kind: 'done' };
  return { label: data.outcome === 'completed' ? '回答结束 · 未配置自动验证' : '准备就绪', kind: '' };
}
