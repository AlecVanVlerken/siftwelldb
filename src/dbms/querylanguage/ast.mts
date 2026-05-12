// author: Frederik Caeyman & Matisse De Gauquier
// AST type definitions for the QueryLanguage. No runtime code lives here.

import { type FieldValue } from '../document.mjs';

export type QueryResultRow = Record<string, FieldValue | undefined>;

// ── WHERE Expression Types ───────────────────────────────────────────────────

export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'NOT LIKE';
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
 *
 * Subqueries are represented by `values: ParsedSelect`; the executor
 * runs them once up-front and turns the result into a Set.
 */
export type InExpression = {
  type: 'in';
  field: string;
  negated: boolean;
  values: FieldValue[] | ParsedSelect;
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

// ── JOIN Types ───────────────────────────────────────────────────────────────

/**
 * The three join modes the parser actually emits and the executor
 * actually implements:
 *
 *   - `INNER`: explicit `JOIN ... ON left = right` (and the bare
 *     `INNER JOIN ... ON ...` synonym). Yields one merged row per
 *     matching (left, right) pair.
 *   - `NATURAL`: `NATURAL JOIN ...` (no `ON`). Matches on every field
 *     name that appears on both sides; collapses those fields into one
 *     output column per match.
 *   - `CROSS`: `CROSS JOIN ...` (no `ON`). Cartesian product —
 *     intentionally noisy syntax so it can't be requested by accident.
 *
 * `LEFT`, `RIGHT`, and `FULL OUTER` joins are intentionally not in this
 * union: the executor doesn't emit unmatched rows on either side. Add
 * them here only once that's implemented.
 */
export type JoinType = 'INNER' | 'NATURAL' | 'CROSS';

export type JoinClause = {
  type: JoinType;
  collection: string;
  /** Field on the left side of an INNER `ON`. Empty for NATURAL / CROSS. */
  leftField: string;
  /** Field on the right side of an INNER `ON`. Empty for NATURAL / CROSS. */
  rightField: string;
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
  /** `SELECT DISTINCT ...` — dedupe the projected rows after WHERE/JOIN. */
  distinct?: boolean;
  /**
   * Join chain. Each entry joins the running result with one new
   * collection. Resolved left-to-right: `FROM A JOIN B JOIN C` means
   * `(A JOIN B) JOIN C`. Always present even for a single join — the
   * compatibility alias `.join` (singular) was removed when multi-join
   * support landed.
   */
  joins?: JoinClause[];
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

/**
 * `<select> UNION [ALL] <select> [UNION ...]` — concatenation of two or
 * more SELECTs with the same column shape.
 *
 *   - `UNION` deduplicates rows (per standard SQL).
 *   - `UNION ALL` keeps duplicates.
 *
 * The mode applies to every adjacent pair; we model it as a flat array
 * of branches with one mode flag because mixing UNION and UNION ALL in
 * one statement is rare and standard-ambiguous in SQL anyway.
 */
export type ParsedUnion = {
  kind: 'union';
  /** `true` for `UNION ALL` (keep duplicates), `false` for `UNION`. */
  all: boolean;
  branches: ParsedSelect[];
};

export type ParsedQuery =
  | ParsedSelect
  | ParsedInsert
  | ParsedDelete
  | ParsedUpdate
  | ParsedUnion;
