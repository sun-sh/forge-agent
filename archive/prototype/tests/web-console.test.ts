import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWebConsole } from "../src/web/server.js";

const servers: ReturnType<typeof createServer>[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function sse(response: import("node:http").ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

interface MockOptions {
  writePath?: string;
  content?: string;
  answer?: string;
}

async function startMock(options: MockOptions = {}): Promise<string> {
  let call = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk.toString(); });
    request.on("end", () => {
      call++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (call === 1) {
        const content = options.content ?? (options.writePath ? "web approval passed\n" : "web console passed\n");
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "write_file", arguments: JSON.stringify({ path: options.writePath ?? "answer.txt", content }) } }] } }] });
        sse(response, { choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else {
        sse(response, { choices: [{ delta: { content: options.answer ?? "The web console flow completed.", finish_reason: "stop" } }] });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  servers.push(server);
  return new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock provider did not bind");
    resolve(`http://127.0.0.1:${address.port}/v1`);
  }));
}

async function workspace(options: MockOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-web-")));
  await writeFile(join(root, "pforge.json"), JSON.stringify({ approvalMode: "ask", networkPolicy: "deny", maxTurns: 6 }), "utf8");
  const baseUrl = await startMock(options);
  const consoleServer = await startWebConsole({
    cwd: root,
    host: "127.0.0.1",
    port: 0,
    config: { provider: "openai-compatible", model: "mock-web", baseUrl, apiKeyEnv: "MOCK_KEY", approvalMode: "ask", networkPolicy: "deny", maxTurns: 6 },
    env: { MOCK_KEY: "test-key" }
  });
  closers.push(consoleServer.close);
  return { root, consoleServer, headers: { "x-pforge-token": consoleServer.token, "content-type": "application/json" } };
}

async function waitForResult(url: string, headers: Record<string, string>, runId: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`SSE returned ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE body missing");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE ended without result");
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const payload = JSON.parse(data.slice(6)) as { type?: string; result?: unknown; runId?: string };
        if (payload.type === "result") { await reader.cancel(); return payload.result; }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

describe("Web Console API", () => {
  it("rejects unauthenticated API requests and serves the static app", async () => {
    const { consoleServer } = await workspace();
    const unauthorized = await fetch(new URL("/api/config", consoleServer.url));
    expect(unauthorized.status).toBe(401);
    const page = await fetch(consoleServer.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("今天要构建什么");
    const authorized = await fetch(new URL("/api/config", consoleServer.url), { headers: { "x-pforge-token": consoleServer.token } });
    expect(authorized.status).toBe(200);
    const authorizedConfig = await authorized.json() as { provider: string };
    expect(authorizedConfig.provider).toBe("openai-compatible");
  });

  it("replays approval events to a late SSE client and completes after approval", async () => {
    const { root, consoleServer, headers } = await workspace({ writePath: "approved.txt" });
    const base = new URL(consoleServer.url);
    const started = await fetch(new URL("/api/run", base), { method: "POST", headers, body: JSON.stringify({ prompt: "create approved.txt" }) });
    expect(started.status).toBe(202);
    const { runId } = await started.json() as { runId: string };

    const controller = new AbortController();
    const eventsResponse = await fetch(new URL(`/api/runs/${runId}/events?token=${encodeURIComponent(consoleServer.token)}`, base), { signal: controller.signal });
    const reader = eventsResponse.body?.getReader();
    if (!reader) throw new Error("Approval stream missing");
    const decoder = new TextDecoder();
    let buffer = "";
    let approvalId: string | undefined;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      while (!approvalId) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Stream ended before approval");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          const payload = JSON.parse(data.slice(6)) as { type?: string; request?: { id?: string } };
          if (payload.type === "approval_required" && payload.request?.id) approvalId = payload.request.id;
        }
      }
    } finally {
      clearTimeout(timeout);
      await reader.cancel();
    }

    expect(approvalId).toBeTruthy();
    const approved = await fetch(new URL("/api/approve", base), { method: "POST", headers, body: JSON.stringify({ runId, requestId: approvalId, decision: "allow" }) });
    expect(approved.status).toBe(200);
    const result = await waitForResult(new URL(`/api/runs/${runId}/events?token=${encodeURIComponent(consoleServer.token)}`, base).toString(), { "x-pforge-token": consoleServer.token }, runId);
    expect((result as { status?: string }).status).toBe("completed");
    expect(await readFile(join(root, "approved.txt"), "utf8")).toBe("web approval passed\n");
  });
});
