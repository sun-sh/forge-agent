import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Filesystem identity, shared by execution locks and persisted project scopes. */
export function directoryKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
export async function canonicalDirectory(path: string): Promise<string> { return realpath(resolve(path)); }
export async function sameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (path: string) => { try { return await canonicalDirectory(path); } catch { return resolve(path); } };
  const [a, b] = await Promise.all([canonical(left), canonical(right)]);
  return directoryKey(a) === directoryKey(b);
}
