#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
cpSync(join(root, 'src', 'web', 'ui'), join(root, 'dist', 'web', 'ui'), { recursive: true });
