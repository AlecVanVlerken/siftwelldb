import { detectType, esc, fmtNum, imageDataUrlFromValue, isImageField } from './format.js';

export function parseSemanticResult(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { result: parsed };
  } catch {
    return { result: raw };
  }
}

export function semanticResultColumns(rows: Record<string, unknown>[], mode = 'text'): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      cols.push(key);
    }
  }
  return cols.sort((a, b) => {
    if (a === 'id') return -1;
    if (b === 'id') return 1;
    if (mode === 'image') {
      const ai = rows.some((row) => isImageField(a, row));
      const bi = rows.some((row) => isImageField(b, row));
      if (ai && !bi) return -1;
      if (!ai && bi) return 1;
    }
    return 0;
  });
}

export function semanticTypeBadge(value: unknown): string {
  const t = detectType(value);
  if (t === 'number') return 'n';
  if (t === 'boolean') return 'b';
  if (t === 'string') return 's';
  return '';
}

export function renderSemanticCell(key: string, value: unknown, row: Record<string, unknown> | null = null): string {
  if (value === null || value === undefined) return '<td class="cnu">[NULL]</td>';
  if (typeof value === 'number') return `<td class="cn">${fmtNum(value)}</td>`;
  if (typeof value === 'boolean') return `<td class="cb">${value ? 'true' : 'false'}</td>`;
  if (typeof value === 'object') return `<td class="ck">${esc(JSON.stringify(value))}</td>`;
  const imageUrl = imageDataUrlFromValue(key, value, row);
  if (imageUrl) return `<td class="ci"><img src="${esc(imageUrl)}" alt=""></td>`;
  return `<td class="cs">${esc(String(value as string))}</td>`;
}

export function hasImageField(doc: Record<string, unknown> | null | undefined): boolean {
  return !!doc && typeof doc === 'object' && Object.keys(doc).some((key) => isImageField(key, doc));
}
