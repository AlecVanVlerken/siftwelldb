import { describe, expect, it } from 'vitest';
import {
  buildDocumentTemplate,
  compactDocumentImages,
  imagePlaceholder,
  parseJsonObjectInput,
  validateDocumentInput,
} from '../document-editor.js';

describe('document-editor helpers', () => {
  it('parses only top-level JSON objects', () => {
    expect(parseJsonObjectInput('{"id":"a"}')).toEqual({ ok: true, value: { id: 'a' } });
    expect(parseJsonObjectInput('[1,2]')).toEqual({ ok: false, error: 'Top-level value must be a JSON object.' });
    expect(parseJsonObjectInput('{')).toMatchObject({ ok: false });
  });

  it('validates required and stable document ids', () => {
    expect(validateDocumentInput('{"name":"Alice"}')).toEqual({
      ok: false,
      error: 'Document must include an "id" field.',
    });
    expect(validateDocumentInput('{"id":"b"}', { existingId: 'a' })).toEqual({
      ok: false,
      error: 'The "id" field is read-only and must remain "a".',
    });
    expect(validateDocumentInput('{"id":"a","name":"Alice"}', { existingId: 'a' })).toEqual({
      ok: true,
      value: { id: 'a', name: 'Alice' },
    });
  });

  it.each(['true', 'false', 'null', '{}', '[]', '1e400'])('rejects unsupported id %s before sending it', (id) => {
    expect(validateDocumentInput(`{"id":${id}}`)).toMatchObject({ ok: false });
  });

  it('preserves the type as well as the value of an existing id', () => {
    expect(validateDocumentInput('{"id":"1"}', { existingId: 1 })).toMatchObject({ ok: false });
    expect(validateDocumentInput('{"id":1}', { existingId: '1' })).toMatchObject({ ok: false });
    expect(validateDocumentInput('{"id":0}', { existingId: 0 })).toEqual({ ok: true, value: { id: 0 } });
  });

  it.each(['null', '[]', '{}', '1e400'])('rejects field values unsupported by the storage engine: %s', (field) => {
    expect(validateDocumentInput(`{"id":"a","details":${field}}`)).toEqual({
      ok: false,
      error: 'Field "details" must be a string, a finite number, or a boolean.',
    });
  });

  it('normalizes image data URLs to raw base64 storage values', () => {
    expect(validateDocumentInput('{"id":"a","photo.jpg":"data:image/jpeg;base64,abc123"}')).toEqual({
      ok: true,
      value: { id: 'a', 'photo.jpg': 'abc123' },
    });
    expect(
      validateDocumentInput('{"id":"a","photo":"data:image/png;base64,abc123","_photo_mime":"image/png"}'),
    ).toEqual({
      ok: true,
      value: { id: 'a', photo: 'abc123', _photo_mime: 'image/png' },
    });
  });

  it('compacts image payloads to placeholders and restores them on validation', () => {
    const compacted = compactDocumentImages({ id: 'a', title: 'Rabbit', photo: 'abc123', _photo_mime: 'image/jpeg' });

    expect(compacted).toEqual({
      document: { id: 'a', title: 'Rabbit', photo: imagePlaceholder('photo', 'abc123'), _photo_mime: 'image/jpeg' },
      imagePayloads: { photo: 'abc123' },
    });
    expect(
      validateDocumentInput(JSON.stringify(compacted.document), { imagePayloads: compacted.imagePayloads }),
    ).toEqual({
      ok: true,
      value: { id: 'a', title: 'Rabbit', photo: 'abc123', _photo_mime: 'image/jpeg' },
    });
  });

  it('allows image fields to be deleted by removing the placeholder field', () => {
    const compacted = compactDocumentImages({ id: 'a', 'photo.jpg': 'abc123' });

    expect(validateDocumentInput('{"id":"a"}', { imagePayloads: compacted.imagePayloads })).toEqual({
      ok: true,
      value: { id: 'a' },
    });
  });

  it('keeps replacement image payloads instead of stale placeholders', () => {
    const compacted = compactDocumentImages({ id: 'a', 'photo.jpg': 'abc123' });
    const edited = { ...compacted.document, 'photo.jpg': 'data:image/jpeg;base64,new456' };

    expect(validateDocumentInput(JSON.stringify(edited), { imagePayloads: compacted.imagePayloads })).toEqual({
      ok: true,
      value: { id: 'a', 'photo.jpg': 'new456' },
    });
  });

  it('builds a template from existing document field types', () => {
    expect(
      buildDocumentTemplate('employees', [
        { id: 'e1', name: 'Alice', salary: 100, active: true, tags: ['x'], meta: { team: 'A' } },
      ]),
    ).toEqual({
      id: 'employees-1',
      name: '',
      salary: 0,
      active: false,
    });
  });

  it('builds an insertable template with an id absent from the loaded documents', () => {
    const template = buildDocumentTemplate('employees', [
      { id: 'employees-1', name: 'Alice' },
      { id: 'employees-2', name: 'Bob' },
      { id: 'employees-4', name: 'Carol' },
    ]);

    expect(template).toEqual({ id: 'employees-3', name: '' });
    expect(validateDocumentInput(JSON.stringify(template))).toEqual({ ok: true, value: template });
  });
});
