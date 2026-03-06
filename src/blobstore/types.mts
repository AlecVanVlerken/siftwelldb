export interface BlobRef {
  kind: 'blob';
  blobId: number;
  sizeBytes: number;
  mimeType?: string;
  createdAtMs?: number;
  checksum?: string;
}

export interface BlobInfo {
  sizeBytes: number;
  mimeType?: string;
}

export class BlobNotFound extends Error {
  constructor(blobId: number) {
    super(`Blob ${blobId.toString()} not found`);
    this.name = 'BlobNotFound';
  }
}

export class InvalidRange extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRange';
  }
}

export class CorruptBlobChain extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptBlobChain';
  }
}