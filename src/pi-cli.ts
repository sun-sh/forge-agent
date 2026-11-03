#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main, VERSION as PI_VERSION, ProjectTrustStore, SettingsManager, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { startWebConsole } from "./web/server.js";
import { openLocalBrowser } from "./web/open-browser.js";
import { pforgeHome, configurePforgeEnvironment } from "./pforge-home.js";
import { loadConfig } from "./config.js";
import { createPforgeVerification } from "./verification/pi-extension.js";
import { runVerification, verificationMessage } from "./verification/verify.js";

export interface ParsedPforgeArgs {
  cwd: string;
  args: string[];
}

function packageVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return value.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function parsePforgeArgs(args: string[], base = process.cwd()): ParsedPforgeArgs {
  let cwd = resolve(base);
  const forwarded: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "-C" || value === "--cwd") {
      const next = args[++index];
      if (!next) throw new Error(`${value} requires a path`);
      cwd = resolve(base, next);
      continue;
    }
    if (value.startsWith("--cwd=")) {
      const next = value.slice("--cwd=".length);
      if (!next) throw new Error("--cwd requires a path");
      cwd = resolve(base, next);
      continue;
    }
    forwarded.push(value);
  }
  return { cwd, args: forwarded };
}

export function brandedVersion(): string {
  return `forge-agent ${packageVersion()} (Pi core ${PI_VERSION})`;
}

export function brandedHelp(): string {
  return [
    `Forge Agent ${packageVersion()} - local coding agent (Pi core ${PI_VERSION})`,
    "",
    "Usage:",
    "  forge-agent                     start the interactive TUI",
    "  forge-agent web [--no-open]      start the local Web client and open a browser",
    "  forge-agent [options] [prompt...] run with Pi options and a prompt",
    "  forge-agent -p <prompt>         single-shot mode",
    "  forge-agent doctor              check local configuration",
    "  forge-agent check               run configured verification only",
    "  forge-agent auth <command>      inspect provider authentication",
    "",
    "Common options:",
    "  -C, --cwd <path>               run in another workspace",
    "  --model <provider/model>       select a model",
    "  --thinking <level>             off, minimal, low, medium, high, xhigh, max",
    "  -c, --continue                 continue the latest session",
    "  -r, --resume                   choose a session to resume",
    "  --offline                      disable startup network operations",
    "  -h, --help                     show this help",
    "  -v, --version                  show version information",
    "",
    "In the TUI, use /login to configure a provider, /model to switch models, /settings for preferences, and /help for commands.",
    "Configuration: forge-agent.json verification commands; data: FORGE_AGENT_HOME (default ~/.forge-agent).",
    "Existing PFORGE_HOME, ~/.pforge data and pforge.json/yaml/yml configuration remain supported.",
    ""
  ].join("\n");
}

export function credentialStatus(home: string, env: NodeJS.ProcessEnv = process.env): { configured: boolean; detail: string } {
  const names = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "ZAI_API_KEY", "MOONSHOT_API_KEY"];
  const name = names.find((value) => Boolean(env[value]?.trim()));
  if (name) return { configured: true, detail: `environment (${name})` };
  const authPath = join(home, "auth.json");
  if (existsSync(authPath)) return { configured: true, detail: authPath };
  const modelsPath = join(home, "models.json");
  if (existsSync(modelsPath)) return { configured: true, detail: modelsPath };
  return { configured: false, detail: "not configured (start forge-agent, then use /login)" };
}

async function doctor(cwd: string, home: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const settingsPath = join(home, "settings.json");
  const credentials = credentialStatus(home);
  const checks: Array<[string, string, boolean]> = [
    ["Node", process.version, Number(process.versions.node.split(".")[0]) >= 22],
    ["Workspace", cwd, true],
    ["Data directory", home, true],
    ["Pi core", PI_VERSION, true],
    ["Settings", existsSync(settingsPath) ? "configured" : "defaults", true],
    ["Credentials", credentials.detail, credentials.configured],
    ["Forge Agent config", loaded.sources.length ? loaded.sources.join(", ") : "defaults", true],
    ["Verification", loaded.config.verify.length ? `${loaded.config.verify.length} command(s)` : "not configured", true]
  ];
  for (const [name, value, ok] of checks) process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}: ${value}\n`);
  for (const warning of loaded.warnings) process.stderr.write(`WARN ${warning}\n`);
  return checks.every(([, , ok]) => ok) ? 0 : 1;
}

async function check(cwd: string, home: string): Promise<number> {
  const trust = new ProjectTrustStore(home).get(cwd);
  const defaultTrust = SettingsManager.create(cwd, home, { projectTrusted: false }).getDefaultProjectTrust();
  const trusted = trust ?? (defaultTrust === 'always' || (defaultTrust !== 'never' && !hasTrustRequiringProjectResources(cwd)));
  if (!trusted) { process.stderr.write('Project is not trusted; refusing to run project verification commands.\n'); return 1; }
  const loaded = loadConfig(cwd);
  if (loaded.config.verify.length === 0) {
    process.stderr.write("No verification commands configured in forge-agent.json (or legacy pforge.json).\n");
    return 1;
  }
  const report = await runVerification(cwd, loaded.config.verify, new AbortController().signal, join(home, "verification"));
  process.stdout.write(`${verificationMessage(report)}\n`);
  return report.passed ? 0 : 1;
}

export async function runPforge(args = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedPforgeArgs;
  try {
    parsed = parsePforgeArgs(args);
  } catch (error) {
    process.stderr.write(`forge-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  process.chdir(parsed.cwd);
  const home = configurePforgeEnvironment();
  if (parsed.args.includes("-h") || parsed.args.includes("--help")) { process.stdout.write(brandedHelp() + "\n"); return; }
  if (parsed.args.includes("-v") || parsed.args.includes("--version")) { process.stdout.write(brandedVersion() + "\n"); return; }
  try {
    if (parsed.args[0] === "doctor") { process.exitCode = await doctor(parsed.cwd, home); return; }
    if (parsed.args[0] === "check") { process.exitCode = await check(parsed.cwd, home); return; }
    if (parsed.args[0] === "web") {
      const portIndex = parsed.args.indexOf("--port");
      const port = portIndex >= 0 ? Number(parsed.args[portIndex + 1]) : 4317;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
      const running = await startWebConsole({ cwd: parsed.cwd, port });
      const noOpen = parsed.args.includes("--no-open");
      const localUrl = new URL(running.url);
      localUrl.search = "";
      localUrl.hash = "";
      if (noOpen) {
        process.stdout.write(`forge-agent web: ${running.url}\n`);
      } else {
        try {
          await openLocalBrowser(running.url);
          process.stdout.write(`forge-agent web: ${localUrl.href}\n`);
          process.stdout.write("Forge Agent 已发送到默认浏览器；以后可直接使用这个本地地址。\n");
        } catch {
          process.stdout.write(`forge-agent web: ${localUrl.href}\n`);
          process.stderr.write("forge-agent: 无法打开默认浏览器，请检查系统设置，或使用 forge-agent web --no-open 手动打开。\n");
        }
      }
      process.stdout.write("Press Ctrl+C to stop.\n");
      await new Promise<void>((resolveShutdown) => {
        const shutdown = () => {
          process.removeListener("SIGINT", shutdown);
          process.removeListener("SIGTERM", shutdown);
          resolveShutdown();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      await running.close();
      return;
    }
  } catch (error) {
    process.stderr.write(`forge-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  let verification: ReturnType<typeof createPforgeVerification>;
  try {
    verification = createPforgeVerification(parsed.cwd);
  } catch (error) {
    process.stderr.write(`forge-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    await main(parsed.args, {
      extensionFactories: [{ name: "pforge-verification", factory: verification.extension }]
    });
    if (verification.outcome.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`forge-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1]?.replace(/\\/g, "/");
if (entry?.endsWith("/pi-cli.js") || entry?.endsWith("/pi-cli.ts")) {
  await runPforge();
}
