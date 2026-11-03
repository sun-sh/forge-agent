import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import type { RuntimeEvent, ToolDefinition } from "../src/protocol.js";
import { text } from "../src/protocol.js";
import { assistant, FakeModel } from "./fake-model.js";

function tool(name: string, parallelSafe: boolean, delayMs = 0): ToolDefinition<{ value: string }> {
  return {
    name,
    description: name,
    effect: parallelSafe ? "read" : "write",
    parallelSafe,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    async execute(input) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [text(`${name}:${input.value}`)] };
    }
  };
}

describe("Agent loop", () => {
  it("streams text and returns a clean single-turn result", async () => {
    const model = new FakeModel([assistant([{ type: "text", text: "hello world" }])]);
    const events: RuntimeEvent[] = [];
    const agent = new Agent({
      model,
      tools: [],
      systemPrompt: "system",
      approve: async () => ({ type: "allow" }),
      onEvent: (event) => events.push(event)
    });
    const result = await agent.run("hi");
    expect(result.status).toBe("completed");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.system).toBe("system");
    expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: "user", content: "hi" });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text).join("")).toBe("hello world");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("executes a tool, returns its result, and continues", async () => {
    const model = new FakeModel([
      assistant([{ type: "tool_call", id: "call-1", name: "echo", input: { value: "a" } }], "tool_calls"),
      assistant([{ type: "text", text: "finished" }])
    ]);
    const agent = new Agent({
      model,
      tools: [tool("echo", true)],
      systemPrompt: "system",
      approve: async () => ({ type: "allow" })
    });
    const result = await agent.run("use the tool");
    expect(result.status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({ toolName: "echo", isError: false });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", toolName: "echo" });
  });

  it("runs consecutive read-only tools in parallel and write tools as a barrier", async () => {
    const order: string[] = [];
    const make = (name: string, safe: boolean): ToolDefinition => ({
      name,
      description: name,
      effect: safe ? "read" : "write",
      parallelSafe: safe,
      inputSchema: { type: "object" },
      async execute() {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`${name}:end`);
        return { content: [text(name)] };
      }
    });
    const model = new FakeModel([
      assistant([
        { type: "tool_call", id: "1", name: "read1", input: {} },
        { type: "tool_call", id: "2", name: "read2", input: {} },
        { type: "tool_call", id: "3", name: "write", input: {} },
        { type: "tool_call", id: "4", name: "read3", input: {} }
      ], "tool_calls"),
      assistant([{ type: "text", text: "done" }])
    ]);
    const agent = new Agent({
      model,
      tools: [make("read1", true), make("read2", true), make("write", false), make("read3", true)],
      systemPrompt: "system",
      approve: async () => ({ type: "allow" })
    });
    await agent.run("go");
    expect(order.slice(0, 2).sort()).toEqual(["read1:start", "read2:start"]);
    expect(order.indexOf("write:start")).toBeGreaterThan(order.indexOf("read1:end"));
    expect(order.indexOf("read3:start")).toBeGreaterThan(order.indexOf("write:end"));
  });

  it("turns thrown tool errors into tool results instead of failing the run", async () => {
    const model = new FakeModel([
      assistant([{ type: "tool_call", id: "1", name: "bad", input: {} }], "tool_calls"),
      assistant([{ type: "text", text: "recovered" }])
    ]);
    const agent = new Agent({
      model,
      tools: [{ name: "bad", description: "bad", effect: "read", parallelSafe: true, inputSchema: { type: "object" }, async execute() { throw new Error("boom"); } }],
      systemPrompt: "system",
      approve: async () => ({ type: "allow" })
    });
    const result = await agent.run("go");
    expect(result.status).toBe("completed");
    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({ isError: true, content: [{ text: "boom" }] });
  });

  it("honors max turns", async () => {
    const model = new FakeModel(Array.from({ length: 3 }, (_, index) => assistant([{ type: "tool_call", id: String(index), name: "echo", input: {} }], "tool_calls")));
    const agent = new Agent({
      model,
      tools: [{ name: "echo", description: "echo", effect: "read", parallelSafe: true, inputSchema: { type: "object" }, async execute() { return { content: [text("ok")] }; } }],
      systemPrompt: "system",
      maxTurns: 2,
      approve: async () => ({ type: "allow" })
    });
    const result = await agent.run("go");
    expect(result.status).toBe("max_turns");
  });

  it("supports abort and propagates tool signals", async () => {
    let seenSignal: AbortSignal | undefined;
    const model = new FakeModel([
      assistant([{ type: "tool_call", id: "1", name: "wait", input: {} }], "tool_calls"),
      assistant([{ type: "text", text: "unreachable" }])
    ]);
    const agent = new Agent({
      model,
      tools: [{
        name: "wait",
        description: "wait",
        effect: "read",
        parallelSafe: false,
        inputSchema: { type: "object" },
        async execute(_input, context) {
          seenSignal = context.signal;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { content: [text("done")] };
        }
      }],
      systemPrompt: "system",
      approve: async () => ({ type: "allow" })
    });
    const run = agent.run("go");
    await new Promise((resolve) => setTimeout(resolve, 10));
    agent.abort();
    expect((await run).status).toBe("aborted");
    expect(seenSignal?.aborted).toBe(true);
  });

  it("rejects duplicate tool names during construction", () => {
    const make = (): ToolDefinition => ({ name: "same", description: "same", effect: "read", parallelSafe: true, inputSchema: { type: "object" }, async execute() { return { content: [text("x")] }; } });
    expect(() => new Agent({ model: new FakeModel([]), tools: [make(), make()], systemPrompt: "system", approve: async () => ({ type: "allow" }) })).toThrow(/Duplicate tool name/);
  });
});
