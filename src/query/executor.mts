import type { SimpleDbms } from '../database/simpledbms.mjs';
import type { RawId } from '../database/document.mjs';
import type { OrderByClause, ParsedQuery, ParsedSelect, QueryResultRow } from './ast.mjs';
import { compareValues, evaluateWhere } from './expressions.mjs';
import { executeGroupBy, GroupAggregator } from './aggregator.mjs';
import { project } from './projection.mjs';
import { planCursor, type CursorPlan } from './planner.mjs';

function sortResults(rows: QueryResultRow[], orderBy: OrderByClause[]): QueryResultRow[] {
  return [...rows].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const cmp = compareValues(
        Object.hasOwn(a, field) ? a[field] : undefined,
        Object.hasOwn(b, field) ? b[field] : undefined,
      );
      if (cmp !== 0) return direction === 'DESC' ? -cmp : cmp;
    }
    return 0;
  });
}
function sortForSelect(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  if (!parsed.orderBy) return rows;
  const fields = parsed.fields;
  const order = parsed.orderBy.map((o) => ({
    ...o,
    field: fields === '*' ? o.field : (fields.find((f) => f.alias === o.field)?.expr ?? o.field),
  }));
  return sortResults(rows, order);
}
function dedupeRows(rows: QueryResultRow[]): QueryResultRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row, Object.keys(row).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function slice(rows: QueryResultRow[], parsed: { offset?: number; limit?: number }): QueryResultRow[] {
  const offset = parsed.offset ?? 0;
  return rows.slice(offset, parsed.limit === undefined ? undefined : offset + parsed.limit);
}
function finishSelect(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  if (parsed.distinct && !parsed.groupBy) {
    let result = dedupeRows(rows.map((row) => project(row, parsed.fields)));
    if (parsed.orderBy) result = sortResults(result, parsed.orderBy);
    return slice(result, parsed);
  }
  const sorted = sortForSelect(rows, parsed);
  if (parsed.distinct) return slice(dedupeRows(sorted.map((row) => project(row, parsed.fields))), parsed);
  return slice(sorted, parsed).map((row) => project(row, parsed.fields));
}
export function executeOnRows(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
  const matching = parsed.where ? rows.filter((row) => evaluateWhere(row, parsed.where!)) : rows;
  return finishSelect(parsed.groupBy ? executeGroupBy(matching, parsed.groupBy, parsed.having) : matching, parsed);
}
export function executeWithPreloadedRows(
  _dbms: SimpleDbms,
  rows: QueryResultRow[],
  parsed: ParsedSelect,
): Promise<QueryResultRow[]> {
  return Promise.resolve(executeOnRows(rows, parsed));
}

async function* openCursor(dbms: SimpleDbms, collection: string, plan: CursorPlan): AsyncGenerator<QueryResultRow> {
  if (plan.kind === 'idEquality') {
    // cursorEqual terminates after the exact primary-key match, including misses.
    for await (const json of dbms.cursorEqual(collection, 'id', plan.value)) yield JSON.parse(json) as QueryResultRow;
    return;
  }
  if (plan.kind === 'fieldEquality') {
    for await (const json of dbms.cursorEqual(collection, plan.field, plan.value))
      yield JSON.parse(json) as QueryResultRow;
    return;
  }
  const cursor = dbms.cursor(
    collection,
    plan.kind === 'range' ? plan.field : 'id',
    plan.kind === 'range' ? plan.lower : undefined,
  );
  for await (const json of cursor) {
    const row = JSON.parse(json) as QueryResultRow;
    if (plan.kind === 'range') {
      if (plan.upper !== undefined) {
        const cmp = compareValues(row[plan.field], plan.upper);
        if (cmp > 0 || (cmp === 0 && !plan.upperInclusive)) break;
      }
      if (plan.lower !== undefined && !plan.lowerInclusive && compareValues(row[plan.field], plan.lower) === 0)
        continue;
    }
    yield row;
  }
}

/** Late failures can leave prior documents staged; report their identities. */
export class QueryMutationError extends Error {
  constructor(
    kind: string,
    readonly affectedIds: RawId[],
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `${kind.toUpperCase()} failed after ${affectedIds.length} document(s) completed: ${message}. Partial changes may be staged; discard this session and reopen the last committed database.`,
      { cause },
    );
    this.name = 'QueryMutationError';
  }
}

export async function executeParsed(dbms: SimpleDbms, parsed: ParsedQuery): Promise<QueryResultRow[]> {
  if (parsed.kind === 'explain') return explainSelect(dbms, parsed.query);
  if (parsed.kind === 'insert') {
    dbms.validateDocument(parsed.collection, parsed.document);
    await dbms.insertDocumentObject(parsed.collection, parsed.document);
    return [{ id: parsed.document['id'] }];
  }
  if (!dbms.listCollections().includes(parsed.collection)) throw new Error('Collection does not exist');
  const plan = planCursor(parsed.where, dbms, parsed.collection);
  if (parsed.kind === 'update' || parsed.kind === 'delete') {
    let documents: QueryResultRow[] = [];
    for await (const row of openCursor(dbms, parsed.collection, plan)) {
      if (!parsed.where || evaluateWhere(row, parsed.where)) documents.push(row);
    }
    if (parsed.kind === 'delete') {
      documents = slice(sortResults(documents, parsed.orderBy ?? [{ field: 'id', direction: 'ASC' }]), parsed);
    } else {
      // Preflight every final document before changing the first document.
      const finalDocuments: QueryResultRow[] = [];
      for (const candidate of documents) {
        // JSON cursors intentionally represent Buffers as base64. Read the
        // original decoded values so untouched binary fields retain their type.
        const original = await dbms.getDocumentObjectById(parsed.collection, candidate['id'] as RawId);
        const final = { ...original };
        for (const { field, value } of parsed.assignments) {
          if (field === 'id' || !Object.hasOwn(original, field))
            throw new Error(`Field ${field} cannot be edited on this document`);
          final[field] = value;
        }
        dbms.validateDocument(parsed.collection, final);
        finalDocuments.push(final);
      }
      documents = finalDocuments;
    }
    const affectedIds: RawId[] = [];
    try {
      for (const document of documents) {
        const id = document['id'] as RawId;
        if (parsed.kind === 'delete') await dbms.deleteDocumentById(parsed.collection, id);
        else await dbms.replaceDocument(parsed.collection, id, document, { preserveCompression: true });
        affectedIds.push(id);
      }
    } catch (error) {
      throw new QueryMutationError(parsed.kind, affectedIds, error);
    }
    return affectedIds.map((id) => ({ id }));
  }
  if (parsed.limit === 0) return [];
  const streaming = !parsed.orderBy && !parsed.groupBy && !parsed.distinct;
  const group = parsed.groupBy ? new GroupAggregator(parsed.groupBy, parsed.having) : undefined;
  const rows: QueryResultRow[] = [];
  let skipped = 0;
  for await (const row of openCursor(dbms, parsed.collection, plan)) {
    if (parsed.where && !evaluateWhere(row, parsed.where)) continue;
    if (group) group.add(row);
    else if (streaming) {
      if (skipped++ < (parsed.offset ?? 0)) continue;
      rows.push(project(row, parsed.fields));
      if (rows.length === parsed.limit) break;
    } else rows.push(row);
  }
  return streaming ? rows : finishSelect(group ? group.finish() : rows, parsed);
}

function explainSelect(dbms: SimpleDbms, parsed: ParsedSelect): QueryResultRow[] {
  const plan = planCursor(parsed.where, dbms, parsed.collection);
  let detail: string;
  if (parsed.limit === 0)
    return [
      { stage: 'collection', detail: parsed.collection },
      { stage: 'scan', detail: 'no document reads (LIMIT 0)' },
    ];
  if (plan.kind === 'idEquality') detail = `exact primary id lookup (${String(plan.value)})`;
  else if (plan.kind === 'fieldEquality') detail = `secondary index equality on ${plan.field} (${String(plan.value)})`;
  else if (plan.kind === 'range')
    detail = `bounded index range on ${plan.field}: ${plan.lowerInclusive ? '[' : '('}${plan.lower ?? '-infinity'}, ${plan.upper ?? 'infinity'}${plan.upperInclusive ? ']' : ')'}`;
  else detail = 'full scan over id index (no compatible index predicate)';
  const rows: QueryResultRow[] = [
    { stage: 'collection', detail: parsed.collection },
    { stage: 'scan', detail },
  ];
  if (parsed.where) rows.push({ stage: 'filter', detail: 'evaluate complete row predicate' });
  if (parsed.groupBy)
    rows.push({
      stage: 'group',
      detail: `incremental aggregate state by ${parsed.groupBy.fields.join(', ') || '(global)'}`,
    });
  if (parsed.having) rows.push({ stage: 'having', detail: 'filter aggregate rows' });
  const sort = {
    stage: 'sort',
    detail: `in memory by ${parsed.orderBy?.map((o) => `${o.field} ${o.direction}`).join(', ')}`,
  };
  if (parsed.orderBy && !(parsed.distinct && !parsed.groupBy)) rows.push(sort);
  const projection = {
    stage: 'project',
    detail: parsed.fields === '*' ? 'all document fields' : 'selected columns and aliases',
  };
  if (parsed.distinct) rows.push(projection);
  if (parsed.distinct) rows.push({ stage: 'distinct', detail: 'dedupe projected rows before slicing' });
  if (parsed.orderBy && parsed.distinct && !parsed.groupBy) rows.push(sort);
  if (parsed.limit !== undefined || parsed.offset !== undefined)
    rows.push({
      stage: 'slice',
      detail: `offset ${parsed.offset ?? 0}, limit ${parsed.limit ?? 'all'}${!parsed.orderBy && !parsed.groupBy && !parsed.distinct ? '; stop cursor early' : ''}`,
    });
  if (!parsed.distinct) rows.push(projection);
  return rows;
}
