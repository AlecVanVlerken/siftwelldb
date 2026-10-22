# Webclient media

These files show the actual webclient running with demo-generated records. The search results come from stored native
HNSW indexes, using locally cached MiniLM and CLIP models.

## HNSW photo search

The photo-search recording was captured in Chrome on 22 October 2026. It uses the production demo seeder and four
photographs already in `examples/assets/images/photos/`, with their original Flickr8k captions. This smaller demo has
97 documents across eight collections. The database stores the image bytes and builds the same CLIP image index as
the full demo. The GIF lasts 22.4 seconds at 1280 × 800 pixels.

| File                                                               | View                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [webclient-hnsw-photo-search.gif](webclient-hnsw-photo-search.gif) | Text-to-image searches and an uploaded-photo search in the demo's photos collection |
| [webclient-image-search.png](webclient-image-search.png)           | A still from the photo-search session                                               |

Changing the query changes the ranking of the same four stored photographs. Uploading one of those photographs searches
its image embedding directly. The recording uses the real search responses, result table and document view.

### Photo credits

The source pages identify these photographs and their licences. Filenames are relative to
`examples/assets/images/photos/`.

| Demo file                   | Photograph                                                                          | Photographer      | Licence                                                         |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------- |
| `3716272233_7845ec5b3e.jpg` | [Walking on Water 1](https://www.flickr.com/photos/8802700@N03/3716272233/)         | NaturesFan        | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)       |
| `197107117_4b438b1872.jpg`  | [O Teto do Bau...Imponente!!!](https://www.flickr.com/photos/groundzero/197107117/) | Leonardo Pallotta | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)       |
| `112178718_87270d9b4d.jpg`  | [Momento de Reflexão](https://www.flickr.com/photos/groundzero/112178718/)          | Leonardo Pallotta | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)       |
| `2394919002_ed7527ff93.jpg` | [pond run](https://www.flickr.com/photos/f_mafra/2394919002/)                       | Fernando Mafra    | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |

The photographs are resized in the results and document view. The GIF is resized and colour-reduced for playback. The
photo-search GIF and matching PNG are distributed under [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/),
with the credits above. This media licence covers those two files; the other local demo photographs and memes retain
their individual terms.

## Other captures

These captures show the webclient running with a small database on 20 October 2026. The database contains 176 documents,
including records from the demo generators and three original geometric illustrations stored as PNG fields. It uses the
same HTTP router, database service and storage implementation as the regular webclient.

Text search uses `Xenova/all-MiniLM-L6-v2` and image search uses `Xenova/clip-vit-base-patch32`, both running locally
with cached weights. The search results come from the stored HNSW indexes. Displayed timings describe this session
rather than a benchmark.

| File                                                   | View                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [webclient-tour.gif](webclient-tour.gif)               | Opening a database, browsing products, viewing a document and running SQL |
| [webclient-overview.png](webclient-overview.png)       | Collection counts and storage status                                      |
| [webclient-document.png](webclient-document.png)       | A product's fields and storage metadata                                   |
| [webclient-sql.png](webclient-sql.png)                 | Products grouped by category with average prices                          |
| [webclient-semantic.png](webclient-semantic.png)       | A text search about crash recovery                                        |
| [webclient-compression.png](webclient-compression.png) | Stored gzip defaults and codec advice for article bodies                  |

The screenshot database has 18 employees, 24 products, 48 orders, 31 knowledge articles, 16 longer articles, 16 travel
guides, 20 support tickets and three illustrations. The illustrations were drawn from SVG shapes and converted to PNG: a
red circle, a blue square and a green triangle on white backgrounds. No Flickr8k, Wikipedia or meme images appear in
these captures.

The GIF lasts about 14 seconds. Its frames were captured from Chrome, resized and encoded with a reduced colour palette.
Its connection dialog predates the database dropdown; the document, query and search views use the same layout.

## Reproducing the views

Run `npm run build` and `npm start`, then open a demo or a database containing sample records. Use `products` for the
Data and document views. For photo search, select `photos` in **Semantic Search** and use photo/text-to-image mode.
The recording searches for a white bird over water, a mountain climber and a child beside a pond, then uploads a stored
photo for image-to-image search.

The SQL capture runs:

```sql
SELECT category, COUNT(*) AS products, AVG(price) AS average_price
FROM products
GROUP BY category
ORDER BY average_price DESC
```

The text-search query is `How can a database recover changes after a crash?` in `knowledge`. The compression view uses
**Analyze field** on `articles.body`: its saved default is `gzip`, while the advisor compares six codecs and recommends
`zstd-fast` for that sample.
