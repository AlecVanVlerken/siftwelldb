// author: Frederik Caeyman & Matisse De Gauquier
// Value parsing, WHERE / HAVING evaluation, and the LIKE→RegExp helper.

import { type FieldValue } from '../database/document.mjs';
import type {
  BetweenExpression,
  ComparisonExpression,
  InExpression,
  IsNullExpression,
  WhereExpression,
} from './ast.mjs';

/**
 * Convert a SQL `LIKE` pattern to a case-insensitive `RegExp`.
 *
 *   `%`  → matches any sequence of characters (including none)
 *   `_`  → matches exactly one character
 *   All other regex metacharacters are escaped.
 */
export function likeToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Parse a literal value as it appears in a WHERE/HAVING comparison
 * or in the right-hand side of an `=` predicate.
 *
 * Accepts single/double-quoted strings, booleans (`true`/`false`,
 * case-insensitive) and numbers (including negative and decimal).
 * Anything else throws — we never silently coerce.
 */
export function parseValue(raw: string): FieldValue {
  const quoted = raw.match(/^'(.*)'$/) ?? raw.match(/^"(.*)"$/);
  if (quoted) return quoted[1];

  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';

  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

  throw new Error(`Unsupported value: "${raw}". Use numbers, booleans, or quoted strings.`);
}

/**
 * Three-way comparator used both by ORDER BY and by `>`/`<`/`>=`/`<=`.
 *
 * Strings compare by Unicode code point (`<` / `>`) rather than
 * `localeCompare` so results are **deterministic** across operating
 * systems, ICU versions, and runtime locales — a query run in a Dutch
 * locale produces the same row order as one run in en_US.
 *
 * Numbers compare numerically, booleans by 0/1. Mixed scalar types are
 * rejected instead of silently coerced; in a schemaless store, coercion
 * tends to hide bad data and produce surprising analytics.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === undefined && b === undefined) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return compareStringsByCodePoint(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);

  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
    throw new Error('Cannot compare complex objects in WHERE clause');
  }

  throw new Error(`Cannot compare values of different types: ${typeof a} and ${typeof b}`);
}

/**
 * Deterministic string comparison: -1 / 0 / 1 based on code-point order.
 *
 * Avoids `String.prototype.localeCompare` (locale-dependent, slow) and
 * `<` / `>` (which work on code units, not code points, so surrogate
 * pairs sort wrong). For ASCII this is identical to `<` / `>`.
 */
function compareStringsByCodePoint(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  while (true) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0)!;
    const bc = bn.value.codePointAt(0)!;
    if (ac !== bc) return ac - bc;
  }
}

function evaluateComparison(doc: Record<string, unknown>, expr: ComparisonExpression): boolean {
  const actual = doc[expr.field];
  const expected = expr.value;

  switch (expr.operator) {
    case '=':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>':
      if (actual === undefined || actual === null) return false;
      return compareValues(actual, expected) > 0;
    case '>=':
      if (actual === undefined || actual === null) return false;
      return compareValues(actual, expected) >= 0;
    case '<':
      if (actual === undefined || actual === null) return false;
      return compareValues(actual, expected) < 0;
    case '<=':
      if (actual === undefined || actual === null) return false;
      return compareValues(actual, expected) <= 0;
    case 'LIKE': {
      const re = expr.regex ?? likeToRegex(String(expected));
      return typeof actual === 'string' && re.test(actual);
    }
    case 'NOT LIKE': {
      const re = expr.regex ?? likeToRegex(String(expected));
      return typeof actual !== 'string' || !re.test(actual);
    }
    case 'CONTAINS': {
      const re = expr.regex ?? likeToRegex(`%${String(expected)}%`);
      return typeof actual === 'string' && re.test(actual);
    }
    default: {
      const exhaustiveCheck: never = expr.operator;
      throw new Error(`Unknown operator: ${String(exhaustiveCheck)}`);
    }
  }
}

function evaluateIsNull(doc: Record<string, unknown>, expr: IsNullExpression): boolean {
  const v = doc[expr.field];
  const isMissing = v === undefined || v === null;
  return expr.negated ? !isMissing : isMissing;
}

function evaluateIn(doc: Record<string, unknown>, expr: InExpression): boolean {
  const actual = doc[expr.field];
  const found = expr.values.some((v) => v === actual);
  return expr.negated ? !found : found;
}

function evaluateBetween(doc: Record<string, unknown>, expr: BetweenExpression): boolean {
  const actual = doc[expr.field];
  if (actual === undefined || actual === null) {
    // SQL semantics: NULL between anything is NULL → treated as false,
    // even when negated (so it stays out of the result either way).
    return false;
  }
  const inRange = compareValues(actual, expr.low) >= 0 && compareValues(actual, expr.high) <= 0;
  return expr.negated ? !inRange : inRange;
}

/**
 * Evaluate a WHERE/HAVING expression against a single row.
 *
 * Logical operators short-circuit: the right-hand side is only evaluated
 * when the left side cannot decide the outcome alone.
 */
export function evaluateWhere(doc: Record<string, unknown>, expr: WhereExpression): boolean {
  switch (expr.type) {
    case 'comparison':
      return evaluateComparison(doc, expr);
    case 'isnull':
      return evaluateIsNull(doc, expr);
    case 'in':
      return evaluateIn(doc, expr);
    case 'between':
      return evaluateBetween(doc, expr);
    case 'not':
      return !evaluateWhere(doc, expr.expr);
    case 'logical':
      if (expr.operator === 'AND') {
        return evaluateWhere(doc, expr.left) && evaluateWhere(doc, expr.right);
      }
      return evaluateWhere(doc, expr.left) || evaluateWhere(doc, expr.right);
    default: {
      const exhaustive: never = expr;
      throw new Error(`Unknown WHERE expression: ${String(exhaustive)}`);
    }
  }
}
