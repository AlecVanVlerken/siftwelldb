import { type File } from '../core/file.mjs';
import { type Document } from './document.mjs';

export type SerializedDatabase = {
  version: number;
  collections: Record<string, Document[]>;
};

type AtomicCapableFile = File & {
  atomicWrite?: (updates: Map<number, Buffer>) => Promise<boolean>;
};

export const CURRENT_VERSION = 1;

export class DbmsBackend {
  private readonly file: AtomicCapableFile;
  private isOpen = false;

  constructor(file: File) {
    this.file = file as AtomicCapableFile;
  }

  async create(initialState?: SerializedDatabase) {
    await this.file.create();
    this.isOpen = true;
    const state = initialState ?? { version: CURRENT_VERSION, collections: {} };
    await this.persist(state);
  }

  async open(): Promise<SerializedDatabase> {
    if (!this.isOpen) {
      await this.file.open();
      this.isOpen = true;
    }
    return await this.readState();
  }

  async persist(state: SerializedDatabase): Promise<void> {
    if (!this.isOpen) {
      await this.file.open();
      this.isOpen = true;
    }

    const payload = Buffer.from(JSON.stringify(state), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const buffer = Buffer.concat([header, payload]);

    if (typeof this.file.atomicWrite === 'function') {
      const ok = await this.file.atomicWrite(new Map([[0, buffer]]));
      if (!ok) throw new Error('Atomic commit failed');
    } else {
      await this.file.truncate(0);
      await this.file.writev([buffer], 0);
      await this.file.sync();
    }
    await this.file.truncate(buffer.length);
    await this.file.sync();
  }

  async close() {
    if (!this.isOpen) return;
    await this.file.close();
    this.isOpen = false;
  }

  private async readState(): Promise<SerializedDatabase> {
    const { size } = await this.file.stat();
    if (size === 0) return { version: CURRENT_VERSION, collections: {} };

    const header = Buffer.alloc(4);
    await this.file.read(header, { position: 0 });
    const payloadLength = header.readUInt32LE(0);
    const usableLength = Math.max(0, Math.min(payloadLength, size - 4));
    if (usableLength === 0) return { version: CURRENT_VERSION, collections: {} };

    const payload = Buffer.alloc(usableLength);
    await this.file.read(payload, { position: 4 });
    const parsed = JSON.parse(payload.toString('utf8')) as SerializedDatabase;
    return {
      version: parsed.version ?? CURRENT_VERSION,
      collections: parsed.collections ?? {},
    };
  }
}
