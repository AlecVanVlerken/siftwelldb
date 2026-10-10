import { readQuotedString } from '../database/string-literal.mjs';

export type Token = {
  kind: 'identifier' | 'string' | 'number' | 'symbol' | 'eof';
  value: string;
  start: number;
  end: number;
};

export class QuerySyntaxError extends Error {
  constructor(message: string, source: string, offset: number) {
    const lines = source.slice(0, offset).split('\n');
    super(`${message} (line ${lines.length}, column ${lines.at(-1)!.length + 1})`);
    this.name = 'QuerySyntaxError';
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length; ) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    const start = i;
    let kind: Token['kind'];
    let value: string;
    if (source[i] === "'" || source[i] === '"') {
      try {
        const quoted = readQuotedString(source, i);
        kind = 'string';
        value = quoted.value;
        i = quoted.end;
      } catch (error) {
        throw new QuerySyntaxError((error as Error).message, source, start);
      }
    } else {
      const number = source.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      const identifier = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (number) {
        kind = 'number';
        value = number[0];
        i += value.length;
      } else if (identifier) {
        kind = 'identifier';
        value = identifier[0];
        i += value.length;
      } else {
        const op = source.slice(i).match(/^(?:>=|<=|!=|[=<>(),*{}:;])/);
        if (!op) throw new QuerySyntaxError(`Unsupported value or character "${source[i]}"`, source, i);
        kind = 'symbol';
        value = op[0];
        i += value.length;
      }
    }
    tokens.push({ kind, value, start, end: i });
  }
  tokens.push({ kind: 'eof', value: '', start: source.length, end: source.length });
  return tokens;
}
