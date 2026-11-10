import { spawn } from "node:child_process";
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
  failure?: CommandFailure;
  error?: string;
}

export type CommandFailure = 'timeout' | 'aborted' | 'spawn_error';

export class CommandExecutionError extends Error {
  constructor(message: string, readonly result: CommandOutputResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommandExecutionError';
  }
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
    // Do not freeze the host event loop while Windows walks a process tree.
    // Network updates, cancellation and test timeouts must remain responsive.
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const fallback = () => { try { child.kill(); } catch { /* already gone */ } };
    const guard = setTimeout(() => { killer.kill(); fallback(); }, 5000); guard.unref();
    killer.once("error", () => { clearTimeout(guard); fallback(); });
    killer.once("close", (code) => { clearTimeout(guard); if (code !== 0) fallback(); });
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
  const failure: CommandFailure | undefined = aborted ? 'aborted' : timedOut ? 'timeout' : spawnError ? 'spawn_error' : undefined;
  const error = failure === 'aborted' ? 'Command aborted' : failure === 'timeout' ? `Command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : spawnError?.message;
  const result: CommandOutputResult = {
    exitCode: spawnError ? null : exitCode,
    stdout: output.toBuffer().toString("utf8"),
    stderr: errorOutput.toBuffer().toString("utf8"),
    combined: allOutput.toBuffer().toString("utf8"),
    truncated: output.truncated || errorOutput.truncated || allOutput.truncated,
    durationMs: Math.round(performance.now() - started),
    ...(failure || output.truncated || errorOutput.truncated || allOutput.truncated ? { outputPath } : {}),
    ...(failure ? { failure, error } : {})
  };
  if (failure) throw new CommandExecutionError(error!, result, spawnError ? { cause: spawnError } : undefined);
  return result;
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
