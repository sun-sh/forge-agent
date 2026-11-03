import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTwoFilesPatch, parsePatch, applyPatch } from "diff";
import { z } from "zod";
import { schemaToJson } from "../schema/json-schema.js";
import type { JsonValue, ToolDefinition, ToolExecutionResult } from "../protocol.js";
import type { PathGuard } from "../security/path-guard.js";

const patchInput = z.object({
  patch: z.string().min(1).max(4_000_000)
}).strict();

function schemaOf<T>(schema: z.ZodType<T>): Record<string, JsonValue> {
  return schemaToJson(schema);
}

interface PlannedChange {
  path: string;
  absolute: string;
  before: string;
  after: string;
  existed: boolean;
}

function stripPatchPrefix(path: string): string {
  return path.replace(/^[ab]\//, "").replace(/^\.\//, "");
}

function splitOperations(patch: string): string[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const operations: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.some((line) => line.startsWith("--- ") || line.startsWith("+++ "))) operations.push(current.join("\n"));
    current = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch") || line.startsWith("*** Begin") || line.startsWith("*** End")) continue;
    if ((line.startsWith("*** Add File:") || line.startsWith("*** Delete File:") || line.startsWith("*** Update File:") || line.startsWith("*** Move to:"))) {
      flush();
      current.push(line);
      continue;
    }
    if (line.startsWith("*** ") && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return operations.filter(Boolean);
}

type UnifiedOperation = ReturnType<typeof parsePatch>[number];

function parseUnifiedOperations(patch: string): UnifiedOperation[] {
  const parsed = parsePatch(patch);
  if (!parsed.length) throw new Error("Patch parser found no file operations.");
  for (const entry of parsed) {
    if (!entry.oldFileName || !entry.newFileName) throw new Error("Every patch operation needs old and new file headers.");
    const oldPath = stripPatchPrefix(entry.oldFileName);
    const newPath = stripPatchPrefix(entry.newFileName);
    if (oldPath !== newPath && oldPath !== "/dev/null" && newPath !== "/dev/null") throw new Error("Renames are not supported by apply_patch; use a separate add/delete pair.");
  }
  return parsed;
}

function parseCustomOperations(patch: string): Array<{ kind: "add" | "delete" | "update"; path: string; moveTo?: string; lines: string[] }> {
  const operations: Array<{ kind: "add" | "delete" | "update"; path: string; moveTo?: string; lines: string[] }> = [];
  let current: { kind: "add" | "delete" | "update"; path: string; moveTo?: string; lines: string[] } | undefined;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      current = { kind: "add", path: line.slice("*** Add File: ".length).trim(), lines: [] };
      operations.push(current);
    } else if (line.startsWith("*** Delete File: ")) {
      current = { kind: "delete", path: line.slice("*** Delete File: ".length).trim(), lines: [] };
      operations.push(current);
    } else if (line.startsWith("*** Update File: ")) {
      current = { kind: "update", path: line.slice("*** Update File: ".length).trim(), lines: [] };
      operations.push(current);
    } else if (line.startsWith("*** Move to: ") && current) {
      current.moveTo = line.slice("*** Move to: ".length).trim();
    } else if (line === "*** End Patch" || line.startsWith("*** End of File")) {
      current = undefined;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return operations;
}

function applyCustomUpdate(before: string, lines: string[]): string {
  const sourceLines = before.replace(/\r\n/g, "\n").split("\n");
  const hunks: Array<{ oldLines: string[]; newLines: string[] }> = [];
  let hunk: { oldLines: string[]; newLines: string[] } | undefined;
  for (const raw of lines) {
    const line = raw ?? "";
    if (line.startsWith("@@")) {
      if (hunk) hunks.push(hunk);
      hunk = { oldLines: [], newLines: [] };
    } else if (line.startsWith("+")) {
      if (!hunk) hunk = { oldLines: [], newLines: [] };
      hunk.newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      if (!hunk) hunk = { oldLines: [], newLines: [] };
      hunk.oldLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      if (!hunk) hunk = { oldLines: [], newLines: [] };
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
    }
  }
  if (hunk) hunks.push(hunk);
  if (!hunks.length) return before;
  let cursor = 0;
  for (const change of hunks) {
    const oldBlock = change.oldLines.join("\n");
    const newBlock = change.newLines.join("\n");
    const index = sourceLines.slice(cursor).join("\n").indexOf(oldBlock);
    if (index < 0) throw new Error("Patch context did not match the target file.");
    const skipped = sourceLines.slice(cursor).join("\n").slice(0, index).split("\n").length - 1;
    const start = cursor + skipped;
    const oldCount = change.oldLines.length;
    const replacement = newBlock ? newBlock.split("\n") : [];
    sourceLines.splice(start, oldCount, ...replacement);
    cursor = start + replacement.length;
  }
  return sourceLines.join("\n");
}

function planFromCustomOperations(patch: string): Array<{ operation: ReturnType<typeof parseCustomOperations>[number] }> {
  const operations = parseCustomOperations(patch);
  if (!operations.length) return [];
  return operations.map((operation) => ({ operation }));
}

async function buildPlans(patch: string, guard: PathGuard): Promise<{ changes: PlannedChange[]; preview: string[] }> {
  const changes: PlannedChange[] = [];
  const preview: string[] = [];
  const custom = parseCustomOperations(patch);
  if (custom.length > 0) {
    for (const operation of custom) {
      if (operation.kind === "add") {
        const absolute = await guard.resolve(operation.path, "write");
        if (existsSync(absolute)) throw new Error(`Add File target already exists: ${operation.path}`);
        const content = operation.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n");
        changes.push({ path: operation.path, absolute, before: "", after: content, existed: false });
        preview.push(createTwoFilesPatch(operation.path, operation.path, "", content, "before", "after"));
      } else if (operation.kind === "delete") {
        const absolute = await guard.assertFile(operation.path);
        const before = await readFile(absolute, "utf8");
        changes.push({ path: operation.path, absolute, before, after: "", existed: true });
        preview.push(createTwoFilesPatch(operation.path, operation.path, before, "", "before", "after"));
      } else {
        const absolute = await guard.assertFile(operation.path);
        const before = await readFile(absolute, "utf8");
        const after = applyCustomUpdate(before, operation.lines);
        changes.push({ path: operation.path, absolute, before, after, existed: true });
        preview.push(createTwoFilesPatch(operation.path, operation.path, before, after, "before", "after"));
      }
    }
    return { changes, preview };
  }
  for (const entry of parseUnifiedOperations(patch)) {
    const path = stripPatchPrefix(entry.newFileName === "/dev/null" ? entry.oldFileName! : entry.newFileName!);
    const absolute = entry.newFileName === "/dev/null" ? await guard.assertFile(path) : await guard.assertWritableFile(path);
    const existed = existsSync(absolute);
    const before = existed ? await readFile(absolute, "utf8") : "";
    const after = applyPatch(before, entry, { fuzzFactor: 0, autoConvertLineEndings: true });
    if (after === false) throw new Error(`Patch did not apply cleanly to ${path}.`);
    changes.push({ path, absolute, before, after, existed });
    preview.push(createTwoFilesPatch(path, path, before, after, "before", "after"));
  }
  return { changes, preview };
}

export interface PatchTransactionFs {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const defaultTransactionFs: PatchTransactionFs = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, content) => { await writeFile(path, content, "utf8"); },
  rename,
  remove: async (path) => { await rm(path, { force: true }); },
  exists: async (path) => existsSync(path)
};

interface CommitJournal {
  change: PlannedChange;
  backup?: string;
  temporary?: string;
  movedToBackup: boolean;
  installed: boolean;
}

export async function commitPatchChanges(changes: PlannedChange[], transactionId: string, ops: PatchTransactionFs = defaultTransactionFs): Promise<void> {
  const suffix = transactionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const journals: CommitJournal[] = [];
  try {
    for (const change of changes) {
      await ops.mkdir(dirname(change.absolute));
      if (change.after === "") continue;
      const temporary = `${change.absolute}.pforge-${suffix}.tmp`;
      await ops.remove(temporary);
      await ops.writeFile(temporary, change.after);
    }
    for (const change of changes) {
      const backup = change.existed ? `${change.absolute}.pforge-${suffix}.bak` : undefined;
      const temporary = change.after === "" ? undefined : `${change.absolute}.pforge-${suffix}.tmp`;
      const journal: CommitJournal = { change, ...(backup ? { backup } : {}), ...(temporary ? { temporary } : {}), movedToBackup: false, installed: false };
      journals.push(journal);
      if (backup) {
        await ops.remove(backup);
        await ops.rename(change.absolute, backup);
        journal.movedToBackup = true;
      }
      if (temporary) {
        await ops.rename(temporary, change.absolute);
        journal.installed = true;
      }
    }
    for (const journal of journals) {
      if (journal.backup) await ops.remove(journal.backup).catch(() => undefined);
    }
  } catch (error) {
    for (const journal of [...journals].reverse()) {
      try {
        if (journal.installed || (!journal.change.existed && journal.movedToBackup === false)) {
          await ops.remove(journal.change.absolute);
        }
        if (journal.movedToBackup && journal.backup) {
          await ops.rename(journal.backup, journal.change.absolute);
        } else if (journal.change.existed && !journal.installed && (await ops.exists(journal.change.absolute))) {
          await ops.writeFile(journal.change.absolute, journal.change.before);
        }
      } catch { /* continue restoring the remaining journal entries */ }
    }
    for (const change of changes) {
      for (const extension of ["tmp", "bak"]) {
        await ops.remove(`${change.absolute}.pforge-${suffix}.${extension}`).catch(() => undefined);
      }
    }
    throw error;
  }
}
export function createApplyPatchTool(guard: PathGuard): ToolDefinition<z.infer<typeof patchInput>> {
  return {
    name: "apply_patch",
    description: "Apply a transaction over multiple files. Accepts unified diff with ---/+++ headers or the *** Begin Patch format with Add File, Delete File, and Update File sections. All target files are validated and computed in memory before any write. Prefer this for coherent multi-file changes.",
    effect: "write",
    parallelSafe: false,
    approval: { mode: "always", risk: "high", reason: "Transactional patch writes workspace files" },
    inputSchema: schemaOf(patchInput),
    parse: (input) => patchInput.parse(input),
    async execute(input, context): Promise<ToolExecutionResult> {
      const { changes, preview } = await buildPlans(input.patch, guard);
      if (changes.length === 0) return { isError: true, content: [{ type: "text", text: "Patch contains no file operations." }] };
      if (changes.length > 32) return { isError: true, content: [{ type: "text", text: "Patch touches more than 32 files; split it into smaller changes." }] };
      const seen = new Set<string>();
      for (const change of changes) {
        if (seen.has(change.absolute)) return { isError: true, content: [{ type: "text", text: `Patch touches ${change.path} more than once.` }] };
        seen.add(change.absolute);
      }
      await commitPatchChanges(changes, context.callId);
      context.emit({ type: "status", message: `Applied patch to ${changes.length} file(s)` });
      return {
        content: [{ type: "text", text: `Applied patch to ${changes.length} file(s): ${changes.map((change) => change.path).join(", ")}` }],
        metadata: { files: changes.length, diff: preview.join("\n").slice(0, 64_000) }
      };
    }
  };
}

void planFromCustomOperations;
void splitOperations;
void resolve;
