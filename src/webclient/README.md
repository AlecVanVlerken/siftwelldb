# SiftwellDB webclient

Build with `npm run build`, then run `npx tsx src/webclient/server/daemon.mts` and open
`http://localhost:8000`. Rebuild and restart the daemon after source changes.
`Open / create` opens an existing database or initializes a missing file; the
separate create actions replace existing files after confirmation.

## Full sample database

Run from the repository root:

```powershell
npx tsx scripts/seed-test-database.mts
```

This creates `webclient-test.db` and its companion `webclient-test.db.log`.
It refuses to overwrite either file. To generate a fresh copy after destructive
experiments, supply a different filename:

```powershell
npx tsx scripts/seed-test-database.mts webclient-test-2.db
```

Open the generated file with **Open / create**, not a create action that replaces
existing data. Keep the companion log beside the database. The seeder uses the
same real MiniLM/CLIP configuration as the daemon and verifies counts, SQL and
semantic searches after reopening. Initial model downloads may take several
minutes. Photos come from the existing `examples/assets/images` directory, with the
service's bundled fallback when that optional directory is absent.

| Collection      |                 Records | Try                                                                             |
| --------------- | ----------------------: | ------------------------------------------------------------------------------- |
| employees       |                     200 | Pagination, numeric filters, salary aggregates                                  |
| products        |                     120 | Prices, stock, booleans, compression advice, text search                        |
| orders          |                     320 | Pagination, status filters, grouped SQL                                         |
| travel_guides   |                      48 | Text search on summaries; long gzip-compressed `_body` storage                  |
| support_tickets |                      48 | Semantic paraphrases, missing optional satisfaction fields                      |
| knowledge       |                      31 | Existing science, cooking, sports and other semantic examples                   |
| wiki_lab        |                     100 | Compression Lab reports and applying policies; seeded without semantic indexing |
| photos          | Available fixture count | Photo previews, text-to-photo and image-to-image searches                       |
| playground      |                       1 | Editing, image upload, deletion and new documents                               |

Use these SQL examples one at a time in the Query Language tab:

```sql
SELECT * FROM products WHERE price > 100 ORDER BY price DESC LIMIT 10;
SELECT status, COUNT(*) AS orders, SUM(total) AS revenue FROM orders GROUP BY status;
SELECT department, AVG(salary) AS average_salary FROM employees GROUP BY department;
INSERT INTO playground VALUES { id: 'my-test', title: 'A new camping backpack', quantity: 3, enabled: true };
UPDATE playground SET quantity = 9 WHERE id = 'my-test';
DELETE FROM playground WHERE id = 'my-test';
```

In Semantic Search, select `products` and text mode, then try **equipment for a
rainy hiking trip**. In `support_tickets`, try **I want my money back**. In `photos`,
use photo mode with **a bear in the wild**, or upload a photo from `examples/assets/images`
for image similarity search. Search runs within the selected collection.

After edits/deletions, try manual incremental compaction or full vacuum and
reopen the database. AI Chat still needs a Gemini key; schema introspection does
not. The sample data itself does not bypass that requirement.

MiniLM and CLIP are pretrained models: inserts compute vectors and update HNSW
indexes, rather than training either model. New supported text/image records
inserted through the webclient become searchable without retraining. Copying
files into a folder alone does not import them. All eligible text fields contribute to semantic embeddings, including long
unindexed bodies and underscore-prefixed fields.
Larger collections cost more embedding time, disk space and search resources;
HNSW produces approximate similarity rankings, not guaranteed semantic matches.

## Compression controls and bulk documents

The Compression tab lists document fields, not extra settings named after those
fields. For example, `label` is the photo label field. Each **Saved default**
dropdown immediately persists that field's codec for future writes. **Analyze
field** samples up to 100 records and displays advice without changing the saved
codec. Short labels commonly receive `none` because compressing them does not
save storage blocks. **Recommend & save all defaults** analyzes the collection
and saves its advised policy. **Reload saved defaults** reads the persisted
policy again; it does not reset anything or rewrite existing records.

In the Lab, **Analyze collection** produces a read-only policy report for the
selected collection. **Save advised defaults** stores the advisor policy for
future writes. Chart sizes are estimates. None of these advice/default actions
recompress existing documents, and full vacuum does not apply a new codec policy.
Sample data can be created with the standalone `seed-test-database.mts` script;
the Lab has no sample creation or reset action.

The Data tab provides individual checkboxes, a visible-page checkbox,
**Select visible rows**, and **Select entire collection**. The latter includes
unloaded pages and ignores the local grid filter; its scope appears in the
selection bar and confirmation. Selection clears on collection/database changes
and manual reload. Unchecking a row while the entire collection is selected
changes the scope to loaded rows, with a notification.

**Delete selected** and **Edit field** require confirmation. Field editing sets
one existing field to a JSON string, finite number or boolean on every target.
It excludes primary IDs and image fields. Every target is checked for existence,
field presence and safe index-key size before mutations begin. Bulk routes are
`POST /api/documents/:collection/bulk-delete` and `bulk-edit`, accepting either
`{all: true}` or `{ids: [...]}`; edits additionally accept `field` and `value`.
Numeric IDs retain their type through these routes and SQL mutations.
Engine mutations run sequentially with one final commit;
this does not add transaction rollback for unexpected failures midway through a
batch. The UI reloads current data after either success or failure.

**Refresh overview** reloads collections, document counts, loaded records and
database status, invalidates cached storage figures and shows completion/error
feedback. It is available on both database and collection overviews. Refresh
does not compact or shrink the database. The top-right menu retains background
compaction and full vacuum; the manual incremental-step action has been removed.
Routine daemon request, seeding, search and compaction progress output is silent;
errors remain available in the terminal and through the existing UI feedback.

## Exact document addresses

The frontend addresses individual documents with JSON-encoded query parameters:

```typescript
const address = new URLSearchParams({ collection: JSON.stringify(collection), id: JSON.stringify(id) });
// GET or DELETE: /api/document?{address}
// GET metadata: /api/document/metadata?{address}
// POST field edit or replacement: /api/document/edit?{address}
```

The edit body remains `{ field, value }` or `{ document, compression? }`.
GET `/api/document` returns `{ document }`; `encoded=true` requests the existing
encoded representation. IDs `""`, `"metadata"`, `"edit"`, `"."`, `".."`, punctuation
and Unicode use the same routes. JSON `42` and `"42"` retain their distinct types;
the backend enforces the collection's primary ID type. Malformed surrogate IDs
and invalid address types return input errors before mutation.

Collection operations use `/api/documents?collection=<JSON string>` for listing
and insertion, with `/bulk-delete`, `/bulk-edit`, `/search`, `/search/photos` and
`/search/image` suffixes. `/api/collection?collection=<JSON string>` deletes the
exact collection; `/indexes`, `/storage` and GET `/compression` suffixes expose
its settings. Encode query values with `URLSearchParams`, including collection
names that are empty, dot segments or contain URL punctuation.

Ordinary legacy `/api/documents/:collection/...` and
`/api/collections/:collection/...` routes remain supported. Legacy path IDs have
no type tag, so their numeric interpretation follows the persisted primary index.
Use the canonical query addresses to preserve explicit ID types and all names.

For cursor listing, request `/api/documents?collection=<JSON string>&iterableKey=<field>&limit=<positive integer>` and pass the returned opaque `nextCursor` unchanged as the `cursor` parameter. Tokens include the complete logical index key, so repeated secondary values progress by document ID and deletion of the saved entry retains its next surviving successor. Tokens are versioned and bound to their exact collection and field; invalid, legacy bare-value or duplicated cursor parameters return HTTP 400. `hasMore: false` omits `nextCursor`. Commit/reopen and physical relocation retain logical continuation. These pages are not snapshots; indexed-value updates can move documents across the saved position. The grid continues using offset pagination, and explicit sorting also uses offset mode. Cursor and offset parameters cannot be combined.

## Integration boundaries

The frontend uses the existing HTTP router, `DatabaseService`, and
`ConversationalService`. Database engine algorithms and unmerged feature
branches are unchanged. Engine CRUD type declarations now also accept numeric
IDs, matching their underlying storage methods.

| UI area                   | API routes                                                                                                   | Behavior                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Connection dialog/menu    | `/api/connect`, `/api/create`, `/api/disconnect`, `/api/status`                                              | Opening, demo creation, switching and disconnecting                                                            |
| Explorer, grid and drawer | `/api/collections`, `/api/documents/:collection`, document edit/delete/metadata routes, collection `indexes` | Collection deletion, document CRUD, field Indexed settings, images and pagination                              |
| Query Language            | `/api/query`                                                                                                 | SELECT, INSERT, UPDATE, DELETE and EXPLAIN SELECT; writes require confirmation                                 |
| Semantic Search           | Document `search`, `search/photos`, `search/image`; `/api/embeddings/status`, `/api/embeddings/preload`      | MiniLM text search and CLIP photo/image search                                                                 |
| Compression and Lab       | `/api/compression/defaults`, `/api/compression/recommendation`, `/api/compression/lab/*`                     | Persisted defaults, per-write overrides, advice and reports; fixture seeding remains available through the API |
| Maintenance menu          | `/api/database/status`, `/api/database/vacuum`, `/api/database/incremental-compaction/*`                     | Full vacuum and background compaction                                                                          |
| AI Chat/schema/settings   | `/api/conversational/*`, `/api/settings`, `/api/settings/gemini-key`                                         | Key-free schema introspection and editing; configured Gemini chat                                              |

Document lists expose `{documents, total, hasMore, nextCursor?}` and accept
`limit` and `offset`. The grid sorts and filters the loaded documents; its count
distinguishes those documents from the full collection. Storage and vacuum
figures use data-file bytes. WAL bytes remain separately available through the
status API.

Database/collection generations and operation-specific request versions prevent
late responses from replacing a different database, collection, or reopened
editor. Service operations share a database queue; helpers called while holding
that queue must use the unlocked methods.

## Current backend limits

- Documents contain scalar fields and supported binary/image values. Nested
  objects, null fields and general arrays are unsupported.
- Ordinary scalar fields default to secondary indexes, controlled by persisted
  collection-field **Indexed** settings. Disable indexing for long text through
  Fields or the document editor. The backend rejects oversized encoded keys
  before writes, including UTF-8 and composite ID overhead. Compression does
  not shorten index keys. All eligible text contributes to semantic embeddings,
  including unindexed and underscore-prefixed fields. The Lab configures its
  title-only B+ tree policy explicitly.
- SQL INSERT/UPDATE/DELETE support string and numeric IDs. The bundled **SQL
  Reference** opens beside the editor and from the connection dialog, without an
  open database or internet connection. Its source also generates the
  [query-language README](../query/README.md) through `npm run docs:sql`.
- Gemini chat requires an API key; schema introspection works without one.
  MiniLM/CLIP require their model assets. Chart rendering falls back to its
  result table when Chart.js is unavailable.

## Validation

Regression tests cover API payloads, temporary-file connection switching, CRUD,
index-key validation, compression defaults/reports, vacuum rollback, incremental
maintenance, schema persistence, request contexts and editor helpers.

An actual daemon and Chrome were also exercised using disposable databases:
CRUD, SQL/EXPLAIN, real MiniLM and CLIP searches, delayed-response/editor races,
compression, pagination, maintenance, demo seeding, optional-service failures,
disconnecting and opening another database. No browser test framework or
dependencies were added. Gemini-backed conversations were not exercised with a
live key.
