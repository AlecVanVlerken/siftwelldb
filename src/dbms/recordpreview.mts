import { StringDecoder } from 'node:string_decoder';
import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { decodeUtf8Text, detectBinaryMetadata, toDataUrl, toHexPreview } from '../preview/binaryMetadata.mjs';
import {
  normalizePreviewOptions,
  type DocumentPreviewOptions,
  type NormalizedPreviewOptions,
} from '../preview/previewConfig.mjs';
import type { DocumentPreview, PreviewField } from '../preview/documentPreview.mjs';
import type { RawId } from './document.mjs';

const ASCII_BACKSLASH = '\\'.charCodeAt(0);
const ASCII_CLOSE_BRACE = '}'.charCodeAt(0);
const ASCII_CLOSE_BRACKET = ']'.charCodeAt(0);
const ASCII_COLON = ':'.charCodeAt(0);
const ASCII_COMMA = ','.charCodeAt(0);
const ASCII_FALSE = 'f'.charCodeAt(0);
const ASCII_MINUS = '-'.charCodeAt(0);
const ASCII_OPEN_BRACE = '{'.charCodeAt(0);
const ASCII_OPEN_BRACKET = '['.charCodeAt(0);
const ASCII_QUOTE = '"'.charCodeAt(0);
const ASCII_TRUE = 't'.charCodeAt(0);

const RAW_STRING_CHUNK_BYTES = 512;
const BINARY_SAMPLE_BYTES = 1024;

export async function readLegacyDocumentPreview(
  freeBlockFile: FreeBlockFile,
  blockID: number,
  dataOffset: number,
  options: DocumentPreviewOptions = {},
): Promise<DocumentPreview> {
  const stream = new RecordByteStream(freeBlockFile, blockID, dataOffset);
  const jsonLength = (await stream.readExact(4)).readUInt32BE(0);
  const reader = new LegacyJsonReader(stream, jsonLength);
  const normalized = normalizePreviewOptions(options);

  await reader.expectByte(ASCII_OPEN_BRACE);
  await reader.expectProperty('collection');
  const collection = await reader.readSmallString();
  await reader.expectByte(ASCII_COMMA);
  await reader.expectProperty('id');
  const id = await readRawId(reader);
  await reader.expectByte(ASCII_COMMA);
  await reader.expectProperty('iterableEntries');

  const fields: Record<string, PreviewField> = {};
  await readFieldEntries(reader, fields, normalized);
  await reader.expectByte(ASCII_COMMA);
  await reader.expectProperty('nonIterableEntries');
  await readFieldEntries(reader, fields, normalized);
  await reader.expectByte(ASCII_CLOSE_BRACE);
  await reader.assertFullyConsumed();

  return { collection, id, fields };
}

async function readRawId(reader: LegacyJsonReader): Promise<RawId> {
  const next = await reader.peekNonWhitespaceByte();
  if (next === ASCII_QUOTE) {
    return await reader.readSmallString();
  }
  return await reader.readNumber();
}

async function readFieldEntries(
  reader: LegacyJsonReader,
  fields: Record<string, PreviewField>,
  options: NormalizedPreviewOptions,
): Promise<void> {
  await reader.expectByte(ASCII_OPEN_BRACKET);
  if (await reader.tryReadByte(ASCII_CLOSE_BRACKET)) {
    return;
  }

  while (true) {
    await reader.expectByte(ASCII_OPEN_BRACKET);
    const fieldName = await reader.readSmallString();
    await reader.expectByte(ASCII_COMMA);
    fields[fieldName] = await readFieldPreview(reader, fieldName, options);
    await reader.expectByte(ASCII_CLOSE_BRACKET);

    if (await reader.tryReadByte(ASCII_COMMA)) {
      continue;
    }
    await reader.expectByte(ASCII_CLOSE_BRACKET);
    return;
  }
}

async function readFieldPreview(
  reader: LegacyJsonReader,
  fieldName: string,
  options: NormalizedPreviewOptions,
): Promise<PreviewField> {
  const next = await reader.peekNonWhitespaceByte();
  if (next === ASCII_QUOTE) {
    return await readStringFieldPreview(reader, options);
  }
  if (next === ASCII_OPEN_BRACE) {
    return await readBinaryFieldPreview(reader, fieldName, options);
  }
  if (next === ASCII_TRUE || next === ASCII_FALSE) {
    return { type: 'boolean', mode: 'inline', value: await reader.readBoolean() };
  }
  if (next === ASCII_MINUS || isDigit(next)) {
    return { type: 'number', mode: 'inline', value: await reader.readNumber() };
  }
  throw new Error(`Unsupported field value token: ${String.fromCharCode(next)}`);
}

async function readStringFieldPreview(
  reader: LegacyJsonReader,
  options: NormalizedPreviewOptions,
): Promise<PreviewField> {
  let byteLength = 0;
  let charLength = 0;
  let inlineValue: string | undefined = '';
  let previewPrefix = '';

  await reader.readStringChunks((chunk) => {
    byteLength += Buffer.byteLength(chunk, 'utf-8');
    charLength += chunk.length;

    if (inlineValue !== undefined) {
      inlineValue += chunk;
      if (byteLength > options.maxInlineStringBytes) {
        inlineValue = undefined;
      }
    }

    if (previewPrefix.length < options.stringPreviewChars) {
      previewPrefix += chunk;
      if (previewPrefix.length > options.stringPreviewChars) {
        previewPrefix = previewPrefix.slice(0, options.stringPreviewChars);
      }
    }
  });

  if (inlineValue !== undefined) {
    return {
      type: 'string',
      mode: 'inline',
      byteLength,
      charLength,
      truncated: false,
      value: inlineValue,
    };
  }

  return {
    type: 'string',
    mode: 'preview',
    byteLength,
    charLength,
    truncated: true,
    preview: charLength <= options.stringPreviewChars ? previewPrefix : `${previewPrefix}...`,
  };
}

async function readBinaryFieldPreview(
  reader: LegacyJsonReader,
  fieldName: string,
  options: NormalizedPreviewOptions,
): Promise<PreviewField> {
  await reader.expectByte(ASCII_OPEN_BRACE);
  await reader.expectProperty('__bin');
  const maxInlineBytes = Math.max(options.maxInlineImageBytes, options.maxInlineTextBytes);
  const sampleEncodedChars = Math.ceil(Math.max(BINARY_SAMPLE_BYTES, options.hexPreviewBytes) / 3) * 4;
  const maxInlineEncodedChars = Math.ceil(maxInlineBytes / 3) * 4;
  const binaryValue = await reader.readBase64Value(sampleEncodedChars, maxInlineEncodedChars);
  await reader.expectByte(ASCII_CLOSE_BRACE);

  const detected = detectBinaryMetadata(fieldName, binaryValue.sample, { sampleBytes: binaryValue.sample.length });

  if (detected.category === 'image') {
    if (binaryValue.fullData && binaryValue.byteLength <= options.maxInlineImageBytes) {
      return {
        type: 'image',
        mode: 'inline',
        byteLength: binaryValue.byteLength,
        mimeType: detected.mimeType,
        dataUrl: toDataUrl(binaryValue.fullData, detected.mimeType),
      };
    }

    return {
      type: 'image',
      mode: 'download',
      byteLength: binaryValue.byteLength,
      mimeType: detected.mimeType,
    };
  }

  if (detected.category === 'text') {
    if (binaryValue.fullData && binaryValue.byteLength <= options.maxInlineTextBytes) {
      const decoded = decodeUtf8Text(binaryValue.fullData);
      if (decoded !== null) {
        return {
          type: 'text',
          mode: 'inline',
          byteLength: binaryValue.byteLength,
          charLength: decoded.length,
          mimeType: detected.mimeType,
          truncated: false,
          value: decoded,
        };
      }
    }

    return {
      type: 'text',
      mode: 'preview',
      byteLength: binaryValue.byteLength,
      mimeType: detected.mimeType,
      truncated: true,
      preview: previewTextSample(binaryValue.sample, options.textPreviewChars),
    };
  }

  return {
    type: 'binary',
    mode: 'download',
    byteLength: binaryValue.byteLength,
    mimeType: detected.mimeType,
    hexPreview: toHexPreview(binaryValue.sample, options.hexPreviewBytes),
  };
}

function previewTextSample(data: Buffer, maxChars: number): string {
  const decoded = new TextDecoder('utf-8').decode(data);
  return decoded.length <= maxChars ? decoded : `${decoded.slice(0, maxChars)}...`;
}

function isDigit(value: number): boolean {
  return value >= '0'.charCodeAt(0) && value <= '9'.charCodeAt(0);
}

function isWhitespace(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
}

type Base64Value = {
  byteLength: number;
  sample: Buffer;
  fullData?: Buffer;
};

class LegacyJsonReader {
  private lookahead: number | null = null;
  private remainingBytes: number;

  constructor(
    private readonly stream: RecordByteStream,
    jsonLength: number,
  ) {
    this.remainingBytes = jsonLength;
  }

  async expectProperty(name: string): Promise<void> {
    const actual = await this.readSmallString();
    if (actual !== name) {
      throw new Error(`Unexpected property "${actual}", expected "${name}"`);
    }
    await this.expectByte(ASCII_COLON);
  }

  async expectByte(expected: number): Promise<void> {
    const actual = await this.readNonWhitespaceByte();
    if (actual !== expected) {
      throw new Error(`Unexpected token "${String.fromCharCode(actual)}"`);
    }
  }

  async tryReadByte(expected: number): Promise<boolean> {
    const actual = await this.peekNonWhitespaceByte();
    if (actual !== expected) {
      return false;
    }
    await this.readByte();
    return true;
  }

  async peekNonWhitespaceByte(): Promise<number> {
    let value = await this.peekByte();
    while (isWhitespace(value)) {
      await this.readByte();
      value = await this.peekByte();
    }
    return value;
  }

  async readSmallString(): Promise<string> {
    let value = '';
    await this.readStringChunks((chunk) => {
      value += chunk;
    });
    return value;
  }

  async readBoolean(): Promise<boolean> {
    const next = await this.peekNonWhitespaceByte();
    if (next === ASCII_TRUE) {
      await this.readLiteral('true');
      return true;
    }
    await this.readLiteral('false');
    return false;
  }

  async readNumber(): Promise<number> {
    await this.peekNonWhitespaceByte();

    let literal = '';
    while (true) {
      const value = await this.peekByte();
      if (
        isWhitespace(value) ||
        value === ASCII_COMMA ||
        value === ASCII_CLOSE_BRACKET ||
        value === ASCII_CLOSE_BRACE
      ) {
        break;
      }
      literal += String.fromCharCode(await this.readByte());
    }

    return Number(literal);
  }

  async readStringChunks(onChunk: (chunk: string) => void): Promise<void> {
    const quote = await this.readNonWhitespaceByte();
    if (quote !== ASCII_QUOTE) {
      throw new Error('Expected string');
    }

    const decoder = new StringDecoder('utf8');
    let rawBytes: number[] = [];
    const flushRaw = () => {
      if (rawBytes.length === 0) return;
      const decoded = decoder.write(Buffer.from(rawBytes));
      if (decoded.length > 0) {
        onChunk(decoded);
      }
      rawBytes = [];
    };

    while (true) {
      const value = await this.readByte();
      if (value === ASCII_QUOTE) {
        flushRaw();
        const remainder = decoder.end();
        if (remainder.length > 0) {
          onChunk(remainder);
        }
        return;
      }
      if (value === ASCII_BACKSLASH) {
        flushRaw();
        onChunk(await this.readEscapeSequence());
        continue;
      }

      rawBytes.push(value);
      if (rawBytes.length >= RAW_STRING_CHUNK_BYTES) {
        flushRaw();
      }
    }
  }

  async readBase64Value(sampleEncodedChars: number, maxInlineEncodedChars: number): Promise<Base64Value> {
    const quote = await this.readNonWhitespaceByte();
    if (quote !== ASCII_QUOTE) {
      throw new Error('Expected base64 string');
    }

    let encodedLength = 0;
    let sampleBase64 = '';
    let fullBase64: string | undefined = '';
    let tail = '';

    while (true) {
      const value = await this.readByte();
      if (value === ASCII_QUOTE) {
        const fullData = fullBase64 === undefined ? undefined : Buffer.from(fullBase64, 'base64');
        return {
          byteLength: fullData?.length ?? calculateBase64ByteLength(encodedLength, tail),
          sample: sampleBase64.length === 0 ? Buffer.alloc(0) : Buffer.from(sampleBase64, 'base64'),
          fullData,
        };
      }

      const char = String.fromCharCode(value);
      encodedLength++;
      tail = `${tail}${char}`.slice(-4);

      if (sampleBase64.length < sampleEncodedChars) {
        sampleBase64 += char;
      }
      if (fullBase64 !== undefined) {
        fullBase64 += char;
        if (encodedLength > maxInlineEncodedChars) {
          fullBase64 = undefined;
        }
      }
    }
  }

  private async readEscapeSequence(): Promise<string> {
    const escapeType = await this.readByte();
    switch (escapeType) {
      case '"'.charCodeAt(0):
        return '"';
      case '\\'.charCodeAt(0):
        return '\\';
      case '/'.charCodeAt(0):
        return '/';
      case 'b'.charCodeAt(0):
        return '\b';
      case 'f'.charCodeAt(0):
        return '\f';
      case 'n'.charCodeAt(0):
        return '\n';
      case 'r'.charCodeAt(0):
        return '\r';
      case 't'.charCodeAt(0):
        return '\t';
      case 'u'.charCodeAt(0):
        return String.fromCharCode(await this.readHexCodeUnit());
      default:
        throw new Error(`Unsupported escape sequence "\\${String.fromCharCode(escapeType)}"`);
    }
  }

  private async readHexCodeUnit(): Promise<number> {
    let hex = '';
    for (let i = 0; i < 4; i++) {
      hex += String.fromCharCode(await this.readByte());
    }
    return Number.parseInt(hex, 16);
  }

  private async readLiteral(literal: string): Promise<void> {
    for (const character of literal) {
      const actual = await this.readByte();
      if (actual !== character.charCodeAt(0)) {
        throw new Error(`Unexpected token while reading "${literal}"`);
      }
    }
  }

  private async readNonWhitespaceByte(): Promise<number> {
    let value = await this.readByte();
    while (isWhitespace(value)) {
      value = await this.readByte();
    }
    return value;
  }

  private async peekByte(): Promise<number> {
    if (this.lookahead === null) {
      this.lookahead = await this.readFromStream();
    }
    return this.lookahead;
  }

  private async readByte(): Promise<number> {
    if (this.lookahead !== null) {
      const value = this.lookahead;
      this.lookahead = null;
      return value;
    }
    return await this.readFromStream();
  }

  private async readFromStream(): Promise<number> {
    if (this.remainingBytes <= 0) {
      throw new Error('Unexpected end of JSON payload');
    }
    const value = (await this.stream.readExact(1)).readUInt8(0);
    this.remainingBytes--;
    return value;
  }

  async assertFullyConsumed(): Promise<void> {
    while (this.remainingBytes > 0) {
      const value = await this.readByte();
      if (!isWhitespace(value)) {
        throw new Error('Unexpected trailing data in JSON payload');
      }
    }
  }
}

class RecordByteStream {
  private currentBlockID: number;
  private currentChunk: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private currentOffset = 0;

  constructor(
    private readonly freeBlockFile: FreeBlockFile,
    startBlockID: number,
    private readonly dataOffset: number,
  ) {
    this.currentBlockID = startBlockID;
  }

  async readExact(byteLength: number): Promise<Buffer> {
    if (byteLength === 0) {
      return Buffer.alloc(0);
    }

    const result = Buffer.alloc(byteLength);
    let written = 0;
    while (written < byteLength) {
      await this.ensureChunk();
      const readable = Math.min(byteLength - written, this.currentChunk.length - this.currentOffset);
      this.currentChunk.copy(result, written, this.currentOffset, this.currentOffset + readable);
      this.currentOffset += readable;
      written += readable;
    }
    return result;
  }

  private async ensureChunk(): Promise<void> {
    while (this.currentOffset >= this.currentChunk.length) {
      if (this.currentBlockID === 0) {
        throw new Error('Unexpected end of record chain');
      }

      const blockData = await this.freeBlockFile.readBlock(this.currentBlockID);
      this.currentBlockID = blockData.readUInt32LE(1);
      this.currentChunk = blockData.subarray(this.dataOffset);
      this.currentOffset = 0;
    }
  }
}

function calculateBase64ByteLength(encodedLength: number, tail: string): number {
  let padding = 0;
  if (tail.endsWith('==')) {
    padding = 2;
  } else if (tail.endsWith('=')) {
    padding = 1;
  }
  return Math.floor(encodedLength / 4) * 3 - padding;
}
