/**
 * Rectangle
 * ----------
 * Axis-aligned bounding rectangle (AABB) used by the R*-tree spatial index.
 * Represents a 2D rectangular region defined by its minimum and maximum
 * coordinates on both axes.
 *
 * **Coordinate System**
 * The rectangle is defined by four coordinates:
 * - `minX`, `minY`: Lower-left corner (inclusive)
 * - `maxX`, `maxY`: Upper-right corner (inclusive)
 *
 * **Usage Examples**
 * ```typescript
 * // Create a 10x10 rectangle at origin
 * const rect = new Rectangle(0, 0, 10, 10);
 *
 * // Check if two rectangles overlap
 * const other = new Rectangle(5, 5, 15, 15);
 * if (rect.intersects(other)) {
 *   console.log('Rectangles overlap');
 * }
 *
 * // Compute bounding box of two rectangles
 * const bbox = rect.union(other);
 * ```
 */
export class Rectangle {
  /**
   * Creates a new axis-aligned bounding rectangle.
   *
   * @param minX - Minimum X coordinate (left edge)
   * @param minY - Minimum Y coordinate (bottom edge)
   * @param maxX - Maximum X coordinate (right edge)
   * @param maxY - Maximum Y coordinate (top edge)
   *
   * @example
   * const rect = new Rectangle(0, 0, 100, 50);
   */
  constructor(
    public minX: number,
    public minY: number,
    public maxX: number,
    public maxY: number,
  ) {}

  /**
   * Calculates the area of this rectangle.
   *
   * @returns The area (width × height). Returns 0 for point or line rectangles.
   *
   * @example
   * const rect = new Rectangle(0, 0, 10, 5);
   * console.log(rect.area()); // 50
   */
  area(): number {
    return (this.maxX - this.minX) * (this.maxY - this.minY);
  }

  /**
   * Tests whether this rectangle intersects (overlaps) with another rectangle.
   * Two rectangles intersect if they share any area, including edges.
   *
   * @param other - The rectangle to test intersection with
   * @returns `true` if the rectangles overlap, `false` otherwise
   *
   * @example
   * const r1 = new Rectangle(0, 0, 10, 10);
   * const r2 = new Rectangle(5, 5, 15, 15);
   * console.log(r1.intersects(r2)); // true
   */
  intersects(other: Rectangle): boolean {
    return this.minX <= other.maxX && this.maxX >= other.minX && this.minY <= other.maxY && this.maxY >= other.minY;
  }

  /**
   * Computes the minimum bounding rectangle (MBR) that contains both
   * this rectangle and another rectangle.
   *
   * @param other - The rectangle to union with
   * @returns A new Rectangle representing the union
   *
   * @example
   * const r1 = new Rectangle(0, 0, 10, 10);
   * const r2 = new Rectangle(5, 5, 15, 15);
   * const union = r1.union(r2);
   * // union = Rectangle(0, 0, 15, 15)
   */
  union(other: Rectangle): Rectangle {
    return new Rectangle(
      Math.min(this.minX, other.minX),
      Math.min(this.minY, other.minY),
      Math.max(this.maxX, other.maxX),
      Math.max(this.maxY, other.maxY),
    );
  }

  /**
   * Calculates how much this rectangle's area would increase if it were
   * enlarged to contain another rectangle.
   *
   * This is a key metric used by R*-tree insertion to choose the best
   * subtree — the subtree requiring the least enlargement is preferred.
   *
   * @param other - The rectangle to potentially include
   * @returns The area increase required (union area - current area)
   *
   * @example
   * const r1 = new Rectangle(0, 0, 10, 10); // area = 100
   * const r2 = new Rectangle(5, 5, 15, 15);
   * console.log(r1.enlargement(r2)); // 125 (union area 225 - original 100)
   */
  enlargement(other: Rectangle): number {
    const unionRect = this.union(other);
    return unionRect.area() - this.area();
  }

  /**
   * Tests whether a point lies within or on the boundary of this rectangle.
   *
   * @param point - An object with `x` and `y` coordinates
   * @returns `true` if the point is inside or on the rectangle boundary
   *
   * @example
   * const rect = new Rectangle(0, 0, 10, 10);
   * console.log(rect.contains({ x: 5, y: 5 }));  // true
   * console.log(rect.contains({ x: 15, y: 5 })); // false
   */
  contains(point: { x: number; y: number }): boolean {
    return point.x >= this.minX && point.x <= this.maxX && point.y >= this.minY && point.y <= this.maxY;
  }

  /**
   * Tests whether this rectangle is exactly equal to another rectangle.
   * Two rectangles are equal if all four coordinates match exactly.
   *
   * @param other - The rectangle to compare with
   * @returns `true` if rectangles are identical
   *
   * @example
   * const r1 = new Rectangle(0, 0, 10, 10);
   * const r2 = new Rectangle(0, 0, 10, 10);
   * console.log(r1.equals(r2)); // true
   */
  equals(other: Rectangle): boolean {
    return this.minX === other.minX && this.minY === other.minY && this.maxX === other.maxX && this.maxY === other.maxY;
  }
}
