import { describe, expect, it } from 'vitest';
import { JSONtoDocument, defaultIndexPredicate, parseRawDocument, type FieldValue } from './document.mjs';

describe('document.mts', () => {
  it('parses a document string and splits iterable vs non-iterable fields', () => {
    const input = "{id: 'Leuven', population: 101032, _internal: true, name: 'Leuven'}";
    const doc = JSONtoDocument(input, 'cities');

    expect(doc.getId()).toBe('Leuven');
    expect(doc.getIterableKeys()).toEqual(['population', 'name']);
    expect(doc.getNonIterableKeys()).toEqual(['_internal']);
    expect(doc.getFields()).toEqual({ population: 101032, _internal: true, name: 'Leuven' });
    expect(doc.asDocument()).toEqual({
      id: 'Leuven',
      population: 101032,
      _internal: true,
      name: 'Leuven',
    });
  });

  it('retains numeric ids without normalization', () => {
    const input = "{id: 42, foo: 'bar'}";
    const doc = JSONtoDocument(input, 'numbers');
    expect(doc.getId()).toBe(42);
    expect(doc.asDocument().id).toBe(42);
  });

  it('rejects missing or invalid ids', () => {
    expect(() => JSONtoDocument('{foo: 1}', 'c')).toThrow();
    expect(() => JSONtoDocument('{id: {}, foo: 1}', 'c')).toThrow();
  });

  it('rejects unsupported value types', () => {
    const bad: Record<string, FieldValue | Record<string, unknown>> = {
      id: 'bad',
      ok: true,
      nested: { nope: true },
    };
    const str = `{id: 'bad', ok: true, nested: { nope: true }}`;
    expect(() => JSONtoDocument(str, 'c')).toThrow();
  });

  it('parses raw object input via parseRawDocument', () => {
    const raw = { id: 'X', a: 1, _b: false };
    const doc = parseRawDocument('coll', raw, defaultIndexPredicate);
    expect(doc.getId()).toBe('X');
    expect(doc.getIterableKeys()).toEqual(['a']);
    expect(doc.getNonIterableKeys()).toEqual(['_b']);
    expect(doc.getFields()).toEqual({ a: 1, _b: false });
  });
});
