import { describe, expect, it } from 'vitest';
import { evaluationSchedule, reviewConfusion } from '../scripts/evaluation-protocol.mjs';

describe('counterbalanced evaluation protocol', () => {
  it('pairs each task/repetition across all arms and balances order over three repetitions', () => {
    const arms = ['direct', 'planned', 'planned-no-review'], schedule = evaluationSchedule(['a', 'b'], arms, 3);
    expect(schedule).toHaveLength(18);
    for (const task of ['a', 'b']) for (const arm of arms) {
      const runs = schedule.filter((item) => item.task === task && item.workflow === arm);
      expect(runs.map((item) => item.run)).toEqual([1, 2, 3]);
      expect(runs.map((item) => item.position).sort()).toEqual([1, 2, 3]);
    }
  });
  it('counts missed defects and false positives, retaining malformed results as abstentions', () => {
    const metrics = reviewConfusion([
      { expectedDefect: true, valid: true, blocking: true }, { expectedDefect: true, valid: true, blocking: false },
      { expectedDefect: false, valid: true, blocking: true }, { expectedDefect: false, valid: true, blocking: false },
      { expectedDefect: true, valid: false }
    ]);
    expect(metrics).toMatchObject({ total: 5, truePositives: 1, falseNegatives: 1, falsePositives: 1, trueNegatives: 1, abstentions: 1, recall: 1 / 3, precision: 0.5, falsePositiveRate: 0.5, coverage: 0.8 });
    expect(reviewConfusion([])).toMatchObject({ recall: null, precision: null });
  });
});
