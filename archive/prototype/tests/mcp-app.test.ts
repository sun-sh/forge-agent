import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgent, closeCodingAgent } from "../src/app.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function startMock() {
  let call = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      call++;
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
      const toolResult = payload.messages.find((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (value: unknown): void => { response.write(`data: ${JSON.stringify(value)}\n\n`); };
      if (!toolResult) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "mcp-call", function: { name: "mcp__test__write_note", arguments: JSON.stringify({ text: "hello" }) } }] } }] });
        send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else {
        send({ choices: [{ delta: { content: "MCP finished" }, finish_reason: "stop" }] });
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

describe("MCP app integration", () => {
  it("denies MCP write tools by default without invoking them", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-mcp-app-")));
    await writeFile(join(root, "pforge.json"), JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/test-mcp-server.mjs")], cwd: process.cwd(), autoApprove: [] } } }));
    const baseUrl = await startMock();
    const agent = new CodingAgent({ cwd: root, rootDir: join(root, "state"), config: { provider: "openai-compatible", model: "mock", baseUrl, apiKeyEnv: "MOCK_KEY", approvalMode: "ask", networkPolicy: "allow", maxTurns: 4 }, env: { MOCK_KEY: "test" }, approvalHandler: async (request) => ({ type: "deny", reason: `denied ${request.toolName}` }) });
    try {
      await agent.inspect();
      await agent.inspect();
      expect(agent.mcpConnections).toHaveLength(1);
      const result = await agent.run({ prompt: "use MCP" });
      expect(result.status).toBe("completed");
      const tool = result.messages.find((message) => message.role === "tool");
      expect(tool).toMatchObject({ isError: true });
      expect(tool?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("denied") });
    } finally {
      await closeCodingAgent(agent);
    }
  }, 20_000);
});
