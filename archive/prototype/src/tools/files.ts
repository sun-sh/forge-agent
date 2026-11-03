import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { schemaToJson } from "../schema/json-schema.js";
import type { JsonValue, TextPart, ToolDefinition, ToolExecutionResult } from "../protocol.js";
import { PathGuard, isBinary } from "../security/path-guard.js";

const readInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(4000).optional()
});

const writeInput = z.object({
  path: z.string().min(1),
  content: z.string().max(4_000_000)
});

const editInput = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string().max(4_000_000)
});

const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_READ_LINES = 500;

function schemaOf<T>(schema: z.ZodType<T>): Record<string, JsonValue> {
  return schemaToJson(schema);
}

function withLineNumbers(lines: string[], start: number): string {
  return lines.map((line, index) => `${String(start + index).padStart(6, " ")}\t${line}`).join("\n");
}

export function createFileTools(guard: PathGuard): ToolDefinition[] {
  const read: ToolDefinition<z.infer<typeof readInput>> = {
    name: "read_file",
    description: "Read a UTF-8 text file with line numbers. Use offset and limit for large files. Binary files are rejected.",
    effect: "read",
    parallelSafe: true,
    inputSchema: schemaOf(readInput),
    async execute(input, context): Promise<ToolExecutionResult> {
      const path = await guard.assertFile(input.path);
      const buffer = await readFile(path);
      if (buffer.length > MAX_READ_BYTES && !input.limit) {
        return {
          isError: true,
          content: [{ type: "text", text: `File is ${buffer.length} bytes. Read it in chunks using offset and limit.` }]
        };
      }
      if (isBinary(buffer)) return { isError: true, content: [{ type: "text", text: "Binary file reading is not supported." }] };
      const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      const startIndex = (input.offset ?? 1) - 1;
      if (startIndex >= lines.length) return { isError: true, content: [{ type: "text", text: `Offset ${input.offset} is past the end of ${input.path}.` }] };
      const selected = lines.slice(startIndex, startIndex + (input.limit ?? DEFAULT_READ_LINES));
      const relative = guard.relative(path);
      context.emit({ type: "status", message: `Read ${relative} (${selected.length}/${lines.length} lines)` });
      return {
        content: [{ type: "text", text: `<file path="${relative}">\n${withLineNumbers(selected, startIndex + 1)}\n</file>` }],
        metadata: { lines: lines.length, shown: selected.length, offset: startIndex + 1 }
      };
    }
  };

  const write: ToolDefinition<z.infer<typeof writeInput>> = {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file. Parent directories are created automatically. Prefer edit_file for changing existing files.",
    effect: "write",
    parallelSafe: false,
    inputSchema: schemaOf(writeInput),
    approval: { mode: "always", risk: "medium", reason: "Overwrite or create a workspace file" },
    async execute(input, context): Promise<ToolExecutionResult> {
      const path = await guard.assertWritableFile(input.path);
      let previous: string | undefined;
      try { previous = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, "utf8");
      context.emit({ type: "status", message: `Wrote ${guard.relative(path)}` });
      const patch = createTwoFilesPatch(guard.relative(path), guard.relative(path), previous ?? "", input.content, undefined, undefined, { context: 3 });
      return {
        content: [{ type: "text", text: previous === undefined ? `Created ${guard.relative(path)}.` : `Overwrote ${guard.relative(path)}.` }],
        metadata: { diff: patch.slice(0, 32_000), bytes: Buffer.byteLength(input.content) }
      };
    }
  };

  const edit: ToolDefinition<z.infer<typeof editInput>> = {
    name: "edit_file",
    description: "Edit an existing UTF-8 text file by replacing one unique oldText block with newText. Read the file first and provide enough context to make the match unique.",
    effect: "write",
    parallelSafe: false,
    inputSchema: schemaOf(editInput),
    approval: { mode: "always", risk: "medium", reason: "Modify an existing workspace file" },
    async execute(input, context): Promise<ToolExecutionResult> {
      const path = await guard.assertFile(input.path);
      const original = await readFile(path, "utf8");
      const matches = original.split(input.oldText).length - 1;
      if (matches === 0) return { isError: true, content: [{ type: "text", text: `oldText was not found in ${guard.relative(path)}.` }] };
      if (matches > 1) return { isError: true, content: [{ type: "text", text: `oldText matched ${matches} times in ${guard.relative(path)}; provide more context.` }] };
      const updated = original.replace(input.oldText, input.newText);
      await writeFile(path, updated, "utf8");
      const relative = guard.relative(path);
      const patch = createTwoFilesPatch(relative, relative, original, updated, undefined, undefined, { context: 3 });
      context.emit({ type: "status", message: `Edited ${relative}` });
      return {
        content: [{ type: "text", text: `Edited ${relative}.` }],
        metadata: { diff: patch.slice(0, 32_000) }
      };
    }
  };

  return [read, write, edit] as ToolDefinition[];
}

export function normalizeTextContent(content: Array<TextPart>): string {
  return content.map((part) => part.text).join("\n");
}
