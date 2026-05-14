export type SqlMutationKind = 'INSERT' | 'UPDATE' | 'DELETE';

const MUTATING_SQL_RE = /^\s*(insert|update|delete)\b/i;

export function getSqlMutationKind(sql: string): SqlMutationKind | null {
  const match = sql.match(MUTATING_SQL_RE);
  if (!match) return null;
  return match[1].toUpperCase() as SqlMutationKind;
}

export function isMutatingSql(sql: string): boolean {
  return getSqlMutationKind(sql) !== null;
}
