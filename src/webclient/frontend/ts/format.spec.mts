import { describe, expect, it } from 'vitest';
import { detectType, esc, fmtNum, fmtSize, isImageField } from './format.js';

describe('format helpers', () => {
  it('escapes HTML-sensitive characters', () => {
    expect(esc(`<img src="x" onerror='bad'>&`)).toBe('&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt;&amp;');
  });

  it('formats numbers and byte sizes', () => {
    expect(fmtNum(1234.567)).toBe('1,234.57');
    expect(fmtSize(null)).toBe('—');
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(1536)).toBe('1.5 KB');
    expect(fmtSize(2 * 1024 * 1024)).toBe('2.00 MB');
  });

  it('detects display types', () => {
    expect(detectType(null)).toBe('null');
    expect(detectType(1)).toBe('number');
    expect(detectType(false)).toBe('boolean');
    expect(detectType([])).toBe('array');
    expect(detectType({})).toBe('object');
    expect(detectType('x')).toBe('string');
  });

  it('recognizes image-like field names', () => {
    expect(isImageField('cover.jpg')).toBe(true);
    expect(isImageField('avatar.png')).toBe(true);
    expect(isImageField('title')).toBe(false);
  });
});

