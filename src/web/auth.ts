import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function matchesToken(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const left = Buffer.from(expected), right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(name + '='))?.slice(name.length + 1);
}

// This authenticates the local Web gateway; provider authentication remains in Pi.
export async function loadWebToken(home: string): Promise<string> {
  const directory = join(home, 'web');
  const path = join(directory, 'access-token');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const saved = (await readFile(path, 'utf8')).trim();
      if (/^[A-Za-z0-9_-]{43}$/.test(saved)) return saved;
      if (attempt === 5) throw new Error('Invalid local Web access file: ' + path + '. Restore or remove this file and restart forge-agent web.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const generated = randomBytes(32).toString('base64url');
      try { await writeFile(path, generated + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); return generated; }
      catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
    }
    // Another process may have created the file and still be completing its write.
    await delay(20);
  }
  throw new Error('Unable to initialize local Web access file: ' + path);
}
