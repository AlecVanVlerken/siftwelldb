import { Rectangle } from './rstarRectangle.mjs';
import { RStarNode, type RStarEntry } from './rstarNode.mjs';
import { RStarTreeStorage } from './rstarTreeStorage.mjs';
import { chooseSubtree } from './rstarChooseSubtree.mjs';
import { rstarSplit } from './rstarSplit.mjs';

/**
 * Inserts a rectangle with its associated ID into the R*-tree.
 *
 * **Algorithm Overview**
 * 1. Traverse from root to the appropriate leaf node using `chooseSubtree`
 * 2. Insert the new entry into the leaf
 * 3. If overflow occurs, split the node (R*-tree split algorithm)
 * 4. Propagate splits upward, possibly creating a new root
 *
 * **Node Splitting**
 * When a node overflows (exceeds `maxEntries`), it is split along
 * the axis that minimizes the total perimeter of the resulting MBRs.
 *
 * **Return Value**
 * Returns the (possibly new) root page ID. The root changes when:
 * - The original root was split, requiring a new root node
 *
 * @param storage - The tree storage manager
 * @param rootPageId - Current root page ID
 * @param rect - Rectangle to insert
 * @param id - Associated record/document ID
 * @returns The new root page ID (may be same as input if no root split)
 *
 * @example
 * let root = await rstarInsert(storage, root, new Rectangle(0,0,10,10), 1);
 */
export async function rstarInsert(
  storage: RStarTreeStorage,
  rootPageId: number,
  rect: Rectangle,
  id: number,
): Promise<number> {
  const root = await storage.loadNode(rootPageId);
  const newEntry: RStarEntry = { mbr: rect, recordId: id };

  // Track which levels have had forced reinsertion to avoid infinite loops
  const reinsertedLevels = new Set<number>();

  const result = await insertRecursive(storage, root, newEntry, reinsertedLevels);

  if (result.split) {
    // Root was split, create new root
    const newRootPageId = await storage.allocateNode(root.level + 1);
    const newRoot = await storage.loadNode(newRootPageId);

    const mbr1 = computeMBR(result.node1!.entries);
    const mbr2 = computeMBR(result.node2!.entries);

    await storage.saveNode(result.node1!.pageId!, result.node1!);
    await storage.saveNode(result.node2!.pageId!, result.node2!);

    newRoot.entries = [
      { mbr: mbr1, child: result.node1!.pageId! },
      { mbr: mbr2, child: result.node2!.pageId! },
    ];
    await storage.saveNode(newRootPageId, newRoot);
    return newRootPageId;
  }

  await storage.saveNode(rootPageId, result.node!);
  return rootPageId;
}

type InsertResult = {
  split: boolean;
  node?: RStarNode;
  node1?: RStarNode;
  node2?: RStarNode;
};

async function insertRecursive(
  storage: RStarTreeStorage,
  node: RStarNode,
  entry: RStarEntry,
  reinsertedLevels: Set<number>,
): Promise<InsertResult> {
  if (node.isLeaf()) {
    // Insert into leaf
    node.entries.push(entry);

    if (node.entries.length > storage.getMaxEntries()) {
      // Overflow: split the node
      // (Forced reinsertion disabled for simplicity - can cause infinite loops)
      const [node1, node2] = rstarSplit(node);
      node1.pageId = node.pageId;
      node2.pageId = await storage.allocateNode(node.level);
      return { split: true, node1, node2 };
    }

    return { split: false, node };
  } else {
    // Choose subtree
    const idx = chooseSubtree(node, entry.mbr);
    const childPageId = node.entries[idx].child!;
    const child = await storage.loadNode(childPageId);

    const result = await insertRecursive(storage, child, entry, reinsertedLevels);

    if (result.split) {
      // Child was split, update this node
      node.entries.splice(idx, 1); // Remove old entry

      const mbr1 = computeMBR(result.node1!.entries);
      const mbr2 = computeMBR(result.node2!.entries);

      await storage.saveNode(result.node1!.pageId!, result.node1!);
      await storage.saveNode(result.node2!.pageId!, result.node2!);

      node.entries.push({ mbr: mbr1, child: result.node1!.pageId! });
      node.entries.push({ mbr: mbr2, child: result.node2!.pageId! });

      if (node.entries.length > storage.getMaxEntries()) {
        // This node also overflows - split it
        const [node1, node2] = rstarSplit(node);
        node1.pageId = node.pageId;
        node2.pageId = await storage.allocateNode(node.level);
        return { split: true, node1, node2 };
      }
    } else {
      // Update MBR
      node.entries[idx].mbr = computeMBR(result.node!.entries);
      await storage.saveNode(result.node!.pageId!, result.node!);
    }

    return { split: false, node };
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
