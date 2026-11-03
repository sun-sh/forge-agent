import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileTools } from "../src/tools/files.js";
import { createSearchTools } from "../src/tools/search.js";
import { PathGuard } from "../src/security/path-guard.js";
import type { ToolExecutionContext, ToolDefinition } from "../src/protocol.js";

function context(root: string): ToolExecutionContext {
  return { cwd: root, signal: new AbortController().signal, callId: "test", sessionId: "test", approve: async () => ({ type: "allow" }), emit: () => {} };
}

function find<T>(tools: ToolDefinition[], name: string): ToolDefinition<T> {
  return tools.find((tool) => tool.name === name) as ToolDefinition<T>;
}

describe("file tools", () => {
  it("reads with line numbers and limits", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-files-")));
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
    const tools = createFileTools(new PathGuard({ cwd: root }));
    const result = await find<{ path: string; offset?: number; limit?: number }>(tools, "read_file").execute({ path: "a.txt", offset: 2, limit: 1 }, context(root));
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("two");
    expect((result.content[0] as { text: string }).text).not.toContain("three");
  });

  it("creates a file and emits a diff", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-files-")));
    const tools = createFileTools(new PathGuard({ cwd: root }));
    const result = await find<{ path: string; content: string }>(tools, "write_file").execute({ path: "nested/a.ts", content: "export const a = 1;\n" }, context(root));
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "nested", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(result.metadata?.["diff"]).toContain("+export const a = 1;");
  });

  it("edits only a unique oldText match", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-files-")));
    await writeFile(join(root, "a.ts"), "const a = 1;\nconst b = 2;\n");
    const tools = createFileTools(new PathGuard({ cwd: root }));
    const edit = find<{ path: string; oldText: string; newText: string }>(tools, "edit_file");
    const ok = await edit.execute({ path: "a.ts", oldText: "const b = 2;", newText: "const b = 3;" }, context(root));
    expect(ok.isError).not.toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toContain("const b = 3;");
    const duplicate = await edit.execute({ path: "a.ts", oldText: "const", newText: "let" }, context(root));
    expect(duplicate.isError).toBe(true);
    expect((duplicate.content[0] as { text: string }).text).toMatch(/matched/);
  });

  it("does not partially edit when oldText is missing", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-files-")));
    await writeFile(join(root, "a.ts"), "const a = 1;\n");
    const tools = createFileTools(new PathGuard({ cwd: root }));
    const result = await find<{ path: string; oldText: string; newText: string }>(tools, "edit_file").execute({ path: "a.ts", oldText: "missing", newText: "x" }, context(root));
    expect(result.isError).toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("const a = 1;\n");
  });
});

describe("search tools", () => {
  it("finds files and ignores node_modules", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-search-")));
    await writeFile(join(root, "a.ts"), "export const alpha = 1;\n");
    await writeFile(join(root, "b.txt"), "alpha\n");
    const tools = createSearchTools(new PathGuard({ cwd: root }));
    const result = await find<{ pattern: string; path: string; limit: number }>(tools, "find_files").execute({ pattern: "**/*.ts", path: ".", limit: 10 }, context(root));
    expect((result.content[0] as { text: string }).text).toContain("a.ts");
    expect((result.content[0] as { text: string }).text).not.toContain("node_modules");
  });

  it("greps with line numbers and context", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-search-")));
    await writeFile(join(root, "a.ts"), "line 1\nalpha\nline 3\n");
    const tools = createSearchTools(new PathGuard({ cwd: root }));
    const result = await find<{ pattern: string; path: string; glob?: string; limit: number; context: number; caseSensitive: boolean }>(tools, "grep").execute({ pattern: "alpha", path: ".", limit: 10, context: 1, caseSensitive: true }, context(root));
    const output = (result.content[0] as { text: string }).text;
    expect(output).toContain("a.ts:2: alpha");
    expect(output).toContain("a.ts:1: line 1");
    expect(output).toContain("a.ts:3: line 3");
  });

  it("rejects invalid regexes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-search-")));
    const tools = createSearchTools(new PathGuard({ cwd: root }));
    const result = await find<{ pattern: string; path: string; limit: number; context: number; caseSensitive: boolean }>(tools, "grep").execute({ pattern: "[", path: ".", limit: 10, context: 0, caseSensitive: true }, context(root));
    expect(result.isError).toBe(true);
  });
});
