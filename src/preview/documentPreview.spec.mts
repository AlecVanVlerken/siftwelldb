import { describe, expect, it } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { parseRawDocument } from '../dbms/document.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { buildDocumentPreview } from './documentPreview.mjs';

describe('buildDocumentPreview', () => {
  it('truncates large string fields into previews', () => {
    const document = parseRawDocument('articles', {
      id: 'doc-1',
      body: 'x'.repeat(2000),
    });

    const preview = buildDocumentPreview(document, {
      maxInlineStringBytes: 128,
      stringPreviewChars: 32,
    });

    expect(preview.fields['body']).toEqual({
      type: 'string',
      mode: 'preview',
      byteLength: 2000,
      charLength: 2000,
      truncated: true,
      preview: `${'x'.repeat(32)}...`,
    });
  });

  it('inlines small image fields as data urls', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const document = parseRawDocument('photos', {
      id: 'img-1',
      'photo.png': pngBytes.toString('base64'),
    });

    const preview = buildDocumentPreview(document, { maxInlineImageBytes: 128 });
    const imageField = preview.fields['photo.png'];

    expect(imageField.type).toBe('image');
    expect(imageField.mode).toBe('inline');
    if (imageField.type === 'image' && imageField.mode === 'inline') {
      expect(imageField.byteLength).toBe(pngBytes.length);
      expect(imageField.dataUrl).toBe(`data:image/png;base64,${pngBytes.toString('base64')}`);
    }
  });

  it('marks opaque binary payloads as download-only', () => {
    const document = parseRawDocument('files', {
      id: 'bin-1',
      archive: Buffer.from([0x00, 0xff, 0x10, 0xaa, 0xbb, 0xcc]),
    });

    const preview = buildDocumentPreview(document, { hexPreviewBytes: 4 });

    expect(preview.fields['archive']).toEqual({
      type: 'binary',
      mode: 'download',
      byteLength: 6,
      mimeType: 'application/octet-stream',
      hexPreview: '00 ff 10 aa',
    });
  });
});

describe('SimpleDbms.getDocumentPreviewById', () => {
  it('returns a preview without changing record reconstruction', async () => {
    const dataFile = new MockFile(256);
    const logFile = new MockFile(4096);
    const simpleDbms = await SimpleDbms.create(dataFile, logFile);

    await simpleDbms.insertDocument(
      'articles',
      JSON.stringify({
        id: 'preview-doc',
        title: 'Medium sized document',
        _body: 'z'.repeat(10000),
      }),
    );
    await simpleDbms.commit();

    const previewJson = await simpleDbms.getDocumentPreviewById('articles', 'preview-doc', {
      maxInlineStringBytes: 256,
      stringPreviewChars: 40,
    });

    expect(JSON.parse(previewJson)).toEqual({
      collection: 'articles',
      id: 'preview-doc',
      fields: {
        title: {
          type: 'string',
          mode: 'inline',
          byteLength: 21,
          charLength: 21,
          truncated: false,
          value: 'Medium sized document',
        },
        _body: {
          type: 'string',
          mode: 'preview',
          byteLength: 10000,
          charLength: 10000,
          truncated: true,
          preview: `${'z'.repeat(40)}...`,
        },
      },
    });

    await simpleDbms.close();
  });
});
