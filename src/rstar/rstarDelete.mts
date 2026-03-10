import { Rectangle } from './rstarRectangle.mjs';
import { RStarNode, type RStarEntry } from './rstarNode.mjs';
import { RStarTreeStorage } from './rstarTreeStorage.mjs';

/**
 * Deletes a rectangle with the specified ID from the R*-tree.
 *
 * **Algorithm Overview**
 * 1. Search for the entry by traversing nodes whose MBRs intersect the target
 * 2. Remove the matching entry from its leaf node
 * 3. Update ancestor MBRs to reflect the deletion
 * 4. Handle underflow by removing empty nodes
 * 5. If root has single child, promote to reduce tree height
 *
 * **Matching**
 * Both the rectangle and ID must match exactly for deletion.
 * Uses `Rectangle.equals()` for rectangle comparison.
 *
 * **Return Value**
 * Returns the (possibly new) root page ID. The root changes when:
 * - The old root is condensed to a single child (promotes child as new root)
 *
 * @param storage - The tree storage manager
 * @param rootPageId - Current root page ID
 * @param rect - Exact rectangle to delete
 * @param id - Associated record/document ID
 * @returns The new root page ID (may differ if tree condensed)
 *
 * @example
 * const newRoot = await rstarDelete(storage, root, rect, recordId);
 */
export async function rstarDelete(
  storage: RStarTreeStorage,
  rootPageId: number,
  rect: Rectangle,
  id: number,
): Promise<number> {
  const root = await storage.loadNode(rootPageId);
  const deleted = await deleteRecursive(storage, root, rect, id);

  if (!deleted) {
    return rootPageId; // Nothing deleted
  }

  // Check if root is now empty (can happen after condensing)
  if (root.entries.length === 0 && !root.isLeaf()) {
    // Root has no entries, tree is empty
    return rootPageId;
  }

  // If root has only one child and is not a leaf, promote the child
  if (root.entries.length === 1 && !root.isLeaf()) {
    const childPageId = root.entries[0].child!;
    await storage.saveNode(rootPageId, root);
    return childPageId;
  }

  await storage.saveNode(rootPageId, root);
  return rootPageId;
}

async function deleteRecursive(
  storage: RStarTreeStorage,
  node: RStarNode,
  rect: Rectangle,
  id: number,
): Promise<boolean> {
  if (node.isLeaf()) {
    // Find and remove the entry
    const idx = node.entries.findIndex((e) => e.recordId === id && e.mbr.equals(rect));

    if (idx === -1) {
      return false; // Not found
    }

    node.entries.splice(idx, 1);
    return true;
  } else {
    // Find child nodes that might contain the entry
    for (let i = 0; i < node.entries.length; i++) {
      const entry = node.entries[i];
      if (entry.mbr.intersects(rect)) {
        const child = await storage.loadNode(entry.child!);
        const deleted = await deleteRecursive(storage, child, rect, id);

        if (deleted) {
          // Update MBR or remove child if empty
          if (child.entries.length === 0) {
            node.entries.splice(i, 1);
          } else {
            entry.mbr = computeMBR(child.entries);
            await storage.saveNode(entry.child!, child);
          }
          return true;
        }
      }
    }

    return false; // Not found in any child
  }
}

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
