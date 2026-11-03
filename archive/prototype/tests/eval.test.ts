import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalSuite, type EvalSuite } from "../src/eval/runner.js";

describe("eval suite isolation", () => {
  it("does not mutate the template workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-eval-test-")));
    const task = join(root, "one");
    await mkdir(task);
    await writeFile(join(task, "a.txt"), "original\n");
    const suite: EvalSuite = { name: "test", concurrency: 1, tasks: [{ id: "one", prompt: "update a", requiredFiles: ["a.txt"], forbiddenFiles: [], expectedText: [{ path: "a.txt", contains: "original" }], timeoutMs: 1000 }] };
    const report = await runEvalSuite({ suite, projectRoot: root, workspaceTemplate: root, reportDir: join(root, "reports"), config: { provider: "openai-compatible", model: "mock" }, env: { OPENAI_API_KEY: "unused" } });
    expect(report.total).toBe(1);
    expect(await readFile(join(task, "a.txt"), "utf8")).toBe("original\n");
    expect(["timeout", "error"]).toContain(report.results[0]?.status);
  });
});
