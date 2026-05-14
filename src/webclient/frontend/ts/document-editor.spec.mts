import { describe, expect, it } from 'vitest';
import { buildDocumentTemplate, parseJsonObjectInput, validateDocumentInput } from './document-editor.js';

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

  it('builds a template from existing document field types', () => {
    expect(buildDocumentTemplate('employees', [
      { id: 'e1', name: 'Alice', salary: 100, active: true, tags: ['x'], meta: { team: 'A' } },
    ])).toEqual({
      id: 'employees-1',
      name: '',
      salary: 0,
      active: false,
      tags: [],
      meta: {},
    });
  });
});
