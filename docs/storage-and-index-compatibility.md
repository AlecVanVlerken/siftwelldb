# Storage and index compatibility

This note keeps the detailed identity, migration and failure-handling contracts
behind the [project overview](../README.md). It describes the current reader and
writer; it does not introduce a separate migration command.

## Field indexing

Collection fields have a persisted `Indexed` setting. Ordinary string, number and boolean fields default to indexed, regardless of their names; image and binary fields are excluded. The primary `id` index is mandatory. Configure long text before inserting it:

```typescript
await db.setFieldIndexed('articles', 'body', false);
await db.insertDocumentObject('articles', { id: '1', title: 'Databases', body: longArticle });
const settings = db.getFieldIndexConfig('articles');
await db.setFieldIndexed('articles', 'title', false);
```

Enabling an index validates and backfills existing documents. Disabling it frees the secondary tree while preserving documents; equality queries use the existing scan fallback. Call `commit()` to persist API changes. Indexed keys have a 2035-byte encoded limit with the default 4096-byte blocks, including field value, ID and encoding overhead. Compression does not reduce index key size. Unindexed text stays in RecordStore and has no B+ tree key limit.

With an embedding configuration, HNSW automatically uses eligible textual fields independently of these settings, including underscore-prefixed text. Images retain their separate encoder. Model input limits still apply. In the webclient, use the **Indexed** checkboxes in Fields or the document editor; changes apply to the collection and wait for backend completion.

Existing databases migrate their field settings from persisted index roots and stored fields. Record, B+ tree, WAL and block formats remain unchanged. Semantic indexes with verified persisted dimensions can finish a pending field migration when the original working embedding configuration is available; pending migration is exposed by `getPendingSemanticCollections()` and the database status API. Graphs without dimension evidence stay disabled rather than guessing. Normal reopen and B+ tree toggles do not rebuild current semantic indexes. Full vacuum copies the settings before rebuilding records and incremental compaction repairs references only for existing indexes.

Semantic deletion retains graph nodes, vectors and their record-pointer anchors as tombstones, without rebuilding the collection graph. Incremental compaction moves retained graph/vector units; full vacuum copies live logical documents and reclaims tombstones and retained dead records. Offline semantic mutations remain pending until reopening with a working embedding configuration.

HNSW graph metadata now includes a versioned `HPD1` directory of exclusively owned graph pages. Occupied slots on those pages define complete persisted membership, including unreachable nodes and retained tombstones. Reopening, graph inspection, relocation and collection cleanup use that inventory independently of approximate graph navigation. The graph-node, vector, document, B+ tree and WAL layouts remain unchanged; large directories use linked metadata overflow blocks which also participate in incremental compaction.

Older graphs migrate once when routing evidence, page layouts, vector dimensions and live primary-record anchors establish unambiguous ownership. The migration preserves node IDs, vectors and identifiable tombstones. Disconnected tombstones, mixed-ownership pages or indistinguishable text/image indexes can lack sufficient ownership evidence; those states retain their allocations and document access, with semantic operations disabled and an explicit error. Collection cleanup refuses unverified ownership rather than silently removing metadata or guessing which allocations to free.

Semantic searches share the backend operation queue with mutations and maintenance. Closing rejects new queued operations and waits for accepted operations to finish before freeing native resources. A rejected embedding releases the queue; an embedding that remains pending also keeps close pending. Native methods reject closed handles. `SimpleDbms.reopen()` closes the previous backend and reapplies the instance's original runtime configuration, including custom text/image encoders, while retaining persisted dimension checks. Embedding functions and credentials are not stored in database files.

Document mutations validate supported values, finite numbers, index keys, compression and embeddings before writing. Single-field edits preserve the stored codecs of untouched fields, including explicit uncompressed choices and binary fields, using the same preservation path as SQL UPDATE and preserving replacements.

If a record, index or semantic mutation fails after changes may have begun, the session rejects subsequent reads, writes and commits, including direct block-file commits. `db.isHealthy` and `db.assertHealthy()` expose this state. Close without committing, then open a fresh database instance; logical staged changes, including earlier uncommitted successful operations, are discarded. Validation failures and completely discarded unpublished index builds remain usable. Bulk import continues after safe document rejections, but stops on an unsafe failure and throws `BulkImportError` with completed insertion and acknowledged-commit counts. The webclient closes unsafe sessions, stops maintenance and retains the database path for explicit reconnect.

This protection is not per-operation rollback or SQL statement atomicity. A failure during WAL commit still follows storage recovery: a complete submitted write set can be applied on reopen even when its commit was not acknowledged. Already acknowledged commits are retained.

## Identifier consistency

Collection and field names are exact, case-sensitive strings. Names such as `__proto__`, `constructor`, `toString`, punctuation, empty strings and distinct Unicode spellings are safe metadata keys. Only the existing collection names `__hnsw__`, `__compression__` and `__indexing__` are reserved for database metadata. User-keyed dictionaries have no inherited properties and B+ tree caches encode the collection and field as a JSON tuple, so delimiters in names cannot cause collisions.

Document IDs are finite numbers or well-formed Unicode strings, including empty strings and valid surrogate pairs. Each collection retains the primary ID type established by its first document; lookups and writes reject the other type instead of coercing it. String IDs retain their existing UTF-8 key encoding, case sensitivity and Unicode spelling. Unpaired UTF-16 surrogates are rejected before mutations and on ID lookup. Legacy malformed IDs are not renamed or silently re-keyed: document operations and vacuum report an explicit validation error when encountering such a record, leaving the source data available for recovery.

String field contents follow the same Unicode well-formedness rule as IDs.
Insert, edit, replacement, import, SQL literals and index lookups reject unpaired
UTF-16 surrogates before UTF-8 encoding or mutation. Valid surrogate pairs and
literal U+FFFD characters remain unchanged. RecordStore also checks decoded
Document writes before allocation or compression; persistent formats are unchanged.

Semantic metadata now stores a versioned map keyed by `[collection, "default" | "text" | "image"]` JSON tuples. Deletion, reindexing, tombstones, relocation and vacuum use exact collection ownership. Legacy flat names with no semantic suffix migrate directly. For `collection::text` or `collection::image`, live graph records with matching primary references must establish the exact owner; empty, tombstoned-only or unverified graphs refuse opening with a compatibility error and retain the stored data. Relocation targets carry a logical collection and optional `indexKind`; graph inspection takes the same optional kind instead of interpreting suffixes in collection names.

The webclient uses JSON-typed query addresses so IDs and collection names are never altered by URL path normalization. See the [HTTP addressing contract](../src/webclient/README.md#exact-document-addresses).

## Cursor pagination

`fetchPageCursor(db, { collection, iterableKey, limit, afterCursor? })` returns index-ordered JSON documents, `hasMore` and an opaque `nextCursor` string. Pass that string unchanged to resume. A version 1 token carries the exact collection, field, persisted key form and complete B+ tree key bytes, including the document ID component of secondary keys. Resumption seeks strictly after that logical key using the existing index comparator. Duplicate field values advance by their ID tie-breaker and deleting the last emitted entry does not skip its surviving successor. Seeking costs O(log N), followed by reading the page and one lookahead entry; API total counts can require a separate initial scan.

Tokens remain usable after commit/reopen, record or index relocation and full vacuum when the logical collection/index key form is retained. Malformed tokens, wrong collection/field bindings, incomplete composite keys and changed or removed index forms produce explicit cursor errors. Legacy bare field-value tokens are unsupported because they cannot identify a unique secondary position; restart from the first page.

Pagination is not a snapshot. Inserts at keys after the saved position can appear on subsequent pages; inserts before it are not revisited. Updating an indexed value across that position can omit or repeat that document. A deleted entry continues from its old key's next surviving successor. For an unchanged dataset, concatenated pages exactly match full traversal of the same index. Ordinary inclusive `cursor()` seeks, SQL `LIMIT`/`OFFSET` and the webclient's offset-based grid browsing retain their existing behavior.

## HNSW note

Semantic search is optional. Each graph persists its vector dimension and new vector pages carry their own dimension tag. Opening checks the graph before native allocation or vector decoding; incompatible dimensions disable semantic operations for that session while ordinary document access remains available. Matching dimensions do not prove that two embedding models share a vector space: keep the original model and `HnswConfig` shape.

Legacy graphs without stored dimension evidence remain intact and disabled. Their dimension cannot safely be inferred from the current configuration, vector bytes or an empty/tombstoned graph. Recovery requires an explicitly verified source or exporting readable documents into a fresh database with the intended configuration. Graph metadata and vector-page extensions require the updated reader for semantic operations; document records, B+ trees and WAL retain their existing formats. See [HNSW dimension compatibility](../src/indexes/hnsw/README.md).
