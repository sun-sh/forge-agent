/** No-key model stub for Docker plumbing acceptance. It deliberately does not solve the issue. */
import { createServer } from 'node:http';
export async function startSmokeModel() {
  let calls = 0;
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) { raw += chunk; if (raw.length > 2000000) { response.writeHead(413).end(); return; } }
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    let body; try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    calls++;
    const finishedTool = body.messages?.at(-1)?.role === 'tool';
    const delta = finishedTool ? { role: 'assistant', content: 'Synthetic integration fixture wrote forge-smoke.txt. It does not repair the benchmark issue.' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: 'smoke-write-' + calls, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'forge-smoke.txt', content: 'Forge SWE-bench integration fixture only.\n' }) } }]
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, reason] of [[delta, null], [{}, finishedTool ? 'stop' : 'tool_calls']]) {
      response.write('data: ' + JSON.stringify({ id: 'fixture-' + calls, object: 'chat.completion.chunk', model: 'fixture', created: 1, choices: [{ index: 0, delta: part, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } } : {}) }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', ready); });
  const port = server.address().port;
  return { port, calls: () => calls, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((ready) => server.close(ready)); } };
}
