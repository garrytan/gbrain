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

## The brain store

`new addon.Brain(pool)` is one brain on disk, opened with `open` and run on the pool you pass it, so
the event loop is never blocked. The records live in a directory (`~/.gbrain/brain.rust/` in the
design): `FORMAT` (JSON: `format_version`, `engine_abi`, `catalog_version`, `schema_version`,
`brain_id`, `created_by`) and `records.redb`. The store is `crates/gbrain-store`: redb behind a
narrow key-value trait (`kv.rs`); only `redb_kv.rs` names redb. This is a bake-off store: its keyword and title
search is a port of PostgreSQL's english full-text search and `ts_rank`, and matches PGLite (`docs/store/keyword.md`).

Rules for every method:

- Arguments and results are plain JSON-shaped values. Dates are ISO strings with microsecond
  precision (`2026-08-10T12:00:00.000123Z`), never `Date`; the TypeScript wrapper converts. A result
  is `null` where the PGLite method returns `null`.
- Every call returns a promise. A failure rejects with an `Error` whose `code` is in the table
  below. A call on a closed brain rejects `store_closed`.
- One process owns a brain. A second `open`, from this process or another, rejects `store_locked`
  while the first is open; nothing is waited for.
- `FORMAT` is read before the records are opened. A `format_version` this build does not read
  (`addon.formatVersions` lists them) rejects `format_unknown` and nothing is written. A missing
  `FORMAT` is rebuilt from the records. Every format number, its upgrade and what an older build
  does with a newer brain are in [`docs/store/format.md`](docs/store/format.md).
- Multi-user mode (off by default) adds commit positions, an optional commit log written with the
  data (store format 13) and write origins on journal rows: [`docs/store/commit-log.md`](docs/store/commit-log.md).

### Lifecycle

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `new Brain(pool)` | the handle, closed | `PGLiteEngine` constructor |
| `brain.open(path, options?)` | `{ brain_id, format_version, schema_version, created }` | `connect` and `initSchema` |
| `brain.close()` | `undefined`; a closed handle is a no-op | `disconnect` |
| `brain.info()` | the same record as `open` | `readBrainIdentity` (`persistence/identity.ts`) |
| `brain.isOpen` | `boolean` (a getter, not a promise) | none |

`options` is `{ schemaVersion?: number, createdBy?: string, concurrentWrites?: boolean,
embeddingModel?: string, embeddingDimensions?: number, chunkStrategy?: string,
writeGateDetectorVersion?: number }`. `schemaVersion` is what a fresh brain stores as config
`version`; pass `LATEST_SCHEMA_VERSION`. `embeddingModel`, `embeddingDimensions` and `chunkStrategy`
are config entries a fresh brain records ([docs/store/config.md](docs/store/config.md));
`writeGateDetectorVersion` is the detector version of the write gate's scan baseline;
`concurrentWrites` lets many write transactions run at once (off unless true or
`GBRAIN_RUST_CONCURRENT_WRITES=1`). `close` waits for calls already running, then gives up the lock.

### Methods by family

Each family of store methods is documented in its own file under [`docs/store/`](docs/store/),
one file per family, so documenting a new family adds a file and edits nothing here. The
families, their files and their key tags are listed in
[docs/designs/RUST_ENGINE_INTERFACES.md](../docs/designs/RUST_ENGINE_INTERFACES.md).

### Deterministic simulation

`crates/gbrain-store/tests/sim.rs` runs the store on redb over `gbrain-sim`'s fault-injecting disk. A
seed fixes three simulated clients (put, journaled write, replay, tag, soft delete, restore, delete,
chunks, version, admit, finish, link, batch link, unlink, walk, backlinks, timeline entry, timeline
batch, timeline read), the clock and ids the store sees, and where the disk crashes, tears
a write, fails an fsync or lies about one. After a reboot the recovered records must equal the
replay of a prefix of the acknowledged commits (nothing lost, the batch in flight all or nothing),
and the store's own invariants must hold: id index, chunks against postings, index totals, journal
index and outstanding counters, each link against its three index keys and its pages, and each
timeline entry against its dedup key, its page and the page's newest-entry time. A control run (every fsync lies, the checker is told the disk was
honest) must report violations, or the harness is blind.

```sh
cd rust
cargo test -p gbrain-store --test sim -- --nocapture          # 200 seeds per kind
GBRAIN_SIM_SEEDS=10000 cargo test --release -p gbrain-store --test sim -- --nocapture crash fsync control
GBRAIN_SIM_SEED=1234 cargo test -p gbrain-store --test sim     # repeat one seed
```

### Fact fingerprints and property tests

Withdrawals and purge tombstones match claims by fingerprint, so the Rust `fact_fingerprint` and
`fact_fingerprint_v1` must equal the SQL functions byte for byte. `crates/gbrain-store/tests/fixtures/fact_fingerprints.json`
holds PGLite's answers: `lower()` and `[[:space:]]` for every code point, and both fingerprints for a
corpus of hand-written claims (every whitespace class, Turkish I, sharp s, final sigma, ligatures,
combining marks, NFC/NFD pairs, RTL, CJK, emoji, long text) plus seeded random ones. The Rust tests
check every per-character port and both fingerprints against it, plus proptest properties.
`test/fact-fingerprint-corpus.test.ts` fails when the fixture is stale and, on Postgres, prints where
the host's `lower()` or `[[:space:]]` differs from PGLite (a glibc host counts U+1680 and not U+0085).

```sh
bun rust/scripts/fact-fingerprint-fixture.ts           # check the fixture against PGLite
bun rust/scripts/fact-fingerprint-fixture.ts --write   # rewrite it after a deliberate change
```

Other proptest suites: `crates/gbrain-store/tests/store_props.rs` (put then get, delete leaves no
row, a withdrawn claim stays withdrawn after reopen) and `crates/gbrain-napi/src/boundary_props.rs`
(hostile JSON never panics a Brain method); `rust/smoke/cases.ts` fuzzes the built addon from
JavaScript. proptest is a dev-dependency with default features off, so it writes no files.

## Error codes

Errors from the addon are real `Error` objects with a `code`:

| Code | When |
| --- | --- |
| `cancelled` | A queued or running task was cancelled. Carries `completedSteps` and `started`. |
| `internal_error` | Rust code panicked. Carries a `diagnosticId`; the panic text is not sent to the caller. |
| `engine_shutdown` | A call arrived after shutdown began. |
| `store_locked` | Another handle or process has the brain open. |
| `format_unknown` | `FORMAT` or the format record is not a version this build reads. Nothing was written. |
| `store_closed` | The brain is not open on this handle. |
| `store_io` | The file system or the storage engine failed; the write did not commit. |
| `store_corrupt` | The records fail their integrity check, or `FORMAT` names another brain. |
| `invalid_state` | The call does not fit the handle's state (`open` on an open handle), or `finishWrite` met a request that already ended. |
| `snapshot_cancelled` | `snapshotTo` was cancelled with `snapshotCancel`. It removed what it wrote and released its read before it rejected. |
| `read_only_transaction` | A write inside a read-only transaction (Postgres SQLSTATE `25006`). Nothing was written. |
| `unmodeled_input` | An input written in a form the store does not read the way Postgres does (a resolved date with a zone followed by an offset such as `PST+1`, or a date after 2037 in a zone with daylight saving time). Nothing was written; the engine refuses the call as `engine_capability_missing`, naming the member and the input. |
| `invalid_argument` | A malformed argument. |
| `invalid_slug` | The slug failed `validateSlug`. |
| `source_not_found` | A page write named a source that does not exist. |
| `page_not_found` | `addTag`, `addPageTagsById`, `createVersion`, `addLink` or `addTimelineEntry` named a page that does not exist. |
| `page_ambiguous` | `readPageSnapshot` under `requireUnambiguous` found more than one readable page for the identifier. The addon rejects with this code. The TypeScript wrapper converts it to `PageSnapshotAmbiguousError` in `src/core/rust-engine/store-errors.ts` where that mapping exists; master's wrapper does not have it yet, so there the code stays on the error. |
| `constraint_violation` | A write breaks a table constraint PGLite enforces: a `linkSource` outside its CHECK, or a `deletePage` whose origin clear collides with another link. |
| `revision_conflict` | `expectedRevision` does not match the page. |
| `revision_required` | The page exists and the caller sent `force: false` without `expectedRevision`. |
| `empty_overwrite` | A blank body would replace a page that has content. |
| `origin_claimed` | A page write or `restorePage` would make a second live page of a source recording one `source_path`. The message is JSON (`source_id`, `source_path`, `holders`, `slug`); the binding maps it to `page_identity_changed`. |
| `source_changed` | `sourceIncarnation` is not the source's current incarnation. |
| `idempotency_conflict` | A request id was used for different content. |
| `admission_refused` | The principal or the brain has too many unfinished writes. |
| `writer_rejected` | A local writer registration is revoked, or its lane or credential does not match. |
| `writer_not_initialized` | The brain has no persistence identity. |

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
  `rust_engine_addon_missing`, reason `not_installed`. `gbrain engine install rust` downloads, checks
  and installs the addon a release publishes (ENGINES.md, "Installing the addon"); releases build it
  with `rust/scripts/release-addon.ts` in `.github/workflows/release.yml`.
- To go back to the normal gbrain path, `unset GBRAIN_RUST_ENGINE_ADDON`.
- `GBRAIN_TEST_BACKEND=rust bun test <file>` arrives with the Rust test arm in a later change. It
  does not exist yet.
