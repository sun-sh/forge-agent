import { spawn } from 'node:child_process';
import { join } from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function localBrowserCommand(address: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const url = new URL(address);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new Error('The browser launcher requires a plain local Web address');
  }
  if (platform === 'win32') {
    return {
      file: join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', url.href]
    };
  }
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [url.href] };
  return { file: 'xdg-open', args: [url.href] };
}

export async function openLocalBrowser(address: string): Promise<void> {
  const command = localBrowserCommand(address);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
