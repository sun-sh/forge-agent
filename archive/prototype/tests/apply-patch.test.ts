import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../src/tools/apply-patch.js";
import { PathGuard } from "../src/security/path-guard.js";
import type { ToolExecutionContext } from "../src/protocol.js";

function context(root: string): ToolExecutionContext {
  return { cwd: root, signal: new AbortController().signal, callId: "patch-test", sessionId: "test", approve: async () => ({ type: "allow" }), emit: () => {} };
}

describe("apply_patch", () => {
  it("applies a multi-file unified patch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-patch-")));
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    const tool = createApplyPatchTool(new PathGuard({ cwd: root }));
    const patch = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-export const a = 1;",
      "+export const a = 10;",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-export const b = 2;",
      "+export const b = 20;",
      ""
    ].join("\n");
    const result = await tool.execute({ patch }, context(root));
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toContain("a = 10");
    expect(await readFile(join(root, "b.ts"), "utf8")).toContain("b = 20");
  });

  it("rejects malformed patches without changing files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-patch-")));
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    const tool = createApplyPatchTool(new PathGuard({ cwd: root }));
    const patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-wrong", "+right", ""].join("\n");
    await expect(tool.execute({ patch }, context(root))).rejects.toThrow();
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("blocks path traversal", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-patch-")));
    const tool = createApplyPatchTool(new PathGuard({ cwd: root }));
    const patch = ["--- /dev/null", "+++ b/../escape.txt", "@@ -0,0 +1 @@", "+bad", ""].join("\n");
    await expect(tool.execute({ patch }, context(root))).rejects.toThrow(/escapes|outside/i);
  });
});
