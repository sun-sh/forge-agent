import { z } from "zod";
import { schemaToJson } from "../schema/json-schema.js";
import type { ContextEngine } from "../context/engine.js";
import type { JsonValue, ToolDefinition, ToolExecutionResult } from "../protocol.js";

const repoMapInput = z.object({
  query: z.string().max(4_000).optional(),
  budgetTokens: z.number().int().min(200).max(12_000).default(2_000)
}).strict();

function schemaOf<T>(schema: z.ZodType<T>): Record<string, JsonValue> {
  return schemaToJson(schema);
}

export function createRepoMapTool(context: ContextEngine): ToolDefinition<z.infer<typeof repoMapInput>> {
  return {
    name: "repo_map",
    description: "Return a token-budgeted repository index of important symbols and dependencies. Optionally focus it with a query naming classes, functions, files, or concepts. Use this to orient across modules before broad grep/read work.",
    effect: "read",
    parallelSafe: true,
    inputSchema: schemaOf(repoMapInput),
    parse: (input) => repoMapInput.parse(input),
    async execute(input): Promise<ToolExecutionResult> {
      const map = await context.map(input.query, input.budgetTokens);
      return {
        content: [{ type: "text", text: map.text || "Repository map is empty." }],
        metadata: { files: map.files, symbols: map.symbols, estimatedTokens: map.estimatedTokens }
      };
    }
  };
}
