import { Document, type RawId } from '../dbms/document.mjs';
import { decodeUtf8Text, detectBinaryMetadata, toDataUrl, toHexPreview } from './binaryMetadata.mjs';
import { normalizePreviewOptions, truncatePreviewText, type DocumentPreviewOptions } from './previewConfig.mjs';
export type { DocumentPreviewOptions, NormalizedPreviewOptions } from './previewConfig.mjs';

export type PreviewMode = 'inline' | 'preview' | 'download';

type ScalarFieldPreview = {
  type: 'number' | 'boolean';
  mode: 'inline';
  value: number | boolean;
};

type StringFieldPreview = {
  type: 'string';
  mode: 'inline' | 'preview';
  byteLength: number;
  charLength?: number;
  truncated: boolean;
  value?: string;
  preview?: string;
};

type TextFieldPreview = {
  type: 'text';
  mode: 'inline' | 'preview';
  byteLength: number;
  charLength?: number;
  mimeType: string;
  truncated: boolean;
  value?: string;
  preview?: string;
};

type ImageFieldPreview = {
  type: 'image';
  mode: 'inline' | 'download';
  byteLength: number;
  mimeType: string;
  dataUrl?: string;
};

type BinaryFieldPreview = {
  type: 'binary';
  mode: 'download';
  byteLength: number;
  mimeType: string;
  hexPreview: string;
};

export type PreviewField =
  | ScalarFieldPreview
  | StringFieldPreview
  | TextFieldPreview
  | ImageFieldPreview
  | BinaryFieldPreview;

export type DocumentPreview = {
  collection: string;
  id: RawId;
  fields: Record<string, PreviewField>;
};

export function buildDocumentPreview(document: Document, options: DocumentPreviewOptions = {}): DocumentPreview {
  const normalized = normalizePreviewOptions(options);
  const fieldPreviews: Record<string, PreviewField> = {};

  for (const [fieldName, value] of Object.entries(document.getFields())) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      fieldPreviews[fieldName] = {
        type: typeof value === 'number' ? 'number' : 'boolean',
        mode: 'inline',
        value,
      };
      continue;
    }

    if (typeof value === 'string') {
      const byteLength = Buffer.byteLength(value, 'utf-8');
      if (byteLength <= normalized.maxInlineStringBytes) {
        fieldPreviews[fieldName] = {
          type: 'string',
          mode: 'inline',
          byteLength,
          charLength: value.length,
          truncated: false,
          value,
        };
      } else {
        fieldPreviews[fieldName] = {
          type: 'string',
          mode: 'preview',
          byteLength,
          charLength: value.length,
          truncated: true,
          preview: truncatePreviewText(value, normalized.stringPreviewChars),
        };
      }
      continue;
    }

    const metadata = detectBinaryMetadata(fieldName, value);

    if (metadata.category === 'image') {
      if (metadata.byteLength <= normalized.maxInlineImageBytes) {
        fieldPreviews[fieldName] = {
          type: 'image',
          mode: 'inline',
          byteLength: metadata.byteLength,
          mimeType: metadata.mimeType,
          dataUrl: toDataUrl(value, metadata.mimeType),
        };
      } else {
        fieldPreviews[fieldName] = {
          type: 'image',
          mode: 'download',
          byteLength: metadata.byteLength,
          mimeType: metadata.mimeType,
        };
      }
      continue;
    }

    if (metadata.category === 'text') {
      const decoded = decodeUtf8Text(value);
      if (decoded === null) {
        fieldPreviews[fieldName] = {
          type: 'binary',
          mode: 'download',
          byteLength: metadata.byteLength,
          mimeType: 'application/octet-stream',
          hexPreview: toHexPreview(value, normalized.hexPreviewBytes),
        };
        continue;
      }

      if (metadata.byteLength <= normalized.maxInlineTextBytes) {
        fieldPreviews[fieldName] = {
          type: 'text',
          mode: 'inline',
          byteLength: metadata.byteLength,
          charLength: decoded.length,
          mimeType: metadata.mimeType,
          truncated: false,
          value: decoded,
        };
      } else {
        fieldPreviews[fieldName] = {
          type: 'text',
          mode: 'preview',
          byteLength: metadata.byteLength,
          charLength: decoded.length,
          mimeType: metadata.mimeType,
          truncated: true,
          preview: truncatePreviewText(decoded, normalized.textPreviewChars),
        };
      }
      continue;
    }

    fieldPreviews[fieldName] = {
      type: 'binary',
      mode: 'download',
      byteLength: metadata.byteLength,
      mimeType: metadata.mimeType,
      hexPreview: toHexPreview(value, normalized.hexPreviewBytes),
    };
  }

  return {
    collection: document.getCollectionName(),
    id: document.getId(),
    fields: fieldPreviews,
  };
}
