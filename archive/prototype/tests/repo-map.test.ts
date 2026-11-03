import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepoMap, extractRepoMapSeeds } from "../src/context/repo-map.js";

describe("RepoMap", () => {
  it("ranks relevant files and respects the token budget", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-map-")));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "auth.ts"), "export class AuthService { login() {} }\nexport function authenticate() { return new AuthService(); }\n");
    await writeFile(join(root, "src", "api.ts"), "import { AuthService } from './auth';\nexport class ApiClient { constructor(private auth: AuthService) {} }\n");
    await writeFile(join(root, "src", "unused.ts"), "export class Unrelated {}\n");
    const map = new RepoMap(root);
    const result = await map.render({ seedIdentifiers: ["AuthService", "ApiClient"], budgetTokens: 500 });
    expect(result.text).toContain("src/auth.ts");
    expect(result.text).toContain("AuthService");
    expect(result.estimatedTokens).toBeLessThanOrEqual(700);
  });

  it("extracts file and type seeds from recent messages", () => {
    const seeds = extractRepoMapSeeds([
      { role: "user", content: "Fix src/auth/AuthService.ts and update ApiClient" },
      { role: "assistant", content: [{ type: "tool_call", input: { path: "src/api.ts" }, text: "ApiClient" }] }
    ]);
    expect(seeds.seedFiles).toContain("src/auth/AuthService.ts");
    expect(seeds.seedFiles).toContain("src/api.ts");
    expect(seeds.seedIdentifiers).toContain("ApiClient");
  });

  it("ignores dependency folders", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-map-")));
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "node_modules", "x", "bad.ts"), "export class Hidden {}\n");
    await writeFile(join(root, "good.ts"), "export class Good {}\n");
    const map = new RepoMap(root);
    const result = await map.render({ budgetTokens: 500 });
    expect(result.text).toContain("good.ts");
    expect(result.text).not.toContain("bad.ts");
  });
});
