import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const services = vi.hoisted(() => ({ start: vi.fn(), open: vi.fn(), close: vi.fn() }));
vi.mock('../src/web/server.js', () => ({ startWebConsole: services.start }));
vi.mock('../src/web/open-browser.js', () => ({ openLocalBrowser: services.open }));
import { runPforge } from '../src/pi-cli.js';

const address = 'http://127.0.0.1:4328/?token=private-local-startup-credential';
beforeEach(() => {
  vi.stubEnv('FORGE_AGENT_HOME', join(tmpdir(), 'pforge-launch-test'));
  vi.stubEnv('PFORGE_HOME', join(tmpdir(), 'pforge-launch-test'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(tmpdir(), 'pforge-launch-test'));
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(tmpdir(), 'pforge-launch-test', 'sessions'));
  services.start.mockResolvedValue({ url: address, token: 'private-local-startup-credential', close: services.close });
  services.open.mockResolvedValue(undefined);
  services.close.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

async function launch(args: string[]) {
  const previous = new Set(process.listeners('SIGINT'));
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const running = runPforge(['web', '--port', '4328', ...args]);
  await vi.waitFor(() => expect(out).toHaveBeenCalledWith('Press Ctrl+C to stop.\n'));
  const shutdown = process.listeners('SIGINT').find((listener) => !previous.has(listener));
  expect(shutdown).toBeTypeOf('function');
  shutdown!.call(process, 'SIGINT');
  await running;
  return {
    output: out.mock.calls.map(([value]) => String(value)).join(''),
    error: err.mock.calls.map(([value]) => String(value)).join('')
  };
}

describe('Web browser startup', () => {
  it('opens the authorized browser automatically and only prints the fixed local address', async () => {
    const result = await launch([]);
    expect(services.open).toHaveBeenCalledExactlyOnceWith(address);
    expect(result.output).toContain('forge-agent web: http://127.0.0.1:4328/\n');
    expect(result.output).not.toContain('token=');
    expect(result.error).toBe('');
    expect(services.close).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit no-open mode for integrations that manage their own browser', async () => {
    const result = await launch(['--no-open']);
    expect(services.open).not.toHaveBeenCalled();
    expect(result.output).toContain(address);
    expect(services.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed browser launch actionable without exposing credentials from launch errors', async () => {
    services.open.mockRejectedValueOnce(new Error('Failed to launch ' + address));
    const result = await launch([]);
    expect(result.error).toContain('--no-open');
    expect(result.error + result.output).not.toContain('private-local-startup-credential');
    expect(services.close).toHaveBeenCalledTimes(1);
  });
});
