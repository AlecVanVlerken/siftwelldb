// author: Frederik Caeyman & Matisse De Gauquier
// SELECT / INSERT / DELETE execution pipeline + helpers shared by both
// the disk-backed `execute()` path and the in-memory `executeOnRows()` path.

import type { SimpleDbms } from '../simpledbms.mjs';
import { type FieldValue } from '../document.mjs';
import type {
  HavingExpression,
  OrderByClause,
  ParsedQuery,
  ParsedSelect,
  QueryResultRow,
  WhereExpression,
} from './ast.mjs';
import { compareValues, evaluateWhere } from './expressions.mjs';
import { executeGroupBy } from './aggregator.mjs';
import { executeJoinChain, loadCollection } from './join.mjs';
import { project } from './projection.mjs';
import { planCursor } from './planner.mjs';
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

/**
 * Apply the in-memory tail of the SELECT pipeline:
 * `WHERE → GROUP BY → project → ORDER BY → OFFSET/LIMIT`.
 *
 * Exposed as a public surface so callers (e.g. the conversational engine)
 * can inject derived/computed fields *before* running a query, without
 * re-implementing the post-load stages.
 */
export function executeOnRows(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  let results = parsed.where
    ? rows.filter((r) => evaluateWhere(r as Record<string, FieldValue>, parsed.where!))
    : rows;

  if (parsed.groupBy) {
    results = executeGroupBy(results, parsed.groupBy, parsed.having);
  }
  results = results.map((row) => project(row as Record<string, FieldValue>, parsed.fields));

  if (parsed.distinct) {
    results = dedupeRows(results);
  }

  if (parsed.orderBy && parsed.orderBy.length > 0) {
    results = sortResults(results, parsed.orderBy);
  }

  return sliceOffsetLimit(results, parsed.offset, parsed.limit);
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
 * Like {@link executeOnRows} but also handles JOIN by loading the right
 * side from the DBMS on demand. Use this when the caller has pre-loaded
 * (and possibly enriched) the *left* collection.
 */
export async function executeWithPreloadedRows(
  dbms: SimpleDbms,
  preloadedRows: QueryResultRow[],
  parsed: ParsedSelect,
): Promise<QueryResultRow[]> {
  if (parsed.joins && parsed.joins.length > 0) {
    // Single or chained joins go through the same path: fold every
    // right side into the running result, then run the in-memory
    // pipeline (WHERE → GROUP BY → project → DISTINCT → ORDER BY →
    // OFFSET/LIMIT). A previous single-join shortcut silently dropped
    // DISTINCT / ORDER BY / LIMIT / OFFSET — fixed by unifying the
    // code path.
    const merged = await executeJoinChain(dbms, parsed, preloadedRows as Record<string, FieldValue>[]);
    return executeOnRows(merged as QueryResultRow[], parsed);
  }
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

/**
 * Walk a WHERE/HAVING tree and execute every `field IN (SELECT ...)`
 * subquery in place. The subquery's first column is collected into a
 * value list and stored on the InExpression — the per-row evaluator
 * never has to touch the database.
 *
 * This is run exactly once per query, before any filtering. The cost
 * is O(N subqueries × subquery size); each subquery is materialised in
 * full, which is the standard "uncorrelated subquery" execution model.
 *
 * Returns the same expression with every subquery resolved. The AST is
 * mutated in place — it's only consumed once per execute() call.
 */
async function materializeSubqueries(
  dbms: SimpleDbms,
  expr: WhereExpression | undefined,
): Promise<WhereExpression | undefined> {
  if (!expr) return expr;
  switch (expr.type) {
    case 'in':
      if (!Array.isArray(expr.values)) {
        const sub = await executeParsed(dbms, expr.values);
        const cols = sub.length > 0 ? Object.keys(sub[0]) : [];
        if (cols.length !== 1) {
          throw new Error(
            `Subquery for "${expr.field} IN (...)" must project exactly one column (got ${cols.length})`,
          );
        }
        const col = cols[0];
        const values: FieldValue[] = [];
        for (const row of sub) {
          const v = row[col];
          if (v === undefined || v === null) continue;
          values.push(v);
        }
        expr.values = values;
      }
      return expr;
    case 'not':
      expr.expr = (await materializeSubqueries(dbms, expr.expr))!;
      return expr;
    case 'logical':
      expr.left = (await materializeSubqueries(dbms, expr.left))!;
      expr.right = (await materializeSubqueries(dbms, expr.right))!;
      return expr;
    case 'comparison':
    case 'isnull':
    case 'between':
      return expr;
  }
}

async function materializeAllSubqueries(dbms: SimpleDbms, parsed: ParsedSelect | { where?: WhereExpression; having?: HavingExpression }): Promise<void> {
  const p = parsed as { where?: WhereExpression; having?: HavingExpression };
  p.where = await materializeSubqueries(dbms, p.where);
  p.having = (await materializeSubqueries(dbms, p.having)) as HavingExpression | undefined;
}

export async function executeParsed(dbms: SimpleDbms, parsed: ParsedQuery): Promise<QueryResultRow[]> {
  if (parsed.kind === 'union') {
    const merged: QueryResultRow[] = [];
    for (const branch of parsed.branches) {
      const rows = await executeParsed(dbms, branch);
      for (const row of rows) merged.push(row);
    }
    return parsed.all ? merged : dedupeRows(merged);
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
    await materializeAllSubqueries(dbms, parsed);
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
    await materializeAllSubqueries(dbms, parsed);
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
  await materializeAllSubqueries(dbms, parsed);
  if (parsed.joins && parsed.joins.length > 0) {
    const baseDocs = await loadCollection(dbms, parsed.collection);
    const merged = await executeJoinChain(dbms, parsed, baseDocs);
    // Run the in-memory pipeline (WHERE → GROUP BY → project → DISTINCT
    // → ORDER BY → OFFSET/LIMIT) over the merged rows — same code path
    // as the JOIN-less case below, so feature support is uniform.
    return executeOnRows(merged as QueryResultRow[], parsed);
  }

  const plan = planCursor(parsed.where);
  const cursor = openPlannedCursor(dbms, parsed.collection, plan);

  const collected: QueryResultRow[] = [];
  for await (const jsonDoc of cursor) {
    const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;
    if (parsed.where && !evaluateWhere(doc, parsed.where)) continue;
    // When grouping we postpone projection so aggregates can see the full row.
    collected.push(parsed.groupBy ? doc : project(doc, parsed.fields));
  }

  return finalize(collected, parsed);
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
function finalize(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  let results = rows;
  if (parsed.groupBy) {
    results = executeGroupBy(results, parsed.groupBy, parsed.having);
    results = results.map((row) => project(row as Record<string, FieldValue>, parsed.fields));
  }
  if (parsed.distinct) {
    results = dedupeRows(results);
  }
  if (parsed.orderBy && parsed.orderBy.length > 0) {
    results = sortResults(results, parsed.orderBy);
  }
  return sliceOffsetLimit(results, parsed.offset, parsed.limit);
}
