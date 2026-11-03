import { executeCommand } from "../tools/command.js";
import type { VerifyCommand } from "../config.js";
import { readFile } from "node:fs/promises";

export interface VerificationResult {
  name?: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  output: string;
}

export interface VerificationReport {
  passed: boolean;
  results: VerificationResult[];
  summary: string;
}

const MAX_VERIFICATION_OUTPUT = 80_000;

export async function runVerification(root: string, commands: VerifyCommand[], signal: AbortSignal, outputRoot: string): Promise<VerificationReport> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    const result = await executeCommand({
      command: command.command,
      cwd: root,
      timeoutMs: command.timeoutMs ?? 300_000,
      maxOutputBytes: MAX_VERIFICATION_OUTPUT,
      signal,
      outputDir: outputRoot,
      outputId: `verify_${results.length}_${Date.now()}`
    });
    const output = result.truncated && result.outputPath ? await readFile(result.outputPath, "utf8") : result.combined;
    results.push({ name: command.name, command: command.command, exitCode: result.exitCode, passed: result.exitCode === 0, durationMs: result.durationMs, output });
    if (result.exitCode !== 0) break;
  }
  const passed = commands.length > 0 && results.length === commands.length && results.every((result) => result.passed);
  return { passed, results, summary: commands.length === 0 ? "No verification commands configured." : results.map((result) => `${result.passed ? "PASS" : "FAIL"} ${result.name ?? result.command} (${result.durationMs}ms)`).join("\n") };
}

export function verificationMessage(report: VerificationReport): string {
  if (report.results.length === 0) return "No automated verification is configured. Run the most relevant available checks manually.";
  return `${report.summary}\n\n${report.results.map((result) => `[${result.name ?? result.command}] ${result.command}\n${result.output || "(no output)"}`).join("\n\n")}`;
}
