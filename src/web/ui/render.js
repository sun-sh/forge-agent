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

function currentVerification(verification) {
  return verification?.status === 'passed' && (!verification.protection || verification.protection.status === 'unchanged') && verification.evidence?.freshness === 'current' && Boolean(verification.evidence.workspace?.digest) && verification.report?.passed === true
    && verification.report.results?.length > 0 && verification.report.results.every((result) => result.passed && result.exitCode === 0 && !result.failure && !result.error);
}
export function verificationUnconfigured(verification) {
  return verification?.status === 'skipped' && !verification.report && !verification.error && (!verification.protection || verification.protection.status === 'unchanged') && (!verification.evidence || verification.evidence.freshness === 'current') && /^No verification commands configured(?:\.|; protected paths are unchanged\.)$/i.test(verification.reason || '');
}
export function verificationLabel(verification) {
  if (verification?.protection?.status === 'changed') return '保护路径发生变化';
  if (verification?.protection?.status === 'unconfirmed') return '保护路径无法确认';
  if (verification?.status === 'failed') return '验证失败';
  if (verification?.evidence?.freshness === 'stale') return '历史验证 · 证据已过期';
  if (verification?.status === 'passed') return currentVerification(verification) ? '配置检查通过' : '命令曾通过 · 当前版本未确认';
  if (verification?.status === 'running') return '正在验证';
  if (verificationUnconfigured(verification)) return '未配置自动验证';
  return '未执行自动验证';
}
function implementationResultLabel(task) {
  const modified = task.kind === 'change' || task.artifacts?.length || task.changes?.files?.some((file) => file.observed);
  return (modified ? '已实现' : '执行结束') + ' · 需求未验收';
}
export function taskPhaseLabel(phase, checkRole) {
  if (phase === 'check' && checkRole === 'baseline') return '基线检查';
  if (phase === 'check' && checkRole === 'candidate') return '候选检查';
  return ({ inspect: '调研', plan: '规划', implement: '实现', check: '行为检查', verify: '验证', review: '审阅', complete: '执行结束' })[phase] || phase;
}
export function taskPhaseSteps(task) {
  const phases = task.kind === 'verify' ? ['verify', 'complete'] : task.workflow === 'direct' ? ['implement', 'complete'] : ['inspect', 'plan', 'implement', ...(task.behavior ? ['check'] : []), 'verify', 'review', 'complete'];
  return phases.flatMap((phase) => {
    if (!task.behavior?.calibration || task.workflow === 'direct') return [{ phase }];
    if (phase === 'implement') return [{ phase: 'check', checkRole: 'baseline' }, { phase }];
    return [{ phase, ...(phase === 'check' ? { checkRole: 'candidate' } : {}) }];
  });
}
export function behaviorCheckView(task) {
  const behavior = task.behavior;
  if (!behavior) return null;
  const calibration = task.result?.behaviorCalibration;
  const status = task.result?.behaviorChecks ?? (behavior.calibration && behavior.status === 'passed' ? 'unconfirmed' : behavior.status);
  const statusLabel = ({ pending: '等待执行', not_run: '等待执行', running: '执行中', passed: '冻结检查命令已通过，需求仍未验收', failed: '命令未通过，需区分行为与环境', unconfirmed: '证据未确认' })[status] || '未确认';
  const baselineLabel = ({ pending: '等待执行', running: '执行中', observed: '已观测', unavailable: '不可用', unconfirmed: '未确认' })[calibration?.baseline.status] || '未确认';
  const comparisons = { changed_to_pass: '失败转通过', unchanged_pass: '持续通过', pre_existing_failure: '基线已有失败', candidate_regression: '候选回归', unconfirmed: '对照未确认' };
  const receiptText = (receipts) => (receipts || []).map((item) => item.checkId + ' · ' + item.status + ' · exit=' + (item.exitCode ?? 'unknown') + '\n' + item.output).join('\n');
  const lines = [];
  if (behavior.calibration) {
    lines.push('基线：' + baselineLabel);
    if (calibration) {
      lines.push('实现：' + (calibration.implementationStarted ? '已开始' : '尚未开始'));
      lines.push('基线诊断：' + ({ not_run: '未使用', running: '进行中', kept: '保留原检查', replaced: '已校正检查', unavailable: '不可用' })[calibration.correction.status] + (calibration.correction.consumed ? ' · 单次机会已消耗' : ''));
      for (const row of calibration.comparisons) lines.push(row.checkId + ' · ' + comparisons[row.outcome] + (row.sameOutput ? ' · 输出相同' : ''));
    }
    if (behavior.calibration.correction?.result?.summary) lines.push(behavior.calibration.correction.result.summary);
    if (behavior.calibration.correction?.error) lines.push(behavior.calibration.correction.error);
    for (const [index, run] of (behavior.calibration.runs || []).entries()) lines.push('基线记录 ' + (index + 1) + ' · ' + run.status, receiptText(run.receipts), run.reason || '');
  }
  if (behavior.runPurpose !== 'baseline') lines.push((behavior.calibration ? '候选检查：' : '行为检查：') + statusLabel, receiptText(behavior.receipts));
  if (behavior.reason) lines.push(behavior.reason);
  return { summary: '行为检查 · ' + (behavior.calibration ? '基线' + baselineLabel + (behavior.runPurpose === 'baseline' ? '' : ' · 候选' + statusLabel) : statusLabel), detail: lines.filter(Boolean).join('\n') };
}
export function reviewStopView(task) {
  let stop = task?.result?.reviewStop ?? task?.reviewStop;
  if (!stop && task?.review) {
    const review = task.review, unconfirmedIds = (review.acceptance || []).filter((item) => item.status === 'unconfirmed').map((item) => item.id);
    const nonCode = review.issues?.length && review.issueKinds?.length === review.issues.length && review.issueKinds.every((kind) => kind !== 'code_defect');
    if (nonCode) stop = { reason: 'insufficient_evidence', issueCount: 0, unconfirmedIds: (review.acceptance || []).filter((item) => item.status !== 'met').map((item) => item.id) };
    else if (review.issues?.length || review.acceptance?.some((item) => item.status === 'unmet')) stop = { reason: 'code_defects', issueCount: review.issues?.length || review.acceptance.filter((item) => item.status === 'unmet').length, unconfirmedIds };
    else if (review.verdict === 'insufficient_evidence' || unconfirmedIds.length) stop = { reason: 'insufficient_evidence', issueCount: 0, unconfirmedIds };
  }
  if (!stop) return null;
  if (stop.reason === 'budget_exhausted') return { label: '审阅未完成 · 预算耗尽', kind: 'unverified', action: 'adjust_budget', detail: (stop.budgetScope === 'parent' ? '父任务总预算已用尽。' : '独立审阅预算已用尽。') + '请在设置 → 关于 → 执行预算中调整对应预算后重试；现有文件和检查记录保留。' };
  if (stop.reason === 'insufficient_evidence') return { label: '需求未验收 · 证据不足', kind: 'unverified', action: 'provide_evidence', detail: '无法确认' + (stop.unconfirmedIds?.length ? '：' + stop.unconfirmedIds.join('、') : '当前验收条件') + '。请补充相关测试或执行证据，或进行人工验收；这不表示已发现代码缺陷。' };
  if (stop.reason === 'code_defects') return { label: '审阅发现 ' + stop.issueCount + ' 个问题', kind: 'failed', action: 'fix_code', detail: '请根据审阅问题和未满足的验收项修复代码，再运行验证和独立审阅。' };
  return { label: stop.reason === 'invalid_review' ? '审阅结果格式无效' : '审阅执行失败', kind: 'failed', action: 'retry_review', detail: '审阅尚未产生有效结论。请查看执行记录并重试；未将其视为代码缺陷或审阅通过。' };
}
export function sessionOutcome(data) {
  if (data.task) {
    if (!data.running && (data.task.finalization === 'failed' || data.task.status === 'completed' && (data.error || data.task.error || data.outcome === 'failed'))) return { label: '任务失败 · 收尾或执行异常', kind: 'failed' };
    if (data.running && data.task.finalization === 'pending') return { label: '正在完成收尾', kind: 'running' };
    const readOnlyMode = ['ask', 'plan'].includes(data.runMode ?? data.task.mode);
    if (readOnlyMode || ['answer', 'explore'].includes(data.task.kind)) {
      if (data.running) return { label: '正在回答', kind: 'running' };
      if (data.task.status === 'aborted') return { label: '回答已停止', kind: 'failed' };
      if (data.error || data.outcome === 'failed' || data.task.status === 'failed' || data.task.status === 'needs_attention') return { label: '回答失败 · 需要检查', kind: 'failed' };
      if (data.task.status === 'completed') return { label: data.task.workflow === 'planned' || readOnlyMode ? '回答结束 · 未执行修改' : '回答结束', kind: 'done' };
    }
    if (data.running) return { label: '正在' + (taskPhaseLabel(data.task.phase, data.task.phases?.at(-1)?.checkRole ?? data.task.behavior?.runPurpose) || '运行'), kind: 'running' };
    const reviewStop = reviewStopView(data.task);
    if (reviewStop && data.task.phase === 'review' && ['needs_attention', 'failed', 'budget_exceeded'].includes(data.task.status)) return { label: reviewStop.label, kind: reviewStop.kind };
    if (data.task.status === 'budget_exceeded') return { label: '执行预算已用尽 · 可继续', kind: 'failed' };
    if (data.task.status === 'interrupted') return { label: '任务中断 · 等待明确继续', kind: 'failed' };
    if (data.task.status === 'needs_attention') return { label: '需要检查 · 尚未通过完成门槛', kind: 'failed' };
    if (data.task.status === 'failed') return { label: data.task.verification?.status === 'failed' ? '验证失败 · 任务未通过' : '任务失败', kind: 'failed' };
    if (data.task.status === 'aborted') return { label: '任务已停止', kind: 'failed' };
    if (data.task.status === 'completed') {
      const verification = data.task.verification;
      if (verification?.protection && verification.protection.status !== 'unchanged') return { label: '需要检查 · ' + verificationLabel(verification), kind: 'failed' };
      if (verification?.status === 'failed' || verification?.evidence?.freshness === 'stale' || verification?.status === 'passed' && !currentVerification(verification)) return { label: '需要重新检查 · ' + verificationLabel(verification), kind: 'failed' };
      const acceptance = data.task.plan?.acceptance, findings = data.task.review?.acceptance;
      const acceptanceMet = !acceptance || Array.isArray(findings) && findings.length === acceptance.length && new Set(findings.map((item) => item.id)).size === findings.length && acceptance.every((item) => findings.some((finding) => finding.id === item.id && finding.status === 'met' && finding.evidence?.trim()));
      const unconfigured = verificationUnconfigured(verification);
      const reviewed = Boolean(verification?.evidenceId) && data.task.review?.verdict === 'ready' && !data.task.review.issues?.length && data.task.review.freshness === 'current' && currentVerification(verification) && data.task.review.evidenceId === verification.evidenceId && acceptanceMet;
      const reviewLabel = data.task.reviewer?.context === 'independent' ? '独立模型审阅通过' : '模型审阅通过';
      const productResult = data.task.result;
      if (productResult?.status === 'blocked') return { label: '需要检查 · 完成证据不完整', kind: 'failed' };
      if (productResult && ['implemented_unverified', 'finished_unverified'].includes(productResult.status)) {
        const behaviorLabel = productResult.behaviorChecks ? ' · 行为检查' + ({ passed: '命令通过', failed: '命令失败', unconfirmed: '未确认', not_run: '未执行', running: '进行中' }[productResult.behaviorChecks] || '未确认') : '';
        const resultReview = productResult.modelReview === 'not_applicable' ? ' · 未启用审阅' : productResult.modelReview === 'passed' ? ' · 独立模型审阅通过' : productResult.modelReview === 'changes_requested' ? ' · 审阅发现待处理问题' : ' · 未进行模型审阅';
        return { label: implementationResultLabel(data.task) + ' · ' + verificationLabel(verification) + behaviorLabel + resultReview, kind: 'unverified' };
      }
      if (data.task.reviewFollowup || data.task.review && (data.task.review.verdict !== 'ready' || data.task.review.issues?.length || !acceptanceMet)) return { label: '审阅发现待处理问题 · 需要检查', kind: 'failed' };
      if (unconfigured) return { label: implementationResultLabel(data.task) + ' · 未配置自动验证', kind: 'unverified' };
      if (data.task.workflow === 'planned' && data.task.kind === 'change' && (!currentVerification(verification) || data.task.reviewRequired !== false && !reviewed)) return { label: '需要检查 · 完成证据不完整', kind: 'failed' };
      if (data.task.workflow === 'planned' && data.task.reviewRequired === false) return { label: implementationResultLabel(data.task) + ' · ' + verificationLabel(verification) + ' · 评测：未启用审阅', kind: 'unverified' };
      return { label: (data.task.kind === 'verify' ? '检查结束' : implementationResultLabel(data.task)) + ' · ' + verificationLabel(verification) + (data.task.kind === 'verify' ? '' : reviewed ? ' · ' + reviewLabel : ' · 未进行模型审阅'), kind: data.task.kind === 'verify' ? 'done' : 'unverified' };
    }
  }
  if (data.running) return { label: '正在运行', kind: 'running' };
  if (data.outcome === 'aborted') return { label: '已停止', kind: 'failed' };
  if (data.error || data.outcome === 'failed' || data.verification?.status === 'failed') return { label: data.verification?.status === 'failed' ? '验证失败 · 任务未通过' : '运行失败', kind: 'failed' };
  if (data.readOnly) return { label: '历史记录 · 选择可用模型后继续', kind: '' };
  if (data.outcome === 'completed' && data.runMode === 'plan') return { label: data.mode === 'agent' ? '规划完成 · 可发送执行指令' : '规划完成 · 等待切换 Agent 执行', kind: 'done' };
  if (data.outcome === 'completed' && data.runMode === 'ask') return { label: '问答结束 · 未执行修改', kind: 'done' };
  if (data.verification?.status === 'passed') return { label: '执行结束 · 需求未验收 · ' + verificationLabel(data.verification), kind: 'unverified' };
  return { label: data.outcome === 'completed' ? '回答结束 · 未执行自动验证' : '准备就绪', kind: '' };
}
