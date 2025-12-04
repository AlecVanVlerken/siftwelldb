import { describe, expect, it } from 'vitest';
import {
  defaultIndexPredicate,
  DocumentRecord,
  parseRawDocument,
  type FieldValue,
} from './document.mjs';

describe('document.mts', () => {
  it('parses a raw document with string id and splits iterable vs non-iterable fields', () => {
    const raw = { id: 'Leuven', population: 101032, _internal: true, name: 'Leuven' };
    const parsed = parseRawDocument('cities', raw, defaultIndexPredicate);

    expect(parsed.id).toBe('Leuven');
    expect(parsed.collection).toBe('cities');
    expect(parsed.iterableEntries).toEqual([
      ['population', 101032],
      ['name', 'Leuven'],
    ]);
    expect(parsed.nonIterableEntries).toEqual([['_internal', true]]);
    expect(parsed.asDocument()).toEqual({
      id: 'Leuven',
      population: 101032,
      _internal: true,
      name: 'Leuven',
    });
  });

  it('normalizes numeric ids to strings', () => {
    const raw = { id: 42, foo: 'bar' };
    const parsed = parseRawDocument('numbers', raw, defaultIndexPredicate);
    expect(parsed.id).toBe('42');
    expect(parsed.asDocument().id).toBe('42');
  });

  it('rejects missing or empty ids', () => {
    expect(() => parseRawDocument('c', { foo: 1 } as unknown, defaultIndexPredicate)).toThrow();
    expect(() => parseRawDocument('c', { id: '', foo: 1 } as unknown, defaultIndexPredicate)).toThrow();
  });

  it('rejects unsupported value types', () => {
    const bad: Record<string, FieldValue | Record<string, unknown>> = {
      id: 'bad',
      ok: true,
      nested: { nope: true },
    };
    expect(() => parseRawDocument('c', bad, defaultIndexPredicate)).toThrow(/Unsupported value type/);
  });

  it('wraps parsing via DocumentRecord helpers', () => {
    const doc = new DocumentRecord('u', { id: 'x', a: 1, _b: false }, defaultIndexPredicate);
    expect(doc.getId()).toBe('x');
    expect(doc.getIterableKeys()).toEqual(['a']);
    expect(doc.getNonIterableKeys()).toEqual(['_b']);
    expect(doc.getFields()).toEqual({ a: 1, _b: false });
    expect(doc.asDocument()).toEqual({ id: 'x', a: 1, _b: false });
  });
});
