// author: Frederik Caeyman
// date: 2026-02-17

import { SimpleDbms } from '../simpledbms.mjs';
import { type FieldValue } from '../document.mjs';

export type QueryResultRow = Record<string, FieldValue | undefined>;

// ── WHERE Expression Types ───────────────────────────────────────────────────

type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';
type LogicalOperator = 'AND' | 'OR';

type ComparisonExpression = {
  type: 'comparison';
  field: string;
  operator: ComparisonOperator;
  value: FieldValue;
};

type LogicalExpression = {
  type: 'logical';
  operator: LogicalOperator;
  left: WhereExpression;
  right: WhereExpression;
};

type WhereExpression = ComparisonExpression | LogicalExpression;

// ── Query Types ──────────────────────────────────────────────────────────────

type ParsedSelect = {
  kind: 'select';
  fields: '*' | string[];
  collection: string;
  where?: WhereExpression;
  limit?: number;
  offset?: number;
};

type ParsedInsert = {
  kind: 'insert';
  collection: string;
  body: string;
};

export type ParsedQuery = ParsedSelect | ParsedInsert;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended SQL-like query language that supports:
 *   SELECT <fields|*> FROM <collection> [WHERE <conditions>] [LIMIT n] [OFFSET k]
 *   INSERT INTO <collection> VALUES {id: '...', field: ...}
 *
 * WHERE now supports:
 *   - Comparison: =, !=, >, >=, <, <=
 *   - Logical: AND, OR
 *   - Examples:
 *     WHERE age > 25
 *     WHERE age >= 18 AND active = true
 *     WHERE country = 'Belgium' OR country = 'Netherlands'
 */
export class QueryLanguage {
  private dbms: SimpleDbms;

  constructor(dbms: SimpleDbms) {
    this.dbms = dbms;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PARSING
  // ═════════════════════════════════════════════════════════════════════════════

  parse(query: string): ParsedQuery {
    const normalized = query.trim().replace(/;$/, '').trim();

    // ── INSERT ─────────────────────────────────────────────────────────────────
    const insertMatch = normalized.match(/^insert\s+into\s+([A-Za-z_][A-Za-z0-9_]*)\s+values\s+(.+)$/i);
    if (insertMatch) {
      const [, collection, rawBody] = insertMatch;
      const body = rawBody.trim();
      if (!body.startsWith('{') || !body.endsWith('}')) {
        throw new Error('INSERT body must be an object literal in braces');
      }
      return { kind: 'insert', collection, body };
    }

    // ── SELECT ─────────────────────────────────────────────────────────────────
    // Pattern: SELECT <fields> FROM <collection> [WHERE <expr>] [LIMIT n] [OFFSET k]
    const selectMatch = normalized.match(
      /^select\s+(.+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:where\s+(.+?))?(?:\s+limit\s+(\d+))?(?:\s+offset\s+(\d+))?$/i,
    );

    if (!selectMatch) {
      throw new Error('Invalid query. Use SELECT <fields> FROM <collection> [WHERE conditions] [LIMIT n] [OFFSET k]');
    }

    const [, selectPartRaw, collection, wherePartRaw, limitStr, offsetStr] = selectMatch;

    const fields = this.parseFields(selectPartRaw.trim());
    const where = wherePartRaw ? this.parseWhere(wherePartRaw.trim()) : undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;

    return { kind: 'select', fields, collection, where, limit, offset };
  }

  // ── Parse SELECT fields ────────────────────────────────────────────────────

  private parseFields(selectPart: string): '*' | string[] {
    if (selectPart === '*') return '*';

    const fieldNames = selectPart
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);

    if (fieldNames.length === 0) {
      throw new Error('SELECT clause must list at least one field or *');
    }

    return fieldNames;
  }

  // ── Parse WHERE clause ─────────────────────────────────────────────────────

  private parseWhere(wherePart: string): WhereExpression {
    // Strategy: Parse OR first (lowest precedence), then AND, then comparisons
    return this.parseOrExpression(wherePart);
  }

  private parseOrExpression(expr: string): WhereExpression {
    // Split on OR (case-insensitive), but not inside quotes
    const parts = this.splitOnKeyword(expr, 'OR');

    if (parts.length === 1) {
      return this.parseAndExpression(parts[0]);
    }

    // Build left-associative tree: a OR b OR c → ((a OR b) OR c)
    let result = this.parseAndExpression(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      result = {
        type: 'logical',
        operator: 'OR',
        left: result,
        right: this.parseAndExpression(parts[i]),
      };
    }
    return result;
  }

  private parseAndExpression(expr: string): WhereExpression {
    const parts = this.splitOnKeyword(expr, 'AND');

    if (parts.length === 1) {
      return this.parseComparison(parts[0]);
    }

    let result: WhereExpression = this.parseComparison(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      result = {
        type: 'logical',
        operator: 'AND',
        left: result,
        right: this.parseComparison(parts[i]),
      };
    }
    return result;
  }

  private parseComparison(expr: string): ComparisonExpression {
    expr = expr.trim();

    // Match: field <operator> value
    // Operators: >=, <=, !=, =, >, <
    const match = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|=|>|<)\s*(.+)$/);

    if (!match) {
      throw new Error(`Invalid WHERE comparison: "${expr}". Expected format: field <operator> value`);
    }

    const [, field, operator, rawValue] = match;
    const value = this.parseValue(rawValue.trim());

    return {
      type: 'comparison',
      field,
      operator: operator as ComparisonOperator,
      value,
    };
  }

  /**
   * Split a string on a keyword (AND/OR), but ignore keywords inside quotes.
   * Example: "age > 18 AND name = 'Alice AND Bob'" → ["age > 18", "name = 'Alice AND Bob'"]
   */
  private splitOnKeyword(expr: string, keyword: 'AND' | 'OR'): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar: string | null = null;

    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    let i = 0;

    while (i < expr.length) {
      const char = expr[i];

      // Track quote state
      if ((char === '"' || char === "'") && (i === 0 || expr[i - 1] !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
          quoteChar = null;
        }
        current += char;
        i++;
        continue;
      }

      // Check for keyword if not in quotes
      if (!inQuotes) {
        const remaining = expr.slice(i);
        const match = remaining.match(regex);

        if (match && match.index === 0) {
          // Found keyword at current position
          parts.push(current.trim());
          current = '';
          i += match[0].length; // Skip past keyword
          continue;
        }
      }

      current += char;
      i++;
    }

    // Add final part
    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts.filter(Boolean);
  }

  private parseValue(raw: string): FieldValue {
    // String wrapped in single or double quotes
    const quoted = raw.match(/^'(.*)'$/) ?? raw.match(/^"(.*)"$/);
    if (quoted) return quoted[1];

    if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';

    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

    throw new Error(`Unsupported value: "${raw}". Use numbers, booleans, or quoted strings.`);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ═════════════════════════════════════════════════════════════════════════════

  async execute(query: string): Promise<QueryResultRow[]> {
    //const startTime = Date.now();
    const parsed = this.parse(query);

    if (parsed.kind === 'insert') {
      await this.dbms.insertDocument(parsed.collection, parsed.body);
      return [];
    }

    // Determine which field to use for cursor
    // Strategy: Use the first field in a comparison (if available)
    const indexField = this.extractIndexField(parsed.where);
    const iterableKey = indexField ?? 'id';

    // For exact matches, we can pass the value to cursor for index optimization
    const cursorValue = this.extractCursorValue(parsed.where, iterableKey);

    const results: QueryResultRow[] = [];
    const cursor = this.dbms.cursor(
      parsed.collection,
      iterableKey,
      cursorValue !== undefined ? this.valueToCursor(cursorValue) : undefined,
    );

    let count = 0;
    const limit = parsed.limit ?? Infinity;
    const offset = parsed.offset ?? 0;

    for await (const jsonDoc of cursor) {
      const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;

      // Evaluate WHERE condition
      if (parsed.where && !this.evaluateWhere(doc, parsed.where)) {
        continue;
      }

      // Handle OFFSET
      if (count < offset) {
        count++;
        continue;
      }

      // Handle LIMIT (early termination)
      if (count >= offset + limit) {
        break;
      }

      results.push(this.project(doc, parsed.fields));
      count++;
    }

    // add execution time to the results for testing purposes
    // the start time is captured at the beginning of the execute method, and the execution time is calculated at the end
    //const executionTime = Date.now() - startTime;
    //return results.map(result => ({ ...result, executionTime }));
    return results;
  }

  /**
   * Extract the first field used in a comparison for cursor optimization.
   * Example: "age > 25 AND active = true" → "age"
   */
  private extractIndexField(where?: WhereExpression): string | null {
    if (!where) return null;

    if (where.type === 'comparison') {
      return where.field;
    }

    if (where.type === 'logical') {
      // Prefer left side (arbitrary choice)
      return this.extractIndexField(where.left) ?? this.extractIndexField(where.right);
    }

    return null;
  }

  /**
   * Extract cursor value for exact match optimization.
   * Only returns value if WHERE is a simple "field = value" (no OR/AND).
   */
  private extractCursorValue(where: WhereExpression | undefined, field: string): FieldValue | undefined {
    if (!where) return undefined;

    // Only optimize for simple exact matches
    if (where.type === 'comparison' && where.field === field && where.operator === '=') {
      return this.valueToCursor(where.value);
    }

    return undefined;
  }

  // ── WHERE Evaluation ───────────────────────────────────────────────────────

  private evaluateWhere(doc: Record<string, unknown>, expr: WhereExpression): boolean {
    if (expr.type === 'comparison') {
      return this.evaluateComparison(doc, expr);
    }

    if (expr.type === 'logical') {
      const leftResult = this.evaluateWhere(doc, expr.left);
      const rightResult = this.evaluateWhere(doc, expr.right);

      if (expr.operator === 'AND') {
        return leftResult && rightResult;
      } else {
        return leftResult || rightResult;
      }
    }

    return false;
  }

  private evaluateComparison(doc: Record<string, unknown>, expr: ComparisonExpression): boolean {
    const actual = doc[expr.field];
    const expected = expr.value;

    switch (expr.operator) {
      case '=':
        return actual === expected;

      case '!=':
        return actual !== expected;

      case '>':
        return this.compareValues(actual, expected) > 0;

      case '>=':
        return this.compareValues(actual, expected) >= 0;

      case '<':
        return this.compareValues(actual, expected) < 0;

      case '<=':
        return this.compareValues(actual, expected) <= 0;

      default: {
        const exhaustiveCheck: never = expr.operator;
        throw new Error(`Unknown operator: ${String(exhaustiveCheck)}`);
      }
    }
  }

  /**
   * Compare two values for ordering.
   * Returns: < 0 if a < b, 0 if equal, > 0 if a > b
   */
  private compareValues(a: unknown, b: unknown): number {
    // Handle null/undefined
    if (a === null && b === null) return 0;
    if (a === undefined && b === undefined) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;

    // Number comparison
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }

    // String comparison
    if (typeof a === 'string' && typeof b === 'string') {
      return a.localeCompare(b);
    }

    // Boolean comparison (false < true)
    if (typeof a === 'boolean' && typeof b === 'boolean') {
      return (a ? 1 : 0) - (b ? 1 : 0);
    }

    // Reject comparisons involving complex objects (null already handled above)
    if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
      throw new Error('Cannot compare complex objects in WHERE clause');
    }

    // Mixed primitive types: convert to string (use JSON.stringify for non-primitive structures to avoid "[object Object]")
    const toComparableString = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      try {
        const json = JSON.stringify(v);
        if (json !== undefined) return json;
      } catch {
        // fall back to default string conversion on error
      }
      return String(v);
    };

    return toComparableString(a).localeCompare(toComparableString(b));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private valueToCursor(value: FieldValue): string | number {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return value;
    return String(value); // Fallback voor safety
  }

  private project(doc: Record<string, FieldValue>, fields: '*' | string[]): QueryResultRow {
    if (fields === '*') return doc;

    const projected: QueryResultRow = {};
    for (const field of fields) {
      projected[field] = doc[field];
    }
    return projected;
  }
}
