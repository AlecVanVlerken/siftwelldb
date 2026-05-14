import { describe, expect, it } from 'vitest';
import { getSqlMutationKind, isMutatingSql } from './sql-ui.js';

describe('SQL UI helpers', () => {
  it.each([
    ['INSERT INTO docs VALUES {"id":"1"}', 'INSERT'],
    [' update docs set name = "x"', 'UPDATE'],
    ['\nDELETE FROM docs WHERE id = "1"', 'DELETE'],
  ] as const)('detects mutating %s statements', (sql, kind) => {
    expect(isMutatingSql(sql)).toBe(true);
    expect(getSqlMutationKind(sql)).toBe(kind);
  });

  it.each([
    'SELECT * FROM docs',
    'WITH docs AS something',
    'EXPLAIN SELECT * FROM docs',
    'xUPDATE docs SET name = "x"',
    '',
  ])('does not treat %s as mutating', (sql) => {
    expect(isMutatingSql(sql)).toBe(false);
    expect(getSqlMutationKind(sql)).toBeNull();
  });
});

