// author: Frederik Caeyman & Matisse De Gauquier
//
// Tiny "planner" that decides how a SELECT should iterate the
// underlying collection.
//
// Two specialisations land short-circuit scans:
//
//   1. `WHERE id = X`  → use the `id` index as a direct point lookup.
//   2. `WHERE f = X`   → if `f` is indexed, seek the secondary index;
//                        early-terminate once the field value changes.
//                        Falls back to a full scan at execution time if
//                        the field has no index (the planner is schema-
//                        agnostic; the executor verifies).
//
// Everything else (range predicates, OR, NOT, IN, BETWEEN, …)
// fall back to a full scan over the `id` index with the WHERE filter
// applied row-by-row. This is correctness-preserving; the speed-up is
// gravy.

import { type FieldValue } from '../database/document.mjs';
import type { WhereExpression } from './ast.mjs';

export type CursorPlan =
  | {
      /** Full scan over the `id` index. WHERE applied per row. */
      kind: 'fullScan';
    }
  | {
      /** Point lookup by primary key. Stops after the first matching row. */
      kind: 'idEquality';
      value: string | number;
    }
  | {
      /**
       * Secondary-index equality seek. Executor will fall back to a
       * full scan if the field turns out not to be indexed.
       */
      kind: 'fieldEquality';
      field: string;
      value: string | number | boolean;
    };

/**
 * Walk the top-level AND-chain of a WHERE expression looking for an
 * `<field> = <literal>` comparison.  Returns the comparison if found,
 * otherwise `undefined`. We refuse to peek through `OR` because the
 * other branch could match rows with different values — seeking there
 * would skip valid matches.
 */
function findFieldEquality(where: WhereExpression | undefined): { field: string; value: FieldValue } | undefined {
  if (!where) return undefined;
  if (where.type === 'comparison' && where.operator === '=') {
    return { field: where.field, value: where.value };
  }
  if (where.type !== 'logical' || where.operator === 'OR') return undefined;
  return findFieldEquality(where.left) ?? findFieldEquality(where.right);
}

export function planCursor(where: WhereExpression | undefined): CursorPlan {
  const eq = findFieldEquality(where);
  if (!eq) return { kind: 'fullScan' };

  if (eq.field === 'id') {
    if (typeof eq.value === 'boolean') return { kind: 'idEquality', value: eq.value ? 1 : 0 };
    if (typeof eq.value === 'string' || typeof eq.value === 'number') {
      return { kind: 'idEquality', value: eq.value };
    }
    return { kind: 'idEquality', value: String(eq.value) };
  }

  if (typeof eq.value === 'string' || typeof eq.value === 'number' || typeof eq.value === 'boolean') {
    return { kind: 'fieldEquality', field: eq.field, value: eq.value };
  }
  return { kind: 'fullScan' };
}
