import { describe, expect, it } from 'vitest';
import type { LLMProvider, LLMResponse, ChatMessage } from '../llmProvider.mjs';
import type { SemanticModel } from '../semanticModel.mjs';
import { QueryGenerator } from '../queryGenerator.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import type { SimpleDbms } from '../../database/simpledbms.mjs';

class FakeLLMProvider implements LLMProvider {
  readonly calls: Array<{ systemPrompt: string; history: ChatMessage[]; userMessage: string }> = [];

  constructor(private readonly responses: string[]) {}

  generate(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
    return this.chat(systemPrompt, [], userMessage);
  }

  chat(systemPrompt: string, history: ChatMessage[], userMessage: string): Promise<LLMResponse> {
    this.calls.push({ systemPrompt, history, userMessage });
    const text = this.responses.shift();
    if (text === undefined) throw new Error('No fake LLM response queued');
    return Promise.resolve({ text });
  }
}

const model: SemanticModel = {
  explores: [
    {
      collection: 'employees',
      label: 'Employees',
      fields: [
        { name: 'id', type: 'string', label: 'ID' },
        { name: 'name', type: 'string', label: 'Name', synonyms: ['employee'] },
        { name: 'salary', type: 'number', label: 'Salary' },
      ],
    },
  ],
};

function createGenerator(provider: FakeLLMProvider): QueryGenerator {
  const queryLanguage = new QueryLanguage({} as SimpleDbms);
  return new QueryGenerator(provider, model, queryLanguage);
}

describe('QueryGenerator', () => {
  it('extracts a plain generated query and validates it with the parser', async () => {
    const provider = new FakeLLMProvider(['SELECT name FROM employees']);
    const generator = createGenerator(provider);

    const generated = await generator.generate('list employee names');

    expect(generated.query).toBe('SELECT name FROM employees');
    expect(generated.parsed.kind).toBe('select');
    expect(provider.calls[0]?.systemPrompt).toContain('Collection "employees"');
    expect(provider.calls[0]?.systemPrompt).toContain('Do NOT invent filter values');
    expect(provider.calls[0]?.systemPrompt).toContain('use field labels, descriptions, synonyms, and tags');
    expect(provider.calls[0]?.systemPrompt).toContain('DELETE FROM <collection>');
    expect(provider.calls[0]?.systemPrompt).toContain('DELETE supports ORDER BY / LIMIT / OFFSET');
  });

  it('strips SQL fences and a trailing semicolon', async () => {
    const provider = new FakeLLMProvider(['```sql\nSELECT name FROM employees;\n```']);
    const generator = createGenerator(provider);

    await expect(generator.generate('list employee names')).resolves.toMatchObject({
      query: 'SELECT name FROM employees',
    });
  });

  it('asks the LLM for one repair when the first query is invalid', async () => {
    const provider = new FakeLLMProvider(['SELECT FROM employees', 'SELECT name FROM employees']);
    const generator = createGenerator(provider);

    const generated = await generator.generate('list employee names');

    expect(generated.query).toBe('SELECT name FROM employees');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.userMessage).toContain('The query you generated was invalid');
  });

  it('throws when the repaired query is still invalid', async () => {
    const provider = new FakeLLMProvider(['SELECT FROM employees', 'still not sql']);
    const generator = createGenerator(provider);

    await expect(generator.generate('list employee names')).rejects.toThrow(/Invalid query syntax/i);
  });

  it('can request a broader query after an empty filtered result', async () => {
    const provider = new FakeLLMProvider(['SELECT COUNT(*) FROM employees']);
    const generator = createGenerator(provider);

    const repaired = await generator.repairEmptyResult(
      'Count records matching a specific condition?',
      "SELECT COUNT(*) FROM employees WHERE city = 'New York'",
    );

    expect(repaired.query).toBe('SELECT COUNT(*) FROM employees');
    expect(provider.calls[0]?.userMessage).toContain('returned 0 rows');
    expect(provider.calls[0]?.userMessage).toContain('Do not invent new filter values');
  });
});
