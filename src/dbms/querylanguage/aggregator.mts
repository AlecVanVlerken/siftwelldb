// author: Frederik Caeyman & Matisse De Gauquier
// GROUP BY execution and aggregate-function compute.

import { type FieldValue } from '../document.mjs';
import type { AggregateExpression, GroupByClause, HavingExpression, QueryResultRow } from './ast.mjs';
import { compareValues, evaluateWhere } from './expressions.mjs';

/** Result of one aggregate call against a group of rows. */
export type AggregateValue = FieldValue | null;

/**
 * Compute one aggregate function over a set of rows.
 *
 *   - `COUNT(*)` counts every row, nulls included.
 *   - `COUNT(field)` and any `*(DISTINCT field)` form skip rows where
 *     the field is `null` / `undefined`.
 *   - `SUM` / `AVG` only consider numeric values. Non-numeric values
 *     are ignored, not zero-coerced.
 *   - `MIN` / `MAX` work on any comparable scalar (string / number /
 *     boolean) using the same {@link compareValues} comparator that
 *     drives `ORDER BY` and `<` / `>` — so they're locale-independent.
 *   - **Empty input** for `SUM` / `AVG` / `MIN` / `MAX` returns `null`,
 *     matching standard SQL. The previous engine returned `0`, which
 *     was indistinguishable from an actual zero sum.
 *
 * `MIN`/`MAX` deliberately avoid `Math.min(...arr)` / `Math.max(...arr)` —
 * the spread form blows up V8's argument limit (~65 535 elements) on
 * large groups. The reduce loop is O(n) and safe for any size.
 */
export function computeAggregate(rows: QueryResultRow[], agg: AggregateExpression): AggregateValue {
  const input: QueryResultRow[] = agg.distinct && agg.field !== '*' ? dedupeBy(rows, agg.field) : rows;

  switch (agg.func) {
    case 'COUNT':
      if (agg.field === '*') return input.length;
      return input.reduce(
        (n, row) => n + (row[agg.field] !== undefined && row[agg.field] !== null ? 1 : 0),
        0,
      );

    case 'SUM': {
      let sum = 0;
      let seen = 0;
      for (const row of input) {
        const val = row[agg.field];
        if (typeof val === 'number') {
          sum += val;
          seen++;
        }
      }
      return seen === 0 ? null : sum;
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
      return count === 0 ? null : sum / count;
    }

    case 'MIN':
      return reduceExtreme(input, agg.field, -1);

    case 'MAX':
      return reduceExtreme(input, agg.field, 1);
  }
}

/**
 * Walk `rows` once and return the `field` value that compares smallest
 * (`direction = -1`) or largest (`direction = 1`) by {@link compareValues}.
 *
 * `null` / `undefined` are skipped. Returns `null` for empty input
 * (matching `MIN(...)` / `MAX(...)` over no rows in standard SQL).
 */
function reduceExtreme(rows: QueryResultRow[], field: string, direction: -1 | 1): FieldValue | null {
  let extreme: FieldValue | null = null;
  for (const row of rows) {
    const v = row[field];
    if (v === undefined || v === null) continue;
    if (extreme === null) {
      extreme = v;
      continue;
    }
    const cmp = compareValues(v, extreme);
    if (direction === -1 ? cmp < 0 : cmp > 0) extreme = v;
  }
  return extreme;
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
 * Compose an unambiguous group key from the values of every GROUP BY
 * field on a row.
 *
 * Length-prefixed JSON encoding per component prevents the classic
 * `'a|b'` / `'a' + 'b'` collision, and keeps `null`, `undefined`, and
 * the empty string in distinct groups (JSON.stringify(undefined) is
 * itself `undefined`, so we encode it explicitly).
 */
function groupKey(row: QueryResultRow, fields: string[]): string {
  let out = '';
  for (const f of fields) {
    const v = row[f];
    if (v === undefined) {
      out += 'u|';
      continue;
    }
    const s = JSON.stringify(v);
    out += `${s.length}:${s}|`;
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
    const key = groupKey(row, groupBy.fields);
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
      const value = computeAggregate(groupRows, agg);
      // `QueryResultRow`'s value type is `FieldValue | undefined` — no
      // `null`. We map `null` aggregates (empty SUM / AVG / MIN / MAX)
      // to `undefined` so the column still exists but reads as missing.
      // `evaluateIsNull` already treats both as "no value", so a
      // `HAVING ... IS NULL` predicate matches empty-group aggregates.
      resultRow[agg.alias] = value === null ? undefined : (value as FieldValue);
    }

    if (having && !evaluateWhere(resultRow as Record<string, FieldValue>, having)) continue;

    results.push(resultRow);
  }

  return results;
}
