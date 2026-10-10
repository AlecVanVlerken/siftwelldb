// Token-aware parser for the supported single-collection SQL subset.
import { JSONtoDocument, type FieldValue } from '../database/document.mjs';
import type {
  AggregateExpression,
  AggregateFunction,
  FieldSelector,
  OrderByClause,
  ParsedQuery,
  ParsedSelect,
  WhereExpression,
} from './ast.mjs';
import { likeToRegex } from './expressions.mjs';
import { QuerySyntaxError, tokenize, type Token } from './tokens.mjs';
export { parseValue } from './expressions.mjs';

const functions = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const clauses = ['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET'];

class Parser {
  private position = 0;
  private aggregates = new Map<string, AggregateExpression>();
  private readonly tokens: Token[];
  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }
  private peek(): Token {
    return this.tokens[this.position];
  }
  private next(): Token {
    return this.tokens[this.position++];
  }
  private is(value: string): boolean {
    const t = this.peek();
    return t.kind !== 'string' && t.value.toUpperCase() === value;
  }
  private take(value: string): boolean {
    if (!this.is(value)) return false;
    this.next();
    return true;
  }
  private expect(value: string): void {
    if (!this.take(value)) this.fail(`Expected ${value}`);
  }
  private fail(message: string): never {
    throw new QuerySyntaxError(message, this.source, this.peek().start);
  }
  private identifier(collection = false): string {
    const t = this.peek();
    if (t.kind !== 'identifier' || (collection && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value)))
      this.fail('Expected field or collection name');
    this.next();
    return t.value;
  }
  private literal(): FieldValue {
    const t = this.peek();
    if (t.kind === 'string') {
      this.next();
      return t.value;
    }
    if (t.kind === 'number') {
      this.next();
      const value = Number(t.value);
      if (!Number.isFinite(value)) this.fail('Numeric values must be finite');
      return value;
    }
    if (this.take('TRUE')) return true;
    if (this.take('FALSE')) return false;
    this.fail('Invalid value: expected a literal number, boolean, or quoted string');
  }
  private integer(label: string): number {
    const t = this.peek();
    if (t.kind !== 'number' || !/^\d+$/.test(t.value) || !Number.isSafeInteger(Number(t.value)))
      this.fail(`${label} must be a non-negative integer within the safe numeric range`);
    this.next();
    return Number(t.value);
  }
  private reference(allowAggregate: boolean): string {
    const field = this.identifier();
    if (!this.take('(')) return field;
    const func = field.toUpperCase();
    if (!allowAggregate || !functions.has(func)) this.fail(`Unsupported expression or function "${field}"`);
    const distinct = this.take('DISTINCT');
    const arg = this.take('*') ? '*' : this.identifier();
    if (arg === '*' && (func !== 'COUNT' || distinct))
      this.fail('Only COUNT(*) supports *; DISTINCT * is not supported');
    this.expect(')');
    const canonical = `${func}(${distinct ? 'DISTINCT ' : ''}${arg})`;
    this.aggregates.set(canonical, {
      func: func as AggregateFunction,
      field: arg,
      alias: canonical,
      distinct: distinct || undefined,
    });
    return canonical;
  }
  private expression(aggregate = false): WhereExpression {
    return this.or(aggregate);
  }
  private or(aggregate: boolean): WhereExpression {
    let left = this.and(aggregate);
    while (this.take('OR')) left = { type: 'logical', operator: 'OR', left, right: this.and(aggregate) };
    return left;
  }
  private and(aggregate: boolean): WhereExpression {
    let left = this.primary(aggregate);
    while (this.take('AND')) left = { type: 'logical', operator: 'AND', left, right: this.primary(aggregate) };
    return left;
  }
  private primary(aggregate: boolean): WhereExpression {
    if (this.take('NOT')) return { type: 'not', expr: this.primary(aggregate) };
    if (this.take('(')) {
      if (this.is('SELECT')) this.fail('Subqueries are not supported');
      const expr = this.expression(aggregate);
      this.expect(')');
      return expr;
    }
    const field = this.reference(aggregate);
    if (this.take('IS')) {
      const negated = this.take('NOT');
      this.expect('NULL');
      return { type: 'isnull', field, negated };
    }
    const negated = this.take('NOT');
    if (this.take('IN')) {
      this.expect('(');
      if (this.is('SELECT')) this.fail('Subqueries are not supported');
      const values = [this.literal()];
      while (this.take(',')) values.push(this.literal());
      this.expect(')');
      return { type: 'in', field, values, negated };
    }
    if (this.take('BETWEEN')) {
      const low = this.literal();
      this.expect('AND');
      const high = this.literal();
      return { type: 'between', field, low, high, negated };
    }
    const token = this.peek();
    if (token.kind === 'eof') this.fail('Expected comparison operator');
    const op = this.next().value.toUpperCase();
    if (negated && op !== 'LIKE') this.fail('NOT after a field requires IN, BETWEEN, or LIKE');
    if (!['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'CONTAINS'].includes(op)) this.fail('Invalid comparison operator');
    const value = this.literal();
    if ((op === 'LIKE' || op === 'CONTAINS') && typeof value !== 'string') this.fail(`${op} requires a quoted string`);
    const operator = (negated ? 'NOT LIKE' : op) as import('./ast.mjs').ComparisonOperator;
    return {
      type: 'comparison',
      field,
      operator,
      value,
      ...(op === 'LIKE' ? { regex: likeToRegex(value as string) } : {}),
    };
  }
  statement(): ParsedQuery {
    if (this.take('EXPLAIN')) {
      const query = this.statement();
      if (query.kind !== 'select') this.fail('EXPLAIN only supports SELECT statements');
      return { kind: 'explain', query };
    }
    if (this.take('INSERT')) {
      this.expect('INTO');
      const collection = this.identifier(true);
      this.expect('VALUES');
      const start = this.peek().start;
      if (!this.is('{')) this.fail('INSERT body must be an object literal in braces');
      this.expect('{');
      while (!this.is('}') && this.peek().kind !== 'eof') this.next();
      const end = this.peek().end;
      this.expect('}');
      const body = this.source.slice(start, end);
      const document = JSONtoDocument(body, collection).asDocument();
      return { kind: 'insert', collection, body, document };
    }
    if (this.take('UPDATE')) {
      const collection = this.identifier(true);
      this.expect('SET');
      const assignments: import('./ast.mjs').UpdateAssignment[] = [];
      const seen = new Set<string>();
      do {
        const field = this.identifier();
        if (field === 'id') this.fail('UPDATE cannot change "id" — it is the primary key');
        if (seen.has(field)) this.fail(`Duplicate UPDATE assignment for "${field}"`);
        seen.add(field);
        this.expect('=');
        assignments.push({ field, value: this.literal() });
      } while (this.take(','));
      const where = this.take('WHERE') ? this.expression() : undefined;
      return { kind: 'update', collection, assignments, where };
    }
    if (this.take('DELETE')) {
      this.expect('FROM');
      const collection = this.identifier(true);
      const tail = this.tail(false);
      return { kind: 'delete', collection, ...tail };
    }
    if (!this.take('SELECT')) this.fail('Invalid query syntax: expected SELECT, INSERT, UPDATE, DELETE, or EXPLAIN');
    const distinct = this.take('DISTINCT');
    let fields: '*' | FieldSelector[];
    if (this.take('*')) fields = '*';
    else {
      fields = [];
      do {
        const expr = this.reference(true);
        const alias = this.take('AS') ? this.identifier() : undefined;
        fields.push({ expr, alias });
      } while (this.take(','));
      const outputs = fields.map((f) => f.alias ?? f.expr);
      if (new Set(outputs).size !== outputs.length) this.fail('Duplicate SELECT output name; use unique aliases');
    }
    this.expect('FROM');
    const collection = this.identifier(true);
    const tail = this.tail(true);
    const groupBy = tail.groupBy ?? (this.aggregates.size ? { fields: [], aggregates: [] } : undefined);
    if (groupBy) groupBy.aggregates = [...this.aggregates.values()];
    if (tail.having && !groupBy) this.fail('HAVING requires GROUP BY or aggregate functions');
    const aliases = new Map(fields === '*' ? [] : fields.filter((f) => f.alias).map((f) => [f.alias!, f.expr]));
    const resolve = (name: string) => aliases.get(name) ?? name;
    if (groupBy) {
      if (fields === '*') this.fail('SELECT * cannot be combined with aggregate functions or GROUP BY');
      const valid = new Set([...groupBy.fields, ...this.aggregates.keys()]);
      for (const f of fields)
        if (!valid.has(f.expr)) this.fail(`Field "${f.expr}" must appear in GROUP BY or be aggregated`);
      if (tail.having)
        visitFields(tail.having, (name) => {
          const resolved = resolve(name);
          if (!valid.has(resolved)) this.fail(`HAVING field "${name}" must be grouped or aggregated`);
          return resolved;
        });
      for (const o of tail.orderBy ?? [])
        if (!valid.has(resolve(o.field)))
          this.fail(`ORDER BY field "${o.field}" must be a GROUP BY field, aggregate, or SELECT alias`);
    }
    if (distinct && fields !== '*') {
      const outputs = new Set(fields.map((f) => f.alias ?? f.expr));
      for (const o of tail.orderBy ?? [])
        if (!outputs.has(o.field)) this.fail(`ORDER BY field "${o.field}" must appear in SELECT DISTINCT output`);
    }
    return { kind: 'select', fields, collection, distinct: distinct || undefined, ...tail, groupBy };
  }
  private tail(select: boolean): Pick<ParsedSelect, 'where' | 'groupBy' | 'having' | 'orderBy' | 'limit' | 'offset'> {
    const tail: Pick<ParsedSelect, 'where' | 'groupBy' | 'having' | 'orderBy' | 'limit' | 'offset'> = {};
    let previous = -1;
    while (this.peek().kind === 'identifier') {
      const keyword = this.peek().value.toUpperCase();
      const index = clauses.indexOf(keyword);
      if (index < 0) break;
      if (index <= previous) this.fail(`Duplicate or out-of-order ${keyword} clause`);
      if (!select && (keyword === 'GROUP' || keyword === 'HAVING'))
        this.fail('DELETE supports WHERE, ORDER BY, LIMIT, and OFFSET only');
      previous = index;
      this.next();
      if (keyword === 'WHERE') tail.where = this.expression();
      else if (keyword === 'HAVING') tail.having = this.expression(true);
      else if (keyword === 'GROUP') {
        this.expect('BY');
        const fields = [this.identifier()];
        while (this.take(',')) fields.push(this.identifier());
        tail.groupBy = { fields, aggregates: [] };
      } else if (keyword === 'ORDER') {
        this.expect('BY');
        const orderBy: OrderByClause[] = [];
        do {
          const field = this.reference(select);
          const direction = this.take('DESC') ? 'DESC' : (this.take('ASC'), 'ASC');
          if (this.peek().kind === 'identifier' && !clauses.includes(this.peek().value.toUpperCase()))
            this.fail('Invalid sort direction or trailing ORDER BY token; use ASC or DESC');
          orderBy.push({ field, direction });
        } while (this.take(','));
        tail.orderBy = orderBy;
      } else if (keyword === 'LIMIT') tail.limit = this.integer('LIMIT');
      else tail.offset = this.integer('OFFSET');
    }
    return tail;
  }
  finish(): void {
    this.take(';');
    if (this.peek().kind !== 'eof') {
      const token = this.peek().value.toUpperCase();
      if (['JOIN', 'UNION', 'WITH'].includes(token)) this.fail(`${token} is not supported`);
      this.fail(`Unexpected trailing token "${this.peek().value}"; unsupported expression or clause`);
    }
  }
}

function visitFields(expr: WhereExpression, resolve: (field: string) => string): void {
  if (expr.type === 'logical') {
    visitFields(expr.left, resolve);
    visitFields(expr.right, resolve);
  } else if (expr.type === 'not') visitFields(expr.expr, resolve);
  else expr.field = resolve(expr.field);
}

export function parse(query: string): ParsedQuery {
  const parser = new Parser(query);
  const result = parser.statement();
  parser.finish();
  return result;
}
