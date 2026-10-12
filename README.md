# SiftwellDB

SiftwellDB is a private Node.js and TypeScript database project originating from the P&O CW 2025-2026 coursework. It combines a WAL-backed storage engine, document-oriented CRUD operations, B+ tree indexes, optional HNSW-based semantic search, compaction tooling, a browser UI, a query-language CLI, and conversational analytics.

## Highlights

- WAL-backed durability and recovery primitives under `src/storage/wal/`
- Fixed-size block storage and record management under `src/storage/`
- B+ tree indexing under `src/indexes/btree/`
- Optional semantic search with a Rust-backed HNSW core under `src/indexes/hnsw/` and `hnsw-native/`
- Compression advice and field-compression support under `src/database/`
- Incremental compaction and full vacuum support under `src/compaction/`
- Browser-based management UI under `src/webclient/`
- SQL-like query language CLI under `src/query/`
- Gemini-backed conversational analytics under `src/conversational/`
- Performance benchmarks under `benchmarks/` and runnable demos under `examples/`

## Repository layout

- `src/storage/` - file abstraction, WAL/atomic writes, free blocks, and record storage
- `src/indexes/` - B+ trees, persisted/native HNSW, and word/content indexes
- `src/database/` - high-level SimpleDbms API, documents, compression, bulk import, and pagination
- `src/query/` - SQL-like parser, planner, executor, and CLI
- `src/compaction/` - public compaction entry point, with vacuum, incremental, and relocation modules; see the [compaction layout](src/compaction/README.md)
- `src/webclient/server/` - HTTP daemon, router, services, and embedding configuration
- `src/webclient/frontend/` - maintained HTML/CSS and browser TypeScript modules
- `src/webclient/fixtures/` - sample data used by existing webclient seeding APIs
- `src/conversational/` - semantic models, query generation, LLM provider, and chat engine
- `src/types/` - local ambient declarations for third-party modules
- `examples/` - text/image search demos, semantic map, and an independent teaching reference store
- `examples/assets/` - maintained demo images, also used by image regression tests
- `benchmarks/` - performance suites and plotting scripts
- `scripts/` - import/index/seed commands and build helpers
- `tests/` - shared helpers and subprocess fixtures; implementation tests live in a `tests/` subfolder of each module
- `hnsw-native/` - Rust source and maintained prebuilt libraries
- `build/` - generated runtime JavaScript, browser assets, and native libraries

## Requirements

- Node.js 24.x. CI uses `node:24`.
- npm
- Python 3 if you want to run the plotting scripts under `benchmarks/`
- Rust only if you want to rebuild the native HNSW library in `hnsw-native/`
- `GEMINI_API_KEY` in `.env` if you want conversational analytics

The repository includes prebuilt native HNSW binaries for Windows and Linux under `hnsw-native/prebuilt/`. Rust is only needed to rebuild them; see [native build instructions](hnsw-native/README.md).

## Setup

```bash
npm ci
npm run build
npm run lint
npm test
```

Notes:

- `npm run lint` checks runtime code, tests, examples, benchmarks, and scripts.
- `npm test` runs the modules' regression tests and the reference-store tests; benchmarks are opt-in.
- `npm run coverage` collects coverage for the non-benchmark source tree.
- `npm run build` checks all maintained TypeScript, rebuilds runtime/browser code, and copies HTML/CSS and native libraries.
- `npm run clean` removes generated build output. Databases and example images are kept.

If a third-party package needs a local typing shim for this codebase, those declarations live in `src/types/`. The current repo includes `src/types/google-genai.d.ts` for `@google/genai`.

## Running the web client

The browser UI is served by `src/webclient/server/daemon.mts` on port 8000.

```bash
npm run build
npm start
```

Then open `http://localhost:8000`.

For source development, use `npm run start:dev` after building the browser assets.
Create a populated database with `npm run seed:test`; see the [webclient guide](src/webclient/README.md).

The daemon:

- serves the frontend from `src/webclient/frontend/` and `build/webclient/frontend/`
- exposes JSON APIs under `/api/`
- opens or creates a database file you choose in the UI
- stores WAL data in a sibling file with the `.log` suffix
- can persist `GEMINI_API_KEY` into `.env` through the settings UI

## Field indexing

Collection fields have a persisted `Indexed` setting. Ordinary string, number and boolean fields default to indexed, regardless of their names; image and binary fields are excluded. The primary `id` index is mandatory. Configure long text before inserting it:

```typescript
await db.setFieldIndexed('articles', 'body', false);
await db.insertDocumentObject('articles', { id: '1', title: 'Databases', body: longArticle });
const settings = db.getFieldIndexConfig('articles');
await db.setFieldIndexed('articles', 'title', false);
```

Enabling an index validates and backfills existing documents. Disabling it frees the secondary tree while preserving documents; equality queries use the existing scan fallback. Call `commit()` to persist API changes. Indexed keys have a 2035-byte encoded limit with the default 4096-byte blocks, including field, ID and serialization overhead. Compression does not reduce index key size. Unindexed text stays in RecordStore and has no B+ tree key limit.

With an embedding configuration, HNSW automatically uses eligible textual fields independently of these settings, including underscore-prefixed text. Images retain their separate encoder. Model input limits still apply. In the webclient, use the **Indexed** checkboxes in Fields or the document editor; changes apply to the collection and wait for backend completion.

Existing databases migrate their field settings from persisted index roots and stored fields. Record, B+ tree, WAL and block formats remain unchanged. Semantic indexes with verified persisted dimensions can finish a pending field migration when the original working embedding configuration is available; pending migration is exposed by `getPendingSemanticCollections()` and the database status API. Graphs without dimension evidence stay disabled rather than guessing. Normal reopen and B+ tree toggles do not rebuild current semantic indexes. Full vacuum copies the settings before rebuilding records, and incremental compaction repairs references only for existing indexes.

Semantic deletion retains graph nodes, vectors and their record-pointer anchors as tombstones, without rebuilding the collection graph. Incremental compaction moves retained graph/vector units; full vacuum copies live logical documents and reclaims tombstones and retained dead records. Offline semantic mutations remain pending until reopening with a working embedding configuration.

Document mutations validate supported values, finite numbers, index keys, compression and embeddings before writing. Single-field edits preserve the stored codecs of untouched fields, including explicit uncompressed choices and binary fields, using the same preservation path as SQL UPDATE and preserving replacements.

If a record, index or semantic mutation fails after changes may have begun, the session rejects subsequent reads, writes and commits, including direct block-file commits. `db.isHealthy` and `db.assertHealthy()` expose this state. Close without committing, then open a fresh database instance; logical staged changes, including earlier uncommitted successful operations, are discarded. Validation failures and completely discarded unpublished index builds remain usable. Bulk import continues after safe document rejections, but stops on an unsafe failure and throws `BulkImportError` with completed insertion and acknowledged-commit counts. The webclient closes unsafe sessions, stops maintenance and retains the database path for explicit reconnect.

This protection is not per-operation rollback or SQL statement atomicity. A failure during WAL commit still follows storage recovery: a complete submitted write set can be applied on reopen even when its commit was not acknowledged. Already acknowledged commits are retained.

## Identifier consistency

Collection and field names are exact, case-sensitive strings. Names such as `__proto__`, `constructor`, `toString`, punctuation, empty strings and distinct Unicode spellings are safe metadata keys. Only the existing collection names `__hnsw__`, `__compression__` and `__indexing__` are reserved for database metadata. User-keyed dictionaries have no inherited properties, and B+ tree caches encode the collection and field as a JSON tuple, so delimiters in names cannot cause collisions.

Document IDs are finite numbers or well-formed Unicode strings, including empty strings and valid surrogate pairs. Each collection retains the primary ID type established by its first document; lookups and writes reject the other type instead of coercing it. String IDs retain their existing UTF-8 key encoding, case sensitivity and Unicode spelling. Unpaired UTF-16 surrogates are rejected before mutations and on ID lookup. Legacy malformed IDs are not renamed or silently re-keyed: document operations and vacuum report an explicit validation error when encountering such a record, leaving the source data available for recovery.

Semantic metadata now stores a versioned map keyed by `[collection, "default" | "text" | "image"]` JSON tuples. Deletion, reindexing, tombstones, relocation and vacuum use exact collection ownership. Legacy flat names with no semantic suffix migrate directly. For `collection::text` or `collection::image`, live graph records with matching primary references must establish the exact owner; empty, tombstoned-only or unverified graphs refuse opening with a compatibility error and retain the stored data. Relocation targets carry a logical collection and optional `indexKind`; graph inspection takes the same optional kind instead of interpreting suffixes in collection names.

The webclient uses JSON-typed query addresses so IDs and collection names are never altered by URL path normalization. See the [HTTP addressing contract](src/webclient/README.md#exact-document-addresses).

## Cursor pagination

`fetchPageCursor(db, { collection, iterableKey, limit, afterCursor? })` returns index-ordered JSON documents, `hasMore` and an opaque `nextCursor` string. Pass that string unchanged to resume. A version 1 token carries the exact collection, field, persisted key form and complete B+ tree key bytes, including the document ID component of secondary keys. Resumption seeks strictly after that logical key using the existing index comparator. Duplicate field values advance by their ID tie-breaker, and deleting the last emitted entry does not skip its surviving successor. Seeking costs O(log N), followed by reading the page and one lookahead entry; API total counts can require a separate initial scan.

Tokens remain usable after commit/reopen, record or index relocation and full vacuum when the logical collection/index key form is retained. Malformed tokens, wrong collection/field bindings, incomplete composite keys and changed or removed index forms produce explicit cursor errors. Legacy bare field-value tokens are unsupported because they cannot identify a unique secondary position; restart from the first page.

Pagination is not a snapshot. Inserts at keys after the saved position can appear on subsequent pages; inserts before it are not revisited. Updating an indexed value across that position can omit or repeat that document. A deleted entry continues from its old key's next surviving successor. For an unchanged dataset, concatenated pages exactly match full traversal of the same index. Ordinary inclusive `cursor()` seeks, SQL `LIMIT`/`OFFSET`, and the webclient's offset-based grid browsing retain their existing behavior.

## Query language CLI

The SQL-like query engine has a CLI entry point:

```bash
npm run cli -- "SELECT * FROM cities"
npm run cli -- --data my.db --log my.db.log "SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC"
```

Supported operations include `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `EXPLAIN`. Full grammar, operator reference, type semantics, and worked examples live in `src/query/README.md`.

## Conversational analytics

Conversational analytics is implemented under `src/conversational/` and can be used from the webclient or from the CLI.

```bash
npx tsx src/conversational/cli.mts --data my.db --model model.json
```

Requirements:

- a database data file
- a semantic model JSON file
- `GEMINI_API_KEY` in `.env` or passed with `--api-key`

The example environment file is `.env.example`.

## Demos

Available demo scripts:

- `npm run demo` - text semantic search demo
- `npm run demo:images` - image semantic search demo; uses maintained animal photos in `examples/assets/images/` and downloads missing samples
- `npm run demo:map` - generates a standalone `map.html` semantic map

The demos store generated databases under the ignored `demo-db/` directory. The map output, `map.html`, is also ignored. The teaching reference store is separate from the runtime DBMS; run its checks with `npm run test:reference`.

Import utilities are available as `npm run import:wikipedia`, `npm run seed:articles`, and `npm run index:content`; pass arguments after `--`.

## Benchmarks

The repository includes multiple benchmark suites under `benchmarks/`, including general DBMS performance, HNSW performance and recall, incremental compaction, and large-dataset loaders and workloads.

Useful commands:

- `npm run benchmark:compression`
- `npm run benchmark:pagination -- articles.db --total 100000`
- `npm run benchmark:btree`
- `npm run benchmark:dbms`
- `npm run benchmark:hnsw`
- `npm run benchmark:vacuum`
- `npm run benchmark:incremental`

Benchmark-specific documentation lives in:

- `benchmarks/README.md` - suite inventory, small-run examples, and cleanup decisions
- `benchmarks/hnsw/README.md`
- `benchmarks/incremental-compaction/README.txt`
- `benchmarks/large-dataset/README.txt`

Many benchmark plotting scripts are Python programs. Install their Python dependencies separately before running them.

## Main entry points

- `src/database/simpledbms.mts` - primary high-level library API
- `src/webclient/server/daemon.mts` - browser UI and HTTP API
- `src/query/cli.mts` - query language CLI
- `src/conversational/cli.mts` - conversational analytics CLI

## HNSW note

Semantic search is optional. Each graph persists its vector dimension, and new vector pages carry their own dimension tag. Opening checks the graph before native allocation or vector decoding; incompatible dimensions disable semantic operations for that session while ordinary document access remains available. Matching dimensions do not prove that two embedding models share a vector space: keep the original model and `HnswConfig` shape.

Legacy graphs without stored dimension evidence remain intact and disabled. Their dimension cannot safely be inferred from the current configuration, vector bytes, or an empty/tombstoned graph. Recovery requires an explicitly verified source or exporting readable documents into a fresh database with the intended configuration. Graph metadata and vector-page extensions require the updated reader for semantic operations; document records, B+ trees and WAL retain their existing formats. See [HNSW dimension compatibility](src/indexes/hnsw/README.md).

## Related docs

- `licences.md`
- `src/query/README.md`
- `benchmarks/hnsw/README.md`
- `benchmarks/incremental-compaction/README.txt`
- `benchmarks/large-dataset/README.txt`
