import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitiveFile } from "../src/security/sensitive.js";
import { PathGuard } from "../src/security/path-guard.js";
import { createSearchTools } from "../src/tools/search.js";
import type { ToolDefinition, ToolExecutionContext } from "../src/protocol.js";

function context(root: string): ToolExecutionContext {
  return { cwd: root, signal: new AbortController().signal, callId: "t", sessionId: "s", approve: async () => ({ type: "allow" }), emit: () => {} };
}

describe("sensitive file policy", () => {
  it("identifies credential material", () => {
    expect(isSensitiveFile(".env")).toBe(true);
    expect(isSensitiveFile("config/.env.production")).toBe(true);
    expect(isSensitiveFile("id_rsa")).toBe(true);
    expect(isSensitiveFile("certs/server.pem")).toBe(true);
    expect(isSensitiveFile("src/auth.ts")).toBe(false);
    expect(isSensitiveFile("environment.ts")).toBe(false);
  });

  it("blocks direct reads before they reach the filesystem", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-sensitive-")));
    await writeFile(join(root, ".env"), "SECRET=value");
    const guard = new PathGuard({ cwd: root });
    await expect(guard.assertFile(".env")).rejects.toThrow(/sensitive/);
  });

  it("omits credential files from grep results", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-sensitive-")));
    await writeFile(join(root, ".env"), "SECRET=value");
    await writeFile(join(root, "config.ts"), "export const value = 'SECRET';\n");
    const tools = createSearchTools(new PathGuard({ cwd: root }));
    const grep = tools.find((tool) => tool.name === "grep") as ToolDefinition<{ pattern: string; path: string; limit: number; context: number; caseSensitive: boolean }>;
    const result = await grep.execute({ pattern: "SECRET", path: ".", limit: 10, context: 0, caseSensitive: true }, context(root));
    const output = (result.content[0] as { text: string }).text;
    expect(output).toContain("config.ts");
    expect(output).not.toContain(".env");
  });
});
