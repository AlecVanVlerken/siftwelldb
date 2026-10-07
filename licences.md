# Licences

This file is a repository-specific licence inventory for the current codebase state. It records what can be verified from version-controlled manifests, installed package metadata, and dependency metadata fetched from the package managers on 2026-05-14. It does not replace upstream `LICENSE` files.

## Project licence status

- The root npm package `simpledbms` in `package.json` is marked `"private": true` and declares `"license": "ISC"`.
- The repository does not currently include a root `LICENSE` file with the ISC licence text.
- `hnsw-native/package.json` also declares `ISC`.
- `hnsw-native/Cargo.toml` currently does not declare a Rust `license` or `license-file`, so the Rust manifest is not fully aligned with the npm metadata for that subproject.

## First-party code and generated artifacts

- Files under `src/`, `tests/`, `scripts/`, `examples/`, and `benchmarks/`, including local declaration files under `src/types/`, `hnsw-native/src/`, and the repository configuration files are first-party project code.
- `hnsw-native/prebuilt/hnsw_native.dll` and `hnsw-native/prebuilt/libhnsw_native.so` are generated binaries built from the local `hnsw-native/` source tree.
- Generated outputs such as `build/`, `hnsw-native/target/`, `map.html`, `testdb`, benchmark result files under `benchmarks/**/results/`, and database or WAL files such as `demo-db/*.data` and `demo-db/*.wal` are outputs of this repository's code. They do not add separate third-party software licences by themselves.

## Local typing shims

- `src/types/google-genai.d.ts` is a project-authored ambient TypeScript declaration used so the repository can type-check and lint its `@google/genai` integration cleanly.
- That declaration file is first-party repository code. It is not a bundled upstream typing package and it does not change the underlying licence of `@google/genai`, which remains `Apache-2.0`.

## Direct runtime npm dependencies

When this file was written, `npm ls --depth=0` reported that `@emnapi/core`, `@emnapi/runtime`, `@google/genai`, and `dotenv` were declared in `package.json` but missing from the current `node_modules` snapshot. Their licence metadata below was therefore verified via the npm registry instead of local package files.

| Package                     | Version  | Licence        | Verification         |
| --------------------------- | -------- | -------------- | -------------------- |
| `@emnapi/core`              | `1.10.0` | `MIT`          | npm registry         |
| `@emnapi/runtime`           | `1.10.0` | `MIT`          | npm registry         |
| `@google/genai`             | `2.0.1`  | `Apache-2.0`   | npm registry         |
| `@huggingface/transformers` | `3.8.1`  | `Apache-2.0`   | local `node_modules` |
| `dotenv`                    | `17.4.2` | `BSD-2-Clause` | npm registry         |
| `koffi`                     | `2.15.2` | `MIT`          | local `node_modules` |

## Direct development npm dependencies

| Package               | Version   | Licence      | Verification         |
| --------------------- | --------- | ------------ | -------------------- |
| `@eslint/js`          | `9.39.0`  | `MIT`        | local `node_modules` |
| `@napi-rs/cli`        | `3.6.0`   | `MIT`        | local `node_modules` |
| `@types/node`         | `24.10.0` | `MIT`        | local `node_modules` |
| `@vitest/coverage-v8` | `4.0.6`   | `MIT`        | local `node_modules` |
| `eslint`              | `9.39.0`  | `MIT`        | local `node_modules` |
| `prettier`            | `3.6.2`   | `MIT`        | local `node_modules` |
| `random`              | `5.4.1`   | `MIT`        | local `node_modules` |
| `tsx`                 | `4.20.6`  | `MIT`        | local `node_modules` |
| `typescript`          | `5.9.3`   | `Apache-2.0` | local `node_modules` |
| `typescript-eslint`   | `8.46.2`  | `MIT`        | local `node_modules` |
| `vitest`              | `4.0.6`   | `MIT`        | local `node_modules` |

## Direct Rust dependencies

Rust dependency metadata was verified with `cargo metadata --manifest-path hnsw-native/Cargo.toml`.

| Crate        | Version | Licence             |
| ------------ | ------- | ------------------- |
| `fastrand`   | `2.3.0` | `Apache-2.0 OR MIT` |
| `rustc-hash` | `2.1.2` | `Apache-2.0 OR MIT` |

## Browser-side libraries loaded from CDNs

The browser UI and generated semantic map load some libraries directly from jsDelivr instead of through `package.json`.

| Location                            | Library    | Version selector in repo | Licence | Notes                                                          |
| ----------------------------------- | ---------- | ------------------------ | ------- | -------------------------------------------------------------- |
| `src/webclient/frontend/index.html` | `Chart.js` | `@4`                     | `MIT`   | The repo pins the major version, not an exact patch release.   |
| `examples/semantic-map/renderMap.mts`   | `D3`       | `@7`                     | `ISC`   | The generated `map.html` inherits the same runtime dependency. |

## Assets without complete licence metadata in the repo

The image demo implementation in `examples/semantic-image-search.mts` downloads sample animal images from Wikipedia. It resolves an animal name through the Wikipedia REST summary API and then downloads the returned `thumbnail` or `originalimage` asset into `examples/assets/images/`.

The repository still does not record per-file source page URLs or licence terms for the committed image files themselves, so this document does not assign a licence to those assets.

Assets affected by that limitation include:

- `examples/assets/rabbit.jpg`
- files under `examples/assets/images/`

## What this file does not claim

- It does not inline every transitive npm dependency licence. The authoritative transitive dependency set is pinned in `package-lock.json` and depends on the exact install state.
- It does not infer per-file licence terms for bundled images when the repository does not record them.
- It does not replace the actual upstream licence texts for third-party packages.
