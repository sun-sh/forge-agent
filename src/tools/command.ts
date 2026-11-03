import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "../protocol.js";

export interface CommandOutputResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  truncated: boolean;
  durationMs: number;
  outputPath?: string;
}

interface CommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
const HARD_MAX_OUTPUT = 1024 * 1024;

export class OutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer): void {
    if (this.bytes + chunk.length <= this.limit) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return;
    }
    const remaining = this.limit - this.bytes;
    if (remaining > 0) this.chunks.push(chunk.subarray(0, remaining));
    this.truncated = true;
    this.bytes = this.limit;
  }
  toBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

export interface ExecuteCommandOptions extends CommandInput {
  signal: AbortSignal;
  outputDir: string;
  outputId: string;
  env?: NodeJS.ProcessEnv;
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
    setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }, 1_000).unref();
  }
}

export async function executeCommand(options: ExecuteCommandOptions): Promise<CommandOutputResult> {
  options.signal.throwIfAborted();
  const started = performance.now();
  const maxBytes = Math.min(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, HARD_MAX_OUTPUT);
  const output = new OutputBuffer(maxBytes);
  const errorOutput = new OutputBuffer(maxBytes);
  const allOutput = new OutputBuffer(maxBytes);
  const outputPath = join(options.outputDir, `${options.outputId}.log`);
  mkdirSync(options.outputDir, { recursive: true });
  const stream = createWriteStream(outputPath, { flags: "w" });
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | undefined;

  const shell = process.platform === "win32" ? process.env["ComSpec"] ?? "cmd.exe" : process.env["SHELL"] ?? "/bin/sh";
  // cmd /s strips the outer pair; preserve the command's own quotes verbatim.
  const args = process.platform === "win32" ? ["/d", "/s", "/c", '"' + options.command + '"'] : ["-lc", options.command];
  const child = spawn(shell, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const append = (buffer: OutputBuffer, chunk: Buffer): void => {
    buffer.append(chunk);
    allOutput.append(chunk);
    if (!stream.destroyed) stream.write(chunk);
  };
  child.stdout?.on("data", (chunk: Buffer) => append(output, chunk));
  child.stderr?.on("data", (chunk: Buffer) => append(errorOutput, chunk));
  const timeout = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => { aborted = true; killTree(child); };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  child.on("error", (error) => { spawnError = error; });
  const exitCode = await new Promise<number | null>((resolve) => { child.on("close", (code) => resolve(code)); });
  clearTimeout(timeout);
  options.signal.removeEventListener("abort", onAbort);
  await new Promise<void>((resolve, reject) => stream.end((error?: Error) => error ? reject(error) : resolve()));
  if (spawnError) throw spawnError;
  if (aborted) throw new Error("Command aborted");
  if (timedOut) throw new Error(`Command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  return {
    exitCode,
    stdout: output.toBuffer().toString("utf8"),
    stderr: errorOutput.toBuffer().toString("utf8"),
    combined: allOutput.toBuffer().toString("utf8"),
    truncated: output.truncated || errorOutput.truncated || allOutput.truncated,
    durationMs: Math.round(performance.now() - started),
    ...(output.truncated || errorOutput.truncated || allOutput.truncated ? { outputPath } : {})
  };
}

export function createCommandTool(run: (input: CommandInput, context: ToolExecutionContext) => Promise<CommandOutputResult>): ToolDefinition<CommandInput> {
  return {
    name: "shell",
    description: "Execute a shell command in the workspace. Use for tests, builds, git inspection, and other terminal work. Commands must be non-interactive.",
    effect: "execute",
    parallelSafe: false,
    approval: { mode: "remote", risk: "high", reason: "Shell commands can access the host and network" },
    inputSchema: {
      type: "object", additionalProperties: false, required: ["command"],
      properties: {
        command: { type: "string", description: "Non-interactive shell command." },
        cwd: { type: "string", description: "Optional workspace-relative working directory." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000 },
        maxOutputBytes: { type: "integer", minimum: 1024, maximum: 1048576 }
      }
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const result = await run(input, context);
      const outputText = result.combined.trim() || "(no output)";
      const notes: string[] = [];
      if (result.truncated) notes.push(`[Output truncated.${result.outputPath ? ` Full log: ${result.outputPath}` : ""}]`);
      return {
        isError: result.exitCode !== 0,
        content: [{ type: "text", text: `${outputText}\n\n${notes.join("\n")}`.trim() }],
        metadata: { exitCode: result.exitCode ?? -1, durationMs: result.durationMs, truncated: result.truncated, ...(result.outputPath ? { outputPath: result.outputPath } : {}) }
      };
    }
  };
}
