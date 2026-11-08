import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceMetadataFile } from '../src/task/persistence.js';

describe('atomic host metadata replacement', () => {
  it('preserves the existing file during transient Windows sharing failures, then replaces it atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-metadata-')), source = join(root, 'next.tmp'), target = join(root, 'state.json');
    await writeFile(source, 'new state'); await writeFile(target, 'previous state'); let attempts = 0;
    const wait = vi.fn(async () => {});
    await replaceMetadataFile(source, target, { platform: 'win32', wait, rename: async (from, to) => {
      expect(await readFile(target, 'utf8')).toBe('previous state');
      if (++attempts < 3) throw Object.assign(new Error('sharing failure'), { code: 'EPERM' });
      await rename(from, to);
    } });
    expect(await readFile(target, 'utf8')).toBe('new state'); expect(wait).toHaveBeenCalledTimes(2);
  });
  it('bounds retries and preserves the original error on permanent Windows failures', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const replace = vi.fn(async () => { throw error; }), wait = vi.fn(async () => {});
    await expect(replaceMetadataFile('temporary', 'existing', { platform: 'win32', rename: replace, wait })).rejects.toBe(error);
    expect(replace).toHaveBeenCalledTimes(6); expect(wait).toHaveBeenCalledTimes(5);
  });
  it('does not retry missing files or non-Windows failures', async () => {
    for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EPERM']] as const) {
      const error = Object.assign(new Error('failure'), { code }), replace = vi.fn(async () => { throw error; }), wait = vi.fn(async () => {});
      await expect(replaceMetadataFile('temporary', 'existing', { platform, rename: replace, wait })).rejects.toBe(error);
      expect(replace).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
    }
  });
});
