#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import pc from "picocolors";
import { CodingAgent, closeCodingAgent } from "../dist/app.js";
import { formatMetrics } from "../dist/observability/metrics.js";
import { readTrace } from "../dist/storage/trace.js";

const root = resolve(".pforge", `demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const state = join(root, "state");
await mkdir(root, { recursive: true });
await writeFile(join(root, "greeting.ts"), "export const greeting = 'hello';\n", "utf8");
await writeFile(join(root, "verify.cjs"), [
  "const fs = require('node:fs');",
  "const source = fs.readFileSync('greeting.ts', 'utf8');",
  "if (!source.includes(\"hello world\")) { console.error('greeting was not updated'); process.exit(1); }",
  "console.log('verification passed: greeting contains hello world');"
].join("\n"), "utf8");
await writeFile(join(root, "pforge.json"), JSON.stringify({
  approvalMode: "ask",
  networkPolicy: "deny",
  maxTurns: 8,
  verify: [{ name: "greeting-check", command: "node verify.cjs", timeoutMs: 30000 }]
}, null, 2), "utf8");
await writeFile(join(root, "AGENTS.md"), "Keep changes small and verify them.\n", "utf8");

let approvals = 0;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk.toString(); });
  request.on("end", () => {
    const payload = JSON.parse(body);
    const toolMessages = payload.messages.filter((message) => message.role === "tool");
    const toolText = toolMessages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (!toolText.includes("Plan updated") && !toolText.includes("Updated greeting.ts")) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "plan", function: { name: "update_plan", arguments: JSON.stringify({ goal: "Update the greeting and verify it", constraints: ["Keep the change small"], steps: [{ id: "inspect", description: "Inspect the relevant file", status: "in_progress" }, { id: "patch", description: "Update the greeting", status: "pending" }, { id: "verify", description: "Run project verification", status: "pending" }] }) } }] } }] });
      send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
    } else if (!toolText.includes("repo_map")) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "map", function: { name: "repo_map", arguments: JSON.stringify({ query: "greeting.ts" }) } }] } }] });
      send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
    } else if (!toolText.includes("Applied patch")) {
      const patch = ["*** Begin Patch", "*** Update File: greeting.ts", "@@", "-export const greeting = 'hello';", "+export const greeting = 'hello world';", "*** End Patch"].join("\n");
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "patch", function: { name: "apply_patch", arguments: JSON.stringify({ patch }) } }] } }] });
      send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
    } else {
      send({ choices: [{ delta: { content: "Updated greeting.ts to return \"hello world\"." }, finish_reason: "stop" }] });
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

const baseUrl = await new Promise((resolveUrl) => server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  resolveUrl(`http://127.0.0.1:${address.port}/v1`);
}));

const original = await readFile(join(root, "greeting.ts"), "utf8");
console.log(pc.bold("\nPi Forge demo"));
console.log(pc.dim(`workspace: ${root}`));
console.log(pc.dim("task: update the greeting and verify it\n"));

const agent = new CodingAgent({
  cwd: root,
  rootDir: state,
  config: {
    provider: "openai-compatible",
    model: "demo-model",
    baseUrl,
    apiKeyEnv: "DEMO_KEY",
    approvalMode: "ask",
    networkPolicy: "deny",
    maxTurns: 8
  },
  env: { DEMO_KEY: "demo-key" },
  approvalHandler: async (request) => {
    approvals++;
    console.log(`${pc.yellow("[approval]")} ${request.toolName} [${request.risk}] ${pc.dim(request.reason)} -> ${pc.green("allow")}`);
    return { type: "allow" };
  }
});

try {
  await agent.inspect();
  const result = await agent.run({
    prompt: "Update greeting.ts to say hello world, then run verification.",
    requireChanges: true,
    onEvent: (event) => {
      if (event.type === "tool_call_start") console.log(`${pc.cyan("[tool]")} ${event.name} ${pc.dim(JSON.stringify(event.input).slice(0, 120))}`);
      if (event.type === "tool_call_end") console.log(`${event.result.isError ? pc.red("[tool failed]") : pc.green("[tool ok]")} ${event.name} ${pc.dim(`${event.durationMs}ms`)}`);
      if (event.type === "text_delta") process.stdout.write(event.text);
      if (event.type === "warning") console.log(pc.yellow(`[warning] ${event.message}`));
    }
  });

  const updated = await readFile(join(root, "greeting.ts"), "utf8");
  console.log(`\n\n${pc.bold("Result")}: ${result.status === "completed" ? pc.green(result.status) : pc.red(result.status)}`);
  console.log(`${pc.bold("Answer")}: ${result.answer}`);
  console.log(`\n${pc.bold("Diff")}\n${createTwoFilesPatch("greeting.ts", "greeting.ts", original, updated, "before", "after", { context: 3 })}`);
  console.log(`${pc.bold("Verification")}: ${result.verification?.passed ? pc.green("PASS") : pc.red("FAIL")}`);
  console.log(result.verification?.summary ?? "No verification result");
  console.log(`\n${pc.bold("Metrics")}: ${formatMetrics(result.metrics)}`);
  console.log(`Approvals: ${approvals}`);
  console.log(pc.dim(`session: ${result.sessionPath}`));
  console.log(pc.dim(`trace:   ${result.tracePath}`));

  const trace = await readTrace(result.tracePath);
  const toolCalls = trace.filter((record) => record.event.type === "tool_call_end").length;
  console.log(`${pc.bold("Trace")}: ${trace.length} records, ${toolCalls} completed tool calls`);
  if (result.status !== "completed" || !result.verification?.passed) process.exitCode = 1;
} finally {
  await closeCodingAgent(agent);
  await new Promise((resolveClose) => server.close(resolveClose));
}
