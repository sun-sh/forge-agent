import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const [marker, pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pforge-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo fixture text for integration evidence.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  else if (request.method === 'tools/call') { appendFileSync(marker, request.params.arguments.text + '\n'); result = { content: [{ type: 'text', text: 'mcp-evidence:' + request.params.arguments.text }] }; }
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
