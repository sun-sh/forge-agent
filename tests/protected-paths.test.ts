import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { captureProtectedPaths, compareProtectedPaths } from '../src/verification/protected.js';
import { createPforgeVerification, isVerified, verificationOutcomeMessage, verificationOutcomeSchema } from '../src/verification/pi-extension.js';
import { verificationConfigHash } from '../src/verification/evidence.js';

afterEach(() => vi.unstubAllEnvs());
async function fixture(protect = ['tests', 'package-lock.json', 'absent.txt'], command = 'node --version') {
  const project = await mkdtemp(join(tmpdir(), 'forge-protect-project-')), home = await mkdtemp(join(tmpdir(), 'forge-protect-home-'));
  vi.stubEnv('FORGE_AGENT_HOME', home); vi.stubEnv('PFORGE_HOME', home);
  await mkdir(join(project, 'tests')); await writeFile(join(project, 'tests', 'existing.txt'), 'existing user edits\n');
  await writeFile(join(project, 'package-lock.json'), 'initial lock\n');
  await writeFile(join(project, 'forge-agent.json'), JSON.stringify({ protect, verify: [{ name: 'check', command }], verifyRetries: 1 }));
  const runtime = createPforgeVerification(project, { isProjectTrusted: () => true });
  return { project, home, runtime, signal: new AbortController().signal };
}
describe('protected-path delivery gate', () => {
  it('accepts literal files/directories, normalizes separators and binds rules into verification evidence', async () => {
    const f = await fixture(['tests\\existing.txt', './package-lock.json']);
    expect(loadConfig(f.project).config.protect).toEqual(['tests/existing.txt', 'package-lock.json']);
    expect(verificationConfigHash([], ['tests'])).not.toBe(verificationConfigHash([], []));
    expect(verificationConfigHash([], ['tests', 'package-lock.json'])).toBe(verificationConfigHash([], ['package-lock.json', 'tests']));
  });
  it.each(['', '.', '..', '../secret', 'tests/../secret', '/absolute', 'C:\\secret', 'C:secret', '\\\\server\\share', '.git/config', '.GIT/config', '.git./config', 'file:stream', 'tests/**', 'tests\0bad', 'tests//file'])('rejects unsafe or nonliteral configuration: %j', async (path) => {
    const f = await fixture(); await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ protect: [path] }));
    expect(() => loadConfig(f.project)).toThrow('protect');
  });
  it('uses the pre-execution content including dirty user edits; passing commands cannot hide later test and lock edits', async () => {
    const f = await fixture(); f.runtime.beginTurn(); await f.runtime.prepareTurn(f.signal);
    await writeFile(join(f.project, 'tests', 'existing.txt'), 'model weakened test');
    await writeFile(join(f.project, 'package-lock.json'), 'changed lock');
    const outcome = await f.runtime.verifyTrusted(f.signal);
    expect(outcome).toMatchObject({ status: 'failed', report: { passed: true }, protection: { status: 'changed', changes: [{ path: 'package-lock.json', kind: 'modified' }, { path: 'tests', kind: 'modified' }] } });
    expect(isVerified(outcome)).toBe(false); expect(verificationOutcomeMessage(outcome)).toContain('package-lock.json');
    expect(JSON.stringify(outcome.protection)).not.toContain('model weakened test');
    expect(verificationOutcomeSchema.parse(outcome).protection).toEqual(outcome.protection);
    // Automatic repairs keep the original baseline; only restoring those exact bytes can pass.
    await f.runtime.prepareTurn(f.signal); await f.runtime.verifyTrusted(f.signal); expect(isVerified(outcome)).toBe(false);
    await writeFile(join(f.project, 'tests', 'existing.txt'), 'existing user edits\n');
    await writeFile(join(f.project, 'package-lock.json'), 'initial lock\n');
    await f.runtime.verifyTrusted(f.signal); expect(isVerified(outcome)).toBe(true);
    const dirs = await (await import('node:fs/promises')).readdir(join(f.home, 'verification'));
    const saved = verificationOutcomeSchema.parse(JSON.parse(await readFile(join(f.home, 'verification', dirs[0]!, 'latest.json'), 'utf8')));
    expect(saved.protection?.status).toBe('unchanged');
  });
  it('detects additions, deletion, nested edits and a verification command that modifies a protected file', async () => {
    const f = await fixture(); const paths = loadConfig(f.project).config.protect;
    const before = await captureProtectedPaths(f.project, paths);
    await mkdir(join(f.project, 'tests', 'nested')); await writeFile(join(f.project, 'tests', 'nested', 'new.txt'), 'new test');
    await rm(join(f.project, 'package-lock.json')); await writeFile(join(f.project, 'absent.txt'), 'created');
    expect(compareProtectedPaths(before, await captureProtectedPaths(f.project, paths))).toMatchObject({ status: 'changed', changes: [{ path: 'absent.txt', kind: 'added' }, { path: 'package-lock.json', kind: 'removed' }, { path: 'tests', kind: 'modified' }] });
    const mutating = await fixture(['package-lock.json'], 'node -e "require(\'node:fs\').writeFileSync(\'package-lock.json\', \'different\');process.stdout.write(\'exact-check-output\')"');
    const outcome = await mutating.runtime.verifyTrusted(mutating.signal);
    expect(outcome.status).toBe('failed'); expect(outcome.report?.results[0]?.output).toBe('exact-check-output');
    expect(outcome.protection?.status).toBe('changed'); expect(isVerified(outcome)).toBe(false);
  });
  it('rechecks protected paths excluded from workspace observations after restore', async () => {
    const f = await fixture(['.env']); await writeFile(join(f.project, '.env'), 'LOCAL_PRIVATE_VALUE');
    await f.runtime.verifyTrusted(f.signal); expect(isVerified(f.runtime.outcome)).toBe(true);
    const saved = structuredClone(f.runtime.outcome);
    await writeFile(join(f.project, '.env'), 'CHANGED_PRIVATE_VALUE');
    const restored = createPforgeVerification(f.project, { initialOutcome: saved, isProjectTrusted: () => true });
    await restored.refreshEvidence();
    expect(restored.outcome.status).toBe('failed'); expect(restored.outcome.protection?.status).toBe('changed'); expect(isVerified(restored.outcome)).toBe(false);
    expect(JSON.stringify(restored.outcome.protection)).not.toContain('PRIVATE_VALUE');
  });
  it('persists the execution baseline before tools and reuses it after an interrupted turn', async () => {
    const f = await fixture(); f.runtime.beginTurn(); await f.runtime.prepareTurn(f.signal);
    const dirs = await (await import('node:fs/promises')).readdir(join(f.home, 'verification'));
    const saved = verificationOutcomeSchema.parse(JSON.parse(await readFile(join(f.home, 'verification', dirs[0]!, 'latest.json'), 'utf8')));
    expect(saved).toMatchObject({ status: 'unchecked', protection: { status: 'unchanged' } });
    await writeFile(join(f.project, 'package-lock.json'), 'post-crash edit');
    const restored = createPforgeVerification(f.project, { initialOutcome: saved, isProjectTrusted: () => true });
    await restored.prepareTurn(f.signal); await restored.verifyTrusted(f.signal);
    expect(restored.outcome).toMatchObject({ status: 'failed', protection: { status: 'changed' } });
  });
  it('preserves protection and retry count when the user continues an interrupted execution', async () => {
    const f = await fixture(); f.runtime.beginTurn(); await f.runtime.prepareTurn(f.signal);
    f.runtime.outcome.attempts = 1;
    const previous = structuredClone(f.runtime.outcome);
    await writeFile(join(f.project, 'package-lock.json'), 'changed before continuation');
    f.runtime.beginTurn(undefined, previous);
    expect(f.runtime.outcome.attempts).toBe(1);
    await f.runtime.verifyTrusted(f.signal);
    expect(f.runtime.outcome).toMatchObject({ status: 'failed', protection: { status: 'changed', baseline: previous.protection?.baseline } });
  });
  it('blocks delivery without verification commands and never labels unchanged protection as verified', async () => {
    const f = await fixture(['tests']);
    await writeFile(join(f.project, 'forge-agent.json'), JSON.stringify({ protect: ['tests'], verify: [] }));
    f.runtime.reload(); await f.runtime.prepareTurn(f.signal); await f.runtime.verifyTrusted(f.signal);
    expect(f.runtime.outcome).toMatchObject({ status: 'skipped', protection: { status: 'unchanged' } });
    expect(isVerified(f.runtime.outcome)).toBe(false);
    await writeFile(join(f.project, 'tests', 'existing.txt'), 'changed'); await f.runtime.verifyTrusted(f.signal);
    expect(f.runtime.outcome).toMatchObject({ status: 'failed', protection: { status: 'changed' } });
  });
  it('refuses symlink ancestors, nested links and oversized files without following them', async () => {
    const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'forge-protect-outside-'));
    await writeFile(join(outside, 'private.txt'), 'never expose');
    await symlink(outside, join(f.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['linked/private.txt', 'linked']) expect(await captureProtectedPaths(f.project, [path])).toMatchObject({ complete: false, reason: expect.stringContaining('links') });
    await symlink(outside, join(f.project, 'tests', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await captureProtectedPaths(f.project, ['tests'])).complete).toBe(false);
    const handle = await open(join(f.project, 'large'), 'w'); await handle.truncate(257 * 1024 * 1024); await handle.close();
    expect(await captureProtectedPaths(f.project, ['large'])).toMatchObject({ complete: false, reason: expect.stringContaining('byte limit') });
  });
});
