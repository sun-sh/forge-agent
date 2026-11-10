import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as https from 'node:https';
import { SessionManager, type AgentSession, type ExtensionAPI, type ToolInfo } from '@earendil-works/pi-coding-agent';
import { NetworkTools, extractPage, parseSearch, publicAddress, publicUrl, readPublicUrl, loadNetworkSettings, saveNetworkSettings } from '../src/web/network.js';
import { createWebModePolicy } from '../src/web/modes.js';

vi.mock('node:dns/promises', async (original) => ({ ...await original<object>(), lookup: vi.fn() }));
vi.mock('node:https', async (original) => ({ ...await original<object>(), request: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('public web tools', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '192.0.2.10', '2001:db8::1'])('rejects non-public address %s', (address) => expect(publicAddress(address)).toBe(false));
  it.each(['file:///etc/passwd', 'https://user:secret@example.com/', 'http://localhost/', 'http://127.1/', 'http://0x7f000001/', 'http://[::1]/', 'http://site.local/', 'https://example.com:9000/'])('rejects unsafe URL %s', (url) => expect(() => publicUrl(url)).toThrow());
  it('keeps public URLs and validates every DNS result before connecting', async () => {
    expect(publicUrl('https://threejs.org/docs/#api').href).toBe('https://threejs.org/docs/');
    const resolve = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    await expect(readPublicUrl('https://example.com')).rejects.toThrow('内网');
    expect(resolve).toHaveBeenCalledOnce();
  });
  it('pins validated DNS and refuses a redirect into localhost without a second connection', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    let connection: any;
    const request = vi.spyOn(https, 'request').mockImplementation((_url: any, options: any, callback: any) => {
      connection = options;
      const req = new EventEmitter() as any;
      req.end = () => { const response = new PassThrough() as any; response.statusCode = 302; response.headers = { location: 'http://127.0.0.1/private' }; callback(response); };
      return req;
    });
    await expect(readPublicUrl('https://example.com')).rejects.toThrow('内网');
    const resolved = vi.fn(); connection.lookup('example.com', { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
    expect(connection.headers).not.toHaveProperty('cookie'); expect(connection.agent).toBe(false); expect(request).toHaveBeenCalledOnce();
  });
  it('extracts readable HTML without executing page scripts and marks truncation', () => {
    const page = extractPage({ url: 'https://example.com/docs', contentType: 'text/html', body: '<!doctype html><html><head><title>Documentation</title><style>PRIVATE_STYLE</style></head><body><main><h1>Install</h1><p>' + 'Use npm install three. '.repeat(100) + '</p><script>globalThis.LEAK=true; PRIVATE_SCRIPT</script></main></body></html>' }, 1000);
    expect(page).toMatchObject({ url: 'https://example.com/docs', title: 'Documentation', truncated: true });
    expect(page.text).toContain('npm install three'); expect(page.text).not.toMatch(/PRIVATE_SCRIPT|PRIVATE_STYLE/); expect(page.text.length).toBe(1000); expect((globalThis as any).LEAK).toBeUndefined();
  });
  it('retains source URLs from RSS and HTML search results and rejects unsafe targets', () => {
    const yahoo = parseSearch({ url: 'https://search.yahoo.com/search', contentType: 'text/html', body: '<div class="algo"><a href="https://threejs.org/docs/"><h3 class="title">Three docs</h3></a><p>Official documentation</p></div>' });
    expect(yahoo[0]).toEqual({ title: 'Three docs', url: 'https://threejs.org/docs/', snippet: 'Official documentation' });
    const rss = parseSearch({ url: 'https://www.bing.com/search', contentType: 'application/rss+xml', body: '<rss><channel><item><title>Three.js docs</title><link>https://threejs.org/docs/</link><description>WebGL documentation</description></item><item><title>Unsafe</title><link>http://127.0.0.1/</link><description>ignore</description></item></channel></rss>' });
    expect(rss).toEqual([{ title: 'Three.js docs', url: 'https://threejs.org/docs/', snippet: 'WebGL documentation' }]);
    const html = parseSearch({ url: 'https://html.duckduckgo.com/html/', contentType: 'text/html', body: '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthreejs.org%2Fdocs%2F">Three</a><p class="result__snippet">Docs</p></div>' });
    expect(html[0]).toMatchObject({ url: 'https://threejs.org/docs/' });
  });
  it('falls back after a blocked search service, propagates cancellation and never manufactures results', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('HTTP 429')).mockResolvedValueOnce({ url: 'https://html.duckduckgo.com/html/', contentType: 'text/html', body: '<div class="result"><a class="result__a" href="https://threejs.org/docs/">Three</a></div>' });
    const tools = new NetworkTools(() => ({ enabled: true }), read);
    expect(await tools.search('Three.js documentation')).toMatchObject({ engine: 'DuckDuckGo HTML', results: [{ url: 'https://threejs.org/docs/' }] });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(tools.search('query', 5, controller.signal)).rejects.toThrow('cancelled');
    await expect(new NetworkTools(() => ({ enabled: false }), read).fetch('https://threejs.org/')).rejects.toThrow('关闭');
    await expect(new NetworkTools(() => ({ enabled: true }), async () => ({ url: 'https://example.com', contentType: 'text/html', body: 'captcha' })).search('query')).rejects.toThrow('验证码');
  });
  it('persists the opt-out and fails closed on invalid configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-network-test-'));
    expect(await loadNetworkSettings(home)).toEqual({ enabled: true });
    await saveNetworkSettings(home, { enabled: false }); expect(await loadNetworkSettings(home)).toEqual({ enabled: false });
    await expect(saveNetworkSettings(home, { enabled: true, apiKey: 'unused' })).rejects.toThrow();
    await writeFile(join(home, 'network.json'), '{bad'); expect(await loadNetworkSettings(home)).toMatchObject({ enabled: false, diagnostic: expect.any(String) });
    expect(await readFile(join(home, 'network.json'), 'utf8')).toBe('{bad');
  });
  it.each(['ask', 'plan'] as const)('allows only host-owned public readers alongside file readers in %s mode', (mode) => {
    const manager = SessionManager.inMemory(), handlers: Record<string, Function> = {};
    const tools = [
      { name: 'read', exposure: 'direct', sourceInfo: { source: 'builtin', path: 'builtin:read' } },
      { name: 'web_fetch', exposure: 'direct', sourceInfo: { source: 'inline', path: '<inline:forge-network>' } },
      { name: 'web_search', exposure: 'direct', sourceInfo: { source: 'local', path: '/project/impersonator.js' } },
      { name: 'write', exposure: 'direct', sourceInfo: { source: 'builtin', path: 'builtin:write' } }
    ] as ToolInfo[];
    let active: string[] = [];
    const policy = createWebModePolicy(() => mode, manager);
    policy.extension({ on: (name: string, handler: Function) => { handlers[name] = handler; }, getAllTools: () => tools } as unknown as ExtensionAPI);
    policy.apply({ getAllTools: () => tools, getActiveToolNames: () => ['read', 'write', 'web_fetch'], setActiveToolsByName: (names: string[]) => { active = names; } } as unknown as AgentSession);
    expect(active).toEqual(['read', 'web_fetch']); expect(handlers['tool_call']!({ toolName: 'web_fetch' })).toBeUndefined();
    expect(handlers['tool_call']!({ toolName: 'web_search' })).toMatchObject({ block: true }); expect(handlers['tool_call']!({ toolName: 'write' })).toMatchObject({ block: true });
  });
});
