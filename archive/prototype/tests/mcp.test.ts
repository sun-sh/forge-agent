import { describe, expect, it } from "vitest";
import { connectMcpServer, createMcpToolDefinitions } from "../src/mcp/client.js";
import type { ToolExecutionContext } from "../src/protocol.js";

function context(): ToolExecutionContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, callId: "mcp", sessionId: "test", approve: async () => ({ type: "allow" }), emit: () => {} };
}

describe("MCP stdio integration", () => {
  it("discovers tools and maps annotations to approval policy", async () => {
    const connection = await connectMcpServer({ name: "test", command: process.execPath, args: ["tests/fixtures/test-mcp-server.mjs"], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    try {
      expect(connection.tools.map((tool) => tool.name).sort()).toEqual(["echo", "write_note"]);
      const tools = createMcpToolDefinitions([connection], new Map([["test", new Set(["echo"])]]));
      const echo = tools.find((tool) => tool.name === "mcp__test__echo")!;
      const write = tools.find((tool) => tool.name === "mcp__test__write_note")!;
      expect(echo.effect).toBe("read");
      expect(echo.approval?.mode).toBe("never");
      expect(write.effect).toBe("execute");
      expect(write.approval?.mode).toBe("always");
      const result = await echo.execute({ message: "hi" }, context());
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text", text: "echo:hi" });
    } finally {
      await connection.close();
    }
  }, 20_000);
});
