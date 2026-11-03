import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgent } from "../src/app.js";
import { SessionStore } from "../src/storage/session.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function sse(response: import("node:http").ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startMock() {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      calls++;
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
      const toolMessages = payload.messages.filter((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (toolMessages.length === 0) {
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "a\n" }) } }] } }] });
        sse(response, { choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else {
        sse(response, { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  servers.push(server);
  return new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    resolve(`http://127.0.0.1:${address.port}/v1`);
  }));
}

describe("session resume integrity", () => {
  it("persists the user prompt, assistant tool call, and tool result", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-resume-")));
    await writeFile(join(root, "pforge.json"), JSON.stringify({ verify: [{ name: "ok", command: process.platform === "win32" ? "exit /b 0" : "true" }] }));
    const baseUrl = await startMock();
    const session = SessionStore.create(root, join(root, "state"));
    const agent = new CodingAgent({ cwd: root, rootDir: join(root, "state"), session, config: { provider: "openai-compatible", model: "mock", baseUrl, apiKeyEnv: "MOCK_KEY", approvalMode: "auto", networkPolicy: "allow", maxTurns: 5 }, env: { MOCK_KEY: "test" } });
    await agent.inspect();
    await agent.run({ prompt: "write a.txt" });
    const messages = SessionStore.open(session.sessionPath).messages();
    expect(messages.some((message) => message.role === "user" && message.content === "write a.txt")).toBe(true);
    expect(messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "tool_call"))).toBe(true);
    expect(messages.some((message) => message.role === "tool" && message.toolCallId === "call-1")).toBe(true);
  });
});
