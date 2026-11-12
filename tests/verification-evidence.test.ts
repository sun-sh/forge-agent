import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, open, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkspace, revalidateEvidence, verificationConfigHash } from '../src/verification/evidence.js';
import { createPforgeVerification, isVerified, verificationOutcomeSchema } from '../src/verification/pi-extension.js';

afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'forge-evidence-project-'));
  const home = await mkdtemp(join(tmpdir(), 'forge-evidence-home-'));
  vi.stubEnv('FORGE_AGENT_HOME', home); vi.stubEnv('PFORGE_HOME', home);
  await writeFile(join(project, 'code.txt'), 'before\n');
  await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'check', command: 'node --version' }], verifyRetries: 2 }));
  const runtime = createPforgeVerification(project, { isProjectTrusted: () => true });
  return { project, home, runtime, signal: new AbortController().signal };
}

describe('versioned verification evidence', () => {
  it('binds a passed report to source content, preserves raw output and invalidates changes even when timestamps are restored', async () => {
    const f = await fixture(); await f.runtime.verifyTrusted(f.signal);
    expect(isVerified(f.runtime.outcome)).toBe(true);
    const original = structuredClone(f.runtime.outcome); const oldTime = new Date(1_700_000_000_000);
    expect(isVerified({ ...original, evidence: { ...original.evidence!, workspace: { version: 1, scope: 'directory', files: 0 } } })).toBe(false);
    await writeFile(join(f.project, 'code.txt'), 'after!\n'); await utimes(join(f.project, 'code.txt'), oldTime, oldTime);
    await f.runtime.refreshEvidence();
    expect(f.runtime.outcome).toMatchObject({ status: 'passed', report: original.report, evidenceId: original.evidenceId, attempts: 0, evidence: { freshness: 'stale' } });
    expect(isVerified(f.runtime.outcome)).toBe(false);
    await writeFile(join(f.project, 'code.txt'), 'before\n');
    await f.runtime.refreshEvidence(); expect(f.runtime.outcome.evidence?.freshness).toBe('stale');
    expect(verificationOutcomeSchema.parse(f.runtime.outcome).report).toEqual(original.report);
    await f.runtime.verifyTrusted(f.signal); expect(isVerified(f.runtime.outcome)).toBe(true);
    expect(f.runtime.outcome.evidenceId).not.toBe(original.evidenceId);
  });
  it('invalidates explicit host mutations without erasing report output, run id or retry state, and persists it', async () => {
    const f = await fixture(); await f.runtime.verifyTrusted(f.signal); f.runtime.outcome.attempts = 2;
    const original = structuredClone(f.runtime.outcome);
    await f.runtime.invalidate('恢复检查点');
    expect(f.runtime.outcome).toMatchObject({ status: 'passed', report: original.report, runId: original.runId, attempts: 2, evidence: { freshness: 'stale', reason: '恢复检查点' } });
    const directories = await (await import('node:fs/promises')).readdir(join(f.home, 'verification'));
    const saved = JSON.parse(await readFile(join(f.home, 'verification', directories[0]!, 'latest.json'), 'utf8'));
    expect(saved.evidence.freshness).toBe('stale');
  });
  it('checks the current command configuration and treats legacy reports as unconfirmed on restore', async () => {
    const f = await fixture(); await f.runtime.verifyTrusted(f.signal);
    const old = structuredClone(f.runtime.outcome); delete old.evidence;
    const restored = createPforgeVerification(f.project, { initialOutcome: old, isProjectTrusted: () => true });
    await restored.refreshEvidence(); expect(restored.outcome.evidence?.freshness).toBe('unconfirmed');
    await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'different', command: 'node -v' }] }));
    await f.runtime.refreshEvidence();
    expect(f.runtime.outcome.evidence).toMatchObject({ freshness: 'stale', reason: expect.stringContaining('配置') });
  });
  it('never certifies a source version changed by a passing verification command', async () => {
    const f = await fixture();
    await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ verify: [{ name: 'mutating', command: 'node -e "require(\'node:fs\').writeFileSync(\'code.txt\', \'after\\n\'); console.log(\'exact-output\')"' }] }));
    f.runtime.reload(); await f.runtime.verifyTrusted(f.signal);
    expect(f.runtime.outcome.report?.passed).toBe(true); expect(f.runtime.outcome.report?.results[0]?.output).toContain('exact-output');
    expect(f.runtime.outcome.evidence?.freshness).toBe('unconfirmed'); expect(isVerified(f.runtime.outcome)).toBe(false);
  });
  it('covers files beyond the diff display cap, staged content, ignored outputs and new/deleted paths in Git projects', async () => {
    const f = await fixture(); const run = promisify(execFile);
    const git = (...args: string[]) => run('git', args, { cwd: f.project, windowsHide: true });
    await git('init', '-q'); await writeFile(join(f.project, '.gitignore'), 'generated/\n');
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(f.project, `file-${index}.txt`), 'source')));
    await git('add', '.'); const first = await captureWorkspace(f.project);
    expect(first.scope).toBe('git'); expect(first.files).toBeGreaterThan(200); expect(first.digest).toBeDefined();
    await writeFile(join(f.project, 'file-204.txt'), 'changed'); const second = await captureWorkspace(f.project);
    expect(second.digest).not.toBe(first.digest);
    await git('add', 'file-204.txt'); const staged = await captureWorkspace(f.project); expect(staged.digest).not.toBe(second.digest);
    await mkdir(join(f.project, 'generated')); await writeFile(join(f.project, 'generated', 'output'), 'ignored build output');
    expect((await captureWorkspace(f.project)).digest).toBe(staged.digest);
    await writeFile(join(f.project, 'new-file.txt'), 'new'); expect((await captureWorkspace(f.project)).digest).not.toBe(staged.digest);
  });
  it('records tracked symlinks in Git scope without following their targets', async () => {
    const f = await fixture(); const run = promisify(execFile);
    const git = (...args: string[]) => run('git', args, { cwd: f.project, windowsHide: true });
    await git('init', '-q'); await writeFile(join(f.project, 'target.txt'), 'target');
    try { await symlink('target.txt', join(f.project, 'link.txt'), process.platform === 'win32' ? 'file' : undefined); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await git('add', '.'); const stamp = await captureWorkspace(f.project);
    expect(stamp.scope).toBe('git'); expect(stamp.digest).toBeDefined();
  });
  it('records Git submodule entries as gitlinks without entering the nested repository', async () => {
    const f = await fixture(); const run = promisify(execFile);
    const git = (...args: string[]) => run('git', args, { cwd: f.project, windowsHide: true });
    await git('init', '-q'); await mkdir(join(f.project, 'nested')); await writeFile(join(f.project, 'nested', 'ignored.txt'), 'nested');
    await git('update-index', '--add', '--cacheinfo', '160000,' + 'a'.repeat(40) + ',nested');
    const stamp = await captureWorkspace(f.project);
    expect(stamp.scope).toBe('git'); expect(stamp.digest).toBeDefined();
  });
  it('does not attest a non-Git directory containing a nested repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-evidence-parent-')), nested = join(root, 'nested');
    await mkdir(nested);
    await promisify(execFile)('git', ['init', '-q'], { cwd: nested, windowsHide: true });
    await writeFile(join(nested, 'code.txt'), 'nested source');
    const stamp = await captureWorkspace(root);
    expect(stamp.scope).toBe('directory'); expect(stamp.digest).toBeUndefined();
    expect(stamp.reason).toContain('nested repositories');
  });
  it('fails closed on oversized files and linked directories, and excludes credentials and local state', async () => {
    const f = await fixture(); const initial = await captureWorkspace(f.project);
    await writeFile(join(f.project, '.env'), 'LOCAL-SECRET-DO-NOT-EXPOSE');
    await mkdir(join(f.project, '.forge-agent')); await writeFile(join(f.project, '.forge-agent', 'state.json'), '{}');
    expect((await captureWorkspace(f.project)).digest).toBe(initial.digest);
    const large = await open(join(f.project, 'oversized.bin'), 'w'); await large.truncate(257 * 1024 * 1024); await large.close();
    const oversized = await captureWorkspace(f.project);
    expect(oversized.digest).toBeUndefined(); expect(oversized.reason).toContain('byte limit');
    const linkedRoot = await mkdtemp(join(tmpdir(), 'forge-evidence-links-'));
    await symlink(f.project, join(linkedRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await captureWorkspace(linkedRoot)).digest).toBeUndefined();
    expect(revalidateEvidence({ workspace: initial, configHash: verificationConfigHash([]), freshness: 'current' }, { version: 1, scope: 'directory', files: 0, reason: 'unreadable' }, verificationConfigHash([])).freshness).toBe('unconfirmed');
  });
});
