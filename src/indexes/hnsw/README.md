# HNSW dimension compatibility

Every new semantic graph records its vector dimension independently of the active embedding configuration. `HNSWIndex.open` checks this metadata before creating the native index or decoding vectors. A mismatch raises `HnswCompatibilityError`; the stored graph and vectors remain unchanged.

Graph metadata retains its original 22-byte prefix and appends `HVD1` followed by a uint32 dimension. Graph nodes, neighbor references and tombstone layouts are unchanged. Metadata relocation preserves this extension.

New vector pages use magic `0xa6`, followed by a uint32 dimension, uint16 occupied-slot count, bitmap and float32 slots. Pointer access checks the page dimension before interpreting its bitmap or vectors. Heap scans skip pages of other dimensions, so text and image embeddings can share a database file safely.

Legacy graphs without dimension metadata have an unknown layout. Their dimension cannot reliably be inferred from vector bytes, the current model, or an empty/tombstoned result set. They raise an explicit compatibility error instead of guessing or rebuilding automatically. Where semantic namespace ownership is unambiguous, database opening preserves document access and keeps the legacy semantic blocks intact; a supplied configuration is disabled for the session. Unknown legacy dimensions are never automatically labelled, migrated or inferred from the current model. Ambiguous legacy suffix ownership has a separate [compatibility restriction](../../../README.md#identifier-consistency).

Legacy `0xa5` vector pages retain their original offsets. They are readable through graph pointers only after an independently persisted graph dimension has been validated. Scans skip untagged legacy pages because pages of different dimensions cannot be distinguished reliably. Vector relocation writes a tagged page and updates the graph pointer; it preserves retained tombstones.

Files containing the extended HNSW metadata or tagged vector pages require this reader for semantic operations. Document records, B+ tree indexes and WAL formats are unchanged.
