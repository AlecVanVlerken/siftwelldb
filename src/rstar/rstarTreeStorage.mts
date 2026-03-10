import { RStarNode } from './rstarNode.mjs';
import { serializeRectangle, deserializeRectangle } from './rectangleSerializer.mjs';
import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';

/** Magic byte identifying R*-tree pages (0xA4) */
const RSTAR_PAGE_MAGIC = 0xa4;

/**
 * RStarTreeStorage
 * -----------------
 * Low-level persistence layer for R*-tree nodes.
 *
 * Manages serialization/deserialization of R*-tree nodes to/from
 * disk blocks in a FreeBlockFile. Implements caching for performance.
 *
 * **PAGE FORMAT**
 * ```
 * Byte 0: Page magic (0xA4)
 * Byte 1: Node level (0 = leaf)
 * Bytes 2-3: Entry count (uint16 LE)
 * Bytes 4+: Entries
 *
 * Each entry:
 *   Bytes 0-31: MBR (4 x float64 LE)
 *   Bytes 32-35: child pageId (internal) or recordId (leaf)
 * ```
 *
 * **NOTE**: FreeBlockFile reserves byte 0 of each block for BlockType,
 * so our page data starts at byte 1 of the raw block.
 *
 * **USAGE**
 * ```typescript
 * const storage = new RStarTreeStorage(fbf, 50);
 * const rootId = await storage.create();
 *
 * const node = await storage.loadNode(rootId);
 * node.entries.push({ mbr: rect, recordId: 42 });
 * await storage.saveNode(rootId, node);
 * ```
 *
 * @see RStarIndex - High-level API using this storage
 * @see RStarNode - In-memory node representation
 */
export class RStarTreeStorage {
  private readonly blockSize: number;
  private readonly maxEntries: number;
  private readonly nodeCache: Map<number, RStarNode> = new Map();
  private rootPageId: number = -1;

  /**
   * Creates a new R*-tree storage instance.
   *
   * @param file - The FreeBlockFile to store nodes in
   * @param maxEntries - Maximum entries per node (affects tree depth)
   */
  constructor(
    private readonly file: FreeBlockFile,
    maxEntries: number = 50,
  ) {
    this.blockSize = file._getBlockSize();
    this.maxEntries = maxEntries;
  }

  /**
   * Creates a new R*-tree with an empty root node.
   *
   * @returns Page ID of the newly created root node
   */
  async create(): Promise<number> {
    const rootPageId = await this.allocateNode(0);
    this.rootPageId = rootPageId;
    return rootPageId;
  }

  /**
   * Opens an existing R*-tree from a previously saved root page.
   *
   * @param rootPageId - Page ID of the root node
   */
  open(rootPageId: number): void {
    this.rootPageId = rootPageId;
  }

  /**
   * Gets the current root page ID.
   * @returns The root page ID, or -1 if not initialized
   */
  getRootPageId(): number {
    return this.rootPageId;
  }

  /**
   * Updates the root page ID (called after root splits).
   * @param pageId - The new root page ID
   */
  setRootPageId(pageId: number): void {
    this.rootPageId = pageId;
  }

  /**
   * Loads a node from disk (or cache).
   *
   * Nodes are cached after loading to avoid repeated disk I/O.
   *
   * @param pageId - The page ID of the node to load
   * @returns The loaded RStarNode
   * @throws Error if page magic is invalid
   */
  async loadNode(pageId: number): Promise<RStarNode> {
    if (this.nodeCache.has(pageId)) {
      return this.nodeCache.get(pageId)!;
    }

    const buffer = await this.file.readBlock(pageId);
    // FreeBlockFile returns full block: byte 0 is BlockType, usable data starts at byte 1
    const view = new DataView(buffer.buffer, buffer.byteOffset + 1);

    // Check magic byte
    const magic = view.getUint8(0);
    if (magic !== RSTAR_PAGE_MAGIC) {
      throw new Error(`Invalid R*-tree page magic: ${magic}`);
    }

    const level = view.getUint8(1);
    const entryCount = view.getUint16(2, true);

    const node = new RStarNode(level);
    node.pageId = pageId;

    let offset = 4;
    for (let i = 0; i < entryCount; i++) {
      // Read rectangle (32 bytes)
      const rectBuffer = new Uint8Array(buffer.buffer, buffer.byteOffset + 1 + offset, 32);
      const mbr = deserializeRectangle(rectBuffer);
      offset += 32;

      if (node.isLeaf()) {
        // Leaf: read recordId (4 bytes)
        const recordId = view.getUint32(offset, true);
        offset += 4;
        node.entries.push({ mbr, recordId });
      } else {
        // Internal: read child pageId (4 bytes)
        const child = view.getUint32(offset, true);
        offset += 4;
        node.entries.push({ mbr, child });
      }
    }

    this.nodeCache.set(pageId, node);
    return node;
  }

  /**
   * Saves a node to disk and updates the cache.
   *
   * @param pageId - The page ID to write to
   * @param node - The node to save
   */
  async saveNode(pageId: number, node: RStarNode): Promise<void> {
    // Usable area is blockSize - 1 (FreeBlockFile reserves 1 byte)
    const usableSize = this.blockSize - 1;
    const buffer = Buffer.alloc(usableSize);
    const view = new DataView(buffer.buffer);

    // Write header
    view.setUint8(0, RSTAR_PAGE_MAGIC);
    view.setUint8(1, node.level);
    view.setUint16(2, node.entries.length, true);

    let offset = 4;
    for (const entry of node.entries) {
      // Write rectangle (32 bytes)
      const rectBuffer = serializeRectangle(entry.mbr);
      buffer.set(rectBuffer, offset);
      offset += 32;

      if (node.isLeaf()) {
        // Leaf: write recordId
        view.setUint32(offset, entry.recordId!, true);
        offset += 4;
      } else {
        // Internal: write child pageId
        view.setUint32(offset, entry.child!, true);
        offset += 4;
      }
    }

    await this.file.writeBlock(pageId, buffer);
    this.nodeCache.set(pageId, node);
  }

  /**
   * Allocates a new node at the specified level.
   *
   * Creates an empty node, saves it to disk, and returns its page ID.
   *
   * @param level - Tree level (0 = leaf)
   * @returns Page ID of the newly allocated node
   */
  async allocateNode(level: number): Promise<number> {
    const pageId = await this.file.allocateBlock();
    const node = new RStarNode(level);
    node.pageId = pageId;
    await this.saveNode(pageId, node);
    return pageId;
  }

  /**
   * Gets the maximum number of entries per node.
   * @returns The configured maximum entries
   */
  getMaxEntries(): number {
    return this.maxEntries;
  }
}
