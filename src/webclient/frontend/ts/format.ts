export function esc(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) {
    text = '';
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else {
    text = JSON.stringify(value) ?? '';
  }
  return text.replace(/[&<>"']/g, (char) => (
    {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char] ?? char
  ));
}

export function fmtNum(value: unknown): string {
  return typeof value === 'number'
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : String(value);
}

export function fmtSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function docSize(document: unknown): number {
  return new Blob([JSON.stringify(document)]).size;
}

function imageMimeMetadataField(key: string): string {
  return `_${key}_mime`;
}

export function imageMimeFromDocument(key: string, documentValue?: Record<string, unknown> | null): string | null {
  const value = documentValue?.[imageMimeMetadataField(key)];
  return typeof value === 'string' && value.toLowerCase().startsWith('image/') ? value : null;
}

export function isImageField(key: string, documentValue?: Record<string, unknown> | null): boolean {
  return /^(image|photo|picture|cover|avatar|thumbnail|img).*\.(jpe?g|png|gif|webp)$/i.test(key)
    || /\.(jpe?g|png|gif|webp)$/i.test(key)
    || imageMimeFromDocument(key, documentValue) !== null;
}

export function imageMimeFromField(key: string, documentValue?: Record<string, unknown> | null): string | null {
  const explicit = imageMimeFromDocument(key, documentValue);
  if (explicit) return explicit;
  const lower = key.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

export function imageDataUrlFromValue(
  key: string,
  value: unknown,
  documentValue?: Record<string, unknown> | null,
): string | null {
  if (!isImageField(key, documentValue) || typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('data:image/')) return value;
  const mime = imageMimeFromField(key, documentValue);
  return mime ? `data:${mime};base64,${value}` : null;
}

export function detectType(value: unknown): 'null' | 'number' | 'boolean' | 'array' | 'object' | 'string' {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}
