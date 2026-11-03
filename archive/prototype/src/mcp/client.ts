import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonValue, ToolDefinition, ToolExecutionResult } from "../protocol.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  timeoutMs?: number;
  autoApprove?: string[];
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

export interface McpConnection {
  server: string;
  client: Client;
  tools: McpToolInfo[];
  timeoutMs: number;
  close(): Promise<void>;
}

const PREFIX = "mcp__";
const MAX_TOOLS_PER_SERVER = 200;
const MAX_TOOL_DESCRIPTION = 8_000;
const MAX_TOOL_SCHEMA_BYTES = 256_000;
const MAX_RESULT_TEXT_BYTES = 128_000;
const MAX_RESULT_IMAGES = 4;
const MAX_RESULT_IMAGE_BYTES = 2_000_000;

export function normalizeMcpToolName(server: string, tool: string): string {
  const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "").slice(0, 40) || "tool";
  return `${PREFIX}${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);
}

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  if (!config.command.trim()) throw new Error(`MCP server ${config.name} has no command`);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    cwd: config.cwd,
    stderr: "pipe"
  });
  const client = new Client({ name: "pi-forge", version: "0.1.0" }, { capabilities: {} });
  transport.stderr?.on("data", () => { /* server diagnostics stay out of model context */ });
  try {
    await client.connect(transport);
    const discovered: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
      for (const tool of page.tools) {
        const inputSchema = (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, JsonValue>;
        if (Buffer.byteLength(JSON.stringify(inputSchema)) > MAX_TOOL_SCHEMA_BYTES) {
          throw new Error(`MCP tool ${config.name}/${tool.name} has an oversized input schema`);
        }
        discovered.push({
          server: config.name,
          name: tool.name,
          description: (tool.description ?? "").slice(0, MAX_TOOL_DESCRIPTION),
          inputSchema,
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint !== true,
          openWorld: tool.annotations?.openWorldHint === true
        });
        if (discovered.length > MAX_TOOLS_PER_SERVER) {
          throw new Error(`MCP server ${config.name} exposes more than ${MAX_TOOLS_PER_SERVER} tools`);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return {
      server: config.name,
      client,
      tools: discovered,
      timeoutMs,
      async close() { await client.close(); }
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function contentToResult(content: Awaited<ReturnType<Client["callTool"]>>): Array<{ type: "text"; text: string } | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }> {
  if (!("content" in content) || !Array.isArray(content.content)) {
    return [{ type: "text", text: JSON.stringify(content).slice(0, MAX_RESULT_TEXT_BYTES) }];
  }
  const result: Array<{ type: "text"; text: string } | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }> = [];
  let textBytes = 0;
  let imageCount = 0;
  for (const part of content.content) {
    if (part.type === "text") {
      const remaining = Math.max(0, MAX_RESULT_TEXT_BYTES - textBytes);
      const value = part.text.slice(0, remaining);
      textBytes += Buffer.byteLength(value);
      result.push({ type: "text", text: value });
    } else if (part.type === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(part.mimeType)) {
      if (imageCount >= MAX_RESULT_IMAGES || Buffer.byteLength(part.data) > MAX_RESULT_IMAGE_BYTES) {
        result.push({ type: "text", text: "[MCP image omitted: image budget exceeded]" });
      } else {
        imageCount++;
        result.push({ type: "image", mediaType: part.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: part.data });
      }
    } else if (part.type === "resource" && "text" in part.resource) {
      const remaining = Math.max(0, MAX_RESULT_TEXT_BYTES - textBytes);
      const value = part.resource.text.slice(0, remaining);
      textBytes += Buffer.byteLength(value);
      result.push({ type: "text", text: value });
    } else {
      result.push({ type: "text", text: `[MCP ${part.type} content omitted]` });
    }
    if (textBytes >= MAX_RESULT_TEXT_BYTES && imageCount >= MAX_RESULT_IMAGES) break;
  }
  return result.length ? result : [{ type: "text", text: "(no output)" }];
}

export function createMcpToolDefinitions(connections: McpConnection[], autoApprove: Map<string, Set<string>>): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const connection of connections) {
    for (const info of connection.tools) {
      const name = normalizeMcpToolName(info.server, info.name);
      const readOnly = info.readOnly && !info.destructive && !info.openWorld;
      const approved = autoApprove.get(info.server)?.has(info.name) === true;
      tools.push({
        name,
        description: `[MCP ${info.server}] ${info.description}`,
        inputSchema: { ...info.inputSchema, type: "object" },
        effect: readOnly ? "read" : "execute",
        parallelSafe: readOnly,
        approval: readOnly && approved
          ? { mode: "never", risk: "low", reason: "Explicit MCP autoApprove and read-only annotation" }
          : { mode: "always", risk: info.destructive ? "high" : "medium", reason: `External MCP tool from ${info.server}` },
        async execute(input, context): Promise<ToolExecutionResult> {
          const result = await connection.client.callTool(
            { name: info.name, arguments: input as Record<string, unknown> },
            undefined,
            { timeout: connection.timeoutMs, signal: context.signal }
          );
          return {
            isError: "isError" in result ? result.isError === true : false,
            content: contentToResult(result),
            metadata: {
              server: info.server,
              tool: info.name,
              ...("structuredContent" in result && result.structuredContent
                ? { structured: JSON.stringify(result.structuredContent).slice(0, 32_000) }
                : {})
            }
          };
        }
      });
    }
  }
  return tools;
}

export async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.close()));
}
