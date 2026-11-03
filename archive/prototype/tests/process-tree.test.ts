import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCommand } from "../src/tools/command.js";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("command process-tree timeout", () => {
  it("kills a spawned descendant on timeout", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-kill-")));
    const pidFile = join(root, "pid.txt");
    const childScript = join(root, "child.cjs");
    await import("node:fs/promises").then((fs) => fs.writeFile(childScript, "setInterval(() => {}, 1000);\n"));
    const command = process.platform === "win32"
      ? `start /b node "${childScript}" & echo %ERRORLEVEL% > "${pidFile}"`
      : `node "${childScript}" & echo $! > "${pidFile}"; wait`;
    let resultError: unknown;
    try {
      await executeCommand({ command, cwd: root, timeoutMs: 250, signal: new AbortController().signal, outputDir: join(root, "logs"), outputId: "kill" });
    } catch (error) { resultError = error; }
    expect(String(resultError)).toMatch(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const raw = await readFile(pidFile, "utf8").catch(() => "");
    const pid = Number(raw.trim());
    if (Number.isFinite(pid) && pid > 0) expect(alive(pid)).toBe(false);
  }, 10_000);
});
