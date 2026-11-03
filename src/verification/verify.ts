import { CommandExecutionError, executeCommand, type CommandFailure, type CommandOutputResult } from "../tools/command.js";
import type { VerifyCommand } from "../config.js";
import { readFile } from "node:fs/promises";

export interface VerificationResult {
  name?: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  output: string;
  failure?: CommandFailure;
  error?: string;
  outputPath?: string;
}

export interface VerificationReport {
  passed: boolean;
  results: VerificationResult[];
  summary: string;
}

const MAX_VERIFICATION_OUTPUT = 80_000;

export class VerificationInterruptedError extends Error {
  constructor(readonly report: VerificationReport, cause: unknown) {
    super('Verification interrupted by cancellation.', { cause });
    this.name = 'VerificationInterruptedError';
  }
}

function summarize(commands: VerifyCommand[], results: VerificationResult[]): VerificationReport {
  const passed = commands.length > 0 && results.length === commands.length && results.every((result) => result.passed);
  const summary = commands.length === 0 ? 'No verification commands configured.' : results.map((result) => `${result.passed ? 'PASS' : 'FAIL'} ${result.name ?? result.command} (${result.durationMs}ms)${result.error ? ': ' + result.error : ''}`).join('\n');
  return { passed, results, summary };
}

export async function runVerification(root: string, commands: VerifyCommand[], signal: AbortSignal, outputRoot: string): Promise<VerificationReport> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    signal.throwIfAborted();
    let result: CommandOutputResult;
    let interruption: CommandExecutionError | undefined;
    try {
      result = await executeCommand({
        command: command.command,
        cwd: root,
        timeoutMs: command.timeoutMs ?? 300_000,
        maxOutputBytes: MAX_VERIFICATION_OUTPUT,
        signal,
        outputDir: outputRoot,
        outputId: `verify_${results.length}_${Date.now()}`
      });
    } catch (error) {
      if (!(error instanceof CommandExecutionError)) throw error;
      result = error.result;
      if (result.failure === 'aborted') interruption = error;
    }
    const output = result.truncated && result.outputPath ? await readFile(result.outputPath, "utf8") : result.combined;
    const passed = result.exitCode === 0 && !result.failure;
    results.push({ name: command.name, command: command.command, exitCode: result.exitCode, passed, durationMs: result.durationMs, output,
      ...(result.failure ? { failure: result.failure, error: result.error } : {}), ...(result.outputPath ? { outputPath: result.outputPath } : {}) });
    if (interruption) throw new VerificationInterruptedError(summarize(commands, results), interruption);
    signal.throwIfAborted();
    if (!passed) break;
  }
  return summarize(commands, results);
}

export function verificationMessage(report: VerificationReport): string {
  if (report.results.length === 0) return "No automated verification is configured. Run the most relevant available checks manually.";
  return `${report.summary}\n\n${report.results.map((result) => `[${result.name ?? result.command}] ${result.command}\n${result.output || "(no output)"}`).join("\n\n")}`;
}
