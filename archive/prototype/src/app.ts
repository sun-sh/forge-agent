import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type RunResult } from "./agent.js";
import { loadConfig, resolveApiKey, resolveBaseUrl, type AgentConfig, type LoadedConfig } from "./config.js";
import { ContextEngine } from "./context/engine.js";
import { HttpModelAdapter, validateProviderConfig, type ProviderConfig } from "./provider/http.js";
import { streamResponses } from "./provider/responses.js";
import { assessCommand } from "./security/command-policy.js";
import { PathGuard } from "./security/path-guard.js";
import { CheckpointManager } from "./storage/checkpoint.js";
import { SessionStore } from "./storage/session.js";
import { TraceWriter } from "./storage/trace.js";
import { createCommandTool, executeCommand } from "./tools/command.js";
import { createFileTools } from "./tools/files.js";
import { createSearchTools } from "./tools/search.js";
import { createRepoMapTool } from "./tools/repo-map.js";
import { createApplyPatchTool } from "./tools/apply-patch.js";
import { PlanState, createPlanTools } from "./planning/plan.js";
import { MetricsCollector, estimateCost, type RunMetrics } from "./observability/metrics.js";
import { runVerification, verificationMessage, type VerificationReport } from "./verification/verify.js";
import { collectChangeEvidence, validateChangeEvidence, type ChangeEvidence } from "./verification/evidence.js";
import { closeMcpConnections, connectMcpServer, createMcpToolDefinitions, type McpConnection } from "./mcp/client.js";
import type { ApprovalDecision, ApprovalRequest, RuntimeEvent, ToolDefinition, UserContent } from "./protocol.js";
import { text } from "./protocol.js";

export interface RunOptions {
  prompt: UserContent;
  requireChanges?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
}

export interface CodingAgentOptions {
  cwd: string;
  config?: Partial<AgentConfig>;
  rootDir?: string;
  session?: SessionStore;
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  env?: NodeJS.ProcessEnv;
}

export interface AgentRunOutput extends RunResult {
  sessionPath: string;
  tracePath: string;
  verification?: VerificationReport;
  evidence?: ChangeEvidence;
  metrics: RunMetrics;
  answer: string;
}

function stateRoot(cwd: string): string {
  return process.env["PFORGE_HOME"] ? resolve(process.env["PFORGE_HOME"]) : join(homedir(), ".pforge");
}

function finalAnswer(messages: RunResult["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const value = message.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
    if (value) return value;
  }
  return "";
}

export class CodingAgent {
  readonly cwd: string;
  readonly config: AgentConfig;
  readonly loadedConfig: LoadedConfig;
  readonly rootDir: string;
  readonly session: SessionStore;
  readonly trace: TraceWriter;
  readonly checkpoints: CheckpointManager;
  private readonly context: ContextEngine;
  private readonly guard: PathGuard;
  private readonly model: HttpModelAdapter;
  private readonly tools: ToolDefinition[];
  private readonly readOnlyTools: ToolDefinition[];
  private readonly approvalHandler: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  private readonly latestVerificationState: { value: VerificationReport | null } = { value: null };
  private readonly approvals = new Map<string, ApprovalDecision>();
  private latestCheckpoint: import("./storage/checkpoint.js").CheckpointManifest | undefined;
  private readonly planState: PlanState;
  readonly mcpConnections: McpConnection[] = [];
  private mcpConnected = false;

  constructor(options: CodingAgentOptions) {
    this.cwd = resolve(options.cwd);
    this.loadedConfig = loadConfig(this.cwd, options.config);
    this.config = this.loadedConfig.config;
    this.rootDir = resolve(options.rootDir ?? stateRoot(this.cwd));
    mkdirSync(this.rootDir, { recursive: true });
    this.session = options.session ?? SessionStore.create(this.cwd, this.rootDir);
    this.trace = new TraceWriter(this.rootDir, this.session.id);
    this.checkpoints = new CheckpointManager(this.cwd, this.session);
    this.context = new ContextEngine(this.cwd, this.config.approvalMode);
    this.guard = new PathGuard({ cwd: this.cwd, readOnly: this.config.sandboxMode === "read-only" });
    this.approvalHandler = options.approvalHandler ?? (async () => {
      if (this.config.approvalMode === "auto") return { type: "allow" };
      if (this.config.approvalMode === "deny") return { type: "deny", reason: "Approval policy is deny" };
      return { type: "deny", reason: "No approval handler is attached" };
    });

    const env = options.env ?? process.env;
    const apiKey = resolveApiKey(this.config, env);
    if (!apiKey) throw new Error(`No API key found for ${this.config.provider}. Set the provider API key or configure apiKeyEnv.`);
    const providerConfig: ProviderConfig = {
      provider: this.config.provider,
      model: this.config.model,
      baseUrl: resolveBaseUrl(this.config),
      apiKey,
      contextWindow: this.config.contextWindow,
      maxOutputTokens: this.config.maxOutputTokens
    };
    validateProviderConfig(providerConfig);
    this.model = new HttpModelAdapter(providerConfig);
    if (this.config.provider === "openai-responses") {
      const base = providerConfig;
      this.model = {
        id: `${base.provider}/${base.model}`,
        provider: base.provider,
        model: base.model,
        contextWindow: base.contextWindow,
        maxOutputTokens: base.maxOutputTokens,
        stream: (request, signal) => streamResponses(request, signal, { ...base, provider: base.provider as "openai" | "openai-responses" | "openai-compatible", maxRetries: base.maxRetries, timeoutMs: base.timeoutMs })
      } as HttpModelAdapter;
    } else {
      this.model = new HttpModelAdapter(providerConfig);
    }

    const cwd = this.cwd;
    const config = this.config;
    const rootDir = this.rootDir;
    const model = this.model;
    const sessionId = this.session.id;
    const checkpoints = this.checkpoints;
    const approvals = this.approvals;
    const approvalHandler = this.approvalHandler;
    const setVerification = (report: VerificationReport): void => { this.latestVerificationState.value = report; };

    this.readOnlyTools = [
      ...createFileTools(this.guard).filter((tool) => tool.effect === "read"),
      createRepoMapTool(this.context),
      ...createSearchTools(this.guard, config.ignore)
    ];
    const readOnlyTools = this.readOnlyTools;

    this.planState = new PlanState(this.session, this.session.id);
    this.tools = [
      ...createPlanTools(this.session, this.session.id),
      ...createFileTools(this.guard),
      createApplyPatchTool(this.guard),
      createRepoMapTool(this.context),
      ...createSearchTools(this.guard, config.ignore),
      createCommandTool(async (input, context) => {
        const assessment = assessCommand(input.command, config.approvalMode, config.networkPolicy);
        if (assessment.denied) throw new Error(`Command denied: ${assessment.reason}`);
        const callCwd = input.cwd ? await this.guard.resolve(input.cwd, "read") : cwd;
        if (!existsSync(callCwd)) throw new Error(`Command working directory does not exist: ${input.cwd}`);
        if (assessment.requiresApproval || assessment.risk === "high" || assessment.risk === "medium") {
          const request: ApprovalRequest = {
            id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            toolName: "shell",
            summary: input.command.slice(0, 240),
            detail: input.command,
            risk: assessment.risk,
            reason: assessment.reason
          };
          context.emit({ type: "approval_request", request });
          const cacheKey = `${assessment.risk}:${callCwd}:${input.command}`;
          const decision = approvals.get(cacheKey) ?? await approvalHandler(request);
          context.emit({ type: "approval_result", requestId: request.id, decision });
          if (decision.type === "deny") throw new Error(`Command denied by user: ${decision.reason ?? "no reason provided"}`);
          if (decision.remember) approvals.set(cacheKey, { type: "allow", remember: true });
        }
        return executeCommand({
          ...input,
          cwd: callCwd,
          signal: context.signal,
          outputDir: join(rootDir, "command-output"),
          outputId: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        });
      }),
      {
        name: "create_checkpoint",
        description: "Create a restorable snapshot of the workspace before risky or broad changes.",
        effect: "write",
        parallelSafe: false,
        inputSchema: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", minLength: 1, maxLength: 200 } } },
        async execute(input: { label: string }) {
          if (typeof input.label !== "string" || !input.label.trim()) throw new Error("label is required");
          const manifest = await checkpoints.create(input.label);
          return { content: [text(`Checkpoint ${manifest.id} created (${manifest.files.length} files).`)], metadata: { checkpointId: manifest.id } };
        }
      },
      {
        name: "run_verification",
        description: "Run the project's configured verification commands and return exact pass/fail results. Automatic verification also runs before completion.",
        effect: "execute",
        parallelSafe: false,
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        async execute(_input, context) {
          const report = await runVerification(cwd, config.verify, context.signal, join(rootDir, "verification"));
          setVerification(report);
          return { isError: !report.passed, content: [text(verificationMessage(report))], metadata: { passed: report.passed } };
        }
      },
      {
        name: "research",
        description: "Delegate a focused read-only investigation to a separate subagent. Use for broad codebase questions where a concise evidence-backed answer saves main-context tokens. It cannot write files or execute shell commands.",
        effect: "read",
        parallelSafe: true,
        inputSchema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string", minLength: 1, maxLength: 8000 } } },
        async execute(input: { question: string }) {
          if (typeof input.question !== "string" || !input.question.trim()) throw new Error("question is required");
          const researcher = new Agent({
            model,
            cwd,
            tools: readOnlyTools,
            systemPrompt: "You are a read-only research subagent. Investigate the repository and return a concise, evidence-backed answer. Never invent files or behavior. Include relevant paths and line references when possible.",
            maxTurns: 8,
            maxOutputTokens: Math.min(config.maxOutputTokens, 4096),
            approve: async () => ({ type: "deny", reason: "Read-only research cannot approve side effects" })
          }, `${sessionId}_research`);
          const result = await researcher.run(input.question);
          if (result.status !== "completed") return { isError: true, content: [text(`Research failed: ${result.error ?? result.status}`)] };
          return { content: [text(finalAnswer(result.messages) || "Research completed without a textual answer.")] };
        }
      }
    ];
  }

  private getLatestVerification(): VerificationReport | null {
    return this.latestVerificationState.value;
  }

  private async connectMcpServers(): Promise<void> {
    if (this.mcpConnected) return;
    const autoApprove = new Map<string, Set<string>>();
    const started: McpConnection[] = [];
    try {
      for (const [name, server] of Object.entries(this.config.mcpServers)) {
        if (!server.enabled) continue;
        const connection = await connectMcpServer({
          name,
          ...server,
          cwd: server.cwd ? resolve(this.cwd, server.cwd) : this.cwd
        });
        started.push(connection);
        autoApprove.set(name, new Set(server.autoApprove));
      }
      if (started.length > 0) {
        const existing = new Set(this.tools.map((tool) => tool.name));
        const mcpTools = createMcpToolDefinitions(started, autoApprove);
        for (const tool of mcpTools) {
          if (existing.has(tool.name)) throw new Error(`MCP tool name collision: ${tool.name}`);
          existing.add(tool.name);
        }
        this.mcpConnections.push(...started);
        this.tools.push(...mcpTools);
      }
      this.mcpConnected = true;
    } catch (error) {
      await closeMcpConnections(started);
      throw new Error(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async inspect(): Promise<void> {
    await this.connectMcpServers();
    await this.context.refresh();
    await this.trace.record({ type: "status", message: `Workspace inspected: ${this.cwd}` });
    await this.trace.flush();
  }

  async run(options: RunOptions): Promise<AgentRunOutput> {
    await this.context.refresh();
    const checkpoint = await this.checkpoints.create(`before-run-${new Date().toISOString()}`);
    this.latestCheckpoint = checkpoint;
    await this.trace.record({ type: "status", message: `Checkpoint ${checkpoint.id} created` });
    this.latestVerificationState.value = null;
    const metrics = new MetricsCollector();
    const historicalMessages = this.session.messages();
    const initialMessages = historicalMessages.at(-1)?.role === "user" ? historicalMessages.slice(0, -1) : historicalMessages;
    let persistedMessageCount = initialMessages.length;
    const agent = new Agent({
      model: this.model,
      cwd: this.cwd,
      initialMessages,
      tools: this.tools,
      systemPrompt: async (messages) => `${await this.context.system(messages, { contextWindow: this.config.contextWindow, compactAt: this.config.compactAt, maxOutputTokens: this.config.maxOutputTokens, repoMapTokens: this.config.repoMapTokens, repoMapMode: this.config.repoMapMode })}\n\n${this.planState.render()}`,
      maxTurns: this.config.maxTurns,
      maxOutputTokens: this.config.maxOutputTokens,
      maxRepeatedFailures: this.config.maxRepeatedFailures,
      maxIdenticalActions: this.config.maxIdenticalActions,
      ...(this.config.maxDurationMs !== undefined ? { maxDurationMs: this.config.maxDurationMs } : {}),
      ...(this.config.maxTotalTokens !== undefined ? { maxTotalTokens: this.config.maxTotalTokens } : {}),
      ...(this.config.maxEstimatedCostUsd !== undefined ? { maxEstimatedCostUsd: this.config.maxEstimatedCostUsd, estimateUsageCost: (usage) => estimateCost(`${this.model.provider}/${this.model.model}`, usage) } : {}),
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      approve: async (request) => {
        const decision = await this.approvalHandler(request);
        await this.trace.record({ type: "approval_result", requestId: request.id, decision });
        return decision;
      },
      transformContext: async (messages) => (await this.context.transform(messages, {
        contextWindow: this.config.contextWindow,
        compactAt: this.config.compactAt,
        maxOutputTokens: this.config.maxOutputTokens,
        repoMapTokens: this.config.repoMapTokens,
        repoMapMode: this.config.repoMapMode
      })).messages,
      onMessages: async (messages) => {
        const latestAssistant = messages.at(-1);
        if (latestAssistant?.role === "assistant" && latestAssistant.usage) {
          metrics.addUsage(`${latestAssistant.provider}/${latestAssistant.model}`, latestAssistant.usage);
        }
        for (let index = persistedMessageCount; index < messages.length; index++) {
          const message = messages[index];
          if (message) this.session.appendMessage(message);
        }
        persistedMessageCount = messages.length;
      },
      onEvent: (event) => {
        metrics.record(event);
        void this.trace.record(event);
        options.onEvent?.(event);
      },
      completionGateRetries: this.config.verifyRetries,
      completionGate: async ({ signal }) => {
        const report = await runVerification(this.cwd, this.config.verify, signal, join(this.rootDir, "verification"));
        this.latestVerificationState.value = report;
        const evidence = this.latestCheckpoint ? collectChangeEvidence(this.cwd, this.latestCheckpoint, [this.rootDir]) : undefined;
        const evidenceProblems = evidence
          ? validateChangeEvidence(evidence, {
              allowTestEdits: true,
              allowEmpty: !options.requireChanges,
              requireImplementation: options.requireChanges === true
            })
          : [];
        const verificationPassed = this.config.verify.length === 0 || report.passed;
        if (verificationPassed && evidenceProblems.length === 0) return { continue: false };
        const verificationSection = this.config.verify.length === 0
          ? "No verification commands are configured."
          : verificationMessage(report);        return {
          continue: true,
          message: `Automatic verification or change-evidence gate failed. Diagnose and fix the underlying issue, then finish again. Do not claim success.\n\n${evidenceProblems.length ? `Evidence problems:\n${evidenceProblems.join("\n")}\n\n` : ""}${verificationSection}`
        };
      }
    }, this.session.id);
    const abort = (): void => agent.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await agent.run(options.prompt);
      const finalVerification = this.getLatestVerification();
      const evidence = this.latestCheckpoint ? collectChangeEvidence(this.cwd, this.latestCheckpoint) : undefined;
      this.session.appendEvent("run_end", { status: result.status, errorKind: result.errorKind, ...(finalVerification ? { verification: finalVerification.summary } : {}) });
      await this.trace.flush();
      return {
        ...result,
        ...(evidence ? { evidence } : {}),
        sessionPath: this.session.sessionPath,
        ...(evidence ? { evidence } : {}),
        tracePath: this.trace.tracePath,
        ...(finalVerification ? { verification: finalVerification } : {}),
        answer: finalAnswer(result.messages),
        metrics: metrics.finish()
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

export async function closeCodingAgent(agent: CodingAgent): Promise<void> {
  await closeMcpConnections(agent.mcpConnections);
}
export function listSessions(cwd: string, rootDir = stateRoot(cwd)): ReturnType<typeof SessionStore.list> {

  return SessionStore.list(cwd, rootDir);
}

export function stateDirectory(cwd: string): string { return stateRoot(cwd); }

export function readPackageVersion(): string {
  try { return (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "0.1.0"; }
  catch { return "0.1.0"; }
}
