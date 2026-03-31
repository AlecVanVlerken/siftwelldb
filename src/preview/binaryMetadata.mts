import { isImageField } from '../dbms/document.mjs';

export type BinaryCategory = 'image' | 'text' | 'binary';

export type BinaryMetadata = {
  category: BinaryCategory;
  byteLength: number;
  mimeType: string;
  extension?: string;
  encoding?: 'utf-8';
};

export type BinaryMetadataOptions = {
  sampleBytes?: number;
  maxControlCharRatio?: number;
};

const DEFAULT_SAMPLE_BYTES = 4096;
const DEFAULT_MAX_CONTROL_CHAR_RATIO = 0.02;

const EXTENSION_TO_MIME: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
};

function getExtension(fieldName: string): string | undefined {
  const lastDot = fieldName.lastIndexOf('.');
  return lastDot === -1 ? undefined : fieldName.slice(lastDot).toLowerCase();
}

function detectMimeFromMagic(data: Buffer): string | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (data.length >= 5 && data.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  return undefined;
}

export function decodeUtf8Text(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function looksLikeUtf8Text(data: Buffer, options: BinaryMetadataOptions = {}): boolean {
  const sampleBytes = options.sampleBytes ?? DEFAULT_SAMPLE_BYTES;
  const sample = data.subarray(0, Math.min(data.length, sampleBytes));
  const decoded = decodeUtf8Text(sample);
  if (decoded === null) return false;
  if (decoded.length === 0) return true;

  let controlCharacters = 0;
  for (const char of decoded) {
    const codePoint = char.codePointAt(0)!;
    if ((codePoint < 32 && char !== '\n' && char !== '\r' && char !== '\t') || codePoint === 0xfffd) {
      controlCharacters++;
    }
  }

  return controlCharacters / decoded.length <= (options.maxControlCharRatio ?? DEFAULT_MAX_CONTROL_CHAR_RATIO);
}

export function detectBinaryMetadata(fieldName: string, data: Buffer, options: BinaryMetadataOptions = {}): BinaryMetadata {
  const extension = getExtension(fieldName);
  const mimeFromMagic = detectMimeFromMagic(data);
  const mimeFromExtension = extension ? EXTENSION_TO_MIME[extension] : undefined;

  if (isImageField(fieldName) || mimeFromMagic?.startsWith('image/') || mimeFromExtension?.startsWith('image/')) {
    return {
      category: 'image',
      byteLength: data.length,
      mimeType: mimeFromMagic ?? mimeFromExtension ?? 'application/octet-stream',
      extension,
    };
  }

  if (
    mimeFromExtension?.startsWith('text/') ||
    mimeFromExtension === 'application/json' ||
    mimeFromExtension === 'application/xml' ||
    looksLikeUtf8Text(data, options)
  ) {
    return {
      category: 'text',
      byteLength: data.length,
      mimeType: mimeFromExtension ?? 'text/plain',
      extension,
      encoding: 'utf-8',
    };
  }

  return {
    category: 'binary',
    byteLength: data.length,
    mimeType: mimeFromMagic ?? mimeFromExtension ?? 'application/octet-stream',
    extension,
  };
}

export function toDataUrl(data: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

export function toHexPreview(data: Buffer, maxBytes = 16): string {
  return Array.from(data.subarray(0, Math.max(0, maxBytes)), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}
