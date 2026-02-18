// vector/vectorSerializer.ts

export class VectorSerializer {
  /** Returns the number of bytes required to serialize a vector of the given dimension. */
  static byteSize(dimension: number): number {
    return dimension * 4; // each float32 = 4 bytes
  }

  /** Serializes the given Float32Array into `buffer` at `offset` (little-endian floats). */
  static serialize(vector: Float32Array, buffer: Buffer, offset: number): void {
    for (let i = 0; i < vector.length; i++) {
      buffer.writeFloatLE(vector[i], offset + i * 4);
    }
  }

  /** Deserializes a Float32Array of `dimension` values from `buffer` at `offset`. */
  static deserialize(buffer: Buffer, offset: number, dimension: number): Float32Array {
    const result = new Float32Array(dimension);
    for (let i = 0; i < dimension; i++) {
      result[i] = buffer.readFloatLE(offset + i * 4);
    }
    return result;
  }
}
