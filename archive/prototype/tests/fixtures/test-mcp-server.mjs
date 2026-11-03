#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "pforge-test-mcp", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo a message back",
  inputSchema: { message: z.string() },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }));
server.registerTool("write_note", {
  description: "Pretend to write a note",
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async ({ text }) => ({ content: [{ type: "text", text: `wrote:${text}` }] }));
await server.connect(new StdioServerTransport());
