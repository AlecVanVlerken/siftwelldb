# SimpleDBMS

SimpleDBMS is a private Node.js and TypeScript database project for the P&O CW 2025-2026 coursework. It combines a WAL-backed storage engine, document-oriented CRUD operations, B+ tree indexes, optional HNSW-based semantic search, compaction tooling, a browser UI, a query-language CLI, and conversational analytics.

## Highlights

- WAL-backed durability and recovery primitives under `src/atomic/`
- Fixed-size block storage and record management under `src/freeblockfile/`
- B+ tree indexing under `src/btree/`
- Optional semantic search with a Rust-backed HNSW core under `src/hnsw/` and `hnsw-native/`
- Compression advice and field-compression support under `src/dbms/`
- Incremental compaction and full vacuum support under `src/compaction/`
- Browser-based management UI under `src/webclient/`
- SQL-like query language CLI under `src/dbms/querylanguage/`
- Gemini-backed conversational analytics under `src/conversational/`
- Benchmark, demo, and visualization suites under `src/benchmarking/`, `src/demo/`, and `src/visualization/`

## Repository layout

- `src/core/` - real and mock file abstractions shared across the storage stack
- `src/atomic/` - WAL records, writer, and atomic file layer
- `src/freeblockfile/` - fixed-size block allocator and storage primitives
- `src/btree/` - B+ tree implementation and tests
- `src/hnsw/` - TypeScript HNSW integration and native bridge
- `hnsw-native/` - Rust implementation used by the native HNSW backend
- `src/dbms/` - high-level `SimpleDbms` API, query language, compression, and record logic
- `src/compaction/` - incremental compaction and full-vacuum code
- `src/largedatasets/` - bulk import, inverted/word/content indexes, pagination, and the Wikipedia loader
- `src/webclient/` - HTTP daemon, API router, service layer, and frontend
- `src/conversational/` - semantic models, query generation, LLM provider, and chat engine
- `src/demo/` - semantic text and image search demos
- `src/types/` - local ambient type declarations for third-party modules
- `src/visualization/` - semantic map demo and HTML renderer
- `src/benchmarking/` - performance suites and plotting scripts
- `build/` - generated JavaScript output from TypeScript compilation

## Requirements

- Node.js 24.x. CI uses `node:24`.
- npm
- Python 3 if you want to run the plotting scripts under `src/benchmarking/`
- Rust only if you want to rebuild the native HNSW library in `hnsw-native/`
- `GEMINI_API_KEY` in `.env` if you want conversational analytics

The repository currently includes prebuilt native HNSW binaries for Windows and Linux at `src/hnsw/hnsw_native.dll` and `src/hnsw/libhnsw_native.so`. Rust is only needed when you want to rebuild those artifacts.

## Setup

```bash
npm ci
npm run build
npm run lint
npm test
```

Notes:

- `npm run lint` checks the `src/` tree with ESLint.
- `npm test` runs the `src/` test suite and excludes `src/benchmarking/**`.
- `npm run coverage` collects coverage for the non-benchmark source tree.
- `npm run build` compiles both the main TypeScript project and the webclient frontend assets.

If a third-party package needs a local typing shim for this codebase, those declarations live in `src/types/`. The current repo includes `src/types/google-genai.d.ts` for `@google/genai`.

## Running the web client

The browser UI is served by `src/webclient/daemon.mts` on port 8000.

```bash
npm run build
npx tsx src/webclient/daemon.mts
```

Then open `http://localhost:8000`.

The daemon:

- serves the frontend from `src/webclient/frontend/` and `build/webclient/frontend/`
- exposes JSON APIs under `/api/`
- opens or creates a database file you choose in the UI
- stores WAL data in a sibling file with the `.log` suffix
- can persist `GEMINI_API_KEY` into `.env` through the settings UI

## Query language CLI

The SQL-like query engine has a CLI entry point:

```bash
npm run cli -- "SELECT * FROM cities"
npm run cli -- --data my.db --log my.db.log "SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC"
```

Supported operations include `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `EXPLAIN`. Full grammar, operator reference, type semantics, and worked examples live in `src/dbms/querylanguage/README.md`.

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
- `npm run demo:images` - image semantic search demo; downloads sample animal images from Wikipedia into `demo-db/images/`
- `npm run demo:map` - generates a standalone `map.html` semantic map

The demos store their data under `demo-db/`.

## Benchmarks

The repository includes multiple benchmark suites under `src/benchmarking/`, including general DBMS performance, HNSW performance and recall, incremental compaction, and large-dataset loaders and workloads.

Useful commands:

- `npm run benchmark:compression`
- `npm run benchmark:incremental`
- `npm run profile`

Benchmark-specific documentation lives in:

- `src/benchmarking/hnsw/README.md`
- `src/benchmarking/incremental-compaction/README.txt`
- `src/benchmarking/large-dataset/README.txt`

Many benchmark plotting scripts are Python programs. Install their Python dependencies separately before running them.

## Main entry points

- `src/dbms/simpledbms.mts` - primary high-level library API
- `src/webclient/daemon.mts` - browser UI and HTTP API
- `src/dbms/querylanguage/cli.mts` - query language CLI
- `src/conversational/cli.mts` - conversational analytics CLI

## HNSW note

Semantic search is optional. If you create or reopen a database with HNSW enabled, you must pass the same `HnswConfig` shape and vector dimension each time. The HNSW configuration is not persisted inside the database file.

## Related docs

- `licences.md`
- `src/dbms/querylanguage/README.md`
- `src/benchmarking/hnsw/README.md`
- `src/benchmarking/incremental-compaction/README.txt`
- `src/benchmarking/large-dataset/README.txt`
