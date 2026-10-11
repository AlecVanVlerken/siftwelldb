# FreeBlockFile

Minimal client documentation for the FreeBlockFile abstraction used in the Simple DBMS project.

## Block Layout

The file is divided into fixed-size blocks. Each block starts with a one-byte block type indicating its role: `Free` for unused blocks, `Header` for the metadata block, and `Data` for blocks containing user or index data.

Block 0 is always the header block. It stores the global metadata of the file in the following order: the block type at byte 0, the first free block pointer at bytes 1–4 (uint32, little-endian), the root block pointer at bytes 5–8 (uint32, little-endian) and the client metadata area from byte 9 to the end of the block. These bytes are reserved for future extensions and client-specific metadata.

Free blocks contain the block type `Free` at byte 0, followed by a pointer to the next free block at bytes 1–4. The remaining bytes of the block are unused.

## Usage Lifecycle

A FreeBlockFile instance must always be used according to the following sequence: `create()` (only once for a new file), `open()`, normal operations such as block allocation, reading, writing and freeing, followed by `commit()` to persist the changes and finally `close()`.

All write operations are buffered in memory and only become durable after calling `commit()`.

### Example

```ts
const fbf = new FreeBlockFile(file, 512);

await fbf.create();
await fbf.open();

const block = await fbf.allocateBlock();
await fbf.writeBlock(block, Buffer.from('hello'));

await fbf.commit();
await fbf.close();
```

## Public API Overview

The main operations offered by FreeBlockFile can be grouped as follows:

- file management: create, open, close, commit.

- data management: allocateBlock, freeBlock, readBlock, writeBlock.

- header access: getRootBlock, setRootBlock, getClientArea, writeClientArea.

Block 0 (the header) cannot be accessed directly through readBlock or writeBlock and must always be accessed via the dedicated header methods.

## Free-List Model

Unused blocks are managed using a linked free-list stored inside the file. The head of the list is stored in the header block. When allocating a block, the system first attempts to reuse a free block from this list. Only if the free-list is empty is a new block appended at the end of the file. When a block is freed, it is prepended to the free-list.

## Crash Safety

FreeBlockFile commits its dirty blocks through the existing redo WAL:
write and sync the complete WAL, apply every data write, sync the data file,
then truncate and sync the WAL. RealFile fills required read buffers and
completes scatter/gather writes, retrying partial transfers and rejecting
unexpected EOF, zero progress, and I/O failures.

A failed commit or recovery blocks further storage reads and mutations in that session.
Close and reopen the database to retry recovery with fresh block/index caches.
AtomicFile also supports explicit recovery when used directly. Valid WAL entries
are replayed idempotently; failed replay or data synchronization preserves the
WAL. Malformed or incomplete WAL files remain intact and opening fails explicitly.
No automatic corruption repair is attempted.

A rejected commit can still be applied by later redo recovery. If WAL truncation
succeeds but its sync fails, data has already been synchronized; the session
still rejects the commit until recovery completes cleanup. These guarantees
depend on the filesystem honoring file synchronization. They do not provide
rollback for arbitrary failures during staged B+ tree/document mutations.

## Authors

- Alec Van Vlerken
- Arthur Cukier
