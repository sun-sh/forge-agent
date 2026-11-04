import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/** A local authorization server/resource server; never uses real accounts or credentials. */
export async function startOAuthFixture() {
  let origin, registration, challenge, grants = 0, calls = 0;
  const secret = 'isolated-oauth-fixture-access-token';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    const json = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['tools:read'] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(200, { issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { registration = JSON.parse(raw); return json(201, { ...registration, client_id: 'forge-local-fixture' }); }
    if (url.pathname === '/authorize') {
      challenge = url.searchParams.get('code_challenge');
      if (!registration?.redirect_uris.includes(url.searchParams.get('redirect_uri')) || url.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const redirect = new URL(url.searchParams.get('redirect_uri')); redirect.searchParams.set('code', 'local-fixture-code'); redirect.searchParams.set('state', url.searchParams.get('state'));
      response.writeHead(302, { location: redirect.href }).end(); return;
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(raw), proof = createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
      if (params.get('code') !== 'local-fixture-code' || proof !== challenge) return json(400, { error: 'invalid_grant' });
      grants++; return json(200, { access_token: secret, token_type: 'Bearer', expires_in: 3600, scope: 'tools:read' });
    }
    if (url.pathname !== '/mcp') return json(404, {});
    if (request.headers.authorization !== 'Bearer ' + secret) { response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return; }
    const input = raw ? JSON.parse(raw) : {};
    if (input.id === undefined) { response.writeHead(202).end(); return; }
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    const result = input.method === 'initialize' ? { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oauth-local-fixture', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'read/file', description: 'Read-only fixture.', inputSchema: { type: 'object' } }] }
      : input.method === 'tools/call' ? (calls++, { content: [{ type: 'text', text: 'fixture' }] }) : {};
    json(200, { jsonrpc: '2.0', id: input.id, result });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, secret, get grants() { return grants; }, get calls() { return calls; }, close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }) };
}
