// author: Frederik Caeyman
// date: 2025-12-08

import { deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib';

export type CompressionAlgorithm = 'none' | 'gzip' | 'deflate';
export type CompressionOverride = CompressionAlgorithm | 'off';

export interface CompressionCodec {
  id: CompressionAlgorithm;
  compress(input: Buffer): Buffer;
  decompress(input: Buffer): Buffer;
  canDecode(input: Buffer): boolean;
}

class NoopCodec implements CompressionCodec {
  id: CompressionAlgorithm = 'none';

  compress(input: Buffer): Buffer {
    return input;
  }

  decompress(input: Buffer): Buffer {
    return input;
  }

  canDecode(_input: Buffer): boolean {
    return false;
  }
}

class GzipCodec implements CompressionCodec {
  id: CompressionAlgorithm = 'gzip';

  compress(input: Buffer): Buffer {
    return gzipSync(input);
  }

  decompress(input: Buffer): Buffer {
    return gunzipSync(input);
  }

  canDecode(input: Buffer): boolean {
    return input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
  }
}

class DeflateCodec implements CompressionCodec {
  id: CompressionAlgorithm = 'deflate';

  compress(input: Buffer): Buffer {
    return deflateSync(input);
  }

  decompress(input: Buffer): Buffer {
    return inflateSync(input);
  }

  canDecode(input: Buffer): boolean {
    if (input.length < 2 || input[0] !== 0x78) return false;
    const flg = input[1];
    return flg === 0x01 || flg === 0x5e || flg === 0x9c || flg === 0xda;
  }
}

export class CompressionRegistry {
  private codecs: Map<CompressionAlgorithm, CompressionCodec> = new Map();

  constructor() {
    this.register(new NoopCodec());
    this.register(new GzipCodec());
    this.register(new DeflateCodec());
  }

  register(codec: CompressionCodec): void {
    this.codecs.set(codec.id, codec);
  }

  get(id: CompressionAlgorithm): CompressionCodec {
    const codec = this.codecs.get(id);
    if (!codec) throw new Error(`Unsupported compression algorithm: ${id}`);
    return codec;
  }

  detect(encoded: Buffer): CompressionCodec | null {
    for (const codec of this.codecs.values()) {
      if (codec.id === 'none') continue;
      if (codec.canDecode(encoded)) return codec;
    }
    return null;
  }
}

export type FieldCompressionDefaults = Record<string, CompressionAlgorithm>;
export type FieldCompressionOverrides = Record<string, CompressionOverride>;
