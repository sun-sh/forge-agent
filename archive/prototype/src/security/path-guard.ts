import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertNotSensitive } from "./sensitive.js";

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export interface SecurePathOptions {
  cwd: string;
  readOnly?: boolean;
  allowedRoots?: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export class PathGuard {
  readonly cwd: string;
  readonly allowedRoots: string[];
  private readonly readOnly: boolean;

  constructor(options: SecurePathOptions) {
    this.cwd = resolve(options.cwd);
    this.allowedRoots = [this.cwd, ...(options.allowedRoots ?? []).map((root) => resolve(root))];
    this.readOnly = options.readOnly ?? false;
  }

  async resolve(input: string, operation: "read" | "write" = "read"): Promise<string> {
    if (!input || input.includes("\0")) throw new PathSecurityError("Path is empty or contains NUL bytes.");
    if (operation === "write" && this.readOnly) throw new PathSecurityError("Writes are disabled in read-only mode.");
    const target = resolve(this.cwd, input);
    assertNotSensitive(target);
    if (!this.allowedRoots.some((root) => isWithin(root, target))) {
      throw new PathSecurityError(`Path escapes the permitted workspace: ${input}`);
    }
    let candidate = target;
    if (existsSync(target)) {
      candidate = await realpath(target);
    } else if (operation === "read") {
      throw new PathSecurityError(`File does not exist: ${input}`);
    } else {
      let parent = resolve(target, "..");
      while (!existsSync(parent)) parent = resolve(parent, "..");
      candidate = resolve(await realpath(parent), relative(parent, target));
    }
    if (!this.allowedRoots.some((root) => isWithin(root, candidate))) {
      throw new PathSecurityError(`Path resolves outside the permitted workspace: ${input}`);
    }
    return target;
  }

  async assertFile(input: string): Promise<string> {
    const path = await this.resolve(input, "read");
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink()) throw new PathSecurityError(`Symbolic links are not readable: ${input}`);
    const info = await stat(path);
    if (!info.isFile()) throw new PathSecurityError(`Not a regular file: ${input}`);
    return path;
  }

  async assertWritableFile(input: string): Promise<string> {
    const path = await this.resolve(input, "write");
    if (existsSync(path)) {
      const linkInfo = await lstat(path);
      if (linkInfo.isSymbolicLink()) throw new PathSecurityError(`Symbolic links are not editable: ${input}`);
      const info = await stat(path);
      if (!info.isFile()) throw new PathSecurityError(`Not a regular file: ${input}`);
    }
    return path;
  }

  relative(path: string): string {
    return relative(this.cwd, path).replaceAll(sep, "/") || ".";
  }
}

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.08;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newId(): string {
  return randomUUID();
}