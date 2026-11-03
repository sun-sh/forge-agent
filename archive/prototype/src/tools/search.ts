import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";
import { schemaToJson } from "../schema/json-schema.js";
import type { JsonValue, ToolDefinition, ToolExecutionResult } from "../protocol.js";
import { PathGuard, isBinary } from "../security/path-guard.js";
import { isSensitiveFile } from "../security/sensitive.js";

const globInput = z.object({
  pattern: z.string().default("**/*"),
  path: z.string().default("."),
  limit: z.number().int().positive().max(2000).default(200)
}).strict();

const grepInput = z.object({
  pattern: z.string().min(1).max(2000),
  path: z.string().default("."),
  glob: z.string().optional(),
  limit: z.number().int().positive().max(1000).default(100),
  context: z.number().int().min(0).max(10).default(0),
  caseSensitive: z.boolean().default(true)
}).strict();

function schemaOf<T>(schema: z.ZodType<T>): Record<string, JsonValue> {
  return schemaToJson(schema);
}

async function loadIgnore(root: string): Promise<Ignore> {
  const matcher = ignore();
  for (const name of [".gitignore", ".ignore"]) {
    try { matcher.add(await readFile(resolve(root, name), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  matcher.add(["node_modules/", ".git/", "dist/", "coverage/", ".pforge/", "*.min.js", "*.map"]);
  return matcher;
}

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function workspaceRelative(root: string, relativeToSearch: string): string | undefined {
  const value = normalizeRelative(relativeToSearch);
  if (!value || value === "." || value.startsWith("../") || value === "..") return undefined;
  const absolute = resolve(root, value);
  const relativeToWorkspace = normalizeRelative(relative(root, absolute));
  return relativeToWorkspace && !relativeToWorkspace.startsWith("../") && relativeToWorkspace !== ".." ? relativeToWorkspace : undefined;
}

export function createSearchTools(guard: PathGuard, extraIgnores: string[] = []): ToolDefinition[] {
  const commonGlobOptions = {
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
    ignore: [...extraIgnores, "node_modules/**", ".git/**", "dist/**", "coverage/**", ".pforge/**", "*.min.js", "*.map"]
  };
  const glob: ToolDefinition<z.infer<typeof globInput>> = {
    name: "find_files",
    description: "Find files using a glob pattern. Respects .gitignore and common generated directories. Returns workspace-relative paths.",
    effect: "read",
    parallelSafe: true,
    inputSchema: schemaOf(globInput),
    parse: (input) => globInput.parse(input),
    async execute(input): Promise<ToolExecutionResult> {
      const root = await guard.resolve(input.path, "read");
      const searchPrefix = normalizeRelative(relative(guard.cwd, root));
      const matcher = await loadIgnore(guard.cwd);
      for (const pattern of extraIgnores) matcher.add(pattern);
      const results = await fg(input.pattern, { ...commonGlobOptions, cwd: root, objectMode: true });
      const accepted: string[] = [];
      for (const entry of results) {
        const relToSearch = normalizeRelative(entry.path);
        const relativeToWorkspace = workspaceRelative(guard.cwd, searchPrefix ? `${searchPrefix}/${relToSearch}` : relToSearch);
        if (!relativeToWorkspace || matcher.ignores(relativeToWorkspace) || isSensitiveFile(relativeToWorkspace)) continue;
        accepted.push(relativeToWorkspace);
        if (accepted.length >= input.limit) break;
      }
      return {
        content: [{ type: "text", text: accepted.length ? accepted.join("\n") : "No files found." }],
        metadata: { count: accepted.length, limitReached: results.length > accepted.length }
      };
    }
  };

  const grep: ToolDefinition<z.infer<typeof grepInput>> = {
    name: "grep",
    description: "Search text files in the workspace. Uses JavaScript regular expressions by default, respects ignore files, and truncates long output.",
    effect: "read",
    parallelSafe: true,
    inputSchema: schemaOf(grepInput),
    parse: (input) => grepInput.parse(input),
    async execute(input): Promise<ToolExecutionResult> {
      let regex: RegExp;
      try { regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i"); }
      catch (error) { return { isError: true, content: [{ type: "text", text: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}` }] }; }
      const root = await guard.resolve(input.path, "read");
      const searchPrefix = normalizeRelative(relative(guard.cwd, root));
      const matcher = await loadIgnore(guard.cwd);
      for (const pattern of extraIgnores) matcher.add(pattern);
      const entries = await fg(input.glob ?? "**/*", { ...commonGlobOptions, cwd: root, objectMode: true });
      const output: string[] = [];
      let matches = 0;
      let limitReached = false;
      for (const entry of entries) {
        const relToSearch = normalizeRelative(entry.path);
        const relativeToWorkspace = workspaceRelative(guard.cwd, searchPrefix ? `${searchPrefix}/${relToSearch}` : relToSearch);
        if (!relativeToWorkspace || matcher.ignores(relativeToWorkspace) || isSensitiveFile(relativeToWorkspace)) continue;
        const absolute = resolve(root, relToSearch);
        let buffer: Buffer;
        try { buffer = await readFile(absolute); } catch { continue; }
        if (buffer.length > 2_000_000 || isBinary(buffer)) continue;
        const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i] ?? "")) continue;
          matches++;
          const start = Math.max(0, i - input.context);
          const end = Math.min(lines.length, i + input.context + 1);
          for (let j = start; j < end; j++) output.push(`${relativeToWorkspace}:${j + 1}: ${(lines[j] ?? "").slice(0, 500)}`);
          if (input.context > 0) output.push("--");
          if (matches >= input.limit) { limitReached = true; break; }
        }
        if (limitReached) break;
      }
      if (output.at(-1) === "--") output.pop();
      return {
        content: [{ type: "text", text: output.length ? output.join("\n") : "No matches found." }],
        metadata: { matches, limitReached }
      };
    }
  };

  return [glob, grep] as ToolDefinition[];
}
