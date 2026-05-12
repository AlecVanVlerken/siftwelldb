import * as fsPromises from 'node:fs/promises';

const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024;

export type FvecsInfo = {
  dim: number;
  count: number;
  recordBytes: number;
};

export type LoadedFvecs = {
  dim: number;
  count: number;
  data: Float32Array;
};

export type LoadedIvecs = {
  k: number;
  count: number;
  data: Int32Array;
};

async function inspectTexmexFile(filePath: string): Promise<{ width: number; count: number; recordBytes: number }> {
  const handle = await fsPromises.open(filePath, 'r');
  try {
    const header = Buffer.allocUnsafeSlow(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) {
      throw new Error(`Could not read header from ${filePath}.`);
    }
    const width = header.readInt32LE(0);
    const stats = await handle.stat();
    const recordBytes = 4 + width * 4;
    if (stats.size % recordBytes !== 0) {
      throw new Error(`Texmex file ${filePath} has invalid size ${stats.size} for width ${width}.`);
    }
    return {
      width,
      count: Math.floor(stats.size / recordBytes),
      recordBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function inspectFvecs(filePath: string): Promise<FvecsInfo> {
  const info = await inspectTexmexFile(filePath);
  return { dim: info.width, count: info.count, recordBytes: info.recordBytes };
}

export async function streamFvecs(
  filePath: string,
  onVector: (vector: Float32Array, index: number) => Promise<void> | void,
  options: {
    limit?: number;
    batchBytes?: number;
  } = {},
): Promise<FvecsInfo> {
  const info = await inspectFvecs(filePath);
  const limit = Math.min(options.limit ?? info.count, info.count);
  const batchBytes = Math.max(options.batchBytes ?? DEFAULT_BATCH_BYTES, info.recordBytes);
  const batchRecords = Math.max(1, Math.floor(batchBytes / info.recordBytes));
  const ioBuffer = Buffer.allocUnsafeSlow(batchRecords * info.recordBytes);
  const vectorBuffer = new Float32Array(info.dim);
  const handle = await fsPromises.open(filePath, 'r');

  try {
    let emitted = 0;
    while (emitted < limit) {
      const recordsThisBatch = Math.min(batchRecords, limit - emitted);
      const bytesToRead = recordsThisBatch * info.recordBytes;
      const { bytesRead } = await handle.read(ioBuffer, 0, bytesToRead, emitted * info.recordBytes);
      if (bytesRead !== bytesToRead) {
        throw new Error(`Short read while streaming ${filePath}: expected ${bytesToRead}, got ${bytesRead}.`);
      }

      for (let batchIndex = 0; batchIndex < recordsThisBatch; batchIndex++) {
        const recordOffset = batchIndex * info.recordBytes;
        const dim = ioBuffer.readInt32LE(recordOffset);
        if (dim !== info.dim) {
          throw new Error(`Mixed dimensions in ${filePath}: expected ${info.dim}, got ${dim}.`);
        }
        const view = new Float32Array(ioBuffer.buffer, ioBuffer.byteOffset + recordOffset + 4, info.dim);
        vectorBuffer.set(view);
        await onVector(vectorBuffer, emitted);
        emitted += 1;
      }
    }
  } finally {
    await handle.close();
  }

  return { ...info, count: limit };
}

export async function loadFvecs(filePath: string, limit?: number): Promise<LoadedFvecs> {
  const info = await inspectFvecs(filePath);
  const count = Math.min(limit ?? info.count, info.count);
  const data = new Float32Array(count * info.dim);
  await streamFvecs(
    filePath,
    (vector, index) => {
      data.set(vector, index * info.dim);
    },
    { limit: count },
  );
  return { dim: info.dim, count, data };
}

export async function loadIvecs(filePath: string, limit?: number): Promise<LoadedIvecs> {
  const info = await inspectTexmexFile(filePath);
  const count = Math.min(limit ?? info.count, info.count);
  const data = new Int32Array(count * info.width);
  const handle = await fsPromises.open(filePath, 'r');
  const rowBuffer = Buffer.allocUnsafeSlow(info.recordBytes);

  try {
    for (let index = 0; index < count; index++) {
      const { bytesRead } = await handle.read(rowBuffer, 0, rowBuffer.length, index * info.recordBytes);
      if (bytesRead !== rowBuffer.length) {
        throw new Error(`Short read while loading ${filePath}: expected ${rowBuffer.length}, got ${bytesRead}.`);
      }
      const width = rowBuffer.readInt32LE(0);
      if (width !== info.width) {
        throw new Error(`Mixed widths in ${filePath}: expected ${info.width}, got ${width}.`);
      }
      for (let item = 0; item < info.width; item++) {
        data[index * info.width + item] = rowBuffer.readInt32LE(4 + item * 4);
      }
    }
  } finally {
    await handle.close();
  }

  return {
    k: info.width,
    count,
    data,
  };
}
