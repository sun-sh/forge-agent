import { rename as renameFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Windows readers/indexers can briefly deny an atomic metadata replacement.
 * Keep the destination intact, bound the wait, and propagate real failures.
 * Project-file mutations retain their separate conflict checks.
 */
export async function replaceMetadataFile(source: string, target: string, operations: {
  rename?: (source: string, target: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
} = {}): Promise<void> {
  const rename = operations.rename ?? renameFile;
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((operations.platform ?? process.platform) !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5) throw error;
      await (operations.wait ?? (async (milliseconds) => { await delay(milliseconds); }))(20 * 2 ** attempt);
    }
  }
}
