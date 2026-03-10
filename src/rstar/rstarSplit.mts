import { RStarNode, type RStarEntry } from './rstarNode.mjs';
import { Rectangle } from './rstarRectangle.mjs';

/**
 * Splits an overflowing node using the R*-tree split algorithm.
 *
 * **Algorithm Overview**
 * 1. **Choose split axis**: Evaluate X and Y axes, choose the one with
 *    minimum total perimeter (margin) sum across all split candidates
 * 2. **Choose split index**: Along the chosen axis, select the split point
 *    that minimizes overlap between the two resulting MBRs
 *
 * **Distribution**
 * - Minimum 40% of entries per resulting node
 * - Entries are sorted by their lower bound on the split axis
 *
 * @param node - The overflowing node to split
 * @returns Tuple of two new nodes with entries distributed between them
 *
 * @example
 * if (node.entries.length > maxEntries) {
 *   const [node1, node2] = rstarSplit(node);
 *   // node1.pageId = original page, node2.pageId = new allocation
 * }
 */
export function rstarSplit(node: RStarNode): [RStarNode, RStarNode] {
  const axis = chooseSplitAxis(node);
  const splitIndex = chooseSplitIndex(node, axis);

  // Sort entries along the chosen axis
  const sorted = [...node.entries].sort((a, b) => {
    const aMin = axis === 0 ? a.mbr.minX : a.mbr.minY;
    const bMin = axis === 0 ? b.mbr.minX : b.mbr.minY;
    return aMin - bMin;
  });

  // Split at the chosen index
  const node1 = new RStarNode(node.level);
  const node2 = new RStarNode(node.level);

  node1.entries = sorted.slice(0, splitIndex);
  node2.entries = sorted.slice(splitIndex);

  return [node1, node2];
}

/**
 * Chooses the axis to split along (0 = X, 1 = Y).
 *
 * Evaluates all valid split positions on each axis and chooses
 * the axis with minimum total perimeter (margin) sum.
 *
 * @internal
 */
function chooseSplitAxis(node: RStarNode): number {
  const M = node.entries.length;
  const m = Math.floor(M * 0.4); // Minimum 40% entries per node

  let bestAxis = 0;
  let bestMargin = Infinity;

  for (let axis = 0; axis < 2; axis++) {
    // Sort by lower bound, then upper bound
    const sorted = [...node.entries].sort((a, b) => {
      const aMin = axis === 0 ? a.mbr.minX : a.mbr.minY;
      const bMin = axis === 0 ? b.mbr.minX : b.mbr.minY;
      return aMin - bMin;
    });

    let marginSum = 0;
    for (let k = m; k <= M - m; k++) {
      const mbr1 = computeMBR(sorted.slice(0, k));
      const mbr2 = computeMBR(sorted.slice(k));
      marginSum += margin(mbr1) + margin(mbr2);
    }

    if (marginSum < bestMargin) {
      bestMargin = marginSum;
      bestAxis = axis;
    }
  }

  return bestAxis;
}

/**
 * Chooses the optimal split index along the given axis.
 *
 * Selects the split point that minimizes overlap between the
 * two resulting MBRs, with area as a tie-breaker.
 *
 * @internal
 */
function chooseSplitIndex(node: RStarNode, axis: number): number {
  const M = node.entries.length;
  const m = Math.floor(M * 0.4);

  const sorted = [...node.entries].sort((a, b) => {
    const aMin = axis === 0 ? a.mbr.minX : a.mbr.minY;
    const bMin = axis === 0 ? b.mbr.minX : b.mbr.minY;
    return aMin - bMin;
  });

  let bestIndex = m;
  let bestOverlap = Infinity;
  let bestArea = Infinity;

  for (let k = m; k <= M - m; k++) {
    const mbr1 = computeMBR(sorted.slice(0, k));
    const mbr2 = computeMBR(sorted.slice(k));
    const overlap = computeOverlap(mbr1, mbr2);
    const area = mbr1.area() + mbr2.area();

    if (overlap < bestOverlap || (overlap === bestOverlap && area < bestArea)) {
      bestIndex = k;
      bestOverlap = overlap;
      bestArea = area;
    }
  }

  return bestIndex;
}

/**
 * Computes the minimum bounding rectangle of a set of entries.
 * @internal
 */
function computeMBR(entries: RStarEntry[]): Rectangle {
  if (entries.length === 0) {
    return new Rectangle(0, 0, 0, 0);
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const entry of entries) {
    minX = Math.min(minX, entry.mbr.minX);
    minY = Math.min(minY, entry.mbr.minY);
    maxX = Math.max(maxX, entry.mbr.maxX);
    maxY = Math.max(maxY, entry.mbr.maxY);
  }
  return new Rectangle(minX, minY, maxX, maxY);
}

function margin(rect: Rectangle): number {
  return 2 * (rect.maxX - rect.minX + (rect.maxY - rect.minY));
}

function computeOverlap(r1: Rectangle, r2: Rectangle): number {
  if (!r1.intersects(r2)) return 0;
  const overlapMinX = Math.max(r1.minX, r2.minX);
  const overlapMinY = Math.max(r1.minY, r2.minY);
  const overlapMaxX = Math.min(r1.maxX, r2.maxX);
  const overlapMaxY = Math.min(r1.maxY, r2.maxY);
  return (overlapMaxX - overlapMinX) * (overlapMaxY - overlapMinY);
}
