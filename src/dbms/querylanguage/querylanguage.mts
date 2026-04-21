// author: Frederik Caeyman & Matisse De Gauquier

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

// ── ORDER BY Types ───────────────────────────────────────────────────────────

type SortDirection = 'ASC' | 'DESC';

type OrderByClause = {
  field: string;
  direction: SortDirection;
};

// ── JOIN Types ─────────────────────────────────────────────────────────────

type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'NATURAL';

type JoinClause = {
  type: JoinType;
  collection: string;
  leftField: string;
  rightField: string;
};

// ── GROUP BY / HAVING Types ──────────────────────────────────────────────────

type AggregateFunction = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

type AggregateExpression = {
  func: AggregateFunction;
  field: string; // '*' only valid for COUNT
  alias: string; // e.g. "COUNT(*)" or "AVG(population)"
};

type GroupByClause = {
  fields: string[];
  aggregates: AggregateExpression[];
};

type HavingExpression = WhereExpression;

// ── Query Types ──────────────────────────────────────────────────────────────

type ParsedSelect = {
  kind: 'select';
  fields: '*' | string[];
  collection: string;
  join?: JoinClause;
  where?: WhereExpression;
  groupBy?: GroupByClause;
  having?: HavingExpression;
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
};

type ParsedInsert = {
  kind: 'insert';
  collection: string;
  body: string;
};

type ParsedDelete = {
  kind: 'delete';
  collection: string;
  where?: WhereExpression;
};

export type ParsedQuery = ParsedSelect | ParsedInsert | ParsedDelete;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended SQL-like query language that supports:
 *   SELECT <fields|*> FROM <collection>
 *     [JOIN <collection> ON <left> = <right>]
 *     [WHERE <conditions>]
 *     [GROUP BY <fields>]
 *     [HAVING <aggregate conditions>]
 *     [ORDER BY <field> [ASC|DESC], ...]
 *     [LIMIT n]
 *     [OFFSET k]
 *   INSERT INTO <collection> VALUES {id: '...', field: ...}
 *   DELETE FROM <collection> [WHERE <conditions>]
 *
 * WHERE/HAVING support:
 *   - Comparison: =, !=, >, >=, <, <=
 *   - Logical: AND, OR
 *
 * GROUP BY supports aggregates: COUNT(*), SUM(field), AVG(field), MIN(field), MAX(field)
 *
 * ORDER BY supports:
 *   - Single or multiple fields: ORDER BY population DESC, id ASC
 *   - Default direction is ASC
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

    // ── DELETE ───────────────────────────────────────────────
    const deleteMatch = normalized.match(/^delete\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:where\s+(.+?))?$/i);
    if (deleteMatch) {
      const [, collection, wherePartRaw] = deleteMatch;
      const where = wherePartRaw ? this.parseWhere(wherePartRaw.trim()) : undefined;
      return { kind: 'delete', collection, where };
    }

    // ── SELECT ──────────────────────────────────────────
    // Pattern: SELECT <fields> FROM <collection> [JOIN ...] [WHERE <expr>] [GROUP BY <fields>] [HAVING <expr>] [ORDER BY <fields>] [LIMIT n] [OFFSET k]
    const selectMatch = normalized.match(
      /^select\s+(.+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+join\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+on\s+([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*))?)?\s*(?:where\s+(.+?))?\s*(?:group\s+by\s+(.+?))?\s*(?:having\s+(.+?))?\s*(?:order\s+by\s+(.+?))?\s*(?:limit\s+(\d+))?\s*(?:offset\s+(\d+))?$/i,
    );

    if (!selectMatch) {
      throw new Error('Invalid query syntax.');
    }

    const [
      ,
      selectPartRaw,
      collection,
      joinCollection,
      joinLeft,
      joinRight,
      wherePartRaw,
      groupByRaw,
      havingRaw,
      orderByRaw,
      limitStr,
      offsetStr,
    ] = selectMatch;

    const fields = this.parseFields(selectPartRaw.trim());
    const aggregatesInSelect = this.extractAggregates(selectPartRaw.trim());
    const where = wherePartRaw ? this.parseWhere(wherePartRaw.trim()) : undefined;
    const groupBy = groupByRaw
      ? this.parseGroupBy(groupByRaw.trim(), selectPartRaw.trim())
      : aggregatesInSelect.length > 0
        ? { fields: [], aggregates: aggregatesInSelect }
        : undefined;
    const having = havingRaw ? this.parseHaving(havingRaw.trim()) : undefined;
    const orderBy = orderByRaw ? this.parseOrderBy(orderByRaw.trim()) : undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;
    let join: JoinClause | undefined = undefined;

    if (joinCollection) {
      join = {
        type: 'INNER',
        collection: joinCollection,
        leftField: joinLeft || '',
        rightField: joinRight || '',
      };
    }

    return { kind: 'select', fields, collection, join, where, groupBy, having, orderBy, limit, offset };
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
    return this.parseOrExpression(wherePart);
  }

  private parseOrExpression(expr: string): WhereExpression {
    const parts = this.splitOnKeyword(expr, 'OR');

    if (parts.length === 1) {
      return this.parseAndExpression(parts[0]);
    }

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

    // Uitgebreide regex: staat aggregate functies toe als veldnaam, bv. COUNT(*) of AVG(population)
    const match = expr.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?|[A-Za-z_][A-Za-z0-9_.]*)\s*(>=|<=|!=|=|>|<)\s*(.+)$/,
    );

    if (!match) {
      throw new Error(`Invalid WHERE/HAVING comparison: "${expr}". Expected format: field <operator> value`);
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

  // ── Parse ORDER BY clause ──────────────────────────────────────────────────

  private parseOrderBy(orderByPart: string): OrderByClause[] {
    const parts = orderByPart
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    return parts.map((part) => {
      const tokens = part.split(/\s+/);
      if (tokens.length === 0 || !tokens[0]) {
        throw new Error(`Invalid ORDER BY clause: "${part}"`);
      }

      const field = tokens[0];
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?$/.test(field)) {
        throw new Error(`Invalid field name in ORDER BY: "${field}"`);
      }

      const directionRaw = tokens[1]?.toUpperCase();
      if (directionRaw && directionRaw !== 'ASC' && directionRaw !== 'DESC') {
        throw new Error(`Invalid sort direction "${directionRaw}". Use ASC or DESC.`);
      }

      const direction: SortDirection = (directionRaw as SortDirection) ?? 'ASC';
      return { field, direction };
    });
  }

  // ── Parse GROUP BY clause ──────────────────────────────────────────────────

  private parseGroupBy(groupByPart: string, selectPart: string): GroupByClause {
    const fields = groupByPart
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    if (fields.length === 0) {
      throw new Error('GROUP BY clause must list at least one field');
    }

    const aggregates = this.extractAggregates(selectPart);
    return { fields, aggregates };
  }

  private extractAggregates(selectPart: string): AggregateExpression[] {
    const aggregates: AggregateExpression[] = [];
    const aggRegex = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|[A-Za-z_][A-Za-z0-9_]*)\s*\)/gi;

    let match: RegExpExecArray | null;
    while ((match = aggRegex.exec(selectPart)) !== null) {
      const func = match[1].toUpperCase() as AggregateFunction;
      const field = match[2];
      const alias = `${func}(${field})`;
      aggregates.push({ func, field, alias });
    }

    return aggregates;
  }

  // ── Parse HAVING clause ────────────────────────────────────────────────────

  private parseHaving(havingPart: string): HavingExpression {
    // Normaliseer aggregate calls naar hun alias vorm vóór het parsen
    // zodat "COUNT(*) > 5" behandeld wordt als een gewone comparison met field "COUNT(*)"
    const normalized = havingPart.replace(
      /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|[A-Za-z_][A-Za-z0-9_]*)\s*\)/gi,
      (_match: string, func: string, field: string) => `${func.toUpperCase()}(${field})`,
    );

    return this.parseWhere(normalized);
  }

  /**
   * Split a string on a keyword (AND/OR), but ignore keywords inside quotes.
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

      if (!inQuotes) {
        const remaining = expr.slice(i);
        const match = remaining.match(regex);

        if (match && match.index === 0) {
          parts.push(current.trim());
          current = '';
          i += match[0].length;
          continue;
        }
      }

      current += char;
      i++;
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts.filter(Boolean);
  }

  private parseValue(raw: string): FieldValue {
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
    const parsed = this.parse(query);

    if (parsed.kind === 'insert') {
      await this.dbms.insertDocument(parsed.collection, parsed.body);
      return [];
    }

    if (parsed.kind === 'delete') {
      const cursor = this.dbms.cursor(parsed.collection, 'id', undefined);
      const idsToDelete: string[] = [];
      for await (const jsonDoc of cursor) {
        const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;
        if (!parsed.where || this.evaluateWhere(doc, parsed.where)) {
          if (typeof doc['id'] === 'string') idsToDelete.push(doc['id']);
        }
      }
      for (const id of idsToDelete) {
        await this.dbms.deleteDocumentById(parsed.collection, id);
      }
      return [];
    }

    // ── SELECT ─────────────────────────────────────────────────────────────────
    let results: QueryResultRow[] = [];

    if (parsed.join) {
      // Delegate entirely to executeJoin when a JOIN clause is present
      results = await this.executeJoin(parsed);
    } else {
      const indexField = this.extractIndexField(parsed.where);
      const iterableKey = indexField ?? 'id';
      const cursorValue = this.extractCursorValue(parsed.where, iterableKey);

      const cursor = this.dbms.cursor(
        parsed.collection,
        iterableKey,
        cursorValue !== undefined ? this.valueToCursor(cursorValue) : undefined,
      );

      for await (const jsonDoc of cursor) {
        const doc = JSON.parse(jsonDoc) as Record<string, FieldValue>;

        if (parsed.where && !this.evaluateWhere(doc, parsed.where)) {
          continue;
        }

        results.push(parsed.groupBy ? doc : this.project(doc, parsed.fields));
      }
    }

    // ── GROUP BY ───────────────────────────────────────────────────────────────
    if (parsed.groupBy) {
      results = this.executeGroupBy(results, parsed.groupBy, parsed.having);
      results = results.map((row) => this.project(row as Record<string, FieldValue>, parsed.fields));
    }

    // ── ORDER BY ───────────────────────────────────────────────────────────────
    if (parsed.orderBy && parsed.orderBy.length > 0) {
      results = this.sortResults(results, parsed.orderBy);
    }

    // ── OFFSET / LIMIT ─────────────────────────────────────────────────────────
    const offset = parsed.offset ?? 0;
    const limit = parsed.limit ?? Infinity;
    results = results.slice(offset, offset === 0 && limit === Infinity ? undefined : offset + limit);

    return results;
  }

  // ── Sorting ────────────────────────────────────────────────────────────────

  private sortResults(rows: QueryResultRow[], orderBy: OrderByClause[]): QueryResultRow[] {
    return [...rows].sort((a, b) => {
      for (const { field, direction } of orderBy) {
        const cmp = this.compareValues(a[field], b[field]);
        if (cmp !== 0) {
          return direction === 'DESC' ? -cmp : cmp;
        }
      }
      return 0;
    });
  }

  // ── Grouping ───────────────────────────────────────────────────────────────

  private executeGroupBy(rows: QueryResultRow[], groupBy: GroupByClause, having?: HavingExpression): QueryResultRow[] {
    // Stap 1: Groepeer rijen op de GROUP BY velden
    const groups = new Map<string, QueryResultRow[]>();

    for (const row of rows) {
      const key = groupBy.fields.map((f) => String(row[f] ?? '')).join('|');
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    // Stap 2: Bereken aggregaten per groep
    const results: QueryResultRow[] = [];

    for (const groupRows of groups.values()) {
      const resultRow: QueryResultRow = {};

      // Kopieer de GROUP BY velden van de eerste rij
      for (const field of groupBy.fields) {
        resultRow[field] = groupRows[0][field];
      }

      // Bereken elke aggregatiefunctie
      for (const agg of groupBy.aggregates) {
        resultRow[agg.alias] = this.computeAggregate(groupRows, agg);
      }

      // Stap 3: HAVING filter toepassen
      if (having && !this.evaluateWhere(resultRow as Record<string, FieldValue>, having)) {
        continue;
      }

      results.push(resultRow);
    }

    return results;
  }

  private computeAggregate(rows: QueryResultRow[], agg: AggregateExpression): number {
    switch (agg.func) {
      case 'COUNT':
        return rows.length;

      case 'SUM': {
        return rows.reduce((sum, row) => {
          const val = row[agg.field];
          return sum + (typeof val === 'number' ? val : 0);
        }, 0);
      }

      case 'AVG': {
        const sum = rows.reduce((s, row) => {
          const val = row[agg.field];
          return s + (typeof val === 'number' ? val : 0);
        }, 0);
        return rows.length > 0 ? sum / rows.length : 0;
      }

      case 'MIN': {
        const vals = rows.map((r) => r[agg.field]).filter((v) => typeof v === 'number');
        return vals.length > 0 ? Math.min(...vals) : 0;
      }

      case 'MAX': {
        const vals = rows.map((r) => r[agg.field]).filter((v) => typeof v === 'number');
        return vals.length > 0 ? Math.max(...vals) : 0;
      }
    }
  }

  // ── Joining ────────────────────────────────────────────────────────────────

  private async executeJoin(parsed: ParsedSelect): Promise<QueryResultRow[]> {
    const join = parsed.join!;
    const leftDocs = await this.loadCollection(parsed.collection);
    const rightDocs = await this.loadCollection(join.collection);

    const leftKeys = leftDocs.length > 0 ? Object.keys(leftDocs[0]) : [];
    const rightKeys = rightDocs.length > 0 ? Object.keys(rightDocs[0]) : [];
    const overlapping = leftKeys.filter((k) => rightKeys.includes(k));

    let effectiveJoinType: 'INNER' | 'NATURAL' | 'FULL' = 'INNER';
    let leftKey: string | undefined;
    let rightKey: string | undefined;
    let mergeFields: string[] = [];

    if (join.leftField && join.rightField) {
      // Scenario 1: ON conditie aanwezig -> INNER JOIN
      effectiveJoinType = 'INNER';
      leftKey = join.leftField.split('.').pop()!;
      rightKey = join.rightField.split('.').pop()!;
      mergeFields = [leftKey, rightKey];
    } else if (overlapping.length > 0) {
      // Scenario 2: Geen ON, wel overlap -> NATURAL JOIN
      effectiveJoinType = 'NATURAL';
      mergeFields = overlapping;
      leftKey = overlapping[0];
      rightKey = overlapping[0];
    } else {
      // Scenario 3: Geen ON, geen overlap -> FULL JOIN (Cartesian)
      effectiveJoinType = 'FULL';
    }

    // --- Uitvoering ---
    const results: QueryResultRow[] = [];

    if (effectiveJoinType === 'FULL' && !leftKey) {
      // Cartesian Product logica
      for (const leftDoc of leftDocs) {
        for (const rightDoc of rightDocs) {
          results.push(this.mergeDocuments(leftDoc, rightDoc, parsed.collection, join.collection, 'FULL', []));
        }
      }
    } else {
      // Index-based Join (voor INNER en NATURAL)
      const rightMap = new Map<FieldValue, Record<string, FieldValue>[]>();
      for (const doc of rightDocs) {
        const val = doc[rightKey!];
        const bucket = rightMap.get(val) ?? [];
        bucket.push(doc);
        rightMap.set(val, bucket);
      }

      for (const leftDoc of leftDocs) {
        const matches = rightMap.get(leftDoc[leftKey!]) ?? [];
        for (const rightDoc of matches) {
          const merged = this.mergeDocuments(
            leftDoc,
            rightDoc,
            parsed.collection,
            join.collection,
            effectiveJoinType,
            mergeFields,
          );

          if (parsed.where && !this.evaluateWhere(merged, parsed.where)) {
            continue;
          }

          results.push(this.project(merged, parsed.fields));
        }
      }
    }
    return results;
  }

  private async loadCollection(collection: string): Promise<Record<string, FieldValue>[]> {
    const docs: Record<string, FieldValue>[] = [];
    for await (const jsonDoc of this.dbms.cursor(collection, 'id', undefined)) {
      docs.push(JSON.parse(jsonDoc) as Record<string, FieldValue>);
    }
    return docs;
  }

  private mergeDocuments(
    leftDoc: Record<string, FieldValue> | null,
    rightDoc: Record<string, FieldValue> | null,
    leftColl: string,
    rightColl: string,
    type: string,
    mergeFields: string[],
  ): Record<string, FieldValue> {
    const merged: Record<string, FieldValue> = {};
    const overlap = leftDoc && rightDoc ? this.getOverlappingFields(leftDoc, rightDoc) : new Set<string>();
    const isNatural = type === 'NATURAL';

    const leftJoinKey = mergeFields.length > 0 ? mergeFields[0] : null;
    const rightJoinKey = mergeFields.length > 0 ? mergeFields[mergeFields.length - 1] : null;

    // STAP 1: Zet de join-velden als allereerste in het object
    if (leftDoc && leftJoinKey && leftDoc[leftJoinKey] !== undefined) {
      merged[leftJoinKey] = leftDoc[leftJoinKey];
    } else if (rightDoc && rightJoinKey && rightDoc[rightJoinKey] !== undefined) {
      merged[rightJoinKey] = rightDoc[rightJoinKey];
    }

    // STAP 2: Voeg de rest van de velden van links toe
    if (leftDoc) {
      for (const [k, v] of Object.entries(leftDoc)) {
        if (k === leftJoinKey) continue;

        if (k === 'id' && !isNatural) {
          merged[`${leftColl}.id`] = v;
        } else if (overlap.has(k) && !isNatural) {
          merged[`${leftColl}.${k}`] = v;
        } else {
          merged[k] = v;
        }
      }
    }

    // STAP 3: Voeg de rest van de velden van rechts toe
    if (rightDoc) {
      for (const [k, v] of Object.entries(rightDoc)) {
        if (k === rightJoinKey) continue;

        if (k === 'id' && !isNatural) {
          merged[`${rightColl}.id`] = v;
        } else if (overlap.has(k) && !isNatural) {
          merged[`${rightColl}.${k}`] = v;
        } else if (merged[k] === undefined) {
          merged[k] = v;
        }
      }
    }

    return merged;
  }

  // ── Index helpers ──────────────────────────────────────────────────────────

  private extractIndexField(where?: WhereExpression): string | null {
    if (!where) return null;

    if (where.type === 'comparison') {
      return where.field;
    }

    if (where.type === 'logical') {
      return this.extractIndexField(where.left) ?? this.extractIndexField(where.right);
    }

    return null;
  }

  private extractCursorValue(where: WhereExpression | undefined, field: string): FieldValue | undefined {
    if (!where) return undefined;

    if (where.type === 'comparison' && where.field === field && where.operator === '=') {
      return this.valueToCursor(where.value);
    }

    return undefined;
  }

  // ── WHERE / HAVING Evaluation ──────────────────────────────────────────────

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

  private compareValues(a: unknown, b: unknown): number {
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
    return String(value);
  }

  private project(doc: Record<string, FieldValue>, fields: '*' | string[]): QueryResultRow {
    if (fields === '*') return doc;

    const projected: QueryResultRow = {};
    for (const field of fields) {
      projected[field] = doc[field];
    }
    return projected;
  }

  private getOverlappingFields(leftDoc: Record<string, FieldValue>, rightDoc: Record<string, FieldValue>): Set<string> {
    const leftKeys = Object.keys(leftDoc);
    const rightKeys = Object.keys(rightDoc);
    const overlap = new Set<string>();

    const rightKeySet = new Set(rightKeys);
    for (const key of leftKeys) {
      if (rightKeySet.has(key)) {
        overlap.add(key);
      }
    }
    return overlap;
  }
}
