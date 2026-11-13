import { describe, expect, it } from 'vitest';
import { reviewCases } from '../scripts/review-cases.mjs';

const moduleFrom = (source) => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
describe('externally checked reviewer counterexamples, not model-quality scores', () => {
  it('retains explicit endpoint validation even when the requested new name guard passes visible checks', async () => {
    const task = reviewCases.find((item) => item.id === 'endpoint-override-regression');
    const good = await moduleFrom(task.correctFiles[task.entry]), bad = await moduleFrom(task.defectiveFiles[task.entry]);
    for (const implementation of [good, bad]) { expect(implementation.register('api')).toBe('api.index'); expect(() => implementation.register('bad.name')).toThrow(); }
    expect(() => good.register('api', 'a.b')).toThrow(TypeError);
    expect(bad.register('api', 'a.b')).toBe('api.a.b');
  });
  it('distinguishes preserving Nx1 input from a blanket 2D rejection despite a misleading model ledger', async () => {
    const task = reviewCases.find((item) => item.id === 'column-vector-regression');
    const good = await moduleFrom(task.correctFiles[task.entry]), bad = await moduleFrom(task.defectiveFiles[task.entry]);
    for (const implementation of [good, bad]) { expect(implementation.lineCoordinates([1,2])).toEqual([1,2]); expect(() => implementation.lineCoordinates([[1,2],[3,4]])).toThrow(); }
    expect(good.lineCoordinates([[1],[2]])).toEqual([1,2]);
    expect(() => bad.lineCoordinates([[1],[2]])).toThrow();
    expect(task.ledgerConstraints[0]).toContain('all two-dimensional');
    expect(task.provenance).toBe('synthetic-mechanism-analogue-not-upstream');
  });
});
