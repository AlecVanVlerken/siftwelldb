# Native HNSW

This Rust crate builds a C-compatible shared library loaded by Koffi. It does not
use Node-API bindings, generated JavaScript wrappers, or an npm package of its own.

`prebuilt/` contains the maintained Windows (`hnsw_native.dll`) and Linux
(`libhnsw_native.so`) libraries. Source runs load these files; the TypeScript build
copies them to `build/indexes/hnsw/prebuilt/`. Keep the prebuilt files until you
have built and tested replacements. macOS requires a local `.dylib` build.

To rebuild for your platform, run from this directory:

```sh
cargo build --release
cargo test
```

Copy the resulting shared library from `target/release/` into `prebuilt/`, then
run `npm run build` and `npm test` from the repository root. Cargo's `target/`
directory is generated and ignored.

The previous machine-specific MinGW setup is retained as
`.cargo/config.windows-gnu.toml.example`. Copy it to `.cargo/config.toml` and adapt
the tool paths if you need that target. Keep local machine paths untracked. Its
`target-cpu=native` setting optimizes for the build machine; choose CPU settings
appropriate to the machines where you will run a redistributed binary.
