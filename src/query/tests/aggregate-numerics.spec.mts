import { describe, expect, it } from 'vitest';
import { executeGroupBy } from '../aggregator.mjs';
import { parse } from '../parser.mjs';
import { executeOnRows } from '../executor.mjs';

function aggregate(values: number[], func: 'AVG' | 'SUM') {
  return executeGroupBy(
    values.map((score) => ({ score })),
    { fields: [], aggregates: [{ func, field: 'score', alias: 'result' }] },
  )[0]['result'];
}

describe('finite numeric aggregates', () => {
  it.each([
    [Array<number>(1000).fill(1e308), 1e308],
    [Array<number>(1000).fill(Number.MAX_VALUE), Number.MAX_VALUE],
    [[Number.MAX_VALUE, Number.MAX_VALUE], Number.MAX_VALUE],
    [[-1e308, -1e308], -1e308],
    [[1e308, 1e308, -1e308, -1e308], 0],
    [[1e308, 1, -1e308], 1 / 3],
    [[Number.MIN_VALUE, Number.MIN_VALUE], Number.MIN_VALUE],
    [[Number.MAX_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE], Number.MIN_VALUE],
    [[1, 2, 3], 2],
    [[0.1, 0.2, 0.3], 0.2],
  ] as [number[], number][])('averages finite values across magnitudes (%#)', (values, expected) => {
    const actual = aggregate(values, 'AVG') as number;
    expect(Number.isFinite(actual)).toBe(true);
    if (expected === 0 || expected === Number.MIN_VALUE) expect(actual).toBe(expected);
    else expect(Math.abs((actual - expected) / expected)).toBeLessThan(5 * Number.EPSILON);
  });
  it('averages large finite numbers without overflowing', () => {
    expect(aggregate([1e308, 1e308], 'AVG')).toBe(1e308);
  });
  it('reports unrepresentable sums explicitly', () => {
    expect(() => aggregate([1e308, 1e308], 'SUM')).toThrow(/SUM.*finite/);
  });
  it('returns representable sums after intermediate overflow and cancellation', () => {
    expect(aggregate([1e308, 1e308, -1e308], 'SUM')).toBe(1e308);
    expect(aggregate([1e308, 1, -1e308], 'SUM')).toBe(1);
  });
  it('preserves small cancellation terms when normalization would be subnormal', () => {
    for (const values of [
      [Number.MAX_VALUE, 3e-16, -Number.MAX_VALUE],
      [3e-16, Number.MAX_VALUE, -Number.MAX_VALUE],
      [1, 3e-16, Number.MAX_VALUE, -Number.MAX_VALUE, -1],
    ]) {
      expect(aggregate(values, 'SUM')).toBe(3e-16);
      expect(aggregate(values, 'AVG')).toBe(3e-16 / values.length);
    }
  });
  it('preserves grouping, HAVING aliases, DISTINCT and missing/nonnumeric semantics', () => {
    const query = parse(
      'SELECT team, AVG(score) AS average, COUNT(*) AS count FROM docs GROUP BY team HAVING average > 1e307',
    );
    if (query.kind !== 'select') throw new Error('Expected SELECT');
    expect(
      executeOnRows(
        [
          { team: 'a', score: 1e308 },
          { team: 'a', score: 1e308 },
          { team: 'b', score: 1 },
        ],
        query,
      ),
    ).toEqual([{ team: 'a', average: 1e308, count: 2 }]);
    expect(
      executeGroupBy([{ score: null }, {}, { score: 'text' }], {
        fields: [],
        aggregates: [
          { func: 'AVG', field: 'score', alias: 'average' },
          { func: 'COUNT', field: 'score', alias: 'count' },
        ],
      }),
    ).toEqual([{ average: null, count: 1 }]);
    expect(executeGroupBy([], { fields: [], aggregates: [{ func: 'AVG', field: 'score', alias: 'average' }] })).toEqual(
      [{ average: null }],
    );
    expect(
      executeGroupBy([{ score: 1e308 }, { score: 1e308 }], {
        fields: [],
        aggregates: [{ func: 'SUM', field: 'score', alias: 'total', distinct: true }],
      }),
    ).toEqual([{ total: 1e308 }]);
  });
  it('rejects a mixed result containing an overflowing aggregate', () => {
    expect(() =>
      executeGroupBy([{ score: 1e308 }, { score: 1e308 }], {
        fields: [],
        aggregates: [
          { func: 'AVG', field: 'score', alias: 'average' },
          { func: 'SUM', field: 'score', alias: 'total' },
        ],
      }),
    ).toThrow(/SUM.*finite/);
  });
});
