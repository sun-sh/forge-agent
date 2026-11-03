import type {
  ApprovalDecision,
  ApprovalRequest,
  AssistantMessage,
  AssistantPart,
  Message,
  ModelAdapter,
  RuntimeEvent,
  ToolCallPart,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  Usage,
  UserContent
} from "./protocol.js";
import { assistantText, createId, extractText, text, type AgentErrorKind } from "./protocol.js";
import { classifyAgentError } from "./provider/errors.js";

export interface CompletionGateContext {
  messages: Message[];
  signal: AbortSignal;
  turn: number;
}

export interface CompletionGateResult {
  continue: boolean;
  message?: string;
  status?: "verification_failed";
}

export interface AgentLoopOptions {
  model: ModelAdapter;
  cwd?: string;
  initialMessages?: Message[];
  tools: ToolDefinition[];
  systemPrompt: string | ((messages: Message[]) => string | Promise<string>);
  maxTurns?: number;
  maxOutputTokens?: number;
  temperature?: number;
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  onEvent?: (event: RuntimeEvent) => void;
  onMessages?: (messages: Message[]) => void | Promise<void>;
  transformContext?: (messages: Message[]) => Promise<Message[]> | Message[];
  maxToolCallsPerTurn?: number;
  maxRepeatedFailures?: number;
  maxIdenticalActions?: number;
  maxDurationMs?: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
  estimateUsageCost?: (usage: Usage) => number;
  completionGateRetries?: number;
  completionGate?: (context: CompletionGateContext) => Promise<CompletionGateResult>;
}

export interface RunResult {
  runId: string;
  messages: Message[];
  assistant: AssistantMessage[];
  status: "completed" | "failed" | "aborted" | "max_turns" | "verification_failed" | "budget_exceeded";
  error?: string;
  errorKind?: AgentErrorKind;
}

export class Agent {
  readonly sessionId: string;
  readonly messages: Message[] = [];
  private abortController: AbortController | undefined;
  private readonly toolMap: Map<string, ToolDefinition>;

  constructor(private readonly options: AgentLoopOptions, sessionId = createId("session")) {
    this.sessionId = sessionId;
    this.toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
    if (options.initialMessages) this.messages.push(...structuredClone(options.initialMessages));
    validateToolDefinitions(options.tools);
  }

  get isRunning(): boolean { return this.abortController !== undefined; }
  abort(): void { this.abortController?.abort(); }

  async run(prompt: UserContent): Promise<RunResult> {
    if (this.isRunning) throw new Error("Agent is already running");
    const runId = createId("run");
    const controller = new AbortController();
    this.abortController = controller;
    const assistantMessages: AssistantMessage[] = [];
    const emit = (event: RuntimeEvent): void => {
      try { this.options.onEvent?.(event); } catch { /* listener failures are isolated */ }
    };
    emit({ type: "run_start", runId, sessionId: this.sessionId });
    this.messages.push({ role: "user", content: prompt });
    let status: RunResult["status"] = "completed";
    let error: string | undefined;
    let errorKind: AgentErrorKind | undefined;
    let gateAttempts = 0;
    let consecutiveFailures = 0;
    let totalTokens = 0;
    let totalCost = 0;
    const runStarted = performance.now();
    const actionFingerprints = new Map<string, number>();

    try {
      const maxTurns = this.options.maxTurns ?? 40;
      for (let turn = 1; turn <= maxTurns; turn++) {
        controller.signal.throwIfAborted();
        emit({ type: "turn_start", turn });
        const budgetError = this.checkBudget(runStarted, totalTokens, totalCost);
        if (budgetError) {
          emit({ type: "warning", message: budgetError });
          status = "budget_exceeded";
          errorKind = "budget";
          error = budgetError;
          break;
        }
        const context = this.options.transformContext ? await this.options.transformContext(this.messages) : [...this.messages];
        const system = typeof this.options.systemPrompt === "function" ? await this.options.systemPrompt(context) : this.options.systemPrompt;
        let responseText = "";
        const responseParts: AssistantPart[] = [];
        let stopReason: AssistantMessage["stopReason"] = "stop";
        let usage: AssistantMessage["usage"];

        for await (const streamEvent of this.options.model.stream({
          system,
          messages: context,
          tools: this.options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          maxOutputTokens: this.options.maxOutputTokens ?? this.options.model.maxOutputTokens,
          ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {})
        }, controller.signal)) {
          if (streamEvent.type === "text_delta") {
            responseText += streamEvent.text;
            emit({ type: "text_delta", text: streamEvent.text });
          } else if (streamEvent.type === "thinking_delta") {
            emit({ type: "thinking_delta", text: streamEvent.text });
          } else if (streamEvent.type === "usage") {
            usage = addUsage(usage, streamEvent.usage);
            totalTokens += tokenCount(streamEvent.usage);
            totalCost += this.options.estimateUsageCost?.(streamEvent.usage) ?? streamEvent.usage.costUsd ?? 0;
          } else {
            responseParts.push(...streamEvent.response.parts);
            stopReason = streamEvent.response.stopReason;
            if (streamEvent.response.usage) {
              if (!usage) {
                usage = streamEvent.response.usage;
                totalTokens += tokenCount(streamEvent.response.usage);
                totalCost += this.options.estimateUsageCost?.(streamEvent.response.usage) ?? streamEvent.response.usage.costUsd ?? 0;
              }
            }
          }
        }

        const textParts: AssistantPart[] = responseText ? [{ type: "text", text: responseText }] : [];
        const existingText = responseParts
          .filter((part): part is Extract<AssistantPart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");
        const combinedParts: AssistantPart[] = [
          ...textParts,
          ...responseParts.filter((part) => part.type !== "text" || (!existingText.includes(part.text) && !responseText.includes(part.text)))
        ];
        const toolCalls = combinedParts.filter((part): part is ToolCallPart => part.type === "tool_call");
        const assistant: AssistantMessage = {
          role: "assistant",
          content: combinedParts,
          model: this.options.model.model,
          provider: this.options.model.provider,
          stopReason: toolCalls.length ? "tool_calls" : stopReason,
          ...(usage ? { usage } : {})
        };
        this.messages.push(assistant);
        assistantMessages.push(assistant);
        await this.options.onMessages?.(this.messages);
        const responseBudgetError = this.checkBudget(runStarted, totalTokens, totalCost);
        if (responseBudgetError) {
          emit({ type: "warning", message: responseBudgetError });
          status = "budget_exceeded";
          errorKind = "budget";
          error = responseBudgetError;
          emit({ type: "turn_end", turn });
          for (const call of toolCalls) {
            this.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: [text(`Tool call not executed: ${responseBudgetError}`)], isError: true });
          }
          break;
        }

        if (toolCalls.length === 0) {
          if (stopReason === "length") emit({ type: "warning", message: "Model stopped at the output limit; the response may be incomplete." });
          let gateResult: CompletionGateResult | undefined;
          if (this.options.completionGate) {
            gateResult = await this.options.completionGate({ messages: this.messages, signal: controller.signal, turn });
          }
          if (gateResult?.continue) {
            if (gateAttempts < (this.options.completionGateRetries ?? 2)) {
              gateAttempts++;
              this.messages.push({ role: "user", content: gateResult.message ?? "The completion gate failed. Continue and resolve the issue." });
              emit({ type: "status", message: "Completion gate requested more work." });
              emit({ type: "turn_end", turn });
              continue;
            }
            status = gateResult.status ?? "verification_failed";
            error = gateResult.message ?? "Completion gate still failing after repair attempts.";
            emit({ type: "turn_end", turn });
            break;
          }
          if (gateResult?.status) {
            status = gateResult.status;
            error = gateResult.message;
            emit({ type: "turn_end", turn });
            break;
          }
          emit({ type: "turn_end", turn });
          break;
        }

        const maxCalls = this.options.maxToolCallsPerTurn ?? 16;
        if (toolCalls.length > maxCalls) {
          for (const call of toolCalls) this.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: [text(`Rejected: more than ${maxCalls} tool calls in one turn.`)], isError: true });
          emit({ type: "warning", message: `Rejected ${toolCalls.length} tool calls in one turn (limit ${maxCalls}).` });
          emit({ type: "turn_end", turn });
          continue;
        }

        const results = await this.executeToolCalls(toolCalls, controller.signal, emit);
        for (const result of results) this.messages.push(result);
        const failed = results.filter((result) => result.isError).length;
        consecutiveFailures = failed > 0 ? consecutiveFailures + failed : 0;
        for (const call of toolCalls) {
          const fingerprint = `${call.name}:${stableJson(call.input)}`;
          actionFingerprints.set(fingerprint, (actionFingerprints.get(fingerprint) ?? 0) + 1);
        }
        await this.options.onMessages?.(this.messages);
        emit({ type: "turn_end", turn });
        if (consecutiveFailures >= (this.options.maxRepeatedFailures ?? 4)) {
          emit({ type: "warning", message: `Stopping after ${consecutiveFailures} consecutive tool failures; repeated failure is not progress.` });
          status = "failed";
          errorKind = "stalled";
          error = "The agent stalled after repeated tool failures. Inspect the latest error, change strategy, and resume the task.";
          break;
        }
        if ([...actionFingerprints.values()].some((count) => count >= (this.options.maxIdenticalActions ?? 5))) {
          emit({ type: "warning", message: "Stopping after repeated identical tool actions without progress." });
          status = "failed";
          errorKind = "stalled";
          error = "The agent repeated the same tool action without progress. Resume with a different approach.";
          break;
        }
        if (turn === maxTurns) status = "max_turns";
      }
    } catch (caught) {
      if (controller.signal.aborted) status = "aborted";
      else { status = "failed"; error = caught instanceof Error ? caught.message : String(caught); errorKind = classifyAgentError(caught); }
    } finally {
      this.abortController = undefined;
    }

    emit({ type: "run_end", runId, status, ...(error ? { error } : {}), ...(errorKind ? { errorKind } : {}) });
    return { runId, messages: [...this.messages], assistant: assistantMessages, status, ...(error ? { error } : {}), ...(errorKind ? { errorKind } : {}) };
  }

  private checkBudget(started: number, totalTokens: number, estimatedCostUsd: number): string | undefined {
    if (this.options.maxDurationMs !== undefined && performance.now() - started > this.options.maxDurationMs) {
      return `Run exceeded the ${this.options.maxDurationMs}ms duration budget.`;
    }
    if (this.options.maxTotalTokens !== undefined && totalTokens > this.options.maxTotalTokens) {
      return `Run exceeded the ${this.options.maxTotalTokens} token budget.`;
    }
    if (this.options.maxEstimatedCostUsd !== undefined && estimatedCostUsd > this.options.maxEstimatedCostUsd) {
      return `Run exceeded the $${this.options.maxEstimatedCostUsd} estimated-cost budget.`;
    }
    return undefined;
  }

  private async executeToolCalls(
    calls: ToolCallPart[],
    signal: AbortSignal,
    emit: (event: RuntimeEvent) => void
  ): Promise<Array<Extract<Message, { role: "tool" }>>> {
    const executeOne = async (call: ToolCallPart): Promise<Extract<Message, { role: "tool" }>> => {
      const started = performance.now();
      const tool = this.toolMap.get(call.name);
      if (!tool) return { role: "tool", toolCallId: call.id, toolName: call.name, content: [text(`Unknown tool: ${call.name}`)], isError: true };
      if (tool.approval?.mode === "always") {
        const request: ApprovalRequest = {
          id: `approval_${call.id}`,
          toolName: call.name,
          summary: summarizeToolRequest(call),
          detail: stableJson(call.input),
          risk: tool.approval.risk,
          reason: tool.approval.reason
        };
        emit({ type: "approval_request", request });
        let decision: ApprovalDecision;
        try {
          decision = await this.options.approve(request);
        } catch (caught) {
          decision = { type: "deny", reason: caught instanceof Error ? caught.message : String(caught) };
        }
        emit({ type: "approval_result", requestId: request.id, decision });
        if (decision.type === "deny") {
          return { role: "tool", toolCallId: call.id, toolName: call.name, content: [text(`Tool call denied: ${decision.reason ?? "no reason provided"}`)], isError: true };
        }
      }
      emit({ type: "tool_call_start", callId: call.id, name: call.name, input: call.input });
      let result: ToolExecutionResult;
      try {
        const parsed = tool.parse ? tool.parse(call.input) : call.input;
        const context: ToolExecutionContext = {
          cwd: this.options.cwd ?? process.cwd(), signal, callId: call.id, sessionId: this.sessionId,
          approve: this.options.approve, emit
        };
        result = await tool.execute(parsed, context);
      } catch (caught) {
        result = { isError: true, content: [text(caught instanceof Error ? caught.message : String(caught))] };
      }
      const durationMs = Math.round(performance.now() - started);
      emit({ type: "tool_call_end", callId: call.id, name: call.name, result, durationMs });
      return { role: "tool", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError ?? false, durationMs };
    };

    const results: Array<Extract<Message, { role: "tool" }>> = new Array(calls.length);
    let cursor = 0;
    while (cursor < calls.length) {
      const batch: number[] = [];
      while (cursor < calls.length) {
        const candidate = calls[cursor]!;
        const candidateTool = this.toolMap.get(candidate.name);
        if (!candidateTool?.parallelSafe) break;
        batch.push(cursor++);
      }
      if (batch.length > 0) {
        const settled = await Promise.all(batch.map(async (position) => [position, await executeOne(calls[position]!)] as const));
        for (const [position, result] of settled) results[position] = result;
        continue;
      }
      const position = cursor++;
      results[position] = await executeOne(calls[position]!);
    }
    return results;
  }
}

function validateToolDefinitions(tools: ToolDefinition[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    if (!tool.inputSchema || tool.inputSchema["type"] !== "object") throw new Error(`Tool ${tool.name} must use an object input schema`);
    names.add(tool.name);
  }
}

function tokenCount(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function addUsage(current: Usage | undefined, next: Usage): Usage {
  if (!current) return next;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    costUsd: (current.costUsd ?? 0) + (next.costUsd ?? 0)
  };
}

export function collectFinalText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return assistantText(message.content);
  }
  return "";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function summarizeToolRequest(call: ToolCallPart): string {
  if (typeof call.input === "string") return call.input.slice(0, 500);
  if (call.input && typeof call.input === "object") {
    const record = call.input as Record<string, unknown>;
    if (call.name === "apply_patch" && typeof record["patch"] === "string") {
      const files = [...record["patch"].matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim());
      return files.length ? `修改 ${files.join(", ")}` : "应用代码补丁";
    }
    return String(record["command"] ?? record["path"] ?? record["pattern"] ?? JSON.stringify(record).slice(0, 500));
  }
  return "";
}

export function promptText(content: UserContent): string { return extractText(content); }
