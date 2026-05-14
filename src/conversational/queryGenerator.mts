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

  /**
   * Ask for one broader repair when a syntactically valid query returned
   * no rows. This keeps the original generation path simple while giving
   * over-specific filters one chance to back off.
   */
  async repairEmptyResult(question: string, failedQuery: string, history: ChatMessage[] = []): Promise<GeneratedQuery> {
    const repairMsg = `The previous query returned 0 rows:
${failedQuery}

Original user question: "${question}"

Generate one broader replacement SELECT query. If the previous query used a literal filter value that was not explicitly present in the user's question or chat history, remove that filter. Do not invent new filter values. Prefer a broad count/list/grouping query over a guessed condition. Respond with ONLY the corrected SELECT query.`;

    const raw = await this.provider.chat(this.systemPrompt, history, repairMsg);
    const query = extractQuery(raw.text);
    const parsed = this.queryLanguage.parse(query);
    return { query, parsed };
  }
}

function buildSystemPrompt(model: SemanticModel): string {
  const schema = modelToSchemaPrompt(model);

  return `You are a query generator for a SimpleDBMS. Your ONLY job is to convert natural-language questions into valid queries.

DATABASE SCHEMA:
${schema}

QUERY SYNTAX (SQL-like):
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

  Each query targets EXACTLY ONE collection in its FROM clause.
  Cross-collection joins, subqueries, and UNION are not supported — never emit them.
  DELETE supports ORDER BY / LIMIT / OFFSET so users can delete a bounded sorted subset. UPDATE does not support ORDER BY, LIMIT, or OFFSET.

WHERE/HAVING conditions:
  - Comparisons: =, !=, >, >=, <, <=
  - Pattern matching: field CONTAINS 'text', LIKE 'pattern' / NOT LIKE 'pattern'
      % matches any sequence of characters, _ matches exactly one character.
      Prefer CONTAINS for natural "contains/includes" wording.
      Example: WHERE name LIKE 'A%'  (starts with A)
               WHERE city CONTAINS 'dam' (contains "dam")
  - Set membership: field IN ('a', 'b', 'c')  /  field NOT IN ('a', 'b')
  - Ranges: field BETWEEN low AND high  /  field NOT BETWEEN low AND high
  - Missing/unset field check: field IS NULL  /  field IS NOT NULL
  - Negation: NOT (<expression>)
  - Logical: AND, OR (combine multiple conditions)
  - Parentheses to override precedence: (a = 1 OR b = 2) AND c = 3
Aggregates: COUNT(*), COUNT(field), COUNT(DISTINCT field),
            SUM(field), SUM(DISTINCT field),
            AVG(field), AVG(DISTINCT field),
            MIN(field), MAX(field).
String values must be in single quotes: 'value'.
Field names are case-sensitive and must match the schema exactly.
Column aliases: \`SELECT expr AS name\` — usable in ORDER BY and HAVING too.

RULES:
1. Respond with ONLY the query. No explanation, no markdown, no code fences.
2. Use the exact field names from the schema above.
3. When the user asks about a concept, use field labels, descriptions, synonyms, and tags to find the right field.
4. For "how many", use COUNT(*). For "average"/"mean" use AVG(). For "total"/"sum" use SUM().
5. For "how many unique/distinct X" use COUNT(DISTINCT field). For "list unique X" use SELECT DISTINCT.
6. For "highest"/"most"/"maximum" use MAX() or ORDER BY ... DESC LIMIT 1.
7. For "lowest"/"least"/"minimum" use MIN() or ORDER BY ... ASC LIMIT 1.
8. For substring matches ("contains", "includes"), use CONTAINS. For starts/ends-with patterns, use LIKE.
9. For "field is one of X, Y, Z" use IN (X, Y, Z). For "between X and Y" use BETWEEN X AND Y.
   For "field is missing/empty/unset" use IS NULL.
10. Do NOT invent filter values. Only use literal values that appear in the user's question, chat history, or schema tags/descriptions as sample/distinct values.
11. If the user asks vaguely for "matching a condition", "filtered records", or a "specific condition" without naming the condition, do NOT guess one. Use a broad query such as COUNT(*) or list/group by useful fields.
12. Every query MUST target a single collection. If the user's question requires data from another collection, answer with the closest single-collection query you can and let the user know in plain language (the engine will summarize). Never emit JOIN, UNION, or subqueries.
13. This executable chat path is read-only. For data questions, emit SELECT only. You may know INSERT / UPDATE / DELETE syntax, but do not emit mutating statements for execution.
14. If the question is ambiguous, prefer the broadest simple valid query over a made-up WHERE filter.
15. Always include the relevant fields in SELECT so the answer is understandable.
16. IMPORTANT: If the user references a previous question (e.g. "break that down by city", "same but for Sales", "now filter those"), use the conversation history to understand what they mean and generate the appropriate new query.

EXAMPLES:
- "How many employees per department?"           -> SELECT department, COUNT(*) AS n FROM employees GROUP BY department
- "How many distinct departments are there?"     -> SELECT COUNT(DISTINCT department) FROM employees
- "Employees in HR, Sales or Engineering"        -> SELECT * FROM employees WHERE department IN ('HR', 'Sales', 'Engineering')
- "Employees earning between 50k and 100k"       -> SELECT * FROM employees WHERE salary BETWEEN 50000 AND 100000
- "Employees with no manager assigned"           -> SELECT * FROM employees WHERE manager_id IS NULL
- "Employees whose city contains dam"             -> SELECT * FROM employees WHERE city CONTAINS 'dam'
- "Employees in Engineering OR managers anywhere" -> SELECT id, name FROM employees WHERE department = 'Engineering' OR role = 'Manager'`;
}

function extractQuery(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:sql)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/;\s*$/, '').trim();
  return text;
}
