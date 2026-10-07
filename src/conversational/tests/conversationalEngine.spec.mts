import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RealFile } from '../../storage/file.mjs';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import type { ChatMessage, LLMProvider, LLMResponse } from '../llmProvider.mjs';
import type { SemanticModel } from '../semanticModel.mjs';
import { ConversationalEngine } from '../conversationalEngine.mjs';

class FakeLLMProvider implements LLMProvider {
  readonly chatCalls: Array<{ systemPrompt: string; history: ChatMessage[]; userMessage: string }> = [];

  constructor(private readonly responses: string[]) {}

  generate(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
    return this.chat(systemPrompt, [], userMessage);
  }

  chat(systemPrompt: string, history: ChatMessage[], userMessage: string): Promise<LLMResponse> {
    this.chatCalls.push({ systemPrompt, history, userMessage });
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
        { name: 'name', type: 'string', label: 'Name' },
        { name: 'department', type: 'string', label: 'Department' },
        { name: 'salary', type: 'number', label: 'Salary' },
      ],
    },
  ],
};

let dbCounter = 0;

async function setupDb(): Promise<SimpleDbms> {
  const id = dbCounter++;
  const dataPath = path.join(os.tmpdir(), `test_conversation_${id}.data`);
  const logPath = path.join(os.tmpdir(), `test_conversation_${id}.log`);

  if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  fs.closeSync(fs.openSync(logPath, 'w'));

  const db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath));
  await db.insertDocumentObject('employees', {
    id: 'e1',
    name: 'Alice',
    department: 'Engineering',
    salary: 120000,
  });
  await db.insertDocumentObject('employees', {
    id: 'e2',
    name: 'Bob',
    department: 'Sales',
    salary: 90000,
  });
  await db.commit();
  return db;
}

async function createEngine(
  responses: string[],
): Promise<{ engine: ConversationalEngine; provider: FakeLLMProvider; db: SimpleDbms }> {
  const db = await setupDb();
  const provider = new FakeLLMProvider(responses);
  const engine = new ConversationalEngine({ dbms: db, llmProvider: provider, semanticModel: model });
  return { engine, provider, db };
}

describe('ConversationalEngine', () => {
  it('generates, executes, and enriches a read-only SELECT response', async () => {
    const insight = JSON.stringify({
      summary: 'Alice is the highest-paid Engineering employee.',
      chart: { type: 'bar', title: 'Salary by employee', xColumn: 'name', yColumns: ['salary'] },
      interpretation: 'engineering employees ordered by salary',
      suggestions: [{ type: 'drill', text: 'Show Alice details' }],
      anomaly: 'Alice earns more than Bob.',
    });
    const { engine, provider, db } = await createEngine([
      "SELECT name, salary FROM employees WHERE department = 'Engineering'",
      insight,
    ]);

    const response = await engine.ask('Who earns the most in Engineering?');

    expect(response.error).toBeUndefined();
    expect(response.query).toBe("SELECT name, salary FROM employees WHERE department = 'Engineering'");
    expect(response.data).toEqual([{ name: 'Alice', salary: 120000 }]);
    expect(response.summary).toBe('Alice is the highest-paid Engineering employee.');
    expect(response.chart).toEqual({ type: 'bar', title: 'Salary by employee', xColumn: 'name', yColumns: ['salary'] });
    expect(response.suggestions).toEqual([{ type: 'drill', text: 'Show Alice details' }]);
    expect(response.anomaly).toBe('Alice earns more than Bob.');
    expect(provider.chatCalls).toHaveLength(2);
    await db.close();
  });

  it('rejects mutating generated queries before execution', async () => {
    const { engine, provider, db } = await createEngine(["DELETE FROM employees WHERE id = 'e1'"]);

    const response = await engine.ask('Delete Alice');

    expect(response.error).toMatch(/Only read-only queries are allowed/i);
    expect(response.query).toBe("DELETE FROM employees WHERE id = 'e1'");
    expect(provider.chatCalls).toHaveLength(1);
    await db.close();
  });

  it('answers mutation syntax questions without executing them', async () => {
    const { engine, provider, db } = await createEngine([
      "Chat cannot execute DELETE. Use SELECT id ... LIMIT 50, then DELETE FROM employees WHERE id IN ('e1').",
    ]);

    const response = await engine.ask('How do I write a delete query for 50 employees?');
    const rows = await new QueryLanguage(db).execute('SELECT id FROM employees');

    expect(response.error).toBeUndefined();
    expect(response.query).toBe('');
    expect(response.summary).toContain('DELETE FROM employees');
    expect(rows).toHaveLength(2);
    expect(provider.chatCalls).toHaveLength(1);
    expect(provider.chatCalls[0]?.systemPrompt).toContain('DELETE FROM <collection>');
    expect(provider.chatCalls[0]?.systemPrompt).toContain('DELETE supports ORDER BY / LIMIT / OFFSET');
    await db.close();
  });

  it('returns did-you-mean suggestions for empty results', async () => {
    const { engine, db } = await createEngine([
      "SELECT name FROM employees WHERE department = 'Legal'",
      "SELECT name FROM employees WHERE department = 'AlsoMissing'",
      '["Show all departments", 123, "List all employees", "Compare departments", "Ignored extra"]',
    ]);

    const response = await engine.ask('Who works in Legal?');

    expect(response.summary).toBe('No results found.');
    expect(response.didYouMean).toEqual(['Show all departments', 'List all employees', 'Compare departments']);
    await db.close();
  });

  it('repairs an over-filtered zero-result query once before falling back', async () => {
    const { engine, provider, db } = await createEngine([
      "SELECT COUNT(*) FROM employees WHERE department = 'Legal'",
      'SELECT COUNT(*) FROM employees',
      JSON.stringify({ summary: 'There are 2 employees.', chart: null }),
    ]);

    const response = await engine.ask('Count records matching a specific condition?');

    expect(response.query).toBe('SELECT COUNT(*) FROM employees');
    expect(response.data).toEqual([{ 'COUNT(*)': 2 }]);
    expect(response.summary).toBe('There are 2 employees.');
    expect(provider.chatCalls[1]?.userMessage).toContain('returned 0 rows');
    await db.close();
  });

  it('discards chart specs that reference columns absent from the result', async () => {
    const { engine, db } = await createEngine([
      'SELECT name FROM employees',
      JSON.stringify({
        summary: 'Two employees found.',
        chart: { type: 'bar', title: 'Invalid chart', xColumn: 'name', yColumns: ['salary'] },
      }),
    ]);

    const response = await engine.ask('List employees');

    expect(response.summary).toBe('Two employees found.');
    expect(response.chart).toBeNull();
    await db.close();
  });

  it('falls back to raw text when insight JSON is malformed', async () => {
    const { engine, db } = await createEngine(['SELECT name FROM employees', 'not json but still useful']);

    const response = await engine.ask('List employees');

    expect(response.summary).toBe('not json but still useful');
    expect(response.chart).toBeNull();
    await db.close();
  });
});
