# HNSW and hnsw-native: In-Depth Structure and Working Overview

This document explains, in concrete terms:
- how `hnsw-native/` is structured
- how `src/hnsw/` is structured
- which files are active in the current runtime path
- how insert/search/delete/open move through both layers
- why certain APIs exist (for example dirty-node and import APIs)

The goal is to support detailed MR review, not just a high-level summary.

---

## 1) Mental Model First: What Is Split, and Why

This implementation intentionally splits HNSW into two concerns:

- **Native compute (`hnsw-native/`)**  
  Rust owns in-memory graph algorithms and fast query-time traversal.

- **Persistence/integration (`src/hnsw/`)**  
  TypeScript owns durable storage layout, FreeBlockFile/WAL integration, and DBMS orchestration.

If you keep one rule in mind, the file roles become easier to follow:

> Rust decides graph topology in memory; TypeScript serializes that topology and vectors to disk.

That is why there are APIs like `takeDirtyNodes()` and `getAllNeighbors()` in the native layer: TS needs to know exactly what changed so it can persist only those changes.

---

## 2) Terminology (Used Precisely in This Codebase)

- **docId**: logical document ID used by HNSW and returned by search. In this project it corresponds to RecordStore block IDs for inserted documents.
- **node index (Rust internal)**: position in Rust `nodes` array. Not persisted directly.
- **NodeId (TS persisted identifier)**: encoded `(pageId, slotId)` location in `HNSWGraphStorage`.
- **entry point**: current top-level starting node for HNSW traversal.
- **max level**: highest graph layer currently present.
- **dirty node**: a node whose adjacency list changed due to insert/delete and must be rewritten to persistent graph storage.

Important mapping:
- Rust mostly speaks in **docId**
- `HNSWGraphStorage` persistence speaks in **NodeId**
- `HNSWIndex` translates between the two.

---

## 3) `hnsw-native/` Structure and Responsibilities

```text
hnsw-native/
  .cargo/
    config.toml
  Cargo.toml
  Cargo.lock
  package.json
  src/
    lib.rs
    hnsw.rs
    distance.rs
  target/   (generated build artifacts)
```

### 3.1 `hnsw-native/src/lib.rs` (FFI boundary)

**Primary role:** expose Rust functionality as a plain C ABI callable from Node via `koffi`.

It contains:
- `HnswHandle` wrapper around `HnswCore`
- constructor/destructor:
  - `hnsw_create`
  - `hnsw_destroy`
- operational API:
  - `hnsw_insert`
  - `hnsw_search`
  - `hnsw_delete`
  - `hnsw_size`
  - `hnsw_set_ef_search`
- persistence-sync API:
  - `hnsw_take_dirty_nodes`
  - `hnsw_get_level`
  - `hnsw_get_neighbor_count`
  - `hnsw_get_neighbors`
  - `hnsw_get_all_neighbors`
  - `hnsw_get_entry_doc_id`
  - `hnsw_get_max_level`
- bulk-import API:
  - `hnsw_import_node`
  - `hnsw_import_set_neighbors`
  - `hnsw_import_finish`

### Why this layer exists

`hnsw.rs` is pure Rust logic. `lib.rs` translates that logic into stable C-callable functions with raw pointers and fixed signatures, which `koffi` can bind.

---

### 3.2 `hnsw-native/src/hnsw.rs` (algorithm core)

**Primary role:** implement the in-memory HNSW graph and algorithms.

`HnswCore` stores:
- graph parameters (`m`, `m0`, `ef_construction`, `ef_search`)
- vector store (`Vec<f32>`, flattened by node index)
- node table (per-node level, deleted flag, per-layer neighbor lists)
- `doc_to_node` map (docId -> internal node index)
- entry point + max level
- `dirty_doc_ids` buffer

Key operations:
- **insert**
  - assign random level
  - greedy descent from high layers
  - beam search per layer
  - heuristic neighbor selection
  - backlink creation/pruning
  - mark touched docIds as dirty
- **search**
  - greedy descent from top to layer 1
  - beam search on layer 0 with `ef = max(efSearch, k)`
  - filter deleted nodes
  - return closest docIds
- **delete**
  - remove backlinks from neighbors
  - mark node deleted
  - remove from `doc_to_node`
  - adjust entry point/max level if needed
  - record affected neighbors as dirty
- **import**
  - reconstruct in-memory graph from already persisted nodes/vectors

### Why dirty tracking is built in

A single insert or delete can modify many neighbor lists besides the directly inserted/deleted node.  
Rust tracks these touched docIds so TS can persist only those nodes instead of rescanning/rewriting all nodes.

---

### 3.3 `hnsw-native/src/distance.rs`

**Primary role:** low-level distance primitive.

- Implements squared L2 over two same-length slices.
- Kept as tight loop for compiler autovectorization opportunities.

---

### 3.4 `hnsw-native/Cargo.toml`

**Primary role:** crate identity + build profile.

Important points:
- `crate-type = ["cdylib"]` means output is shared library for FFI loading.
- dependencies are small and targeted (`fastrand`, `rustc-hash`).
- release profile is throughput-oriented (`opt-level=3`, LTO, etc.).

---

### 3.5 `hnsw-native/.cargo/config.toml`

**Primary role:** local Cargo target/toolchain defaults.

Current config is Windows-target-centric (`x86_64-pc-windows-gnu`) and includes explicit linker/ar paths, which is relevant when reviewing portability and CI reproducibility.

---

### 3.6 `hnsw-native/package.json`

**Primary role:** metadata for native module directory.

There is `napi` metadata present, but the active runtime path in this branch uses `koffi` + C ABI exports from `lib.rs`.

---

### 3.7 `hnsw-native/target/`

**Primary role:** generated build output and metadata.

Contains compiled artifacts, dependency fingerprints, and per-target intermediates.

---

## 4) `src/hnsw/` Structure and Responsibilities

```text
src/hnsw/
  hnswNative.mts
  hnswIndex.mts
  hnswGraphStorage.mts
  vectorHeapFile.mts
  vectorSerializer.mts
  hnswNode.mts
  hnswSearch.mts      (legacy TS algorithm path)
  hnswInsert.mts      (legacy TS algorithm path)
  hnswDelete.mts      (legacy TS algorithm path)
  hnsw.spec.mts
  hnsw_native.dll
  libhnsw_native.so
```

### 4.1 Active runtime path

#### `src/hnsw/hnswNative.mts` (Node <-> Rust bridge)

**Primary role:** bind C ABI functions from native library and expose TS class `HnswIndexNative`.

It does four important things:
1. Resolve library filename by OS (`.dll`, `.so`, `.dylib`) with prefix rules.
2. Load the library with `koffi`.
3. Register native signatures exactly (type-level contract with Rust exports).
4. Provide method wrappers with reusable typed arrays to reduce per-call allocations.

This file is the narrow waist between TS and Rust.

---

#### `src/hnsw/hnswIndex.mts` (orchestrator / consistency layer)

**Primary role:** coordinate native graph changes with persistent storage updates.

Internals:
- owns native engine: `rustIdx: HnswIndexNative`
- owns persistent graph: `HNSWGraphStorage`
- owns persistent vectors: `VectorHeapFile`
- maintains in-memory translation maps:
  - `docIdIndex`: docId -> NodeId
  - `vectorPtrCache`: docId -> vector pointer

Why these maps matter:
- Rust returns/accepts docIds.
- Graph storage writes neighbor arrays as NodeIds.
- `HNSWIndex` must translate quickly both ways without repeated storage scans.

---

#### `src/hnsw/hnswGraphStorage.mts` (persistent graph pages)

**Primary role:** define and manipulate on-disk graph node layout in FreeBlockFile.

Responsibilities:
- page magic + slot bitmap management for graph pages
- node serialization/deserialization:
  - docId
  - level
  - vector pointer
  - deleted flag
  - per-layer neighbor NodeIds
- dedicated metadata block management:
  - `M`
  - max stored level
  - entry point
  - current max level
- level histogram tracking to compute true max level
- hot-path neighbor rewrite method:
  - `updateNodeNeighbors(nodeId, docId, rustIdx, docIdIndex)`
  - fetches neighbors from Rust in compact form (`getAllNeighbors`)
  - writes counts and NodeId lists directly into page buffers

This file is where persisted graph format is defined.

---

#### `src/hnsw/vectorHeapFile.mts` (persistent vector pages)

**Primary role:** store and retrieve fixed-dimension float vectors in shared FreeBlockFile.

Responsibilities:
- page layout and slot allocation/free
- insert/get/update/delete vector slots
- page-level bitmap/used-count maintenance
- optional scan iterator for all vectors

Design note:
- `HNSWIndex` writes vectors before graph rewiring to preserve "data before index" ordering.

---

#### `src/hnsw/vectorSerializer.mts`

**Primary role:** raw little-endian float32 codec used by `VectorHeapFile`.

---

#### `src/hnsw/hnswNode.mts`

**Primary role:** TS model of persisted graph node and `NodeId` type semantics.

This is a data model used by storage and orchestrator, not by native compute directly.

---

### 4.2 Legacy/reference TS algorithm path

#### `src/hnsw/hnswSearch.mts`
#### `src/hnsw/hnswInsert.mts`
#### `src/hnsw/hnswDelete.mts`

These files implement pure-TS algorithmic logic (search/insert/delete contexts).  
They are useful for historical behavior and comparison, but current `HNSWIndex` execution path uses native Rust for those operations.

---

### 4.3 Test and native binary artifacts

#### `src/hnsw/hnsw.spec.mts`

Covers storage behavior and index/persistence invariants.

#### `src/hnsw/hnsw_native.dll` and `src/hnsw/libhnsw_native.so`

Prebuilt native binaries loaded by `hnswNative.mts`.

---

## 5) Cross-Layer API Mapping (Rust export -> TS method -> usage)

This section fills the common "who calls what" gap.

- Rust `hnsw_create` -> TS `new HnswIndexNative(...)` -> called in `HNSWIndex` constructor
- Rust `hnsw_insert` -> TS `rustIdx.insert(docId, vector)` -> called in `HNSWIndex.insert`
- Rust `hnsw_search` -> TS `rustIdx.search(query, k)` -> called in `HNSWIndex.search`
- Rust `hnsw_delete` -> TS `rustIdx.delete(docId)` -> called in `HNSWIndex.delete`
- Rust `hnsw_take_dirty_nodes` -> TS `rustIdx.takeDirtyNodes()` -> called after insert/delete
- Rust `hnsw_get_all_neighbors` -> TS `rustIdx.getAllNeighbors(docId)` -> used by:
  - `HNSWIndex.buildNeighborList`
  - `HNSWGraphStorage.updateNodeNeighbors`
- Rust import API (`hnsw_import_*`) -> TS `importNode/importSetNeighbors/importFinish` -> used by `HNSWIndex.loadFromFBF`

This mapping is the key to understanding why both code trees exist and how they handshake.

---

## 6) End-to-End Working (Detailed, With Rationale)

### 6.1 Create/New index

1. DBMS creates or opens shared `FreeBlockFile`.
2. `HNSWGraphStorage.create(...)` allocates metadata block and stores graph params.
3. `VectorHeapFile` is created for configured embedding dimension.
4. `HNSWIndex` constructs native `HnswIndexNative`.
5. Collection metadata stores graph meta block ID so open can find graph later.

---

### 6.2 Insert flow (exact responsibilities)

1. Upstream DBMS computes embedding vector.
2. `HNSWIndex.insert(docId, vector)` writes vector to `VectorHeapFile`.
3. `rustIdx.insert(docId, vector)` mutates in-memory graph.
4. `rustIdx.takeDirtyNodes()` returns docIds whose adjacency changed.
5. New node is persisted first (`insertNode`) so other dirty nodes can safely reference it.
6. For each other dirty docId, `HNSWGraphStorage.updateNodeNeighbors(...)` rewrites adjacency from native state.
7. `HNSWIndex` updates persisted graph-level metadata (entry point, max level).
8. Commit path flushes shared WAL state atomically via FreeBlockFile commit.

Why step ordering matters:
- Vector first, graph second prevents persisted graph references to non-persisted vectors.

---

### 6.3 Search flow

1. DBMS produces query embedding.
2. `HNSWIndex.search(query, k)` delegates to native search.
3. Native returns docIds ranked by distance.
4. DBMS resolves documents from its own document storage by docId.

No persistent graph I/O is needed in the query hot path once index is loaded.

---

### 6.4 Delete flow

1. `HNSWIndex.delete(docId)` resolves node/vector pointers.
2. Vector slot is deleted/freed in `VectorHeapFile`.
3. Native delete updates graph and returns dirty docIds.
4. Node slot is hard-deleted from `HNSWGraphStorage`.
5. All dirty neighbors have their adjacency rewritten from native graph state.
6. Entry point / max level metadata are recalculated and persisted.

---

### 6.5 Open/recovery flow

1. `HNSWIndex.open(...)` triggers `loadFromFBF()`.
2. Scan graph storage nodes; skip deleted nodes.
3. Read each node's vector from `VectorHeapFile`.
4. Import nodes into native graph (`importNode` pass).
5. Rebuild neighbor edges (`importSetNeighbors` pass).
6. Set entry point and max level (`importFinish`).
7. Rebuild docId/NodeId and vector pointer caches.

This restores fast native query behavior from persisted TS-managed state.

---

## 7) File-By-File Quick Reference (Review-Oriented)

### `hnsw-native/`
- `src/lib.rs`: FFI surface; stable ABI contract for Node.
- `src/hnsw.rs`: algorithm/data-structure implementation.
- `src/distance.rs`: distance primitive.
- `Cargo.toml`: build and optimization profile.
- `.cargo/config.toml`: local target/toolchain defaults.
- `target/`: generated build outputs.

### `src/hnsw/`
- `hnswNative.mts`: runtime FFI binding and native class wrapper.
- `hnswIndex.mts`: orchestration + consistency + lifecycle.
- `hnswGraphStorage.mts`: persistent graph pages + metadata.
- `vectorHeapFile.mts`: persistent vector pages.
- `vectorSerializer.mts`: vector binary codec.
- `hnswNode.mts`: persisted node model.
- `hnswSearch.mts`, `hnswInsert.mts`, `hnswDelete.mts`: legacy TS algorithm path.
- `hnsw.spec.mts`: tests around storage/index behavior.
- `hnsw_native.dll`, `libhnsw_native.so`: prebuilt native binaries used at runtime.

---

## 8) Core Architectural Takeaway

This branch does **not** replace persistence with native code.  
It replaces **graph computation** with native code, while keeping persistence in TS/FreeBlockFile.

So the architecture is:
- Rust = mutable in-memory HNSW engine
- TypeScript = durable graph/vector representation + DBMS plumbing
- `HNSWIndex` = correctness boundary that synchronizes both worlds

That synchronization boundary (`HNSWIndex`) is the most important place to inspect for correctness during review.
