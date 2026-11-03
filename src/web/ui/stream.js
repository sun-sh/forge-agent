// A fetch-based SSE client keeps the access token out of request URLs.
export class StreamError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createSseParser(onEvent) {
  let buffer = '';
  return (chunk, final = false) => {
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    if (final && buffer) { frames.push(buffer); buffer = ''; }
    for (const frame of frames) {
      const data = [], fields = {};
      for (const line of frame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (name === 'data') data.push(value);
        if (name === 'id' && !value.includes('\0')) fields.id = value;
      }
      if (data.length) onEvent({ id: fields.id, data: data.join('\n') });
    }
  };
}

export async function readEventStream(url, token, { after = 0, signal, onEvent }) {
  const headers = { 'x-pforge-token': token, accept: 'text/event-stream' };
  if (after) headers['last-event-id'] = String(after);
  const response = await fetch(url, { headers, signal, cache: 'no-store' });
  if (!response.ok) throw new StreamError(response.status, '实时连接返回 HTTP ' + response.status);
  if (!response.body) throw new Error('实时连接没有响应内容');
  const reader = response.body.getReader();
  const decode = new TextDecoder();
  const parse = createSseParser(onEvent);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { parse(decode.decode(), true); break; }
      parse(decode.decode(value, { stream: true }));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
