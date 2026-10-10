import type { AggregateExpression, GroupByClause, HavingExpression, QueryResultRow } from './ast.mjs';
import { compareValues, evaluateWhere } from './expressions.mjs';

type State = {
  aggregate: AggregateExpression;
  count: number;
  sum: number;
  extreme: QueryResultRow[string];
  distinct?: Set<unknown>;
};
type Group = { row: QueryResultRow; states: State[] };

function groupKey(row: QueryResultRow, fields: string[]): string {
  return fields
    .map((field) => {
      const value = Object.hasOwn(row, field) ? row[field] : undefined;
      if (value === undefined) return 'u|';
      const json = JSON.stringify(value);
      return `${json.length}:${json}|`;
    })
    .join('');
}

/** Retain aggregate state, not every member document. DISTINCT needs a value set. */
export class GroupAggregator {
  private readonly groups = new Map<string, Group>();
  constructor(
    private readonly groupBy: GroupByClause,
    private readonly having?: HavingExpression,
  ) {
    if (groupBy.fields.length === 0) this.group({});
  }
  private group(row: QueryResultRow): Group {
    const key = groupKey(row, this.groupBy.fields);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        row: Object.fromEntries(
          this.groupBy.fields.map((field) => [field, Object.hasOwn(row, field) ? row[field] : undefined]),
        ),
        states: this.groupBy.aggregates.map((aggregate) => ({
          aggregate,
          count: 0,
          sum: 0,
          extreme: null,
          distinct: aggregate.distinct ? new Set() : undefined,
        })),
      };
      this.groups.set(key, group);
    }
    return group;
  }
  add(row: QueryResultRow): void {
    for (const state of this.group(row).states) {
      const { aggregate } = state;
      const value =
        aggregate.field === '*' ? 1 : Object.hasOwn(row, aggregate.field) ? row[aggregate.field] : undefined;
      if (value === null || value === undefined) continue;
      if (state.distinct?.has(value)) continue;
      state.distinct?.add(value);
      if (aggregate.func === 'COUNT') state.count++;
      else if (aggregate.func === 'SUM' || aggregate.func === 'AVG') {
        if (typeof value === 'number') {
          state.count++;
          state.sum += value;
        }
      } else if (
        state.extreme === null ||
        (aggregate.func === 'MIN' ? compareValues(value, state.extreme) < 0 : compareValues(value, state.extreme) > 0)
      )
        state.extreme = value;
    }
  }
  finish(): QueryResultRow[] {
    const result: QueryResultRow[] = [];
    for (const { row, states } of this.groups.values()) {
      for (const state of states) {
        const func = state.aggregate.func;
        row[state.aggregate.alias] =
          func === 'COUNT'
            ? state.count
            : func === 'SUM'
              ? state.count
                ? state.sum
                : null
              : func === 'AVG'
                ? state.count
                  ? state.sum / state.count
                  : null
                : state.extreme;
      }
      if (!this.having || evaluateWhere(row, this.having)) result.push(row);
    }
    return result;
  }
}

export function executeGroupBy(
  rows: Iterable<QueryResultRow>,
  groupBy: GroupByClause,
  having?: HavingExpression,
): QueryResultRow[] {
  const aggregator = new GroupAggregator(groupBy, having);
  for (const row of rows) aggregator.add(row);
  return aggregator.finish();
}
