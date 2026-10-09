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

Existing databases migrate their field settings from persisted index roots and stored fields. Names and record, B+ tree, HNSW, WAL and block formats remain unchanged. Legacy semantic indexes are rebuilt once when the original embedding configuration is available; pending migration is exposed by `getPendingSemanticCollections()` and the database status API, and semantic search reports it explicitly. Normal reopen and B+ tree toggles do not rebuild current semantic indexes. Full vacuum copies the settings before rebuilding records, and incremental compaction repairs references only for existing indexes.

Semantic deletion retains graph nodes, vectors and their record-pointer anchors as tombstones, without rebuilding the collection graph. Incremental compaction moves retained graph/vector units; full vacuum copies live logical documents and reclaims tombstones and retained dead records. Offline semantic mutations remain pending until reopening with a working embedding configuration.

Validation and embedding failures are checked before document replacement writes. The backend does not provide per-operation rollback for storage or index failures after writes begin: discard that session and reopen without committing the failed mutation to recover the last committed database.

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

Semantic search is optional. If you create or reopen a database with HNSW enabled, you must pass the same `HnswConfig` shape and vector dimension each time. The HNSW configuration is not persisted inside the database file.

## Related docs

- `licences.md`
- `src/query/README.md`
- `benchmarks/hnsw/README.md`
- `benchmarks/incremental-compaction/README.txt`
- `benchmarks/large-dataset/README.txt`
