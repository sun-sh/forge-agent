import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function pforgeHome(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const configured = env['FORGE_AGENT_HOME']?.trim() || env['PFORGE_HOME']?.trim();
  if (configured) return resolve(configured);
  const home = join(userHome, '.forge-agent');
  const legacy = join(userHome, '.pforge');
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
}

export function configurePforgeEnvironment(home = pforgeHome()): string {
  process.env['PFORGE_HOME'] = home;
  process.env['PI_CODING_AGENT_DIR'] = home;
  process.env['PI_CODING_AGENT_SESSION_DIR'] = join(home, 'sessions');
  return home;
}
