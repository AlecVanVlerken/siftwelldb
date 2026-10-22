# SiftwellDB webclient

The webclient provides a browser interface for documents, queries, semantic search and storage maintenance. A Node.js
daemon serves the frontend and owns the open database. The browser sends HTTP requests to that daemon rather than
accessing the database file itself.

Build and start it from the repository root:

```sh
npm run build
npm start
```

Open [http://localhost:8000](http://localhost:8000). The connection dialog lists persistent databases in a dropdown.
Choose one and click **Open**, or enter a new name and click **Create database**. **Refresh** reloads the list.
**Create demo database** builds temporary sample collections.

## Persistent databases

Persistent webclient databases are stored in `databases/` at the project root, independently of the daemon's working
directory. The folder is created automatically. A database named `research` uses:

```text
databases/
├── research.db
├── research.db.log
└── research.db.model.json   # optional saved schema model
```

Names can contain letters, numbers, spaces, hyphens and underscores, with an optional `.db` suffix. The backend resolves
the filenames and companion files. Paths and reserved filenames are rejected. Opening requires an existing database;
creating one requires an unused name, including its WAL and model sidecars.

To use a database stored elsewhere, disconnect it first and move its data file, companion WAL and optional model file
into `databases/`, keeping their matching names. Click **Refresh** to find it. Temporary demos and test fixtures use
their own directories. Library callers can still supply explicit file paths.

## Temporary demo

The demo combines generated employee, product and order records with articles, travel guides, support tickets and local
images. It is useful for trying SQL, compression and semantic search on the same database.

| Collection      | Default documents | Contents                                            |
| --------------- | ----------------: | --------------------------------------------------- |
| employees       |               200 | Names, departments, salaries, ages and cities       |
| products        |               160 | Categories, brands, prices, stock and descriptions  |
| orders          |               400 | Product references, quantities, totals and statuses |
| knowledge       |                31 | Short articles on several topics                    |
| articles        |               240 | Longer text with titles, summaries and tags         |
| travel_guides   |                64 | Destinations, countries and descriptions            |
| support_tickets |               120 | Reported problems, priorities and resolutions       |
| photos          |               450 | Flickr8k images with supplied captions              |
| gallery         |               150 | Images without descriptive captions                 |
| memes           |               240 | Template names and images                           |

With all image inputs available, the defaults produce 2,055 documents. The number of imported images depends on the
valid files found locally.

The seeder uses the database API to insert documents, store image bytes and build indexes. Long article and travel-guide
bodies are unindexed by B+ trees and use gzip compression. Short metadata fields remain indexed. Tags and captions are
stored as strings because the document model does not support arrays.

Creation commits in batches, then reopens the database and checks the stored data before connecting the interface. The
progress dialog shows the collection and stage being processed. **Cancel** stops creation and removes the incomplete
temporary database. The first run can take longer while embedding models download.

### Local image sources

Place the image inputs under `examples/assets/images/`:

```text
examples/assets/images/
├── photos/
│   ├── *.jpg
│   ├── captions.json
│   └── Flickr8k-NOTICE.txt
├── gallery/
└── memes/
```

The six CC0 photographs directly inside `examples/assets/images/` belong to the standalone `npm run demo:images`
example. The webclient demo reads the three subfolders above.

`photos/captions.json` maps each filename to its five Flickr8k descriptions, in their original order. These become the
document's newline-separated `captions` field. Gallery images use different files and are stored without titles,
categories or descriptions, so their retrieval relies on image embeddings. Meme titles come from filenames. A checksum
suffix distinguishes different templates that had the same filename.

Discovery checks image headers and dimensions for JPEG, PNG and static WebP. It skips invalid or duplicate images and
orders photographs deterministically across caption-derived categories. The original image bytes are stored in the
database. Browsing an imported image therefore does not require its source file.

If the `photos/` folder is absent, discovery also accepts Flickr8k image/text folders and meme folders in the repository
root. The older caption format is `filename.jpg#0<TAB>description` in `Flickr8k.token.txt`.

The image sources are local inputs and are not downloaded by the demo generator. Missing required inputs stop creation
before the active connection changes. The Flickr8k notice requests citation of M. Hodosh, P. Young and J. Hockenmaier's
2013 paper, _Framing Image Description as a Ranking Task: Data, Models and Evaluation Metrics_. Individual photo and
meme redistribution rights are not fully recorded; see [licences.md](../../licences.md).

### Models and example queries

MiniLM produces 384-dimensional text embeddings. CLIP produces 512-dimensional image and text-to-image embeddings. Both
models load on demand and run locally once their assets are cached. Creating the demo and running semantic searches do
not require Gemini. AI Chat uses Gemini separately, while schema inspection works without an API key.

Eligible text fields contribute to the text embedding independently of their B+ tree settings. Long documents are not
split into chunks. Titles and summaries precede article bodies so they are included before the model's input limit is
reached. Searches return an approximate ranking within the selected collection.

In **Semantic Search**, try:

| Collection and mode          | Query                                        |
| ---------------------------- | -------------------------------------------- |
| articles, text               | How do databases organize information?       |
| travel_guides, text          | Interesting places to visit in the mountains |
| support_tickets, text        | I want my money back for a damaged item      |
| products, text               | Equipment for a rainy hiking trip            |
| photos, text                 | A dog running through a field                |
| photos, photo/text-to-image  | Children playing outdoors                    |
| gallery, photo/text-to-image | A person riding a bicycle                    |
| memes, photo/text-to-image   | A surprised face                             |

Text mode searches the document text with MiniLM. Photo mode uses CLIP to compare the query with stored image vectors.
Uploading an image in that mode runs an image-to-image search.

Run these SQL examples one at a time in **Query Language**:

```sql
SELECT department, AVG(salary) AS average_salary FROM employees GROUP BY department;
SELECT name, price FROM products WHERE price > 100 ORDER BY price DESC LIMIT 10;
SELECT status, COUNT(*) AS orders, SUM(total) AS revenue FROM orders GROUP BY status;
SELECT category, COUNT(*) AS total FROM articles GROUP BY category;
SELECT title, category FROM articles WHERE category = 'Technology' LIMIT 10;
SELECT title, category FROM photos WHERE category = 'Animals' LIMIT 10;
```

A separate collection can be used to try document writes:

```sql
INSERT INTO playground VALUES { id: 'my-test', title: 'A new camping backpack', quantity: 3, enabled: true };
UPDATE playground SET quantity = 9 WHERE id = 'my-test';
DELETE FROM playground WHERE id = 'my-test';
```

### Session lifetime

Temporary demos are stored in the operating system's temporary directory under `siftwelldb-demos/demo-<uuid>/`. Each
directory contains `demo.db`, its WAL and an ownership marker. Disconnecting or switching databases closes the database
and removes that directory.

The daemon has one active database shared by its browser tabs. Each demo tab renews a lease every 20 seconds. A lease
expires after 90 seconds without renewal, followed by a 60-second grace period after the last active tab leaves. This
allows a page reload while still cleaning up abandoned demos. A long browser suspension can therefore end a temporary
session.

A demo stays available while another tab has an active lease. Switching away or ending that shared session is blocked
until the other tabs leave it. On shutdown, the daemon closes and removes its demos. On startup, it can remove abandoned
outputs identified by ownership markers whose process is no longer running. Persistent databases and source images have
separate lifetimes.

### Keeping a demo database

To generate a persistent version, run:

```sh
npm run seed:test
```

This uses the same data generators, local images and embedding models. It writes
`databases/webclient-test.db` and its companion `.log`, refusing to overwrite existing output files. A different
database name can be supplied:

```sh
npx tsx scripts/seed-test-database.mts another-demo
```

Select the result in the database dropdown and click **Open**. It remains on disk after disconnection.

## Documents and field settings

The Data tab lists documents from the selected collection. The grid sorts and filters its loaded rows; the collection
count includes documents on other pages. Opening a document shows its fields and storage metadata. The editor can change
individual fields, replace a document or attach an image.

Documents contain strings, finite numbers, booleans and binary values. General arrays, nested objects and stored null
values are unsupported. Every document has a string or numeric ID, with one ID type per collection.

The editor fetches a fresh document with `editor=true`. Binary fields use `{"$binary":"canonical base64"}` so they can
be distinguished from strings in JSON. A replacement request sends `editor: true` to use this representation. Unchanged
binary fields and stored compression codecs are preserved. There is no version check on a replacement, so saving an
older editor snapshot can overwrite a change made elsewhere.

The **Indexed** setting belongs to a collection field. Disabling it removes that field's secondary B+ tree; enabling it
validates existing values and builds the index. The primary ID index is mandatory. Long text should be unindexed because
B+ tree keys must fit within a block. Compression affects stored payloads rather than index keys. Changing B+ tree
settings does not exclude text from semantic embeddings.

The selection bar offers **Select visible rows** and **Select entire collection**. The latter includes unloaded pages
and ignores the grid's local filter. Unchecking a row changes the selection back to loaded rows. **Delete selected** and
**Edit field** ask for confirmation. Bulk edits set one existing field to a string, finite number or boolean and exclude
IDs and images.

The backend checks target documents and index-key sizes before starting a batch. It then applies mutations sequentially
and commits the batch. A runtime failure has no statement-level rollback; the interface refreshes its data after either
success or failure.

## Compression

Each **Saved default** dropdown in Compression sets the codec for future writes to that field. **Analyze field** samples
up to 100 records and compares codecs without changing the default. Short values often receive `none` because their
compression would not save storage blocks.

**Recommend & save all defaults** analyzes the collection and saves its advised policy. **Reload saved defaults** reads
that policy again. Existing documents keep their stored codecs, including when full vacuum copies them.

The Lab compares compression policies for the selected collection. **Analyze collection** creates a report and **Save
advised defaults** applies the policy to future writes. Chart sizes are estimates of the compared policies.

## Collection deletion and maintenance

The overview reads collection counts from primary indexes rather than fetching all document bodies. **Refresh overview**
reloads those counts and storage metrics; it does not reload every image. Documents load when a collection is selected.
Storage metrics are cached between mutations, though calculating them after a write can require walking the free-block
list.

After a collection deletion is confirmed, the interface hides the collection and clears its selection. Cached data from
other collections stays available. New reads and writes may wait because deletion shares the database queue with them.
The waiting view resumes when deletion finishes. If deletion fails, the interface reloads the collection list from the
backend.

The queue serializes operations because collections share the allocator, WAL and native index resources. The frontend
tracks database and collection generations so a response from an older selection cannot replace the current view.

The maintenance menu offers background incremental compaction and full vacuum. Incremental compaction moves allocated
units into lower free blocks and trims a free file tail where possible. It preserves HNSW tombstones. Full vacuum copies
live documents into a new database and rebuilds indexes, removing tombstones.

During full vacuum, an overlay blocks editing and database switching until the replacement has been installed and
reopened. It shows phases such as copying, validation and reopening. Copy percentages refer to the named collection and
phase, so they can restart for the next collection. Phases without document counts show a spinner.

`GET /api/database/operations` returns in-memory progress metadata independently of the database queue. This lets the
browser observe maintenance while file handles are being replaced. Conflicting requests receive HTTP 409 with
`busyOperation: 'vacuum'`. If recovery cannot reopen a usable database, the interface returns to its disconnected state
with the error.

The [compaction guide](../compaction/README.md) explains relocation and vacuum recovery.
[Deletion and vacuum measurements](../../docs/webclient-performance.md) record the effect of reducing repeated record
reads.

## Exact document addresses

Document routes use JSON-encoded query parameters to preserve exact collection names and ID types:

```typescript
const address = new URLSearchParams({ collection: JSON.stringify(collection), id: JSON.stringify(id) });
// GET or DELETE: /api/document?{address}
// GET metadata: /api/document/metadata?{address}
// POST field edit or replacement: /api/document/edit?{address}
```

The edit body is `{ field, value }` or `{ document, compression? }`. GET returns `{ document }`; `encoded=true` requests
the encoded representation. JSON numbers and strings retain their types, including `42` and `"42"`. Empty IDs, dot
segments, Unicode and URL punctuation are passed through these query addresses.

Collections use `/api/documents?collection=<JSON string>` for listing and insertion. The `/bulk-delete`, `/bulk-edit`,
`/search`, `/search/photos` and `/search/image` suffixes select bulk or search operations.
`/api/collection?collection=<JSON string>` deletes a collection; `/indexes`, `/storage` and GET `/compression` expose
its settings. Use `URLSearchParams` to encode the values.

Legacy `/api/documents/:collection/...` and `/api/collections/:collection/...` paths are also supported. Their untyped
IDs are interpreted using the collection's primary index. Query addresses preserve explicit ID types and names that
cannot be represented reliably as path segments.

Document lists return `{ documents, total, hasMore, nextCursor? }`. Offset paging uses `limit` and `offset`. Cursor
paging uses `collection`, `iterableKey`, `limit` and the previous `nextCursor` as `cursor`. Tokens identify the complete
logical index key, including its ID tie-breaker. They survive commit/reopen and physical relocation, but do not
represent a snapshot. Cursor and offset parameters cannot be combined; the browser grid uses offset paging.

## Integration boundaries

`ApiRouter` handles HTTP requests and delegates database work to `DatabaseService`. That service owns the connection and
operation queue. `ConversationalService` handles schema models and Gemini chat. Schema inspection works without a key;
chat produces read-only SQL. Charts use Chart.js and fall back to a result table when the library is unavailable.

| UI area              | API routes                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Connection           | `/api/databases`, `/api/connect`, `/api/create`, `/api/disconnect`, `/api/status`                                    |
| Temporary demo       | `/api/demo/create`, `/api/demo/status`, `/api/demo/cancel`, `/api/demo/heartbeat`, `/api/demo/release`               |
| Documents and fields | Collection/document routes, bulk operations and collection `indexes`                                                 |
| Query Language       | `/api/query`                                                                                                         |
| Semantic Search      | Document search routes, `/api/embeddings/status`, `/api/embeddings/preload`                                          |
| Compression and Lab  | `/api/compression/defaults`, `/api/compression/recommendation`, `/api/compression/lab/*`                             |
| Maintenance          | `/api/database/status`, `/api/database/operations`, `/api/database/vacuum`, `/api/database/incremental-compaction/*` |
| AI Chat and settings | `/api/conversational/*`, `/api/settings`, `/api/settings/gemini-key`                                                 |

The SQL reference is bundled in the frontend and opens beside the editor or from the connection dialog. Its source,
`frontend/sql-reference.json`, also generates the [query README](../query/README.md) through `npm run docs:sql`.

`GET /api/databases` returns `{ databases: [{ name, filename }] }`. `POST /api/connect` and `POST /api/create` take
`{ name }`, plus the demo session identifiers when switching away from a demo. Filepaths are resolved on the daemon;
these endpoints do not accept arbitrary paths. Status responses retain the resolved filepath for backend integration.

## Tests

Run `npx vitest run src/webclient` from the repository root. Tests cover HTTP payloads, document and index operations,
connection switching, temporary demos, compression, maintenance, recovery and frontend request state.

Demo tests use small generated images and controlled embeddings. They check caption association, stored binary values,
semantic indexes and cleanup without requiring the external datasets or pretrained model downloads.
