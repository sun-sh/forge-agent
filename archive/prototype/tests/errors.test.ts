import { describe, expect, it } from "vitest";
import { classifyAgentError, describeAgentError } from "../src/provider/errors.js";
import { Agent } from "../src/agent.js";
import { FakeModel } from "./fake-model.js";

describe("agent error classification", () => {
  it("classifies provider and transport failures", () => {
    expect(classifyAgentError(new Error("Model request failed (401): invalid api key"))).toBe("authentication");
    expect(classifyAgentError(new Error("Model request failed (429): rate limit"))).toBe("rate_limit");
    expect(classifyAgentError(new Error("maximum context length exceeded"))).toBe("context_overflow");
    expect(classifyAgentError(new Error("fetch failed: ECONNRESET"))).toBe("network");
    expect(classifyAgentError(new Error("Model request failed (500): boom"))).toBe("provider");
  });

  it("renders actionable messages", () => {
    expect(describeAgentError(new Error("Model request failed (401): no"))).toMatch(/Authentication/);
  });

  it("exposes authentication error kind from a failed run", async () => {
    const model = new FakeModel([]);
    model.stream = async function* () { throw new Error("Model request failed (401): invalid api key"); };
    const agent = new Agent({ model, tools: [], systemPrompt: "system", approve: async () => ({ type: "allow" }) });
    const result = await agent.run("hello");
    expect(result.status).toBe("failed");
    expect(result.errorKind).toBe("authentication");
  });
});
