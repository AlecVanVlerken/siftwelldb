import { Rectangle } from './rstarRectangle.mjs';

/**
 * Rectangle Serialization Format
 * ================================
 * Each rectangle is stored as 32 bytes:
 *
 * | Offset | Size | Field | Type    |
 * |--------|------|-------|---------|
 * | 0      | 8    | minX  | Float64 |
 * | 8      | 8    | minY  | Float64 |
 * | 16     | 8    | maxX  | Float64 |
 * | 24     | 8    | maxY  | Float64 |
 *
 * All values are little-endian.
 */

/** Size of a serialized rectangle in bytes */
export const RECTANGLE_BYTES = 32;

/**
 * Serializes a Rectangle to a 32-byte binary buffer.
 *
 * Converts the rectangle's four boundary coordinates to
 * little-endian Float64 values.
 *
 * @param rect - The rectangle to serialize
 * @returns A 32-byte Uint8Array containing the serialized rectangle
 *
 * @example
 * const rect = new Rectangle(0, 0, 10, 20);
 * const bytes = serializeRectangle(rect);
 * // bytes.length === 32
 */
export function serializeRectangle(rect: Rectangle): Uint8Array {
  const buffer = new Uint8Array(32);
  const view = new DataView(buffer.buffer);
  view.setFloat64(0, rect.minX, true);
  view.setFloat64(8, rect.minY, true);
  view.setFloat64(16, rect.maxX, true);
  view.setFloat64(24, rect.maxY, true);
  return buffer;
}

/**
 * Deserializes a Rectangle from a 32-byte binary buffer.
 *
 * Reads four little-endian Float64 values representing the
 * rectangle's boundary coordinates.
 *
 * @param buffer - A 32-byte Uint8Array containing a serialized rectangle
 * @returns The deserialized Rectangle object
 *
 * @throws Will produce incorrect results if buffer is less than 32 bytes
 *
 * @example
 * const bytes = new Uint8Array(32);
 * // ... fill bytes with serialized data ...
 * const rect = deserializeRectangle(bytes);
 */
export function deserializeRectangle(buffer: Uint8Array): Rectangle {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  const minX = view.getFloat64(0, true);
  const minY = view.getFloat64(8, true);
  const maxX = view.getFloat64(16, true);
  const maxY = view.getFloat64(24, true);
  return new Rectangle(minX, minY, maxX, maxY);
}
