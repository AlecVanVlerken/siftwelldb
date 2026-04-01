//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { type NodeId, HNSWNode } from './hnswNode.mjs';
import type { VectorPointer } from './vectorHeapFile.mjs';

/**
 * Magic byte written at usable[0] (= raw byte 1) of every HNSW graph node page.
 * Allows HNSWGraphStorage.scanNodes() to skip pages belonging to other subsystems
 * (B+ trees, RecordStore, VectorHeapFile) when everything shares a single FBF.
 */
const HNSW_GRAPH_PAGE_MAGIC = 0xa3;

// ** NodeId encoding **
// NodeId = BigInt(pageId) << 32n | BigInt(slotId)
// This is a unique, serialisable identifier for every node slot.

export function encodeNodeId(pageId: number, slotId: number): NodeId {
  return (BigInt(pageId) << 32n) | BigInt(slotId);
}

export function decodeNodeId(nodeId: NodeId): { pageId: number; slotId: number } {
  return {
    pageId: Number((nodeId >> 32n) & 0xffffffffn),
    slotId: Number(nodeId & 0xffffffffn),
  };
}

// ** Per-collection metadata block offsets **
// When HNSWGraphStorage is used as part of a shared FreeBlockFile (DbmsBack
// unified mode), metadata is written to a dedicated allocated block rather
// than the FBF client area (which DbmsBack uses for its own JSON meta).
//
// Layout of the 22-byte metadata payload stored in the dedicated block
// (bytes [1..22] of the raw block, i.e. the usable area):
//   [0-3]  M              (uint32 LE)
//   [4-7]  maxStoredLevel (uint32 LE)
//   [8-11] nodeSize       (uint32 LE, validation)
//   [12-15] entryPointHigh (uint32 LE) — high 32 bits of entry-point NodeId
//   [16-19] entryPointLow  (uint32 LE) — low  32 bits of entry-point NodeId
//   [20]   hasEntryPoint  (uint8)
//   [21]   currentMaxLevel (uint8)
const META_SIZE = 22;
const META_M = 0;
const META_MAX_LEVEL = 4;
const META_NODE_SIZE = 8;
const META_EP_HIGH = 12;
const META_EP_LOW = 16;
const META_HAS_EP = 20;
const META_CURRENT_MAX_LEVEL = 21;

// ** Per-node slot layout (within usable page area) **
// Each page starts with a 1-byte magic marker (HNSW_GRAPH_PAGE_MAGIC) at
// usable[0], so the page header layout is:
//
//   [0]    page magic (HNSW_GRAPH_PAGE_MAGIC = 0xa3)
//   [1-2]  usedCount (uint16 LE)
//   [3 … 2+bitmapBytes] slot bitmap
//   [3+bitmapBytes …]   node slots
//
// Fixed node header: 12 bytes per slot
//   [0-3]  docId              (uint32 LE)
//   [4]    level              (uint8)
//   [5-8]  vectorPtr.pageId   (uint32 LE)
//   [9-10] vectorPtr.slotId   (uint16 LE)
//   [11]   deleted            (uint8, 0 or 1)
//
// Layer 0 neighbors: 1 + 2*M*8 bytes
//   [12]        count0   (uint8)
//   [13 … 12+2*M*8] NodeId[]  (each 8 bytes, uint64 LE)
//
// Layer l (1 ≤ l ≤ maxStoredLevel): 1 + M*8 bytes
//   neighborsOffset(l) + [0]   count_l (uint8)
//   neighborsOffset(l) + [1 … M*8] NodeId[]
//
// nodeSize = 12 + (1 + 2*M*8) + maxStoredLevel*(1 + M*8)

function computeNodeSize(M: number, maxStoredLevel: number): number {
  return 12 + (1 + 2 * M * 8) + maxStoredLevel * (1 + M * 8);
}

function layer0NeighborOffset(): number {
  return 13; // after 12-byte header + 1 byte count
}

function layerNNeighborOffset(M: number, layer: number): number {
  // layer must be ≥ 1
  const base = 12 + (1 + 2 * M * 8); // skip fixed header + layer-0 block
  return base + (layer - 1) * (1 + M * 8) + 1; // +1 for count byte
}

function layerNCountOffset(M: number, layer: number): number {
  const base = 12 + (1 + 2 * M * 8);
  return base + (layer - 1) * (1 + M * 8);
}

const LAYER0_COUNT_OFFSET = 12; // byte index of count0 in the slot

// ** Page layout (usable area = bytes [1, blockSize-1] of raw block) **
// Mirror of the VectorHeapFile page layout (magic byte differs):
//   [0]              page magic (HNSW_GRAPH_PAGE_MAGIC = 0xa3)
//   [1-2]            usedCount  (uint16 LE)
//   [3 … 2+bitmapBytes] slot bitmap
//   [3+bitmapBytes … ]  node slots

/**
 * HNSWGraphStorage
 * -----------------
 * Persistent storage for HNSW graph nodes backed by a FreeBlockFile.
 *
 * Lifecycle (sharedFbf is the FreeBlockFile already open by DbmsBack):
 *   // New index:
 *   const gs = await HNSWGraphStorage.create(sharedFbf, M, maxStoredLevel);
 *   // store gs.metaBlockId in DbmsBack's metaCache for later reopen
 *
 *   // Existing index:
 *   const gs = await HNSWGraphStorage.open(sharedFbf, metaBlockId);
 *
 *   …use gs.insertNode / getNode / saveNode / deleteNode…
 *   await gs.saveMetadata();   // persist entry-point + level changes
 *   await sharedFbf.commit();  // one atomic WAL flush (covers all subsystems)
 *   await sharedFbf.close();   // managed by DbmsBack
 */
export class HNSWGraphStorage {
  readonly M: number;
  readonly maxStoredLevel: number;
  readonly nodeSize: number;
  private readonly bitmapBytes: number;
  readonly slotsPerPage: number;
  private readonly pageDataOffset: number;

  private _entryPoint: NodeId | null = null;
  private _currentMaxLevel: number = 0;
  /** Per-level node count. Index = level (0..maxStoredLevel). Maintained via incrementLevel/decrementLevel. */
  private _levelHistogram: number[];

  private insertHint: number = 0;

  /**
   * Block number of the dedicated metadata block in the FreeBlockFile.
   * Set by create() (which allocates the block) and by open() (which reads
   * from the known block). saveMetadata() writes to this block.
   */
  private _metaBlockId: number = 0;

  private constructor(
    private readonly file: FreeBlockFile,
    M: number,
    maxStoredLevel: number,
  ) {
    this.M = M;
    this.maxStoredLevel = maxStoredLevel;
    this.nodeSize = computeNodeSize(M, maxStoredLevel);
    this._levelHistogram = new Array<number>(maxStoredLevel + 1).fill(0);
    const blockSize = file._getBlockSize();
    // usable area = blockSize - 1 (byte 0 is block-type owned by FreeBlockFile)
    // page header = 1 byte magic + 2 bytes usedCount + bitmapBytes
    // n * nodeSize + ceil(n/8) <= blockSize - 4
    this.slotsPerPage = Math.floor(((blockSize - 4) * 8) / (this.nodeSize * 8 + 1));
    if (this.slotsPerPage < 1) {
      throw new Error(
        `Block size ${blockSize} is too small for nodeSize=${this.nodeSize} ` +
          `(M=${M}, maxStoredLevel=${maxStoredLevel}). Increase the block size.`,
      );
    }
    this.bitmapBytes = Math.ceil(this.slotsPerPage / 8);
    // magic(1) + usedCount(2) + bitmap
    this.pageDataOffset = 3 + this.bitmapBytes;
  }

  // ** Factory methods for create/open **

  /**
   * Initialise a brand-new HNSWGraphStorage on an already-open FreeBlockFile.
   * Allocates one dedicated metadata block from the FBF and writes initial
   * metadata there.  The block number is exposed via `gs.metaBlockId` and
   * must be stored externally (e.g. in DbmsBack's metaCache) so that
   * open() can locate it on reopen.
   *
   * Call `await fbf.commit()` + `await fbf.close()` when done.
   */
  static async create(file: FreeBlockFile, M: number, maxStoredLevel: number): Promise<HNSWGraphStorage> {
    const gs = new HNSWGraphStorage(file, M, maxStoredLevel);
    // Allocate a dedicated metadata block from the shared FBF.
    gs._metaBlockId = await file.allocateBlock();
    await gs.saveMetadata();
    return gs;
  }

  /**
   * Open an existing HNSWGraphStorage from a previously-created FreeBlockFile.
   * Reads M, maxStoredLevel, entry point, and current max level from the
   * dedicated metadata block whose block number is `metaBlockId`.
   *
   * `metaBlockId` was returned via `gs.metaBlockId` when the storage was
   * first created and should have been persisted externally.
   *
   * NOTE: The level histogram is initialised to all-zeros after `open()`.
   * It is the caller's responsibility to rebuild it — `HNSWIndex.open()`
   * does this automatically via `rebuildDocIdIndex()`.
   */
  static async open(file: FreeBlockFile, metaBlockId: number): Promise<HNSWGraphStorage> {
    const raw = await file.readBlock(metaBlockId);
    // Usable area starts at byte 1 (byte 0 is the block-type byte owned by FBF).
    const clientArea = raw.subarray(1);
    const M = clientArea.readUInt32LE(META_M);
    const maxStoredLevel = clientArea.readUInt32LE(META_MAX_LEVEL);
    const storedNodeSize = clientArea.readUInt32LE(META_NODE_SIZE);
    const gs = new HNSWGraphStorage(file, M, maxStoredLevel);
    gs._metaBlockId = metaBlockId;
    if (gs.nodeSize !== storedNodeSize) {
      throw new Error(
        `HNSWGraphStorage: stored nodeSize=${storedNodeSize} ≠ computed nodeSize=${gs.nodeSize}. ` +
          `Parameters do not match the file.`,
      );
    }
    // Restore entry point and current max level
    const hasEp = clientArea.readUInt8(META_HAS_EP);
    if (hasEp) {
      const high = BigInt(clientArea.readUInt32LE(META_EP_HIGH));
      const low = BigInt(clientArea.readUInt32LE(META_EP_LOW));
      gs._entryPoint = (high << 32n) | low;
    }
    gs._currentMaxLevel = clientArea.readUInt8(META_CURRENT_MAX_LEVEL);
    return gs;
  }

  // ** Accessors and mutators for graph-level metadata (entry point, max level, histogram) **

  /** Block number of the dedicated metadata block in the FreeBlockFile. */
  get metaBlockId(): number {
    return this._metaBlockId;
  }

  get entryPoint(): NodeId | null {
    return this._entryPoint;
  }

  get currentMaxLevel(): number {
    return this._currentMaxLevel;
  }

  setEntryPoint(nodeId: NodeId | null): void {
    this._entryPoint = nodeId;
  }

  setCurrentMaxLevel(level: number): void {
    this._currentMaxLevel = level;
  }

  /**
   * Increment the level histogram for a newly inserted node.
   * Call once per insert with the node's assigned level.
   */
  incrementLevel(level: number): void {
    const l = Math.min(level, this.maxStoredLevel);
    this._levelHistogram[l]++;
  }

  /**
   * Decrement the level histogram for a node being deleted.
   * Call once per delete with the node's level.
   */
  decrementLevel(level: number): void {
    const l = Math.min(level, this.maxStoredLevel);
    if (this._levelHistogram[l] > 0) this._levelHistogram[l]--;
  }

  /**
   * Return the true graph-wide maximum level: the highest level whose
   * histogram count is still > 0.  Returns 0 if the graph is empty.
   */
  computedMaxLevel(): number {
    for (let l = this.maxStoredLevel; l >= 0; l--) {
      if (this._levelHistogram[l] > 0) return l;
    }
    return 0;
  }

  /**
   * Reset and recount all histogram buckets from scratch.
   * Called by HNSWIndex.open() after scanning all live nodes.
   */
  resetHistogram(): void {
    this._levelHistogram.fill(0);
  }

  /**
   * Persist graph-level metadata (entryPoint, currentMaxLevel, M, maxStoredLevel)
   * to the dedicated metadata block in the FreeBlockFile.
   * Must call `index.commit()` afterwards to flush to disk.
   */
  async saveMetadata(): Promise<void> {
    const metaBuf = Buffer.alloc(META_SIZE);
    metaBuf.writeUInt32LE(this.M, META_M);
    metaBuf.writeUInt32LE(this.maxStoredLevel, META_MAX_LEVEL);
    metaBuf.writeUInt32LE(this.nodeSize, META_NODE_SIZE);
    if (this._entryPoint !== null) {
      metaBuf.writeUInt32LE(Number((this._entryPoint >> 32n) & 0xffffffffn), META_EP_HIGH);
      metaBuf.writeUInt32LE(Number(this._entryPoint & 0xffffffffn), META_EP_LOW);
      metaBuf.writeUInt8(1, META_HAS_EP);
    } else {
      metaBuf.writeUInt8(0, META_HAS_EP);
    }
    metaBuf.writeUInt8(this._currentMaxLevel, META_CURRENT_MAX_LEVEL);
    // Write to the dedicated metadata block (not the FBF client area, which is
    // reserved for DbmsBack's JSON meta in the unified single-FBF design).
    await this.file.writeBlock(this._metaBlockId, metaBuf);
  }

  // ** Low-level page helpers **

  private async readPage(pageId: number): Promise<Buffer> {
    const raw = await this.file.readBlock(pageId);
    return raw.subarray(1);
  }

  private async readPageIfData(pageId: number): Promise<Buffer | null> {
    const raw = await this.file.readBlock(pageId);
    if (raw.readUInt8(0) !== 0x02) return null; // 0x02 = BlockType.Data
    // Skip pages that belong to other subsystems (B+ trees, RecordStore, VectorHeapFile)
    // when operating inside a shared FBF.  HNSW graph pages always carry the magic.
    if (raw.readUInt8(1) !== HNSW_GRAPH_PAGE_MAGIC) return null;
    return raw.subarray(1);
  }

  private async writePage(pageId: number, usable: Buffer): Promise<void> {
    await this.file.writeBlock(pageId, usable);
  }

  private newPageBuffer(): Buffer {
    const buf = Buffer.alloc(this.file._getBlockSize() - 1);
    // Mark this as an HNSW graph page so scanNodes() can identify it in a
    // shared FBF where multiple subsystems coexist.
    buf.writeUInt8(HNSW_GRAPH_PAGE_MAGIC, 0);
    return buf;
  }

  // usedCount lives at usable[1..2] (usable[0] is the page magic byte)
  private getUsedCount(usable: Buffer): number {
    return usable.readUInt16LE(1);
  }

  private setUsedCount(usable: Buffer, count: number): void {
    usable.writeUInt16LE(count, 1);
  }

  // Bitmap starts at usable[3] (magic[0] + usedCount[1..2])
  private isBitSet(usable: Buffer, slotId: number): boolean {
    return (usable.readUInt8(3 + Math.floor(slotId / 8)) & (1 << slotId % 8)) !== 0;
  }

  private setBit(usable: Buffer, slotId: number): void {
    const idx = 3 + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(idx) | (1 << slotId % 8), idx);
  }

  private clearBit(usable: Buffer, slotId: number): void {
    const idx = 3 + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(idx) & ~(1 << slotId % 8), idx);
  }

  private slotOffset(slotId: number): number {
    return this.pageDataOffset + slotId * this.nodeSize;
  }

  private findFreeSlot(usable: Buffer): number {
    if (this.getUsedCount(usable) >= this.slotsPerPage) return -1;
    for (let s = 0; s < this.slotsPerPage; s++) {
      if (!this.isBitSet(usable, s)) return s;
    }
    return -1;
  }

  // ** Node serialisation helpers **

  private serialiseNode(usable: Buffer, slotOffset: number, node: HNSWNode): void {
    usable.writeUInt32LE(node.docId, slotOffset + 0);
    usable.writeUInt8(node.level, slotOffset + 4);
    usable.writeUInt32LE(node.vectorPtr.pageId, slotOffset + 5);
    usable.writeUInt16LE(node.vectorPtr.slotId, slotOffset + 9);
    usable.writeUInt8(node.deleted ? 1 : 0, slotOffset + 11);

    // Write neighbors for each layer
    const maxLayer = Math.min(node.level, this.maxStoredLevel);
    const maxM0 = this.M * 2; // max connections at layer 0

    // Layer 0
    const neighbors0 = node.neighbors[0] ?? [];
    const count0 = Math.min(neighbors0.length, maxM0);
    usable.writeUInt8(count0, slotOffset + LAYER0_COUNT_OFFSET);
    const off0 = slotOffset + layer0NeighborOffset();
    for (let i = 0; i < count0; i++) {
      usable.writeBigUInt64LE(neighbors0[i], off0 + i * 8);
    }

    // Layers 1 … maxLayer
    for (let l = 1; l <= this.maxStoredLevel; l++) {
      const countOff = slotOffset + layerNCountOffset(this.M, l);
      const neighborsOff = slotOffset + layerNNeighborOffset(this.M, l);
      const neighborsL = l <= maxLayer ? (node.neighbors[l] ?? []) : [];
      const countL = Math.min(neighborsL.length, this.M);
      usable.writeUInt8(countL, countOff);
      for (let i = 0; i < countL; i++) {
        usable.writeBigUInt64LE(neighborsL[i], neighborsOff + i * 8);
      }
    }
  }

  private deserialiseNode(usable: Buffer, slotOffset: number, nodeId: NodeId): HNSWNode {
    const docId = usable.readUInt32LE(slotOffset + 0);
    const level = usable.readUInt8(slotOffset + 4);
    const vectorPageId = usable.readUInt32LE(slotOffset + 5);
    const vectorSlotId = usable.readUInt16LE(slotOffset + 9);
    const deleted = usable.readUInt8(slotOffset + 11) !== 0;
    const vectorPtr: VectorPointer = { pageId: vectorPageId, slotId: vectorSlotId };

    const neighbors: NodeId[][] = [];

    // Layer 0
    const count0 = usable.readUInt8(slotOffset + LAYER0_COUNT_OFFSET);
    const off0 = slotOffset + layer0NeighborOffset();
    const neighbors0: NodeId[] = [];
    for (let i = 0; i < count0; i++) {
      neighbors0.push(usable.readBigUInt64LE(off0 + i * 8));
    }
    neighbors.push(neighbors0);

    // Layers 1 … maxStoredLevel
    const maxLayer = Math.min(level, this.maxStoredLevel);
    for (let l = 1; l <= this.maxStoredLevel; l++) {
      if (l > maxLayer) {
        neighbors.push([]);
        continue;
      }
      const countOff = slotOffset + layerNCountOffset(this.M, l);
      const neighborsOff = slotOffset + layerNNeighborOffset(this.M, l);
      const countL = usable.readUInt8(countOff);
      const neighborsL: NodeId[] = [];
      for (let i = 0; i < countL; i++) {
        neighborsL.push(usable.readBigUInt64LE(neighborsOff + i * 8));
      }
      neighbors.push(neighborsL);
    }

    return new HNSWNode({ nodeId, docId, level, vectorPtr, neighbors, deleted });
  }

  // ** Public node API **

  /**
   * Store a new node and return its persistent NodeId.
   * The caller should fill `node.docId`, `node.level`, `node.vectorPtr`,
   * `node.neighbors`, and `node.deleted` before calling this.
   * `node.nodeId` will be set to the assigned NodeId.
   */
  async insertNode(node: HNSWNode): Promise<NodeId> {
    // Try insert hint first — O(1) fast path.
    if (this.insertHint > 0) {
      const usable = await this.readPage(this.insertHint);
      const slotId = this.findFreeSlot(usable);
      if (slotId >= 0) {
        return this.writeNewNode(this.insertHint, usable, slotId, node);
      }
    }

    // Hint page is full — allocate a new page directly (O(1)).
    // Skipping the previous O(N) scan of all existing data pages.
    // Freed slots from deletes are reclaimed lazily when the hint page
    // itself has space (after a hardDeleteNode frees a slot on the hint page).
    const pageId = await this.file.allocateBlock();
    const usable = this.newPageBuffer();
    await this.writePage(pageId, usable); // initial write so block exists
    this.insertHint = pageId;
    return this.writeNewNode(pageId, usable, 0, node);
  }

  private async writeNewNode(pageId: number, usable: Buffer, slotId: number, node: HNSWNode): Promise<NodeId> {
    const nodeId = encodeNodeId(pageId, slotId);
    node.nodeId = nodeId;
    this.serialiseNode(usable, this.slotOffset(slotId), node);
    this.setBit(usable, slotId);
    this.setUsedCount(usable, this.getUsedCount(usable) + 1);
    await this.writePage(pageId, usable);
    return nodeId;
  }

  /**
   * Retrieve a node by its NodeId.
   */
  async getNode(nodeId: NodeId): Promise<HNSWNode> {
    const { pageId, slotId } = decodeNodeId(nodeId);
    const usable = await this.readPage(pageId);
    if (!this.isBitSet(usable, slotId)) {
      throw new Error(`HNSWGraphStorage: nodeId ${nodeId} slot is not occupied.`);
    }
    return this.deserialiseNode(usable, this.slotOffset(slotId), nodeId);
  }

  /**
   * Overwrite an existing node (update its neighbor lists, deleted flag, etc.).
   * `node.nodeId` must already be set to a valid, existing NodeId.
   */
  async saveNode(node: HNSWNode): Promise<void> {
    const { pageId, slotId } = decodeNodeId(node.nodeId);
    const usable = await this.readPage(pageId);
    if (!this.isBitSet(usable, slotId)) {
      throw new Error(`HNSWGraphStorage: cannot save node ${node.nodeId} — slot is not occupied.`);
    }
    this.serialiseNode(usable, this.slotOffset(slotId), node);
    await this.writePage(pageId, usable);
  }

  /**
   * Mark a node as deleted (soft-delete).
   * The slot is NOT freed; the node remains in the graph but will be ignored
   * during search. Use `hardDeleteNode` to reclaim the slot.
   */
  async softDeleteNode(nodeId: NodeId): Promise<void> {
    const node = await this.getNode(nodeId);
    node.deleted = true;
    await this.saveNode(node);
  }

  /**
   * Free the slot occupied by a node (hard delete).
   * Only call this after removing all neighbor references to this node.
   */
  async hardDeleteNode(nodeId: NodeId): Promise<void> {
    const { pageId, slotId } = decodeNodeId(nodeId);
    const usable = await this.readPage(pageId);
    this.clearBit(usable, slotId);
    const newCount = this.getUsedCount(usable) - 1;
    this.setUsedCount(usable, newCount);
    if (newCount === 0) {
      await this.file.freeBlock(pageId);
      if (this.insertHint === pageId) this.insertHint = 0;
    } else {
      await this.writePage(pageId, usable);
    }
  }

  /**
   * Async generator that yields every occupied node slot in the graph,
   * including soft-deleted nodes.  Callers must check `node.deleted` themselves.
   * Used by `HNSWIndex.open()` to rebuild the in-memory docId → NodeId map
   * and level histogram.
   */
  async *scanNodes(): AsyncGenerator<HNSWNode> {
    const blockCount = Math.max(this.file._getCachedBlockCount(), this.file._getHighestDirtyBlock() + 1);
    for (let pageId = 1; pageId < blockCount; pageId++) {
      const usable = await this.readPageIfData(pageId).catch(() => null);
      if (usable === null) continue; // freed or inaccessible block
      if (this.getUsedCount(usable) === 0) continue;
      for (let slotId = 0; slotId < this.slotsPerPage; slotId++) {
        if (this.isBitSet(usable, slotId)) {
          const nodeId = encodeNodeId(pageId, slotId);
          const node = this.deserialiseNode(usable, this.slotOffset(slotId), nodeId);
          yield node;
        }
      }
    }
  }

  /**
   * Flush all dirty graph blocks to disk via the shared WAL.
   * Both HNSWGraphStorage and VectorHeapFile delegate to the same
   * FreeBlockFile instance, so the call order only affects in-memory
   * write ordering — the actual on-disk commit is one atomic operation.
   * Always call vectorHeap.commit() first to preserve the
   * "data before index" in-memory write ordering invariant.
   */
  async commit(): Promise<void> {
    await this.file.commit();
  }

  /**
   * No-op in the shared-FBF design — the underlying FreeBlockFile is owned
   * and closed by DbmsBack.  Kept for symmetry with VectorHeapFile.
   */
  async close(): Promise<void> {
    await this.file.close();
  }
}
