// author: Frederik Caeyman & Matisse De Gauquier
// AST type definitions for the QueryLanguage. No runtime code lives here.

import { type FieldValue } from '../document.mjs';

export type QueryResultRow = Record<string, FieldValue | undefined>;

// ── WHERE Expression Types ───────────────────────────────────────────────────

export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'NOT LIKE' | 'CONTAINS';
export type LogicalOperator = 'AND' | 'OR';

/**
 * Standard binary comparison: `field <op> value`.
 *
 * For `LIKE` / `NOT LIKE` the parser also precompiles the SQL pattern
 * into `regex` so per-row evaluation is regex-test only.
 */
export type ComparisonExpression = {
  type: 'comparison';
  field: string;
  operator: ComparisonOperator;
  value: FieldValue;
  regex?: RegExp;
};

/**
 * `field IS [NOT] NULL` — checks for absent / `null` / `undefined` values.
 */
export type IsNullExpression = {
  type: 'isnull';
  field: string;
  negated: boolean;
};

/**
 * `field [NOT] IN (v1, v2, ...)` — set membership.
 */
export type InExpression = {
  type: 'in';
  field: string;
  negated: boolean;
  values: FieldValue[];
};

/**
 * `field [NOT] BETWEEN low AND high` — inclusive range check.
 */
export type BetweenExpression = {
  type: 'between';
  field: string;
  negated: boolean;
  low: FieldValue;
  high: FieldValue;
};

/**
 * `NOT (expr)` — logical negation. Kept as its own node so it can wrap
 * any sub-expression (including nested NOTs) without forcing
 * De Morgan's law at parse time.
 */
export type NotExpression = {
  type: 'not';
  expr: WhereExpression;
};

export type LogicalExpression = {
  type: 'logical';
  operator: LogicalOperator;
  left: WhereExpression;
  right: WhereExpression;
};

export type WhereExpression =
  | ComparisonExpression
  | IsNullExpression
  | InExpression
  | BetweenExpression
  | NotExpression
  | LogicalExpression;
export type HavingExpression = WhereExpression;

// ── ORDER BY Types ───────────────────────────────────────────────────────────

export type SortDirection = 'ASC' | 'DESC';

export type OrderByClause = {
  field: string;
  direction: SortDirection;
};

// ── SELECT field selectors ───────────────────────────────────────────────────

/**
 * A single entry in the SELECT list. `expr` is the raw expression text
 * (e.g. `"name"`, `"COUNT(*)"`, `"AVG(salary)"`); `alias` is the explicit
 * output column name when `AS <name>` was provided.
 *
 * The output column is `alias ?? expr` — i.e. `SELECT name AS n` projects
 * into key `n`, while `SELECT name` projects into key `name`.
 */
export type FieldSelector = {
  expr: string;
  alias?: string;
};

// ── GROUP BY / Aggregates ────────────────────────────────────────────────────

export type AggregateFunction = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export type AggregateExpression = {
  func: AggregateFunction;
  field: string; // '*' only valid for COUNT
  /**
   * `COUNT(DISTINCT col)`, `AVG(DISTINCT col)`, etc. — deduplicate the
   * input column before aggregating. Has no effect when `field === '*'`
   * (which is only legal for COUNT and always counts every row).
   */
  distinct?: boolean;
  /**
   * Internal column name produced after aggregation. Always the canonical
   * `FUNC(field)` form (e.g. `"COUNT(*)"`) regardless of any `AS` alias —
   * the alias is applied later by `project()` via {@link FieldSelector}.
   */
  alias: string;
};

export type GroupByClause = {
  fields: string[];
  aggregates: AggregateExpression[];
};

// ── Parsed query shapes ──────────────────────────────────────────────────────

export type ParsedSelect = {
  kind: 'select';
  fields: '*' | FieldSelector[];
  collection: string;
  /** `SELECT DISTINCT ...` — dedupe the projected rows after WHERE. */
  distinct?: boolean;
  where?: WhereExpression;
  groupBy?: GroupByClause;
  having?: HavingExpression;
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
};

export type ParsedInsert = {
  kind: 'insert';
  collection: string;
  body: string;
};

export type ParsedDelete = {
  kind: 'delete';
  collection: string;
  where?: WhereExpression;
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
};

/**
 * A single `field = value` assignment in an UPDATE statement. The RHS
 * is always a literal — UPDATE expressions referencing other fields
 * (e.g. `salary = salary * 1.1`) are intentionally not supported.
 */
export type UpdateAssignment = {
  field: string;
  value: FieldValue;
};

export type ParsedUpdate = {
  kind: 'update';
  collection: string;
  assignments: UpdateAssignment[];
  where?: WhereExpression;
};

export type ParsedExplain = {
  kind: 'explain';
  query: ParsedSelect;
};

export type ParsedQuery = ParsedSelect | ParsedInsert | ParsedDelete | ParsedUpdate | ParsedExplain;
