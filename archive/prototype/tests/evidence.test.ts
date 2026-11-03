import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectChangeEvidence, validateChangeEvidence } from "../src/verification/evidence.js";
import { CheckpointManager } from "../src/storage/checkpoint.js";
import { SessionStore } from "../src/storage/session.js";

describe("change evidence", () => {
  it("detects implementation changes and test-only changes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-evidence-")));
    await writeFile(join(root, "app.ts"), "export const n = 1;\n");
    await writeFile(join(root, "app.test.ts"), "test('n', () => {});\n");
    const session = SessionStore.create(root, root);
    const checkpoint = await new CheckpointManager(root, session).create("before");
    await writeFile(join(root, "app.ts"), "export const n = 2;\n");
    await writeFile(join(root, "app.test.ts"), "test('n2', () => {});\n");
    const evidence = collectChangeEvidence(root, checkpoint, ["sessions"]);
    expect(evidence.changedFiles.map((file) => file.path).sort()).toEqual(["app.test.ts", "app.ts"]);
    expect(evidence.testFilesChanged).toEqual(["app.test.ts"]);
    expect(validateChangeEvidence(evidence, { allowTestEdits: true, allowEmpty: true })).toEqual([]);
    expect(validateChangeEvidence(evidence, { allowTestEdits: true, allowEmpty: false, requireImplementation: true })).toEqual([]);
    expect(await readFile(join(root, "app.ts"), "utf8")).toContain("2");
  });

  it("reports empty changes when implementation is required", () => {
    const evidence = { changedFiles: [], testFilesChanged: [], nonTestChanged: [], diff: "", diffTruncated: false };
    expect(validateChangeEvidence(evidence, { allowTestEdits: true, allowEmpty: false, requireImplementation: true })).toEqual(["No workspace changes were detected.", "No non-test implementation files changed."]);
  });
});
