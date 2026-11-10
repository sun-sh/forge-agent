#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const node = process.execPath;
const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const checks = [
  ["typecheck", [node, tsc, "-p", "tsconfig.json", "--noEmit"]],
  ["build", [node, join(process.cwd(), "scripts", "build.mjs")]],
  ["tests", [node, vitest, "run", "--reporter=dot"]],
  ["version", [node, join(process.cwd(), "dist", "pi-cli.js"), "--version"]],
  ["help", [node, join(process.cwd(), "dist", "pi-cli.js"), "--help"]]
];
let failed = false;
for (const [name, args] of checks) {
  process.stdout.write(`\n== ${name} ==\n`);
  try {
    execFileSync(args[0], args.slice(1), { stdio: "inherit", cwd: process.cwd() });
  } catch {
    failed = true;
  }
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, path] of Object.entries(pkg.bin ?? {})) {
  const exists = existsSync(path.replace(/^\.\//, ""));
  process.stdout.write(`${exists ? "PASS" : "FAIL"} bin ${name} -> ${path}\n`);
  if (!exists) failed = true;
}
process.exitCode = failed ? 1 : 0;
