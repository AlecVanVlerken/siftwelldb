// author: Frederik Caeyman & Matisse De Gauquier
// GROUP BY execution and aggregate-function compute.

import { type FieldValue } from '../document.mjs';
import type { AggregateExpression, GroupByClause, HavingExpression, QueryResultRow } from './ast.mjs';
import { evaluateWhere } from './expressions.mjs';

/**
 * Compute one aggregate function over a set of rows.
 *
 * `MIN`/`MAX` deliberately avoid `Math.min(...arr)` / `Math.max(...arr)` —
 * the spread form blows up V8's argument limit (~65 535 elements) on
 * large groups. The reduce version is O(n) and safe for any size.
 *
 * `DISTINCT` (e.g. `COUNT(DISTINCT col)`) deduplicates the input column
 * before aggregating. For `COUNT(*)` it's a no-op since the wildcard
 * already counts every row, never a field.
 */
export function computeAggregate(rows: QueryResultRow[], agg: AggregateExpression): number {
  const input: QueryResultRow[] = agg.distinct && agg.field !== '*' ? dedupeBy(rows, agg.field) : rows;

  switch (agg.func) {
    case 'COUNT':
      // COUNT(*) counts rows regardless of nulls; COUNT(field) and
      // COUNT(DISTINCT field) exclude rows whose field is null/missing.
      if (agg.field === '*') return input.length;
      return input.reduce((n, row) => n + (row[agg.field] !== undefined && row[agg.field] !== null ? 1 : 0), 0);

    case 'SUM': {
      return input.reduce((sum, row) => {
        const val = row[agg.field];
        return sum + (typeof val === 'number' ? val : 0);
      }, 0);
    }

    case 'AVG': {
      let sum = 0;
      let count = 0;
      for (const row of input) {
        const val = row[agg.field];
        if (typeof val === 'number') {
          sum += val;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    }

    case 'MIN': {
      let min: number | null = null;
      for (const r of input) {
        const v = r[agg.field];
        if (typeof v === 'number' && (min === null || v < min)) min = v;
      }
      return min ?? 0;
    }

    case 'MAX': {
      let max: number | null = null;
      for (const r of input) {
        const v = r[agg.field];
        if (typeof v === 'number' && (max === null || v > max)) max = v;
      }
      return max ?? 0;
    }
  }
}

/**
 * Return one row per unique value of `field`. Used for `AGG(DISTINCT field)`.
 * `null` / `undefined` are dropped (matching `COUNT(DISTINCT)` semantics —
 * SQL treats those as "no value"); other types are deduped by strict equality.
 */
function dedupeBy(rows: QueryResultRow[], field: string): QueryResultRow[] {
  const seen = new Set<unknown>();
  const out: QueryResultRow[] = [];
  for (const row of rows) {
    const v = row[field];
    if (v === undefined || v === null) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(row);
  }
  return out;
}

/**
 * Group `rows` by the `groupBy.fields` keys, compute every aggregate,
 * and apply `HAVING` to filter out groups.
 *
 * Output rows contain the group-by fields plus one column per aggregate
 * keyed by its canonical alias (e.g. `COUNT(*)`, `AVG(salary)`). Any
 * `AS` aliasing is handled later by the projector, not here.
 */
export function executeGroupBy(
  rows: QueryResultRow[],
  groupBy: GroupByClause,
  having?: HavingExpression,
): QueryResultRow[] {
  const groups = new Map<string, QueryResultRow[]>();
  for (const row of rows) {
    const key = groupBy.fields.map((f) => String(row[f] ?? '')).join('|');
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const results: QueryResultRow[] = [];
  for (const groupRows of groups.values()) {
    const resultRow: QueryResultRow = {};

    for (const field of groupBy.fields) {
      resultRow[field] = groupRows[0][field];
    }
    for (const agg of groupBy.aggregates) {
      resultRow[agg.alias] = computeAggregate(groupRows, agg);
    }

    if (having && !evaluateWhere(resultRow as Record<string, FieldValue>, having)) continue;

    results.push(resultRow);
  }

  return results;
}
