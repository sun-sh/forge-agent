#!/usr/bin/env node
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const dist = join(root, "dist");
const demoRoot = join(root, ".pforge", "demo-console");
mkdirSync(demoRoot, { recursive: true });
writeFileSync(join(demoRoot, "greeting.ts"), "export const greeting = 'hello';\n", "utf8");
writeFileSync(join(demoRoot, "verify.cjs"), [
  "const fs = require('node:fs');",
  "const text = fs.readFileSync('greeting.ts', 'utf8');",
  "if (!text.includes(\"hello world\")) { console.error('greeting was not updated'); process.exit(1); }",
  "console.log('verification passed');"
].join("\n"), "utf8");
writeFileSync(join(demoRoot, "pforge.json"), JSON.stringify({ approvalMode: "ask", networkPolicy: "deny", verify: [{ name: "greeting-check", command: "node verify.cjs" }] }, null, 2), "utf8");
writeFileSync(join(demoRoot, "AGENTS.md"), "Keep the demo change small and verify it.\n", "utf8");

const tsc = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
mkdirSync(join(dist, "web", "ui"), { recursive: true });
cpSync(join(root, "src", "web", "ui"), join(dist, "web", "ui"), { recursive: true });
const child = spawn(process.execPath, [join(dist, "cli.js"), "--cwd", demoRoot, "ui", "--demo", "--port", "4317"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  const text = chunk.toString();
  const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
  if (match) {
    console.log(`Opening ${match[0]}`);
    if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", "", match[0]], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [match[0]], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [match[0]], { detached: true, stdio: "ignore" }).unref();
  }
});
const stop = () => { child.kill("SIGINT"); setTimeout(() => process.exit(0), 1000); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
