import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitPatchChanges, type PatchTransactionFs } from "../src/tools/apply-patch.js";

describe("patch transaction rollback", () => {
  it("restores both files when installing the second file fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-txn-")));
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    await writeFile(a, "a-before\n");
    await writeFile(b, "b-before\n");
    let renameCount = 0;
    const fsOps: PatchTransactionFs = {
      async mkdir() {},
      async writeFile(path, content) { await writeFile(path, content, "utf8"); },
      async rename(from, to) {
        renameCount++;
        if (renameCount === 4) throw new Error("injected rename failure");
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
      async remove(path) { const { rm } = await import("node:fs/promises"); await rm(path, { force: true }); },
      async exists(path) { const { existsSync } = await import("node:fs"); return existsSync(path); }
    };
    await expect(commitPatchChanges([
      { path: "a.txt", absolute: a, before: "a-before\n", after: "a-after\n", existed: true },
      { path: "b.txt", absolute: b, before: "b-before\n", after: "b-after\n", existed: true }
    ], "injected", fsOps)).rejects.toThrow(/injected/);
    expect(await readFile(a, "utf8")).toBe("a-before\n");
    expect(await readFile(b, "utf8")).toBe("b-before\n");
  });
});
