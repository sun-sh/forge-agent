import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from '@earendil-works/pi-coding-agent';
import type { McpRuntimeView } from './mcp-runtime.js';

/** Match Pi CLI builtin names, replacement and disable semantics without altering defaultTools. */
export function webBuiltinExtensions(mcp?: McpRuntimeView) {
  return [
    { name: 'codemode', factory: createCodemodeExtension({ mode: 'on' }), builtin: true, replaceable: true },
    { name: 'tool-search', factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: 'mcp', factory: mcp?.factory() ?? createMcpExtension(), builtin: true, replaceable: true }
  ];
}
