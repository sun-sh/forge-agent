import { describe, expect, it } from 'vitest';
import { taskCheckpoint } from '../src/task/context.js';
import type { TaskState } from '../src/task/controller.js';
import { taskRequirementsSchema } from '../src/task/plan.js';

const requirements = {
  goal: 'Fix the login response without changing the public contract.',
  affectedPaths: ['src/auth/login.ts'],
  constraints: ['Do not delete the production database.', 'Do not modify existing tests.'],
  acceptance: [{ id: 'A1', criterion: 'The login response keeps its current shape.', check: 'inspection' as const, evidence: 'Inspect the response type and focused test.' }],
  unresolved: []
};

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    version: 1, id: '3e2c8c2d-4a6e-41c8-8c1c-2f6abf2f5ad4', prompt: 'long request', status: 'running', phase: 'implement',
    workflow: 'planned', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repairs: 0,
    phases: [{ phase: 'inspect', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), summary: 'located files' }],
    requirements, ...overrides
  };
}

describe('task context checkpoint', () => {
  it('keeps the host-owned goal, constraints and acceptance complete', () => {
    const checkpoint = taskCheckpoint(task({ prompt: 'background '.repeat(10_000) + 'TAIL USER REQUEST' }));
    expect(checkpoint).toContain('Do not delete the production database.');
    expect(checkpoint).toContain('Do not modify existing tests.');
    expect(checkpoint).toContain('The login response keeps its current shape.');
    expect(checkpoint).toContain('src/auth/login.ts');
    expect(checkpoint).toContain('"excerptOnly":false');
  });

  it('fits a large standalone requirement ledger without duplicating or replacing its goal with raw background', () => {
    const preserved = taskRequirementsSchema.parse({ ...requirements, goal: 'g'.repeat(4000), constraints: Array.from({ length: 7 }, (_, index) => String(index) + 'c'.repeat(999)), affectedPaths: ['p'.repeat(500)] });
    const checkpoint = taskCheckpoint(task({ requirements: preserved, brief: undefined, prompt: '\u0001'.repeat(10_000) }));
    const json = checkpoint.slice(checkpoint.indexOf('\n') + 1), value = JSON.parse(json);
    expect(json.length).toBeLessThanOrEqual(16000);
    expect(value.requirements).toEqual(preserved);
    expect(value.goal).toBeUndefined();
    expect(value.originalRequest.excerptOnly).toBe(false);
  });

  it('reconstructs requirements for a legacy task that only has a brief', () => {
    const checkpoint = taskCheckpoint(task({ requirements: undefined, brief: {
      version: 1, intent: 'change', goal: requirements.goal, affectedPaths: requirements.affectedPaths,
      constraints: requirements.constraints, unresolved: requirements.unresolved, acceptance: requirements.acceptance
    } }));
    expect(checkpoint).toContain('Do not delete the production database.');
    expect(checkpoint).toContain('A1');
  });

  it('keeps a bounded head and tail when no structured requirements exist yet', () => {
    const checkpoint = task({ requirements: undefined, brief: undefined, prompt: 'HEAD_REQUEST ' + 'background '.repeat(2_000) + 'TAIL_ACCEPTANCE' });
    const text = taskCheckpoint(checkpoint);
    expect(text).toContain('HEAD_REQUEST');
    expect(text).toContain('TAIL_ACCEPTANCE');
    expect(text).toContain('excerptOnly":true');
  });
});
