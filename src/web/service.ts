import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadWebToken } from './auth.js';

const schema = z.object({ version: z.literal(1), instance: z.uuid(), pid: z.number().int().positive(), origin: z.string().url(), startedAt: z.string() }).strict();
export type ServiceRecord = z.infer<typeof schema>;
const recordPath = (home: string) => join(home, 'web', 'service.json');
export async function serviceStatus(home: string) {
  let record: ServiceRecord;
  try { record = schema.parse(JSON.parse(await readFile(recordPath(home), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { running: false as const };
    // Windows can finish unlinking the service record while readFile is still
    // resolving. A disappearing record is a stopped service, not corruption.
    try { await lstat(recordPath(home)); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return { running: false as const }; }
    throw new Error('后台服务记录不可读，请检查 web/service.json');
  }
  const url = new URL(record.origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('后台服务地址无效');
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(2000), redirect: 'error' });
    const health = await response.json() as { instance?: string };
    return { running: response.ok && health.instance === record.instance, ...record };
  } catch { return { running: false, ...record }; }
}
export async function saveService(home: string, origin: string, instance: string) {
  await mkdir(join(home, 'web'), { recursive: true });
  const record: ServiceRecord = { version: 1, instance, pid: process.pid, origin: new URL(origin).origin, startedAt: new Date().toISOString() };
  const temporary = recordPath(home) + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 }); await rename(temporary, recordPath(home));
}
export async function clearService(home: string, instance: string) {
  try { const record = schema.parse(JSON.parse(await readFile(recordPath(home), 'utf8'))); if (record.instance === instance) await unlink(recordPath(home)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function startService(home: string, cwd: string, entry: string, port: number) {
  const current = await serviceStatus(home); if (current.running) return current;
  await mkdir(join(home, 'web'), { recursive: true });
  const instance = randomUUID(), log = await open(join(home, 'web', 'service.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry, '-C', cwd, 'web', '--no-open', '--port', String(port)], {
      cwd, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, FORGE_AGENT_HOME: home, FORGE_SERVICE_INSTANCE: instance }
    });
    let failure: Error | undefined; child.once('error', (error) => { failure = error; }); child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      const state = await serviceStatus(home);
      if (state.running && state.instance === instance) return state;
      await delay(200);
    }
    throw new Error('后台服务未能就绪，请检查端口及 web/service.log');
  } finally { await log.close(); }
}
export async function stopService(home: string) {
  const status = await serviceStatus(home); if (!status.running || !('origin' in status)) return;
  const response = await fetch(status.origin + '/api/service/stop', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-pforge-token': await loadWebToken(home) }, body: JSON.stringify({ instance: status.instance }) });
  if (!response.ok) throw new Error('后台服务拒绝停止请求：HTTP ' + response.status);
  for (let attempt = 0; attempt < 100; attempt++) { if (!(await serviceStatus(home)).running) return; await delay(200); }
  throw new Error('后台服务仍在清理任务，请稍后查看状态');
}
