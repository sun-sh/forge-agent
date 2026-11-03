import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { brandedHelp, brandedVersion, credentialStatus, parsePforgeArgs } from "../src/pi-cli.js";
import { pforgeHome, configurePforgeEnvironment } from "../src/pforge-home.js";
import { localBrowserCommand } from "../src/web/open-browser.js";

afterEach(() => vi.unstubAllEnvs());

describe("Forge Agent CLI helpers", () => {
  it("parses and strips cwd options", () => {
    const root = join(tmpdir(), "pforge-cli");
    expect(parsePforgeArgs(["-C", "repo", "--model", "mock/test", "-p", "hello"], root)).toEqual({
      cwd: join(root, "repo"),
      args: ["--model", "mock/test", "-p", "hello"]
    });
    expect(parsePforgeArgs(["--cwd=repo", "doctor"], root)).toEqual({
      cwd: join(root, "repo"),
      args: ["doctor"]
    });
  });

  it("rejects a missing cwd value", () => {
    expect(() => parsePforgeArgs(["--cwd"])).toThrow("requires a path");
  });

  it("uses PFORGE_HOME as Pi's agent and session directories", () => {
    vi.stubEnv('FORGE_AGENT_HOME', undefined);
    vi.stubEnv('PFORGE_HOME', join(tmpdir(), "pforge-home-cli"));
    vi.stubEnv('PI_CODING_AGENT_DIR', undefined);
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined);
    const home = configurePforgeEnvironment();
    expect(home).toBe(pforgeHome());
    expect(process.env['PI_CODING_AGENT_DIR']).toBe(home);
    expect(process.env['PI_CODING_AGENT_SESSION_DIR']).toBe(join(home, "sessions"));
  });

  it("prefers FORGE_AGENT_HOME while keeping Pi and legacy consumers on the same directory", () => {
    const home = join(tmpdir(), 'forge-agent-home-cli');
    vi.stubEnv('FORGE_AGENT_HOME', home);
    vi.stubEnv('PFORGE_HOME', join(tmpdir(), 'old-forge-home'));
    vi.stubEnv('PI_CODING_AGENT_DIR', undefined);
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined);
    expect(configurePforgeEnvironment()).toBe(home);
    expect(process.env['PFORGE_HOME']).toBe(home);
    expect(process.env['PI_CODING_AGENT_DIR']).toBe(home);
    expect(process.env['PI_CODING_AGENT_SESSION_DIR']).toBe(join(home, 'sessions'));
  });

  it("reuses existing legacy data without copying credentials and prefers an existing new home", async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'forge-agent-home-selection-'));
    const current = join(userHome, '.forge-agent'), legacy = join(userHome, '.pforge');
    expect(pforgeHome({}, userHome)).toBe(current);
    await mkdir(legacy);
    expect(pforgeHome({}, userHome)).toBe(legacy);
    await mkdir(current);
    expect(pforgeHome({}, userHome)).toBe(current);
    expect(pforgeHome({ PFORGE_HOME: legacy }, userHome)).toBe(legacy);
    expect(pforgeHome({ FORGE_AGENT_HOME: current, PFORGE_HOME: legacy }, userHome)).toBe(current);
  });

  it("loads new project configuration ahead of its legacy alias and honors the new global home", async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-agent-config-'));
    const home = await mkdtemp(join(tmpdir(), 'forge-agent-config-home-'));
    vi.stubEnv('FORGE_AGENT_HOME', home);
    await writeFile(join(home, 'config.json'), JSON.stringify({ verify: [], verifyRetries: 1 }));
    expect(loadConfig(root).config.verifyRetries).toBe(1);
    await writeFile(join(root, 'pforge.json'), JSON.stringify({ verifyRetries: 2 }));
    await writeFile(join(root, 'forge-agent.json'), JSON.stringify({ verifyRetries: 3 }));
    expect(loadConfig(root).config.verifyRetries).toBe(3);
  });

  it("reports credentials without exposing their values", async () => {
    const home = await mkdtemp(join(tmpdir(), "pforge-credentials-"));
    expect(credentialStatus(home, {})).toMatchObject({ configured: false });
    await writeFile(join(home, "auth.json"), "{}", "utf8");
    expect(credentialStatus(home, {})).toMatchObject({ configured: true, detail: join(home, "auth.json") });
    expect(credentialStatus(home, { OPENAI_API_KEY: "secret" })).toEqual({ configured: true, detail: "environment (OPENAI_API_KEY)" });
  });

  it("has branded help and version output", () => {
    expect(brandedVersion()).toMatch(/^forge-agent \d+\.\d+\.\d+ \(Pi core 1\.4\.0\)$/);
    expect(brandedHelp()).toContain("forge-agent");
    expect(brandedHelp()).toContain("/login");
    expect(brandedHelp()).toContain("--no-open");
  });

  it("only constructs browser launches for local Web addresses", () => {
    expect(localBrowserCommand("http://127.0.0.1:4328/?token=test", "win32")).toMatchObject({
      args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4328/?token=test"]
    });
    for (const address of ["https://example.com", "file:///C:/Windows", "http://user:password@localhost:4328", "http://localhost.evil.example:4328"]) {
      expect(() => localBrowserCommand(address)).toThrow("plain local Web address");
    }
    expect(localBrowserCommand("http://[::1]:4328/", "darwin").args).toEqual(["http://[::1]:4328/"]);
  });
  it.each(['pforge.json', 'forge-agent.json'])("rejects unknown configuration keys in %s", async (filename) => {
    const root = await mkdtemp(join(tmpdir(), "pforge-strict-config-"));
    await writeFile(join(root, filename), JSON.stringify({ verify: [], sandboxMode: "workspace" }), "utf8");
    expect(() => loadConfig(root)).toThrow(/Unrecognized key/);
  });

});
