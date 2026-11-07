import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { z } from 'zod';
import { loadConfig, type LoadedConfig } from "../config.js";
import { pforgeHome } from "../pforge-home.js";
import { runVerification, verificationMessage, VerificationInterruptedError, type VerificationReport } from "./verify.js";

export interface PforgeVerificationOutcome {
  status: "unchecked" | "running" | "passed" | "failed" | "skipped";
  reason?: string;
  attempts: number;
  report?: VerificationReport;
  error?: string;
  runId?: string;
  evidenceId?: string;
  checkedAt?: string;
}

export interface PforgeVerificationRuntime {
  extension: ExtensionFactory;
  outcome: PforgeVerificationOutcome;
  /** Reload the project configuration while the session is idle. */
  reload(): LoadedConfig;
  waitForVerification(signal?: AbortSignal): Promise<PforgeVerificationOutcome>;
  beginTurn(runId?: string): void;
  verifyTrusted(signal: AbortSignal): Promise<PforgeVerificationOutcome>;
  readonly commands: ReadonlyArray<{ name: string; command: string; timeoutMs?: number }>;
}
export const verificationOutcomeSchema = z.object({
  status: z.enum(['unchecked', 'running', 'passed', 'failed', 'skipped']), attempts: z.number().int().min(0).max(20),
  reason: z.string().optional(), error: z.string().optional(), runId: z.uuid().optional(), evidenceId: z.uuid().optional(), checkedAt: z.iso.datetime().optional(),
  report: z.object({ passed: z.boolean(), summary: z.string(), results: z.array(z.object({ name: z.string().optional(), command: z.string(), exitCode: z.number().int().nullable(), passed: z.boolean(), durationMs: z.number().min(0), output: z.string(), failure: z.enum(['timeout', 'aborted', 'spawn_error']).optional(), error: z.string().optional(), outputPath: z.string().optional() })).max(1000) }).optional()
});

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
  await rename(temporary, path);
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
    return next;
  };
  const beginTurn = (runId = randomUUID()) => {
    for (const key of Object.keys(outcome)) delete (outcome as unknown as Record<string, unknown>)[key];
    Object.assign(outcome, { status: 'unchecked', attempts: 0, runId });
    options.onOutcome?.(structuredClone(outcome));
  };
  const blocked = (): string | undefined => {
    const reason = options.executionBlockReason?.();
    if (reason) { outcome.status = "skipped"; outcome.reason = reason; outcome.report = undefined; outcome.error = undefined; }
    return reason;
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
    options.onOutcome?.(structuredClone(outcome));
    const current = runVerification(cwd, commands, signal, verificationOutputRoot(cwd))
      .then(async (report) => {
        outcome.report = report;
        outcome.status = report.passed ? "passed" : "failed";
        outcome.checkedAt = new Date().toISOString();
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
    pi.on('before_agent_start', (event) => {
      if (event.messageType === 'user' && !options.managed?.()) { beginTurn(); blocked(); options.onOutcome?.(structuredClone(outcome)); }
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
          content: [{ type: "text", text: verificationMessage(report) }],
          details: { passed: report.passed, summary: report.summary },
          isError: !report.passed
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
        ctx.ui.notify(report.summary, report.passed ? "info" : "error");
      }
    });

    pi.on("agent_before_settle", async (event, ctx) => {
      if (event.outcome !== "completed" || commands.length === 0) return;
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
        if (report.passed) {
          ctx.ui.notify("Verification passed", "info");
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
              content: `Automated verification failed. Diagnose and fix the root cause, then finish again. Do not claim success.\n\n${verificationMessage(report)}`
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
    async verifyTrusted(signal) {
      if (blocked()) return outcome;
      if (!trusted()) { outcome.status = 'failed'; outcome.error = 'Project is not trusted; refusing to run project verification commands.'; await persist(); return outcome; }
      if (!commands.length) { outcome.status = 'skipped'; outcome.reason = 'No verification commands configured.'; await persist(); return outcome; }
      await run(signal);
      return outcome;
    },
    async waitForVerification(signal = new AbortController().signal): Promise<PforgeVerificationOutcome> {
      if (blocked()) return outcome;
      if (!trusted()) { outcome.status = 'failed'; outcome.error = 'Project is not trusted; refusing to run project verification commands.'; return outcome; }
      if (outcome.status === "unchecked" || outcome.status === "running") {
        await run(signal);
      }
      return outcome;
    },
    get commands() { return commands; }
  };
}
