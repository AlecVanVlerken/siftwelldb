import type { SimpleDbms } from '../database/simpledbms.mjs';
import type { WhereExpression } from './ast.mjs';
import { compareValues } from './expressions.mjs';

export type CursorPlan =
  | { kind: 'fullScan' }
  | { kind: 'idEquality'; value: string | number }
  | { kind: 'fieldEquality'; field: string; value: string | number | boolean }
  | {
      kind: 'range';
      field: string;
      lower?: string | number;
      upper?: string | number;
      lowerInclusive: boolean;
      upperInclusive: boolean;
    };

function conjuncts(where?: WhereExpression): WhereExpression[] {
  if (!where) return [];
  if (where.type === 'logical' && where.operator === 'AND')
    return [...conjuncts(where.left), ...conjuncts(where.right)];
  return [where];
}

/** Choose only compatible persisted indexes; never seek inside OR or NOT. */
export function planCursor(where: WhereExpression | undefined, dbms: SimpleDbms, collection: string): CursorPlan {
  const fields = new Map(dbms.describeCollection(collection).map((f) => [f.name, f.type]));
  const predicates = conjuncts(where);
  const compatible = (field: string, value: unknown) =>
    fields.get(field) === typeof value ||
    (field !== 'id' && fields.get(field) === 'number' && typeof value === 'boolean');
  const equalities = predicates.filter(
    (p) => p.type === 'comparison' && p.operator === '=' && compatible(p.field, p.value),
  );
  const id = equalities.find((p) => p.type === 'comparison' && p.field === 'id');
  if (id?.type === 'comparison') return { kind: 'idEquality', value: id.value as string | number };
  const equality = equalities[0];
  if (equality?.type === 'comparison')
    return { kind: 'fieldEquality', field: equality.field, value: equality.value as string | number | boolean };
  for (const field of fields.keys()) {
    // Secondary N encodings deliberately mix booleans and numbers. Seeking
    // a range could skip a value which should raise a strict type error.
    if (field !== 'id' && fields.get(field) !== 'string') continue;
    let lower: string | number | undefined, upper: string | number | undefined;
    let lowerInclusive = true,
      upperInclusive = true;
    // UTF-8 keys replace isolated UTF-16 surrogates with U+FFFD. A
    // boundary between those code points can disagree with SQL ordering,
    // including primary IDs whose original string is retained in the record.
    const orderedKeyCompatible = (value: string | number) =>
      typeof value !== 'string' || !/[\uD800-\uFFFD]/u.test(value);
    const low = (value: string | number, inclusive: boolean) => {
      if (!orderedKeyCompatible(value)) return;
      if (lower === undefined || compareValues(value, lower) > 0) {
        lower = value;
        lowerInclusive = inclusive;
      } else if (compareValues(value, lower) === 0) lowerInclusive &&= inclusive;
    };
    const high = (value: string | number, inclusive: boolean) => {
      if (!orderedKeyCompatible(value)) return;
      if (upper === undefined || compareValues(value, upper) < 0) {
        upper = value;
        upperInclusive = inclusive;
      } else if (compareValues(value, upper) === 0) upperInclusive &&= inclusive;
    };
    for (const p of predicates) {
      if (
        p.type === 'between' &&
        !p.negated &&
        p.field === field &&
        compatible(field, p.low) &&
        compatible(field, p.high)
      ) {
        low(p.low as string | number, true);
        high(p.high as string | number, true);
      } else if (p.type === 'comparison' && p.field === field && compatible(field, p.value)) {
        if (p.operator === '>' || p.operator === '>=') low(p.value as string | number, p.operator === '>=');
        if (p.operator === '<' || p.operator === '<=') high(p.value as string | number, p.operator === '<=');
      }
    }
    if (lower !== undefined || upper !== undefined)
      return { kind: 'range', field, lower, upper, lowerInclusive, upperInclusive };
  }
  return { kind: 'fullScan' };
}
