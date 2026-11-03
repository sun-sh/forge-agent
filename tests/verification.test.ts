import { access, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVerification, verificationMessage } from "../src/verification/verify.js";

describe("verification", () => {
  it('does not launch a command when its signal was already cancelled', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pforge-cancelled-')));
    const controller = new AbortController(); controller.abort();
    await expect(runVerification(root, [{ name: 'side-effect', command: 'node -e "require(\'node:fs\').writeFileSync(\'marker\',\'bad\')"' }], controller.signal, join(root, 'logs'))).rejects.toThrow();
    await expect(access(join(root, 'marker'))).rejects.toThrow();
  });
  it("passes when all configured commands pass", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-verify-")));
    const report = await runVerification(root, [{ name: "node-version", command: "node --version" }], new AbortController().signal, join(root, "logs"));
    expect(report.passed).toBe(true);
    expect(report.results[0]).toMatchObject({ name: "node-version", command: "node --version", passed: true, exitCode: 0 });
  });

  it("fails fast and preserves failure output", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-verify-")));
    const command = process.platform === "win32" ? "exit /b 7" : "exit 7";
    const report = await runVerification(root, [{ name: "fail", command }, { name: "not-run", command: "node --version" }], new AbortController().signal, join(root, "logs"));
    expect(report.passed).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.exitCode).toBe(7);
  });

  it("does not claim success without configured commands", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-verify-")));
    const report = await runVerification(root, [], new AbortController().signal, join(root, "logs"));
    expect(report.passed).toBe(false);
    expect(report.summary).toMatch(/No verification/);
  });

  it("returns long failure output verbatim instead of silently clipping it at the preview limit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-verify-")));
    const command = 'node -e "process.stdout.write(\'start:\' + \'界\'.repeat(30000) + \':end\'); process.exitCode = 7"';
    const report = await runVerification(root, [{ name: "long", command }], new AbortController().signal, join(root, "logs"));
    const expected = 'start:' + '界'.repeat(30000) + ':end';
    expect(report.results[0]).toMatchObject({ command, exitCode: 7 });
    expect(report.results[0]!.output === expected).toBe(true);
    expect(verificationMessage(report).endsWith(expected)).toBe(true);
  });

  it("preserves both streams when their combined output exceeds the preview limit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-verify-")));
    const command = 'node -e "process.stdout.write(\'a\'.repeat(50000)); process.stderr.write(\'b\'.repeat(50000)); process.exitCode = 8"';
    const report = await runVerification(root, [{ name: "combined", command }], new AbortController().signal, join(root, "logs"));
    expect(report.passed).toBe(false);
    const output = report.results[0]!.output;
    expect(output.length).toBe(100000);
    expect(output.replaceAll('a', '')).toBe('b'.repeat(50000));
    expect(output.replaceAll('b', '')).toBe('a'.repeat(50000));
  });
});
