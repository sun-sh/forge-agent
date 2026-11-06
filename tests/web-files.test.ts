import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFiles, parseImageAttachment, preparePromptAttachments, readProjectFile } from '../src/web/files.js';

describe('safe Web project file references', () => {
  it('lists and reads text files while excluding credentials and traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-'));
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'main.ts'), 'export const ok = true;');
    await writeFile(join(root, '.env'), 'SECRET=do-not-read'); await writeFile(join(root, 'token.pem'), 'private'); await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    const files = await listProjectFiles(root);
    expect(files.map((file) => file.path)).toContain('src/main.ts');
    expect(files.map((file) => file.path)).not.toContain('.env');
    expect(files.map((file) => file.path)).not.toContain('binary.dat');
    expect(await readProjectFile(root, '../outside.txt')).toBeUndefined();
    expect(await readProjectFile(root, '.env')).toBeUndefined();
    expect(await readProjectFile(root, 'src/main.ts')).toMatchObject({ path: 'src/main.ts', text: 'export const ok = true;' });
  });

  it('rejects symlink escapes and validates image headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'forge-web-files-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'outside');
    try { await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    expect(await readProjectFile(root, 'linked/secret.txt')).toBeUndefined();
    expect(parseImageAttachment({ type: 'image', mimeType: 'image/png', data: Buffer.from('not png').toString('base64') })).toBeUndefined();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    expect(parseImageAttachment({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('builds a prompt attachment context only from safe project files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-prompt-'));
    await writeFile(join(root, 'notes.md'), '# Notes\nKeep this file.');
    const prepared = await preparePromptAttachments(root, [{ type: 'file', path: 'notes.md' }]);
    expect(prepared.images).toHaveLength(0);
    expect(prepared.text).toContain('[用户引用的项目文件：notes.md]');
    await expect(preparePromptAttachments(root, [{ type: 'file', path: '.env' }])).rejects.toThrow();
  });

  it.each(['.git', '.forge-agent'])('rejects references into %s through an in-project directory alias', async (directory) => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-sensitive-alias-'));
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'config'), 'private fixture content');
    await symlink(join(root, directory), join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readProjectFile(root, 'docs/config')).toBeUndefined();
    await expect(preparePromptAttachments(root, [{ type: 'file', path: 'docs/config' }])).rejects.toThrow('无法安全读取');
  });

  it('allows an in-project directory alias to ordinary text files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-safe-alias-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), 'export const ok = true;');
    await symlink(join(root, 'src'), join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readProjectFile(root, 'docs/main.ts')).toMatchObject({ path: 'docs/main.ts', text: 'export const ok = true;' });
  });

  it('bounds the combined attachment context instead of multiplying per-file limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-total-'));
    const content = Buffer.alloc(1_500_000, 'x');
    await writeFile(join(root, 'one.txt'), content); await writeFile(join(root, 'two.txt'), content); await writeFile(join(root, 'three.txt'), content);
    await expect(preparePromptAttachments(root, [
      { type: 'file', path: 'one.txt' }, { type: 'file', path: 'two.txt' }, { type: 'file', path: 'three.txt' }
    ])).rejects.toThrow('内容过大');
  });

  it('bounds image count at the server boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-web-files-images-'));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64');
    await expect(preparePromptAttachments(root, Array.from({ length: 5 }, () => ({ type: 'image', mimeType: 'image/png', data: png })))).rejects.toThrow('4 张');
  });
});
