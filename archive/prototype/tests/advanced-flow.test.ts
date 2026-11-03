import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgent } from "../src/app.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function startFlowMock() {
  let call = 0;
  const toolsSeen = new Set<string>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      call++;
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
      for (const message of payload.messages) {
        if (message.role !== "tool" || typeof message.content !== "string") continue;
        if (message.content.includes("Plan updated")) toolsSeen.add("update_plan");
        if (message.content.includes("<repo_map>")) toolsSeen.add("repo_map");
        if (message.content.includes("Applied patch")) toolsSeen.add("apply_patch");
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (payloadValue: unknown): void => { response.write(`data: ${JSON.stringify(payloadValue)}\n\n`); };
      if (!toolsSeen.has("update_plan")) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "plan", function: { name: "update_plan", arguments: JSON.stringify({ goal: "Update the greeting", constraints: [], steps: [{ id: "1", description: "Inspect and patch greeting", status: "in_progress" }] }) } }] } }] });
        send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else if (!toolsSeen.has("repo_map")) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "map", function: { name: "repo_map", arguments: JSON.stringify({ query: "greeting.ts" }) } }] } }] });
        send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else if (!toolsSeen.has("apply_patch")) {
        const patch = ["*** Begin Patch", "*** Update File: greeting.ts", "@@", "-export const greeting = 'hello';", "+export const greeting = 'hello world';", "*** End Patch"].join("\n");
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "patch", function: { name: "apply_patch", arguments: JSON.stringify({ patch }) } }] } }] });
        send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
      } else {
        send({ choices: [{ delta: { content: "Updated greeting." }, finish_reason: "stop" }] });
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

describe("advanced end-to-end flow", () => {
  it("coordinates plan, repo map, transactional patch, and verification", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-flow-")));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "greeting.ts"), "export const greeting = 'hello';\n");
    await writeFile(join(root, "greeting.ts"), "export const greeting = 'hello';\n");
    await writeFile(join(root, "verify.cjs"), "const fs = require(\"node:fs\"); process.exit(fs.readFileSync(\"greeting.ts\", \"utf8\").includes(\"hello world\") ? 0 : 1);\n");
    await writeFile(join(root, "pforge.json"), JSON.stringify({ verify: [{ name: "contains", command: "node verify.cjs" }] }));
    const baseUrl = await startFlowMock();
    const agent = new CodingAgent({ cwd: root, rootDir: join(root, "state"), config: { provider: "openai-compatible", model: "mock", baseUrl, apiKeyEnv: "MOCK_KEY", approvalMode: "auto", networkPolicy: "allow", maxTurns: 10, repoMapTokens: 500 }, env: { MOCK_KEY: "test" } });
    await agent.inspect();
    const result = await agent.run({ prompt: "update greeting" });
    if (result.status !== "completed") {
    }
    expect(result.status).toBe("completed");
    expect(await readFile(join(root, "greeting.ts"), "utf8")).toContain("hello world");
    expect(result.verification?.passed).toBe(true);
    expect(result.metrics.toolCalls).toBeGreaterThanOrEqual(3);
    const entries = agent.session.getEntries();
    expect(entries.some((entry) => entry.type === "event" && entry.event === "task_plan")).toBe(true);
  });
});
