// author: Frederik Caeyman
// date: 2025-12-08

import { describe, expect, it } from 'vitest';
import { CompressionRegistry } from './compression.mjs';

describe('CompressionRegistry', () => {
  it('detects gzip magic prefix', () => {
    const registry = new CompressionRegistry();
    const gzip = registry.get('gzip').compress(Buffer.from('hello world', 'utf-8'));
    const detected = registry.detect(gzip);
    expect(detected?.id).toBe('gzip');
  });

  it('detects deflate prefix', () => {
    const registry = new CompressionRegistry();
    const compressed = registry.get('deflate').compress(Buffer.from('hello world', 'utf-8'));
    const detected = registry.detect(compressed);
    expect(detected?.id).toBe('deflate');
  });
});
