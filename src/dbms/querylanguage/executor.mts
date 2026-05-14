// author: Frederik Caeyman & Matisse De Gauquier
// SELECT / INSERT / DELETE execution pipeline + helpers shared by both
// the disk-backed `execute()` path and the in-memory `executeOnRows()` path.

import type { SimpleDbms } from '../simpledbms.mjs';
import { type FieldValue } from '../document.mjs';
import type {
  OrderByClause,
  ParsedQuery,
  ParsedSelect,
  QueryResultRow,
} from './ast.mjs';
import { compareValues, evaluateWhere } from './expressions.mjs';
import { executeGroupBy } from './aggregator.mjs';
import { project } from './projection.mjs';
import { planCursor, type CursorPlan } from './planner.mjs';
import { parse } from './parser.mjs';

/**
 * Stable, multi-key sort. Uses {@link compareValues} so ORDER BY follows
 * the same type-coercion rules as `>`/`<`/`>=`/`<=`.
 */
export function sortResults(rows: QueryResultRow[], orderBy: OrderByClause[]): QueryResultRow[] {
  return [...rows].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const cmp = compareValues(a[field], b[field]);
      if (cmp !== 0) return direction === 'DESC' ? -cmp : cmp;
    }
    return 0;
  });
}

function resolveOrderField(field: string, parsed: ParsedSelect): string {
  if (parsed.fields === '*') return field;
  return parsed.fields.find((f) => f.alias === field)?.expr ?? field;
}

function sortForSelect(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  if (!parsed.orderBy || parsed.orderBy.length === 0) return rows;
  const resolved = parsed.orderBy.map((o) => ({ ...o, field: resolveOrderField(o.field, parsed) }));
  return sortResults(rows, resolved);
}

/**
 * Apply the in-memory tail of the SELECT pipeline:
 * `WHERE → GROUP BY → project → ORDER BY → OFFSET/LIMIT`.
 *
 * Exposed as a public surface so callers (e.g. the conversational engine)
 * can inject derived/computed fields *before* running a query, without
 * re-implementing the post-load stages.
 */
export function executeOnRows(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  return runSelectPipeline(rows, parsed);
}

/**
 * Best-effort extraction of `id` from an INSERT body. The body is the
 * raw JavaScript-ish object literal from the source — we run it through
 * a permissive regex rather than depending on a JSON5 parser. Returns
 * `undefined` when no quoted `id: "..."` field is found; the caller
 * then reports `rowCount: 0` for that INSERT.
 */
function extractIdFromInsertBody(body: string): string | undefined {
  const m = body.match(/['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/);
  return m?.[1];
}

/**
 * Deduplicate projected rows for `SELECT DISTINCT`. Rows are considered
 * equal when their column-name → value pairs serialise identically.
 *
 * Stable: the first occurrence of each unique row is kept.
 */
function dedupeRows(rows: QueryResultRow[]): QueryResultRow[] {
  const seen = new Set<string>();
  const out: QueryResultRow[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row, Object.keys(row).sort());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Kept for existing callers that pre-load a collection before executing
 * the in-memory tail of a SELECT. Joins are no longer part of the
 * supported query language, so this is now equivalent to executeOnRows().
 */
export async function executeWithPreloadedRows(
  _dbms: SimpleDbms,
  preloadedRows: QueryResultRow[],
  parsed: ParsedSelect,
): Promise<QueryResultRow[]> {
  return executeOnRows(preloadedRows, parsed);
}

function sliceOffsetLimit(rows: QueryResultRow[], offset?: number, limit?: number): QueryResultRow[] {
  const o = offset ?? 0;
  const l = limit ?? Infinity;
  return rows.slice(o, o === 0 && l === Infinity ? undefined : o + l);
}

/**
 * Public entry point. Parses the query string and dispatches to the
 * SELECT / INSERT / DELETE pipeline. INSERT and DELETE return an empty
 * row array.
 */
export async function execute(dbms: SimpleDbms, query: string): Promise<QueryResultRow[]> {
  const parsed = parse(query);
  return executeParsed(dbms, parsed);
}

export async function executeParsed(dbms: SimpleDbms, parsed: ParsedQuery): Promise<QueryResultRow[]> {
  if (parsed.kind === 'explain') {
    return explainSelect(dbms, parsed.query);
  }

  if (parsed.kind === 'insert') {
    await dbms.insertDocument(parsed.collection, parsed.body);
    // Mutating ops return one `{id}` row per affected document so that
    // `rows.length` reflects the affected-row count uniformly across
    // SELECT / INSERT / UPDATE / DELETE.
    const insertedId = extractIdFromInsertBody(parsed.body);
    return insertedId ? [{ id: insertedId }] : [];
  }

  if (parsed.kind === 'delete') {
    const cursor = dbms.cursor(parsed.collection, 'id', undefined);
    const idsToDelete: string[] = [];
    for await (const jsonDoc of cursor) {
      const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;
      if (!parsed.where || evaluateWhere(doc, parsed.where)) {
        if (typeof doc['id'] === 'string') idsToDelete.push(doc['id']);
      }
    }
    for (const id of idsToDelete) {
      await dbms.deleteDocumentById(parsed.collection, id);
    }
    return idsToDelete.map((id) => ({ id }));
  }

  if (parsed.kind === 'update') {
    // Two passes: (1) snapshot ids of matching rows so the in-flight
    // cursor never sees its own writes; (2) apply each assignment per
    // id. `editDocument` is one-field-at-a-time, so the cost is
    // O(matches × assignments) calls — acceptable for the row counts
    // SimpleDBMS targets and keeps the write path identical to the
    // existing per-field path on the back-end.
    const cursor = dbms.cursor(parsed.collection, 'id', undefined);
    const idsToUpdate: string[] = [];
    for await (const jsonDoc of cursor) {
      const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;
      if (parsed.where && !evaluateWhere(doc, parsed.where)) continue;
      if (typeof doc['id'] !== 'string') continue;
      idsToUpdate.push(doc['id']);
    }
    for (const id of idsToUpdate) {
      for (const { field, value } of parsed.assignments) {
        await dbms.editDocument(parsed.collection, id, field, value);
      }
    }
    return idsToUpdate.map((id) => ({ id }));
  }

  // ── SELECT ────────────────────────────────────────────────────────────────
  const plan = planCursor(parsed.where);
  const cursor = openPlannedCursor(dbms, parsed.collection, plan);

  const collected: QueryResultRow[] = [];
  for await (const jsonDoc of cursor) {
    const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;
    collected.push(doc);
  }

  return runSelectPipeline(collected, parsed);
}

/**
 * Open the cursor described by a {@link CursorPlan}. The planner picks
 * the shape; here is where it lands on the actual back-end call.
 */
function openPlannedCursor(
  dbms: SimpleDbms,
  collection: string,
  plan: ReturnType<typeof planCursor>,
): AsyncIterable<string> {
  switch (plan.kind) {
    case 'fullScan':
      return dbms.cursor(collection, 'id', undefined);
    case 'idEquality':
      // The B+ tree iterate-from-key keeps yielding past the matching
      // row — we still rely on the WHERE filter to discard everything
      // after the first hit. (Could be tightened with cursorEqual on
      // `id` if it becomes a hot path.)
      return dbms.cursor(collection, 'id', plan.value);
    case 'fieldEquality':
      return dbms.cursorEqual(collection, plan.field, plan.value);
  }
}

/**
 * Apply the post-load stages that the disk-backed SELECT path skipped:
 * group/aggregate (if requested), project grouped rows, sort, and
 * slice for OFFSET/LIMIT.
 */
function runSelectPipeline(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  let filtered = parsed.where
    ? rows.filter((r) => evaluateWhere(r as Record<string, FieldValue>, parsed.where!))
    : rows;

  if (parsed.groupBy) {
    filtered = executeGroupBy(filtered, parsed.groupBy, parsed.having);
    filtered = sortForSelect(filtered, parsed);
    const projected = filtered.map((row) => project(row as Record<string, FieldValue>, parsed.fields));
    const distinct = parsed.distinct ? dedupeRows(projected) : projected;
    return sliceOffsetLimit(distinct, parsed.offset, parsed.limit);
  }

  if (parsed.distinct) {
    let projected = filtered.map((row) => project(row as Record<string, FieldValue>, parsed.fields));
    projected = dedupeRows(projected);
    if (parsed.orderBy && parsed.orderBy.length > 0) {
      projected = sortResults(projected, parsed.orderBy);
    }
    return sliceOffsetLimit(projected, parsed.offset, parsed.limit);
  }

  filtered = sortForSelect(filtered, parsed);
  filtered = sliceOffsetLimit(filtered, parsed.offset, parsed.limit);
  return filtered.map((row) => project(row as Record<string, FieldValue>, parsed.fields));
}

function explainSelect(dbms: SimpleDbms, parsed: ParsedSelect): QueryResultRow[] {
  const plan = planCursor(parsed.where);
  const rows: QueryResultRow[] = [];
  rows.push({ stage: 'collection', detail: parsed.collection });
  rows.push({ stage: 'scan', detail: describeScan(dbms, parsed.collection, plan) });
  if (parsed.where) rows.push({ stage: 'filter', detail: 'row predicate evaluation' });
  if (parsed.groupBy) rows.push({ stage: 'group', detail: `in memory by ${parsed.groupBy.fields.join(', ') || '(global)'}` });
  if (parsed.orderBy && parsed.orderBy.length > 0) {
    rows.push({ stage: 'sort', detail: `in memory by ${parsed.orderBy.map((o) => `${o.field} ${o.direction}`).join(', ')}` });
  }
  if (parsed.distinct) rows.push({ stage: 'distinct', detail: 'dedupe projected rows' });
  if (parsed.limit !== undefined || parsed.offset !== undefined) {
    rows.push({ stage: 'slice', detail: `offset ${parsed.offset ?? 0}, limit ${parsed.limit ?? 'all'}` });
  }
  return rows;
}

function describeScan(dbms: SimpleDbms, collection: string, plan: CursorPlan): string {
  switch (plan.kind) {
    case 'fullScan':
      return 'full scan over id index';
    case 'idEquality':
      return `primary id index equality (${String(plan.value)})`;
    case 'fieldEquality': {
      const indexed = dbms.describeCollection(collection).some((f) => f.name === plan.field);
      return indexed
        ? `secondary index equality on ${plan.field} (${String(plan.value)})`
        : `full scan over id index; ${plan.field} is not indexed`;
    }
  }
}
