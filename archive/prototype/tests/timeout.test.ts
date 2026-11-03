import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpModelAdapter } from "../src/provider/http.js";
import { streamResponses } from "../src/provider/responses.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function slowServer(): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "late" }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, 1500);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}/v1`;
}

const request = { system: "system", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxOutputTokens: 100 };

describe("model request timeout", () => {
  it("aborts slow chat completion requests", async () => {
    const baseUrl = await slowServer();
    const model = new HttpModelAdapter({ provider: "openai-compatible", model: "m", baseUrl, apiKey: "x", contextWindow: 1000, maxOutputTokens: 100, maxRetries: 0, timeoutMs: 100 });
    await expect((async () => { for await (const _event of model.stream(request, new AbortController().signal)) {} })()).rejects.toThrow(/timed out/);
  });

  it("aborts slow Responses requests", async () => {
    const baseUrl = (await slowServer()).replace(/\/v1$/, "");
    await expect((async () => { for await (const _event of streamResponses(request, new AbortController().signal, { provider: "openai-responses", model: "m", baseUrl, apiKey: "x", timeoutMs: 100 })) {} })()).rejects.toThrow(/timed out/);
  });
});
