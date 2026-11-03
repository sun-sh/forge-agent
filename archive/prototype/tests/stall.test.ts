import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { text, type ToolDefinition } from "../src/protocol.js";
import { assistant, FakeModel } from "./fake-model.js";

function failing(name: string): ToolDefinition {
  return { name, description: name, effect: "read", parallelSafe: false, inputSchema: { type: "object" }, async execute() { throw new Error("same failure"); } };
}

describe("agent stall protection", () => {
  it("stops after consecutive tool failures", async () => {
    const model = new FakeModel(Array.from({ length: 6 }, (_, index) => assistant([{ type: "tool_call", id: `${index}`, name: "bad", input: { attempt: index } }], "tool_calls")));
    const agent = new Agent({ model, tools: [failing("bad")], systemPrompt: "system", maxRepeatedFailures: 2, approve: async () => ({ type: "allow" }) });
    const result = await agent.run("go");
    expect(result.status).toBe("failed");
    expect(result.errorKind).toBe("stalled");
    expect(result.messages.filter((message) => message.role === "tool").length).toBe(2);
  });

  it("stops repeated identical actions", async () => {
    const model = new FakeModel(Array.from({ length: 7 }, (_, index) => assistant([{ type: "tool_call", id: `${index}`, name: "echo", input: { value: "same" } }], "tool_calls")));
    const tool: ToolDefinition = { name: "echo", description: "echo", effect: "read", parallelSafe: true, inputSchema: { type: "object" }, async execute() { return { content: [text("ok")] }; } };
    const agent = new Agent({ model, tools: [tool], systemPrompt: "system", maxIdenticalActions: 2, approve: async () => ({ type: "allow" }) });
    const result = await agent.run("go");
    expect(result.status).toBe("failed");
    expect(result.errorKind).toBe("stalled");
    expect(result.messages.filter((message) => message.role === "tool").length).toBe(2);
  });
});
