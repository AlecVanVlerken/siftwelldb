// author: Frederik Caeyman & Matisse De Gauquier
// JOIN execution: streams the right side into memory once, then performs
// either an indexed (INNER/NATURAL) merge or a Cartesian product (FULL).

import type { SimpleDbms } from '../simpledbms.mjs';
import { type FieldValue } from '../document.mjs';
import type { JoinClause, ParsedSelect, QueryResultRow } from './ast.mjs';
import { evaluateWhere } from './expressions.mjs';
import { project } from './projection.mjs';

/**
 * Load an entire collection into memory as parsed JSON rows.
 *
 * NOTE: joins fully materialise both collections by design — there is no
 * streaming join here. Acceptable for the dataset sizes this DBMS targets;
 * call out as a perf cliff if you ever need to scale.
 */
export async function loadCollection(
  dbms: SimpleDbms,
  collection: string,
): Promise<Record<string, FieldValue>[]> {
  const docs: Record<string, FieldValue>[] = [];
  for await (const jsonDoc of dbms.cursor(collection, 'id', undefined)) {
    docs.push(JSON.parse(jsonDoc) as Record<string, FieldValue>);
  }
  return docs;
}

function getOverlappingFields(
  leftDoc: Record<string, FieldValue>,
  rightDoc: Record<string, FieldValue>,
): Set<string> {
  const rightKeySet = new Set(Object.keys(rightDoc));
  const overlap = new Set<string>();
  for (const key of Object.keys(leftDoc)) {
    if (rightKeySet.has(key)) overlap.add(key);
  }
  return overlap;
}

function mergeDocuments(
  leftDoc: Record<string, FieldValue> | null,
  rightDoc: Record<string, FieldValue> | null,
  leftColl: string,
  rightColl: string,
  type: string,
  mergeFields: string[],
): Record<string, FieldValue> {
  const merged: Record<string, FieldValue> = {};
  const overlap = leftDoc && rightDoc ? getOverlappingFields(leftDoc, rightDoc) : new Set<string>();
  const isNatural = type === 'NATURAL';

  const leftJoinKey = mergeFields.length > 0 ? mergeFields[0] : null;
  const rightJoinKey = mergeFields.length > 0 ? mergeFields[mergeFields.length - 1] : null;

  // 1. Put the join key first.
  if (leftDoc && leftJoinKey && leftDoc[leftJoinKey] !== undefined) {
    merged[leftJoinKey] = leftDoc[leftJoinKey];
  } else if (rightDoc && rightJoinKey && rightDoc[rightJoinKey] !== undefined) {
    merged[rightJoinKey] = rightDoc[rightJoinKey];
  }

  // 2. Left-hand fields. Overlapping ones get prefixed with the collection name
  //    (except in NATURAL JOIN, where the overlap *is* the merge).
  if (leftDoc) {
    for (const [k, v] of Object.entries(leftDoc)) {
      if (k === leftJoinKey) continue;
      if (k === 'id' && !isNatural) {
        merged[`${leftColl}.id`] = v;
      } else if (overlap.has(k) && !isNatural) {
        merged[`${leftColl}.${k}`] = v;
      } else {
        merged[k] = v;
      }
    }
  }

  // 3. Right-hand fields, same rules.
  if (rightDoc) {
    for (const [k, v] of Object.entries(rightDoc)) {
      if (k === rightJoinKey) continue;
      if (k === 'id' && !isNatural) {
        merged[`${rightColl}.id`] = v;
      } else if (overlap.has(k) && !isNatural) {
        merged[`${rightColl}.${k}`] = v;
      } else if (merged[k] === undefined) {
        merged[k] = v;
      }
    }
  }

  return merged;
}

/**
 * Merge two collections according to a single JOIN clause. Returns the
 * unfiltered, unprojected cross product (or filtered cross product, for
 * INNER / NATURAL joins).
 *
 * Three resolution modes:
 *
 *   1. **INNER** (`ON left = right`): hash the right side on the join key,
 *      probe per left row. O(L + R) build, O(L) probe.
 *   2. **NATURAL** (no `ON`, but overlapping field names): the first
 *      overlapping field becomes the join key, same algorithm.
 *   3. **FULL** (no `ON`, no overlap): true Cartesian product, O(L · R).
 *
 * WHERE filtering and projection are deliberately **not** applied here —
 * with chained joins those have to wait until every collection has been
 * merged in. The caller (executor) runs them once at the end.
 */
export function mergeJoinedDocs(
  leftDocs: Record<string, FieldValue>[],
  rightDocs: Record<string, FieldValue>[],
  join: JoinClause,
  leftCollName: string,
  rightCollName: string,
): Record<string, FieldValue>[] {
  const leftKeys = leftDocs.length > 0 ? Object.keys(leftDocs[0]) : [];
  const rightKeys = rightDocs.length > 0 ? Object.keys(rightDocs[0]) : [];
  const overlapping = leftKeys.filter((k) => rightKeys.includes(k));

  let effectiveJoinType: 'INNER' | 'NATURAL' | 'FULL' = 'INNER';
  let leftKey: string | undefined;
  let rightKey: string | undefined;
  let mergeFields: string[] = [];

  if (join.leftField && join.rightField) {
    effectiveJoinType = 'INNER';
    leftKey = join.leftField.split('.').pop()!;
    rightKey = join.rightField.split('.').pop()!;
    mergeFields = [leftKey, rightKey];
  } else if (overlapping.length > 0) {
    effectiveJoinType = 'NATURAL';
    mergeFields = overlapping;
    leftKey = overlapping[0];
    rightKey = overlapping[0];
  } else {
    effectiveJoinType = 'FULL';
  }

  const results: Record<string, FieldValue>[] = [];

  if (effectiveJoinType === 'FULL' && !leftKey) {
    for (const leftDoc of leftDocs) {
      for (const rightDoc of rightDocs) {
        results.push(mergeDocuments(leftDoc, rightDoc, leftCollName, rightCollName, 'FULL', []));
      }
    }
    return results;
  }

  const rightMap = new Map<FieldValue, Record<string, FieldValue>[]>();
  for (const doc of rightDocs) {
    const val = doc[rightKey!];
    const bucket = rightMap.get(val) ?? [];
    bucket.push(doc);
    rightMap.set(val, bucket);
  }

  for (const leftDoc of leftDocs) {
    const matches = rightMap.get(leftDoc[leftKey!]) ?? [];
    for (const rightDoc of matches) {
      results.push(
        mergeDocuments(leftDoc, rightDoc, leftCollName, rightCollName, effectiveJoinType, mergeFields),
      );
    }
  }
  return results;
}

/**
 * Legacy single-join helper: merge, filter, project in one pass.
 * Retained because the executor's `executeWithPreloadedRows()` public
 * API still calls it for the single-join case (callers preload the
 * left side and want the full pipeline run for them).
 */
export function applyJoin(
  leftDocs: Record<string, FieldValue>[],
  rightDocs: Record<string, FieldValue>[],
  parsed: ParsedSelect,
): QueryResultRow[] {
  const join = parsed.joins?.[0];
  if (!join) return [];
  const merged = mergeJoinedDocs(leftDocs, rightDocs, join, parsed.collection, join.collection);
  const filtered = parsed.where ? merged.filter((doc) => evaluateWhere(doc, parsed.where!)) : merged;
  return filtered.map((row) => project(row, parsed.fields));
}

/**
 * Load every join's right side and fold the merges left-to-right.
 * The base collection (`parsed.collection`) is loaded by the caller.
 *
 * Each intermediate result is the cross-merged set of rows; WHERE and
 * projection are applied by the caller after all joins have folded in.
 */
export async function executeJoinChain(
  dbms: SimpleDbms,
  parsed: ParsedSelect,
  baseDocs: Record<string, FieldValue>[],
): Promise<Record<string, FieldValue>[]> {
  let merged = baseDocs;
  let leftName = parsed.collection;
  for (const join of parsed.joins ?? []) {
    const rightDocs = await loadCollection(dbms, join.collection);
    merged = mergeJoinedDocs(merged, rightDocs, join, leftName, join.collection);
    // For subsequent joins, the running result keeps composing under
    // the most-recently-merged collection name — that's how downstream
    // joins refer to its fields. Earlier collections remain reachable
    // via their already-prefixed `coll.field` columns on overlap.
    leftName = join.collection;
  }
  return merged;
}
