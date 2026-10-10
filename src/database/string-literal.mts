/** Read a quoted value without interpreting syntax inside its contents. */
export function readQuotedString(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === quote) {
      if (source[i + 1] === quote) {
        value += quote;
        i++;
      } else return { value, end: i + 1 };
    } else if (ch === '\\') {
      const next = source[++i];
      if (next === undefined) break;
      const escapes: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        '\\': '\\',
        '/': '/',
        "'": "'",
        '"': '"',
      };
      if (next === 'u') {
        const hex = source.slice(i + 1, i + 5);
        if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('Invalid Unicode string escape');
        value += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else value += escapes[next] ?? `\\${next}`;
    } else value += ch;
  }
  throw new Error('Unterminated string literal');
}
