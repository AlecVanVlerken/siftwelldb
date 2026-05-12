// author: Frederik Caeyman & Matisse De Gauquier
//
// Tiny "planner" that picks the cursor key + start hint for a SELECT.
//
// Despite every indexable field carrying its own B+ tree, in practice
// the secondary-index cursor isn't usable for partial-key seeks (the
// keys are `(field, id)` composites — a single `field` buffer doesn't
// align with the leaf layout). For now we only specialise the one case
// that *does* work and matters in real workloads: a top-level
// `WHERE id = '...'` point lookup. Everything else falls back to a
// full scan of the `id` index with a WHERE filter applied row-by-row.
//
// Keeping this module small and honest is intentional — earlier
// versions tried to seek on any field and silently did nothing.

import { type FieldValue } from '../document.mjs';
import type { WhereExpression } from './ast.mjs';

export type CursorPlan = {
  /** Index to iterate. Always `'id'` until we get real secondary-index seeks. */
  iterableKey: 'id';
  /** Start hint for the cursor, or `undefined` to scan from the beginning. */
  startValue: string | number | undefined;
};

/**
 * Walk the top-level AND-chain of a WHERE expression looking for an
 * `id = <literal>` comparison.  Returns the literal if one is found,
 * otherwise `undefined`. We refuse to peek through `OR` because the
 * other branch could match rows with different ids — using the id
 * as a cursor start there would skip valid matches.
 */
function findIdEquality(where: WhereExpression | undefined): FieldValue | undefined {
  if (!where) return undefined;
  if (where.type === 'comparison') {
    if (where.field === 'id' && where.operator === '=') return where.value;
    return undefined;
  }
  // Only AND can preserve the id constraint across both sides; bail on
  // any other shape (OR, NOT, IS NULL, IN, BETWEEN) so we don't skip
  // valid matches by mis-seeking.
  if (where.type !== 'logical' || where.operator === 'OR') return undefined;
  return findIdEquality(where.left) ?? findIdEquality(where.right);
}

export function planCursor(where: WhereExpression | undefined): CursorPlan {
  const idVal = findIdEquality(where);
  if (idVal === undefined) return { iterableKey: 'id', startValue: undefined };

  if (typeof idVal === 'boolean') return { iterableKey: 'id', startValue: idVal ? 1 : 0 };
  if (typeof idVal === 'string' || typeof idVal === 'number') {
    return { iterableKey: 'id', startValue: idVal };
  }
  return { iterableKey: 'id', startValue: String(idVal) };
}
