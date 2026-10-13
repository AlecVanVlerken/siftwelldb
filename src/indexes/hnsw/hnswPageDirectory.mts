import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';

// Keep the original graph/dimension prefix. Entries identify exclusively owned
// graph pages; occupied slots on those pages remain the authoritative members.
const MARKER = Buffer.from('HPD1');
const ROOT_OFFSET = 30;
const HEADER_SIZE = 10;
type DirectoryBlock = { id: number; data: Buffer; offset: number };
type Location = { block: DirectoryBlock; offset: number };

export class HnswPageDirectoryError extends Error {}

export class HnswPageDirectory {
  private readonly blocks: DirectoryBlock[] = [];
  private readonly pages = new Map<number, Location>();
  private readonly free: Location[] = [];

  private constructor(private readonly file: FreeBlockFile) {}

  static create(file: FreeBlockFile, root: number, data = Buffer.alloc(file._getBlockSize() - 1)): HnswPageDirectory {
    const directory = new HnswPageDirectory(file);
    MARKER.copy(data, ROOT_OFFSET);
    data.writeUInt32LE(0, ROOT_OFFSET + 4);
    data.writeUInt16LE(0, ROOT_OFFSET + 8);
    directory.addBlock({ id: root, data, offset: ROOT_OFFSET });
    return directory;
  }

  static async open(file: FreeBlockFile, root: number, data: Buffer): Promise<HnswPageDirectory | undefined> {
    if (data.subarray(ROOT_OFFSET, ROOT_OFFSET + HEADER_SIZE).every((byte) => byte === 0)) return undefined;
    const directory = new HnswPageDirectory(file);
    let block: DirectoryBlock = { id: root, data, offset: ROOT_OFFSET };
    const seen = new Set<number>();
    while (true) {
      if (seen.has(block.id)) throw new HnswPageDirectoryError('HNSW page directory contains a cycle.');
      seen.add(block.id);
      directory.addBlock(block);
      const next = block.data.readUInt32LE(block.offset + 4);
      if (next === 0) break;
      const raw = await file.readBlock(next);
      if (raw[0] !== 0x02) throw new HnswPageDirectoryError('HNSW page directory references a non-data block.');
      block = { id: next, data: raw.subarray(1), offset: 0 };
    }
    return directory;
  }

  private addBlock(block: DirectoryBlock): void {
    if (!block.data.subarray(block.offset, block.offset + 4).equals(MARKER))
      throw new HnswPageDirectoryError('Unsupported HNSW page directory metadata.');
    let count = 0;
    for (let offset = block.offset + HEADER_SIZE; offset + 4 <= block.data.length; offset += 4) {
      const page = block.data.readUInt32LE(offset);
      const location = { block, offset };
      if (page === 0) this.free.push(location);
      else {
        if (this.pages.has(page) || page === block.id)
          throw new HnswPageDirectoryError('Duplicate or invalid HNSW page ownership.');
        this.pages.set(page, location);
        count++;
      }
    }
    if (count !== block.data.readUInt16LE(block.offset + 8))
      throw new HnswPageDirectoryError('HNSW page directory count mismatch.');
    this.blocks.push(block);
  }

  get rootData(): Buffer {
    return this.blocks[0].data;
  }

  has(page: number): boolean {
    return this.pages.has(page);
  }

  pageIds(): IterableIterator<number> {
    return this.pages.keys();
  }

  metadataBlocks(): number[] {
    return this.blocks.map((block) => block.id);
  }

  async add(page: number): Promise<void> {
    if (this.pages.has(page)) throw new Error('HNSW graph page is already owned.');
    if (this.free.length === 0) {
      const id = await this.file.allocateBlock();
      const data = Buffer.alloc(this.file._getBlockSize() - 1);
      MARKER.copy(data);
      const previous = this.blocks[this.blocks.length - 1];
      previous.data.writeUInt32LE(id, previous.offset + 4);
      await this.file.writeBlock(previous.id, previous.data);
      this.addBlock({ id, data, offset: 0 });
    }
    const location = this.free.pop()!;
    location.block.data.writeUInt32LE(page, location.offset);
    const countOffset = location.block.offset + 8;
    location.block.data.writeUInt16LE(location.block.data.readUInt16LE(countOffset) + 1, countOffset);
    this.pages.set(page, location);
    await this.file.writeBlock(location.block.id, location.block.data);
  }

  async remove(page: number): Promise<void> {
    const location = this.pages.get(page);
    if (!location) throw new Error('HNSW graph page is not owned.');
    location.block.data.writeUInt32LE(0, location.offset);
    const countOffset = location.block.offset + 8;
    location.block.data.writeUInt16LE(location.block.data.readUInt16LE(countOffset) - 1, countOffset);
    this.pages.delete(page);
    this.free.push(location);
    await this.file.writeBlock(location.block.id, location.block.data);
  }

  async relocate(blockId: number, maxBlockExclusive?: number): Promise<number | null> {
    const index = this.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) throw new Error('HNSW metadata block is not owned.');
    const id =
      maxBlockExclusive === undefined
        ? await this.file.allocateBlock()
        : await this.file.allocateBlockBelow(maxBlockExclusive);
    if (id === null) return null;
    const block = this.blocks[index];
    await this.file.writeBlock(id, block.data);
    if (index > 0) {
      const previous = this.blocks[index - 1];
      previous.data.writeUInt32LE(id, previous.offset + 4);
      await this.file.writeBlock(previous.id, previous.data);
    }
    block.id = id;
    await this.file.freeBlock(blockId);
    return id;
  }

  async freeOverflow(): Promise<void> {
    for (const block of this.blocks.slice(1)) await this.file.freeBlock(block.id);
  }
}
