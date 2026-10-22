# FreeBlockFile

`FreeBlockFile` manages fixed-size blocks and reuses space released by records and indexes. It keeps the block header
and free-list in the database file and sends commits through `AtomicFile` and its write-ahead log.

## Block Layout

The file is divided into fixed-size blocks. Each block starts with a one-byte block type indicating its role: `Free` for
unused blocks, `Header` for the metadata block and `Data` for blocks containing user or index data.

Block 0 is always the header block. It stores the global metadata of the file in the following order: the block type at
byte 0, the first free block pointer at bytes 1–4 (uint32, little-endian), the root block pointer at bytes 5–8 (uint32,
little-endian) and the client metadata area from byte 9 to the end of the block. These bytes are reserved for future
extensions and client-specific metadata.

Free blocks contain the block type `Free` at byte 0, followed by a pointer to the next free block at bytes 1–4. The
remaining bytes of the block are unused.

## Usage Lifecycle

The constructor takes an `AtomicFile` and a block size. Call `create()` to initialize a new file, then `open()` to load
its header. For an existing file, start with `open()`. Allocation, writes and frees are staged until `commit()`;
`close()` releases the file without committing pending changes.

`writeBlock()` accepts up to `blockSize - 1` payload bytes because the first byte stores the block type. `readBlock()`
returns the full block, including that byte.

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

The main operations are:

- file management: create, open, close, commit.

- data management: allocateBlock, freeBlock, readBlock, writeBlock.

- header access: getRootBlock, setRootBlock, getClientArea, writeClientArea.

Block 0 (the header) cannot be accessed directly through readBlock or writeBlock and must always be accessed via the
dedicated header methods.

## Free-List Model

Unused blocks are managed using a linked free-list stored inside the file. The head of the list is stored in the header
block. When allocating a block, the system first attempts to reuse a free block from this list. Only if the free-list is
empty is a new block appended at the end of the file. When a block is freed, it is prepended to the free-list.

## Crash Safety

FreeBlockFile commits its dirty blocks through a redo WAL: write and sync the complete WAL, apply every data write, sync
the data file, then truncate and sync the WAL. RealFile fills required read buffers and completes scatter/gather writes,
retrying partial transfers and rejecting unexpected EOF, zero progress and I/O failures.

A failed commit or recovery blocks further storage reads and mutations in that session. Close and reopen the database to
retry recovery with fresh block/index caches. AtomicFile also supports explicit recovery when used directly. Valid WAL
entries are replayed idempotently; failed replay or data synchronization preserves the WAL. Malformed or incomplete WAL
files remain intact and opening fails explicitly. No automatic corruption repair is attempted.

A rejected commit can still be applied by later redo recovery. If WAL truncation succeeds but its sync fails, data has
already been synchronized; the session still rejects the commit until recovery completes cleanup. These guarantees
depend on the filesystem honoring file synchronization. They do not provide rollback for arbitrary failures during
staged B+ tree/document mutations.

Structural B+ tree failures and partially failed database mutations also mark the shared FreeBlockFile unsafe. Its
health check blocks cached reads, writes and commits before precommit hooks run, so removing an index cache cannot make
an incomplete mutation committable. This logical failure state is never cleared in place: close without committing and
use fresh block/index caches on reopen. Staged changes are discarded; any WAL already submitted by a failed commit
remains governed by redo recovery above.

## Authors

- Alec Van Vlerken
- Arthur Cukier
