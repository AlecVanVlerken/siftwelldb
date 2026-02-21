// author: Frederik Caeyman
// date: 2026-02-17

import { SimpleDbms } from '../simpledbms.mjs';
import { type FieldValue } from '../document.mjs';

export type QueryResultRow = Record<string, FieldValue | undefined>;

type ParsedSelect = {
  kind: 'select';
  fields: '*' | string[];
  collection: string;
  where?: {
    field: string;
    value: FieldValue;
  };
};

type ParsedInsert = {
  kind: 'insert';
  collection: string;
  body: string;
};

export type ParsedQuery = ParsedSelect | ParsedInsert;

/**
 * Minimal SQL-like query language that supports:
 *   SELECT <fields|*> FROM <collection> [WHERE <field> = <value>]
 *   INSERT INTO <collection> VALUES {id: '...', field: ...}
 */
export class QueryLanguage {
  private dbms: SimpleDbms;

  constructor(dbms: SimpleDbms) {
    this.dbms = dbms;
  }

  parse(query: string): ParsedQuery {
    const normalized = query.trim().replace(/;$/, '').trim();

    // INSERT
    const insertMatch = normalized.match(/^insert\s+into\s+([A-Za-z_][A-Za-z0-9_]*)\s+values\s+(.+)$/i);
    if (insertMatch) {
      const [, collection, rawBody] = insertMatch;
      const body = rawBody.trim();
      if (!body.startsWith('{') || !body.endsWith('}')) {
        throw new Error('INSERT body must be an object literal in braces');
      }
      return { kind: 'insert', collection, body };
    }

    // SELECT
    const selectMatch = normalized.match(/^select\s+(.+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:where\s+(.+))?$/i);
    if (!selectMatch) {
      throw new Error(
        'Invalid query. Use SELECT <fields> FROM <collection> [WHERE field = value] or INSERT INTO <collection> VALUES {...}',
      );
    }

    const [, selectPartRaw, collection, wherePartRaw] = selectMatch;
    const fields = this.parseFields(selectPartRaw.trim());
    const where = wherePartRaw ? this.parseWhere(wherePartRaw.trim()) : undefined;

    return { kind: 'select', fields, collection, where };
  }

  async execute(query: string): Promise<QueryResultRow[]> {
    const parsed = this.parse(query);

    if (parsed.kind === 'insert') {
      await this.dbms.insertDocument(parsed.collection, parsed.body);
      return [];
    }

    const iterableKey = parsed.where?.field ?? 'id';
    const cursorValue = parsed.where ? this.valueToCursor(parsed.where.value) : undefined;

    const results: QueryResultRow[] = [];
    const cursor = this.dbms.cursor(parsed.collection, iterableKey, cursorValue);

    for await (const jsonDoc of cursor) {
      const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;

      if (parsed.where && !this.matchesWhere(doc, parsed.where.field, parsed.where.value)) {
        continue;
      }

      results.push(this.project(doc, parsed.fields));
    }

    return results;
  }

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

  private parseWhere(wherePart: string): { field: string; value: FieldValue } {
    const match = wherePart.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) {
      throw new Error('WHERE clause must use the form <field> = <value>');
    }

    const [, field, rawValue] = match;
    const value = this.parseValue(rawValue.trim());

    return { field, value };
  }

  private parseValue(raw: string): FieldValue {
    // String wrapped in single or double quotes
    const quoted = raw.match(/^'(.*)'$/) ?? raw.match(/^"(.*)"$/);
    if (quoted) return quoted[1];

    if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';

    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

    throw new Error('Unsupported value in WHERE clause. Use numbers, booleans, or quoted strings.');
  }

  private valueToCursor(value: FieldValue): string | number | Buffer {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  }

  private matchesWhere(doc: Record<string, unknown>, field: string, expected: FieldValue): boolean {
    const actual = doc[field];
    return actual === expected;
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
