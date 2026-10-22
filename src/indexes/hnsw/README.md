# HNSW dimension compatibility

Every new semantic graph records its vector dimension independently of the active embedding configuration.
`HNSWIndex.open` checks this metadata before creating the native index or decoding vectors. A mismatch raises
`HnswCompatibilityError`; the stored graph and vectors remain unchanged.

Graph metadata retains its original 22-byte prefix and appends `HVD1` followed by a uint32 dimension. Graph nodes,
neighbor references and tombstone layouts are unchanged. Metadata relocation preserves this extension.

New vector pages use magic `0xa6`, followed by a uint32 dimension, uint16 occupied-slot count, bitmap and float32 slots.
Pointer access checks the page dimension before interpreting its bitmap or vectors. Heap scans skip pages of other
dimensions, so text and image embeddings can share a database file safely.

Older graphs without dimension metadata cannot be interpreted safely from the vector bytes or the active model alone.
Opening them raises a compatibility error. If semantic namespace ownership is unambiguous, ordinary document access
remains available while semantic operations are disabled for that session. The graph and vectors stay in the file.
Ambiguous legacy suffix ownership has a separate
[compatibility restriction](../../../docs/storage-and-index-compatibility.md#identifier-consistency).

Legacy `0xa5` vector pages retain their original offsets. They are readable through graph pointers only after an
independently persisted graph dimension has been validated. Scans skip untagged legacy pages because pages of different
dimensions cannot be distinguished reliably. Vector relocation writes a tagged page and updates the graph pointer; it
preserves retained tombstones.

Files containing the extended HNSW metadata or tagged vector pages require this reader for semantic operations. Document
records, B+ tree indexes and WAL formats are unchanged.
