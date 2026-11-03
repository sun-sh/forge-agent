import { access, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVerification, verificationMessage, VerificationInterruptedError } from "../src/verification/verify.js";
import { CommandExecutionError, executeCommand } from "../src/tools/command.js";

afterEach(() => vi.unstubAllEnvs());

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

  it('returns timeout evidence and exact long output, stops later checks, and terminates descendants', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-agent-timeout-')));
    const expected = 'start:' + '界'.repeat(30000) + ':end\n';
    await writeFile(join(root, 'child.cjs'), 'setInterval(() => {}, 1000);');
    await writeFile(join(root, 'check.cjs'), `const fs = require('node:fs'); const child = require('node:child_process').spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' }); child.once('spawn', () => { fs.writeFileSync('descendant.pid', String(child.pid)); process.stdout.write(${JSON.stringify(expected)}); process.stderr.write('stderr:diagnostic\\n'); }); setInterval(() => {}, 1000);`);
    try {
      const report = await runVerification(root, [{ name: 'timeout', command: 'node check.cjs', timeoutMs: 3500 }, { name: 'never', command: 'node -e "require(\'node:fs\').writeFileSync(\'later\',\'bad\')"' }], new AbortController().signal, join(root, 'logs'));
      expect(report.passed).toBe(false);
      expect(report.results).toHaveLength(1);
      expect(report.results[0]).toMatchObject({ passed: false, failure: 'timeout', error: 'Command timed out after 3500ms', outputPath: expect.any(String) });
      expect(report.results[0]!.output).toContain(expected);
      expect(report.results[0]!.output).toContain('stderr:diagnostic\n');
      expect(await readFile(report.results[0]!.outputPath!, 'utf8')).toBe(report.results[0]!.output);
      expect(verificationMessage(report)).toContain(expected);
      await expect(access(join(root, 'later'))).rejects.toThrow();
      const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
      await vi.waitFor(async () => {
        let active = true;
        try { process.kill(pid, 0); if (process.platform === 'linux') active = !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z '); }
        catch { active = false; }
        expect(active).toBe(false);
      }, { timeout: 5000 });
    } finally {
      try { process.kill(Number(await readFile(join(root, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch { /* Already terminated. */ }
    }
  });

  it('keeps cancellation output as interrupted evidence without starting the next command', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-agent-interrupted-')));
    await writeFile(join(root, 'check.cjs'), `process.stdout.write('partial-output\\n', () => { require('node:fs').writeFileSync('ready', 'yes'); }); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = runVerification(root, [{ name: 'cancel', command: 'node check.cjs' }, { name: 'never', command: 'node -e "require(\'node:fs\').writeFileSync(\'later\',\'bad\')"' }], controller.signal, join(root, 'logs')).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => access(join(root, 'ready')), { timeout: 10000 });
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(VerificationInterruptedError);
      const report = (error as VerificationInterruptedError).report;
      expect(report).toMatchObject({ passed: false, results: [{ passed: false, failure: 'aborted', output: 'partial-output\n' }] });
      await expect(access(join(root, 'later'))).rejects.toThrow();
    } finally { controller.abort(); await pending; }
  });

  it('keeps the command executor rejection contract with structured timeout diagnostics', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-agent-command-error-')));
    const error: unknown = await executeCommand({ command: 'node -e "process.stdout.write(\'before-timeout\'); setInterval(() => {}, 1000)"', cwd: root, timeoutMs: 3000, signal: new AbortController().signal, outputDir: join(root, 'logs'), outputId: 'timeout' }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect((error as CommandExecutionError).result).toMatchObject({ failure: 'timeout', combined: 'before-timeout', outputPath: expect.any(String) });
  });
  it('records a shell spawn error as a failed check rather than losing its diagnostics', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-agent-spawn-error-')));
    vi.stubEnv(process.platform === 'win32' ? 'ComSpec' : 'SHELL', join(root, 'missing-shell'));
    const report = await runVerification(root, [{ name: 'spawn', command: 'node --version' }], new AbortController().signal, join(root, 'logs'));
    expect(report.passed).toBe(false);
    expect(report.results[0]).toMatchObject({ failure: 'spawn_error', passed: false, exitCode: null, error: expect.stringContaining('ENOENT'), outputPath: expect.any(String) });
    expect(verificationMessage(report)).toContain('ENOENT');
  });
});
