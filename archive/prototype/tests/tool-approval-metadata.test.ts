import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../src/tools/apply-patch.js";
import { createFileTools } from "../src/tools/files.js";
import { createCommandTool } from "../src/tools/command.js";
import { PathGuard } from "../src/security/path-guard.js";

describe("tool approval metadata", () => {
  it("requires approval for every native side-effect tool", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-approval-meta-")));
    const guard = new PathGuard({ cwd: root });
    const tools = [...createFileTools(guard), createApplyPatchTool(guard), createCommandTool(async () => ({ exitCode: 0, stdout: "", stderr: "", combined: "", truncated: false, durationMs: 0 }))];
    for (const name of ["write_file", "edit_file", "apply_patch", "shell"]) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.approval, name).toBeDefined();
      expect(tool?.approval?.mode, name).not.toBe("never");
      expect(tool?.approval?.risk, name).toBe(name === "shell" || name === "apply_patch" ? "high" : "medium");
    }
    expect(tools.find((tool) => tool.name === "read_file")?.approval).toBeUndefined();
  });
});
