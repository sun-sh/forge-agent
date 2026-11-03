import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPforgeVerification, verificationOutcomeSchema } from "../src/verification/pi-extension.js";
import type { ExtensionAPI, AgentBeforeSettleEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (...args: any[]) => any;
afterEach(() => vi.unstubAllEnvs());

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: Array<{ message: string; type: string }> = [];
  const fake: { trusted: boolean } = { trusted: true };
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); }
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    isProjectTrusted: () => fake.trusted,
    signal: new AbortController().signal,
    ui: {
      notify(message: string, type: string) { notifications.push({ message, type }); },
      setStatus() {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined
    }
  } as unknown as ExtensionContext;
  return { pi, ctx, handlers, tools, commands, notifications, fake };
}

async function workspace(verify: Array<{ name: string; command: string; timeoutMs?: number }>, verifyRetries: number) {
  const root = await mkdtemp(join(tmpdir(), "pforge-pi-extension-"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "pforge.json"), JSON.stringify({ verify, verifyRetries }), "utf8");
  return root;
}

async function emit(fake: ReturnType<typeof fakePi>, name: string, event: any) {
  const results = [];
  for (const handler of fake.handlers.get(name) ?? []) results.push(await handler(event, fake.ctx));
  return results;
}

describe("Pi verification extension", () => {
  it("registers a verification tool and /verify command", async () => {
    const root = await workspace([{ name: "ok", command: "node --version" }], 1);
    const fake = fakePi();
    createPforgeVerification(root).extension(fake.pi);
    expect(fake.tools.has("run_verification")).toBe(true);
    expect(fake.commands.has("verify")).toBe(true);
  });

  it("blocks the tool, command, settle hook and explicit waiter in a read-only mode without claiming a pass", async () => {
    const root = await workspace([{ name: "ok", command: "node --version" }], 1);
    let reason: string | undefined = "Read-only planning mode";
    const runtime = createPforgeVerification(root, { executionBlockReason: () => reason });
    const fake = fakePi(); runtime.extension(fake.pi);
    await emit(fake, "before_agent_start", { messageType: "user" });
    const tool = await fake.tools.get("run_verification").execute("call", {}, undefined, undefined, fake.ctx);
    expect(tool).toMatchObject({ isError: true, details: { passed: false } });
    await fake.commands.get("verify").handler("", fake.ctx);
    expect((await emit(fake, "agent_before_settle", { outcome: "completed" }))[0]).toBeUndefined();
    expect(await runtime.waitForVerification()).toMatchObject({ status: "skipped", attempts: 0, reason });
    expect(runtime.outcome.report).toBeUndefined();
    reason = undefined;
    await emit(fake, "before_agent_start", { messageType: "user" });
    await emit(fake, "agent_before_settle", { outcome: "completed" });
    expect(runtime.outcome).toMatchObject({ status: "passed", attempts: 0 });
    expect(runtime.outcome.reason).toBeUndefined();
  });

  it("returns failure output to the model and continues until retry limit", async () => {
    const root = await workspace([{ name: "fail", command: process.platform === "win32" ? "echo BAD && exit /b 9" : "echo BAD; exit 9" }], 2);
    const runtime = createPforgeVerification(root);
    const fake = fakePi();
    runtime.extension(fake.pi);
    await emit(fake, "before_agent_start", { messageType: "user" });
    const event = { outcome: "completed" } as AgentBeforeSettleEvent;
    const first = await emit(fake, "agent_before_settle", event);
    expect(first[0]).toMatchObject({ continue: true });
    expect(first[0].entries[0].content).toContain("BAD");
    await emit(fake, "agent_start", {});
    const second = await emit(fake, "agent_before_settle", event);
    expect(second[0]).toMatchObject({ continue: true });
    await emit(fake, "agent_start", {});
    const third = await emit(fake, "agent_before_settle", event);
    expect(third[0]).toBeUndefined();
    expect(runtime.outcome).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("resets retries only for a new user prompt", async () => {
    const root = await workspace([{ name: "fail", command: process.platform === "win32" ? "exit /b 4" : "exit 4" }], 1);
    const runtime = createPforgeVerification(root);
    const fake = fakePi();
    runtime.extension(fake.pi);
    await emit(fake, "before_agent_start", { messageType: "user" });
    await emit(fake, "agent_before_settle", { outcome: "completed" });
    expect(runtime.outcome.attempts).toBe(1);
    await emit(fake, "agent_start", {});
    expect(runtime.outcome.attempts).toBe(1);
    await emit(fake, "before_agent_start", { messageType: "custom" });
    expect(runtime.outcome.attempts).toBe(1);
    await emit(fake, "before_agent_start", { messageType: "user" });
    expect(runtime.outcome.attempts).toBe(0);
  });

  it("passes and persists the latest report", async () => {
    const root = await workspace([{ name: "ok", command: "node --version" }], 1);
    const home = await mkdtemp(join(tmpdir(), "pforge-home-"));
    const previous = process.env['PFORGE_HOME'];
    process.env['PFORGE_HOME'] = home;
    try {
      const runtime = createPforgeVerification(root, { isProjectTrusted: () => true });
      const result = await runtime.waitForVerification();
      expect(result.status).toBe("passed");
      expect(result.report?.passed).toBe(true);
      const files = await import("node:fs/promises").then((fs) => fs.readdir(join(home, "verification")));
      expect(files).toHaveLength(1);
      const latest = JSON.parse(await readFile(join(home, "verification", files[0]!, "latest.json"), "utf8"));
      expect(latest.status).toBe("passed");
    } finally {
      if (previous === undefined) delete process.env['PFORGE_HOME'];
      else process.env['PFORGE_HOME'] = previous;
    }
  });

  it("does not run verification when the agent aborts", async () => {
    const root = await workspace([{ name: "ok", command: "node --version" }], 1);
    const runtime = createPforgeVerification(root);
    const fake = fakePi();
    runtime.extension(fake.pi);
    const result = await emit(fake, "agent_before_settle", { outcome: "aborted" });
    expect(result[0]).toBeUndefined();
    expect(runtime.outcome.status).toBe("unchecked");
  });

  it("refuses to run verification for an untrusted project", async () => {
    const root = await workspace([{ name: "ok", command: "node --version" }], 1);
    const runtime = createPforgeVerification(root);
    const fake = fakePi();
    fake.fake.trusted = false;
    runtime.extension(fake.pi);
    const result = await fake.tools.get("run_verification").execute("call", {}, undefined, undefined, fake.ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not trusted");
    expect(runtime.outcome.status).toBe("failed");
  });
  it('refuses a standalone waiter without an authoritative trust decision', async () => {
    const root = await workspace([{ name: 'unsafe', command: 'node --version' }], 0);
    const runtime = createPforgeVerification(root);
    expect(await runtime.waitForVerification()).toMatchObject({ status: 'failed', error: expect.stringContaining('not trusted') });
  });
  it('persists timeout evidence and returns exact output to bounded automatic repairs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-agent-timeout-home-'));
    vi.stubEnv('FORGE_AGENT_HOME', home);
    const root = await workspace([{ name: 'slow', command: 'node -e "process.stdout.write(\'timeout-output\\n\'); setInterval(() => {}, 1000)"', timeoutMs: 3000 }], 1);
    const observed: unknown[] = [];
    const runtime = createPforgeVerification(root, { onOutcome: (value) => observed.push(value) });
    const fake = fakePi(); runtime.extension(fake.pi);
    await emit(fake, 'before_agent_start', { messageType: 'user' });
    const first = await emit(fake, 'agent_before_settle', { outcome: 'completed' });
    expect(first[0]).toMatchObject({ continue: true });
    expect(first[0].entries[0].content).toContain('timeout-output\n');
    expect(first[0].entries[0].content).toContain('Command timed out after 3000ms');
    await emit(fake, 'before_agent_start', { messageType: 'custom' });
    expect((await emit(fake, 'agent_before_settle', { outcome: 'completed' }))[0]).toBeUndefined();
    expect(runtime.outcome).toMatchObject({ status: 'failed', attempts: 1, report: { passed: false, results: [{ failure: 'timeout', passed: false, output: 'timeout-output\n' }] } });
    const { readdir } = await import('node:fs/promises');
    const workspaceDir = join(home, 'verification', (await readdir(join(home, 'verification')))[0]!);
    const saved = verificationOutcomeSchema.parse(JSON.parse(await readFile(join(workspaceDir, runtime.outcome.evidenceId + '.json'), 'utf8')));
    expect(saved.report?.results[0]).toMatchObject({ failure: 'timeout', error: 'Command timed out after 3000ms', outputPath: expect.any(String) });
    expect(saved.attempts).toBe(1);
    expect(observed.length).toBeGreaterThan(2);
  });
  it('replaces stale passing evidence with the current interrupted report and persists it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-agent-interrupted-home-'));
    vi.stubEnv('FORGE_AGENT_HOME', home);
    const root = await workspace([{ name: 'check', command: 'node check.cjs' }], 1);
    await writeFile(join(root, 'check.cjs'), 'process.stdout.write("first-pass");');
    const runtime = createPforgeVerification(root, { isProjectTrusted: () => true });
    expect((await runtime.verifyTrusted(new AbortController().signal)).status).toBe('passed');
    await writeFile(join(root, 'check.cjs'), `process.stdout.write('interrupted-output\\n', () => require('node:fs').writeFileSync('ready', 'yes')); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = runtime.verifyTrusted(controller.signal).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => readFile(join(root, 'ready'), 'utf8'), { timeout: 10000 });
      expect(runtime.outcome.report).toBeUndefined();
      controller.abort(); await pending;
      expect(runtime.outcome).toMatchObject({ status: 'failed', attempts: 0, report: { passed: false, results: [{ failure: 'aborted', passed: false, output: 'interrupted-output\n' }] } });
      const { readdir } = await import('node:fs/promises');
      const workspaceDir = join(home, 'verification', (await readdir(join(home, 'verification')))[0]!);
      const saved = verificationOutcomeSchema.parse(JSON.parse(await readFile(join(workspaceDir, 'latest.json'), 'utf8')));
      expect(saved.report?.results[0]?.failure).toBe('aborted');
      expect(saved.report?.results[0]?.output).not.toContain('first-pass');
    } finally { controller.abort(); await pending; }
  });
  it('invalidates old success even if the next verification is cancelled before spawning', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-agent-cancelled-home-'));
    vi.stubEnv('FORGE_AGENT_HOME', home);
    const root = await workspace([{ name: 'check', command: 'node --version' }], 0);
    const runtime = createPforgeVerification(root, { isProjectTrusted: () => true });
    await runtime.verifyTrusted(new AbortController().signal);
    expect(runtime.outcome.status).toBe('passed');
    const controller = new AbortController(); controller.abort();
    await expect(runtime.verifyTrusted(controller.signal)).rejects.toThrow();
    expect(runtime.outcome.status).toBe('failed');
    expect(runtime.outcome.report).toBeUndefined();
  });
});
