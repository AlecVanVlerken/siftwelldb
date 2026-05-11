// author: Conversational Analytics Module

import type { LLMProvider, ChatMessage } from './llmProvider.mjs';
import type { SemanticModel } from './semanticModel.mjs';
import { getDerivedFields } from './semanticModel.mjs';
import type { QueryResultRow } from '../dbms/querylanguage/querylanguage.mjs';
import { QueryLanguage } from '../dbms/querylanguage/querylanguage.mjs';
import { QueryGenerator } from './queryGenerator.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import type { FieldValue } from '../dbms/document.mjs';

export type ChartSpec = {
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'none';
  title: string;
  xColumn: string;
  yColumns: string[];
  /** When set, the data is pivoted so each unique value in this column becomes a separate dataset/series. */
  seriesColumn?: string;
} | null;

export type Suggestion = {
  text: string;
  type: 'drill' | 'compare' | 'filter' | 'explore';
};

export type AnalyticsResponse = {
  question: string;
  query: string;
  data: QueryResultRow[];
  summary: string;
  chart: ChartSpec;
  /** One-line restatement of how the query was interpreted (e.g. "average salary grouped by department"). */
  interpretation?: string;
  /** Up to four contextual follow-up suggestions, one per intent type. */
  suggestions?: Suggestion[];
  /** Statistical outlier or surprising pattern in the results, if any. */
  anomaly?: string;
  /** Alternative phrasings when the query returned 0 results. */
  didYouMean?: string[];
  error?: string;
};

export type ConversationalEngineConfig = {
  dbms: SimpleDbms;
  llmProvider: LLMProvider;
  semanticModel: SemanticModel;
};

const MAX_HISTORY = 20;

// ── Local mirror types for the (unexported) QL internal AST ──────────────────
// These structurally match the private ParsedSelect / WhereExpression types in
// querylanguage.mts. The cast `parsed as unknown as LSelect` is safe at runtime.

type LWhereExpr =
  | { type: 'comparison'; field: string; operator: string; value: FieldValue }
  | { type: 'logical'; operator: string; left: LWhereExpr; right: LWhereExpr };

type LAgg = { func: string; field: string; alias: string };
type LGroupBy = { fields: string[]; aggregates: LAgg[] };
type LOrderBy = { field: string; direction: 'ASC' | 'DESC' };

type LSelect = {
  kind: 'select';
  fields: '*' | string[];
  collection: string;
  where?: LWhereExpr;
  groupBy?: LGroupBy;
  having?: LWhereExpr;
  orderBy?: LOrderBy[];
  limit?: number;
  offset?: number;
};

/**
 * Top-level orchestrator with conversation memory.
 *
 * Maintains a rolling history of messages so the LLM can resolve
 * references like "break that down by city" or "same but for Sales".
 * Also asks the LLM to produce a summary, chart spec, interpretation,
 * and follow-up suggestions in a single structured call.
 */
export class ConversationalEngine {
  private queryLanguage: QueryLanguage;
  private queryGenerator: QueryGenerator;
  private llmProvider: LLMProvider;
  private semanticModel: SemanticModel;
  private history: ChatMessage[] = [];

  constructor(config: ConversationalEngineConfig) {
    this.queryLanguage = new QueryLanguage(config.dbms);
    this.queryGenerator = new QueryGenerator(config.llmProvider, config.semanticModel, this.queryLanguage);
    this.llmProvider = config.llmProvider;
    this.semanticModel = config.semanticModel;
  }

  /**
   * Ask a question with full conversation context.
   * Optionally accepts external history (from the frontend) to support
   * stateless server deployments.
   */
  async ask(question: string, externalHistory?: ChatMessage[]): Promise<AnalyticsResponse> {
    const history = externalHistory ?? this.history;

    let query: string;
    let data: QueryResultRow[];

    // ── Step 1: generate a query using conversation context ──────────────
    let generated: Awaited<ReturnType<QueryGenerator['generate']>>;
    try {
      generated = await this.queryGenerator.generate(question, history);
      query = generated.query;
    } catch (err) {
      const errMsg = `Failed to generate query: ${err instanceof Error ? err.message : String(err)}`;
      this.pushHistory(history, question, errMsg);
      return { question, query: '', data: [], summary: '', chart: null, error: errMsg };
    }

    // ── Step 2: SELECT-only guard ────────────────────────────────────────
    // The chat interface is read-only analytics. Reject any LLM-generated
    // INSERT or DELETE to prevent accidental or prompt-injected mutations.
    if (generated.parsed.kind !== 'select') {
      const errMsg = `Only SELECT queries are allowed via chat (got: ${generated.parsed.kind}).`;
      this.pushHistory(history, question, errMsg);
      return { question, query, data: [], summary: '', chart: null, error: errMsg };
    }

    // ── Step 3: execute (with derived-field support if needed) ───────────
    try {
      const sel = generated.parsed as unknown as LSelect;
      const derivedFields = getDerivedFields(this.semanticModel, sel.collection);

      if (derivedFields.size > 0 && this.queryReferencesDerived(query, derivedFields)) {
        data = await this.executeWithDerived(sel, derivedFields);
      } else {
        data = await this.queryLanguage.execute(query);
      }
    } catch (err) {
      const errMsg = `Query execution failed: ${err instanceof Error ? err.message : String(err)}`;
      this.pushHistory(history, question, errMsg);
      return { question, query, data: [], summary: '', chart: null, error: errMsg };
    }

    // ── Step 4: summarize + chart + suggestions in one LLM call ─────────
    let summary = '';
    let chart: ChartSpec = null;
    let interpretation: string | undefined;
    let suggestions: Suggestion[] | undefined;
    let anomaly: string | undefined;
    let didYouMean: string[] | undefined;

    if (data.length > 0) {
      try {
        const insight = await this.generateInsight(question, query, data, history);
        summary = insight.summary;
        chart = insight.chart;
        interpretation = insight.interpretation;
        suggestions = insight.suggestions;
        anomaly = insight.anomaly;
      } catch {
        summary = `Returned ${data.length} row(s).`;
      }
    } else {
      summary = 'No results found.';
      didYouMean = await this.generateDidYouMean(question, query, history);
    }

    const assistantText = `Query: ${query}\nResult: ${summary}`;
    this.pushHistory(history, question, assistantText);

    return { question, query, data, summary, chart, interpretation, suggestions, anomaly, didYouMean };
  }

  clearHistory(): void {
    this.history = [];
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  private pushHistory(history: ChatMessage[], question: string, answer: string): void {
    history.push({ role: 'user', text: question });
    history.push({ role: 'assistant', text: answer });
    while (history.length > MAX_HISTORY) history.shift();
    if (history === this.history) return;
    this.history = [...history];
  }

  // ── Derived field execution ───────────────────────────────────────────────

  /** Returns true if the query string contains any derived field name as a word. */
  private queryReferencesDerived(queryStr: string, derivedFields: Map<string, string>): boolean {
    for (const name of derivedFields.keys()) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(queryStr)) return true;
    }
    return false;
  }

  /**
   * Executes a SELECT query that references derived (computed) fields.
   *
   * Because the QL executor works on raw document fields, derived fields
   * can't be passed through it directly. Instead we:
   *   1. Fetch all base rows from the collection
   *   2. Compute derived field values for each row using JavaScript
   *   3. Apply WHERE / GROUP BY / SELECT / ORDER BY / LIMIT in JavaScript
   */
  private async executeWithDerived(parsed: LSelect, derivedFields: Map<string, string>): Promise<QueryResultRow[]> {
    // 1. Fetch all raw rows
    const rawRows = await this.queryLanguage.execute(`SELECT * FROM ${parsed.collection}`);

    // 2. Enrich with derived field values
    const rows = rawRows.map((row) => {
      const enriched: QueryResultRow = { ...row };
      for (const [name, expr] of derivedFields) {
        enriched[name] = evalDerivedExpr(expr, row as Record<string, FieldValue>);
      }
      return enriched;
    });

    // 3. Apply WHERE
    let results = parsed.where ? rows.filter((r) => evalWhere(r as Record<string, FieldValue>, parsed.where!)) : rows;

    // 4. Apply GROUP BY + HAVING
    if (parsed.groupBy) {
      results = applyGroupBy(results, parsed.groupBy, parsed.having);
    }

    // 5. Apply SELECT projection
    results = applyProjection(results, parsed.fields, parsed.groupBy);

    // 6. Apply ORDER BY
    if (parsed.orderBy && parsed.orderBy.length > 0) {
      results = applyOrderBy(results, parsed.orderBy);
    }

    // 7. Apply LIMIT / OFFSET
    const offset = parsed.offset ?? 0;
    const limit = parsed.limit ?? Infinity;
    return results.slice(offset, offset === 0 && limit === Infinity ? undefined : offset + limit);
  }

  // ── Insight generation ────────────────────────────────────────────────────

  private async generateDidYouMean(question: string, query: string, history: ChatMessage[]): Promise<string[]> {
    const msg = `The user asked: "${question}"
The system generated this query: ${query}
The query returned 0 results.

Suggest 2-3 alternative ways the user could rephrase their question to get useful results.
Consider: the value they specified might not exist, or the question might be too narrow.
Respond with ONLY a JSON array of strings: ["suggestion1", "suggestion2", ...]`;

    try {
      const response = await this.llmProvider.chat(
        'You are a helpful data assistant. Suggest rephrased questions when a query returns no results. Output ONLY a JSON array of strings.',
        history,
        msg,
      );
      let text = response.text.trim();
      const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
      if (fence) text = fence[1].trim();
      const parsed = JSON.parse(text) as unknown[];
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').slice(0, 3) : [];
    } catch {
      return [];
    }
  }

  private async generateInsight(
    question: string,
    query: string,
    data: QueryResultRow[],
    history: ChatMessage[],
  ): Promise<{ summary: string; chart: ChartSpec; interpretation?: string; suggestions?: Suggestion[]; anomaly?: string }> {
    const preview = data.slice(0, 30);
    const cols = data.length > 0 ? Object.keys(data[0]) : [];
    const dataStr = JSON.stringify(preview, null, 2);
    const truncated = data.length > 30 ? `\n(showing first 30 of ${data.length} rows)` : '';

    const userMsg = `The user asked: "${question}"

Query executed: ${query}

Result columns: ${cols.join(', ')}
Result rows (${data.length} total):
${dataStr}${truncated}

Respond with a JSON object (no markdown, no code fences) with exactly these fields:
{
  "summary": "<concise 1-3 sentence answer to the user's question, be specific with numbers>",
  "chart": <null if no chart is appropriate, or a chart spec object (see below)>,
  "interpretation": "<one-line restatement of what the query measures, e.g. 'average salary grouped by department, ordered highest first'>",
  "suggestions": [
    {"type": "drill",   "text": "<follow-up drilling into a specific value from the results — name it explicitly>"},
    {"type": "compare", "text": "<follow-up comparing two groups visible in the results>"},
    {"type": "filter",  "text": "<follow-up restricting the same question to a subset>"},
    {"type": "explore", "text": "<follow-up exploring a different dimension or angle>"}
  ],
  "anomaly": <null if nothing notable, or a single concise sentence flagging something statistically surprising — e.g. an outlier group, an unexpectedly large gap, or a value that seems wrong>
}

Suggestion guidelines:
- Ground each suggestion in the actual result data (use real values/categories that appear in the results)
- Keep suggestion text under 10 words, phrased as a natural question or instruction
- "drill": go deeper into one specific result value (e.g. if Engineering scored highest, ask about Engineering)
- "compare": compare two specific groups seen in the results
- "filter": same question but restricted to a specific subset
- "explore": uncover a related angle not yet seen

Chart spec format:
  {"type":"bar|line|pie|doughnut","title":"...","xColumn":"...","yColumns":["..."],"seriesColumn":"...or omit"}

Chart guidelines:
- Use "bar" for comparing categories (e.g. department salaries, city counts).
- Use "pie" or "doughnut" for showing proportions (e.g. gender split, department headcount) when there are <=8 categories.
- Use "line" for trends over ordered/numeric data.
- Use "none" or null for single-value results, large lists of individual records, or when a chart wouldn't add value.
- xColumn must be one of the result columns (the primary category axis). yColumns must be numeric result columns.
- IMPORTANT — seriesColumn: When the result has TWO categorical/grouping columns (e.g. department AND gender), set xColumn to the primary grouping (e.g. "department") and seriesColumn to the secondary grouping (e.g. "gender"). This creates one dataset per unique value in seriesColumn (e.g. one bar group for M, one for F). Only use seriesColumn when there are exactly two categorical columns in the result. Omit it when there is only one categorical column.`;

    const systemPrompt =
      'You are a data analyst. Given query results, produce a JSON object with a summary, chart specification, interpretation, and follow-up suggestions. Output ONLY valid JSON, no markdown.';

    const response = await this.llmProvider.chat(systemPrompt, history, userMsg);
    return this.parseInsight(response.text, cols);
  }

  private parseInsight(
    raw: string,
    cols: string[],
  ): { summary: string; chart: ChartSpec; interpretation?: string; suggestions?: Suggestion[]; anomaly?: string } {
    let text = raw.trim();
    const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
    if (fence) text = fence[1].trim();

    try {
      const parsed = JSON.parse(text) as {
        summary?: string;
        chart?: ChartSpec;
        interpretation?: string;
        suggestions?: unknown[];
        anomaly?: unknown;
      };

      const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
      const interpretation = typeof parsed.interpretation === 'string' ? parsed.interpretation : undefined;

      let chart: ChartSpec = null;
      if (parsed.chart && typeof parsed.chart === 'object' && parsed.chart.type && parsed.chart.type !== 'none') {
        const c = parsed.chart as Record<string, unknown>;
        const validTypes = new Set(['bar', 'line', 'pie', 'doughnut']);
        if (validTypes.has(c.type as string) && cols.includes(c.xColumn as string) && Array.isArray(c.yColumns)) {
          const validY = (c.yColumns as string[]).filter((y: string) => cols.includes(y));
          if (validY.length > 0) {
            chart = {
              type: c.type as NonNullable<ChartSpec>['type'],
              title: (c.title as string) || '',
              xColumn: c.xColumn as string,
              yColumns: validY,
            };
            if (typeof c.seriesColumn === 'string' && cols.includes(c.seriesColumn)) {
              chart.seriesColumn = c.seriesColumn;
            }
          }
        }
      }

      const validSuggestionTypes = new Set(['drill', 'compare', 'filter', 'explore']);
      const suggestions: Suggestion[] = Array.isArray(parsed.suggestions)
        ? (parsed.suggestions as unknown[])
            .filter(
              (s): s is { type: string; text: string } =>
                typeof s === 'object' &&
                s !== null &&
                typeof (s as Record<string, unknown>).type === 'string' &&
                typeof (s as Record<string, unknown>).text === 'string' &&
                validSuggestionTypes.has((s as Record<string, unknown>).type as string),
            )
            .map((s) => ({ type: s.type as Suggestion['type'], text: s.text }))
        : [];

      const anomaly =
        typeof parsed.anomaly === 'string' && parsed.anomaly.trim() ? parsed.anomaly.trim() : undefined;

      return { summary, chart, interpretation, suggestions: suggestions.length > 0 ? suggestions : undefined, anomaly };
    } catch {
      return { summary: text, chart: null };
    }
  }
}

// ── Derived field helpers (module-level, pure functions) ──────────────────────

/**
 * Evaluates a JavaScript expression against a document row.
 * Expressions use the document's field names as variables
 * (e.g. "salary < 60000 ? 'Low' : salary < 90000 ? 'Mid' : 'High'").
 *
 * Expressions come from the server-side model JSON — not from user input.
 */
function evalDerivedExpr(expr: string, row: Record<string, FieldValue>): FieldValue {
  try {
    const keys = Object.keys(row);
    const vals = Object.values(row);
    // eslint-disable-next-line no-new-func
    const fn = new Function(...keys, `"use strict"; return (${expr});`) as (...args: FieldValue[]) => FieldValue;
    return fn(...vals);
  } catch {
    return '';
  }
}

function evalWhere(row: Record<string, FieldValue>, expr: LWhereExpr): boolean {
  if (expr.type === 'logical') {
    const l = evalWhere(row, expr.left);
    const r = evalWhere(row, expr.right);
    return expr.operator.toUpperCase() === 'AND' ? l && r : l || r;
  }
  const v = row[expr.field];
  const t = expr.value;
  switch (expr.operator) {
    case '=': return v === t;
    case '!=': return v !== t;
    case '>': return typeof v === 'number' && typeof t === 'number' && v > t;
    case '>=': return typeof v === 'number' && typeof t === 'number' && v >= t;
    case '<': return typeof v === 'number' && typeof t === 'number' && v < t;
    case '<=': return typeof v === 'number' && typeof t === 'number' && v <= t;
    default: return false;
  }
}

function applyGroupBy(rows: QueryResultRow[], groupBy: LGroupBy, having?: LWhereExpr): QueryResultRow[] {
  const groups = new Map<string, QueryResultRow[]>();
  for (const row of rows) {
    const key = groupBy.fields.map((f) => String(row[f] ?? '')).join('\x00');
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const results: QueryResultRow[] = [];
  for (const groupRows of groups.values()) {
    const out: QueryResultRow = {};
    for (const f of groupBy.fields) out[f] = groupRows[0][f];
    for (const agg of groupBy.aggregates) out[agg.alias] = computeAgg(groupRows, agg);
    if (having && !evalWhere(out as Record<string, FieldValue>, having)) continue;
    results.push(out);
  }
  return results;
}

function computeAgg(rows: QueryResultRow[], agg: LAgg): number {
  const nums = () => rows.map((r) => r[agg.field]).filter((v): v is number => typeof v === 'number');
  switch (agg.func.toUpperCase()) {
    case 'COUNT': return rows.length;
    case 'SUM': return rows.reduce((s, r) => s + (typeof r[agg.field] === 'number' ? (r[agg.field] as number) : 0), 0);
    case 'AVG': {
      const n = nums(); return n.length > 0 ? n.reduce((a, b) => a + b, 0) / n.length : 0;
    }
    case 'MIN': { const n = nums(); return n.length > 0 ? Math.min(...n) : 0; }
    case 'MAX': { const n = nums(); return n.length > 0 ? Math.max(...n) : 0; }
    default: return 0;
  }
}

function applyProjection(rows: QueryResultRow[], fields: '*' | string[], groupBy?: LGroupBy): QueryResultRow[] {
  if (fields === '*') return rows;
  const aggAliases = new Set<string>(groupBy?.aggregates.map((a) => a.alias) ?? []);
  return rows.map((row) => {
    const out: QueryResultRow = {};
    for (const f of fields) {
      if (f in row || aggAliases.has(f)) out[f] = row[f];
    }
    return out;
  });
}

function applyOrderBy(rows: QueryResultRow[], orderBy: LOrderBy[]): QueryResultRow[] {
  return [...rows].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const av = a[field], bv = b[field];
      let cmp = 0;
      if (av === undefined && bv === undefined) cmp = 0;
      else if (av === undefined) cmp = 1;
      else if (bv === undefined) cmp = -1;
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      if (cmp !== 0) return direction === 'DESC' ? -cmp : cmp;
    }
    return 0;
  });
}
