// author: Conversational Analytics Module

import type { LLMProvider, ChatMessage } from './llmProvider.mjs';
import type { SemanticModel } from './semanticModel.mjs';
import type { QueryResultRow } from '../dbms/querylanguage/querylanguage.mjs';
import { QueryLanguage } from '../dbms/querylanguage/querylanguage.mjs';
import { QueryGenerator } from './queryGenerator.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';

export type ChartSpec = {
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'none';
  title: string;
  xColumn: string;
  yColumns: string[];
  /** When set, the data is pivoted so each unique value in this column becomes a separate dataset/series. */
  seriesColumn?: string;
} | null;

export type AnalyticsResponse = {
  question: string;
  query: string;
  data: QueryResultRow[];
  summary: string;
  chart: ChartSpec;
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
 * Also asks the LLM to produce both a summary and chart spec in a
 * single structured call.
 */
export class ConversationalEngine {
  private queryLanguage: QueryLanguage;
  private queryGenerator: QueryGenerator;
  private llmProvider: LLMProvider;
  private history: ChatMessage[] = [];

  constructor(config: ConversationalEngineConfig) {
    this.queryLanguage = new QueryLanguage(config.dbms);
    this.queryGenerator = new QueryGenerator(config.llmProvider, config.semanticModel, this.queryLanguage);
    this.llmProvider = config.llmProvider;
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
    try {
      const generated = await this.queryGenerator.generate(question, history);
      query = generated.query;
    } catch (err) {
      const errMsg = `Failed to generate query: ${err instanceof Error ? err.message : String(err)}`;
      this.pushHistory(history, question, errMsg);
      return { question, query: '', data: [], summary: '', chart: null, error: errMsg };
    }

    // ── Step 2: execute ──────────────────────────────────────────────────
    try {
      data = await this.queryLanguage.execute(query);
    } catch (err) {
      const errMsg = `Query execution failed: ${err instanceof Error ? err.message : String(err)}`;
      this.pushHistory(history, question, errMsg);
      return { question, query, data: [], summary: '', chart: null, error: errMsg };
    }

    // ── Step 3: summarize + chart spec in one LLM call ──────────────────
    let summary = '';
    let chart: ChartSpec = null;

    if (data.length > 0) {
      try {
        const insight = await this.generateInsight(question, query, data, history);
        summary = insight.summary;
        chart = insight.chart;
      } catch {
        summary = `Returned ${data.length} row(s).`;
      }
    } else {
      summary = 'No results found.';
    }

    const assistantText = `Query: ${query}\nResult: ${summary}`;
    this.pushHistory(history, question, assistantText);

    return { question, query, data, summary, chart };
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

  private async generateInsight(
    question: string,
    query: string,
    data: QueryResultRow[],
    history: ChatMessage[],
  ): Promise<{ summary: string; chart: ChartSpec }> {
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
  "chart": <null if no chart is appropriate, or a chart spec object (see below)>
}

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
      'You are a data analyst. Given query results, produce a JSON object with a summary and chart specification. Output ONLY valid JSON, no markdown.';

    const response = await this.llmProvider.chat(systemPrompt, history, userMsg);
    return this.parseInsight(response.text, cols);
  }

  private parseInsight(raw: string, cols: string[]): { summary: string; chart: ChartSpec } {
    let text = raw.trim();
    // Strip code fences if present
    const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
    if (fence) text = fence[1].trim();

    try {
      const parsed = JSON.parse(text) as { summary?: string; chart?: ChartSpec };
      const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
      let chart: ChartSpec = null;

      if (parsed.chart && typeof parsed.chart === 'object' && parsed.chart.type && parsed.chart.type !== 'none') {
        const c = parsed.chart as Record<string, unknown>;
        const validTypes = new Set(['bar', 'line', 'pie', 'doughnut']);
        if (validTypes.has(c.type as string) && cols.includes(c.xColumn as string) && Array.isArray(c.yColumns)) {
          const validY = (c.yColumns as string[]).filter((y: string) => cols.includes(y));
          if (validY.length > 0) {
            chart = {
              type: c.type as ChartSpec & object extends null ? never : NonNullable<ChartSpec>['type'],
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

      return { summary, chart };
    } catch {
      // If JSON parsing fails, treat the whole thing as the summary
      return { summary: text, chart: null };
    }
  }
}
