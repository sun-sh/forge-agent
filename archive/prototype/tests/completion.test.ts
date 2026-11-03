import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgent } from "../src/app.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function mock(content: string): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    resolve(`http://127.0.0.1:${address.port}/v1`);
  }));
}

describe("completion semantics", () => {
  it("allows a no-change answer when no verification is configured", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-answer-")));
    const baseUrl = await mock("The answer is 42.");
    const agent = new CodingAgent({ cwd: root, rootDir: join(root, "state"), config: { provider: "openai-compatible", model: "mock", baseUrl, apiKeyEnv: "KEY" }, env: { KEY: "x" } });
    await agent.inspect();
    const result = await agent.run({ prompt: "answer only", requireChanges: false });
    expect(result.status).toBe("completed");
    expect(result.answer).toContain("42");
  });

  it("rejects a no-change answer when implementation is required", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-required-")));
    const baseUrl = await mock("Done.");
    await writeFile(join(root, "verify.mjs"), "process.exit(0);\n");
    await writeFile(join(root, "pforge.json"), JSON.stringify({ verify: [{ name: "ok", command: "node verify.mjs" }] }));
    const agent = new CodingAgent({ cwd: root, rootDir: join(root, "state"), config: { provider: "openai-compatible", model: "mock", baseUrl, apiKeyEnv: "KEY", verifyRetries: 0 }, env: { KEY: "x" } });
    await agent.inspect();
    const result = await agent.run({ prompt: "implement the change", requireChanges: true });
    expect(result.status).toBe("verification_failed");
    expect(result.error ?? "").toContain("No workspace changes");
  });
});
