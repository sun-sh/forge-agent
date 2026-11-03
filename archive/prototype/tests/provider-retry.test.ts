import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { HttpModelAdapter } from "../src/provider/http.js";

function body(response: import("node:http").ServerResponse, status: number, content = "{}"): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(content);
}

async function listen(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, count: number) => void): Promise<{ url: string; close: () => Promise<void>; calls: () => number }> {
  let count = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => handler(request, response, ++count));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { url: `http://127.0.0.1:${address.port}/v1`, calls: () => count, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const request = { system: "system", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxOutputTokens: 100 };

describe("HttpModelAdapter retry", () => {
  it("retries 429 then succeeds", async () => {
    const server = await listen((_request, response, count) => {
      if (count < 3) return body(response, 429, JSON.stringify({ error: "rate limit" }));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
    try {
      const model = new HttpModelAdapter({ provider: "openai-compatible", model: "m", baseUrl: server.url, apiKey: "x", contextWindow: 1000, maxOutputTokens: 100, maxRetries: 2 });
      const events = [];
      for await (const event of model.stream(request, new AbortController().signal)) events.push(event);
      expect(server.calls()).toBe(3);
      expect(events.some((event) => event.type === "response")).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it("does not retry a 401", async () => {
    const server = await listen((_request, response) => body(response, 401, JSON.stringify({ error: "bad key" })));
    try {
      const model = new HttpModelAdapter({ provider: "openai-compatible", model: "m", baseUrl: server.url, apiKey: "x", contextWindow: 1000, maxOutputTokens: 100, maxRetries: 5 });
      await expect((async () => { for await (const _event of model.stream(request, new AbortController().signal)) {} })()).rejects.toThrow(/401/);
      expect(server.calls()).toBe(1);
    } finally { await server.close(); }
  });

  it("stops retry on abort", async () => {
    const server = await listen((_request, response) => body(response, 500, JSON.stringify({ error: "boom" })));
    try {
      const model = new HttpModelAdapter({ provider: "openai-compatible", model: "m", baseUrl: server.url, apiKey: "x", contextWindow: 1000, maxOutputTokens: 100, maxRetries: 5 });
      const controller = new AbortController();
      const run = (async () => { for await (const _event of model.stream(request, controller.signal)) {} })();
      setTimeout(() => controller.abort(), 40);
      await expect(run).rejects.toThrow();
      expect(server.calls()).toBeLessThanOrEqual(2);
    } finally { await server.close(); }
  });
});
