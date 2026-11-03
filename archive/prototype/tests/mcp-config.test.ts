import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP configuration and approval", () => {
  it("loads MCP server definitions from project config", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-mcp-config-")));
    await writeFile(join(root, "pforge.json"), JSON.stringify({
      mcpServers: {
        test: { command: process.execPath, args: ["server.mjs"], autoApprove: [], enabled: true }
      }
    }));
    const { loadConfig } = await import("../src/config.js");
    const loaded = loadConfig(root);
    expect(loaded.config.mcpServers["test"]).toMatchObject({ command: process.execPath, enabled: true });
    expect(loaded.config.mcpServers["test"]?.timeoutMs).toBe(60_000);
  });

  it("maps MCP server env explicitly for later launch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-mcp-config-")));
    await writeFile(join(root, "pforge.json"), JSON.stringify({ mcpServers: { x: { command: "node", env: { TOKEN_VALUE: "secret" } } } }));
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig(root).config.mcpServers["x"]?.env).toEqual({ TOKEN_VALUE: "secret" });
  });
});
