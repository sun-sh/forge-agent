import type { AssistantPart, ModelRequest, ModelResponse, ModelStreamEvent, Usage } from "../protocol.js";

export type ResponsesProvider = "openai" | "openai-responses" | "openai-compatible";

export interface ResponsesConfig {
  provider: ResponsesProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking?: "off" | "low" | "medium" | "high";
  maxRetries?: number;
  timeoutMs?: number;
}

interface ResponsesSse {
  push(chunk: string): string[];
  flush(): string[];
}

function decoder(): ResponsesSse {
  let buffer = "";
  let data: string[] = [];
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const events: string[] = [];
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) events.push(data.join("\n"));
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      return events;
    },
    flush(): string[] {
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
      buffer = "";
      const events = data.length ? [data.join("\n")] : [];
      data = [];
      return events;
    }
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usage(value: unknown): Usage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  return {
    inputTokens: Number(raw["input_tokens"] ?? 0),
    outputTokens: Number(raw["output_tokens"] ?? 0),
    cacheReadTokens: Number((raw["input_tokens_details"] ? record(raw["input_tokens_details"])?.["cached_tokens"] : 0) ?? 0)
  };
}

function inputMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mediaType};base64,${part.data}` }) });
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] });
        else if (part.type === "tool_call") input.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content.map((part) => part.type === "text" ? part.text : `[image:${part.mediaType}]`).join("\n") });
    }
  }
  return input;
}

function payload(request: ModelRequest, config: ResponsesConfig): Record<string, unknown> {
  return {
    model: config.model,
    instructions: request.system,
    input: inputMessages(request),
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(config.thinking && config.thinking !== "off" ? { reasoning: { effort: config.thinking } } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const value = error instanceof Error ? error.message : String(error);
  return /\((\d+)\)/.test(value) && [408, 409, 425, 429].includes(Number(value.match(/\((\d+)\)/)?.[1])) || /network|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(value) || /\(5\d\d\)/.test(value);
}

async function withRetry<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, maxRetries: number): Promise<T> {
  let attempt = 0;
  let last: unknown;
  while (attempt <= maxRetries) {
    signal.throwIfAborted();
    try { return await operation(signal); }
    catch (error) {
      last = error;
      if (!retryable(error) || attempt >= maxRetries) break;
      const delay = Math.min(8000, 400 * 2 ** attempt + Math.floor(Math.random() * 200));
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
  throw last instanceof Error ? last : new Error(String(last));
}

export async function* streamResponses(request: ModelRequest, signal: AbortSignal, config: ResponsesConfig): AsyncIterable<ModelStreamEvent> {
  const response = await withRetry(async (requestSignal) => {
    const timeoutController = new AbortController();
    const timer = config.timeoutMs ? setTimeout(() => timeoutController.abort(), config.timeoutMs) : undefined;
    const requestWithTimeout = AbortSignal.any([requestSignal, timeoutController.signal]);
    try {
      const result = await fetch(`${config.baseUrl}/responses`, {
        method: "POST",
        signal: requestWithTimeout,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(payload(request, config))
      });
      if (!result.ok) throw new Error(`Model request failed (${result.status}): ${(await result.text()).slice(0, 4000)}`);
      return result;
    } catch (error) {
      if (timeoutController.signal.aborted && !requestSignal.aborted) throw new Error(`Model request timed out after ${config.timeoutMs}ms`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, signal, config.maxRetries ?? 0);
  if (!response.body) throw new Error("Model response has no body");
  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const sse = decoder();
  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  let finalText = "";
  let responseUsage: Usage | undefined;
  let stopReason: ModelResponse["stopReason"] = "stop";
  const process = function* (data: string): Generator<ModelStreamEvent> {
    if (data === "[DONE]") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const type = text(event["type"]);
    if (type === "response.output_text.delta") {
      const delta = text(event["delta"]) ?? "";
      if (delta) { finalText += delta; yield { type: "text_delta", text: delta }; }
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const delta = text(event["delta"]) ?? "";
      if (delta) yield { type: "thinking_delta", text: delta };
    } else if (type === "response.output_item.added") {
      const item = record(event["item"]);
      if (item?.["type"] === "function_call") {
        const key = text(event["item_id"]) ?? text(item["call_id"]) ?? text(item["id"]) ?? `call-${calls.size}`;
        calls.set(key, { id: text(item["call_id"]) ?? key, name: text(item["name"]) ?? "", arguments: "" });
      }
    } else if (type === "response.function_call_arguments.delta") {
      const key = text(event["item_id"]) ?? text(event["call_id"]);
      if (key) {
        const current = calls.get(key) ?? { id: text(event["call_id"]) ?? key, name: "", arguments: "" };
        current.arguments += text(event["delta"]) ?? "";
        calls.set(key, current);
      }
    } else if (type === "response.output_item.done") {
      const item = record(event["item"]);
      if (item?.["type"] === "function_call") {
        const key = text(event["item_id"]) ?? text(item["call_id"]) ?? text(item["id"]);
        if (key) {
          const current = calls.get(key) ?? { id: text(item["call_id"]) ?? key, name: text(item["name"]) ?? "", arguments: "" };
          current.name = text(item["name"]) ?? current.name;
          current.arguments = text(item["arguments"]) ?? current.arguments;
          calls.set(key, current);
        }
      }
    } else if (type === "response.completed") {
      const result = record(event["response"]);
      responseUsage = usage(result?.["usage"]) ?? responseUsage;
      const output = result?.["output"];
      if (Array.isArray(output)) for (const raw of output) {
        const item = record(raw);
        if (item?.["type"] === "function_call") {
          const id = text(item["call_id"]) ?? text(item["id"]) ?? `call-${calls.size}`;
          if (![...calls.values()].some((call) => call.id === id)) calls.set(id, { id, name: text(item["name"]) ?? "", arguments: text(item["arguments"]) ?? "" });
        }
      }
      const reason = text(result?.["status"]);
      stopReason = reason === "incomplete" ? "length" : "stop";
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const data of sse.push(textDecoder.decode(value, { stream: true }))) yield* process(data);
  }
  for (const data of sse.push(textDecoder.decode())) yield* process(data);
  for (const data of sse.flush()) yield* process(data);
  const parts: AssistantPart[] = finalText ? [{ type: "text", text: finalText }] : [];
  for (const call of calls.values()) {
    if (!call.name) continue;
    let input: unknown = {};
    try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { input = { __raw: call.arguments }; }
    parts.push({ type: "tool_call", id: call.id, name: call.name, input });
  }
  const hasCalls = parts.some((part) => part.type === "tool_call");
  yield { type: "response", response: { parts, stopReason: hasCalls ? "tool_calls" : stopReason, ...(responseUsage ? { usage: responseUsage } : {}) } };
}
