import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { text, type ToolDefinition } from "../src/protocol.js";
import { assistant, FakeModel } from "./fake-model.js";

describe("run budgets and tool approval", () => {
  it("hard-stops when the total token budget is exceeded", async () => {
    const model = new FakeModel([
      assistant([{ type: "tool_call", id: "1", name: "echo", input: { value: "a" } }], "tool_calls"),
      assistant([{ type: "text", text: "should not be reached" }])
    ]);
    model.nextUsage = { inputTokens: 100, outputTokens: 20 };
    const agent = new Agent({
      model,
      tools: [{ name: "echo", description: "echo", effect: "read", parallelSafe: true, inputSchema: { type: "object" }, async execute() { return { content: [text("ok")] }; } }],
      systemPrompt: "system",
      maxTotalTokens: 50,
      approve: async () => ({ type: "allow" })
    });
    const result = await agent.run("go");
    expect(result.status).toBe("budget_exceeded");
    expect(result.errorKind).toBe("budget");
    expect(model.requests).toHaveLength(1);
    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({ toolCallId: "1", isError: true });
  });

  it("enforces estimated cost budgets", async () => {
    const model = new FakeModel([assistant([{ type: "text", text: "done" }])]);
    model.nextUsage = { inputTokens: 1_000, outputTokens: 100 };
    const agent = new Agent({
      model,
      tools: [],
      systemPrompt: "system",
      maxEstimatedCostUsd: 0.5,
      estimateUsageCost: () => 1,
      approve: async () => ({ type: "allow" })
    });
    const result = await agent.run("go");
    expect(result.status).toBe("budget_exceeded");
    expect(result.error).toContain("estimated-cost budget");
  });

  it("does not execute an always-approval tool after denial", async () => {
    let executed = false;
    const deniedTool: ToolDefinition = {
      name: "write_thing",
      description: "write",
      effect: "write",
      parallelSafe: false,
      approval: { mode: "always", risk: "high", reason: "writes" },
      inputSchema: { type: "object" },
      async execute() { executed = true; return { content: [text("written")] }; }
    };
    const model = new FakeModel([
      assistant([{ type: "tool_call", id: "1", name: "write_thing", input: {} }], "tool_calls"),
      assistant([{ type: "text", text: "recovered" }])
    ]);
    const agent = new Agent({ model, tools: [deniedTool], systemPrompt: "system", approve: async () => ({ type: "deny", reason: "no" }) });
    const result = await agent.run("go");
    expect(executed).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({ isError: true });
  });

  it("executes an always-approval tool after approval", async () => {
    let executed = false;
    const tool: ToolDefinition = {
      name: "write_thing",
      description: "write",
      effect: "write",
      parallelSafe: false,
      approval: { mode: "always", risk: "medium", reason: "writes" },
      inputSchema: { type: "object" },
      async execute() { executed = true; return { content: [text("written")] }; }
    };
    const model = new FakeModel([
      assistant([{ type: "tool_call", id: "1", name: "write_thing", input: {} }], "tool_calls"),
      assistant([{ type: "text", text: "done" }])
    ]);
    const approvals: string[] = [];
    const agent = new Agent({ model, tools: [tool], systemPrompt: "system", approve: async (request) => { approvals.push(request.toolName); return { type: "allow" }; } });
    const result = await agent.run("go");
    expect(executed).toBe(true);
    expect(approvals).toEqual(["write_thing"]);
    expect(result.status).toBe("completed");
  });
});
