// author: Frederik Caeyman & Matisse De Gauquier
//
// Parse a textual query into a {@link ParsedQuery} AST.
//
// The top-level grammar (INSERT / DELETE / SELECT) is still recognised with
// a small set of regexes — they're robust enough for the supported surface
// and stay out of the parser's hot loop. WHERE / HAVING, on the other hand,
// is handled by a hand-rolled recursive-descent parser over a tiny token
// stream. That's what gives us:
//
//   - Parentheses to override AND/OR precedence: `(a = 1 OR b = 2) AND c = 3`
//   - Short-circuit-friendly AST that the executor can evaluate lazily.
//   - Precompiled LIKE regexes (set once on the AST node, never per row).
//
// The SELECT field list is parsed with a similar small tokenizer so we can
// support `SELECT col AS alias, COUNT(*) AS total` properly.

import { type FieldValue } from '../document.mjs';
import type {
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
  JoinClause,
  NotExpression,
  OrderByClause,
  ParsedQuery,
  SortDirection,
  UpdateAssignment,
  WhereExpression,
} from './ast.mjs';
import { likeToRegex, parseValue } from './expressions.mjs';

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC
// ═════════════════════════════════════════════════════════════════════════════

export function parse(query: string): ParsedQuery {
  const normalized = query.trim().replace(/;$/, '').trim();

  // ── INSERT ───────────────────────────────────────────────────────────────
  const insertMatch = normalized.match(/^insert\s+into\s+([A-Za-z_][A-Za-z0-9_]*)\s+values\s+(.+)$/i);
  if (insertMatch) {
    const [, collection, rawBody] = insertMatch;
    const body = rawBody.trim();
    if (!body.startsWith('{') || !body.endsWith('}')) {
      throw new Error('INSERT body must be an object literal in braces');
    }
    return { kind: 'insert', collection, body };
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  const deleteMatch = normalized.match(/^delete\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:where\s+(.+?))?$/i);
  if (deleteMatch) {
    const [, collection, wherePartRaw] = deleteMatch;
    const where = wherePartRaw ? parseWhere(wherePartRaw.trim()) : undefined;
    return { kind: 'delete', collection, where };
  }

  // ── UPDATE ───────────────────────────────────────────────────────────────
  //   UPDATE <collection> SET f1 = v1 [, f2 = v2, ...] [WHERE ...]
  // Each RHS is a literal — no field-to-field references, no expressions.
  // Mutating `id` is rejected because the backend uses it as the primary
  // key; changing it would orphan all secondary-index entries.
  const updateMatch = normalized.match(
    /^update\s+([A-Za-z_][A-Za-z0-9_]*)\s+set\s+(.+?)(?:\s+where\s+(.+?))?$/i,
  );
  if (updateMatch) {
    const [, collection, setPartRaw, wherePartRaw] = updateMatch;
    const assignments = parseAssignments(setPartRaw.trim());
    if (assignments.length === 0) {
      throw new Error('UPDATE must set at least one field');
    }
    if (assignments.some((a) => a.field === 'id')) {
      throw new Error('UPDATE cannot change "id" — it is the primary key');
    }
    const where = wherePartRaw ? parseWhere(wherePartRaw.trim()) : undefined;
    return { kind: 'update', collection, assignments, where };
  }

  // ── SELECT ───────────────────────────────────────────────────────────────
  //
  // Parsing is split in two stages:
  //   1. Pull `SELECT <fields> FROM <collection>` off the front.
  //   2. The remainder is "head joins ... + tail clauses". Peel each JOIN
  //      from the head until we hit one of WHERE / GROUP BY / HAVING /
  //      ORDER BY / LIMIT / OFFSET — then the rest matches a single
  //      tail regex.
  //
  // This shape lets us support an arbitrary number of chained JOINs
  // without inflating the SELECT regex into 14 capture groups.
  const headMatch = normalized.match(/^select\s+(.+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/is);
  if (!headMatch) {
    throw new Error('Invalid query syntax.');
  }
  const [, selectPartRaw, collection, restRaw] = headMatch;

  const { joins, tail } = peelJoins(restRaw.trim());

  // Paren-aware split: regex can't track depth, and subqueries inside
  // `WHERE … IN (SELECT … ORDER BY …)` would otherwise eat the outer
  // ORDER BY. We slice the tail by scanning for the next clause
  // keyword at depth 0.
  const clauses = splitSelectTail(tail);
  const wherePartRaw = clauses.where;
  const groupByRaw = clauses.groupBy;
  const havingRaw = clauses.having;
  const orderByRaw = clauses.orderBy;
  const limitStr = clauses.limit;
  const offsetStr = clauses.offset;

  let selectPart = selectPartRaw.trim();
  // `SELECT DISTINCT ...` — strip the keyword and mark the parsed query.
  // The dedup is applied after projection by the executor so it works
  // uniformly for plain selects, joins, and grouped queries.
  let distinct = false;
  const distinctMatch = selectPart.match(/^DISTINCT\s+(.+)$/is);
  if (distinctMatch) {
    distinct = true;
    selectPart = distinctMatch[1].trim();
  }
  const fields = parseFields(selectPart);
  const aggregatesInSelect = extractAggregates(selectPart);
  const where = wherePartRaw ? parseWhere(wherePartRaw.trim()) : undefined;
  const groupBy = groupByRaw
    ? parseGroupBy(groupByRaw.trim(), selectPart)
    : aggregatesInSelect.length > 0
      ? { fields: [], aggregates: aggregatesInSelect }
      : undefined;
  const having = havingRaw ? parseHaving(havingRaw.trim()) : undefined;
  const orderBy = orderByRaw ? parseOrderBy(orderByRaw.trim()) : undefined;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;

  return {
    kind: 'select',
    fields,
    collection,
    distinct: distinct || undefined,
    joins: joins.length > 0 ? joins : undefined,
    where,
    groupBy,
    having,
    orderBy,
    limit,
    offset,
  };
}

/**
 * Locations of each clause keyword at depth-0 parens. The string is
 * scanned once; quoted strings and parenthesised subqueries are
 * traversed as opaque regions so they can contain any keyword without
 * upsetting the split.
 */
type TailClauses = {
  where?: string;
  groupBy?: string;
  having?: string;
  orderBy?: string;
  limit?: string;
  offset?: string;
};

function splitSelectTail(src: string): TailClauses {
  const keywords: { name: keyof TailClauses; pattern: RegExp }[] = [
    { name: 'where', pattern: /^where\b/i },
    { name: 'groupBy', pattern: /^group\s+by\b/i },
    { name: 'having', pattern: /^having\b/i },
    { name: 'orderBy', pattern: /^order\s+by\b/i },
    { name: 'limit', pattern: /^limit\b/i },
    { name: 'offset', pattern: /^offset\b/i },
  ];

  // First pass: find the start offset (in `src`) of each clause keyword
  // at depth 0. We require keywords to appear in canonical order
  // (WHERE before GROUP BY before HAVING before …) — any other ordering
  // is a syntax error in standard SQL too.
  const found: { name: keyof TailClauses; start: number; keywordLen: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let i = 0;
  let nextKeywordIndex = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      const isBoundary = i === 0 || /\s/.test(src[i - 1]);
      if (isBoundary) {
        const rest = src.slice(i);
        for (let k = nextKeywordIndex; k < keywords.length; k++) {
          const m = rest.match(keywords[k].pattern);
          if (m) {
            found.push({ name: keywords[k].name, start: i, keywordLen: m[0].length });
            nextKeywordIndex = k + 1;
            i += m[0].length;
            break;
          }
        }
      }
    }
    i++;
  }

  const out: TailClauses = {};
  for (let k = 0; k < found.length; k++) {
    const { name, start, keywordLen } = found[k];
    const end = k + 1 < found.length ? found[k + 1].start : src.length;
    out[name] = src.slice(start + keywordLen, end).trim();
  }
  return out;
}

/**
 * Peel zero or more `JOIN <collection> [ON <left> = <right>]` clauses
 * off the front of the remainder of a SELECT statement.
 *
 * Stops at the first reserved tail keyword (`WHERE` / `GROUP BY` / etc.)
 * or at end-of-string.
 */
function peelJoins(src: string): { joins: JoinClause[]; tail: string } {
  const joins: JoinClause[] = [];
  let s = src.trimStart();
  while (true) {
    const m = s.match(
      /^join\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+on\s+([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*))?(.*)$/is,
    );
    if (!m) break;
    const [, joinColl, leftField, rightField, rest] = m;
    joins.push({
      type: 'INNER',
      collection: joinColl,
      leftField: leftField ?? '',
      rightField: rightField ?? '',
    });
    s = rest.trimStart();
  }
  return { joins, tail: s };
}

// ═════════════════════════════════════════════════════════════════════════════
// SELECT FIELD LIST (with AS aliases)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Split the SELECT list on top-level commas (i.e. ignore commas inside
 * parentheses and quotes) so that `COUNT(a, b)` would be treated as a
 * single column even though it isn't currently supported by the AST.
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Normalise an aggregate call so its textual form matches the canonical
 * alias produced by {@link extractAggregates}. This is what makes
 * `SELECT COUNT( name )` project the same column the aggregator stored
 * under `COUNT(name)`.
 */
function canonicalizeExpr(raw: string): string {
  const trimmed = raw.trim();
  const aggMatch = trimmed.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(DISTINCT\s+)?(\*|[A-Za-z_][A-Za-z0-9_]*)\s*\)$/i);
  if (!aggMatch) return trimmed;
  const func = aggMatch[1].toUpperCase();
  const distinct = Boolean(aggMatch[2]);
  const field = aggMatch[3];
  return distinct ? `${func}(DISTINCT ${field})` : `${func}(${field})`;
}

/**
 * Parse `expr [AS alias]`. The `AS` keyword is optional (`SELECT name n`
 * is **not** supported intentionally — explicit `AS` keeps the syntax
 * unambiguous against unquoted multi-word patterns).
 */
function parseFieldSelector(part: string): FieldSelector {
  const m = part.match(/^(.*?)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
  if (m) return { expr: canonicalizeExpr(m[1]), alias: m[2].trim() };
  return { expr: canonicalizeExpr(part) };
}

function parseFields(selectPart: string): '*' | FieldSelector[] {
  if (selectPart === '*') return '*';
  const parts = splitTopLevelCommas(selectPart).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('SELECT clause must list at least one field or *');
  }
  return parts.map(parseFieldSelector);
}

/**
 * Parse an UPDATE SET clause: comma-separated `field = literal` pairs.
 * The literal goes through {@link parseValue} so it shares the same
 * type rules as WHERE comparisons.
 */
function parseAssignments(setPart: string): UpdateAssignment[] {
  const parts = splitTopLevelCommas(setPart).filter(Boolean);
  return parts.map((part) => {
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!m) throw new Error(`Invalid UPDATE assignment: "${part}". Expected "field = literal".`);
    const field = m[1];
    const value = parseValue(m[2].trim());
    return { field, value };
  });
}

/**
 * Pull every aggregate function call out of the SELECT list, regardless
 * of any `AS` aliasing. The alias on the returned {@link AggregateExpression}
 * is the *internal* `FUNC(field)` form — the public alias is applied later
 * by the projector.
 */
function extractAggregates(selectPart: string): AggregateExpression[] {
  const aggregates: AggregateExpression[] = [];
  // `(DISTINCT field)` deduplicates the column before aggregating. `*`
  // is only legal for COUNT and never combined with DISTINCT — the
  // canonical alias preserves the keyword so a HAVING / ORDER BY clause
  // can refer to it as `COUNT(DISTINCT x)` exactly.
  const aggRegex = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(DISTINCT\s+)?(\*|[A-Za-z_][A-Za-z0-9_]*)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = aggRegex.exec(selectPart)) !== null) {
    const func = match[1].toUpperCase() as AggregateFunction;
    const distinct = Boolean(match[2]);
    const field = match[3];
    if (distinct && field === '*') {
      throw new Error('DISTINCT * is not supported — use COUNT(*) or DISTINCT on a specific field');
    }
    const canonicalAlias = distinct ? `${func}(DISTINCT ${field})` : `${func}(${field})`;
    aggregates.push({ func, field, distinct: distinct || undefined, alias: canonicalAlias });
  }
  return aggregates;
}

// ═════════════════════════════════════════════════════════════════════════════
// WHERE / HAVING (Pratt-style recursive descent over a token stream)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Single token emitted by the WHERE/HAVING tokenizer. `start`/`end` are
 * byte offsets into the original source string — used by the subquery
 * path to slice out a parenthesised SELECT verbatim and re-parse it.
 */
type Token =
  | { kind: 'and'; start: number; end: number }
  | { kind: 'or'; start: number; end: number }
  | { kind: 'not'; start: number; end: number }
  | { kind: 'lparen'; start: number; end: number }
  | { kind: 'rparen'; start: number; end: number }
  | { kind: 'comma'; start: number; end: number }
  | { kind: 'ident'; value: string; start: number; end: number }
  | { kind: 'op'; value: ComparisonOperator; start: number; end: number }
  | { kind: 'keyword'; value: 'IS' | 'NULL' | 'IN' | 'BETWEEN'; start: number; end: number }
  | { kind: 'literal'; value: FieldValue; start: number; end: number }
  | { kind: 'eof'; start: number; end: number };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const start = i;
    if (ch === '(') {
      out.push({ kind: 'lparen', start, end: start + 1 });
      i++;
      continue;
    }
    if (ch === ')') {
      out.push({ kind: 'rparen', start, end: start + 1 });
      i++;
      continue;
    }
    if (ch === ',') {
      out.push({ kind: 'comma', start, end: start + 1 });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j++;
      if (j >= src.length) throw new Error(`Unterminated string literal starting at "${src.slice(i, i + 20)}"`);
      out.push({ kind: 'literal', value: src.slice(i + 1, j), start, end: j + 1 });
      i = j + 1;
      continue;
    }
    const numMatch = src.slice(i).match(/^-?\d+(\.\d+)?/);
    if (numMatch && (out.length === 0 || !canFollowNumberLiteral(out[out.length - 1]))) {
      out.push({ kind: 'literal', value: Number(numMatch[0]), start, end: start + numMatch[0].length });
      i += numMatch[0].length;
      continue;
    }
    if (src.startsWith('>=', i) || src.startsWith('<=', i) || src.startsWith('!=', i)) {
      out.push({ kind: 'op', value: src.slice(i, i + 2) as ComparisonOperator, start, end: start + 2 });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '>' || ch === '<') {
      out.push({ kind: 'op', value: ch as ComparisonOperator, start, end: start + 1 });
      i++;
      continue;
    }
    // Identifier or keyword (AND, OR, NOT, IS, NULL, IN, BETWEEN, LIKE,
    // true, false, possibly with a function call). A function call must
    // have no whitespace between the identifier and the opening paren —
    // that's how we distinguish `COUNT(*)` (one token) from
    // `OR (a = 1)` (two tokens).
    const idMatch = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*(?:\([^)]*\))?/);
    if (idMatch) {
      const raw = idMatch[0].replace(/\s+/g, '');
      const upper = raw.toUpperCase();
      const end = start + idMatch[0].length;
      if (upper === 'AND') out.push({ kind: 'and', start, end });
      else if (upper === 'OR') out.push({ kind: 'or', start, end });
      else if (upper === 'NOT') {
        // `NOT LIKE` is joined into a single op; a bare `NOT` is the
        // prefix-negation operator (which can also precede IN / BETWEEN
        // via `field NOT IN (...)` — handled in `parseComparisonOrSpecial`).
        const restLike = src.slice(i + idMatch[0].length).match(/^\s+LIKE\b/i);
        if (restLike) {
          out.push({ kind: 'op', value: 'NOT LIKE', start, end: end + restLike[0].length });
          i += idMatch[0].length + restLike[0].length;
          continue;
        }
        out.push({ kind: 'not', start, end });
      } else if (upper === 'LIKE') out.push({ kind: 'op', value: 'LIKE', start, end });
      else if (upper === 'IS') out.push({ kind: 'keyword', value: 'IS', start, end });
      else if (upper === 'NULL') out.push({ kind: 'keyword', value: 'NULL', start, end });
      else if (upper === 'IN') out.push({ kind: 'keyword', value: 'IN', start, end });
      else if (upper === 'BETWEEN') out.push({ kind: 'keyword', value: 'BETWEEN', start, end });
      else if (upper === 'TRUE') out.push({ kind: 'literal', value: true, start, end });
      else if (upper === 'FALSE') out.push({ kind: 'literal', value: false, start, end });
      else out.push({ kind: 'ident', value: raw, start, end });
      i = end;
      continue;
    }
    throw new Error(`Unsupported value or character "${ch}" in expression "${src}"`);
  }
  out.push({ kind: 'eof', start: src.length, end: src.length });
  return out;
}

function canFollowNumberLiteral(prev: Token): boolean {
  // A `-` after an identifier or literal is not the start of a number.
  return prev.kind === 'ident' || prev.kind === 'literal' || prev.kind === 'rparen';
}

class TokenStream {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    readonly source: string,
  ) {}
  peek(offset: number = 0): Token {
    return this.tokens[this.i + offset] ?? this.tokens[this.tokens.length - 1];
  }
  next(): Token {
    return this.tokens[this.i++];
  }
  consume(kind: Token['kind']): Token {
    const t = this.tokens[this.i];
    if (t.kind !== kind) throw new Error(`Expected ${kind}, got ${t.kind}`);
    this.i++;
    return t;
  }
}

function parseExpression(stream: TokenStream): WhereExpression {
  return parseOr(stream);
}

function parseOr(stream: TokenStream): WhereExpression {
  let left = parseAnd(stream);
  while (stream.peek().kind === 'or') {
    stream.next();
    const right = parseAnd(stream);
    left = { type: 'logical', operator: 'OR', left, right };
  }
  return left;
}

function parseAnd(stream: TokenStream): WhereExpression {
  let left = parsePrimary(stream);
  while (stream.peek().kind === 'and') {
    stream.next();
    const right = parsePrimary(stream);
    left = { type: 'logical', operator: 'AND', left, right };
  }
  return left;
}

function parsePrimary(stream: TokenStream): WhereExpression {
  const t = stream.peek();
  if (t.kind === 'lparen') {
    stream.next();
    const expr = parseExpression(stream);
    stream.consume('rparen');
    return expr;
  }
  if (t.kind === 'not') {
    stream.next();
    const inner = parsePrimary(stream);
    const negated: NotExpression = { type: 'not', expr: inner };
    return negated;
  }
  return parseFieldExpression(stream);
}

/**
 * Parse any expression that starts with a field identifier. Dispatches
 * on the following token to choose between a plain comparison,
 * `IS [NOT] NULL`, `[NOT] IN (...)`, or `[NOT] BETWEEN low AND high`.
 */
function parseFieldExpression(stream: TokenStream): WhereExpression {
  const fieldTok = stream.next();
  if (fieldTok.kind !== 'ident') {
    throw new Error(`Expected field name, got ${fieldTok.kind}`);
  }
  const next = stream.peek();
  if (next.kind === 'keyword' && next.value === 'IS') return parseIsNull(stream, fieldTok.value);
  if (next.kind === 'keyword' && next.value === 'IN') return parseIn(stream, fieldTok.value, false);
  if (next.kind === 'keyword' && next.value === 'BETWEEN') return parseBetween(stream, fieldTok.value, false);
  if (next.kind === 'not') {
    const after = stream.peek(1);
    if (after.kind === 'keyword' && after.value === 'IN') {
      stream.next();
      return parseIn(stream, fieldTok.value, true);
    }
    if (after.kind === 'keyword' && after.value === 'BETWEEN') {
      stream.next();
      return parseBetween(stream, fieldTok.value, true);
    }
    throw new Error(`Invalid use of NOT after "${fieldTok.value}" — expected NOT IN or NOT BETWEEN`);
  }
  return parseComparisonTail(stream, fieldTok.value);
}

function parseComparisonTail(stream: TokenStream, field: string): ComparisonExpression {
  const opTok = stream.next();
  if (opTok.kind !== 'op') {
    throw new Error(`Expected operator after "${field}"`);
  }
  const valTok = stream.next();
  if (valTok.kind !== 'literal') {
    throw new Error(`Invalid operator or value: expected literal after "${opTok.value}", got ${valTok.kind}`);
  }
  const node: ComparisonExpression = {
    type: 'comparison',
    field,
    operator: opTok.value,
    value: valTok.value,
  };
  if (opTok.value === 'LIKE' || opTok.value === 'NOT LIKE') {
    node.regex = likeToRegex(String(valTok.value));
  }
  return node;
}

function parseIsNull(stream: TokenStream, field: string): IsNullExpression {
  stream.next();
  let negated = false;
  if (stream.peek().kind === 'not') {
    stream.next();
    negated = true;
  }
  const nullTok = stream.next();
  if (nullTok.kind !== 'keyword' || nullTok.value !== 'NULL') {
    throw new Error(`Expected NULL after IS${negated ? ' NOT' : ''} on "${field}"`);
  }
  return { type: 'isnull', field, negated };
}

function parseIn(stream: TokenStream, field: string, negated: boolean): InExpression {
  stream.next();
  stream.consume('lparen');
  const lookahead = stream.peek();
  // Subquery: `IN (SELECT ...)`. We slice the original source between the
  // already-consumed `(` and its matching `)`, recursively parse it, and
  // store the resulting ParsedSelect verbatim. Execution materialises the
  // subquery's first column into a Set at runtime.
  if (lookahead.kind === 'ident' && lookahead.value.toUpperCase() === 'SELECT') {
    return parseInSubquery(stream, field, negated);
  }
  const values: FieldValue[] = [];
  while (true) {
    const tok = stream.next();
    if (tok.kind !== 'literal') {
      throw new Error(`Invalid value in IN list for "${field}": expected literal, got ${tok.kind}`);
    }
    values.push(tok.value);
    const sep = stream.peek();
    if (sep.kind === 'comma') {
      stream.next();
      continue;
    }
    if (sep.kind === 'rparen') break;
    throw new Error(`Expected "," or ")" in IN list for "${field}", got ${sep.kind}`);
  }
  stream.consume('rparen');
  if (values.length === 0) {
    throw new Error(`Empty IN list for "${field}"`);
  }
  return { type: 'in', field, negated, values };
}

/**
 * Slice the subquery source between the already-consumed `(` and its
 * matching `)`, recursively parse it as a SELECT, and emit an
 * InExpression whose `values` is the ParsedSelect.
 */
function parseInSubquery(stream: TokenStream, field: string, negated: boolean): InExpression {
  // `(` was already consumed; the first character inside the subquery
  // is the start offset of the next token.
  const innerStart = stream.peek().start;
  let depth = 1;
  let innerEnd = -1;
  while (true) {
    const tok = stream.next();
    if (tok.kind === 'eof') {
      throw new Error(`Unterminated subquery for "${field} IN (...)"`);
    }
    if (tok.kind === 'lparen') {
      depth++;
      continue;
    }
    if (tok.kind === 'rparen') {
      depth--;
      if (depth === 0) {
        innerEnd = tok.start;
        break;
      }
    }
  }
  const subSrc = stream.source.slice(innerStart, innerEnd).trim();
  const sub = parse(subSrc);
  if (sub.kind !== 'select') {
    throw new Error(`Subquery for "${field} IN (...)" must be a SELECT, got ${sub.kind}`);
  }
  return { type: 'in', field, negated, values: sub };
}

function parseBetween(stream: TokenStream, field: string, negated: boolean): BetweenExpression {
  stream.next();
  const lowTok = stream.next();
  if (lowTok.kind !== 'literal') {
    throw new Error(`Expected literal low bound after BETWEEN on "${field}", got ${lowTok.kind}`);
  }
  const andTok = stream.next();
  if (andTok.kind !== 'and') {
    throw new Error(`Expected AND between BETWEEN bounds on "${field}", got ${andTok.kind}`);
  }
  const highTok = stream.next();
  if (highTok.kind !== 'literal') {
    throw new Error(`Expected literal high bound after BETWEEN ... AND on "${field}", got ${highTok.kind}`);
  }
  return { type: 'between', field, negated, low: lowTok.value, high: highTok.value };
}

export function parseWhere(src: string): WhereExpression {
  const stream = new TokenStream(tokenize(src), src);
  const expr = parseExpression(stream);
  if (stream.peek().kind !== 'eof') {
    throw new Error(`Trailing tokens in WHERE/HAVING expression: "${src}"`);
  }
  return expr;
}

/**
 * HAVING is parsed exactly like WHERE — aggregate calls like `COUNT(*)`
 * are valid identifiers in the tokenizer (they match the
 * `ident(...)` pattern), and the executor looks them up as plain
 * keys against the post-aggregation row.
 */
function parseHaving(src: string): HavingExpression {
  return parseWhere(src);
}

// ═════════════════════════════════════════════════════════════════════════════
// ORDER BY / GROUP BY
// ═════════════════════════════════════════════════════════════════════════════

function parseOrderBy(orderByPart: string): OrderByClause[] {
  return splitTopLevelCommas(orderByPart)
    .filter(Boolean)
    .map((part) => {
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

function parseGroupBy(groupByPart: string, selectPart: string): GroupByClause {
  const fields = splitTopLevelCommas(groupByPart).filter(Boolean);
  if (fields.length === 0) {
    throw new Error('GROUP BY clause must list at least one field');
  }
  const aggregates = extractAggregates(selectPart);
  return { fields, aggregates };
}

// Re-export `parseValue` for the rare external caller (tests, planner).
export { parseValue };
