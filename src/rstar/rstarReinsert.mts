import { RStarNode, type RStarEntry } from './rstarNode.mjs';
import { Rectangle } from './rstarRectangle.mjs';

/**
 * Performs forced reinsertion on an overflowing node.
 *
 * **R*-tree Reinsertion Strategy**
 * Instead of immediately splitting an overflowing node, the R*-tree
 * can remove some entries and reinsert them at the root level.
 * This helps maintain better tree structure and packing.
 *
 * **Algorithm**
 * 1. Compute center of the node's MBR
 * 2. Sort entries by distance from center (descending)
 * 3. Remove the 30% furthest entries for reinsertion
 * 4. Retain the closer entries in the node
 *
 * **Note**: This implementation currently does not use forced reinsertion
 * in the insert path to avoid potential infinite loops. It is provided
 * for completeness and potential future optimization.
 *
 * @param node - The overflowing node (modified in place)
 * @param center - The MBR of the node (used to compute center point)
 * @returns Entries that should be reinserted at the root level
 *
 * @example
 * // Usage (if reinsertion were enabled):
 * const toReinsert = forcedReinsert(node, computeMBR(node.entries));
 * for (const entry of toReinsert) {
 *   await rstarInsert(storage, root, entry.mbr, entry.recordId);
 * }
 */
export function forcedReinsert(node: RStarNode, center: Rectangle): RStarEntry[] {
  const p = Math.floor(node.entries.length * 0.3); // Reinsert 30%

  // Compute center of the node's MBR
  const centerX = (center.minX + center.maxX) / 2;
  const centerY = (center.minY + center.maxY) / 2;

  // Sort entries by distance from center
  const entriesWithDist = node.entries.map((entry) => {
    const entryX = (entry.mbr.minX + entry.mbr.maxX) / 2;
    const entryY = (entry.mbr.minY + entry.mbr.maxY) / 2;
    const dist = Math.sqrt((entryX - centerX) ** 2 + (entryY - centerY) ** 2);
    return { entry, dist };
  });

  entriesWithDist.sort((a, b) => b.dist - a.dist); // Sort descending

  // Take the p furthest entries for reinsertion
  const toReinsert = entriesWithDist.slice(0, p).map((e) => e.entry);
  const remaining = entriesWithDist.slice(p).map((e) => e.entry);

  node.entries = remaining;
  return toReinsert;
}
