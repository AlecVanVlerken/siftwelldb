// author: Frederik Caeyman & Matisse De Gauquier
// Value parsing, WHERE / HAVING evaluation, and the LIKE→RegExp helper.

import { type FieldValue } from '../document.mjs';
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
 * Numbers compare numerically, strings via `localeCompare`, booleans by
 * 0/1. Mixed types fall back to a stringified comparison so the engine
 * never silently returns 0 for unrelated values. Complex objects throw —
 * indexable fields are always scalar so this should never trigger in
 * a healthy query.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === undefined && b === undefined) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);

  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
    throw new Error('Cannot compare complex objects in WHERE clause');
  }

  const toComparableString = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      const json = JSON.stringify(v);
      if (json !== undefined) return json;
    } catch {
      // fall through
    }
    return String(v);
  };
  return toComparableString(a).localeCompare(toComparableString(b));
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
      return compareValues(actual, expected) > 0;
    case '>=':
      return compareValues(actual, expected) >= 0;
    case '<':
      return compareValues(actual, expected) < 0;
    case '<=':
      return compareValues(actual, expected) <= 0;
    case 'LIKE': {
      const re = expr.regex ?? likeToRegex(String(expected));
      return typeof actual === 'string' && re.test(actual);
    }
    case 'NOT LIKE': {
      const re = expr.regex ?? likeToRegex(String(expected));
      return typeof actual !== 'string' || !re.test(actual);
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
  if (!Array.isArray(expr.values)) {
    // Subquery still holds its ParsedSelect AST — the executor must
    // pre-resolve it before calling evaluateWhere(). If we ever reach
    // here, the subquery wasn't lowered, which is a bug.
    throw new Error(`IN subquery for "${expr.field}" was not pre-resolved by the executor`);
  }
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
