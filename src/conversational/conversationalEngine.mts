// author: Conversational Analytics Module

import type { LLMProvider, ChatMessage } from './llmProvider.mjs';
import type { SemanticModel } from './semanticModel.mjs';
import { modelToSchemaPrompt } from './semanticModel.mjs';
import type { ParsedQuery, QueryResultRow } from '../dbms/querylanguage/querylanguage.mjs';
import { QueryLanguage } from '../dbms/querylanguage/querylanguage.mjs';
import { QueryGenerator } from './queryGenerator.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';

/**
 * Whitelist of query kinds the chat surface will execute. Anything not
 * in here is rejected — keep this list to operations that cannot mutate
 * the database.
 */
function isReadOnlyKind(kind: ParsedQuery['kind']): boolean {
  return kind === 'select' || kind === 'explain';
}

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

    if (isMutationSyntaxHelpQuestion(question)) {
      return this.answerMutationSyntaxHelp(question, history);
    }

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

    // ── Step 2: read-only guard ──────────────────────────────────────────
    // The chat interface is read-only analytics. Deny any mutating kind
    // (INSERT / UPDATE / DELETE) instead of allowlisting SELECT — that
    // way new read-only kinds (EXPLAIN / future SHOW, …) work
    // automatically without another policy edit.
    if (!isReadOnlyKind(generated.parsed.kind)) {
      const errMsg = `Only read-only queries are allowed via chat (got: ${generated.parsed.kind}).`;
      this.pushHistory(history, question, errMsg);
      return { question, query, data: [], summary: '', chart: null, error: errMsg };
    }

    // ── Step 3: execute ──────────────────────────────────────────────────
    try {
      data = await this.queryLanguage.execute(query);
      if (
        data.length === 0 &&
        generated.parsed.kind === 'select' &&
        generated.parsed.where
      ) {
        const repaired = await this.tryRepairEmptyResult(question, query, history);
        if (repaired) {
          query = repaired.query;
          data = repaired.data;
          generated = repaired.generated;
        }
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

  private async tryRepairEmptyResult(
    question: string,
    failedQuery: string,
    history: ChatMessage[],
  ): Promise<{
    query: string;
    data: QueryResultRow[];
    generated: Awaited<ReturnType<QueryGenerator['generate']>>;
  } | null> {
    try {
      const generated = await this.queryGenerator.repairEmptyResult(question, failedQuery, history);
      if (!isReadOnlyKind(generated.parsed.kind)) return null;
      const data = await this.queryLanguage.execute(generated.query);
      return { query: generated.query, data, generated };
    } catch {
      return null;
    }
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

  private async answerMutationSyntaxHelp(question: string, history: ChatMessage[]): Promise<AnalyticsResponse> {
    const systemPrompt = buildMutationSyntaxAdvisorPrompt(this.semanticModel);
    try {
      const response = await this.llmProvider.chat(systemPrompt, history, question);
      const summary = response.text.trim();
      this.pushHistory(history, question, summary);
      return { question, query: '', data: [], summary, chart: null };
    } catch (err) {
      const fallback = mutationSyntaxFallback(question);
      this.pushHistory(history, question, fallback);
      return {
        question,
        query: '',
        data: [],
        summary: fallback,
        chart: null,
        error: `Failed to generate syntax advice: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
      if (parsed.chart && typeof parsed.chart === 'object') {
        const c = parsed.chart as Record<string, unknown>;
        const validTypes = new Set(['bar', 'line', 'pie', 'doughnut']);
        if (
          validTypes.has(c['type'] as string) &&
          c['type'] !== 'none' &&
          cols.includes(c['xColumn'] as string) &&
          Array.isArray(c['yColumns'])
        ) {
          const validY = (c['yColumns'] as string[]).filter((y: string) => cols.includes(y));
          if (validY.length > 0) {
            chart = {
              type: c['type'] as NonNullable<ChartSpec>['type'],
              title: (c['title'] as string) || '',
              xColumn: c['xColumn'] as string,
              yColumns: validY,
            };
            if (typeof c['seriesColumn'] === 'string' && cols.includes(c['seriesColumn'])) {
              chart.seriesColumn = c['seriesColumn'];
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
                typeof (s as Record<string, unknown>)['type'] === 'string' &&
                typeof (s as Record<string, unknown>)['text'] === 'string' &&
                validSuggestionTypes.has((s as Record<string, unknown>)['type'] as string),
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

function isMutationSyntaxHelpQuestion(question: string): boolean {
  const text = question.toLowerCase();
  const mentionsMutation = /\b(delete|remove|update|insert|add|mutat(?:e|ion)|change)\b/.test(text);
  if (!mentionsMutation) return false;
  return /\b(how|syntax|query|write|advise|advice|example|can i|should i|what(?:'s| is)? the query)\b/.test(text);
}

function buildMutationSyntaxAdvisorPrompt(model: SemanticModel): string {
  const schema = modelToSchemaPrompt(model);
  return `You are a SimpleDBMS query-language syntax advisor. Explain valid syntax, examples, and limitations in plain language.

The chat interface is read-only and MUST NOT execute mutations. If the user asks for INSERT, UPDATE, or DELETE, give syntax they can paste into the query editor and clearly say chat will not run it.

DATABASE SCHEMA:
${schema}

SUPPORTED QUERY SYNTAX:
  SELECT [DISTINCT] <fields|*|aggregates> FROM <collection>
    [WHERE <conditions>]
    [GROUP BY <fields>]
    [HAVING <aggregate_conditions>]
    [ORDER BY <field> [ASC|DESC], ...]
    [LIMIT n]
    [OFFSET k]

  EXPLAIN SELECT ...

  INSERT INTO <collection> VALUES {id: '...', field: ...}

  UPDATE <collection> SET field = value [, field2 = value2, ...]
    [WHERE <conditions>]

  DELETE FROM <collection>
    [WHERE <conditions>]
    [ORDER BY <field> [ASC|DESC], ...]
    [LIMIT n]
    [OFFSET k]

WHERE/HAVING:
  Comparisons: =, !=, >, >=, <, <=
  Text: field CONTAINS 'text', field LIKE 'A%', field NOT LIKE '%x'
  Sets: field IN ('a', 'b'), field NOT IN ('a', 'b')
  Ranges: field BETWEEN low AND high, field NOT BETWEEN low AND high
  Missing values: field IS NULL, field IS NOT NULL
  Logic: AND, OR, NOT (...), parentheses

LIMITATION:
  DELETE supports ORDER BY / LIMIT / OFFSET. UPDATE does not support ORDER BY, LIMIT, or OFFSET.

RULES:
  - Be concise and practical.
  - Use exact collection and field names from the schema when possible.
  - Do not claim the chat has executed a mutation.
  - If the user asks to delete images and the schema has image MIME sidecars such as _image_mime, prefer DELETE FROM <collection> WHERE _image_mime IS NOT NULL ORDER BY id ASC LIMIT n.`;
}

function mutationSyntaxFallback(question: string): string {
  if (/\bdelete|remove\b/i.test(question)) {
    return `Chat cannot execute DELETE, but the query editor supports bounded DELETE statements. For example:

DELETE FROM photos WHERE _image_mime IS NOT NULL ORDER BY id ASC LIMIT 50;`;
  }
  return 'Chat cannot execute mutations, but the query editor supports INSERT, UPDATE, and DELETE statements with WHERE filters.';
}
