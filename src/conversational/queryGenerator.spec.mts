import { describe, expect, it } from 'vitest';
import type { LLMProvider, LLMResponse, ChatMessage } from './llmProvider.mjs';
import type { SemanticModel } from './semanticModel.mjs';
import { QueryGenerator } from './queryGenerator.mjs';
import { QueryLanguage } from '../dbms/querylanguage/querylanguage.mjs';
import type { SimpleDbms } from '../dbms/simpledbms.mjs';

class FakeLLMProvider implements LLMProvider {
  readonly calls: Array<{ systemPrompt: string; history: ChatMessage[]; userMessage: string }> = [];

  constructor(private readonly responses: string[]) {}

  async generate(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
    return this.chat(systemPrompt, [], userMessage);
  }

  async chat(systemPrompt: string, history: ChatMessage[], userMessage: string): Promise<LLMResponse> {
    this.calls.push({ systemPrompt, history, userMessage });
    const text = this.responses.shift();
    if (text === undefined) throw new Error('No fake LLM response queued');
    return { text };
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
});
