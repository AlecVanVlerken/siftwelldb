import { Rectangle } from './rstarRectangle.mjs';
import { RStarNode } from './rstarNode.mjs';

/**
 * Chooses the best subtree for inserting a new rectangle.
 *
 * **Selection Criteria (in priority order)**
 * 1. Minimum MBR enlargement: Choose the subtree whose MBR needs to expand least
 * 2. Tie-breaker: Choose the subtree with smaller existing area
 *
 * **R*-tree Paper Note**
 * The original R*-tree paper uses different criteria for leaf vs. internal nodes:
 * - Leaf level: minimize overlap increase, then area increase
 * - Higher levels: minimize area increase, then existing area
 *
 * This implementation uses the simpler approach of always minimizing enlargement.
 *
 * @param node - The internal node to choose a child from
 * @param rect - The rectangle being inserted
 * @returns Index of the best child entry in `node.entries`
 *
 * @throws Error if node has no entries
 *
 * @example
 * const idx = chooseSubtree(internalNode, newRect);
 * const childPageId = internalNode.entries[idx].child;
 */
export function chooseSubtree(node: RStarNode, rect: Rectangle): number {
  if (node.entries.length === 0) {
    throw new Error('Cannot choose subtree from empty node');
  }

  // For leaf level, minimize overlap increase, then area increase
  // For higher levels, minimize area increase, then area
  let bestIdx = 0;
  let bestEnlargement = Infinity;
  let bestArea = Infinity;

  for (let i = 0; i < node.entries.length; i++) {
    const entry = node.entries[i];
    const enlargement = entry.mbr.enlargement(rect);
    const area = entry.mbr.area();

    if (enlargement < bestEnlargement || (enlargement === bestEnlargement && area < bestArea)) {
      bestIdx = i;
      bestEnlargement = enlargement;
      bestArea = area;
    }
  }

  return bestIdx;
}
