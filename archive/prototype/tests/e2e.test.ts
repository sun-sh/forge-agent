import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgent } from "../src/app.js";
import { readTrace } from "../src/storage/trace.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function sse(response: import("node:http").ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startMock(mode: "pass" | "fail") {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      calls++;
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
      const feedback = payload.messages.some((message) => typeof message.content === "string" && message.content.includes("Automatic verification failed"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "write_file", arguments: JSON.stringify({ path: mode === "pass" ? "answer.txt" : "broken.txt", content: "agent output\n" }) } }] } }] });
        sse(response, { choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else if (!feedback) {
        sse(response, { choices: [{ delta: { content: mode === "pass" ? "Created answer.txt." : "I attempted the task." }, finish_reason: "stop" }] });
      } else {
        sse(response, { choices: [{ delta: { content: "Verification still cannot pass." }, finish_reason: "stop" }] });
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

async function workspace(mode: "pass" | "fail") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-e2e-")));
  const command = process.platform === "win32" ? "if exist answer.txt (exit /b 0) else (exit /b 1)" : "test -f answer.txt";
  await writeFile(join(root, "pforge.json"), JSON.stringify({ verify: [{ name: "answer", command }] }));
  return { root, baseUrl: await startMock(mode) };
}

function makeAgent(root: string, baseUrl: string) {
  return new CodingAgent({
    cwd: root,
    rootDir: join(root, "state"),
    config: { provider: "openai-compatible", model: "mock", baseUrl, apiKeyEnv: "MOCK_KEY", approvalMode: "auto", networkPolicy: "allow", maxTurns: 8 },
    env: { MOCK_KEY: "test-key" }
  });
}

describe("CodingAgent HTTP end-to-end", () => {
  it("executes a tool call, verifies, persists a session, and writes a complete trace", async () => {
    const { root, baseUrl } = await workspace("pass");
    const agent = makeAgent(root, baseUrl);
    await agent.inspect();
    const result = await agent.run({ prompt: "create answer.txt" });
    expect(result.status).toBe("completed");
    expect(await readFile(join(root, "answer.txt"), "utf8")).toBe("agent output\n");
    expect(result.verification?.passed).toBe(true);
    expect(result.answer).toContain("Created answer.txt");
    expect(agent.session.messages().length).toBeGreaterThan(0);
    expect(result.metrics.turns).toBeGreaterThan(0);
    expect(result.metrics.toolCalls).toBeGreaterThan(0);
    const trace = await readTrace(result.tracePath);
    expect(trace.some((record) => record.event.type === "tool_call_end")).toBe(true);
    expect(trace.some((record) => record.event.type === "run_end")).toBe(true);
  });

  it("feeds verification failures back and cannot claim success", async () => {
    const { root, baseUrl } = await workspace("fail");
    const agent = makeAgent(root, baseUrl);
    await agent.inspect();
    const result = await agent.run({ prompt: "complete the task" });
    expect(result.status).toBe("verification_failed");
    expect(result.verification?.passed).toBe(false);
    expect(result.error).toMatch(/Automatic verification|change-evidence gate/);
    const trace = await readTrace(result.tracePath);
    expect(trace.some((record) => record.event.type === "status" && record.event.message.includes("Completion gate requested more work"))).toBe(true);
  });
});
