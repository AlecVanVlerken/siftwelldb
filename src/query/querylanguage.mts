// author: Frederik Caeyman & Matisse De Gauquier
//
// Public-facing facade for the QueryLanguage. The implementation is split
// across:
//
//   ast.mts          — type definitions
//   parser.mts       — `parse()` and the WHERE/HAVING expression parser
//   expressions.mts  — value parsing, WHERE evaluation, `LIKE`
//   aggregator.mts   — GROUP BY + aggregate compute
//   projection.mts   — SELECT-list projection (with AS aliases)
//   planner.mts      — field-equality + id-equality cursor specialisation
//   executor.mts     — pipelines that tie everything together
//
// This file is intentionally thin: it owns the class shape and the public
// type re-exports so existing callers (`import { QueryLanguage } from
// '.../querylanguage.mjs'`) keep working unchanged.
//
// Extended SQL-like surface:
//   SELECT [DISTINCT] <fields|*> FROM <collection>
//     [WHERE <conditions>]
//     [GROUP BY <fields>]
//     [HAVING <aggregate conditions>]
//     [ORDER BY <field> [ASC|DESC], ...]
//     [LIMIT n]
//     [OFFSET k]
//   INSERT INTO <collection> VALUES {id: '...', field: ...}
//   UPDATE <collection> SET f1 = v1 [, f2 = v2, ...] [WHERE <conditions>]
//   DELETE FROM <collection> [WHERE <conditions>]
//     [ORDER BY <field> [ASC|DESC], ...]
//     [LIMIT n]
//     [OFFSET k]
//
// WHERE/HAVING:
//   - Comparisons:  =, !=, >, >=, <, <=, LIKE, NOT LIKE
//   - Null check:   field IS NULL, field IS NOT NULL
//   - Set test:     field IN (v1, v2, ...), field NOT IN (v1, ...)
//   - Range test:   field BETWEEN low AND high, field NOT BETWEEN low AND high
//   - Negation:     NOT (expr)
//   - Logical:      AND, OR
//   - Parentheses to override precedence:  (a = 1 OR b = 2) AND c = 3
//
// GROUP BY aggregates: COUNT(*), COUNT(field), SUM, AVG, MIN, MAX —
//   each may take `DISTINCT field` to dedupe before aggregating.
//   SUM / AVG / MIN / MAX return query-result `null`
//   when the input set has no values, matching standard SQL.
// SELECT aliases:      `expr AS alias`  (also recognised in ORDER BY / HAVING)

import { SimpleDbms } from '../database/simpledbms.mjs';
import type { ParsedQuery, ParsedSelect, QueryResultRow } from './ast.mjs';
import { parse } from './parser.mjs';
import { executeParsed, executeOnRows, executeWithPreloadedRows } from './executor.mjs';

export type {
  QueryResultRow,
  ParsedQuery,
  ParsedSelect,
  ParsedInsert,
  ParsedUpdate,
  ParsedDelete,
  ParsedExplain,
  UpdateAssignment,
} from './ast.mjs';
export type {
  AggregateExpression,
  AggregateFunction,
  BetweenExpression,
  ComparisonExpression,
  ComparisonOperator,
  FieldSelector,
  GroupByClause,
  HavingExpression,
  InExpression,
  IsNullExpression,
  LogicalOperator,
  NotExpression,
  OrderByClause,
  SortDirection,
  WhereExpression,
} from './ast.mjs';

export class QueryLanguage {
  private dbms: SimpleDbms;

  constructor(dbms: SimpleDbms) {
    this.dbms = dbms;
  }

  parse(query: string): ParsedQuery {
    return parse(query);
  }

  async execute(query: string): Promise<QueryResultRow[]> {
    return executeParsed(this.dbms, parse(query));
  }

  /** Execute an already parsed statement without repeating syntax validation. */
  async executeParsed(query: ParsedQuery): Promise<QueryResultRow[]> {
    return executeParsed(this.dbms, query);
  }

  /**
   * Run the in-memory tail of a SELECT pipeline (`WHERE` → `GROUP BY`
   * → projection → `ORDER BY` → `OFFSET`/`LIMIT`) against rows that
   * were already loaded (and possibly enriched with derived fields).
   */
  executeOnRows(rows: QueryResultRow[], parsed: ParsedSelect): QueryResultRow[] {
    return executeOnRows(rows, parsed);
  }

  /**
   * Compatibility alias for callers that already preloaded the base rows.
   * Joins are not part of the current query language, so this is equivalent
   * to {@link executeOnRows}.
   */
  async executeWithPreloadedRows(preloadedRows: QueryResultRow[], parsed: ParsedSelect): Promise<QueryResultRow[]> {
    return executeWithPreloadedRows(this.dbms, preloadedRows, parsed);
  }
}
