# Rust engine (experimental)

This folder holds an optional Rust engine for gbrain. Nothing in gbrain uses it yet. Today it is a
small Node-API addon that proves the pieces a Rust engine needs: that Bun can load it, call it,
cancel its work, survive its panics and shut it down cleanly. You do not need Rust to build, test
or run gbrain.

## What you need

[rustup](https://rustup.rs). That is all. It reads `rust/rust-toolchain.toml` and installs the
pinned Rust version (with `clippy` and `rustfmt`) the first time you build.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Build the addon

From the repo root:

```sh
bun run rust:build
```

It prints the path of the built file and the line to export:

```
Built /path/to/gbrain/rust/target/addon/gbrain_engine.linux-x64-glibc.node
Point gbrain at it with:

  export GBRAIN_RUST_ENGINE_ADDON=/path/to/gbrain/rust/target/addon/gbrain_engine.linux-x64-glibc.node
```

Run that `export` line in your shell. If cargo is missing the command stops with install
instructions and writes nothing. The build always goes to `rust/target/`: the command passes
`--target-dir`, so `CARGO_TARGET_DIR` and a `build.target-dir` setting are ignored and it never
packages an older library from another build directory.

## Check it works under Bun

```sh
bun rust/smoke/run.ts
```

It runs each check and prints `ok` or `FAIL`, then exits 0 only if all passed. It covers:

- the metadata the addon reports (target, ABI, build hash, catalog version);
- a JavaScript timer still firing while a native task runs;
- typed arrays: sum, scale into a new array, scale in place, offset views, empty arrays, async
  calls copying their input before they return, and a view of a `SharedArrayBuffer` being refused;
- a panic, sync or async, becoming a normal `Error` with `code: 'internal_error'` while the next
  call still works;
- a cancelled task rejecting with `code: 'cancelled'` and `completedSteps`;
- shutdown cancelling queued tasks, waiting a bounded time for running ones, then rejecting later
  calls with `code: 'engine_shutdown'`, from the moment `shutdown()` returns;
- a pool's worker count staying between 1 and 256, and a pool collected without `shutdown()`
  stopping its workers;
- the bounded callback queue answering `queue_full` and `closing` and losing nothing it accepted;
- a child process calling `process.exit(0)` while native work runs (must exit 0 at once);
- a `bun build --compile` executable loading the addon and passing the same core checks.

It is a plain script, not a `bun test` file, because the repo's test preloads can strip
`GBRAIN_*` variables.

The same checks run in CI on Linux x64 and macOS arm64 (`.github/workflows/rust-engine.yml`).

## Everyday commands

Run these in `rust/`:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo deny check      # licenses, sources, advisories; needs `cargo install cargo-deny --locked`
```

## Build times

Measured on an 8-core, 30 GB Linux x64 machine with the crates already downloaded (a cold first
build also downloads them, which depends on your network):

| What | Time |
| --- | --- |
| First release build from an empty `target/` (`bun run rust:build`) | 8.7 s (20 s of CPU) |
| First `cargo test` from an empty `target/` | 7.3 s |
| First `cargo clippy --all-targets` from an empty `target/` | 3.6 s |
| Edit one source file, then `bun run rust:build` | 0.7 s |
| Edit one source file, then `cargo test` | 0.4 s |

The first rustup install of the pinned toolchain is extra and was not timed. `rust/target/` is
ignored by git.

## What `engineBuild` is

The addon reports `engineBuild`, a SHA-256 of the Rust sources it was built from, so a loader can
tell two builds apart. It hashes, in sorted path order, each file under `rust/` as
`path NUL length NUL bytes`. It leaves out `target/`, `bench/`, `smoke/`, `scripts/`, `deny.toml`,
`.gitignore` and every `*.md`, so changing the README or a smoke test does not change the build.
The rule lives in `crates/gbrain-napi/build.rs`.

## Error codes

Errors from the addon are real `Error` objects with a `code`:

| Code | When |
| --- | --- |
| `cancelled` | A queued or running task was cancelled. Carries `completedSteps` and `started`. |
| `internal_error` | Rust code panicked. Carries a `diagnosticId`; the panic text is not sent to the caller. |
| `engine_shutdown` | A call arrived after shutdown began. |

A typed-array argument of the wrong type, or a view of a `SharedArrayBuffer`, throws the
standard Node-API `InvalidArg` error before any Rust code reads it. The addon decides by asking
the runtime (`napi_is_arraybuffer` on the view's buffer): anything the runtime does not call a
plain `ArrayBuffer`, or cannot answer for, is refused, so hiding `SharedArrayBuffer` or swapping a
prototype in JavaScript changes nothing. Rust reads and writes the accepted arrays through relaxed
atomic cells and never builds a slice over them, which is only sound for memory no other thread
can reach.

## Good to know

- A pending native task keeps a process alive. If a script ends without `process.exit()` while a
  pool still has work, it exits only after that work finishes (the smoke test measures this and
  prints the result). Call `pool.shutdown(waitMs)` or `process.exit()` to leave early.
- `new Pool(workers)` starts 1 to 256 threads. If the system refuses a thread, it throws
  `internal_error` and stops the threads it started.
- The callback queue (`Sink`) holds 4 values. That size is fixed at compile time by napi-rs.
- `rust/bench/` is a separate workspace and is not part of this one.
- gbrain's addon loader (`src/core/rust-engine/addon-loader.ts`) uses `GBRAIN_RUST_ENGINE_ADDON`
  first, then an addon cached under `<gbrain home>/engines/rust/` whose SHA-256 matches this
  release's cached manifest. It does not download anything: with no cached addon it refuses with
  `rust_engine_addon_missing`, reason `not_installed`. Nothing starts the loader yet (ENGINES.md,
  "The Rust engine shell").
- To go back to the normal gbrain path, `unset GBRAIN_RUST_ENGINE_ADDON`.
- `GBRAIN_TEST_BACKEND=rust bun test <file>` arrives with the Rust test arm in a later change. It
  does not exist yet.
