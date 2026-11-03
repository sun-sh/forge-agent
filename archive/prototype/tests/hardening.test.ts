import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathGuard } from "../src/security/path-guard.js";
import { RepoMap } from "../src/context/repo-map.js";

describe("hardened path and repo map", () => {
  it("rejects writing through a symlink when the host permits creating one", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-symlink-")));
    await writeFile(join(root, "real.txt"), "before");
    try {
      await symlink(join(root, "real.txt"), join(root, "link.txt"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    const guard = new PathGuard({ cwd: root });
    await expect(guard.assertWritableFile("link.txt")).rejects.toThrow(/Symbolic links/);
  });

  it("resolves relative graph edges inside the workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-graph-")));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "auth.ts"), "export class AuthService {}\n");
    await writeFile(join(root, "src", "api.ts"), "import { AuthService } from './auth';\nexport function useAuth() { return new AuthService(); }\n");
    const map = new RepoMap(root);
    const result = await map.render({ seedFiles: ["src/api.ts"], budgetTokens: 800 });
    expect(result.text).toContain("src/api.ts");
  });
});
