// author: Frederik Caeyman
// date: 2026-02-17

import { describe, it, expect, beforeEach } from 'vitest';
import { MockFile } from '../../core/mockfile.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { QueryLanguage } from './querylanguage.mjs';

describe('QueryLanguage', () => {
  let ql: QueryLanguage;

  beforeEach(async () => {
    const dataFile = new MockFile(4096);
    const logFile = new MockFile(4096);
    const db = await SimpleDbms.create(dataFile, logFile);

    await db.insertDocument('cities', JSON.stringify({ id: 'Leuven', population: 101032, country: 'Belgium' }));
    await db.insertDocument('cities', JSON.stringify({ id: 'Ghent', population: 263700, country: 'Belgium' }));
    await db.insertDocument('cities', JSON.stringify({ id: 'Paris', population: 2148000, country: 'France' }));
    await db.insertDocument('movies', JSON.stringify({ id: 'm1', title: 'Inception', reviewed: true }));
    await db.insertDocument('movies', JSON.stringify({ id: 'm2', title: 'Tenet', reviewed: false }));

    ql = new QueryLanguage(db);
  });

  it('parses a basic select * query', () => {
    const parsed = ql.parse('SELECT * FROM cities');
    expect(parsed.kind).toBe('select');
    if (parsed.kind === 'select') {
      expect(parsed.fields).toBe('*');
      expect(parsed.collection).toBe('cities');
      expect(parsed.where).toBeUndefined();
    }
  });

  it('parses select with where and specific fields', () => {
    const parsed = ql.parse('SELECT id, population FROM cities WHERE population = 101032');
    expect(parsed.kind).toBe('select');
    if (parsed.kind === 'select') {
      expect(parsed.fields).toEqual(['id', 'population']);
      expect(parsed.collection).toBe('cities');
      expect(parsed.where).toEqual({ field: 'population', value: 101032 });
    }
  });

  it('parses insert', () => {
    const parsed = ql.parse("INSERT INTO cities VALUES {id: 'Antwerp', population: 530000}");
    expect(parsed.kind).toBe('insert');
    if (parsed.kind === 'insert') {
      expect(parsed.collection).toBe('cities');
      expect(parsed.body).toContain('Antwerp');
    }
  });

  it('executes select * with numeric where', async () => {
    const rows = await ql.execute('SELECT * FROM cities WHERE population = 101032');
    expect(rows).toEqual([{ id: 'Leuven', population: 101032, country: 'Belgium' }]);
  });

  it('executes projection without where', async () => {
    const rows = await ql.execute('SELECT id, country FROM cities');
    // Order by cursor(id) so deterministic: Ghent, Leuven, Paris
    expect(rows).toEqual([
      { id: 'Ghent', country: 'Belgium' },
      { id: 'Leuven', country: 'Belgium' },
      { id: 'Paris', country: 'France' },
    ]);
  });

  it('supports boolean values in where', async () => {
    const rows = await ql.execute('SELECT title FROM movies WHERE reviewed = true');
    expect(rows).toEqual([{ title: 'Inception' }]);
  });

  it('executes insert and can read it back', async () => {
    const insertResult = await ql.execute(
      "INSERT INTO cities VALUES {id: 'Antwerp', population: 530000, country: 'Belgium'}",
    );
    expect(insertResult).toEqual([]);

    const rows = await ql.execute("SELECT * FROM cities WHERE id = 'Antwerp'");
    expect(rows).toEqual([{ id: 'Antwerp', population: 530000, country: 'Belgium' }]);
  });

  it('throws on invalid syntax', () => {
    expect(() => ql.parse('SELECT FROM')).toThrow();
    expect(() => ql.parse('SELECT id cities')).toThrow();
    expect(() => ql.parse('SELECT id FROM cities WHERE population > 10')).toThrow();
  });
});
