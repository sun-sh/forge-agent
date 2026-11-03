import { randomUUID } from "node:crypto";

export type AgentErrorKind = "authentication" | "rate_limit" | "context_overflow" | "network" | "provider" | "tool" | "verification" | "stalled" | "budget" | "approval" | "internal";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
}

export type UserContent = string | Array<TextPart | ImagePart>;
export type AssistantPart = TextPart | ToolCallPart | ThinkingPart;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: UserContent;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantPart[];
  model: string;
  provider: string;
  stopReason: "stop" | "tool_calls" | "length" | "error" | "aborted";
  usage?: Usage;
  errorMessage?: string;
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: Array<TextPart | ImagePart>;
  isError: boolean;
  durationMs?: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolApprovalPolicy {
  mode: "never" | "always" | "remote";
  risk: "low" | "medium" | "high";
  reason: string;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  effect: "read" | "write" | "execute";
  parallelSafe: boolean;
  approval?: ToolApprovalPolicy;
  parse?: (input: unknown) => TInput;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  callId: string;
  sessionId: string;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  emit(event: RuntimeEvent): void;
}

export interface ToolExecutionResult {
  content: Array<TextPart | ImagePart>;
  isError?: boolean;
  metadata?: Record<string, JsonValue>;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  summary: string;
  detail: string;
  risk: "low" | "medium" | "high";
  reason: string;
}

export type ApprovalDecision =
  | { type: "allow"; remember?: boolean }
  | { type: "deny"; reason?: string };

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ModelToolSpec[];
  maxOutputTokens: number;
  temperature?: number;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
}

export interface ModelResponse {
  parts: AssistantPart[];
  stopReason: AssistantMessage["stopReason"];
  usage?: Usage;
  providerMetadata?: Record<string, JsonValue>;
}

export interface ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "response"; response: ModelResponse };

export type RuntimeEvent =
  | { type: "run_start"; runId: string; sessionId: string }
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; callId: string; name: string; input: unknown }
  | { type: "tool_call_end"; callId: string; name: string; result: ToolExecutionResult; durationMs: number }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_result"; requestId: string; decision: ApprovalDecision }
  | { type: "status"; message: string }
  | { type: "warning"; message: string }
  | { type: "turn_end"; turn: number }
  | { type: "run_end"; runId: string; status: "completed" | "failed" | "aborted" | "max_turns" | "verification_failed" | "budget_exceeded"; error?: string; errorKind?: AgentErrorKind };

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function text(value: string): TextPart {
  return { type: "text", text: value };
}

export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

export function extractText(content: UserContent | Array<TextPart | ImagePart>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function assistantText(content: AssistantPart[]): string {
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function estimateTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.codePointAt(0)! <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii * 0.7);
}
