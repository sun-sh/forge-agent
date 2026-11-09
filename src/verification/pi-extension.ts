import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { z } from 'zod';
import { loadConfig, type LoadedConfig } from "../config.js";
import { pforgeHome } from "../pforge-home.js";
import { runVerification, verificationMessage, VerificationInterruptedError, type VerificationReport } from "./verify.js";
import { captureWorkspace, invalidateEvidence, revalidateEvidence, verificationConfigHash, verificationEvidenceSchema, type VerificationEvidence, type WorkspaceStamp } from './evidence.js';
import { replaceMetadataFile } from '../task/persistence.js';
import { captureProtectedPaths, compareProtectedPaths, protectedCheckMessage, protectedCheckSchema, type ProtectedCheck, type ProtectedSnapshot } from './protected.js';

export interface PforgeVerificationOutcome {
  status: "unchecked" | "running" | "passed" | "failed" | "skipped";
  reason?: string;
  attempts: number;
  report?: VerificationReport;
  error?: string;
  runId?: string;
  evidenceId?: string;
  checkedAt?: string;
  evidence?: VerificationEvidence;
  protection?: ProtectedCheck;
}

export interface PforgeVerificationRuntime {
  extension: ExtensionFactory;
  outcome: PforgeVerificationOutcome;
  /** Reload the project configuration while the session is idle. */
  reload(): LoadedConfig;
  waitForVerification(signal?: AbortSignal): Promise<PforgeVerificationOutcome>;
  beginTurn(runId?: string, continuation?: PforgeVerificationOutcome): void;
  /** Capture before any model tools run; the baseline survives automatic repairs. */
  prepareTurn(signal?: AbortSignal): Promise<void>;
  verifyTrusted(signal: AbortSignal): Promise<PforgeVerificationOutcome>;
  /** Recheck evidence without executing project commands or resetting retries. */
  refreshEvidence(signal?: AbortSignal, observation?: { workspace: WorkspaceStamp; configHash: string }): Promise<PforgeVerificationOutcome>;
  invalidate(reason: string): Promise<void>;
  readonly commands: ReadonlyArray<{ name: string; command: string; timeoutMs?: number }>;
}
export const verificationOutcomeSchema = z.object({
  status: z.enum(['unchecked', 'running', 'passed', 'failed', 'skipped']), attempts: z.number().int().min(0).max(20),
  reason: z.string().optional(), error: z.string().optional(), runId: z.uuid().optional(), evidenceId: z.uuid().optional(), checkedAt: z.iso.datetime().optional(),
  evidence: verificationEvidenceSchema.optional(),
  protection: protectedCheckSchema.optional(),
  report: z.object({ passed: z.boolean(), summary: z.string(), results: z.array(z.object({ name: z.string().optional(), command: z.string(), exitCode: z.number().int().nullable(), passed: z.boolean(), durationMs: z.number().min(0), output: z.string(), failure: z.enum(['timeout', 'aborted', 'spawn_error']).optional(), error: z.string().optional(), outputPath: z.string().optional() })).max(1000) }).optional()
});

export function hasPassedReport(outcome?: PforgeVerificationOutcome): boolean {
  return outcome?.status === 'passed' && outcome.report?.passed === true && outcome.report.results.length > 0
    && outcome.report.results.every((result) => result.passed && result.exitCode === 0 && !result.failure && !result.error);
}
export function isVerified(outcome?: PforgeVerificationOutcome): boolean {
  return hasPassedReport(outcome) && (!outcome?.protection || outcome.protection.status === 'unchanged') && outcome?.evidence?.freshness === 'current' && Boolean(outcome.evidence.workspace.digest);
}
export function verificationOutcomeMessage(outcome: PforgeVerificationOutcome): string {
  return [...new Set([outcome.report ? verificationMessage(outcome.report) : outcome.reason, protectedCheckMessage(outcome.protection), outcome.error].filter(Boolean))].join('\n\n');
}
export function refreshVerificationEvidence(outcome: PforgeVerificationOutcome, workspace: WorkspaceStamp, configHash: string): PforgeVerificationOutcome {
  if (!outcome.report && !outcome.evidence) return outcome;
  const evidence = outcome.evidence ? revalidateEvidence(outcome.evidence, workspace, configHash) : {
    workspace: { version: 1 as const, scope: workspace.scope, files: 0 }, configHash,
    freshness: 'unconfirmed' as const, reason: '历史验证未绑定工作区版本，请重新验证。'
  };
  return { ...outcome, evidence };
}

function stateRoot(): string {
  return pforgeHome();
}

function workspaceKey(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function verificationOutputRoot(cwd: string): string {
  return join(stateRoot(), "verification", workspaceKey(cwd));
}

async function persistOutcome(cwd: string, outcome: PforgeVerificationOutcome): Promise<void> {
  const path = join(verificationOutputRoot(cwd), "latest.json");
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify({ cwd: resolve(cwd), updatedAt: new Date().toISOString(), ...outcome }, null, 2);
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, text, "utf8");
  await replaceMetadataFile(temporary, path);
  if (outcome.evidenceId) await writeFile(join(dirname(path), outcome.evidenceId + '.json'), text, 'utf8');
}

export function createPforgeVerification(cwd = process.cwd(), options: {
  executionBlockReason?: () => string | undefined;
  isProjectTrusted?: () => boolean;
  managed?: () => boolean;
  onOutcome?: (outcome: PforgeVerificationOutcome) => void;
  initialOutcome?: PforgeVerificationOutcome;
} = {}): PforgeVerificationRuntime {
  let loaded = loadConfig(cwd);
  let commands = loaded.config.verify;
  let retries = loaded.config.verifyRetries;
  let protect = loaded.config.protect;
  let protectionBaseline: Promise<ProtectedSnapshot> | undefined;
  const outcome: PforgeVerificationOutcome = options.initialOutcome ? structuredClone(options.initialOutcome) : { status: "unchecked", attempts: 0 };
  if (outcome.status === 'running') { outcome.status = 'failed'; outcome.error = 'Verification was interrupted; run it again explicitly.'; }
  let contextTrust: (() => boolean) | undefined;
  const trusted = () => options.isProjectTrusted?.() ?? contextTrust?.() ?? false;
  const persist = async () => { await persistOutcome(cwd, outcome); options.onOutcome?.(structuredClone(outcome)); };
  const reload = (): LoadedConfig => {
    const next = loadConfig(cwd);
    loaded = next;
    commands = next.config.verify;
    retries = next.config.verifyRetries;
    protect = next.config.protect;
    return next;
  };
  const beginTurn = (runId = randomUUID(), continuation?: PforgeVerificationOutcome) => {
    for (const key of Object.keys(outcome)) delete (outcome as unknown as Record<string, unknown>)[key];
    Object.assign(outcome, { status: 'unchecked', attempts: continuation?.attempts ?? 0, runId,
      ...(continuation?.protection ? { protection: structuredClone(continuation.protection) } : {}) });
    protectionBaseline = undefined;
    options.onOutcome?.(structuredClone(outcome));
  };
  const blocked = (): string | undefined => {
    const reason = options.executionBlockReason?.();
    if (reason) { outcome.status = "skipped"; outcome.reason = reason; outcome.report = undefined; outcome.error = undefined; }
    return reason;
  };
  const prepareTurn = async (signal?: AbortSignal) => {
    if (!protect.length || !trusted()) return;
    protectionBaseline ??= outcome.protection ? Promise.resolve(outcome.protection.baseline) : captureProtectedPaths(cwd, protect, signal);
    const baseline = await protectionBaseline;
    if (!outcome.protection) {
      outcome.protection = compareProtectedPaths(baseline, baseline);
      // Commit the original bytes before granting the model its first tool
      // turn. A restored execution must not adopt post-crash edits as baseline.
      await persist();
    }
  };
  const checkProtection = async (signal?: AbortSignal) => {
    if (!protect.length && !outcome.protection) return;
    if (!protectionBaseline && outcome.protection) protectionBaseline = Promise.resolve(outcome.protection.baseline);
    if (!protectionBaseline) await prepareTurn(signal);
    const baseline = await protectionBaseline;
    if (!baseline) throw new Error('Protected-path baseline is unavailable.');
    outcome.protection = compareProtectedPaths(baseline, await captureProtectedPaths(cwd, protect, signal));
    if (outcome.protection.status !== 'unchanged') { outcome.status = 'failed'; outcome.error = protectedCheckMessage(outcome.protection); }
  };
  const invalidate = async (reason: string) => {
    if (!outcome.report && !outcome.evidence) return;
    const evidence = outcome.evidence ?? { workspace: { version: 1 as const, scope: 'directory' as const, files: 0 }, configHash: verificationConfigHash(commands, protect), freshness: 'unconfirmed' as const };
    const next = invalidateEvidence(evidence, reason);
    if (JSON.stringify(next) !== JSON.stringify(outcome.evidence)) { outcome.evidence = next; await persist(); }
  };
  const refreshEvidence = async (signal?: AbortSignal, observation?: { workspace: WorkspaceStamp; configHash: string }) => {
    if (inFlight || (!outcome.report && !outcome.evidence && !outcome.protection)) return outcome;
    if (!trusted()) { await invalidate('项目信任已撤销，请信任项目并重新验证。'); return outcome; }
    const evidenceId = outcome.evidenceId;
    let configHash: string;
    try { const current = loadConfig(cwd).config; configHash = observation?.configHash ?? verificationConfigHash(current.verify, current.protect); }
    catch { await invalidate('无法确认当前验证配置，请修复配置后重新验证。'); return outcome; }
    const workspace = observation?.workspace ?? await captureWorkspace(cwd, signal);
    if (inFlight || outcome.evidenceId !== evidenceId) return outcome;
    const next = refreshVerificationEvidence(outcome, workspace, configHash);
    const previousProtection = JSON.stringify(outcome.protection);
    await checkProtection(signal);
    if (outcome.protection?.status !== 'unchanged' && outcome.protection && next.evidence) next.evidence = invalidateEvidence(next.evidence, protectedCheckMessage(outcome.protection));
    if (JSON.stringify(next.evidence) !== JSON.stringify(outcome.evidence) || previousProtection !== JSON.stringify(outcome.protection)) { outcome.evidence = next.evidence; await persist(); }
    return outcome;
  };

  let inFlight: Promise<VerificationReport> | undefined;
  const run = (signal: AbortSignal): Promise<VerificationReport> => {
    if (inFlight) return inFlight;
    outcome.runId ??= randomUUID();
    outcome.evidenceId = randomUUID();
    outcome.status = "running";
    outcome.report = undefined;
    outcome.error = undefined;
    outcome.reason = undefined;
    outcome.evidence = undefined;
    options.onOutcome?.(structuredClone(outcome));
    const configHash = verificationConfigHash(commands, protect);
    let before: WorkspaceStamp;
    const current = prepareTurn(signal).then(() => captureWorkspace(cwd, signal)).then((workspace) => { before = workspace; return runVerification(cwd, commands, signal, verificationOutputRoot(cwd)); })
      .then(async (report) => {
        outcome.report = report;
        outcome.status = report.passed ? "passed" : "failed";
        outcome.checkedAt = new Date().toISOString();
        const after = await captureWorkspace(cwd, signal);
        const stable = Boolean(before.digest && before.digest === after.digest && before.scope === after.scope);
        outcome.evidence = { workspace: after, configHash, freshness: stable ? 'current' : 'unconfirmed',
          ...(!stable ? { reason: '验证期间工作区发生变化或未能完整读取，请检查生成文件的忽略规则并重新验证。' } : {}) };
        await checkProtection(signal);
        if (!commands.length && outcome.protection?.status === 'unchanged') { outcome.status = 'skipped'; outcome.reason = 'No verification commands configured; protected paths are unchanged.'; outcome.report = undefined; outcome.evidence = undefined; }
        if (outcome.protection && outcome.protection.status !== 'unchanged' && outcome.evidence) outcome.evidence = invalidateEvidence(outcome.evidence, protectedCheckMessage(outcome.protection));
        await persist();
        return report;
      })
      .catch(async (error) => {
        outcome.status = "failed";
        if (error instanceof VerificationInterruptedError) outcome.report = error.report;
        outcome.error = error instanceof Error ? error.message : String(error);
        outcome.checkedAt = new Date().toISOString();
        await persist();
        throw error;
      })
      .finally(() => { inFlight = undefined; });
    inFlight = current;
    return current;
  };

  const extension: ExtensionFactory = (pi: ExtensionAPI) => {
    pi.on('session_start', (_event, ctx) => { contextTrust = () => ctx.isProjectTrusted(); });
    pi.on('before_agent_start', async (event, ctx) => {
      contextTrust = () => ctx.isProjectTrusted();
      if (event.messageType === 'user' && !options.managed?.()) { beginTurn(); blocked(); options.onOutcome?.(structuredClone(outcome)); }
      await prepareTurn(ctx.signal);
      if (protect.length) event.systemPromptOptions.sections['forge_protection'] = 'These configured project-relative paths are protected for this execution, including existing user edits: ' + JSON.stringify(protect) + '. Do not change, add or delete them. The host compares their content to the pre-execution baseline independently of test exit codes.';
    });
    pi.registerTool(defineTool({
      name: "run_verification",
      label: "Run Verification",
      description: "Run the project verification commands configured in forge-agent.json. Use before claiming completion.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const reason = blocked();
        if (reason) return { content: [{ type: "text", text: reason }], details: { passed: false }, isError: true };
        if (!ctx.isProjectTrusted()) {
          const message = "Project is not trusted; refusing to run project verification commands.";
          outcome.status = "failed";
          outcome.error = message;
          return { content: [{ type: "text", text: message }], details: { passed: false }, isError: true };
        }
        const report = await run(signal ?? new AbortController().signal);
        return {
          content: [{ type: "text", text: verificationOutcomeMessage(outcome) + (report.passed && !isVerified(outcome) && outcome.status !== 'failed' ? '\n\nWorkspace freshness is unconfirmed. These commands passed, but this is not current-version completion evidence. Recheck before claiming verified completion.' : '') }],
          details: { passed: isVerified(outcome), summary: report.summary, freshness: outcome.evidence?.freshness, protection: outcome.protection?.status },
          isError: outcome.status === 'failed' || !report.passed
        };
      }
    }));

    pi.registerCommand("verify", {
      description: "Run the verification commands configured in forge-agent.json",
      handler: async (_args, ctx) => {
        const reason = blocked();
        if (reason) { ctx.ui.notify(reason, "warning"); return; }
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify("Project is not trusted; refusing to run project verification commands.", "error");
          return;
        }
        const report = await run(ctx.signal ?? new AbortController().signal);
        ctx.ui.notify(verificationOutcomeMessage(outcome), outcome.status === 'failed' || !report.passed ? 'error' : 'info');
      }
    });

    pi.on("agent_before_settle", async (event, ctx) => {
      if (event.outcome !== "completed" || event.continue || commands.length === 0 && protect.length === 0) return;
      if (options.managed?.()) return;
      if (blocked()) return;
      if (!ctx.isProjectTrusted()) {
        outcome.status = "failed";
        outcome.error = "Project is not trusted; refusing to run project verification commands.";
        ctx.ui.notify(outcome.error, "error");
        return;
      }
      try {
        const report = await run(ctx.signal ?? new AbortController().signal);
        if (outcome.status === 'skipped') return;
        if (report.passed && outcome.status !== 'failed') {
          ctx.ui.notify(isVerified(outcome) ? 'Verification passed' : 'Verification commands passed; workspace freshness is unconfirmed. Run verification again before claiming verified completion.', isVerified(outcome) ? 'info' : 'warning');
          return;
        }
        if (outcome.attempts < retries) {
          outcome.attempts++;
          await persist();
          ctx.ui.notify(`Verification failed. Returning errors to the agent (${outcome.attempts}/${retries}).`, "warning");
          return {
            continue: true,
            entries: [{
              type: "custom_message",
              customType: "pforge.verification_failed",
              display: false,
              content: `Automated verification or protected-path integrity failed. Diagnose and fix the root cause, then finish again. Do not claim success.\n\n${verificationOutcomeMessage(outcome)}`
            }]
          };
        }
        ctx.ui.notify(`Verification failed. The task is not complete after ${retries} repair attempt(s).`, "error");
      } catch (error) {
        outcome.status = "failed";
        outcome.error = error instanceof Error ? error.message : String(error);
        await persist();
        ctx.ui.notify(`Verification could not run: ${outcome.error}`, "error");
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus("pforge", `verification: ${commands.length} configured`);
    });
  };

  return {
    extension,
    outcome,
    reload,
    beginTurn,
    prepareTurn,
    invalidate,
    refreshEvidence,
    async verifyTrusted(signal) {
      if (blocked()) return outcome;
      if (!trusted()) { outcome.status = 'failed'; outcome.error = 'Project is not trusted; refusing to run project verification commands.'; await persist(); return outcome; }
      if (!commands.length && !protect.length) { outcome.status = 'skipped'; outcome.reason = 'No verification commands configured.'; await persist(); return outcome; }
      await run(signal);
      return outcome;
    },
    async waitForVerification(signal = new AbortController().signal): Promise<PforgeVerificationOutcome> {
      if (blocked()) return outcome;
      if (!trusted()) { outcome.status = 'failed'; outcome.error = 'Project is not trusted; refusing to run project verification commands.'; return outcome; }
      if (outcome.status === "unchecked" || outcome.status === "running") {
        await run(signal);
      } else await refreshEvidence(signal);
      return outcome;
    },
    get commands() { return commands; }
  };
}
