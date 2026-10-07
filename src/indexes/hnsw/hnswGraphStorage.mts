//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';
import { type NodeId, HNSWNode } from './hnswNode.mjs';
import type { VectorPointer } from './vectorHeapFile.mjs';
import { HnswIndexNative } from './hnswNative.mjs';

/**
 * Magic byte written at usable[0] (= raw byte 1) of every HNSW graph node page.
 * Allows HNSWGraphStorage.scanNodes() to skip pages belonging to other subsystems
 * (B+ trees, RecordStore, VectorHeapFile) when everything shares a single FBF.
 */
const HNSW_GRAPH_PAGE_MAGIC = 0xa3;
const CURRENT_NODE_ID_BYTES = 6;
const LEGACY_NODE_ID_BYTES = 8;

// ** NodeId encoding **
// NodeId = pageId * 2^32 + slotId  (fits safely in a JS number for any
// realistic block count — Number.MAX_SAFE_INTEGER / 2^32 ≈ 2 billion pages)

export function encodeNodeId(pageId: number, slotId: number): NodeId {
  return pageId * 4294967296 + slotId;
}

export function decodeNodeId(nodeId: NodeId): { pageId: number; slotId: number } {
  const pageId = Math.floor(nodeId / 4294967296);
  return {
    pageId,
    slotId: nodeId - pageId * 4294967296,
  };
}

export type HnswGraphNodeRelocationResult = {
  oldNodeId: NodeId;
  newNodeId: NodeId;
  docId: number;
  oldBlockNumber: number;
  newBlockNumber: number;
};

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
// Layer 0 neighbors: 1 + 2*M*nodeIdBytes bytes
//   [12]        count0   (uint8)
//   [13 …] NodeId[]  (current: 6 bytes pageId+slotId; legacy files:
//                      8 bytes slotId+pageId)
//
// Layer l (1 ≤ l ≤ maxStoredLevel): 1 + M*nodeIdBytes bytes
//   neighborsOffset(l) + [0]   count_l (uint8)
//   neighborsOffset(l) + [1 …] NodeId[]
//
// nodeSize = 12 + (1 + 2*M*nodeIdBytes) + maxStoredLevel*(1 + M*nodeIdBytes)

function computeNodeSize(M: number, maxStoredLevel: number, nodeIdBytes = CURRENT_NODE_ID_BYTES): number {
  return 12 + (1 + 2 * M * nodeIdBytes) + maxStoredLevel * (1 + M * nodeIdBytes);
}

function layer0NeighborOffset(): number {
  return 13; // after 12-byte header + 1 byte count
}

function layerNNeighborOffset(M: number, layer: number, nodeIdBytes = CURRENT_NODE_ID_BYTES): number {
  // layer must be ≥ 1
  const base = 12 + (1 + 2 * M * nodeIdBytes); // skip fixed header + layer-0 block
  return base + (layer - 1) * (1 + M * nodeIdBytes) + 1; // +1 for count byte
}

function layerNCountOffset(M: number, layer: number, nodeIdBytes = CURRENT_NODE_ID_BYTES): number {
  const base = 12 + (1 + 2 * M * nodeIdBytes);
  return base + (layer - 1) * (1 + M * nodeIdBytes);
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
   * Page-level read/write cache.
   *
   * Keyed by pageId, stores the **full raw block** (blockSize bytes) so that
   * stale entries from a previous commit cycle can be re-registered as dirty
   * via `_setDirtyBlock` with ZERO buffer allocation.  The usable area
   * (bytes [1..blockSize-1]) is obtained as `cached.subarray(1)` on demand.
   */
  private readonly _pageCache = new Map<number, { raw: Buffer; usable: Buffer }>();

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
    private readonly nodeIdBytes = CURRENT_NODE_ID_BYTES,
  ) {
    this.M = M;
    this.maxStoredLevel = maxStoredLevel;
    this.nodeSize = computeNodeSize(M, maxStoredLevel, nodeIdBytes);
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
    const currentNodeSize = computeNodeSize(M, maxStoredLevel, CURRENT_NODE_ID_BYTES);
    const legacyNodeSize = computeNodeSize(M, maxStoredLevel, LEGACY_NODE_ID_BYTES);
    let nodeIdBytes: number;
    if (storedNodeSize === currentNodeSize) {
      nodeIdBytes = CURRENT_NODE_ID_BYTES;
    } else if (storedNodeSize === legacyNodeSize) {
      nodeIdBytes = LEGACY_NODE_ID_BYTES;
    } else {
      throw new Error(
        `HNSWGraphStorage: stored nodeSize=${storedNodeSize} does not match supported node sizes ` +
          `${currentNodeSize} or ${legacyNodeSize}. Parameters do not match the file.`,
      );
    }
    const gs = new HNSWGraphStorage(file, M, maxStoredLevel, nodeIdBytes);
    gs._metaBlockId = metaBlockId;
    // Restore entry point and current max level
    const hasEp = clientArea.readUInt8(META_HAS_EP);
    if (hasEp) {
      const high = clientArea.readUInt32LE(META_EP_HIGH);
      const low = clientArea.readUInt32LE(META_EP_LOW);
      gs._entryPoint = high * 4294967296 + low;
    }
    gs._currentMaxLevel = clientArea.readUInt8(META_CURRENT_MAX_LEVEL);
    return gs;
  }

  // ** Accessors and mutators for graph-level metadata (entry point, max level, histogram) **

  /** Block number of the dedicated metadata block in the FreeBlockFile. */
  get metaBlockId(): number {
    return this._metaBlockId;
  }

  async freeMetadataBlock(): Promise<void> {
    if (this._metaBlockId === 0) return;
    await this.file.freeBlock(this._metaBlockId);
    this._metaBlockId = 0;
  }

  async relocateMetadata(options: { maxBlockExclusive?: number } = {}): Promise<number | null> {
    const oldBlockId = this._metaBlockId;
    if (oldBlockId === 0) return null;

    const newBlockId =
      options.maxBlockExclusive === undefined
        ? await this.file.allocateBlock()
        : await this.file.allocateBlockBelow(options.maxBlockExclusive);
    if (newBlockId === null) return null;

    this._metaBlockId = newBlockId;
    await this.saveMetadata();
    await this.file.freeBlock(oldBlockId);
    return newBlockId;
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
      const epHigh = Math.floor(this._entryPoint / 4294967296);
      const epLow = this._entryPoint - epHigh * 4294967296;
      metaBuf.writeUInt32LE(epHigh, META_EP_HIGH);
      metaBuf.writeUInt32LE(epLow, META_EP_LOW);
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
    // Fast path: return pre-cached usable slice (no subarray() call).
    const cached = this._pageCache.get(pageId);
    if (cached !== undefined) return cached.usable;
    // Not cached: check if already dirty (saves a readBlock allocation).
    const dirty = this.file._getDirtyBlock(pageId);
    if (dirty !== undefined) {
      const usable = dirty.subarray(1);
      this._pageCache.set(pageId, { raw: dirty, usable });
      return usable;
    }
    const raw = await this.file.readBlock(pageId);
    const usable = raw.subarray(1);
    this._pageCache.set(pageId, { raw, usable });
    return usable;
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
    // Fast path: usable is a subarray of the current dirty block (zero-copy).
    const dirty = this.file._getDirtyBlock(pageId);
    if (dirty !== undefined && dirty.buffer === usable.buffer && dirty.byteOffset === usable.byteOffset - 1) {
      const cached = this._pageCache.get(pageId);
      if (cached === undefined || cached.raw !== dirty) this._pageCache.set(pageId, { raw: dirty, usable });
      return;
    }
    // Stale path: usable is subarray(1) of a cached raw block — promote to dirty
    // with ZERO allocation by re-registering the existing raw buffer.
    const cached = this._pageCache.get(pageId);
    if (cached !== undefined && cached.raw.buffer === usable.buffer && usable.byteOffset === 1) {
      this.file._setDirtyBlock(pageId, cached.raw);
      return;
    }
    // Fallback: new page or external buffer — let writeBlock allocate + copy.
    await this.file.writeBlock(pageId, usable);
    const newDirty = this.file._getDirtyBlock(pageId);
    if (newDirty !== undefined) {
      this._pageCache.set(pageId, { raw: newDirty, usable: newDirty.subarray(1) });
    }
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

  private writeNodeId(usable: Buffer, offset: number, nodeId: NodeId): void {
    const { pageId, slotId } = decodeNodeId(nodeId);
    if (this.nodeIdBytes === LEGACY_NODE_ID_BYTES) {
      // Older graph pages used 8-byte node ids with the low slot id first,
      // then the page id. Preserve that on-disk format when old indexes are
      // opened so neighbor rewrites remain compatible with existing data.
      usable.writeUInt32LE(slotId, offset);
      usable.writeUInt32LE(pageId, offset + 4);
      return;
    }

    usable.writeUInt32LE(pageId, offset);
    if (this.nodeIdBytes === CURRENT_NODE_ID_BYTES) {
      if (slotId > 0xffff) throw new Error(`HNSWGraphStorage: slotId ${slotId} exceeds current node-id format.`);
      usable.writeUInt16LE(slotId, offset + 4);
    }
  }

  private readNodeId(usable: Buffer, offset: number): NodeId {
    if (this.nodeIdBytes === LEGACY_NODE_ID_BYTES) {
      const slotId = usable.readUInt32LE(offset);
      const pageId = usable.readUInt32LE(offset + 4);
      return pageId * 4294967296 + slotId;
    }
    const pageId = usable.readUInt32LE(offset);
    const slotId = usable.readUInt16LE(offset + 4);
    return pageId * 4294967296 + slotId;
  }

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
      this.writeNodeId(usable, off0 + i * this.nodeIdBytes, neighbors0[i]);
    }

    // Layers 1 … maxLayer
    for (let l = 1; l <= this.maxStoredLevel; l++) {
      const countOff = slotOffset + layerNCountOffset(this.M, l, this.nodeIdBytes);
      const neighborsOff = slotOffset + layerNNeighborOffset(this.M, l, this.nodeIdBytes);
      const neighborsL = l <= maxLayer ? (node.neighbors[l] ?? []) : [];
      const countL = Math.min(neighborsL.length, this.M);
      usable.writeUInt8(countL, countOff);
      for (let i = 0; i < countL; i++) {
        this.writeNodeId(usable, neighborsOff + i * this.nodeIdBytes, neighborsL[i]);
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
    const neighbors0: NodeId[] = new Array<NodeId>(count0);
    for (let i = 0; i < count0; i++) {
      neighbors0[i] = this.readNodeId(usable, off0 + i * this.nodeIdBytes);
    }
    neighbors.push(neighbors0);

    // Layers 1 … maxStoredLevel
    const maxLayer = Math.min(level, this.maxStoredLevel);
    for (let l = 1; l <= this.maxStoredLevel; l++) {
      if (l > maxLayer) {
        neighbors.push([]);
        continue;
      }
      const countOff = slotOffset + layerNCountOffset(this.M, l, this.nodeIdBytes);
      const neighborsOff = slotOffset + layerNNeighborOffset(this.M, l, this.nodeIdBytes);
      const countL = usable.readUInt8(countOff);
      const neighborsL: NodeId[] = new Array<NodeId>(countL);
      for (let i = 0; i < countL; i++) {
        neighborsL[i] = this.readNodeId(usable, neighborsOff + i * this.nodeIdBytes);
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
  async insertNode(node: HNSWNode, options: { maxBlockExclusive?: number } = {}): Promise<NodeId> {
    // Try insert hint first — O(1) fast path.
    if (
      this.insertHint > 0 &&
      (options.maxBlockExclusive === undefined || this.insertHint < options.maxBlockExclusive)
    ) {
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
    const pageId =
      options.maxBlockExclusive === undefined
        ? await this.file.allocateBlock()
        : await this.allocatePageBelow(options.maxBlockExclusive);
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
    if (slotId < 0 || slotId >= this.slotsPerPage) {
      throw new Error(
        `HNSWGraphStorage: nodeId ${nodeId} has invalid slot ${slotId.toString()} ` +
          `(slotsPerPage=${this.slotsPerPage.toString()}).`,
      );
    }
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
   * Move one graph node to a fresh physical NodeId.
   *
   * The persisted graph currently uses NodeId as both identity and physical
   * location, so relocation repairs stored neighbor references and the entry
   * point when they point at the moved node.
   */
  async relocateNode(
    nodeId: NodeId,
    options: { maxBlockExclusive?: number } = {},
  ): Promise<HnswGraphNodeRelocationResult> {
    const oldLocation = decodeNodeId(nodeId);
    const node = await this.getNode(nodeId);
    if (node.deleted) {
      throw new Error(`HNSWGraphStorage: cannot relocate deleted node ${nodeId}`);
    }

    const moved = new HNSWNode({
      nodeId: 0,
      docId: node.docId,
      level: node.level,
      vectorPtr: { ...node.vectorPtr },
      neighbors: node.neighbors.map((layer) => [...layer]),
      deleted: node.deleted,
    });
    const newNodeId = await this.insertNode(moved, options);
    const newLocation = decodeNodeId(newNodeId);

    if (this._entryPoint === nodeId) {
      this._entryPoint = newNodeId;
      await this.saveMetadata();
    }

    for await (const candidate of this.scanPhysicalNodes()) {
      if (candidate.nodeId === nodeId) {
        continue;
      }
      if (this.replaceNeighborNodeId(candidate, nodeId, newNodeId)) {
        await this.saveNode(candidate);
      }
    }

    await this.hardDeleteNode(nodeId);

    return {
      oldNodeId: nodeId,
      newNodeId,
      docId: node.docId,
      oldBlockNumber: oldLocation.pageId,
      newBlockNumber: newLocation.pageId,
    };
  }

  private async allocatePageBelow(maxBlockExclusive: number): Promise<number> {
    const pageId = await this.file.allocateBlockBelow(maxBlockExclusive);
    if (pageId === null) {
      throw new Error(`No free HNSW graph relocation block below ${maxBlockExclusive.toString()}`);
    }
    return pageId;
  }

  /**
   * Update only the neighbor arrays of a stored node in-place.
   *
   * **Hot path** — called for every dirty node after each HNSW insert/delete.
   * Returns `void` (synchronous, no microtask) when the page is already in the
   * FBF dirty cache, `Promise<void>` only on the rare first-ever disk access.
   *
   * Zero-allocation fast path: avoids constructing a temporary `HNSWNode`,
   * `VectorPointer`, or any intermediate `NodeId[][]` / `NodeId[]` arrays.
   *
   * @param nodeId     NodeId of the node to update.
   * @param docId      docId — used to query Rust for the current neighbor lists.
   * @param rustIdx    Rust HNSW index (for `getNeighbors()` calls).
   * @param docIdIndex Mapping from docId → NodeId for neighbor id resolution.
   */
  updateNodeNeighbors(
    nodeId: NodeId,
    docId: number,
    rustIdx: HnswIndexNative,
    docIdIndex: Map<number, NodeId>,
  ): void | Promise<void> {
    const pageId = Math.floor(nodeId / 4294967296);
    const slotId = nodeId - pageId * 4294967296;

    // 1. Read path — get pre-cached {raw, usable} pair.
    const cached = this._pageCache.get(pageId);
    if (cached === undefined) {
      // Rare: not in cache at all — must read from disk.
      return this._updateNodeNeighborsFromDisk(pageId, slotId, docId, rustIdx, docIdIndex);
    }

    // 2. Ensure raw is the active dirty block; promote stale raw (zero-allocation).
    if (this.file._getDirtyBlock(pageId) !== cached.raw) {
      this.file._setDirtyBlock(pageId, cached.raw);
    }

    // 3. Write neighbors directly into cached.usable (zero subarray() allocation).
    const usable = cached.usable;
    const slotOff = this.slotOffset(slotId);
    const maxM0 = this.M * 2;

    // ONE FFI call returns all layers: [nodeLevel, count0, nb0..., count1, nb1..., ...]
    const allNb = rustIdx.getAllNeighbors(docId);
    const nodeLevel = allNb.length > 0 ? allNb[0] : 0;
    const maxLayer = Math.min(nodeLevel, this.maxStoredLevel);
    let nbPos = 1;

    // Layer 0
    const count0 = allNb[nbPos++];
    const maxCount0 = Math.min(count0, maxM0);
    const off0 = slotOff + layer0NeighborOffset();
    let actualCount0 = 0;
    for (let i = 0; i < maxCount0; i++) {
      const nid = docIdIndex.get(allNb[nbPos + i]);
      if (nid !== undefined) {
        this.writeNodeId(usable, off0 + actualCount0 * this.nodeIdBytes, nid);
        actualCount0++;
      }
    }
    nbPos += count0;
    usable[slotOff + LAYER0_COUNT_OFFSET] = actualCount0;

    for (let l = 1; l <= this.maxStoredLevel; l++) {
      const countOff = slotOff + layerNCountOffset(this.M, l, this.nodeIdBytes);
      const neighborsOff = slotOff + layerNNeighborOffset(this.M, l, this.nodeIdBytes);
      if (l > maxLayer) {
        usable[countOff] = 0;
        continue;
      }
      const countL = allNb[nbPos++];
      const maxCountL = Math.min(countL, this.M);
      let actualCountL = 0;
      for (let i = 0; i < maxCountL; i++) {
        const nid = docIdIndex.get(allNb[nbPos + i]);
        if (nid !== undefined) {
          this.writeNodeId(usable, neighborsOff + actualCountL * this.nodeIdBytes, nid);
          actualCountL++;
        }
      }
      nbPos += countL;
      usable[countOff] = actualCountL;
    }

    return; // void — fully synchronous, no microtask, no allocation
  }

  /**
   * Slow path for `updateNodeNeighbors`: page is not in cache.
   * Reads the block from disk once, registers it as dirty, writes neighbors in-place,
   * and caches the raw block for future synchronous access.
   */
  private async _updateNodeNeighborsFromDisk(
    pageId: number,
    slotId: number,
    docId: number,
    rustIdx: HnswIndexNative,
    docIdIndex: Map<number, NodeId>,
  ): Promise<void> {
    const raw = await this.file.readBlock(pageId);
    // Register as dirty and cache both raw + usable for future zero-allocation access.
    this.file._setDirtyBlock(pageId, raw);
    const usable = raw.subarray(1);
    this._pageCache.set(pageId, { raw, usable });
    const slotOff = this.slotOffset(slotId);
    const maxM0 = this.M * 2;

    // ONE FFI call returns all layers: [nodeLevel, count0, nb0..., count1, nb1..., ...]
    const allNb = rustIdx.getAllNeighbors(docId);
    const nodeLevel = allNb.length > 0 ? allNb[0] : 0;
    const maxLayer = Math.min(nodeLevel, this.maxStoredLevel);
    let nbPos = 1;

    // Layer 0
    const count0 = allNb[nbPos++];
    const maxCount0 = Math.min(count0, maxM0);
    const off0 = slotOff + layer0NeighborOffset();
    let actualCount0 = 0;
    for (let i = 0; i < maxCount0; i++) {
      const nid = docIdIndex.get(allNb[nbPos + i]);
      if (nid !== undefined) {
        this.writeNodeId(usable, off0 + actualCount0 * this.nodeIdBytes, nid);
        actualCount0++;
      }
    }
    nbPos += count0;
    usable[slotOff + LAYER0_COUNT_OFFSET] = actualCount0;

    for (let l = 1; l <= this.maxStoredLevel; l++) {
      const countOff = slotOff + layerNCountOffset(this.M, l, this.nodeIdBytes);
      const neighborsOff = slotOff + layerNNeighborOffset(this.M, l, this.nodeIdBytes);
      if (l > maxLayer) {
        usable[countOff] = 0;
        continue;
      }
      const countL = allNb[nbPos++];
      const maxCountL = Math.min(countL, this.M);
      let actualCountL = 0;
      for (let i = 0; i < maxCountL; i++) {
        const nid = docIdIndex.get(allNb[nbPos + i]);
        if (nid !== undefined) {
          this.writeNodeId(usable, neighborsOff + actualCountL * this.nodeIdBytes, nid);
          actualCountL++;
        }
      }
      nbPos += countL;
      usable[countOff] = actualCountL;
    }
    // Data already reflected in dirty cache via raw — no writePage needed.
  }

  private replaceNeighborNodeId(node: HNSWNode, oldNodeId: NodeId, newNodeId: NodeId): boolean {
    let changed = false;

    for (const neighbors of node.neighbors) {
      for (let i = 0; i < neighbors.length; i++) {
        if (neighbors[i] === oldNodeId) {
          neighbors[i] = newNodeId;
          changed = true;
        }
      }
    }

    return changed;
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
      this._pageCache.delete(pageId); // drop cached pair, not just raw
      await this.file.freeBlock(pageId);
      if (this.insertHint === pageId) this.insertHint = 0;
    } else {
      await this.writePage(pageId, usable);
    }
  }

  /**
   * Async generator that yields nodes reachable from this graph's entry point.
   *
   * All HNSW collections share one FreeBlockFile, so scans must stay scoped
   * to this collection-local graph instead of every HNSW graph page.
   * Used by `HNSWIndex.open()` to rebuild the in-memory docId → NodeId map
   * and level histogram.
   */
  async *scanNodes(): AsyncGenerator<HNSWNode> {
    if (this._entryPoint === null) {
      yield* this.scanPhysicalNodes();
      return;
    }

    const seen = new Set<NodeId>();
    const queue: NodeId[] = [this._entryPoint];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);

      let node: HNSWNode;
      try {
        node = await this.getNode(nodeId);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('slot is not occupied')) {
          throw error;
        }
        continue;
      }

      yield node;

      for (const layer of node.neighbors) {
        for (const neighbor of layer) {
          if (!seen.has(neighbor)) queue.push(neighbor);
        }
      }
    }
  }

  private async *scanPhysicalNodes(): AsyncGenerator<HNSWNode> {
    const blockCount = Math.max(this.file._getCachedBlockCount(), this.file._getHighestDirtyBlock() + 1);
    for (let pageId = 1; pageId < blockCount; pageId++) {
      const usable = await this.readPageIfData(pageId).catch(() => null);
      if (usable === null) continue;
      if (this.getUsedCount(usable) === 0) continue;
      for (let slotId = 0; slotId < this.slotsPerPage; slotId++) {
        if (this.isBitSet(usable, slotId)) {
          const nodeId = encodeNodeId(pageId, slotId);
          yield this.deserialiseNode(usable, this.slotOffset(slotId), nodeId);
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
