#!/usr/bin/env node
import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { CodingAgent, closeCodingAgent, listSessions, readPackageVersion, stateDirectory } from "./app.js";
import { loadConfig, findProjectRoot, resolveApiKey } from "./config.js";
import { startWebConsole } from "./web/server.js";
import { prepareDemoWorkspace } from "./web/demo-workspace.js";
import { SessionStore } from "./storage/session.js";
import { CheckpointManager } from "./storage/checkpoint.js";
import { readTrace } from "./storage/trace.js";
import { formatMetrics } from "./observability/metrics.js";
import { describeAgentError } from "./provider/errors.js";
import { PathGuard } from "./security/path-guard.js";
import type { ApprovalDecision, ApprovalRequest, RuntimeEvent } from "./protocol.js";

interface GlobalOptions {
  cwd: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  thinking?: "off" | "low" | "medium" | "high";
  approval?: "ask" | "auto" | "deny";
  readonly?: boolean;
  json?: boolean;
  quiet?: boolean;
  resume?: string;
  session?: string;
}

function printEvent(event: RuntimeEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  switch (event.type) {
    case "text_delta": process.stdout.write(event.text); break;
    case "tool_call_start": process.stderr.write(`\n${pc.cyan("tool")} ${event.name} ${pc.dim(preview(event.input))}\n`); break;
    case "tool_call_end": process.stderr.write(`${event.result.isError ? pc.red("failed") : pc.green("ok")} ${event.name} ${event.durationMs}ms\n`); break;
    case "status": process.stderr.write(`${pc.dim(event.message)}\n`); break;
    case "warning": process.stderr.write(`${pc.yellow("warning")} ${event.message}\n`); break;
    case "run_end": process.stderr.write(`\n${event.status === "completed" ? pc.green("completed") : event.status === "aborted" ? pc.yellow("aborted") : pc.red(event.status)}${event.error ? `: ${event.error}` : ""}\n`); break;
    default: break;
  }
}

function preview(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return (raw ?? "").replace(/\s+/g, " ").slice(0, 180);
}

async function makeApprovalHandler(options: GlobalOptions): Promise<(request: ApprovalRequest) => Promise<ApprovalDecision>> {
  if (options.approval === "auto") return async () => ({ type: "allow" });
  if (options.approval === "deny") return async () => ({ type: "deny", reason: "Approval policy is deny" });
  if (!input.isTTY) return async (request) => ({ type: "deny", reason: `Non-interactive mode refused ${request.risk}-risk ${request.toolName} action` });
  const rl = createInterface({ input, output });
  try {
    return async (request) => {
      output.write(`\n${pc.yellow("Approval required")} [${request.risk}] ${request.toolName}\n${request.summary}\n${pc.dim(request.reason)}\nAllow? [y/N] `);
      const answer = (await rl.question("")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return { type: "allow" };
      return { type: "deny", reason: "User declined" };
    };
  } finally {
    // handler must outlive this function; closing happens when process exits.
  }
}

function overrides(options: GlobalOptions): Record<string, unknown> {
  return {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.approval ? { approvalMode: options.approval } : {}),
    ...(options.readonly ? { sandboxMode: "read-only" as const } : {})
  };
}

async function runPrompt(prompt: string, options: GlobalOptions, requireChanges = false): Promise<void> {
  const root = resolve(options.cwd);
  const loaded = loadConfig(root, overrides(options));
  const apiKey = resolveApiKey(loaded.config);
  if (!apiKey) {
    process.stderr.write(`${pc.red("Missing API key")} for ${loaded.config.provider}. Set the provider API key or use --provider/--model.\n`);
    process.exitCode = 2;
    return;
  }
  const session = options.resume || options.session ? SessionStore.open(options.resume ?? options.session!) : undefined;
  const agent = new CodingAgent({ cwd: root, config: loaded.config, session, approvalHandler: await makeApprovalHandler(options) });
  await agent.inspect();
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await agent.run({ prompt, signal: controller.signal, requireChanges, onEvent: (event: RuntimeEvent) => printEvent(event, Boolean(options.json)) });
    if (options.json) process.stdout.write(`${JSON.stringify({ answer: result.answer, status: result.status, session: result.sessionPath, trace: result.tracePath, verification: result.verification, metrics: result.metrics })}\n`);
    else {
      if (result.verification && !result.verification.passed) process.stderr.write(`${pc.red("Verification failed")}\n${result.verification.summary}\n`);
      process.stdout.write(`\n\n${pc.dim(formatMetrics(result.metrics))}\n${pc.dim(`session: ${result.sessionPath}`)}\n${pc.dim(`trace: ${result.tracePath}`)}\n`);
    }
    if (result.status !== "completed" || (result.verification && !result.verification.passed)) {
      if (result.error) process.stderr.write(`${pc.red(describeAgentError(new Error(result.error)))}\n`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function interactive(options: GlobalOptions): Promise<void> {
  const root = resolve(options.cwd);
  const loaded = loadConfig(root, overrides(options));
  const apiKey = resolveApiKey(loaded.config);
  if (!apiKey) {
    process.stderr.write(`${pc.red("Missing API key")} for ${loaded.config.provider}. Set the provider API key or use --provider/--model.\n`);
    process.exitCode = 2;
    return;
  }
  const agent = new CodingAgent({ cwd: root, config: loaded.config, approvalHandler: await makeApprovalHandler(options) });
  await agent.inspect();
  process.stderr.write(`${pc.bold("Pi Forge")} ${pc.dim(`${loaded.config.provider}/${loaded.config.model} · ${root}`)}\n${pc.dim("Enter a task. /exit to quit, /status for state.")}\n`);
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const message = (await rl.question(`\n${pc.cyan("> ")}`)).trim();
      if (!message) continue;
      if (message === "/exit" || message === "/quit") break;
      if (message === "/status") {
        process.stderr.write(`session: ${agent.session.sessionPath}\ntrace: ${agent.trace.tracePath}\ncwd: ${root}\nmodel: ${loaded.config.model}\n`);
        continue;
      }
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once("SIGINT", onSignal);
      try {
        const result = await agent.run({ prompt: message, signal: controller.signal, onEvent: (event: RuntimeEvent) => printEvent(event, false) });
        if (result.verification && !result.verification.passed) process.stderr.write(`${pc.red("Verification failed")}\n${result.verification.summary}\n`);
      } catch (error) {
        process.stderr.write(`${pc.red(error instanceof Error ? error.message : String(error))}\n`);
      } finally {
        process.removeListener("SIGINT", onSignal);
      }
    }
  } finally {
    rl.close();
  }
}

async function doctor(options: GlobalOptions): Promise<void> {
  const root = resolve(options.cwd);
  const loaded = loadConfig(root, overrides(options));
  const key = resolveApiKey(loaded.config);
  const checks = [
    ["Node", process.version, Number(process.versions.node.split(".")[0]) >= 22],
    ["Project root", findProjectRoot(root), true],
    ["Config", loaded.sources.length ? loaded.sources.join(", ") : "(defaults)", true],
    ["Provider", loaded.config.provider, true],
    ["Model", loaded.config.model, true],
    ["API key", key ? `configured (${key.slice(0, 4)}…)` : "missing", Boolean(key)],
    ["Path guard", "enabled", true],
    ["Approval", loaded.config.approvalMode, true],
    ["Read-only", String(loaded.config.sandboxMode === "read-only"), true],
    ["Verification commands", String(loaded.config.verify.length), true],
    ["MCP servers", `${Object.values(loaded.config.mcpServers).filter((server) => server.enabled).length} enabled`, true]
  ] as const;
  for (const [name, value, ok] of checks) process.stdout.write(`${ok ? pc.green("PASS") : pc.red("FAIL")} ${name}: ${value}\n`);
  for (const warning of loaded.warnings) process.stderr.write(`${pc.yellow("WARN")} ${warning}\n`);
  if (checks.some(([, , ok]) => !ok)) process.exitCode = 1;
}

async function sessions(options: GlobalOptions): Promise<void> {
  const root = resolve(options.cwd);
  const all = listSessions(root, stateDirectory(root));
  if (!all.length) { process.stdout.write("No sessions found.\n"); return; }
  for (const session of all) process.stdout.write(`${session.id} ${session.updatedAt} ${session.messages} msgs ${session.title ?? ""}\n  ${session.path}\n`);
}

async function showTrace(path: string): Promise<void> {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Trace not found: ${resolved}`);
  for (const record of await readTrace(resolved)) process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function jsonlServe(options: GlobalOptions): Promise<void> {
  const root = resolve(options.cwd);
  const loaded = loadConfig(root, overrides(options));
  const agent = new CodingAgent({ cwd: root, config: loaded.config, approvalHandler: await makeApprovalHandler({ ...options, approval: options.approval ?? "deny" }) });
  await agent.inspect();
  const rl = createInterface({ input });
  output.write(`${JSON.stringify({ type: "ready", sessionId: agent.session.id })}\n`);
  let active = new AbortController();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: { id?: string; type?: string; prompt?: string; command?: string };
    try { request = JSON.parse(line) as typeof request; } catch { output.write(`${JSON.stringify({ type: "error", error: "invalid JSON" })}\n`); continue; }
    if (request.command === "abort" || request.type === "abort") { active.abort(); active = new AbortController(); output.write(`${JSON.stringify({ type: "aborted", id: request.id })}\n`); continue; }
    if (request.command !== "run" && request.type !== "prompt") { output.write(`${JSON.stringify({ type: "error", id: request.id, error: "unknown command" })}\n`); continue; }
    try {
      const result = await agent.run({ prompt: request.prompt ?? "", signal: active.signal, onEvent: (event) => output.write(`${JSON.stringify({ id: request.id, ...event })}\n`) });
      output.write(`${JSON.stringify({ id: request.id, type: "result", status: result.status, answer: result.answer, session: result.sessionPath, trace: result.tracePath, verification: result.verification, metrics: result.metrics })}\n`);
    } catch (error) { output.write(`${JSON.stringify({ id: request.id, type: "error", error: error instanceof Error ? error.message : String(error) })}\n`); }
  }
}

async function restore(options: GlobalOptions, manifest: string): Promise<void> {
  const root = resolve(options.cwd);
  const loaded = loadConfig(root);
  const store = stateDirectory(root);
  const session = SessionStore.create(root, store);
  const manager = new CheckpointManager(root, session);
  const checkpoint = await manager.create("before-restore");
  const restored = await CheckpointManager.restore(resolve(manifest));
  process.stdout.write(`Restored ${restored.files.length} files from ${manifest}\nSafety checkpoint: ${checkpoint.id}\n`);
}

const program = new Command();
program.name("pforge").description("Independent coding agent with guarded tools, verification, checkpoints, tracing, and evaluation.").version(readPackageVersion());
program.option("-C, --cwd <path>", "working directory", process.cwd());
program.option("--provider <provider>", "openai | openai-responses | anthropic | openai-compatible | anthropic-compatible");
program.option("--model <model>", "model id");
program.option("--base-url <url>", "provider base URL");
program.option("--thinking <level>", "off | low | medium | high");
program.option("--approval <mode>", "ask | auto | deny");
program.option("--readonly", "disable all writes");
program.option("--json", "machine-readable output");
program.option("--quiet", "suppress nonessential output");
program.option("--resume <path>", "resume a session JSONL file");
program.option("--session <path>", "session JSONL file");

program.command("run [prompt...]")
  .description("Run one task")
  .option("--stdin", "read prompt from stdin")
  .option("--require-changes", "fail unless the run changes a non-test file")
  .action(async (parts: string[], commandOptions: { stdin?: boolean; requireChanges?: boolean }) => {
    const options = program.opts<GlobalOptions>();
    let prompt = parts.join(" ").trim();
    if (!prompt) throw new Error("A prompt or --stdin is required");
    await runPrompt(prompt, options, commandOptions.requireChanges ?? false);
  });

program.command("ui").description("Start the local Web Console").option("--port <port>", "port to listen on", "4317").option("--host <host>", "bind address", "127.0.0.1").option("--demo", "use a deterministic demo provider without an API key").action(async (commandOptions: { port: string; host: string; demo?: boolean }) => {
  const options = program.opts<GlobalOptions>();
  const loaded = loadConfig(resolve(options.cwd), overrides(options));
  const { startDemoProvider } = await import("./web/demo-provider.js");
  const demo = commandOptions.demo || !resolveApiKey(loaded.config) ? await startDemoProvider() : undefined;
  const cwd = demo ? await prepareDemoWorkspace(resolve(options.cwd)) : resolve(options.cwd);
  const demoOverrides = demo ? { provider: "openai-compatible" as const, model: "pforge-demo", baseUrl: demo.baseUrl, apiKeyEnv: "PFORGE_DEMO_KEY" } : undefined;
  const consoleServer = await startWebConsole({ cwd, host: commandOptions.host, port: Number(commandOptions.port), config: demoOverrides, env: { ...process.env, PFORGE_DEMO_KEY: "demo" } });
  process.stdout.write(`Pi Forge Console: ${consoleServer.url}` + String.fromCharCode(10));
  process.stdout.write("Press Ctrl+C to stop." + String.fromCharCode(10));
  await new Promise<void>((resolveStop) => { const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); consoleServer.close().then(resolveStop); }; process.on("SIGINT", stop); process.on("SIGTERM", stop); });
});
program.command("serve").description("JSONL request/response server over stdio").action(async () => jsonlServe(program.opts<GlobalOptions>()));
program.command("doctor").description("Check configuration and environment").action(async () => doctor(program.opts<GlobalOptions>()));
program.command("sessions").description("List sessions for this workspace").action(async () => sessions(program.opts<GlobalOptions>()));
program.command("trace <path>").description("Print a trace JSONL file").action(async (path: string) => showTrace(path));
program.command("restore <manifest>").description("Restore a checkpoint").action(async (manifest: string) => restore(program.opts<GlobalOptions>(), manifest));
program.command("check").description("Run configured verification commands without an LLM").action(async () => {
  const root = resolve(program.opts<GlobalOptions>().cwd);
  const loaded = loadConfig(root);
  const manifest = await import("./verification/verify.js");
  const report = await manifest.runVerification(root, loaded.config.verify, new AbortController().signal, resolve(stateDirectory(root), "verification"));
  process.stdout.write(`${report.summary}\n${report.results.map((result) => `\n[${result.command}]\n${result.output}`).join("\n")}\n`);
  if (!report.passed) process.exitCode = 1;
});

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${pc.red(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
