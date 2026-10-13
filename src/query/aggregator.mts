import type { AggregateExpression, GroupByClause, HavingExpression, QueryResultRow } from './ast.mjs';
import { compareValues, evaluateWhere } from './expressions.mjs';

type State = {
  aggregate: AggregateExpression;
  count: number;
  sum: number;
  scale: number;
  correction: number;
  residual: number;
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
          scale: 0,
          correction: 0,
          residual: 0,
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
          if (!Number.isFinite(value)) throw new Error(`${aggregate.func} requires finite numeric values`);
          state.count++;
          if (value !== 0) {
            // Power-of-two scaling keeps the running sum in a safe range without
            // rounding ordinary rescaling. Compensation retains cancellation terms.
            const scale = 2 ** Math.min(1023, Math.floor(Math.log2(Math.abs(value))));
            if (scale > state.scale) {
              const ratio = state.scale / scale;
              if (state.sum !== 0 && state.sum * ratio === 0) state.residual += state.sum * state.scale;
              if (state.correction !== 0 && state.correction * ratio === 0)
                state.residual += state.correction * state.scale;
              state.sum *= ratio;
              state.correction *= ratio;
              state.scale = scale;
            }
            const term = value / state.scale;
            if (term === 0) {
              state.residual += value;
              continue;
            }
            const sum = state.sum + term;
            state.correction += Math.abs(state.sum) >= Math.abs(term) ? state.sum - sum + term : term - sum + state.sum;
            state.sum = sum;
          }
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
        const total = (state.sum + state.correction) * state.scale;
        row[state.aggregate.alias] =
          func === 'COUNT'
            ? state.count
            : func === 'SUM'
              ? state.count
                ? total + state.residual
                : null
              : func === 'AVG'
                ? state.count
                  ? (Number.isFinite(total)
                      ? total / state.count
                      : ((state.sum + state.correction) / state.count) * state.scale) +
                    state.residual / state.count
                  : null
                : state.extreme;
        const value = row[state.aggregate.alias];
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new RangeError(`${func}(${state.aggregate.field}) cannot be represented as a finite number`);
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
