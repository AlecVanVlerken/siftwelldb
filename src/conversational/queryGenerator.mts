// author: Conversational Analytics Module

import type { LLMProvider, ChatMessage } from './llmProvider.mjs';
import type { SemanticModel } from './semanticModel.mjs';
import { modelToSchemaPrompt } from './semanticModel.mjs';
import { QueryLanguage, type ParsedQuery } from '../dbms/querylanguage/querylanguage.mjs';

export type GeneratedQuery = {
  query: string;
  parsed: ParsedQuery;
};

/**
 * Translates natural-language questions into executable queries for the
 * SimpleDbms QueryLanguage, using an LLM informed by a semantic model
 * and conversation history.
 */
export class QueryGenerator {
  private provider: LLMProvider;
  private systemPrompt: string;
  private queryLanguage: QueryLanguage;

  constructor(provider: LLMProvider, model: SemanticModel, queryLanguage: QueryLanguage) {
    this.provider = provider;
    this.queryLanguage = queryLanguage;
    this.systemPrompt = buildSystemPrompt(model);
  }

  /**
   * Generate a query from a natural-language question.
   * Conversation history is passed so the LLM can resolve references
   * like "break that down by department" or "same but for Sales".
   */
  async generate(question: string, history: ChatMessage[] = []): Promise<GeneratedQuery> {
    const raw = await this.provider.chat(this.systemPrompt, history, question);
    const query = extractQuery(raw.text);

    try {
      const parsed = this.queryLanguage.parse(query);
      return { query, parsed };
    } catch (firstErr) {
      const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const retryMsg = `The query you generated was invalid:\n${query}\nError: ${errMsg}\nPlease fix it. Respond with ONLY the corrected query.`;
      const retryRaw = await this.provider.chat(this.systemPrompt, history, retryMsg);
      const retryQuery = extractQuery(retryRaw.text);
      const parsed = this.queryLanguage.parse(retryQuery);
      return { query: retryQuery, parsed };
    }
  }
}

function buildSystemPrompt(model: SemanticModel): string {
  const schema = modelToSchemaPrompt(model);

  return `You are a query generator for a SimpleDBMS. Your ONLY job is to convert natural-language questions into valid queries.

DATABASE SCHEMA:
${schema}

QUERY SYNTAX (SQL-like):
  SELECT <fields|*|aggregates> FROM <collection>
    [JOIN <collection> ON <left_field> = <right_field>]
    [WHERE <conditions>]
    [GROUP BY <fields>]
    [HAVING <aggregate_conditions>]
    [ORDER BY <field> [ASC|DESC], ...]
    [LIMIT n]
    [OFFSET k]

WHERE/HAVING conditions support: =, !=, >, >=, <, <= with AND / OR.
Aggregates: COUNT(*), SUM(field), AVG(field), MIN(field), MAX(field).
String values must be in single quotes: 'value'.
Field names are case-sensitive and must match the schema exactly.

RULES:
1. Respond with ONLY the query. No explanation, no markdown, no code fences.
2. Use the exact field names from the schema above.
3. When the user asks about a concept, use the field synonyms and descriptions to find the right field.
4. For questions asking "how many", use COUNT(*).
5. For "average", "mean" use AVG(). For "total", "sum" use SUM().
6. For "highest", "most", "maximum" use MAX() or ORDER BY ... DESC LIMIT 1.
7. For "lowest", "least", "minimum" use MIN() or ORDER BY ... ASC LIMIT 1.
8. If a question involves multiple collections, use JOIN when relationships are defined.
9. If the question is ambiguous, prefer the simplest valid query.
10. Always include the relevant fields in SELECT so the answer is understandable.
11. IMPORTANT: If the user references a previous question (e.g. "break that down by city", "same but for Sales", "now filter those"), use the conversation history to understand what they mean and generate the appropriate new query.`;
}

function extractQuery(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:sql)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/;\s*$/, '').trim();
  return text;
}
