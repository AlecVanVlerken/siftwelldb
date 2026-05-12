//! Rust HNSW — plain C ABI, loaded by Node.js via the `koffi` FFI library.
//!
//! No napi-rs, no node.dll, no build-time Node headers required.
//! Build:  cargo build --release  →  target/release/hnsw_native.dll

mod distance;
mod hnsw;

use hnsw::HnswCore;

// ── C-ABI handle type ─────────────────────────────────────────────────────────

pub struct HnswHandle(HnswCore);

// ── Core CRUD exports ─────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn hnsw_create(
    dim: u32, m: u32, ef_construction: u32, ef_search: u32,
) -> *mut HnswHandle {
    Box::into_raw(Box::new(HnswHandle(
        HnswCore::new(dim as usize, m as usize, ef_construction as usize, ef_search as usize)
    )))
}

#[no_mangle]
pub extern "C" fn hnsw_destroy(handle: *mut HnswHandle) {
    if handle.is_null() { return; }
    unsafe { drop(Box::from_raw(handle)); }
}

/// Insert a vector. After return, call `hnsw_take_dirty_nodes` to get the
/// list of nodes whose neighbor lists were modified (for FBF persistence).
#[no_mangle]
pub extern "C" fn hnsw_insert(handle: *mut HnswHandle, doc_id: u32, vector: *const f32) {
    let idx = unsafe { &mut (*handle).0 };
    let dim = idx.dim();
    let vec = unsafe { std::slice::from_raw_parts(vector, dim) };
    idx.insert(doc_id, vec);
}

/// Search for the `k` nearest neighbours of `query`.
/// Results (doc_ids, closest first) are written into `out_ids[0..k]`.
/// Returns the actual number of results written (≤ `k`).
#[no_mangle]
pub extern "C" fn hnsw_search(
    handle: *const HnswHandle,
    query:  *const f32,
    k:      u32,
    out_ids: *mut u32,
) -> u32 {
    let idx = unsafe { &(*handle).0 };
    let dim = idx.dim();
    let q   = unsafe { std::slice::from_raw_parts(query, dim) };
    let results = idx.search(q, k as usize);
    let n = results.len() as u32;
    unsafe {
        std::ptr::copy_nonoverlapping(results.as_ptr(), out_ids, results.len());
    }
    n
}

/// Soft-delete the node associated with `doc_id`.
/// The node remains allocated in the graph; only the live-doc mapping changes.
/// Returns 1 if found and deleted, 0 otherwise.
#[no_mangle]
pub extern "C" fn hnsw_delete(handle: *mut HnswHandle, doc_id: u32) -> u32 {
    unsafe { (*handle).0.delete(doc_id) as u32 }
}

#[no_mangle]
pub extern "C" fn hnsw_size(handle: *const HnswHandle) -> u32 {
    unsafe { (*handle).0.size() as u32 }
}

#[no_mangle]
pub extern "C" fn hnsw_set_ef_search(handle: *mut HnswHandle, ef: u32) {
    unsafe { (*handle).0.set_ef_search(ef as usize); }
}

// ── Dirty-node tracking (FBF persistence integration) ────────────────────────

/// Copy the dirty doc_id list into `out_buf` (capacity `buf_len`).
/// Returns the number of doc_ids written.
#[no_mangle]
pub extern "C" fn hnsw_take_dirty_nodes(
    handle:  *const HnswHandle,
    out_buf: *mut u32,
    buf_len: u32,
) -> u32 {
    let dirty = &unsafe { &(*handle).0 }.dirty_doc_ids;
    let n = dirty.len().min(buf_len as usize);
    unsafe { std::ptr::copy_nonoverlapping(dirty.as_ptr(), out_buf, n); }
    n as u32
}

// ── Per-node query API (for writing dirty nodes back to FBF) ─────────────────

/// Get the level of the node with `doc_id`.  Returns -1 if not found.
#[no_mangle]
pub extern "C" fn hnsw_get_level(handle: *const HnswHandle, doc_id: u32) -> i32 {
    unsafe { (*handle).0.get_level(doc_id) }
}

/// Number of neighbors of `doc_id` at `layer`.  Returns -1 if not found.
#[no_mangle]
pub extern "C" fn hnsw_get_neighbor_count(
    handle: *const HnswHandle, doc_id: u32, layer: u32,
) -> i32 {
    unsafe { (*handle).0.get_neighbor_count(doc_id, layer as usize) }
}

/// Write neighbor doc_ids of `doc_id` at `layer` into `out_buf`.
/// Returns count written, or -1 if node not found.
#[no_mangle]
pub extern "C" fn hnsw_get_neighbors(
    handle:  *const HnswHandle,
    doc_id:  u32,
    layer:   u32,
    out_buf: *mut u32,
    buf_len: u32,
) -> i32 {
    let out = unsafe { std::slice::from_raw_parts_mut(out_buf, buf_len as usize) };
    unsafe { (*handle).0.get_neighbors(doc_id, layer as usize, out) }
}

/// Write ALL layers' neighbors for `doc_id` into `out_buf` in compact format:
///   [nodeLevel, count0, nb0_0..nb0_k, count1, nb1_0..nb1_k, ...]
/// Returns total u32 values written, or -1 if not found.
/// Single FFI call replaces (maxLevel+1) calls to `hnsw_get_neighbors`.
#[no_mangle]
pub extern "C" fn hnsw_get_all_neighbors(
    handle:  *const HnswHandle,
    doc_id:  u32,
    out_buf: *mut u32,
    buf_len: u32,
) -> i32 {
    let out = unsafe { std::slice::from_raw_parts_mut(out_buf, buf_len as usize) };
    unsafe { (*handle).0.get_all_neighbors(doc_id, out) }
}

/// Entry-point doc_id.  Returns 0xFFFF_FFFF if the index is empty.
#[no_mangle]
pub extern "C" fn hnsw_get_entry_doc_id(handle: *const HnswHandle) -> u32 {
    unsafe { (*handle).0.entry_point_doc_id() }.unwrap_or(u32::MAX)
}

/// Current maximum level in the graph.
#[no_mangle]
pub extern "C" fn hnsw_get_max_level(handle: *const HnswHandle) -> u32 {
    unsafe { (*handle).0.max_level() as u32 }
}

// ── Bulk-import API (used when loading from FBF on open()) ───────────────────

/// Add a node without running the HNSW algorithm.
/// Neighbor lists are empty until you call `hnsw_import_set_neighbors`.
#[no_mangle]
pub extern "C" fn hnsw_import_node(
    handle:  *mut HnswHandle,
    doc_id:  u32,
    level:   u32,
    vector:  *const f32,
    deleted: u32,
) {
    let idx = unsafe { &mut (*handle).0 };
    let dim = idx.dim();
    let vec = unsafe { std::slice::from_raw_parts(vector, dim) };
    idx.import_node(doc_id, level as usize, vec, deleted != 0);
}

/// Set the neighbor list for `doc_id` at `layer` from an array of doc_ids.
#[no_mangle]
pub extern "C" fn hnsw_import_set_neighbors(
    handle:      *mut HnswHandle,
    doc_id:      u32,
    layer:       u32,
    nb_doc_ids:  *const u32,
    nb_count:    u32,
) {
    let idx = unsafe { &mut (*handle).0 };
    let nb = unsafe { std::slice::from_raw_parts(nb_doc_ids, nb_count as usize) };
    idx.import_set_neighbors(doc_id, layer as usize, nb);
}

/// Finalise the import: set the entry-point doc_id and max level.
/// Pass `entry_doc_id = 0xFFFF_FFFF` to indicate an empty index.
#[no_mangle]
pub extern "C" fn hnsw_import_finish(
    handle:        *mut HnswHandle,
    entry_doc_id:  u32,
    max_level:     u32,
) {
    let entry = if entry_doc_id == u32::MAX { None } else { Some(entry_doc_id) };
    unsafe { (*handle).0.import_finish(entry, max_level as usize); }
}
