// author: Frederik Caeyman & Matisse De Gauquier
// Project a single row onto a SELECT field list. Honors `AS` aliases.

import { type FieldValue } from '../database/document.mjs';
import type { FieldSelector, QueryResultRow } from './ast.mjs';

/**
 * Reduce `doc` to the columns listed in `fields`.
 *
 *   - `'*'` returns the input row verbatim.
 *   - Each {@link FieldSelector} contributes one output column. The output
 *     key is `selector.alias ?? selector.expr`. The value is looked up
 *     under `selector.expr` (the *internal* column name produced by the
 *     executor or aggregator — e.g. `COUNT(*)`).
 *
 * This is the single place where `AS` aliasing is actually applied; the
 * parser is responsible for splitting `expr AS alias` into the two parts.
 */
export function project(doc: Record<string, FieldValue>, fields: '*' | FieldSelector[]): QueryResultRow {
  if (fields === '*') return doc;

  const projected: QueryResultRow = {};
  for (const sel of fields) {
    const outKey = sel.alias ?? sel.expr;
    projected[outKey] = doc[sel.expr];
  }
  return projected;
}
