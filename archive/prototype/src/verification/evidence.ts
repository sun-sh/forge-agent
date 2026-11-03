import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { CheckpointManifest } from "../storage/checkpoint.js";

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeHash?: string;
  afterHash?: string;
  isTest: boolean;
  sensitive: boolean;
}

export interface ChangeEvidence {
  changedFiles: ChangedFile[];
  testFilesChanged: string[];
  nonTestChanged: string[];
  diff: string;
  diffTruncated: boolean;
}

function hashFile(path: string): string | undefined {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return undefined; }
}

function isTestPath(path: string): boolean {
  return /(^|\/)(?:__tests__|tests?)\//i.test(path) || /\.(?:test|spec)\.[^.]+$/i.test(path);
}

function isSensitivePath(path: string): boolean {
  return /(^|\/)(?:\.env[^/]*|credentials?\.json|auth\.json|secrets?\.json|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx|jks))$/i.test(path);
}

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return undefined; }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function scanFiles(root: string, excludedRoots: string[]): Set<string> {
  const excluded = excludedRoots.map((path) => normalize(path.startsWith(root) ? relative(root, path) : path)).filter(Boolean);
  const blocked = (path: string): boolean => excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const result = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "coverage", ".pforge", "target", "vendor"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      const path = normalize(relative(root, full));
      if (blocked(path)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.add(path);
    }
  };
  walk(root);
  return result;
}

export function collectChangeEvidence(root: string, checkpoint: CheckpointManifest, excludedRoots: string[] = []): ChangeEvidence {
  const before = new Map(checkpoint.files.map((file) => [normalize(file.path), file.hash]));
  const gitFiles = runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard"])?.split(/\r?\n/).filter(Boolean).map(normalize) ?? [];
  const afterPaths = new Set(gitFiles.length ? gitFiles : [...scanFiles(root, excludedRoots)]);
  const excluded = excludedRoots.map((path) => { const absolute = normalize(path); const rootPath = normalize(root).replace(/\/$/, ""); return absolute === rootPath ? "" : absolute.startsWith(`${rootPath}/`) ? absolute.slice(rootPath.length + 1) : absolute; }).filter(Boolean);
  const isExcluded = (path: string): boolean => excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const changedFiles: ChangedFile[] = [];
  for (const path of new Set([...before.keys(), ...afterPaths])) {
    if (isExcluded(path)) continue;
    const beforeHash = before.get(path);
    const afterHash = hashFile(join(root, path));
    if (beforeHash === afterHash) continue;
    changedFiles.push({
      path,
      status: beforeHash && afterHash ? "modified" : beforeHash ? "deleted" : "added",
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
      isTest: isTestPath(path),
      sensitive: isSensitivePath(path)
    });
  }
  changedFiles.sort((a, b) => a.path.localeCompare(b.path));
  const visible = changedFiles.filter((file) => !file.sensitive).map((file) => file.path);
  const gitDiff = visible.length ? runGit(root, ["diff", "--no-ext-diff", "--binary", "--", ...visible]) ?? "" : "";
  const fallback = changedFiles.filter((file) => !file.sensitive).map((file) => `${file.status} ${file.path}`).join("\n");
  const diff = gitDiff || fallback;
  return {
    changedFiles,
    testFilesChanged: changedFiles.filter((file) => file.isTest).map((file) => file.path),
    nonTestChanged: changedFiles.filter((file) => !file.isTest && !file.sensitive).map((file) => file.path),
    diff: diff.slice(0, 120_000),
    diffTruncated: diff.length > 120_000
  };
}

export function validateChangeEvidence(evidence: ChangeEvidence, options: { allowTestEdits: boolean; allowEmpty: boolean; requireImplementation?: boolean }): string[] {
  const problems: string[] = [];
  if (!options.allowEmpty && evidence.changedFiles.length === 0) problems.push("No workspace changes were detected.");
  if (options.requireImplementation && evidence.nonTestChanged.length === 0) problems.push("No non-test implementation files changed.");
  if (evidence.changedFiles.some((file) => file.sensitive)) problems.push("Sensitive credential files were modified or created.");
  if (!options.allowTestEdits && evidence.testFilesChanged.length > 0 && evidence.nonTestChanged.length === 0) problems.push("Only test files changed; implementation evidence is missing.");
  return problems;
}
