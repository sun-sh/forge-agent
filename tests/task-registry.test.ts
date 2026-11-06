import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskRegistry } from '../src/task/registry.js';
import type { TaskState } from '../src/task/controller.js';

const temporary: string[] = [];
afterEach(async () => { temporary.length = 0; });

function task(status: TaskState['status'] = 'running'): TaskState {
  const now = new Date().toISOString();
  return { version: 1, id: randomUUID(), prompt: 'Inspect the fixture', status, phase: 'inspect', startedAt: now, updatedAt: now, repairs: 0, phases: [{ phase: 'inspect', startedAt: now }] };
}

describe('durable task registry', () => {
  it('persists task metadata, rejects a second owner, and marks live tasks interrupted after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-task-registry-')); temporary.push(home);
    const first = await TaskRegistry.open(home), running = task();
    first.save(running, { project: 'C:/project', sessionFile: 'C:/home/sessions/task.json', sessionId: 'live-session' });
    await first.flush();
    expect(JSON.parse(await readFile(join(home, 'tasks', 'index.json'), 'utf8')).tasks).toHaveLength(1);

    await expect(TaskRegistry.open(home)).rejects.toThrow('已有 Web 服务');
    await first.close();
    const second = await TaskRegistry.open(home);
    const restored = second.get(running.id)!;
    expect(restored.state.status).toBe('interrupted');
    expect(restored.state.error).toContain('服务已重启');
    expect(restored.project).toBe('C:/project');
    await second.flush();
    const persisted = JSON.parse(await readFile(join(home, 'tasks', 'index.json'), 'utf8'));
    expect(persisted.tasks[0].state.status).toBe('interrupted');
    await second.close();
  });

  it('ignores malformed registry data and keeps the newest records first', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-task-registry-invalid-')); temporary.push(home);
    const registry = await TaskRegistry.open(home);
    const old = task('completed'); old.updatedAt = '2020-01-01T00:00:00.000Z';
    const newer = task('failed'); newer.updatedAt = '2026-01-01T00:00:00.000Z';
    registry.save(old, { project: 'old', sessionFile: 'old.json' }); registry.save(newer, { project: 'new', sessionFile: 'new.json' });
    expect(registry.list().map((item) => item.id)).toEqual([newer.id, old.id]);
    await registry.flush();
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(home, 'tasks', 'index.json'), '{broken'));
    await registry.close();
    const recovered = await TaskRegistry.open(home);
    expect(recovered.list()).toEqual([]);
    const files = await (await import('node:fs/promises')).readdir(join(home, 'tasks'));
    expect(files).toEqual(expect.arrayContaining([expect.stringMatching(/^index\.json\.invalid-/)]));
    await recovered.close();
  });
});
