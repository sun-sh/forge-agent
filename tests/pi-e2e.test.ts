import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from 'node:util';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from "vitest";

async function run(verify: string) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!req.url?.includes("/chat/completions")) { res.writeHead(404).end(); return; }
    const payload = JSON.parse(body || "{}");
    requests.push(payload);
    const hasVerification = JSON.stringify(payload.messages || []).includes("run_verification");
    const message = { role: "assistant", content: hasVerification ? "Done." : "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: message }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const port = (server.address() as AddressInfo).port;
  const home = await mkdtemp(join(tmpdir(), "pforge-e2e-"));
  await mkdir(join(home, ".git"));
  await writeFile(join(home, "pforge.json"), JSON.stringify({ verify: [{ name: "verify", command: verify }], verifyRetries: 0 }), "utf8");
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "mock" }] } } }), "utf8");
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "pi-cli.js"), "--approve", "--model", "mock/mock", "-p", "Complete"], { cwd: home, env: { ...process.env, PFORGE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const status = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  await close();
  return { status, stdout, stderr, requests };
}

describe("pforge end-to-end", () => {
  it('exits nonzero for a timed-out configured check and prints its original output', async () => {
    const project = await mkdtemp(join(tmpdir(), 'forge-agent-check-timeout-')), home = await mkdtemp(join(tmpdir(), 'forge-agent-check-home-'));
    await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'timeout', command: 'node -e "process.stdout.write(\'cli-timeout-output\\n\'); setInterval(() => {}, 1000)"', timeoutMs: 3000 }], verifyRetries: 0 }));
    new ProjectTrustStore(home).set(project, true);
    const options = { cwd: project, env: { ...process.env, FORGE_AGENT_HOME: home, PFORGE_HOME: home }, windowsHide: true, timeout: 15000 };
    await expect(promisify(execFile)(process.execPath, [join(process.cwd(), 'dist', 'pi-cli.js'), 'check'], options)).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('cli-timeout-output\n') });
  });
  it('gates pforge check on Pi trust and never runs rejected project commands', async () => {
    const project = await mkdtemp(join(tmpdir(), 'pforge-check-trust-')), home = await mkdtemp(join(tmpdir(), 'pforge-check-home-'));
    await writeFile(join(project, 'pforge.json'), JSON.stringify({ verify: [{ name: 'trust-check', command: 'node -e "require(\'node:fs\').writeFileSync(\'marker\',\'yes\')"' }] }));
    const store = new ProjectTrustStore(home), execute = promisify(execFile);
    const options = { cwd: project, env: { ...process.env, PFORGE_HOME: home }, windowsHide: true, timeout: 15000 };
    store.set(project, false);
    await expect(execute(process.execPath, [join(process.cwd(), 'dist', 'pi-cli.js'), 'check'], options)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('not trusted') });
    await expect(access(join(project, 'marker'))).rejects.toThrow();
    store.set(project, true);
    await expect(execute(process.execPath, [join(process.cwd(), 'dist', 'pi-cli.js'), 'check'], options)).resolves.toMatchObject({ stdout: expect.stringContaining('PASS trust-check') });
    await expect(access(join(project, 'marker'))).resolves.toBeUndefined();
  });
  it("exits zero when verification passes", async () => {
    const result = await run("node --version");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Done.");
    const system = JSON.stringify(result.requests[0].messages.filter((message: any) => message.role === 'system'));
    expect(system).toContain('You are Forge Agent');
    expect(system).toContain('Pi Coding Agent runtime');
    expect(system).toContain('terminal client (interactive TUI or single-shot CLI)');
    expect(system).not.toContain('operating inside pi, a coding agent harness');
  }, 30000);

  it("exits nonzero when verification fails", async () => {
    const result = await run(process.platform === "win32" ? "exit /b 9" : "exit 9");
    expect(result.status).toBe(1);
  }, 30000);
});
