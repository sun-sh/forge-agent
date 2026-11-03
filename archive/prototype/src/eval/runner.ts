import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CodingAgent } from "../app.js";
import type { AgentConfig } from "../config.js";

const evalTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  requiredFiles: z.array(z.string()).default([]),
  forbiddenFiles: z.array(z.string()).default([]),
  expectedText: z.array(z.object({ path: z.string(), contains: z.string() })).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).optional()
});

const evalSuiteSchema = z.object({
  name: z.string().min(1),
  concurrency: z.number().int().min(1).max(4).default(1),
  tasks: z.array(evalTaskSchema).min(1)
});

export type EvalTask = z.infer<typeof evalTaskSchema>;
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export interface EvalTaskResult {
  id: string;
  status: "passed" | "failed" | "error" | "timeout";
  runStatus?: string;
  verificationPassed?: boolean;
  assertions: Array<{ name: string; passed: boolean; detail?: string }>;
  durationMs: number;
  turns: number;
  toolCalls: number;
  failedToolCalls?: number;
  sessionPath?: string;
  tracePath?: string;
  workspacePath?: string;
  tokens?: number;
  estimatedCostUsd?: number;
  error?: string;
  errorKind?: string;
}

export interface EvalReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  verificationRate: number;
  totalTokens: number;
  estimatedCostUsd: number;
  results: EvalTaskResult[];
}

export function loadEvalSuite(path: string): EvalSuite {
  return evalSuiteSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function runEvalSuite(options: {
  suite: EvalSuite;
  projectRoot: string;
  workspaceTemplate: string;
  reportDir: string;
  config?: Partial<AgentConfig>;
  env?: NodeJS.ProcessEnv;
}): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const results: EvalTaskResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(options.suite.concurrency, options.suite.tasks.length) }, async () => {
    while (cursor < options.suite.tasks.length) {
      const task = options.suite.tasks[cursor++]!;
      results.push(await runTask(task, options));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.id.localeCompare(b.id));
  const passed = results.filter((result) => result.status === "passed").length;
  const verification = results.filter((result) => result.verificationPassed).length;
  const totalTokens = results.reduce((sum, result) => sum + (result.tokens ?? 0), 0);
  const estimatedCostUsd = Number(results.reduce((sum, result) => sum + (result.estimatedCostUsd ?? 0), 0).toFixed(6));
  const report: EvalReport = {
    suite: options.suite.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    verificationRate: results.length ? verification / results.length : 0,
    totalTokens,
    estimatedCostUsd,
    results
  };
  mkdirSync(options.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(options.reportDir, `eval-${stamp}.json`), JSON.stringify(report, null, 2), "utf8");
  return report;
}

async function runTask(task: EvalTask, options: Parameters<typeof runEvalSuite>[0]): Promise<EvalTaskResult> {
  const started = performance.now();
  const template = resolve(options.workspaceTemplate, task.id);
  if (!existsSync(template)) {
    return { id: task.id, status: "error", assertions: [], durationMs: 0, turns: 0, toolCalls: 0, error: `Missing workspace template: ${template}` };
  }
  const root = await mkdtemp(join(tmpdir(), `pforge-eval-${task.id.replace(/[^A-Za-z0-9_-]/g, "_")}-`));
  const workspace = join(root, "workspace");
  await cp(template, workspace, { recursive: true, force: true });
  const controller = new AbortController();
  const timeout = task.timeoutMs ?? 600_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  let turns = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  try {
    const agent = new CodingAgent({
      cwd: workspace,
      rootDir: join(options.reportDir, "state", task.id),
      config: options.config,
      env: options.env
    });
    await agent.inspect();
    const result = await agent.run({
      prompt: task.prompt,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "turn_start") turns++;
        if (event.type === "tool_call_start") toolCalls++;
        if (event.type === "tool_call_end" && event.result.isError) failedToolCalls++;
      }
    });
    const assertions: EvalTaskResult["assertions"] = [];
    for (const file of task.requiredFiles) assertions.push({ name: `required:${file}`, passed: existsSync(join(workspace, file)) });
    for (const file of task.forbiddenFiles) assertions.push({ name: `forbidden:${file}`, passed: !existsSync(join(workspace, file)) });
    for (const expectation of task.expectedText) {
      let passed = false;
      try { passed = readFileSync(join(workspace, expectation.path), "utf8").includes(expectation.contains); } catch { /* missing file fails assertion */ }
      assertions.push({ name: `contains:${expectation.path}`, passed });
    }
    const structuralPass = assertions.every((assertion) => assertion.passed);
    const verificationPassed = result.verification?.passed ?? false;
    const success = result.status === "completed" && structuralPass && Boolean(result.verification) && verificationPassed;
    return {
      id: task.id,
      status: controller.signal.aborted ? "timeout" : success ? "passed" : "failed",
      runStatus: result.status,
      verificationPassed,
      assertions,
      durationMs: Math.round(performance.now() - started),
      turns,
      toolCalls,
      failedToolCalls,
      sessionPath: result.sessionPath,
      tracePath: result.tracePath,
      workspacePath: workspace,
      tokens: result.metrics.usage.inputTokens + result.metrics.usage.outputTokens + result.metrics.usage.cacheReadTokens + result.metrics.usage.cacheWriteTokens,
      estimatedCostUsd: result.metrics.usage.estimatedCostUsd
    };
  } catch (error) {
    return { id: task.id, status: controller.signal.aborted ? "timeout" : "error", assertions: [], durationMs: Math.round(performance.now() - started), turns, toolCalls, failedToolCalls, workspacePath: workspace, error: error instanceof Error ? error.message : String(error), errorKind: controller.signal.aborted ? "timeout" : "internal" };
  } finally {
    clearTimeout(timer);
    if (!process.env["PFORGE_KEEP_EVAL_WORKSPACES"]) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
