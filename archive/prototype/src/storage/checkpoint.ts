import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { SessionStore } from "./session.js";
import { isSensitiveFile } from "../security/sensitive.js";

export interface CheckpointManifest {
  id: string;
  createdAt: string;
  label: string;
  cwd: string;
  files: Array<{ path: string; hash: string; size: number; kind: "file" | "symlink" }>;
}

const SNAPSHOT_IGNORES = new Set([".git", "node_modules", "dist", "coverage", ".pforge", ".next", ".turbo", "target", "vendor"]);
const MAX_FILES = 20_000;
const MAX_BYTES = 250 * 1024 * 1024;

interface Exclusions { roots: string[] }

function within(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

async function collectFiles(root: string, current = root, total = { count: 0, bytes: 0 }, exclusions?: Exclusions): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (SNAPSHOT_IGNORES.has(entry.name)) continue;
    if (isSensitiveFile(entry.name)) continue;
    const full = join(current, entry.name);
    if (exclusions?.roots.some((excluded) => within(excluded, full))) continue;
    if (entry.isDirectory()) files.push(...await collectFiles(root, full, total, exclusions));
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const info = await stat(full);
      if (info.isSymbolicLink()) continue;
      total.count++;
      total.bytes += info.size;
      if (total.count > MAX_FILES || total.bytes > MAX_BYTES) throw new Error(`Workspace too large for checkpoint (${total.count} files, ${total.bytes} bytes)`);
      files.push(relative(root, full));
    }
  }
  return files;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function stateStorageRoot(root: string): string {
  if (process.env["PFORGE_HOME"]) return resolve(process.env["PFORGE_HOME"]);
  const defaultState = resolve(homedir(), ".pforge");
  return within(defaultState, root) ? defaultState : join(root, ".pforge");
}

export class CheckpointManager {
  constructor(private readonly root: string, private readonly session: SessionStore, private readonly storageRoot = stateStorageRoot(root)) {}

  async create(label: string): Promise<CheckpointManifest> {
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const storage = join(this.storageRoot, "checkpoints", this.session.id, id);
    const filesRoot = join(storage, "files");
    await mkdir(filesRoot, { recursive: true });
    const files = await collectFiles(this.root, this.root, { count: 0, bytes: 0 }, { roots: [this.storageRoot, join(this.root, ".pforge")] });
    const manifestFiles: CheckpointManifest["files"] = [];
    for (const file of files) {
      const source = join(this.root, file);
      const target = join(filesRoot, file);
      await mkdir(join(target, ".."), { recursive: true });
      await cp(source, target, { force: true, dereference: false });
      const info = await stat(source);
      manifestFiles.push({ path: file.replaceAll("\\", "/"), hash: await hashFile(source), size: info.size, kind: "file" });
    }
    const manifest: CheckpointManifest = { id, createdAt: new Date().toISOString(), label, cwd: this.root, files: manifestFiles };
    await writeFile(join(storage, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(join(storage, "complete"), "ok\n", "utf8");
    this.session.appendCheckpoint(label, join(storage, "manifest.json"));
    return manifest;
  }

  static async restore(manifestPath: string): Promise<CheckpointManifest> {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CheckpointManifest;
    if (!existsSync(join(resolve(manifestPath, ".."), "complete"))) throw new Error("Checkpoint is incomplete or untrusted");
    const workspace = await realpath(manifest.cwd);
    if (isAbsolute(manifest.cwd) && resolve(manifest.cwd) !== workspace) throw new Error("Checkpoint cwd is not canonical");
    const filesRoot = await realpath(join(resolve(manifestPath, ".."), "files"));
    const desired = new Set<string>();
    const validated: Array<{ path: string; source: string; target: string; hash: string }> = [];
    for (const file of manifest.files) {
      if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error(`Unsafe checkpoint path: ${file.path}`);
      const source = resolve(filesRoot, file.path);
      const target = resolve(workspace, file.path);
      if (!within(filesRoot, source) || !within(workspace, target)) throw new Error(`Checkpoint path escapes its root: ${file.path}`);
      if (await hashFile(source) !== file.hash) throw new Error(`Checkpoint is corrupt: ${file.path}`);
      desired.add(file.path.replaceAll("\\", "/"));
      validated.push({ path: file.path, source, target, hash: file.hash });
    }
    const current = await collectFiles(workspace, workspace, { count: 0, bytes: 0 }, { roots: [stateStorageRoot(workspace), join(workspace, ".pforge")] });
    for (const file of current) {
      if (!desired.has(file.replaceAll("\\", "/"))) await rm(join(workspace, file), { force: true });
    }
    for (const file of validated) {
      await mkdir(join(file.target, ".."), { recursive: true });
      await cp(file.source, file.target, { force: true, dereference: false });
      if (!existsSync(file.target) || await hashFile(file.target) !== file.hash) throw new Error(`Checkpoint restore verification failed for ${file.path}`);
    }
    return manifest;
  }
}
