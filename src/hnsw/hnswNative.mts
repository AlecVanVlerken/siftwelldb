//@author: Thomas Dumon with usage of Claude Sonnet 4.6
//@date: 2026-03-31

/**
 * hnswNative.mts
 * ──────────────
 * TypeScript wrapper around the Rust HNSW native DLL loaded via `koffi`.
 *
 * The Rust DLL (`hnsw_native.dll`) exposes a handle-based C API:
 *
 *   hnsw_t* hnsw_create(dim, m, efConstruction, efSearch)
 *   void    hnsw_destroy(handle)
 *   void    hnsw_insert(handle, docId, float* vector)
 *   u32     hnsw_search(handle, float* query, k, u32* outIds)
 *   u32     hnsw_delete(handle, docId)
 *   u32     hnsw_size(handle)
 *   void    hnsw_set_ef_search(handle, ef)
 *
 * Performance wins over the pure-TS implementation
 * ────────────────────────────────────────────────
 *  • AVX2 SIMD L2 distance (auto-vectorised by LLVM, 8 floats/cycle)
 *  • Binary-heap candidates — O(log ef) vs O(ef) splice in TS
 *  • Heuristic neighbour selection (Algorithm 4) — denser graph, fewer hops
 *  • No async overhead — Rust runs synchronously inside koffi
 *  • Flat Vec<f32> storage — cache-friendly, no pointer chasing
 */

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import koffi from 'koffi';
import type { KoffiFunction } from 'koffi';

// ── Locate the DLL relative to this source file ──────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ext = os.platform() === 'win32' ? '.dll' : os.platform() === 'darwin' ? '.dylib' : '.so';
const libPrefix = os.platform() === 'win32' ? '' : 'lib';
let DLL_PATH = path.join(__dirname, `${libPrefix}hnsw_native${ext}`);

if (!fs.existsSync(DLL_PATH)) {
  // If we are running in the build/ folder but the native libs weren't copied natively by ts
  DLL_PATH = path.join(__dirname, '../../src/hnsw', `${libPrefix}hnsw_native${ext}`);
}

// ── Lazy-load koffi so the module can be imported even if koffi is absent ────
let _lib: ReturnType<(typeof import('koffi'))['load']> | null = null;

let _fns: Record<string, KoffiFunction> = {};

function getLib() {
  if (_lib) return _lib;

  _lib = koffi.load(DLL_PATH);

  // Opaque pointer type for the Rust HnswHandle.
  const HnswT = koffi.opaque('HnswT');

  _fns = {
    // ── Core CRUD ─────────────────────────────────────────────────────────────
    create: _lib.func('HnswT *hnsw_create(uint32_t dim, uint32_t m, uint32_t efConstruction, uint32_t efSearch)'),
    destroy: _lib.func('void hnsw_destroy(HnswT *handle)'),
    insert: _lib.func('void hnsw_insert(HnswT *handle, uint32_t docId, float *vector)'),
    search: _lib.func('uint32_t hnsw_search(HnswT *handle, float *query, uint32_t k, _Out_ uint32_t *outIds)'),
    delete: _lib.func('uint32_t hnsw_delete(HnswT *handle, uint32_t docId)'),
    size: _lib.func('uint32_t hnsw_size(HnswT *handle)'),
    setEfSearch: _lib.func('void hnsw_set_ef_search(HnswT *handle, uint32_t ef)'),
    // ── Dirty-node tracking (FBF persistence) ─────────────────────────────────
    takeDirtyNodes: _lib.func(
      'uint32_t hnsw_take_dirty_nodes(HnswT *handle, _Out_ uint32_t *out_buf, uint32_t buf_len)',
    ),
    // ── Per-node query (write dirty nodes back to FBF) ────────────────────────
    getLevel: _lib.func('int32_t hnsw_get_level(HnswT *handle, uint32_t doc_id)'),
    getNeighborCount: _lib.func('int32_t hnsw_get_neighbor_count(HnswT *handle, uint32_t doc_id, uint32_t layer)'),
    getNeighbors: _lib.func(
      'int32_t hnsw_get_neighbors(HnswT *handle, uint32_t doc_id, uint32_t layer, _Out_ uint32_t *out_buf, uint32_t buf_len)',
    ),
    getAllNeighbors: _lib.func(
      'int32_t hnsw_get_all_neighbors(HnswT *handle, uint32_t doc_id, _Out_ uint32_t *out_buf, uint32_t buf_len)',
    ),
    getEntryDocId: _lib.func('uint32_t hnsw_get_entry_doc_id(HnswT *handle)'),
    getMaxLevel: _lib.func('uint32_t hnsw_get_max_level(HnswT *handle)'),
    // ── Bulk-import (loading from FBF on open()) ──────────────────────────────
    importNode: _lib.func(
      'void hnsw_import_node(HnswT *handle, uint32_t doc_id, uint32_t level, float *vector, uint32_t deleted)',
    ),
    importSetNeighbors: _lib.func(
      'void hnsw_import_set_neighbors(HnswT *handle, uint32_t doc_id, uint32_t layer, uint32_t *nb_doc_ids, uint32_t nb_count)',
    ),
    importFinish: _lib.func('void hnsw_import_finish(HnswT *handle, uint32_t entry_doc_id, uint32_t max_level)'),
  };

  // suppress unused warning - HnswT is registered by side-effect
  void HnswT;

  return _lib;
}

// ── Public class ──────────────────────────────────────────────────────────────

/**
 * HnswIndexNative
 * ───────────────
 * In-memory HNSW backed by the Rust DLL.  Drop-in replacement for the disk-
 * based `HNSWIndex` for pure in-memory / benchmarking use cases.
 *
 * All methods are **synchronous** — no `await` needed.
 */
export class HnswIndexNative {
  private readonly handle: object;
  private readonly _dim: number;
  private readonly _k_buf: Uint32Array; // reusable result buffer for search
  private readonly _nb_buf: Uint32Array; // reusable result buffer for getNeighbors
  private readonly _all_nb_buf: Uint32Array; // reusable result buffer for getAllNeighbors
  private readonly _dirty_buf: Uint32Array; // reusable result buffer for takeDirtyNodes

  /**
   * @param dim             Vector dimension (fixed for the lifetime of the index).
   * @param m               HNSW M parameter — edges per node per layer.   Default 16.
   * @param efConstruction  Beam width during graph construction.           Default 200.
   * @param efSearch        Beam width during search (changeable at runtime). Default 128.
   */
  constructor(dim: number, m: number = 16, efConstruction: number = 200, efSearch: number = 128) {
    getLib(); // initialise on first call
    this.handle = _fns['create'](dim, m, efConstruction, efSearch) as object;
    this._dim = dim;
    // Pre-allocate result buffer for up to 1024 neighbours.
    this._k_buf = new Uint32Array(1024);
    // Pre-allocate reusable FFI output buffers to avoid per-call allocations.
    this._nb_buf = new Uint32Array(64); // max M*2 neighbours per layer
    this._all_nb_buf = new Uint32Array(100); // header + all layers: 1+17+9+9+9 ≤ 64 for M=8
    this._dirty_buf = new Uint32Array(512); // max dirty nodes per insert
  }

  /** Insert a vector identified by `docId`. */
  insert(docId: number, vector: Float32Array): void {
    _fns['insert'](this.handle, docId, vector);
  }

  /**
   * Return the `k` nearest doc_ids to `query` (closest first).
   * The returned array is a fresh JS array each call.
   */
  search(query: Float32Array, k: number): number[] {
    const buf = k <= 1024 ? this._k_buf : new Uint32Array(k);
    const n = _fns['search'](this.handle, query, k, buf) as number;
    return Array.from(buf.subarray(0, n));
  }

  /**
   * Remove `docId` from the native live-document map.
   * @returns `true` if the live entry was found.
   */
  delete(docId: number): boolean {
    return (_fns['delete'](this.handle, docId) as number) === 1;
  }

  /** Number of live (non-deleted) entries in the index. */
  get size(): number {
    return _fns['size'](this.handle) as number;
  }

  /** Change the search beam width at runtime (higher = better recall, slower). */
  setEfSearch(ef: number): void {
    _fns['setEfSearch'](this.handle, ef);
  }

  /** Dimension of vectors stored in this index. */
  get dim(): number {
    return this._dim;
  }

  // ── Dirty-node tracking API (for FBF persistence after insert/delete) ───────

  /**
   * Return the doc_ids of all nodes whose neighbor lists were modified by the
   * most recent `insert()` or `delete()` call, then clear the dirty set.
   * Must be called once after each mutating operation before the next one.
   */
  /**
   * Return dirty doc_ids as a Uint32Array view into the shared `_dirty_buf`.
   * Valid only until the next mutating call on this instance.
   */
  takeDirtyNodes(): Uint32Array {
    const n = _fns['takeDirtyNodes'](this.handle, this._dirty_buf, 512) as number;
    return this._dirty_buf.subarray(0, n);
  }

  // ── Per-node query API (read Rust state for writing back to FBF) ─────────────

  /** Get the level of `docId`. Returns -1 if not found. */
  getLevel(docId: number): number {
    return _fns['getLevel'](this.handle, docId) as number;
  }

  /** Number of neighbors of `docId` at `layer`. Returns -1 if not found. */
  getNeighborCount(docId: number, layer: number): number {
    return _fns['getNeighborCount'](this.handle, docId, layer) as number;
  }

  /**
   * Return the neighbor doc_ids of `docId` at `layer` as a read-only view into
   * the pre-allocated `_nb_buf`.  The view is only valid until the next call to
   * this method — callers must not retain the reference across calls.
   * Returns an empty view if the node is not found or the layer is out of range.
   */
  getNeighbors(docId: number, layer: number): Uint32Array {
    const n = _fns['getNeighbors'](this.handle, docId, layer, this._nb_buf, 64) as number;
    if (n < 0) return this._nb_buf.subarray(0, 0);
    return this._nb_buf.subarray(0, n);
  }

  /**
   * Return ALL layers' neighbor doc_ids for `docId` in compact format, as a
   * read-only view into the pre-allocated `_all_nb_buf`.
   *   [nodeLevel, count0, nb0_0..nb0_k, count1, nb1_0..nb1_k, ...]
   * Single FFI call replaces (maxLevel+1) calls to `getNeighbors`.
   * Valid only until the next call to this method.
   */
  getAllNeighbors(docId: number): Uint32Array {
    const n = _fns['getAllNeighbors'](this.handle, docId, this._all_nb_buf, 100) as number;
    if (n <= 0) return this._all_nb_buf.subarray(0, 0);
    return this._all_nb_buf.subarray(0, n);
  }

  /**
   * Entry-point doc_id.
   * Returns `null` if the index is empty.
   */
  getEntryDocId(): number | null {
    const id = _fns['getEntryDocId'](this.handle) as number;
    return id === 0xffffffff ? null : id;
  }

  /** Current maximum level in the graph. */
  getMaxLevel(): number {
    return _fns['getMaxLevel'](this.handle) as number;
  }

  // ── Bulk-import API (loading from FBF on open()) ─────────────────────────────

  /**
   * Add a pre-existing node without running the HNSW algorithm.
   * Neighbor lists start empty; call `importSetNeighbors` for each layer
   * after all nodes have been imported.
   */
  importNode(docId: number, level: number, vector: Float32Array, deleted: boolean): void {
    _fns['importNode'](this.handle, docId, level, vector, deleted ? 1 : 0);
  }

  /**
   * Set the neighbor list for `docId` at `layer` from an array of doc_ids.
   * Call after `importNode` to restore persisted connections.
   */
  importSetNeighbors(docId: number, layer: number, neighborDocIds: number[]): void {
    const buf = new Uint32Array(neighborDocIds);
    _fns['importSetNeighbors'](this.handle, docId, layer, buf, neighborDocIds.length);
  }

  /**
   * Finalise the bulk-import: set the entry-point doc_id and max level.
   * Pass `entryDocId = null` to indicate an empty index.
   */
  importFinish(entryDocId: number | null, maxLevel: number): void {
    const ep = entryDocId !== null ? entryDocId : 0xffffffff;
    _fns['importFinish'](this.handle, ep, maxLevel);
  }

  /**
   * Free the underlying Rust memory.
   * After calling `close()` this instance must not be used.
   */
  close(): void {
    _fns['destroy'](this.handle);
  }
}
