//! Core in-memory HNSW implementation.
//!
//! Performance highlights vs the TypeScript version:
//!   • No async overhead — every call is synchronous Rust.
//!   • `BinaryHeap` for O(log ef) candidate operations instead of O(ef) splice.
//!   • SIMD L2 distance (AVX2 auto-vectorised by LLVM at opt-level=3).
//!   • Heuristic neighbor selection (Algorithm 4) → denser, faster-to-navigate graph.
//!   • `FxHashSet` (rustc-hash) for O(1) integer visited-set operations.
//!   • Flat `Vec<f32>` vector store — cache-friendly, no pointer chasing.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use rustc_hash::{FxHashMap, FxHashSet};


use crate::distance::l2_squared;

// ── Candidate wrappers ────────────────────────────────────────────────────────

/// (distance, node_index)
#[derive(Clone, Copy, PartialEq)]
pub struct Dist(pub f32, pub u32);

/// Min-heap wrapper (BinaryHeap is max by default, so we reverse).
struct MinDist(Dist);
impl PartialEq for MinDist  { fn eq(&self, o: &Self) -> bool { self.0 == o.0 } }
impl Eq for MinDist {}
impl PartialOrd for MinDist {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) }
}
impl Ord for MinDist {
    fn cmp(&self, o: &Self) -> Ordering {
        // Reverse so BinaryHeap::pop() returns the *closest* candidate.
        o.0.0.total_cmp(&self.0.0).then(o.0.1.cmp(&self.0.1))
    }
}

/// Max-heap wrapper (default order — pop returns the *furthest* candidate).
struct MaxDist(Dist);
impl PartialEq for MaxDist  { fn eq(&self, o: &Self) -> bool { self.0 == o.0 } }
impl Eq for MaxDist {}
impl PartialOrd for MaxDist {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) }
}
impl Ord for MaxDist {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0.0.total_cmp(&o.0.0).then(self.0.1.cmp(&o.0.1))
    }
}

// ── Node ──────────────────────────────────────────────────────────────────────

struct Node {
    doc_id: u32,
    level:  usize,
    deleted: bool,
    /// `neighbors[layer]` = list of node indices connected at that layer.
    /// Layer 0 capacity: 2*M.  Layer l>0 capacity: M.
    neighbors: Vec<Vec<u32>>,
}

// ── HnswCore ─────────────────────────────────────────────────────────────────

pub struct HnswCore {
    dim:             usize,
    m:               usize,
    m0:              usize,
    ef_construction: usize,
    ef_search:       usize,
    m_l:             f64,

    vectors:   Vec<f32>,
    nodes:     Vec<Node>,
    doc_to_node: FxHashMap<u32, u32>,
    all_doc_to_node: FxHashMap<u32, u32>,

    entry_point: Option<u32>,
    max_level:   usize,

    /// Nodes modified by the most recent insert/delete call.
    /// Contains the *doc_id* of every touched node.
    /// Cleared at the start of each insert/delete and readable afterwards.
    pub dirty_doc_ids: Vec<u32>,
}

impl HnswCore {
    pub fn new(dim: usize, m: usize, ef_construction: usize, ef_search: usize) -> Self {
        assert!(m >= 2, "M must be >= 2");
        HnswCore {
            dim,
            m,
            m0: m * 2,
            ef_construction,
            ef_search,
            m_l: 1.0 / (m as f64).ln(),
            vectors: Vec::new(),
            nodes:   Vec::new(),
            doc_to_node: FxHashMap::default(),
            all_doc_to_node: FxHashMap::default(),
            entry_point: None,
            max_level:   0,
            dirty_doc_ids: Vec::new(),
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// Insert a vector with the given `doc_id`. Silently replaces an existing
    /// entry with the same `doc_id`.
    /// After this call `dirty_doc_ids` contains the doc_ids of every node
    /// whose neighbor lists were modified (including the new node itself).
    pub fn insert(&mut self, doc_id: u32, vector: &[f32]) {
        assert_eq!(vector.len(), self.dim, "vector dimension mismatch");
        self.dirty_doc_ids.clear();

        // If doc already exists, soft-delete the old node first.
        if let Some(&old) = self.doc_to_node.get(&doc_id) {
            self.nodes[old as usize].deleted = true;
        }

        let node_id = self.nodes.len() as u32;
        let level   = self.random_level();

        self.vectors.extend_from_slice(vector);
        self.nodes.push(Node {
            doc_id,
            level,
            deleted: false,
            neighbors: vec![vec![]; level + 1],
        });
        self.doc_to_node.insert(doc_id, node_id);
        self.all_doc_to_node.insert(doc_id, node_id);
        // New node is always dirty.
        self.dirty_doc_ids.push(doc_id);

        if self.entry_point.is_none() {
            self.entry_point = Some(node_id);
            self.max_level   = level;
            return;
        }

        let mut ep = self.entry_point.unwrap();

        for lc in ((level + 1)..=self.max_level).rev() {
            ep = self.greedy_layer(ep, vector, lc);
        }

        for lc in (0..=level.min(self.max_level)).rev() {
            let m_max = if lc == 0 { self.m0 } else { self.m };

            let candidates = self.search_layer(ep, vector, self.ef_construction, lc);

            if let Some(best) = candidates.iter().min_by(|a, b| a.0.total_cmp(&b.0)) {
                ep = best.1;
            }

            // Paper Algorithm 1: SELECT-NEIGHBORS(q, W, M, lc) — always M,
            // NOT m_max.  m_max (= 2M at layer 0) is only the capacity for
            // pruning existing nodes' back-link lists.
            let neighbors = self.heuristic_select(&candidates, vector, self.m);
            self.nodes[node_id as usize].neighbors[lc] = neighbors.clone();

            for &nb in &neighbors {
                if lc > self.nodes[nb as usize].level { continue; }
                self.nodes[nb as usize].neighbors[lc].push(node_id);

                let nb_doc_id = self.nodes[nb as usize].doc_id;
                if !self.dirty_doc_ids.contains(&nb_doc_id) {
                    self.dirty_doc_ids.push(nb_doc_id);
                }

                if self.nodes[nb as usize].neighbors[lc].len() > m_max {
                    self.prune_backlinks(nb, lc, m_max);
                }
            }
        }

        if level > self.max_level {
            self.entry_point = Some(node_id);
            self.max_level   = level;
        }
    }

    /// Return the `k` nearest doc_ids to `query` (closest first).
    pub fn search(&self, query: &[f32], k: usize) -> Vec<u32> {
        assert_eq!(query.len(), self.dim, "query dimension mismatch");

        let Some(mut ep) = self.entry_point else { return vec![] };

        // Phase 1: greedy descent to layer 1.
        for lc in (1..=self.max_level).rev() {
            ep = self.greedy_layer(ep, query, lc);
        }

        // Phase 2: beam search at layer 0.
        let ef = self.ef_search.max(k);
        let mut results = self.search_layer(ep, query, ef, 0);

        // Sort closest-first, return top-k doc_ids.
        results.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
        results.iter()
            .filter(|d| !self.nodes[d.1 as usize].deleted)
            .take(k)
            .map(|d| self.nodes[d.1 as usize].doc_id)
            .collect()
    }

    /// Soft-delete the node associated with `doc_id`.
    ///
    /// The node stays allocated and keeps its neighbour lists intact. The live
    /// doc_id map is updated so search results and future deletes no longer
    /// target this entry, but no graph rewiring or storage reclamation occurs.
    /// Returns `true` if the entry existed.
    pub fn delete(&mut self, doc_id: u32) -> bool {
        self.dirty_doc_ids.clear();
        let Some(&node_id) = self.doc_to_node.get(&doc_id) else { return false; };

        self.nodes[node_id as usize].deleted = true;
        self.doc_to_node.remove(&doc_id);

        // Update entry point if we deleted it.
        if self.entry_point == Some(node_id) {
            // Find any live node to use as the new entry point.
            self.entry_point = self.nodes.iter()
                .enumerate()
                .find(|(_, n)| !n.deleted)
                .map(|(i, _)| i as u32);
            // Recalculate max level.
            self.max_level = self.nodes.iter()
                .filter(|n| !n.deleted)
                .map(|n| n.level)
                .max()
                .unwrap_or(0);
        }

        true
    }

    pub fn size(&self) -> usize {
        self.doc_to_node.len()
    }

    pub fn set_ef_search(&mut self, ef: usize) {
        self.ef_search = ef;
    }

    /// Vector dimension (needed by the C FFI layer to size raw slices).
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Current graph entry point (as doc_id), or None if empty.
    pub fn entry_point_doc_id(&self) -> Option<u32> {
        self.entry_point.map(|idx| self.nodes[idx as usize].doc_id)
    }

    /// Current maximum level in the graph.
    pub fn max_level(&self) -> usize {
        self.max_level
    }

    /// The level assigned to this doc_id's node, or -1 if not found.
    pub fn get_level(&self, doc_id: u32) -> i32 {
        match self.all_doc_to_node.get(&doc_id) {
            Some(&idx) => self.nodes[idx as usize].level as i32,
            None       => -1,
        }
    }

    /// Number of neighbors of `doc_id` at `layer`, or -1 if node not found
    /// or layer out of range.
    pub fn get_neighbor_count(&self, doc_id: u32, layer: usize) -> i32 {
        let Some(&idx) = self.all_doc_to_node.get(&doc_id) else { return -1; };
        self.nodes[idx as usize].neighbors.get(layer).map_or(-1, |v| v.len() as i32)
    }

    /// Write up to `max_count` neighbor doc_ids of `doc_id` at `layer` into
    /// `out`.  Returns the actual count written, or -1 if node not found.
    pub fn get_neighbors(&self, doc_id: u32, layer: usize, out: &mut [u32]) -> i32 {
        let Some(&idx) = self.all_doc_to_node.get(&doc_id) else { return -1; };
        let nb_ids = match self.nodes[idx as usize].neighbors.get(layer) {
            Some(v) => v,
            None    => return 0,
        };
        let n = nb_ids.len().min(out.len());
        for (i, &nb_idx) in nb_ids[..n].iter().enumerate() {
            out[i] = self.nodes[nb_idx as usize].doc_id;
        }
        n as i32
    }

    /// Write ALL layers' neighbors for `doc_id` into `out` in a compact format:
    ///   out[0]                 = node level (number of layers - 1)
    ///   out[1]                 = count0  (layer-0 neighbor count)
    ///   out[2 .. 2+count0]     = layer-0 doc_ids
    ///   out[2+count0]          = count1
    ///   out[2+count0+1 .. ]    = layer-1 doc_ids
    ///   … and so on for all stored layers.
    ///
    /// Returns total u32 values written, or -1 if node not found.
    /// Single FFI call replaces (maxLevel+1) calls to `get_neighbors`.
    pub fn get_all_neighbors(&self, doc_id: u32, out: &mut [u32]) -> i32 {
        let Some(&idx) = self.all_doc_to_node.get(&doc_id) else { return -1; };
        let node = &self.nodes[idx as usize];
        if out.is_empty() { return 0; }
        out[0] = node.level as u32;
        let mut pos = 1usize;
        for layer_neighbors in &node.neighbors {
            if pos + 1 + layer_neighbors.len() > out.len() { break; }
            out[pos] = layer_neighbors.len() as u32;
            pos += 1;
            for (i, &nb_idx) in layer_neighbors.iter().enumerate() {
                out[pos + i] = self.nodes[nb_idx as usize].doc_id;
            }
            pos += layer_neighbors.len();
        }
        pos as i32
    }

    // ── Import API (used when bulk-loading from FBF on open()) ───────────────

    /// Add a node to the index WITHOUT running the HNSW algorithm.
    /// Use this when loading from disk — you already have the computed graph.
    /// Neighbor lists start empty; call `import_set_neighbors` for each layer.
    pub fn import_node(&mut self, doc_id: u32, level: usize, vector: &[f32], deleted: bool) {
        assert_eq!(vector.len(), self.dim);
        let node_id = self.nodes.len() as u32;
        self.vectors.extend_from_slice(vector);
        self.nodes.push(Node {
            doc_id,
            level,
            deleted,
            neighbors: vec![vec![]; level + 1],
        });
        self.all_doc_to_node.insert(doc_id, node_id);
        if !deleted {
            self.doc_to_node.insert(doc_id, node_id);
        }
    }

    /// Overwrite the neighbor list for `doc_id` at `layer` with the provided
    /// doc_ids.  Called after `import_node` to restore persisted connections.
    /// The `neighbor_doc_ids` slice must contain valid persisted doc_ids.
    pub fn import_set_neighbors(&mut self, doc_id: u32, layer: usize, neighbor_doc_ids: &[u32]) {
        let Some(&idx) = self.all_doc_to_node.get(&doc_id) else { return; };
        if layer >= self.nodes[idx as usize].neighbors.len() { return; }
        // Convert neighbor doc_ids → internal node indices.
        let nb_indices: Vec<u32> = neighbor_doc_ids.iter()
            .filter_map(|&d| self.all_doc_to_node.get(&d).copied())
            .collect();
        self.nodes[idx as usize].neighbors[layer] = nb_indices;
    }

    /// Set the entry point and max level after all nodes have been imported.
    pub fn import_finish(&mut self, entry_doc_id: Option<u32>, max_level: usize) {
        self.entry_point = entry_doc_id.and_then(|d| self.all_doc_to_node.get(&d).copied());
        self.max_level   = max_level;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Greedy single-step descent: follow the best neighbor until no improvement.
    #[inline]
    fn greedy_layer(&self, mut ep: u32, query: &[f32], layer: usize) -> u32 {
        let mut best_dist = l2_squared(self.vec(ep), query);

        loop {
            let mut improved = false;
            // Guard: ep might not have edges at this layer (shouldn't happen,
            // but be defensive).
            let neighbors = match self.nodes[ep as usize].neighbors.get(layer) {
                Some(v) => v,
                None    => break,
            };
            for (i, &nb) in neighbors.iter().enumerate() {
                // Prefetch next neighbor's vector.
                if i + 1 < neighbors.len() {
                    let next_nb = neighbors[i + 1] as usize;
                    if next_nb < self.nodes.len() {
                        let prefetch_addr = self.vectors.as_ptr().wrapping_add(next_nb * self.dim);
                        #[cfg(target_arch = "x86_64")]
                        unsafe {
                            std::arch::x86_64::_mm_prefetch(
                                prefetch_addr as *const i8,
                                std::arch::x86_64::_MM_HINT_T0,
                            );
                        }
                    }
                }

                // Allow greedy descent through deleted nodes — they are valid
                // routing waypoints even after soft-deletion.
                let d = l2_squared(self.vec(nb), query);
                if d < best_dist {
                    best_dist = d;
                    ep        = nb;
                    improved  = true;
                }
            }
            if !improved { break; }
        }
        ep
    }

    /// Beam search on `layer` starting from `entry`, collecting up to `ef`
    /// nearest candidates. Implements Algorithm 2 from the HNSW paper.
    fn search_layer(&self, entry: u32, query: &[f32], ef: usize, layer: usize) -> Vec<Dist> {
        let entry_dist = l2_squared(self.vec(entry), query);

        // `candidates` = min-heap  (pop = closest, unexplored)
        // `w`          = max-heap  (pop = furthest, current result set)
        let mut candidates: BinaryHeap<MinDist> = BinaryHeap::with_capacity(ef * 2);
        let mut w:          BinaryHeap<MaxDist> = BinaryHeap::with_capacity(ef + 1);
        let mut visited:    FxHashSet<u32>      = FxHashSet::with_capacity_and_hasher(ef * 4, Default::default());

        candidates.push(MinDist(Dist(entry_dist, entry)));
        // Only add the entry to the result window if it is live.
        if !self.nodes[entry as usize].deleted {
            w.push(MaxDist(Dist(entry_dist, entry)));
        }
        visited.insert(entry);

        while let Some(MinDist(c)) = candidates.pop() {
            // If the closest unvisited node is farther than the furthest result, stop.
            let f_dist = w.peek().map_or(f32::INFINITY, |m| m.0.0);
            if c.0 > f_dist { break; }

            let neighbors = match self.nodes[c.1 as usize].neighbors.get(layer) {
                Some(v) => v,
                None    => continue,
            };

            for (i, &nb) in neighbors.iter().enumerate() {
                if !visited.insert(nb) { continue; }

                // Prefetch the vector of the next neighbor to hide L3 latency.
                // The vector store is large enough to cause cache misses at high N;
                // issuing a prefetch one iteration ahead overlaps the memory fetch
                // with the current distance computation.
                if i + 1 < neighbors.len() {
                    let next_nb = neighbors[i + 1] as usize;
                    if next_nb < self.nodes.len() {
                        let prefetch_addr = self.vectors.as_ptr().wrapping_add(next_nb * self.dim);
                        #[cfg(target_arch = "x86_64")]
                        unsafe {
                            std::arch::x86_64::_mm_prefetch(
                                prefetch_addr as *const i8,
                                std::arch::x86_64::_MM_HINT_T0,
                            );
                        }
                    }
                }

                let d     = l2_squared(self.vec(nb), query);
                let f_cur = w.peek().map_or(f32::INFINITY, |m| m.0.0);

                if d < f_cur || w.len() < ef {
                    // Always enqueue in `candidates` so we can route *through*
                    // deleted nodes and reach their live neighbours.
                    candidates.push(MinDist(Dist(d, nb)));
                    // Only live nodes enter the result window `w`.
                    if !self.nodes[nb as usize].deleted {
                        w.push(MaxDist(Dist(d, nb)));
                        if w.len() > ef { w.pop(); }
                    }
                }
            }
        }

        w.into_iter().map(|MaxDist(d)| d).collect()
    }

    /// Heuristic neighbor selection — Algorithm 4 from the HNSW paper.
    ///
    /// For each candidate (sorted closest-first), we keep it only if it is
    /// closer to the *query* than to any already-selected neighbor.  This
    /// ensures the chosen neighbors are "well-spread" around the query, giving
    /// the graph better long-range connectivity and improving recall.
    fn heuristic_select(&self, candidates: &[Dist], _query: &[f32], m_max: usize) -> Vec<u32> {
        // Sort a copy by distance.
        let mut sorted: Vec<Dist> = candidates.to_vec();
        sorted.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));

        let mut result:    Vec<u32>      = Vec::with_capacity(m_max);
        let mut result_vecs: Vec<&[f32]> = Vec::with_capacity(m_max);

        for c in &sorted {
            if result.len() >= m_max { break; }
            // Deleted nodes are retained as potential routing hops; not skipped here.

            let c_vec   = self.vec(c.1);
            let dist_qc = c.0;

            // Algorithm 4 (HNSW paper): keep candidate c if it is closer to
            // the query than to every already-selected neighbor:
            //   ∀ r ∈ result:  dist(q, c) < dist(c, r)
            // Matches hnswlib's getNeighborsByHeuristic2: no backfill of
            // discarded candidates (keepPrunedConnections = false).
            let is_useful = result_vecs.iter().all(|&r_vec| {
                dist_qc < l2_squared(c_vec, r_vec)
            });

            if is_useful || result.is_empty() {
                result.push(c.1);
                result_vecs.push(c_vec);
            }
        }

        result
    }

    /// Re-prune node `nb`'s neighbor list at `layer` back to `m_max` entries
    /// using the heuristic selection.  Called after adding a back-link that
    /// pushed the list over capacity.
    fn prune_backlinks(&mut self, nb: u32, layer: usize, m_max: usize) {
        // Clone vectors we need before the mutable borrow.
        let nb_vec_owned: Vec<f32> = self.vec(nb).to_vec();
        let current_nb: Vec<u32>  = self.nodes[nb as usize].neighbors[layer].clone();

        // Keep deleted nodes in the candidate set so they can remain as
        // routing bridges in the neighbour list after pruning.
        let candidates: Vec<Dist> = current_nb.iter()
            .map(|&id| Dist(l2_squared(&nb_vec_owned, self.vec(id)), id))
            .collect();

        self.nodes[nb as usize].neighbors[layer] =
            self.heuristic_select(&candidates, &nb_vec_owned, m_max);
    }

    /// Assign a random level by geometric distribution: P(level ≥ l) = (1/M)^l.
    #[inline]
    fn random_level(&self) -> usize {
        const MAX_LEVEL: usize = 16;
        let f: f64 = fastrand::f64();
        // Avoid ln(0) → clamp to a tiny positive value.
        let l = (-(f.max(1e-10).ln()) * self.m_l).floor() as usize;
        l.min(MAX_LEVEL)
    }

    /// Borrow the vector slice for node `node_id`.
    #[inline(always)]
    fn vec(&self, node_id: u32) -> &[f32] {
        let start = node_id as usize * self.dim;
        // SAFETY: insert() always pushes exactly `dim` floats per node.
        unsafe { self.vectors.get_unchecked(start..start + self.dim) }
    }
}
