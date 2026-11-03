import type {
  AssistantPart,
  JsonValue,
  Message,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  Usage
} from "../protocol.js";
import { assistantText } from "../protocol.js";

export interface ProviderConfig {
  provider: "openai" | "openai-responses" | "anthropic" | "openai-compatible" | "anthropic-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxOutputTokens: number;
  thinking?: "off" | "low" | "medium" | "high";
  maxRetries?: number;
  timeoutMs?: number;
}

class SseDecoder {
  private buffer = "";
  private readonly dataLines: string[] = [];
  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") {
        if (this.dataLines.length) events.push(this.dataLines.join("\n"));
        this.dataLines.length = 0;
      } else if (line.startsWith("data:")) {
        this.dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return events;
  }
  flush(): string[] {
    const events: string[] = [];
    if (this.buffer.startsWith("data:")) this.dataLines.push(this.buffer.slice(5).replace(/^ /, ""));
    this.buffer = "";
    if (this.dataLines.length) events.push(this.dataLines.join("\n"));
    this.dataLines.length = 0;
    return events;
  }
}

function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parseUsage(value: unknown): Usage | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const input = Number(raw["input_tokens"] ?? raw["prompt_tokens"] ?? 0);
  const output = Number(raw["output_tokens"] ?? raw["completion_tokens"] ?? 0);
  const cacheRead = Number((raw["cache_read_input_tokens"] ?? asRecord(raw["prompt_tokens_details"])?.["cached_tokens"]) ?? 0);
  return { inputTokens: Number.isFinite(input) ? input : 0, outputTokens: Number.isFinite(output) ? output : 0, cacheReadTokens: Number.isFinite(cacheRead) ? cacheRead : 0 };
}

function toOpenAiMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part : { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } }) });
    } else if (message.role === "assistant") {
      const value = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const calls = message.content.filter((part) => part.type === "tool_call");
      messages.push({ role: "assistant", content: value || null, ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) } : {}) });
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content.map((part) => part.type === "text" ? part.text : `[image:${part.mediaType}]`).join("\n") });
    }
  }
  return messages;
}

function toAnthropicMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } }) });
    } else if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "tool_call") content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "tool_result", tool_use_id: message.toolCallId, content: part.text, is_error: message.isError });
        else content.push({ type: "tool_result", tool_use_id: message.toolCallId, content: [{ type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } }], is_error: message.isError });
      }
      if (content.length) messages.push({ role: "user", content });
    }
  }
  return messages;
}

function openAiPayload(request: ModelRequest, config: ProviderConfig): Record<string, unknown> {
  return {
    model: config.model,
    messages: toOpenAiMessages(request),
    tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    tool_choice: "auto", stream: true, stream_options: { include_usage: true },
    max_completion_tokens: request.maxOutputTokens,
    ...(config.thinking && config.thinking !== "off" ? { reasoning_effort: config.thinking } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
  };
}

function retryableStatus(status: number): boolean { return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500; }

async function timedFetch(url: string, init: RequestInit, timeoutMs: number | undefined, parent: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const signal = AbortSignal.any([parent, controller.signal]);
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted && !parent.aborted) throw new Error(`Model request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function openAiRequest(request: ModelRequest, signal: AbortSignal, config: ProviderConfig): Promise<Response> {
  const response = await timedFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(openAiPayload(request, config))
  }, config.timeoutMs, signal);
  if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 4000)}`);
  return response;
}

async function anthropicRequest(request: ModelRequest, signal: AbortSignal, config: ProviderConfig): Promise<Response> {
  const response = await timedFetch(`${config.baseUrl}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: config.model, system: request.system, messages: toAnthropicMessages(request),
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      max_tokens: request.maxOutputTokens, stream: true,
      ...(config.thinking && config.thinking !== "off" ? { thinking: { type: "enabled", budget_tokens: config.thinking === "high" ? 8192 : config.thinking === "medium" ? 4096 : 1024 } } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
    })
  }, config.timeoutMs, signal);
  if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 4000)}`);
  return response;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/Model request failed \((\d+)\)/.test(message)) return retryableStatus(Number(message.match(/Model request failed \((\d+)\)/)?.[1] ?? 0));
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|timed out/i.test(message);
}

async function withRetry<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, maxRetries: number): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= maxRetries) {
    signal.throwIfAborted();
    try { return await operation(signal); }
    catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= maxRetries) break;
      const delay = Math.min(8000, 400 * 2 ** attempt + Math.floor(Math.random() * 250));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        const abort = (): void => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
        timer.unref?.();
        void (async () => { await new Promise((done) => setTimeout(done, delay)); signal.removeEventListener("abort", abort); })();
      });
      attempt++;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function* streamOpenAi(request: ModelRequest, parentSignal: AbortSignal, config: ProviderConfig): AsyncIterable<ModelStreamEvent> {
  const response = await withRetry((signal) => openAiRequest(request, signal, config), parentSignal, config.maxRetries ?? 0);
  if (!response.body) throw new Error("Model response has no body");
  const decoder = new SseDecoder(); const textDecoder = new TextDecoder(); const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason = "stop"; let usage: Usage | undefined; let textValue = "";
  const processEvent = function* (data: string): Generator<ModelStreamEvent> {
    if (data === "[DONE]") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const choice = (event["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) { usage = parseUsage(event["usage"]) ?? usage; return; }
    finishReason = asString(choice["finish_reason"]) ?? finishReason;
    const delta = asRecord(choice["delta"]);
    const content = asString(delta?.["content"]);
    if (content) { textValue += content; yield { type: "text_delta", text: content }; }
    const reasoning = asString(delta?.["reasoning_content"]) ?? asString(delta?.["reasoning"]);
    if (reasoning) yield { type: "thinking_delta", text: reasoning };
    for (const rawCall of (delta?.["tool_calls"] as Array<Record<string, unknown>> | undefined) ?? []) {
      const index = Number(rawCall["index"] ?? 0);
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      current.id += asString(rawCall["id"]) ?? "";
      const fn = asRecord(rawCall["function"]);
      current.name += asString(fn?.["name"]) ?? "";
      current.arguments += asString(fn?.["arguments"]) ?? "";
      calls.set(index, current);
    }
    usage = parseUsage(event["usage"]) ?? usage;
  };
  const reader = response.body.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; for (const data of decoder.push(textDecoder.decode(value, { stream: true }))) yield* processEvent(data); }
  for (const data of decoder.push(textDecoder.decode())) yield* processEvent(data);
  for (const data of decoder.flush()) yield* processEvent(data);
  const parts: AssistantPart[] = textValue ? [{ type: "text", text: textValue }] : [];
  for (const call of calls.values()) {
    if (!call.name) continue;
    let input: unknown = {};
    try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { input = { __raw: call.arguments }; }
    parts.push({ type: "tool_call", id: call.id || `call_${Math.random().toString(36).slice(2)}`, name: call.name, input });
  }
  const hasCalls = parts.some((part) => part.type === "tool_call");
  yield { type: "response", response: { parts, stopReason: hasCalls || finishReason === "tool_calls" ? "tool_calls" : finishReason === "length" ? "length" : "stop", ...(usage ? { usage } : {}) } };
}

async function* streamAnthropic(request: ModelRequest, parentSignal: AbortSignal, config: ProviderConfig): AsyncIterable<ModelStreamEvent> {
  const response = await withRetry((signal) => anthropicRequest(request, signal, config), parentSignal, config.maxRetries ?? 0);
  if (!response.body) throw new Error("Model response has no body");
  const decoder = new SseDecoder(); const textDecoder = new TextDecoder(); const parts: AssistantPart[] = [];
  const toolStarts = new Map<number, { id: string; name: string; json: string }>();
  let textValue = ""; let stopReason: ModelResponse["stopReason"] = "stop"; let usage: Usage | undefined;
  const processEvent = function* (data: string): Generator<ModelStreamEvent> {
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const type = asString(event["type"]);
    if (type === "content_block_start") {
      const index = Number(event["index"] ?? 0); const block = asRecord(event["content_block"]);
      if (block?.["type"] === "tool_use") toolStarts.set(index, { id: asString(block["id"]) ?? `tool_${index}`, name: asString(block["name"]) ?? "", json: "" });
      else if (block?.["type"] === "text") { const value = asString(block["text"]) ?? ""; textValue += value; if (value) yield { type: "text_delta", text: value }; }
    } else if (type === "content_block_delta") {
      const index = Number(event["index"] ?? 0); const delta = asRecord(event["delta"]); const deltaType = asString(delta?.["type"]);
      if (deltaType === "text_delta") { const value = asString(delta?.["text"]) ?? ""; textValue += value; yield { type: "text_delta", text: value }; }
      else if (deltaType === "thinking_delta") yield { type: "thinking_delta", text: asString(delta?.["thinking"]) ?? "" };
      else if (deltaType === "input_json_delta") { const call = toolStarts.get(index); if (call) call.json += asString(delta?.["partial_json"]) ?? ""; }
    } else if (type === "content_block_stop") {
      const index = Number(event["index"] ?? 0); const call = toolStarts.get(index);
      if (call) { let input: unknown = {}; try { input = call.json ? JSON.parse(call.json) : {}; } catch { input = { __raw: call.json }; } parts.push({ type: "tool_call", id: call.id, name: call.name, input }); toolStarts.delete(index); }
    } else if (type === "message_delta") {
      stopReason = asString(asRecord(event["delta"])?.["stop_reason"]) === "tool_use" ? "tool_calls" : "stop";
      usage = parseUsage(event["usage"]) ?? usage;
    } else if (type === "message_start") usage = parseUsage(asRecord(event["message"])?.["usage"]) ?? usage;
  };
  const reader = response.body.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; for (const data of decoder.push(textDecoder.decode(value, { stream: true }))) yield* processEvent(data); }
  for (const data of decoder.push(textDecoder.decode())) yield* processEvent(data);
  for (const data of decoder.flush()) yield* processEvent(data);
  if (textValue) parts.unshift({ type: "text", text: textValue });
  const hasCalls = parts.some((part) => part.type === "tool_call");
  yield { type: "response", response: { parts, stopReason: hasCalls ? "tool_calls" : stopReason, ...(usage ? { usage } : {}) } };
}

export class HttpModelAdapter implements ModelAdapter {
  readonly id: string; readonly provider: string; readonly model: string; readonly contextWindow: number; readonly maxOutputTokens: number;
  constructor(private readonly config: ProviderConfig) { this.id = `${config.provider}/${config.model}`; this.provider = config.provider; this.model = config.model; this.contextWindow = config.contextWindow; this.maxOutputTokens = config.maxOutputTokens; }
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    return this.config.provider === "anthropic" || this.config.provider === "anthropic-compatible"
      ? streamAnthropic(request, signal, this.config)
      : streamOpenAi(request, signal, this.config);
  }
}

export function responseText(response: ModelResponse): string { return assistantText(response.parts); }
export function validateProviderConfig(config: ProviderConfig): void { new URL(config.baseUrl); if (!config.apiKey) throw new Error("API key is required"); if (!config.model) throw new Error("Model is required"); }
export function toJsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
