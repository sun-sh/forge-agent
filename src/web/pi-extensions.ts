import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from '@earendil-works/pi-coding-agent';

/** Match Pi CLI builtin names, replacement and disable semantics without altering defaultTools. */
export function webBuiltinExtensions() {
  return [
    { name: 'codemode', factory: createCodemodeExtension({ mode: 'on' }), builtin: true, replaceable: true },
    { name: 'tool-search', factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: 'mcp', factory: createMcpExtension(), builtin: true, replaceable: true }
  ];
}
