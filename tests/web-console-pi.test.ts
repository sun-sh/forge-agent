import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startWebConsole } from "../src/web/server.js";

const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "pforge-web-home-"));
  // Keep the canonical Forge variable empty so tests that temporarily change
  // the legacy PFORGE_HOME alias still exercise the selected isolated home.
  vi.stubEnv("FORGE_AGENT_HOME", "");
  vi.stubEnv("PFORGE_HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(home, "sessions"));
});
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.unstubAllEnvs(); });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "pforge-web-test-"));
  await writeFile(join(root, "pforge.json"), JSON.stringify({ verify: [{ name: "ok", command: "node --version" }], verifyRetries: 1 }), "utf8");
  return root;
}

describe("pforge Pi web console", () => {
  it("serves the client and requires the access token", async () => {
    const root = await workspace();
    const server = await startWebConsole({ cwd: root, port: 0 });
  const base = server.url.split("?")[0];
    closers.push(server.close);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Forge");
    const denied = await fetch(base + "api/config");
    expect(denied.status).toBe(401);
    const config = await fetch(base + "api/config", { headers: { "x-pforge-token": server.token } });
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ verifyRetries: 1 });
  });

  it("reports missing model credentials instead of creating a fake session", async () => {
    const root = await workspace();
    const server = await startWebConsole({ cwd: root, port: 0 });
    const base = server.url.split("?")[0];
    closers.push(server.close);
    const response = await fetch(base + "api/session", { method: "POST", headers: { "x-pforge-token": server.token } });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error?: string }).error).toMatch(/No model credentials/);
  });

  it("exposes project, directory, history, and model endpoints", async () => {
    const root = await workspace();
    const server = await startWebConsole({ cwd: root, port: 0 });
    closers.push(server.close);
    const base = server.url.split("?")[0];
    const headers = { "x-pforge-token": server.token };
    const projects = await fetch(base + "api/projects", { headers });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({ projects: expect.any(Array) });
    const directories = await fetch(base + "api/directories", { headers });
    expect(directories.status).toBe(200);
    expect(await directories.json()).toMatchObject({ path: expect.any(String), directories: expect.any(Array) });
    const history = await fetch(base + "api/history", { headers });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ projects: expect.any(Array) });
    const settings = await fetch(base + "api/settings", { headers });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ models: expect.any(Array) });
  });

  it("exposes the real Pi catalog and persists the selected default model", async () => {
    const root = await workspace();
    const home = await mkdtemp(join(tmpdir(), "pforge-web-home-"));
    await writeFile(join(home, "models.json"), JSON.stringify({
      providers: {
        mock: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test",
          models: [{ id: "mock", name: "Mock model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
        }
      }
    }), "utf8");
    const previousHome = process.env["PFORGE_HOME"];
    process.env["PFORGE_HOME"] = home;
    let server: Awaited<ReturnType<typeof startWebConsole>> | undefined;
    try {
      server = await startWebConsole({ cwd: root, port: 0 });
      const base = server.url.split("?")[0];
      const headers = { "x-pforge-token": server.token };
      const settings = await fetch(base + "api/settings", { headers });
      const value = await settings.json() as { model: string | null; models: Array<{ key: string; available: boolean; reasoning: boolean }> };
      expect(settings.status).toBe(200);
      expect(value.models).toEqual(expect.arrayContaining([expect.objectContaining({ key: "mock/mock", available: true, reasoning: true })]));
      const saved = await fetch(base + "api/settings", { method: "POST", headers, body: JSON.stringify({ model: "mock/mock", thinkingLevel: "high" }) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ model: "mock/mock", thinkingLevel: "high" });
      expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({ defaultProvider: "mock", defaultModel: "mock", defaultThinkingLevel: "high" });
      const credential = await fetch(base + "api/credentials", { method: "POST", headers, body: JSON.stringify({ provider: "mock", apiKey: "persisted-test-key" }) });
      expect(credential.status).toBe(200);
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))).toMatchObject({ mock: { type: "api_key", key: "persisted-test-key" } });
      const trust = await fetch(base + "api/projects/trust?path=" + encodeURIComponent(root), { headers });
      expect(await trust.json()).toMatchObject({ trust: { trusted: expect.any(Boolean) } });
    } finally {
      if (server) await server.close();
      if (previousHome === undefined) delete process.env["PFORGE_HOME"];
      else process.env["PFORGE_HOME"] = previousHome;
    }
  });

  it("clamps thinking settings when a selected model does not support them", async () => {
    const root = await workspace();
    const home = await mkdtemp(join(tmpdir(), "pforge-web-thinking-home-"));
    await writeFile(join(home, "models.json"), JSON.stringify({
      providers: {
        mock: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test",
          models: [
            { id: "reasoning", name: "Reasoning model", reasoning: true, input: ["text"], thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, contextWindow: 8192, maxTokens: 1024 },
            { id: "text", name: "Text model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }
          ]
        }
      }
    }), "utf8");
    const previousHome = process.env["PFORGE_HOME"];
    process.env["PFORGE_HOME"] = home;
    let server: Awaited<ReturnType<typeof startWebConsole>> | undefined;
    try {
      server = await startWebConsole({ cwd: root, port: 0 });
      const base = server.url.split("?")[0];
      const headers = { "x-pforge-token": server.token };
      const saved = await fetch(base + "api/settings", { method: "POST", headers, body: JSON.stringify({ model: "mock/text", thinkingLevel: "high" }) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ model: "mock/text", thinkingLevel: "off" });
      const created = await fetch(base + "api/session", { method: "POST", headers, body: JSON.stringify({ project: root, model: "mock/reasoning", thinkingLevel: "high" }) });
      expect(created.status).toBe(201);
      const session = await created.json() as { id: string; thinkingLevel: string };
      expect(session.thinkingLevel).toBe("high");
      const switched = await fetch(base + "api/sessions/" + session.id + "/model", { method: "POST", headers, body: JSON.stringify({ model: "mock/text" }) });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({ model: "mock/text", thinkingLevel: "off" });
    } finally {
      if (server) await server.close();
      if (previousHome === undefined) delete process.env["PFORGE_HOME"];
      else process.env["PFORGE_HOME"] = previousHome;
    }
  });

  it("rejects restoring a session into a different project", async () => {
    const projectA = await workspace();
    const projectB = await workspace();
    const home = await mkdtemp(join(tmpdir(), "pforge-web-history-home-"));
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "models.json"), JSON.stringify({
      providers: { mock: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test", models: [{ id: "mock" }] } }
    }), "utf8");
    const manager = SessionManager.create(projectA, join(home, "sessions"));
    manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeTruthy();
    const previousHome = process.env["PFORGE_HOME"];
    process.env["PFORGE_HOME"] = home;
    let server: Awaited<ReturnType<typeof startWebConsole>> | undefined;
    try {
      server = await startWebConsole({ cwd: projectB, port: 0 });
      const base = server.url.split("?")[0];
      const response = await fetch(base + "api/session", { method: "POST", headers: { "x-pforge-token": server.token }, body: JSON.stringify({ project: projectB, sessionFile }) });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error?: string }).error).toContain("different project");
    } finally {
      if (server) await server.close();
      if (previousHome === undefined) delete process.env["PFORGE_HOME"];
      else process.env["PFORGE_HOME"] = previousHome;
    }
  });

  it("uses Pi effort capabilities in the catalog, actual requests, model preferences and restored transcripts", async () => {
    const root = await workspace(), home = process.env["PFORGE_HOME"]!;
    const requests: any[] = [];
    const upstream = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw); requests.push(input);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Effort reached the model.' }, null], [{}, 'stop']]) response.write('data: ' + JSON.stringify({ id: 'effort-test', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    closers.push(() => new Promise<void>((done) => { upstream.close(() => done()); upstream.closeAllConnections(); }));
    const allUnsupported = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
    await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port + '/v1', api: 'openai-completions', apiKey: 'isolated-test', models: [
      { id: 'ordinary-reasoner', reasoning: true },
      { id: 'strict-reasoner', reasoning: true, thinkingLevelMap: { ...allUnsupported, low: 'low', high: 'high' } },
      { id: 'text', reasoning: false },
      { id: 'extended', reasoning: true, thinkingLevelMap: { ...allUnsupported, high: 'high', xhigh: 'xhigh', max: 'max' } }
    ] } } }));
    let web = await startWebConsole({ cwd: root, port: 0 });
    closers.push(() => web.close());
    const api = async (path: string, input?: unknown) => {
      const response = await fetch(new URL(web.url).origin + '/api/' + path, { headers: { 'x-pforge-token': web.token, 'content-type': 'application/json' }, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const catalog = (await api('settings')).body.models;
    expect(catalog.find((model: any) => model.id === 'ordinary-reasoner').thinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(catalog.find((model: any) => model.id === 'strict-reasoner').thinkingLevels).toEqual(['low', 'high']);
    expect(catalog.find((model: any) => model.id === 'extended').thinkingLevels).toEqual(['high', 'xhigh', 'max']);
    expect(catalog.find((model: any) => model.id === 'text').thinkingLevels).toEqual(['off']);
    expect((await api('settings', { model: 'mock/strict-reasoner', thinkingLevel: 'high' })).body.thinkingLevel).toBe('high');
    expect((await api('settings', { model: 'mock/text' })).body.thinkingLevel).toBe('off');
    expect((await api('settings', { model: 'mock/strict-reasoner' })).body.thinkingLevel).toBe('high');
    await api('projects/trust', { path: root, trusted: true });
    const session = (await api('session', { project: root, model: 'mock/strict-reasoner', thinkingLevel: 'low', mode: 'ask' })).body;
    expect(session.thinkingLevel).toBe('low');
    for (const level of ['off', 'xhigh', 'max', 'invented']) expect((await api('sessions/' + session.id + '/thinking', { level })).status).toBe(400);
    expect((await api('sessions/' + session.id + '/thinking', { level: 'high', persist: true })).body.thinkingLevel).toBe('high');
    expect((await api('sessions/' + session.id + '/model', { model: 'mock/text' })).body.thinkingLevel).toBe('off');
    expect((await api('sessions/' + session.id + '/model', { model: 'mock/strict-reasoner' })).body.thinkingLevel).toBe('high');
    expect((await api('sessions/' + session.id + '/prompt', { message: 'Verify effort' })).status).toBe(202);
    let snapshot: any;
    await vi.waitFor(async () => { snapshot = (await api('sessions/' + session.id)).body; expect(snapshot.running).toBe(false); expect(snapshot.messages.some((message: any) => message.role === 'assistant')).toBe(true); }, { timeout: 15000 });
    expect(requests).toHaveLength(1);
    expect(requests[0].reasoning_effort).toBe('high');
    const sessionFile = snapshot.sessionFile;
    await api('sessions/' + session.id + '/thinking', { level: 'low' });
    await web.close(); web = await startWebConsole({ cwd: root, port: 0 });
    const restored = (await api('session', { project: root, sessionFile })).body;
    expect(restored).toMatchObject({ thinkingLevel: 'low', mode: 'ask' });
    expect((await api('session', { project: root, model: 'mock/strict-reasoner' })).body.thinkingLevel).toBe('high');
    const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    expect(settings).toMatchObject({ defaultThinkingLevel: 'high', modelThinkingLevels: { 'mock/strict-reasoner': 'high' } });
  }, 30000);

  it("runs a real Web session through Pi and reports verification", async () => {
    const provider = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw || "{}") as { model?: string };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write("data: " + JSON.stringify({ id: "web-mock", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: "Web task complete." } }] }) + "\n\n");
      response.write("data: " + JSON.stringify({ id: "web-mock", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }) + "\n\n");
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as AddressInfo).port;
    const root = await workspace();
    const home = await mkdtemp(join(tmpdir(), "pforge-web-e2e-home-"));
    await writeFile(join(home, "models.json"), JSON.stringify({
      providers: { mock: { baseUrl: "http://127.0.0.1:" + port + "/v1", api: "openai-completions", apiKey: "test", models: [{ id: "mock" }] } }
    }), "utf8");
    const previousHome = process.env["PFORGE_HOME"];
    process.env["PFORGE_HOME"] = home;
    let web: Awaited<ReturnType<typeof startWebConsole>> | undefined;
    try {
      web = await startWebConsole({ cwd: root, port: 0 });
      const base = web.url.split("?")[0];
      const headers = { "x-pforge-token": web.token };
      const trustResponse = await fetch(base + "api/projects/trust", { method: "POST", headers, body: JSON.stringify({ path: root, trusted: true }) });
      expect(trustResponse.status).toBe(200);
      const createdResponse = await fetch(base + "api/session", { method: "POST", headers, body: JSON.stringify({ project: root, model: "mock/mock" }) });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { id: string };
      const promptResponse = await fetch(base + "api/sessions/" + created.id + "/prompt", { method: "POST", headers, body: JSON.stringify({ message: "Finish the task" }) });
      expect(promptResponse.status).toBe(202);
      let latest: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const stateResponse = await fetch(base + "api/sessions/" + created.id + "/state", { headers });
        latest = await stateResponse.json();
        if (!latest.running && latest.messages?.some((message: any) => message.role === "assistant")) break;
      }
      expect(latest.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant" })]));
      expect(latest.verification.status, JSON.stringify(latest.verification)).toBe("passed");
    } finally {
      if (web) await web.close();
      if (previousHome === undefined) delete process.env["PFORGE_HOME"];
      else process.env["PFORGE_HOME"] = previousHome;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 30000);

});
