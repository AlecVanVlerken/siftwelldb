import assert from 'node:assert/strict';
import { type File } from './mockfile.mjs';

export class Database {
  private constructor(
    private file: File,
    private recordsCount: number,
    private recordsListPosition: number,
  ) {}
  static async create(file: File) {
    await file.create();
    const sector0Data = Buffer.alloc(8);
    await file.writev([sector0Data], 0);
    return new Database(file, 0, 0);
  }
  static async open(file: File) {
    await file.open();
    const sector0Data = Buffer.allocUnsafe(8);
    await file.read(sector0Data, { position: 0 });
    const recordsCount = sector0Data.readUInt32LE(0);
    const recordsListPosition = sector0Data.readUInt32LE(4);
    return new Database(file, recordsCount, recordsListPosition);
  }
  async commit() {
    await this.file.sync();
    const sector0Data = Buffer.alloc(8);
    sector0Data.writeUint32LE(this.recordsCount, 0);
    sector0Data.writeUint32LE(this.recordsListPosition, 4);
    await this.file.writev([sector0Data], 0);
    await this.file.sync();
  }
  async close() {
    await this.file.close();
  }
  private async append(data: Buffer): Promise<number> {
    const size = (await this.file.stat()).size;
    await this.file.writev([data], size);
    return size;
  }
  private async getRecordsList() {
    const listBuffer = Buffer.allocUnsafe(this.recordsCount * 8);
    await this.file.read(listBuffer, { position: this.recordsListPosition });
    return listBuffer;
  }
  async getRecords() {
    const listBuffer = await this.getRecordsList();
    const result: unknown[] = [];
    for (let i = 0; i < this.recordsCount; i++) {
      const recordSize = listBuffer.readUint32LE(i * 8);
      const recordPosition = listBuffer.readUint32LE(i * 8 + 4);
      const recordBuffer = Buffer.allocUnsafe(recordSize);
      await this.file.read(recordBuffer, { position: recordPosition });
      const recordString = recordBuffer.toString();
      result.push(JSON.parse(recordString));
    }
    return result;
  }
  async insertRecord(index: number, record: unknown) {
    assert(0 <= index && index <= this.recordsCount);
    const encodedRecord = Buffer.from(JSON.stringify(record));
    const recordPosition = await this.append(encodedRecord);
    const oldListBuffer = await this.getRecordsList();
    const newListBuffer = Buffer.allocUnsafe(oldListBuffer.length + 8);
    oldListBuffer.copy(newListBuffer, 0, 0, index * 8);
    newListBuffer.writeUint32LE(encodedRecord.length, index * 8);
    newListBuffer.writeUInt32LE(recordPosition, index * 8 + 4);
    oldListBuffer.copy(newListBuffer, index * 8 + 8, index * 8, this.recordsCount * 8);
    const newRecordsListPosition = await this.append(newListBuffer);
    this.recordsCount++;
    this.recordsListPosition = newRecordsListPosition;
  }
  async deleteRecord(index: number) {
    assert(0 <= index && index < this.recordsCount);
    const oldRecordsList = await this.getRecordsList();
    const newRecordsList = Buffer.allocUnsafe(oldRecordsList.length - 8);
    oldRecordsList.copy(newRecordsList, 0, 0, index * 8);
    oldRecordsList.copy(newRecordsList, index * 8, index * 8 + 8, this.recordsCount * 8);
    const newRecordsListPosition = await this.append(newRecordsList);
    this.recordsCount--;
    this.recordsListPosition = newRecordsListPosition;
  }
}
