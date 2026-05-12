// author: Frederik Caeyman
// date: 2025-12-08

import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';

export type CompressionAlgorithm = 'none' | 'gzip' | 'deflate' | 'brotli' | 'zstd-fast' | 'zstd';
export type CompressionOverride = CompressionAlgorithm | 'off';

export const COMPRESSION_ALGORITHMS: CompressionAlgorithm[] = [
  'none',
  'gzip',
  'deflate',
  'brotli',
  'zstd-fast',
  'zstd',
];

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

class BrotliCodec implements CompressionCodec {
  id: CompressionAlgorithm = 'brotli';

  compress(input: Buffer): Buffer {
    return brotliCompressSync(input, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 4,
      },
    });
  }

  decompress(input: Buffer): Buffer {
    return brotliDecompressSync(input);
  }

  canDecode(_input: Buffer): boolean {
    return false;
  }
}

class ZstdFastCodec implements CompressionCodec {
  id: CompressionAlgorithm = 'zstd-fast';

  compress(input: Buffer): Buffer {
    return zstdCompressSync(input, {
      params: {
        [constants.ZSTD_c_compressionLevel]: 3,
      },
    });
  }

  decompress(input: Buffer): Buffer {
    return zstdDecompressSync(input);
  }

  canDecode(input: Buffer): boolean {
    return input.length >= 4 && input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd;
  }
}

class ZstdCodec implements CompressionCodec {
  id: CompressionAlgorithm = 'zstd';

  compress(input: Buffer): Buffer {
    return zstdCompressSync(input, {
      params: {
        [constants.ZSTD_c_compressionLevel]: 10,
      },
    });
  }

  decompress(input: Buffer): Buffer {
    return zstdDecompressSync(input);
  }

  canDecode(input: Buffer): boolean {
    return input.length >= 4 && input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd;
  }
}

export class CompressionRegistry {
  private codecs: Map<CompressionAlgorithm, CompressionCodec> = new Map();

  constructor() {
    this.register(new NoopCodec());
    this.register(new GzipCodec());
    this.register(new DeflateCodec());
    this.register(new BrotliCodec());
    this.register(new ZstdFastCodec());
    this.register(new ZstdCodec());
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
