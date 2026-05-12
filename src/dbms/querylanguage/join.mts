// author: Frederik Caeyman & Matisse De Gauquier
// JOIN execution: streams the right side into memory once, then performs
// either an indexed (INNER/NATURAL) merge or a Cartesian product (FULL).

import type { SimpleDbms } from '../simpledbms.mjs';
import { type FieldValue } from '../document.mjs';
import type { JoinClause, ParsedSelect } from './ast.mjs';

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
  type: 'INNER' | 'NATURAL' | 'CROSS',
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
 * unfiltered, unprojected merged rows.
 *
 * The join type is taken from `join.type` — the parser is responsible
 * for picking it. No more silent NATURAL / CROSS inference here:
 *
 *   - `INNER`: hash the right side on `join.rightField`, probe per left
 *     row with `join.leftField`. O(L + R) build, O(L) probe.
 *   - `NATURAL`: discover the overlapping field names between the two
 *     sides at runtime; the first overlap is the join key. If there's
 *     no overlap, throws — `NATURAL JOIN` with no shared columns is
 *     never what the user meant.
 *   - `CROSS`: true Cartesian product, O(L · R).
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
  if (join.type === 'CROSS') {
    const results: Record<string, FieldValue>[] = [];
    for (const leftDoc of leftDocs) {
      for (const rightDoc of rightDocs) {
        results.push(mergeDocuments(leftDoc, rightDoc, leftCollName, rightCollName, 'CROSS', []));
      }
    }
    return results;
  }

  let leftKey: string;
  let rightKey: string;
  let mergeFields: string[];

  if (join.type === 'NATURAL') {
    const leftKeys = leftDocs.length > 0 ? Object.keys(leftDocs[0]) : [];
    const rightKeys = rightDocs.length > 0 ? Object.keys(rightDocs[0]) : [];
    const overlapping = leftKeys.filter((k) => rightKeys.includes(k));
    if (overlapping.length === 0) {
      throw new Error(
        `NATURAL JOIN ${rightCollName}: no overlapping field names between "${leftCollName}" and "${rightCollName}"`,
      );
    }
    leftKey = overlapping[0];
    rightKey = overlapping[0];
    mergeFields = overlapping;
  } else {
    leftKey = join.leftField.split('.').pop()!;
    rightKey = join.rightField.split('.').pop()!;
    mergeFields = [leftKey, rightKey];
  }

  const results: Record<string, FieldValue>[] = [];
  const rightMap = new Map<FieldValue, Record<string, FieldValue>[]>();
  for (const doc of rightDocs) {
    const val = doc[rightKey];
    const bucket = rightMap.get(val) ?? [];
    bucket.push(doc);
    rightMap.set(val, bucket);
  }

  for (const leftDoc of leftDocs) {
    const matches = rightMap.get(leftDoc[leftKey]) ?? [];
    for (const rightDoc of matches) {
      results.push(
        mergeDocuments(leftDoc, rightDoc, leftCollName, rightCollName, join.type, mergeFields),
      );
    }
  }
  return results;
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
