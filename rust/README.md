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
narrow key-value trait (`kv.rs`); only `redb_kv.rs` names redb. This is a bake-off store: keyword
search is a plain BM25 and is not search parity with PGLite (design D5).

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
  `FORMAT` is rebuilt from the records.

### Lifecycle

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `new Brain(pool)` | the handle, closed | `PGLiteEngine` constructor |
| `brain.open(path, options?)` | `{ brain_id, format_version, schema_version, created }` | `connect` and `initSchema` |
| `brain.close()` | `undefined`; a closed handle is a no-op | `disconnect` |
| `brain.info()` | the same record as `open` | `readBrainIdentity` (`persistence/identity.ts`) |
| `brain.isOpen` | `boolean` (a getter, not a promise) | none |

`options` is `{ schemaVersion?: number, createdBy?: string }`. `schemaVersion` is what a fresh brain
stores as config `version`; pass `LATEST_SCHEMA_VERSION`. `close` waits for calls already running,
then gives up the lock.

### Config

A fresh brain has one config entry, `version`, set to the `schemaVersion` given to `open`
(`getConfig('version')` equals `LATEST_SCHEMA_VERSION`, 319 today). Values are strings and keys
cannot contain NUL.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getConfig(key)` | `string \| null` | `getConfig` |
| `brain.setConfig(key, value)` | `null`; an upsert | `setConfig` |
| `brain.unsetConfig(key)` | rows removed, `0` or `1` | `unsetConfig` |
| `brain.listConfigKeys(prefix)` | sorted `string[]`; the prefix is literal (`%` and `_` are plain characters) | `listConfigKeys` |
| `brain.getAllConfig()` | `{ [key]: value }` | `getAllConfig` |

### Sources

A fresh brain has the `default` source: `{ id: 'default', name: 'default', local_path: null,
last_sync_at: null, config: { federated: true } }`. A row is PGLite's `SourceRow` plus
`incarnation` (a UUID that changes when a source is deleted and created again), with
`last_sync_at` as an ISO string.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listAllSources({ includeArchived?, localPathOnly? }?)` | `SourceRow[]`, `default` first then by `id`; archived rows are left out unless `includeArchived`; `localPathOnly` keeps rows with a `local_path` that are not `config.role = 'storage_manifest'` | `listAllSources` |
| `brain.getSourceById(id)` | `SourceRow \| null`, archived rows included | `sources-ops` read by id |
| `brain.upsertSource({ id, name?, local_path?, last_sync_at?, config? })` | the `SourceRow`; only the fields given change; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `sources add` |
| `brain.updateSourceConfig(id, patch)` | `boolean`, whether the source exists; `patch` is merged one level deep, and a `null` value is kept as JSON `null` (it does not remove the key) | `updateSourceConfig` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists | `sources archive` and `restore` |

`upsertSource` and `setSourceArchived` are not in PGLite's engine interface; the store needs a way
to make a source, and the page methods below are source-scoped.

### Pages

Pages are keyed `(source_id, slug)`; `sourceId` defaults to `default`, and a source that does not
exist rejects `source_not_found`. Slugs go through PGLite's `validateSlug` (`invalid_slug`) and are
lower-cased. A `Page` is PGLite's `Page` plus `page_kind`; every date (`created_at`, `updated_at`,
`updated_at_iso`, `deleted_at`, `effective_date`, `ingested_at`) is an ISO string with microseconds
(`2026-08-10T12:00:00.000123Z`) or `null`, and the TypeScript wrapper turns them into `Date`.
A page's `knowledge_revision` is a UUID that changes when its type, kind, title, body, timeline,
frontmatter, deletion or tags change. `text_projection_revision` is `null` until chunks are
installed for that revision. `listPages` and `resolveSlugs` scan every page; there are no
secondary indexes yet.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageSnapshot(slug, { sourceId?, sourceIds?, includeDeleted? }?)` | `{ page, tags, revision, sourceIncarnation, withdrawals: [] }` or `null`. `sourceIds` wins over `sourceId`; with neither, the first match, `default` first | `readPageSnapshot` |
| `brain.putPage(slug, page, { sourceId?, allowEmptyOverwrite?, expectedRevision?, force?, chunks?, index? }?)` | the stored `Page`. By default the store also installs chunks and seals the page (see "Chunks and keyword search"); `index: false` writes the page alone, which is what the TypeScript engine always passes, as PGLite's `putPage` writes no chunks | `putPage` |
| `brain.listPages(filters?)` | `Page[]` (default `limit` 100). Filters: `type`, `tag`, `updated_after`, `updatedAfterKeyset { updatedAt, slug }`, `slugPrefix` (literal), `excludeSlugPrefixes`, `slugAfter`, `sourceId`, `sourceIds`, `includeDeleted`, `sort` (`updated_desc` default, `updated_asc`, `created_desc`, `slug`) | `listPages` |
| `brain.countPages({ sourceId? }?)` | number of live pages | `countPages` |
| `brain.lockPageKeys([{ sourceId, slug }])` | `null`. One process owns the brain and one write runs at a time, so keys are already held; it checks the keys are well formed | `lockPageKeys` |
| `brain.resolveSlugs(partial, { sourceId?, sourceIds? }?)` | `[slug]` for the exact live slug, else `[]`. Exact only: PGLite goes on to a fuzzy title match this store does not have, so `[]` means "no exact match", and the TypeScript engine refuses `engine_capability_missing` instead of returning it | `resolveSlugs` (exact half) |
| `brain.softDeletePage(slug, { sourceId? }?)` | `{ slug }` or `null` | `softDeletePage` |
| `brain.restorePage(slug, { sourceId? }?)` | `boolean` | `restorePage` |
| `brain.deletePage(slug, { sourceId? }?)` | `null`; removes the page and its versions | `deletePage` |
| `brain.getTags(slug, { sourceId?, sourceIds? }?)` | sorted `string[]` | `getTags` |
| `brain.addTag(slug, tag, { sourceId? }?)` | `null`; `page_not_found` for a missing page | `addTag` |
| `brain.removeTag(slug, tag, { sourceId? }?)` | `null`; no error when the page or tag is absent | `removeTag` |
| `brain.createVersion(slug, { sourceId? }?)` | the version row; `page_not_found` for a missing page | `createVersion` |
| `brain.getVersions(slug, { sourceId?, sourceIds?, limit?, includeBody? }?)` | version rows, newest first; `includeBody: false` leaves out `compiled_truth` and `timeline` | `getVersions` |

`putPage` follows PGLite:

- `content_hash` is the caller's, else SHA-256 of the canonical `{ title, type, compiled_truth,
  timeline, frontmatter, tags }` envelope. Two sample pages hash the same as the TypeScript
  `contentHash`; parity for every JSON number and string is not proven, so a caller that needs it
  passes `content_hash`.
- An update clears `deleted_at`, sets `updated_at` and keeps `effective_date`,
  `effective_date_source`, `import_filename`, `source_path`, `source_kind`, `source_uri`,
  `ingested_via` and `ingested_at` when the new write leaves them out.
- A blank `compiled_truth` over a page that has content rejects `empty_overwrite` unless
  `allowEmptyOverwrite`.
- `expectedRevision` is `undefined` (no check), `null` (the page must not exist) or a UUID. A
  mismatch rejects `revision_conflict`; `force: false` with no `expectedRevision` over an existing
  page rejects `revision_required`. `force: true` skips the check and cannot be combined with
  `expectedRevision`. The check sees soft-deleted pages.
- Tags are not part of `putPage`; `addTag` and `removeTag` change them, as in PGLite.

### Chunks and keyword search

A page's text is indexed as chunks (`chunk_source` is `compiled_truth`, `timeline`, `fenced_code` or
`image_asset`; a chunk is one record plus one posting per word). The store's own `putPage`, unless it is
given `index: false`, installs the chunks in the same transaction as the page: `opts.chunks` when the
caller passes `ChunkInput[]`, otherwise the built-in chunker (paragraphs packed to about 1500 characters;
simpler than the TypeScript chunker). The TypeScript engine does not use that: its `putPage` passes
`index: false` and writes no chunks, and only `sealChunks` (or `upsertChunks` with `seal: true`) seals.
`upsertChunks` without `seal` never seals. Sealing sets `text_projection_revision = knowledge_revision`.
Search serves only pages in that state, as PGLite does, so a tag change, soft delete or restore hides a
page from search until the store's indexing `putPage` or a seal indexes it again. Vectors are not stored; `embedding` is
`null`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.putPage(slug, page, { ..., chunks? })` | as above; `chunks` replaces the page's chunks | `putPage` plus `upsertChunks` |
| `brain.upsertChunks(slug, chunks, { sourceId?, expectedRevision?, seal? }?)` | `null`; writes the page's chunks as PGLite does: chunks not in `chunks` are removed, a chunk whose text is unchanged keeps the metadata the write leaves null, an empty list unseals the page. `page_not_found`, `revision_conflict` (`expectedRevision` only checks), `invalid_argument` for a bad `chunk_source`. With `seal: true` the chunks replace the old ones outright and are sealed to the page's revision (PGLite's `sealChunks`) | `upsertChunks` |
| `brain.getChunks(slug, { sourceId?, sourceIds?, includeDeleted? }?)` | `Chunk[]` in index order, `embedding: null`; `[]` unless the page is sealed at its current revision; the slug is matched as written; soft-deleted pages are read, as PGLite reads them. The TypeScript engine refuses more than one distinct `sourceIds` entry | `getChunks` |
| `brain.deleteChunks(slug, { sourceId? }?)` | `null`; the page stays | `deleteChunks` |
| `brain.countChunks()` | number of chunks in the brain | none |
| `brain.searchKeyword(query, opts?)` | `SearchResult[]` (`slug, page_id, title, type, source_id, chunk_text, chunk_source, chunk_id, chunk_index, score, stale`, plus `effective_date` when set). `stale` is PGLite's rule: the page's `updated_at` is older than the newest `created_at` of its timeline entries | `searchKeyword` |

`searchKeyword` is not parity with PGLite. Ranking is BM25 over chunks with index-wide statistics
(`k1` 1.2, `b` 0.75), not the Postgres `ts_rank`, so scores and order differ. There is no stemming;
the English stop words are dropped from the query (a query of only stop words keeps them); each CJK
character is its own term; `websearch` syntax (quotes, `or`, `-`) is not interpreted. Like PGLite:
every term must match, a page is one result represented by its best chunk, order is `score DESC,
page_id ASC, chunk_id ASC`, `limit` defaults to 20 and is clamped to 100, soft-deleted pages,
archived sources and image chunks are hidden, `test/`, `attachments/` and `.raw/` slugs are hidden
(`include_slug_prefixes` opts back in; `exclude_slug_prefixes` adds to them), and `type`, `types`,
`exclude_slugs`, `sourceId`, `sourceIds` (wins), `detail: "low"` (compiled-truth chunks), `language`
and `symbolKind` filter. `where`, `afterDate` and `beforeDate` reject `invalid_argument` instead of
being ignored. A query reads the posting list of every term, so cost grows with the number of
matching chunks.

### Links, graph and timeline

Links and timeline entries are typed key-value records with their own index keys. Every write
changes a record and all of its index keys in one transaction, so a crash keeps all of them or
none (the simulation below checks this). The new key tags are additive; `FORMAT_VERSION` stays 1.

| Key | Value | Mirrors |
| --- | --- | --- |
| `L from_page_id link_id` | the link record (JSON) | a `links` row, stored under the page it leaves |
| `l to_page_id link_id` | `from_page_id` | the backlink index |
| `O origin_page_id link_id` | `from_page_id` | the links a page authored (`origin_page_id`) |
| `U from to link_type \0 link_source origin` | `link_id` | `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)`; a NULL source or origin has its own encoding |
| `E page_id date entry_id` | the entry record (JSON) | a `timeline_entries` row; one reverse scan is `ORDER BY date DESC, id DESC` |
| `D page_id date sha256(summary) source` | `entry_id` | the `(page_id, date, md5(summary), source)` dedup index (another digest, the same rule) |
| `G page_id` | newest `created_at` of the page's entries | what `stale` compares with |

Ids are integers from a counter, like a Postgres serial. A timeline add that hits the dedup key still
takes an id, as `INSERT .. ON CONFLICT DO NOTHING` does, so the ids `getTimeline` returns match
PGLite. `deletePage` removes the links that leave or reach the page and its timeline entries
(`ON DELETE CASCADE`) and clears the origin of links it authored (`ON DELETE SET NULL`). When that
clear would collide with another link, `deletePage` rejects `constraint_violation` and changes
nothing, as PGLite does. A soft-deleted page hides every edge it touches, as an endpoint or as
the origin.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.addLink(from, to, { context?, linkType?, linkSource?, originSlug?, originField?, fromSourceId?, toSourceId?, originSourceId? }?)` | `null`. The positional arguments of `addLink` in one object. Repeating a link updates its context. `page_not_found` for a missing endpoint; `constraint_violation` for a `linkSource` outside PGLite's CHECK; a missing origin is dropped (`origin_slug` `null`, `origin_field` kept) | `addLink` |
| `brain.addLinksBatch(links)` | inserted count; rows with a missing endpoint are skipped | `addLinksBatch` |
| `brain.removeLink(from, to, { linkType?, linkSource?, fromSourceId?, toSourceId? }?)` | removed count. An absent filter matches every value; `null` matches nothing, as `= NULL` does | `removeLink` |
| `brain.getLinks(slug, { sourceId?, sourceIds? }?)` / `brain.getBacklinks(...)` | `{ from_slug, from_source_id, to_slug, to_source_id, link_type, context, link_source, origin_slug, origin_source_id, origin_field }[]`; slugs match exactly | `getLinks` / `getBacklinks` |
| `brain.traverseGraph(slug, depth?, { sourceId?, sourceIds?, frontierCap? }?)` | `{ slug, source_id, title, type, depth, links: [{ to_slug, link_type }] }[]`, outgoing walk, default depth 5, each page once at its shallowest depth, at most 20,000 pages | `traverseGraph` |
| `brain.traversePaths(slug, { depth?, direction?, linkType?, sourceId?, sourceIds? }?)` | `{ from_slug, from_source_id, to_slug, to_source_id, link_type, context, depth }[]`; `direction` `out` (default), `in` or `both`; each edge once | `traversePaths` |
| `brain.traversePathsDetailed(slug, opts?)` | `{ paths, truncated }`; at most 5,000 edges, `truncated` when more exist | `traversePathsDetailed` |
| `brain.addTimelineEntry(slug, { date, summary, source?, detail? }, { sourceId?, skipExistenceCheck? }?)` | `true` when a row was written, `false` for a duplicate (same page, date, summary and source) | `addTimelineEntry` |
| `brain.addTimelineEntriesBatch(entries)` | inserted count; entries of missing pages are skipped | `addTimelineEntriesBatch` |
| `brain.getTimeline(slug, { limit?, after?, before?, sourceId?, sourceIds? }?)` | `{ id, page_id, date, source, summary, detail, event_page_id, created_at }[]`, `date DESC, id DESC`, default `limit` 100, `0` for all | `getTimeline` |

Where this engine differs from PGLite:

- `traversePathsDetailed` orders by `(depth, from_slug, to_slug, from_source_id, to_source_id)` as
  PGLite does, then by `link_type` and link id where PGLite's order is undefined. Two links that
  differ only in origin show once, the one with the lowest id.
- Dates: `YYYY-MM-DD` or `YYYY/MM/DD`, optionally followed by `T` or a space and a time that is
  ignored (`2026-01-05T23:30:00-05:00` is `2026-01-05`, as in PGLite). Other spellings Postgres
  casts are refused `invalid_argument`, as is a date that does not exist.
- `getTimeline` rows carry the `TimelineEntry` fields only, not the write-provenance and
  `trust_tier` columns of the table (PGLite returns them `null` and `"unknown"` for these writes).
- `excludePrivate: true`, `temporal`, `page` (keyset paging of paths) and `eligibility` reject
  `invalid_argument` instead of being ignored. The TypeScript shell must not send them here.

`crates/gbrain-store/tests/graph_parity.rs` replays PGLite's own results for links, the graph
walks at depth 0 to 3 and past (cycles, direction, scope, soft delete, caps), timeline writes and
reads, and `stale`, and compares every step exactly. The fixture is
`tests/fixtures/graph-parity.json`, written by `bun rust/scripts/graph-parity-golden.ts` from the
repository root; `--check` fails when it is stale. Rebuild it when PGLite's behavior changes. The
fixture is part of the build hash; `rust/scripts/` is not.

### The write journal

`submitPageMutation` is the write path for pages: admit, apply and commit in one transaction, so a
page, its chunks and postings, the version snapshot of what it replaced and the committed request
are all there after a crash or none of them are. It ports the semantics of
`src/core/persistence/` (`journal.ts`, `page-mutations.ts`, `identity.ts`), not its SQL. There are no
leases, claims, recovery records, worktree fences or refresh deferral: one process owns the brain
and one write runs at a time, and nothing here publishes files.

A request is identified by `(principal.kind, principal.id, requestId)`. `requestId` is a UUID (absent:
the store mints one; a client's non-UUID id goes in `clientRequestId`). Repeating a request with the same
content returns the stored receipt and writes nothing; other content is `idempotency_conflict`. The
digest covers the operation, source, slug and the page and options as sent. Each principal may have 100
unfinished requests and the brain 1000 (`admission_refused`; `limits` overrides them). A request ends
once, in `committed`, `conflict`, `failed` or `cancelled`; `deferred` and `recovering` are accepted
states a receipt reader may meet but nothing here enters them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.submitPageMutation({ principal, requestId?, clientRequestId?, sourceIncarnation?, slug, page, options?, authority? }, limits?)` | the receipt. `state: "committed"` with `status` (`created`, `updated`, `unchanged`), `slug`, `page_id`, `source_id`, `knowledge_revision`, `content_hash`, `chunks`, `version_id`. A write that fails on its own terms (`revision_conflict`, `revision_required` end `conflict`; `empty_overwrite`, a bad chunk or date end `failed`) changes nothing, resolves a receipt with `write_error` and `write_error_message`, and returns that same receipt when repeated. `invalid_argument`, `invalid_slug`, `source_not_found`, `source_changed`, `idempotency_conflict`, `admission_refused` and `store_*` reject and record nothing | `submitPageMutation` |
| `brain.admitWrite(admission, limits?)` | the stored `WriteRequest` (`id, principal_kind, principal_id, request_id, client_request_id, operation, source_id, source_incarnation, page_id, slug, digest, intent, authority, sequence, state, outcome, error_code, error_message, blocked_reason, compacted, created_at, updated_at, completed_at`); `queued` when new, the stored one when repeated | `admitWrite` |
| `brain.getWriteRequest(principal, requestId)` | the `WriteRequest` or `null` | `getWriteRequest` |
| `brain.getWriteReceipt(principal, requestId)` | the receipt (`outcome` fields, `outcome`, `request_id`, `client_request_id?`, `state`, `write_error?`, `write_error_message?`, `blocked_reason?`, `created_at`, `updated_at`) or `null` | `receiptFor` |
| `brain.finishWrite(principal, requestId, { state, outcome?, errorCode?, errorMessage?, blockedReason? })` | the receipt; `invalid_state` for a request that already ended or a non-terminal state | none |
| `brain.journalOutstanding()` | `{ brain, principals }`, unfinished requests | none |
| `brain.getBrainIdentity()` | `{ brain_id }` | `readBrainIdentity` |
| `brain.registerLocalWriter({ id, lane, credentialHash, grantCeiling? })` | the writer row `{ id, lane, credential_hash, grant_ceiling, created_at, revoked_at }`. Idempotent; `writer_rejected` for a revoked row, another lane or credential under the id, or a credential registered under another id | `registerLocalWriterValue` |
| `brain.readLocalWriter(id)` | the writer row or `null` | `verifyLocalWriter` read |
| `brain.revokeLocalWriter(id)` | `true` when the registration exists | `revokeLocalWriter` |

The credential itself never reaches the store: callers pass its SHA-256. `write_error_message` and
`journalOutstanding` are additions; the TypeScript receipt keeps a separate failure detail row that
this engine does not have.

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
| `invalid_argument` | A malformed argument. |
| `invalid_slug` | The slug failed `validateSlug`. |
| `source_not_found` | A page write named a source that does not exist. |
| `page_not_found` | `addTag`, `createVersion`, `addLink` or `addTimelineEntry` named a page that does not exist. |
| `constraint_violation` | A write breaks a table constraint PGLite enforces: a `linkSource` outside its CHECK, or a `deletePage` whose origin clear collides with another link. |
| `revision_conflict` | `expectedRevision` does not match the page. |
| `revision_required` | The page exists and the caller sent `force: false` without `expectedRevision`. |
| `empty_overwrite` | A blank body would replace a page that has content. |
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
  `rust_engine_addon_missing`, reason `not_installed`. Nothing starts the loader yet (ENGINES.md,
  "The Rust engine shell").
- To go back to the normal gbrain path, `unset GBRAIN_RUST_ENGINE_ADDON`.
- `GBRAIN_TEST_BACKEND=rust bun test <file>` arrives with the Rust test arm in a later change. It
  does not exist yet.
