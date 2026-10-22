# Licences

This inventory records the licence declarations available in the current checkout. The npm versions and licences below
were checked against installed package metadata on 2026-10-22. Rust versions come from `hnsw-native/Cargo.lock` and
their licence declarations were checked against the crates.io version API on 2026-10-20. This file does not replace
upstream licence texts or grant rights to third-party assets.

## Project licence status

The root npm package is `siftwelldb` version `1.0.1`. It is private and declares `ISC` in `package.json`, but this
checkout has no root `LICENSE` text. `hnsw-native/` has no npm manifest and its `Cargo.toml` declares neither `license`
nor `license-file`.

Project-authored TypeScript, Rust, scripts and configuration are distinct from third-party images and model weights. The
maintained libraries in `hnsw-native/prebuilt/` are build products of the local Rust source. Generated databases, build
output and benchmark reports can contain imported content whose rights remain separate from the software's licence
metadata.

## Direct npm dependencies

These versions match `package.json` and the installed packages. The lockfile records the transitive dependency set; this
table covers direct dependencies only.

| Runtime package             | Version  | Declared licence |
| --------------------------- | -------- | ---------------- |
| `@emnapi/runtime`           | `1.10.0` | `MIT`            |
| `@google/genai`             | `2.0.1`  | `Apache-2.0`     |
| `@huggingface/transformers` | `4.3.1`  | `Apache-2.0`     |
| `dotenv`                    | `17.4.2` | `BSD-2-Clause`   |
| `koffi`                     | `2.15.2` | `MIT`            |

| Development package   | Version   | Declared licence |
| --------------------- | --------- | ---------------- |
| `@eslint/js`          | `9.39.0`  | `MIT`            |
| `@types/node`         | `24.10.0` | `MIT`            |
| `@vitest/coverage-v8` | `4.1.12`  | `MIT`            |
| `eslint`              | `9.39.0`  | `MIT`            |
| `prettier`            | `3.6.2`   | `MIT`            |
| `random`              | `5.4.1`   | `MIT`            |
| `tsx`                 | `4.20.6`  | `MIT`            |
| `typescript`          | `5.9.3`   | `Apache-2.0`     |
| `typescript-eslint`   | `8.48.0`  | `MIT`            |
| `vitest`              | `4.1.12`  | `MIT`            |

Local declaration files in `src/types/` are project-authored typing shims. They do not change the licence of the
upstream package they describe. In particular, `google-genai.d.ts` is not a separately bundled third-party typing
package.

## Direct Rust dependencies

Both dependencies are used by the native HNSW implementation. Their licence expressions below are package metadata, with
the actual licence texts available from the upstream source distributions.

| Crate        | Locked version | Declared licence    | Version metadata                                              |
| ------------ | -------------- | ------------------- | ------------------------------------------------------------- |
| `fastrand`   | `2.3.0`        | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/api/v1/crates/fastrand/2.3.0)   |
| `rustc-hash` | `2.1.2`        | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/api/v1/crates/rustc-hash/2.1.2) |

## Browser libraries and embedding models

The frontend loads Chart.js with the major-version selector `@4` from jsDelivr; Chart.js declares MIT. The semantic-map
example loads D3 with `@7`; D3 declares ISC. Those selectors do not pin an exact patch release. A generated `map.html`
retains the map's runtime dependency.

The default embedding models are `Xenova/all-MiniLM-L6-v2` and `Xenova/clip-vit-base-patch32`. Model weights and their
source datasets have their own terms. The licence of Transformers.js does not establish the rights to every model it can
load. Consult the specific model repository and its upstream model card before redistribution or a different use.

## Images and local datasets

The comprehensive demo reads local inputs from `examples/assets/images/photos/`, `gallery/` and `memes/`. These
directories are ignored by Git and are preserved as local source datasets. They are separate from generated temporary
demo databases.

The photos and gallery are selected Flickr8k images. The retained `photos/Flickr8k-NOTICE.txt` requests citation of M.
Hodosh, P. Young and J. Hockenmaier's 2013 paper, _Framing Image Description as a Ranking Task: Data, Models and
Evaluation Metrics_. Photo captions remain associated with their original filenames. The notice is an attribution
record, not a complete per-photograph redistribution licence. The local meme collection does not include a complete
record of individual creators or licences.

The bundled animal photographs in `examples/assets/images/` and `examples/assets/rabbit.jpg` come from the WordPress
Photo Directory and are distributed under CC0. [The source manifest](examples/assets/images/sources.json) records each
file's source page, photographer, licence and SHA-256 digest. The standalone image-search example uses these local files
without downloading additional photographs.

The captures in `docs/media/` show the actual application using synthetic records. The HNSW photo-search GIF and its
matching screenshot show four Flickr8k photographs from the demo whose individual Creative Commons licences were
verified. Those two media files are distributed under CC BY-SA 2.0, with source credits and modification details in
[the media guide](docs/media/README.md#hnsw-photo-search). The other captures use original geometric illustrations.

The CC0 records cover the bundled animal fixtures only. Check individual asset rights before redistributing locally
supplied datasets, screenshots containing them or populated databases.
