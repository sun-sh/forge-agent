import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { streamResponses } from "../src/provider/responses.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function mock(handler: (body: Record<string, unknown>, response: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk.toString(); });
    request.on("end", () => handler(JSON.parse(raw) as Record<string, unknown>, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

function sse(response: import("node:http").ServerResponse, payload: unknown): void {
  response.write(`event: ${String((payload as { type?: string }).type ?? "message")}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const request = { system: "system", messages: [{ role: "user" as const, content: "hello" }], tools: [], maxOutputTokens: 200 };

describe("Responses API streaming", () => {
  it("emits text deltas and usage", async () => {
    const baseUrl = await mock((_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sse(response, { type: "response.output_text.delta", delta: "hel" });
      sse(response, { type: "response.output_text.delta", delta: "lo" });
      sse(response, { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 3 } } });
      response.end();
    });
    const events = [];
    for await (const event of streamResponses(request, new AbortController().signal, { provider: "openai-responses", model: "m", baseUrl, apiKey: "x", maxRetries: 0 })) events.push(event);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text).join("")).toBe("hello");
    const final = events.find((event) => event.type === "response");
    expect(final && final.type === "response" ? final.response.usage?.inputTokens : undefined).toBe(12);
  });

  it("assembles a function call and accepts function_call_output on the next request", async () => {
    let secondRequestBody: Record<string, unknown> | undefined;
    let calls = 0;
    const baseUrl = await mock((body, response) => {
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        sse(response, { type: "response.output_item.added", item_id: "item-1", item: { type: "function_call", call_id: "call-1", name: "write_file" } });
        sse(response, { type: "response.function_call_arguments.delta", item_id: "item-1", delta: "{\"path\":\"a.txt\"," });
        sse(response, { type: "response.function_call_arguments.delta", item_id: "item-1", delta: "\"content\":\"a\"}" });
        sse(response, { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "call-1", name: "write_file", arguments: "{\"path\":\"a.txt\",\"content\":\"a\"}" }] } });
      } else {
        secondRequestBody = body;
        sse(response, { type: "response.output_text.delta", delta: "done" });
        sse(response, { type: "response.completed", response: { status: "completed" } });
      }
      response.end();
    });
    const first = [];
    for await (const event of streamResponses(request, new AbortController().signal, { provider: "openai-responses", model: "m", baseUrl, apiKey: "x", maxRetries: 0 })) first.push(event);
    const responseEvent = first.find((event) => event.type === "response");
    const call = responseEvent && responseEvent.type === "response" ? responseEvent.response.parts.find((part) => part.type === "tool_call") : undefined;
    expect(call).toMatchObject({ id: "call-1", name: "write_file", input: { path: "a.txt", content: "a" } });
    const secondRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant" as const, content: [call!], model: "m", provider: "openai-responses", stopReason: "tool_calls" as const },
        { role: "tool" as const, toolCallId: "call-1", toolName: "write_file", content: [{ type: "text" as const, text: "ok" }], isError: false }
      ]
    };
    for await (const _event of streamResponses(secondRequest, new AbortController().signal, { provider: "openai-responses", model: "m", baseUrl, apiKey: "x", maxRetries: 0 })) {}
    const input = secondRequestBody?.["input"] as Array<Record<string, unknown>> | undefined;
    expect(input?.some((item) => item["type"] === "function_call_output" && item["call_id"] === "call-1")).toBe(true);
  });
});
