import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathGuard, PathSecurityError, isBinary, sha256 } from "../src/security/path-guard.js";

describe("PathGuard", () => {
  it("resolves normal workspace paths", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-path-")));
    await writeFile(join(root, "a.txt"), "hello");
    const guard = new PathGuard({ cwd: root });
    await expect(guard.assertFile("a.txt")).resolves.toBe(join(root, "a.txt"));
  });

  it("blocks traversal outside the workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-path-")));
    const guard = new PathGuard({ cwd: root });
    await expect(guard.resolve("../outside.txt", "read")).rejects.toBeInstanceOf(PathSecurityError);
    await expect(guard.resolve("../../Windows/win.ini", "read")).rejects.toBeInstanceOf(PathSecurityError);
  });

  it("blocks writes in read-only mode", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-path-")));
    const guard = new PathGuard({ cwd: root, readOnly: true });
    await expect(guard.resolve("new.txt", "write")).rejects.toThrow(/read-only/);
  });

  it("rejects files that do not exist for reads", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-path-")));
    const guard = new PathGuard({ cwd: root });
    await expect(guard.assertFile("missing.txt")).rejects.toThrow(/does not exist/);
  });

  it("allows explicitly added roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-path-")));
    const extra = await realpath(await mkdtemp(join(tmpdir(), "pforge-extra-")));
    await mkdir(join(extra, "nested"));
    await writeFile(join(extra, "nested", "x.txt"), "x");
    const guard = new PathGuard({ cwd: root, allowedRoots: [extra] });
    await expect(guard.assertFile(join(extra, "nested", "x.txt"))).resolves.toBe(join(extra, "nested", "x.txt"));
  });

  it("detects binary content", () => {
    expect(isBinary(Buffer.from([0, 1, 2, 3]))).toBe(true);
    expect(isBinary(Buffer.from("hello world"))).toBe(false);
  });

  it("hashes deterministically", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
