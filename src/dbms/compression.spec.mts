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

  it('round-trips brotli payloads', () => {
    const registry = new CompressionRegistry();
    const payload = Buffer.from('hello brotli '.repeat(20), 'utf-8');
    const compressed = registry.get('brotli').compress(payload);
    expect(registry.get('brotli').decompress(compressed).equals(payload)).toBe(true);
  });

  it('detects zstd frame prefix', () => {
    const registry = new CompressionRegistry();
    const compressed = registry.get('zstd-fast').compress(Buffer.from('hello zstd '.repeat(20), 'utf-8'));
    const detected = registry.detect(compressed);
    expect(detected?.id).toBe('zstd-fast');
  });
});
