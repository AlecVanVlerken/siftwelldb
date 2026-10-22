# Native HNSW

The HNSW implementation is a Rust library with a C-compatible interface. TypeScript loads it through Koffi, collects
changed graph nodes from the native index and persists the graph and vectors in the database file.

`prebuilt/` contains the maintained x86-64 Windows (`hnsw_native.dll`) and Linux (`libhnsw_native.so`) libraries. Source
runs load these files; the TypeScript build copies them to `build/indexes/hnsw/prebuilt/`. macOS requires a local
`.dylib` build; other CPU architectures also need a matching local library.

To rebuild for your platform, run from this directory:

```sh
cargo build --release
cargo test
```

Copy the resulting shared library from `target/release/` into `prebuilt/`, then run `npm run build` and `npm test` from
the repository root. Cargo's `target/` directory is generated and ignored.

`.cargo/config.windows-gnu.toml.example` provides an example MinGW configuration. Copy it to `.cargo/config.toml` and
adapt the tool paths for your installation. Its `target-cpu=native` setting optimizes for the build machine; choose CPU
settings appropriate to the machines where you will run a redistributed binary.
