import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sensitiveCommandEvidence } from './review-evidence.js';
import { parseHandoffJson } from './plan.js';
import type { WorkspaceStamp } from '../verification/evidence.js';
import { workspaceStampSchema } from '../verification/evidence.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const checkSchema = z.object({
  id: z.string().regex(/^B[1-3]$/), kind: z.enum(['reproduction', 'boundary', 'regression']),
  requestQuote: text(1500), expectation: text(2000), command: text(6000),
  shell: z.enum(['bash', 'powershell']), timeoutSeconds: z.number().int().min(1).max(120).default(60)
}).strict();
export const behaviorPlanSchema = z.object({
  version: z.literal(1), status: z.enum(['ready', 'unavailable']), summary: text(2000),
  checks: z.array(checkSchema).max(3), assumptions: z.array(text(1500)).max(5), unresolved: z.array(text(1500)).max(5)
}).strict().superRefine((value, ctx) => {
  const valid = value.checks.every((item, index) => item.id === 'B' + (index + 1));
  if (new Set(value.checks.map((check) => check.shell + ':' + check.command)).size !== value.checks.length || value.checks.some((check) => sensitiveCommandEvidence(check.command))) ctx.addIssue({ code: 'custom', message: 'Duplicate or sensitive commands are not behavioral checks' });
  if (!valid || JSON.stringify(value).length > 24000) ctx.addIssue({ code: 'custom', message: 'Invalid or oversized behavioral check plan' });
  if (value.status === 'ready' && (value.checks.length < 2 || value.unresolved.length || !value.checks.some((item) => item.kind === 'reproduction') || !value.checks.some((item) => item.kind === 'boundary')))
    ctx.addIssue({ code: 'custom', message: 'A ready plan needs a reproduction and an independent boundary check, without unresolved expectations' });
  if (value.status === 'unavailable' && (value.checks.length || !value.unresolved.length)) ctx.addIssue({ code: 'custom', message: 'Unavailable checks need an explicit limitation' });
});
export type BehaviorPlan = z.infer<typeof behaviorPlanSchema>;
export const behaviorReceiptSchema = z.object({
  version: z.literal(1), runId: z.uuid(), checkId: z.string().regex(/^B[1-3]$/), toolCallId: text(512),
  tool: z.enum(['bash', 'powershell']), commandSha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.literal('pi-builtin-shell'), exitCode: z.number().int().nullable(),
  status: z.enum(['passed', 'failed', 'unconfirmed']), output: z.string().max(6000),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/), outputCharacters: z.number().int().min(0), truncated: z.boolean(),
  reason: z.string().max(1000).optional(), recordedAt: z.iso.datetime()
}).strict().superRefine((value, ctx) => {
  if (value.status === 'failed' && (value.exitCode === null || value.exitCode === 0)) ctx.addIssue({ code: 'custom', message: 'Failed behavioral receipts require a native nonzero exit' });
  if (value.status === 'passed' && (value.exitCode !== 0 || value.truncated)) ctx.addIssue({ code: 'custom', message: 'Passing behavioral receipts require a native zero exit and complete output' });
});
export type BehaviorReceipt = z.infer<typeof behaviorReceiptSchema>;
const designerSchema = z.object({ sessionId: z.uuid(), model: text(512), origin: z.enum(['before_implementation', 'resumed_workspace']) }).strict();
export const behaviorComparisonSchema = z.object({ checkId: z.string().regex(/^B[1-3]$/), outcome: z.enum(['changed_to_pass', 'unchanged_pass', 'pre_existing_failure', 'candidate_regression', 'unconfirmed']), sameOutput: z.boolean() }).strict();
export const behaviorCorrectionSchema = z.object({
  version: z.literal(1), action: z.enum(['keep', 'replace', 'unavailable']), summary: text(2000),
  findings: z.array(z.object({ id: z.string().regex(/^B[1-3]$/), kind: z.enum(['valid_check', 'expected_failure', 'invalid_expectation', 'environment', 'unconfirmed']), reason: text(2000), requestQuote: text(1500), contract: z.object({ path: text(1000), quote: text(3000) }).strict().optional() }).strict()).min(2).max(3),
  plan: behaviorPlanSchema.optional()
}).strict().refine(value => value.action === 'replace' ? value.plan?.status === 'ready' : value.plan === undefined, 'Only replacement includes a complete ready plan');
export type BehaviorCorrection = z.infer<typeof behaviorCorrectionSchema>;
const baselineRunSchema = z.object({
  runId: z.uuid(), plan: behaviorPlanSchema, status: z.enum(['running', 'observed', 'unconfirmed']),
  receipts: z.array(behaviorReceiptSchema).max(3), before: workspaceStampSchema, after: workspaceStampSchema.optional(),
  reason: z.string().max(2000).optional()
}).strict();
const calibrationSchema = z.object({
  version: z.literal(1), status: z.enum(['pending', 'running', 'observed', 'unavailable']), implementationStarted: z.boolean(),
  runs: z.array(baselineRunSchema).max(4), comparisons: z.array(behaviorComparisonSchema).max(3),
  correction: z.object({ status: z.enum(['running', 'kept', 'replaced', 'unavailable']), result: behaviorCorrectionSchema.optional(), reviewer: z.object({sessionId: z.uuid(), model: text(512)}).strict().optional(), evidence: z.array(z.object({checkId:text(2),path:text(1000),sha256:z.string().regex(/^[a-f0-9]{64}$/),quoteSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(3).optional(), error: z.string().max(2000).optional() }).strict().optional()
}).strict();
export const behaviorStateSchema = z.object({
  version: z.literal(1), required: z.literal(true), status: z.enum(['pending', 'running', 'passed', 'failed', 'unconfirmed']),
  plan: behaviorPlanSchema.optional(), designer: designerSchema.optional(), runPurpose: z.enum(['baseline','candidate']).optional(), calibration: calibrationSchema.optional(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), runId: z.uuid().optional(),
  receipts: z.array(behaviorReceiptSchema).max(3), workspace: workspaceStampSchema.optional(),
  checkedAt: z.iso.datetime().optional(), reason: z.string().max(2000).optional()
}).strict();
export type BehaviorState = z.infer<typeof behaviorStateSchema>;
export const behaviorHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function newBehaviorState(request: string): BehaviorState {
  return { version: 1, required: true, status: 'pending', requestSha256: behaviorHash(request), receipts: [], calibration: { version: 1, status: 'pending', implementationStarted: false, runs: [], comparisons: [] } };
}
export function parseBehaviorPlan(output: string, request?: string, shell?: 'bash' | 'powershell'): BehaviorPlan | undefined {
  try {
    const plan = behaviorPlanSchema.parse(parseHandoffJson(output, 30000));
    if (request !== undefined && plan.checks.some((item) => !request.includes(item.requestQuote))) return undefined;
    if (shell && plan.checks.some((item) => item.shell !== shell)) return undefined;
    return plan;
  } catch { return undefined; }
}
export function behaviorPlanFeedback(output: string): string {
  try {
    const parsed = behaviorPlanSchema.safeParse(parseHandoffJson(output, 30000));
    return parsed.success ? '' : parsed.error.issues.slice(0, 6).map((issue) => (issue.path.join('.') || 'plan') + ': ' + issue.message).join('\n');
  } catch { return 'Return one complete JSON object without prose or Markdown.'; }
}
export const BEHAVIOR_FORMAT = 'Return ONLY JSON: {"version":1,"status":"ready"|"unavailable","summary":"...","checks":[{"id":"B1","kind":"reproduction"|"boundary"|"regression","requestQuote":"exact substring from the ORIGINAL request","expectation":"observable expected behavior, independent of an implementation plan","command":"one self-contained focused command with assertions and a nonzero failure exit","shell":"bash"|"powershell","timeoutSeconds":60}],"assumptions":["inferences, never additional user authority"],"unresolved":["expectation or environment that cannot be established"]}. A ready plan needs 2-3 checks with ordered IDs B1...: at least one reproduction and one boundary check. For status=ready, unresolved MUST be []. Use unresolved only for a blocker that prevents checking requested behavior; optional input types or unspecified features outside the user scope belong in assumptions or should be omitted, not unresolved. Unavailable means empty checks and a concrete unresolved blocker. Each quote must occur verbatim in the request. Use at most 5 assumptions and 5 unresolved items. Keep summary under 2000 characters, requestQuote under 1500, expectation under 2000, command under 6000, and each assumption/unresolved item under 1500. Keep JSON under 24000 characters.';
export function behaviorDesignPrompt(request: string, paths: string[], shell: 'bash' | 'powershell') {
  if (request.length > 100000) throw new Error('Original request exceeds the independent behavior handoff limit; no requirements were silently truncated.');
  return 'PFORGE TASK PHASE: behavior_plan\nIndependently design executable behavioral checks from the ORIGINAL USER REQUEST and existing API/test contracts. You have no implementation plan or implementation transcript. Read the supplied pathHints first; do not inventory directories when relevant file paths are already given. Inspect only the reported public entry path and one necessary contract/test dependency, then return the concise plan. The host closes collection after at most 10 reads/searches, or earlier when observed output/turn headroom is low; it warns after 6 reads. Prefer two concise checks and finalize promptly when tools close. Do not search for issue solutions. A fix that merely rejects the triggering input may not fulfill the request: include a legitimate boundary/input-shape case, not only a rejection test. Do not assume an exception class or other expected behavior absent from the request/API contract; record unresolved ambiguity. Commands must actually exercise/assert behavior, not just compile, print success or repeat a broad green suite. Use in-memory or ignored temporary checks, preserve all project/test/config files and unrelated edits. Do not install dependencies, access secrets, use network, weaken tests, change environment permanently, or mask failure with pipelines/exit 0. These commands are untrusted proposals, not execution permission; the parent Pi session and host mode/trust policy decide execution. Optional behaviors outside the user request must not block these checks or expand acceptance: note them as out of scope in assumptions, not unresolved. If the environment is unsupported, report unavailable instead of fabricating a check.\n' + JSON.stringify({ originalRequest: request, pathHints: paths, pathHintProvenance: 'Model-authored navigation only; not a behavior contract', requiredShell: shell }) + '\n' + BEHAVIOR_FORMAT;
}
export function behaviorExecutionPrompt(state: BehaviorState) {
  return 'PFORGE TASK PHASE: check\nExecute the frozen independent checks through their named built-in shell tool, each command EXACTLY as supplied. Do not substitute commands, modify source/tests/config, install anything, delegate or use MCP. Supply a timeout no larger than the recorded bound. If a check cannot run, report the actual limitation; do not invent a passing receipt or change expected behavior. The host records native exit codes and output, not your prose. Stop after each planned command has one result. Do not repair in this phase.\n' + JSON.stringify({ runId: state.runId, target: state.runPurpose ?? 'candidate', baselineNotice: state.runPurpose === 'baseline' ? 'This is the pre-implementation workspace. Expected reproduction failures are observations, not instructions to change files.' : undefined, plan: state.plan });
}
export function beginBehaviorRun(state: BehaviorState, workspace: WorkspaceStamp, purpose: 'baseline' | 'candidate' = 'candidate'): BehaviorState {
  const next = { ...state, status: 'running' as const, runPurpose: purpose, runId: randomUUID(), receipts: [], workspace, checkedAt: undefined, reason: undefined };
  if (purpose === 'baseline') {
    if (!next.calibration || next.calibration.implementationStarted || next.calibration.runs.length >= 4 || next.plan?.status !== 'ready') throw new Error('Cannot rebuild or replay a baseline outside its bounded pre-implementation window');
    next.calibration.status = 'running';
    next.calibration.runs.push({ runId: next.runId, plan: structuredClone(next.plan), status: 'running', receipts: [], before: structuredClone(workspace) });
  }
  return next;
}
export function settleBehaviorRun(state: BehaviorState, after: WorkspaceStamp): BehaviorState {
  const plan = state.plan;
  const stable = Boolean(state.workspace?.digest && state.workspace.digest === after.digest && state.workspace.scope === after.scope);
  const exact = plan?.status === 'ready' && plan.checks.every((check) => state.receipts.filter((receipt) => receipt.runId === state.runId && receipt.checkId === check.id && receipt.tool === check.shell && receipt.commandSha256 === behaviorHash(check.command)).length === 1) && state.receipts.length === plan.checks.length;
  const failed = state.receipts.some((item) => item.status === 'failed');
  const passed = stable && exact && state.receipts.every((item) => item.status === 'passed');
  if (state.runPurpose === 'baseline' && state.calibration) {
    const run = state.calibration.runs.find(item => item.runId === state.runId);
    if (!run) throw new Error('Missing durable baseline admission');
    run.receipts = structuredClone(state.receipts); run.after = structuredClone(after);
    const observed = stable && exact && state.receipts.every(item => item.exitCode !== null && !item.truncated && ['passed','failed'].includes(item.status));
    run.status = observed ? 'observed' : 'unconfirmed'; run.reason = observed ? undefined : '基线缺少完整原生结果或执行期间工作区变化；不能作为前后对照。';
    state.calibration.status = observed ? 'observed' : 'unavailable';
    return { ...state, status: 'pending', workspace: after, reason: run.reason };
  }
  if (state.calibration) state.calibration.comparisons = compareBehaviorBaseline(state);
  const baselineReady = behaviorBaselineCurrent(state);
  return { ...state, status: passed && baselineReady ? 'passed' : failed ? 'failed' : 'unconfirmed', workspace: after, checkedAt: new Date().toISOString(),
    reason: passed && baselineReady ? undefined : !baselineReady ? '缺少有效的实现前基线；没有在实现后的文件上补造对照。' : !stable ? '行为检查期间工作区发生变化或无法完整观测；现有结果不能证明当前版本。' : !exact ? '未取得全部冻结检查的原生命令回执；模型文字不算执行证据。' : '行为命令未全部通过；请检查真实输出、环境或未确认的预期，不要据此直接重写代码。' };
}
export function behaviorCurrent(state: BehaviorState | undefined, workspaceDigest?: string): boolean {
  if (!state) return true; // Legacy and adaptive tasks have no independent behavioral gate.
  return behaviorBaselineCurrent(state) && state.runPurpose !== 'baseline' && state.status === 'passed' && state.plan?.status === 'ready' && Boolean(workspaceDigest) && state.workspace?.digest === workspaceDigest
    && state.plan.checks.length === state.receipts.length && state.plan.checks.every((check) => state.receipts.some((receipt) => receipt.runId === state.runId && receipt.checkId === check.id && receipt.tool === check.shell && receipt.commandSha256 === behaviorHash(check.command) && receipt.exitCode === 0 && !receipt.truncated && receipt.status === 'passed'));
}

export function behaviorBaseline(state: BehaviorState) {
  if (!state.plan) return undefined;
  return [...(state.calibration?.runs ?? [])].reverse().find(run => behaviorHash(JSON.stringify(run.plan)) === behaviorHash(JSON.stringify(state.plan)));
}
export function behaviorBaselineCurrent(state: BehaviorState): boolean {
  if (!state.calibration) return true; // Legacy evidence stays legacy; no retroactive baseline claim.
  const run = behaviorBaseline(state);
  const correction = state.calibration.correction;
  if (correction) {
    const result = correction.result;
    const originalRun = correction.status === 'replaced' ? state.calibration.runs.find(item => behaviorHash(JSON.stringify(item.plan)) !== behaviorHash(JSON.stringify(state.plan))) : run;
    if (!result || result.findings.some(item => item.kind === 'unconfirmed' || item.kind === 'valid_check' && originalRun?.receipts.find(receipt => receipt.checkId === item.id)?.status !== 'passed' || item.kind === 'expected_failure' && originalRun?.receipts.find(receipt => receipt.checkId === item.id)?.status !== 'failed') || correction.status === 'kept' && (result.action !== 'keep' || result.findings.some(item => !['expected_failure', 'valid_check'].includes(item.kind)))) return false;
    if (correction.status === 'replaced') {
      const original = state.calibration.runs.find(item => behaviorHash(JSON.stringify(item.plan)) !== behaviorHash(JSON.stringify(state.plan)))?.plan;
      if (result.action !== 'replace' || !original || behaviorHash(JSON.stringify(result.plan)) !== behaviorHash(JSON.stringify(state.plan))) return false;
      const changed = state.plan!.checks.filter((item, index) => item.command !== original.checks[index]?.command || item.expectation !== original.checks[index]?.expectation);
      if (!changed.length || changed.some(item => !correction.evidence?.some(evidence => evidence.checkId === item.id))) return false;
    }
  }
  return state.calibration.status === 'observed' && !['running', 'unavailable'].includes(state.calibration.correction?.status ?? '') && Boolean(run && run.status === 'observed' && run.before.digest && run.before.digest === run.after?.digest && run.before.scope === run.after?.scope
    && run.receipts.length === run.plan.checks.length && run.plan.checks.every(check => run.receipts.filter(r => r.runId === run.runId && r.checkId === check.id && r.commandSha256 === behaviorHash(check.command) && r.tool === check.shell && !r.truncated && (r.status === 'passed' && r.exitCode === 0 || r.status === 'failed' && r.exitCode !== null && r.exitCode !== 0)).length === 1));
}
export function compareBehaviorBaseline(state: BehaviorState): z.infer<typeof behaviorComparisonSchema>[] {
  const baseline = behaviorBaseline(state);
  return (state.plan?.checks ?? []).map(check => {
    const before = baseline?.receipts.find(r => r.checkId === check.id), after = state.receipts.find(r => r.checkId === check.id);
    const valid = Boolean(state.runPurpose !== 'baseline' && behaviorBaselineCurrent(state) && after && after.runId === state.runId && after.tool === check.shell && after.commandSha256 === behaviorHash(check.command) && state.receipts.filter(item => item.checkId === check.id).length === 1 && !after.truncated && (after.status === 'passed' && after.exitCode === 0 || after.status === 'failed' && after.exitCode !== null && after.exitCode !== 0));
    const outcome = !valid || !before || !after ? 'unconfirmed' : before.status === 'passed' ? after.status === 'passed' ? 'unchanged_pass' : 'candidate_regression' : after.status === 'passed' ? 'changed_to_pass' : 'pre_existing_failure';
    return { checkId: check.id, outcome, sameOutput: Boolean(before && after && before.outputSha256 === after.outputSha256) };
  });
}
export function baselineNeedsDiagnosis(state: BehaviorState): boolean {
  const run = behaviorBaseline(state);
  return Boolean(run && (run.status !== 'observed' || run.plan.checks.some(check => check.kind !== 'reproduction' && run.receipts.find(r => r.checkId === check.id)?.status !== 'passed')));
}
export function behaviorNeedsEvidence(state: BehaviorState | undefined): boolean {
  return Boolean(state?.calibration && compareBehaviorBaseline(state).some(row => {
    if (!['pre_existing_failure','unconfirmed'].includes(row.outcome)) return false;
    const finding = state.calibration?.correction?.result?.findings.find(item => item.id === row.checkId);
    return finding ? finding.kind !== 'expected_failure' : state.plan?.checks.find(item => item.id === row.checkId)?.kind !== 'reproduction';
  }));
}
