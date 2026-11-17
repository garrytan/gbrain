# Rust engine: family interfaces

**Status:** frozen for the parallel build toward 1x parity (Rust answers match today's PGLite and Postgres answers).
**Parent design:** [RUST_ENGINE.md](RUST_ENGINE.md). **Store contract:** [rust/README.md](../../rust/README.md), "The brain store".

The Rust engine serves BrainEngine members from its own key-value store. Every member it does not serve refuses
with the typed `engine_capability_missing` error. This document cuts the rest of the work into **families**: a
family is a set of BrainEngine members plus the records they own. Each family has its own files on every layer,
so several people can each build a family at the same time without editing the same file and without waiting on
the core store work.

What this document freezes:

1. The shared contracts every family uses: errors, key layout, write transactions, row encoding, timestamps, text
   order and score tolerance.
2. The files each family owns, and the few shared files no family edits.
3. Each family's members, records, parity cases and dependencies.
4. The order of work toward Dec 1.

What it does not freeze: the shape of the single napi `Brain` class, the `STORE_MEMBERS` spread in
`store-members/index.ts`, and the names of the codec helpers. Core can change those without notice to families, as
long as each family's own files keep working.

## How to build a family

Every family already has an empty file on each layer. Building a family means filling in those files and nothing
else.

| Layer | File | What goes in it |
|---|---|---|
| Store | `rust/crates/gbrain-store/src/<module>.rs` | `impl Store { pub fn ... }` methods, the family's record structs, key builders for the bytes after its tag, and its unit tests. |
| Page delete | the same file, `remove_page_rows` | Only for families that keep records under a page (the "Cascade" column below). Deletes those records when a page is hard deleted. |
| Core hooks | the same file, the hook functions core put there | Only for families that core's hooks call ("Core hooks" below). Fill in the body; never change the signature. |
| Binding | `rust/crates/gbrain-napi/src/families/<module>.rs` | One `#[napi] impl Brain { ... }` block. Each method decodes its arguments and calls one `Store` method through `self.run`. |
| TypeScript | `src/core/rust-engine/store-members/<file>.ts` | One exported `StoreMember` per BrainEngine member the family serves, named after the member. Row decoders and helpers stay unexported. |
| Expected differences | `test/rust-expected-divergence/<family>.tsv` | Only if a parity case may differ from PGLite. Create the file; never edit another family's file. |
| Store docs | `rust/docs/store/<family>.md` | The family's methods, arguments and results, in the style of the existing files there. |

A member is served the moment its family file exports it: `index.ts` already spreads every family module into
`STORE_MEMBERS`, and `RustEngine` installs every entry. A member that is not exported keeps refusing. The
capability a member belongs to (`src/core/rust-engine/members.ts`) does not change; `servedCapabilities()` reports
a capability only once every member of it is served, so a capability whose members sit in several families turns
on when the last of them lands.

After a family lands members, regenerate the parity coverage file with `bun test/engine-parity/coverage.ts --write`
(never hand-merge `test/engine-parity/coverage.tsv`), and run the parity suite on the Rust arm
(`GBRAIN_TEST_RUST_ARM=1`). A case whose members are all served must now match PGLite; a case that still reaches a
refused member must still end on that refusal.

### Shared files no family edits

These files belong to core. If a family needs a change in one of them, it asks core for the change in a separate,
small commit. Every other file in the table at the end belongs to exactly one family.

- `rust/crates/gbrain-store/src/{lib.rs,keys.rs,kv.rs,redb_kv.rs,env.rs,error.rs,format.rs,cascade.rs,page_columns.rs,test_support.rs}`
- `rust/crates/gbrain-store/src/{pages.rs,sources.rs,config.rs,chunks.rs,search.rs,links.rs,timeline.rs,journal.rs}`
  (the families core already built)
- `rust/crates/gbrain-napi/src/{lib.rs,store_binding.rs,binding.rs,error.rs,pool.rs}` and `families/mod.rs`
- `src/core/rust-engine/{members.ts,store.ts,store-codec.ts,store-errors.ts,store-capabilities.ts,errors.ts}`,
  `store-members/{index.ts,common.ts}` and the store-member files of the families core built
- `src/core/error-registry.ts`, `docs/guides/error-codes.md`, `rust/README.md`
- `test/engine-parity/{harness.ts,rust-arm.ts,coverage.ts}`, `test/rust-engine-shell.test.ts`,
  `test/rust-engine-store.test.ts`, `test/rust-arm-harness.test.ts`

The list files (`lib.rs`, `families/mod.rs`, `index.ts`, `cascade.rs`, `page_columns.rs`, the reserved block in
`keys.rs`) already name every planned family once, so no family edits them.

## Shared contracts (frozen)

### Errors and the typed refusal

- **Refusal.** A member, option or input the engine cannot answer exactly as PGLite does throws
  `engine_capability_missing` naming its capability, with `member=<name>` and `written=nothing` in the detail. Use
  the helpers in `store-members/common.ts`: `takeOptions` refuses an option the store does not read,
  `refuseMember` refuses an input. A refused call writes no store data: refuse before the first write, or let the
  single store transaction roll back.
- **Store codes** (Rust `gbrain-store/src/error.rs`, passed to JavaScript unchanged): `store_locked`,
  `format_unknown`, `store_io`, `store_corrupt`, `store_closed`, `invalid_argument`, `invalid_slug`,
  `source_not_found`, `revision_conflict`, `revision_required`, `page_not_found`, `constraint_violation`,
  `empty_overwrite`, `idempotency_conflict`, `admission_refused`, `writer_not_initialized`, `writer_rejected`,
  `source_changed`, `invalid_state`.
- **Binding codes** (`gbrain-napi/src/error.rs`): `cancelled`, `internal_error`, `engine_shutdown`.
- **gbrain codes** for store failures: `rust_store_locked` (from `store_locked`), `rust_store_unreadable` (from
  `format_unknown`, `store_corrupt`, `store_io`). `store_closed` maps to `engine_closed`.
- **No new codes from families.** A family uses the codes above. A table CHECK or unique key PGLite enforces is
  `constraint_violation`; a malformed argument is `invalid_argument`. If PGLite throws a member-specific error (a
  message naming the member, a typed error class), the family builds it in its own TypeScript file: catch the store
  error by code around `storeCall` and throw the PGLite-shaped error there. `store-errors.ts` keeps only the shared
  mapping. A family that truly needs a new store code asks core, which adds it to both `error.rs` files,
  `rust/README.md`, `src/core/error-registry.ts` and `docs/guides/error-codes.md` in one commit.

### Key layout

Keys are byte strings compared byte by byte. The first byte is the tag.

| Tag | Records | Owner |
|---|---|---|
| `M` | meta: format record and id counters (`M next_<name>`) | core |
| `C` | config | core |
| `S` | sources | core |
| `P` / `I` | page by `(source, slug)` / page id to page key | core (pages) |
| `K` | chunk by `(page id, chunk index)` | core (chunks) |
| `T` | keyword postings | core (search) |
| `V` | page versions | core (versions) |
| `J` / `j` | journal requests | core (journal) |
| `W` | local writers | core (journal) |
| `L` / `l` / `U` / `O` | links from / to / unique key / origin | core (links) |
| `E` / `D` / `G` | timeline entries / dedup / latest | core (timeline) |

Rules:

- Ids are big-endian `u64` (`keys::id_key`, `keys::page_id`). A chunk index is a big-endian `u32`. Text parts are
  UTF-8 joined by a `0x00` byte (`keys::text`); a text part never contains `0x00`.
- **One tag per family.** Each planned family has one reserved tag below (also in `keys.rs`, one constant per
  family). Every byte after the tag belongs to the family's module, which documents its sub-layout in its header.
  Use a second byte as a sub-table marker when the family has more than one table (for example `F 0x01 <id>` for
  rows and `F 0x02 <source> 0x00 <entity> 0x00 <id>` for an index).
- **Never reuse, reorder or repurpose a byte.** A family that is not listed takes an unused byte in a reviewed
  change to the reserved list. Byte `0x00` belongs to the storage engine adapter.
- **Id counters are family-prefixed:** `M next_<family>_id` through `pages::next_id(tx, "next_fact_id")`.
- **A family writes only its own tag.** To read another family's records it calls that family's `pub(crate)`
  functions (for pages: `read_page`, `read_page_by_id`, `all_pages`, `scope_sources`, `find_in_scope`). To change
  them it calls that family's `pub(crate)` write helpers (for pages: `write_page`; for links: the link helpers in
  `links.rs`). If the helper does not exist, ask core; never write a core tag directly.
- **Per-page state goes under the family's tag, keyed by page id**, not into the core page record. Examples:
  extraction stamps (`e <page id>`), emotional weight (`s <page id>`), alias rows (`k ...`). The family reads the
  page record and joins its own record. A value `getPage` must return (such as `emotional_weight`) goes out through
  the family's `page_columns` hook ("Core hooks"). The family keeps the value under its own tag; until it adds the
  column, the page read returns the fixed default in `PAGE_ROW_DEFAULTS` (`store-codec.ts`). No family edits
  `PAGE_ROW_DEFAULTS`, `store-codec.ts` or `pages.rs`.
- **Format.** `FORMAT_VERSION` 1, `engineAbi` 1, a `FORMAT` file plus `records.redb`. New tags and new records under
  them do not change the format version: an older build never reads a tag it does not know, and a newer build reads
  an absent tag as "no rows". A family that changes the encoding of records that already exist on disk asks core.

Reserved tags:

| Family | Tag | Constant | Cascade on page delete |
|---|---|---|---|
| page_ops | `p` | `PAGE_OPS` | no |
| extraction | `e` | `EXTRACTION` | yes |
| aliases | `k` | `ALIAS` | yes |
| page_body | `b` | `PAGE_BODY` | yes |
| facts | `F` | `FACT` | no |
| ontology | `N` | `ONTOLOGY` | no |
| takes | `A` | `TAKE` | yes |
| contradictions | `Q` | `CONTRADICTIONS` | no |
| dream | `Y` | `DREAM_VERDICT` | no |
| eval_capture | `Z` | `EVAL_CAPTURE` | no |
| code_edges | `H` | `CODE_EDGE` | yes |
| salience | `s` | `SALIENCE` | yes |
| stats | `n` | `INGEST_LOG` | no |
| raw_files | `r` | `RAW_FILES` | yes |
| link_queries | `q` | `LINK_QUERIES` | no |
| timeline_queries | `u` | `TIMELINE_QUERIES` | no |
| keyword | `R` | `TRIGRAM` | no |
| chunk_queries | `c` | `CHUNK_QUERIES` | no |
| vectors (core) | `X` | `VECTOR` | yes |
| embeddings (core) | `B` | `EMBEDDING_STATE` | yes |
| transactions (core) | `w` | `LOCK_QUEUE` | no |
| relations (core) | `v` | `RELATION_CATALOG` | no |

### Page delete cascade

`pages::remove_page` deletes a page's versions, chunks, postings, links and timeline entries, then the event
projections that name the page (`timeline_queries::remove_event_projections`, below), then calls
`cascade::remove_page_rows`, which calls `remove_page_rows(tx, page)` in each family marked "yes" above. Today every
one of those hooks is empty. A family fills in only its own hook, inside the same write transaction, so the page and
everything under it go together or not at all. Soft delete never cascades: reads hide rows whose page has
`deleted_at` set, as PGLite's `deleted_at IS NULL` joins do. `files.page_id` is SET NULL in Postgres, so the raw_files
hook clears the page reference on file rows instead of deleting them.

Facts are not cascaded on page delete (Postgres keys them by slug, not by page id); facts reads hide facts whose page
is soft deleted. Source delete is not served by the Rust engine yet; when core serves it, core adds a
`cascade::remove_source_rows` list the same way.

### Core hooks

Core calls each hook below from its own write or read path, in the same transaction or snapshot, through one list
file that names every family that needs the hook. Each listed family already has the hook function in its own
file, with an empty body. A family fills in only its own body, and never changes a signature or a list. A family
that is not on a list and needs the hook asks core for a one-line addition to the list.

All hooks are empty today, so they change no answer: every served member reads and writes exactly as before.

#### Page columns (`page_columns.rs`)

```rust
// In salience.rs, aliases.rs, extraction.rs and page_body.rs:
pub(crate) fn page_columns(read: &dyn KvRead, page: &PageRecord, columns: &mut PageColumns) -> Result<()>;
// PageColumns:
pub(crate) fn set(&mut self, name: &str, value: Value);
```

- **When it runs:** `getPage`, `readPageSnapshot` (its `page`) and `listPages`, once per page returned, on the same
  read snapshot. `putPage` does not run it: PGLite's `RETURNING` list names no family column.
- **What a family does:** read its own record for `page.id` and call `columns.set(name, value)` for each column it
  owns. Add nothing for a page that has no record; the TypeScript decoder then fills the default from
  `PAGE_ROW_DEFAULTS`.
- **Rules:** a family sets only a `Page` column (`src/core/types.ts`) that PGLite's `rowToPage` returns and the page
  record does not hold. Setting a field core writes, or a column another family set, is a bug: debug builds and the
  unit tests panic on it, and a release build keeps the first value. Dates go as ISO strings (`env::iso`); the
  decoder turns every `Page` date column into a `Date`, including `salience_touched_at`. Numbers go as JSON numbers
  (round `emotional_weight` to `f32` first, as Postgres `REAL` does).
- **Owners:** salience (`emotional_weight`, `salience_touched_at`), aliases (`contextual_retrieval_mode`), page_body
  (`body_storage` and `body_bytes` of a segmented page). Extraction is on the list too, but PGLite's `getPage`
  returns no extraction stamp, so its hook stays empty unless a parity case shows one. `withheld_source_path` has no
  owner yet and stays `null`.
- **Cost:** one read per listed family per page returned. A family whose record is absent for most pages does one
  failed `get` each.
- **Tests:** a store-level unit test can open a store in memory with `crate::test_support::store()`.

#### Timeline entry helpers (`timeline.rs`)

```rust
pub(crate) fn next_entry_id(tx: &mut dyn KvWrite) -> Result<u64>;
pub(crate) fn read_entry(read: &dyn KvRead, page_id: u64, date: &str, id: u64) -> Result<Option<TimelineRecord>>;
pub(crate) fn put_entry(tx: &mut dyn KvWrite, old: Option<&TimelineRecord>, new: &TimelineRecord) -> Result<()>;
```

A family that writes timeline entries (timeline_queries, for `upsertEventProjection`) uses only these; it never
writes `E`, `D` or `G` keys itself.

- `next_entry_id` takes the next id from the counter `addTimelineEntry` uses, so ids stay in one sequence.
- `read_entry` reads the entry at `E page_id date id`.
- `put_entry` writes `new` and, when `old` is given, replaces it. `old` is the entry exactly as it is stored (read
  it with `read_entry`); its `E` key goes, and its `D` key goes when that key still points at `old.id`. When `new`'s
  `D` key points at another entry, it refuses with `constraint_violation` (the dedup unique index of
  `timeline_entries`). Then it writes `new`'s `E` and `D` keys and raises `G` of `new.page_id`.
- `G` only goes up. An update that moves an entry to an older `created_at`, or to another page, leaves `G` where it
  was. Postgres computes the newest `created_at` each time, so if a parity case shows the difference, ask core.
- On a refusal, return the error from the write closure: the transaction then keeps nothing.

#### Event projection delete (`timeline_queries::remove_event_projections`)

```rust
pub(crate) fn remove_event_projections(tx: &mut dyn KvWrite, event_page_id: u64) -> Result<()>;
```

Postgres deletes a timeline entry when the page in its `event_page_id` is deleted (`ON DELETE CASCADE`), and that
entry can sit on another page. `pages::remove_page` calls this function in the same write transaction, after the
page's own entries go. Its body is empty. The timeline_queries family fills it in: it finds the entries through its
own `u 0x01 <event_page_id be8> <date>` index and deletes each one's `E` and `D` keys and its index key.

#### Page rename (`pages::rename_page`)

```rust
pub(crate) fn rename_page(tx: &mut dyn KvWrite, env: &dyn Env, page: &PageRecord, new_slug: &str) -> Result<PageRecord>;
```

The page move of `updateSlug` (`UPDATE pages SET slug = new, updated_at = now()`). Pass the page as it is stored;
it returns the moved record.

- The page keeps its id, so its chunks, links, tags, timeline entries and versions follow it.
- A new slug takes a new `knowledge_revision` and clears `text_projection_revision`, as the Postgres revision trigger
  does. The same slug changes only `updated_at`.
- `new_slug` goes through `validate_slug` (refuses with `invalid_slug`; stores the lowercase form).
- Refuses with `constraint_violation` when the source already holds a page at the new slug, live or soft deleted.
  Return the error from the write closure: the transaction then keeps nothing.
- It moves only the page. The caller versions the page before the move, and records the rename alias after it.

### Write transactions and the journal

- `Store::read()` returns one consistent snapshot. `Store::write(|tx| ...)` runs one write transaction: one writer at
  a time, every put and delete commits as one unit, and an `Err` returned from the closure rolls everything back.
- **One BrainEngine call is one store call is one transaction.** A member that is atomic in Postgres (a batch upsert,
  a supersede, a rename with its alias row, a body generation flip, a sweep) is one `Store::write` in Rust. It does
  not wait on the transactions family. Only the BrainEngine `transaction` / `transactionDirect` callbacks and
  `lockPageKeys`, which span several calls, wait on core.
- **Ordering inside a write:** validate and refuse first, then read, then write. Never leave a partial write behind on
  a refusal.
- Page writes that go through the journal (`submit_page_mutation`, `putPage`) stay core. A family that changes a page
  body (`refreshPageBody`, `revertToVersion`, `updateSlug`) writes the version snapshot PGLite writes, with the
  `pages.rs` helpers (`snapshot_in`, `write_page`).
- Every write is a blocking call on the addon's worker pool (`Brain::run`); reads overlap, writes queue.

### Row encoding

- Records are `serde_json` values stored with `get_json` / `put_json` from `lib.rs`. Each family defines its own
  `#[derive(Serialize, Deserialize)]` record structs and keeps them `pub(crate)` or private.
- New optional fields have `#[serde(default)]` so records written before the field existed still decode.
- Results cross the binding as plain JSON (`serde_json::Value` or a `Serialize` struct). Arguments arrive as JSON:
  options objects decode with `arg::<T>(options, "<member> options")` (absent means `T::default()`), required
  objects with `required::<T>(value, "<member> <arg>")`. Option structs use `#[serde(rename_all = "camelCase")]` to
  match the BrainEngine option names.
- Rust method names are the BrainEngine member in snake_case (`listFactsByEntity` becomes `list_facts_by_entity`);
  napi exposes them to JavaScript in camelCase under the member's own name.
- The TypeScript member turns the store's JSON into the engine type: ISO strings into `Date` where PGLite returns a
  `Date` (`withDates`, `withIsoDates` in `store-codec.ts`), and removes store-only fields. Decoders for a family's
  rows live in the family's file.
- Byte arrays (segment sha256, segment bodies) cross as lowercase hex strings or as napi `Buffer`; vectors cross as
  `Float32Array` (core).

### Timestamps

Stored as `i64` UTC microseconds since the Unix epoch, in fields named `*_us`. The clock is the store's `Env`
(`env.now_micros()`), never the system clock directly, so the deterministic simulation can drive it. Output is
`env::iso(us)`: `2026-08-10T12:00:00.000123Z`, the exact text Postgres `to_char(... 'US')` gives, so a microsecond
keyset cursor round-trips. Calendar dates (`DATE` columns such as timeline `date`) are stored as `YYYY-MM-DD` text
and become midnight UTC in TypeScript.

### Text order

All text ordering and comparison is byte order of UTF-8, which is Postgres `COLLATE "C"`. Keys sort that way for
free. Where PGLite orders by a locale-sensitive collation and a parity fixture would notice, the case goes in the
family's divergence file with the `text-order` reason, or the fixture uses ASCII. Case folding is ASCII `lower()`
unless the PGLite query uses `lower()` on non-ASCII text in a parity case.

### Scores

A float score (cosine similarity, salience, rank) matches PGLite within an absolute tolerance of `1e-6`. Ties break the
way the PGLite `ORDER BY` breaks them, usually by id. Postgres `REAL` columns (`emotional_weight`, take `weight`)
are rounded to `f32` before arithmetic, then computed in `f64`. The store's keyword ranking is a plain BM25 today;
the one keyword case that differs because of it is the row in `test/rust-expected-divergence/search.tsv`. The
`ts_rank` compatibility ranker (design D5) is the parity baseline the keyword family builds toward; every other
keyword, title and trigram case must match exactly.

### Expected differences

`test/rust-expected-divergence/` holds one `<family>.tsv` per family that has an expected difference. Every file is
read. A row is `file<TAB>case name<TAB>normaliser<TAB>reason`. A row must name a normaliser in
`DIVERGENCE_NORMALIZERS`; a new normaliser is a core change. A row whose case starts to match fails the run, so the
row goes in the same commit that makes the case match.

## Families

Each section lists the family's files, its reserved tag, its members (with the Rust `Store` method name; the napi
method has the member's own camelCase name), the Postgres tables it reproduces, a suggested key sub-layout, what it
waits on, an estimate, and the parity cases that prove it. A suggested key sub-layout is a starting point the
family may change before it lands; once records are on disk it is frozen like any other key.

Every member follows the same three-layer shape:

```rust
// gbrain-store/src/facts.rs
impl Store {
    pub fn list_facts_by_entity(&self, source_id: &str, entity: &str, opts: &FactListOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        // scan F 0x02 <source> 0x00 <entity> 0x00 ..., filter, order as PGLite does
    }
}

// gbrain-napi/src/families/facts.rs
#[napi]
impl Brain {
    /// `listFactsByEntity(sourceId, entitySlug, options?)`: resolves the fact rows.
    #[napi]
    pub fn list_facts_by_entity<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        entity_slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_facts_by_entity(&source_id, &entity_slug, &arg(options, "listFactsByEntity options")?)
        })
    }
}
```

```ts
// src/core/rust-engine/store-members/facts.ts
export const listFactsByEntity: StoreMember<[sourceId: string, entitySlug: string, opts?: FactListOpts], FactRow[]> =
  async (brain, sourceId, entitySlug, opts) => {
    const options = takeOptions('listFactsByEntity', opts, ['activeOnly', 'limit', 'kinds' /* ... */]); // refuses the rest
    const rows = await storeCall({ member: 'listFactsByEntity', sourceId }, () => brain.listFactsByEntity(sourceId, entitySlug, options));
    return rows.map(decodeFact); // decodeFact stays in this file
  };
```

The exact helper signatures are in `store-members/common.ts` and `store_binding.rs`; copy a built family (for
example `families/timeline.rs` and `store-members/timeline.ts`) for the details.

### page_ops

Batch page reads and writes the pages capability still refuses.

- **Files:** `gbrain-store/src/page_ops.rs`, `gbrain-napi/src/families/page_ops.rs`, `store-members/page-ops.ts`.
- **Tag:** `p` (`PAGE_OPS`). Cascade on page delete: no.
- **Members (18), capability:** `pages` (17), `page_versions` (1).
- **Store and binding:** `readPageSnapshotsBatch` (`read_page_snapshots_batch`), `findDuplicatePage` (`find_duplicate_page`), `findDuplicatePages` (`find_duplicate_pages`), `deletePages` (`delete_pages`), `resolveSlugsByPaths` (`resolve_slugs_by_paths`), `softDeletePages` (`soft_delete_pages`), `purgeDeletedPages` (`purge_deleted_pages`), `findPages` (`find_pages`), `countPagesBy` (`count_pages_by`), `getAllSlugs` (`get_all_slugs`), `listAllPageRefs` (`list_all_page_refs`), `listPrefixSampledPages` (`list_prefix_sampled_pages`), `listCorpusSample` (`list_corpus_sample`), `getContentFlagsByPageIds` (`get_content_flags_by_page_ids`), `getUnverifiedExtractionPageIds` (`get_unverified_extraction_page_ids`), `getPageTimestamps` (`get_page_timestamps`), `getEffectiveDates` (`get_effective_dates`), `revertToVersion` (`revert_to_version`).
- **Postgres tables:** `pages` (read and soft/hard delete through `pages.rs`), `page_versions` (revert).
- **Keys:** No rows of its own are needed for parity. Use `p` only for an index the reads need (for example `p 0x01 <source> 0x00 <source_path> 0x00 <slug>` for `resolveSlugsByPaths`, `p 0x02 <source> 0x00 <content_hash> 0x00 <page id>` for duplicate lookup), kept in step by an index hook in `write_page` from core.
- **Depends on:** Core page helpers (`read_page`, `all_pages`, `remove_page`, `write_page`, `snapshot_in`). `deletePages` and `purgeDeletedPages` also remove the deleted slugs from eval candidates (`retrieved_slugs`): call the eval_capture family's `pub(crate) fn remove_retrieved_slugs`, so build eval_capture first. The other tables PGLite scrubs there (retrieval events, feedback, gazetteer entries) have no Rust records; the scrub is a no-op for them until a family stores them.
- **Estimate:** about 9 days.
- **Notes:** `revertToVersion` restores only `compiled_truth` and `frontmatter`, writes a version snapshot, and refuses for a segmented page. `findPages` and `countPagesBy` are the largest members (filters, frontmatter keys). `deletePages`, `softDeletePages` and `resolveSlugsByPaths` keep the `DELETE_BATCH_SIZE` input cap. `listAllPageRefs` orders by `(source_id, slug)` in byte order.
- **Parity cases (16, in `links.test.ts`, `pages.test.ts`, `versions-raw.test.ts`):**
  - `links.test.ts`: getContentFlagsByPageIds and getUnverifiedExtractionPageIds read frontmatter markers
  - `links.test.ts`: getPageTimestamps and getEffectiveDates return dates only for existing live pages
  - `pages.test.ts`: softDeletePage hides a page; restorePage brings it back
  - `pages.test.ts`: deletePage removes the page for good
  - `pages.test.ts`: pages are scoped per source
  - `pages.test.ts`: readPageSnapshot and readPageSnapshotsBatch return page, tags and a revision
  - `pages.test.ts`: findDuplicatePage(s) match by content hash or frontmatter id, never the page itself
  - `pages.test.ts`: deletePages and softDeletePages report only real transitions
  - `pages.test.ts`: purgeDeletedPages only purges tombstones past the cutoff
  - `pages.test.ts`: resolveSlugsByPaths maps stored source paths to slugs
  - `pages.test.ts`: findPages matches name, prefix and glob patterns
  - `pages.test.ts`: countPagesBy counts live pages per source and type
  - `pages.test.ts`: listAllPageRefs lists every (source, slug) pair in order
  - `pages.test.ts`: listPrefixSampledPages and listCorpusSample sample live pages
  - `versions-raw.test.ts`: revertToVersion restores body and frontmatter from the snapshot
  - `versions-raw.test.ts`: versions are source-scoped: a same-slug page in another source keeps its own history and revert target

### extraction

Extraction state of pages.

- **Files:** `gbrain-store/src/extraction.rs`, `gbrain-napi/src/families/extraction.rs`, `store-members/extraction.ts`.
- **Tag:** `e` (`EXTRACTION`). Cascade on page delete: yes.
- **Members (7), capability:** `pages` (7).
- **Store and binding:** `countStalePagesForExtraction` (`count_stale_pages_for_extraction`), `listStalePagesForExtraction` (`list_stale_pages_for_extraction`), `markPagesExtractedBatch` (`mark_pages_extracted_batch`), `markPagesAttendanceBlocked` (`mark_pages_attendance_blocked`), `countStaleFrontmatterKeyPages` (`count_stale_frontmatter_key_pages`), `listStaleFrontmatterKeyPages` (`list_stale_frontmatter_key_pages`), `stripStaleFrontmatterKeys` (`strip_stale_frontmatter_keys`).
- **Postgres tables:** `pages.links_extracted_at`, `pages.timeline_extracted_at`, attendance-blocked state, `page_extraction_state`; frontmatter key rewrites go through core `write_page`.
- **Keys:** `e <page id>` holds one record with the extraction stamps and the attendance-blocked flag for that page. Removed by `remove_page_rows`.
- **Depends on:** Core page helpers. `stripStaleFrontmatterKeys` changes a page body: it writes through `write_page` and the version rules core uses. `getStats`/`getHealth` (stats family) read these stamps.
- **Estimate:** about 4 to 5 days.
- **Notes:** A page is stale for extraction when its body changed after the stamp: compare `updated_at_us` (or the body revision) with the stamp, as the PGLite query does. Same capability (`pages`) as page_ops and aliases.
- **Parity cases (5, in `extraction.test.ts`):**
  - `extraction.test.ts`: countStalePagesForExtraction: NULL stamp, older-than-version and edited-since-stamp are stale; deleted and quarantined are not
  - `extraction.test.ts`: listStalePagesForExtraction pages by id keyset, scopes by source and carries the page content
  - `extraction.test.ts`: markPagesExtractedBatch returns the rows stamped: wrong-source and unknown refs match nothing, empty input is 0
  - `extraction.test.ts`: markPagesAttendanceBlocked marks a page at its revision; attendance narrows the stale set and an edit releases it
  - `extraction.test.ts`: countStaleFrontmatterKeyPages, listStaleFrontmatterKeyPages and stripStaleFrontmatterKeys sweep parser-reserved keys per source

### aliases

Slug renames and page aliases.

- **Files:** `gbrain-store/src/aliases.rs`, `gbrain-napi/src/families/aliases.rs`, `store-members/aliases.ts`.
- **Tag:** `k` (`ALIAS`). Cascade on page delete: yes.
- **Members (6), capability:** `pages` (6).
- **Store and binding:** `updateSlug` (`update_slug`), `resolveSlugWithAlias` (`resolve_slug_with_alias`), `resolveSlugWithAliasDetailed` (`resolve_slug_with_alias_detailed`), `resolveAliases` (`resolve_aliases`), `setPageAliases` (`set_page_aliases`), `updatePageContextualRetrievalState` (`update_page_contextual_retrieval_state`).
- **Postgres tables:** `slug_aliases` (no FK to pages), `pages.slug` (rename), `pages.contextual_retrieval_mode`.
- **Keys:** `k 0x01 <source> 0x00 <alias slug>` to the target slug and page id; `k 0x02 <page id> 0x00 <alias slug>` to list a page's aliases; `k 0x03 <page id>` for the contextual retrieval state. Removed by `remove_page_rows`. `getPage` returns `contextual_retrieval_mode` from that record through this family's `page_columns` hook (built).
- **Depends on:** `updateSlug` moves the page key (`P`) from the old slug to the new one through core's `pages::rename_page` (built; "Core hooks"). This family versions the page first (`pages::snapshot_in`), then calls `rename_page`, then records the alias and moves its own slug bindings. Links, chunks, tags, timeline and versions follow the page id and need no change.
- **Estimate:** about 5 to 6 days.
- **Notes:** Same capability (`pages`) as page_ops and extraction. `resolveSlugWithAliasDetailed` returns how the slug was found; keep its result fields exact.
- **Parity cases (6, in `sync-aliases.test.ts`):**
  - `sync-aliases.test.ts`: updateSlug renames a page in place, keeps its chunks, and returns 0 when the old slug is absent
  - `sync-aliases.test.ts`: updateSlug is source-scoped and rejects a path-traversal new slug
  - `sync-aliases.test.ts`: a rename records an alias: resolveSlugWithAlias maps the old slug to the new one, per source
  - `sync-aliases.test.ts`: setPageAliases replaces a page alias set; resolveAliases maps normalized aliases to slugs with source scope
  - `sync-aliases.test.ts`: updatePageContextualRetrievalState stamps the CR mode without touching the body
  - `sync-aliases.test.ts`: rewriteLinks after updateSlug is a no-op: links follow the page id, not the slug

### page_body

Segmented page bodies: segment texts, manifests, staging and derivations.

- **Files:** `gbrain-store/src/page_body.rs`, `gbrain-napi/src/families/page_body.rs`, `store-members/page-body.ts`.
- **Tag:** `b` (`PAGE_BODY`). Cascade on page delete: yes.
- **Members (15), capability:** `page_body` (15).
- **Store and binding:** `allocateBodyOccurrenceIds` (`allocate_body_occurrence_ids`), `stageSegmentTexts` (`stage_segment_texts`), `readSegmentTexts` (`read_segment_texts`), `stageManifestRows` (`stage_manifest_rows`), `readManifest` (`read_manifest`), `stageSegmentChunks` (`stage_segment_chunks`), `createSegmentedPageShell` (`create_segmented_page_shell`), `flipBodyGeneration` (`flip_body_generation`), `openBodyStaging` (`open_body_staging`), `setBodyStagingState` (`set_body_staging_state`), `sweepSegments` (`sweep_segments`), `readSegmentDerivations` (`read_segment_derivations`), `upsertSegmentDerivations` (`upsert_segment_derivations`), `retireSegmentDerivations` (`retire_segment_derivations`), `refreshPageBody` (`refresh_page_body`).
- **Postgres tables:** `page_segment_texts`, `page_body_manifest`, `page_body_stagings`, `page_segment_derivations`, `page_derivation_spend`.
- **Keys:** `b 0x01 <source> 0x00 <sha256>` segment text; `b 0x02 <page id> <occurrence id> <gen_from> <staging id>` manifest row (ids big-endian); `b 0x03 <staging id>` staging; `b 0x04 <page id> ...` derivations; `M next_body_occurrence_id` for occurrence ids. Page-keyed rows go in `remove_page_rows`; segment texts are kept until `sweepSegments`, as in PGLite.
- **Depends on:** Core page helpers for `createSegmentedPageShell`, `flipBodyGeneration` and `refreshPageBody` (page record writes go through `write_page`). `stageSegmentChunks` writes chunk rows: use the core chunk helpers, and refuse any input that carries vectors until the embeddings family lands. The generation-1 parity case also needs the transactions family.
- **Estimate:** about 7 to 8 days: texts and manifest 1 to 2, flip and staging 3, sweep 2, derivations 1.
- **Notes:** Segment bodies are bytes; sha256 and bodies cross the binding as hex or `Buffer`. `flipBodyGeneration` and `sweepSegments` are each one store write.
- **Parity cases (5, in `segmented-body.test.ts`, `sync-aliases.test.ts`):**
  - `segmented-body.test.ts`: a segmented page publishes generation 1 from staged texts and manifest rows
  - `segmented-body.test.ts`: a replace flips to generation 2, closes retired rows and refuses a stale generation
  - `segmented-body.test.ts`: sweepSegments deletes closed rows and unreferenced texts and expires stale stagings
  - `segmented-body.test.ts`: segment derivations upsert by (page, kind, occurrence), read in order and retire dead occurrences
  - `sync-aliases.test.ts`: refreshPageBody rewrites body, timeline and content hash; skips soft-deleted pages and other sources

### facts

Facts and their supersession chains.

- **Files:** `gbrain-store/src/facts.rs`, `gbrain-napi/src/families/facts.rs`, `store-members/facts.ts`.
- **Tag:** `F` (`FACT`). Cascade on page delete: no.
- **Members (15), capability:** `facts` (15).
- **Store and binding:** `insertFact` (`insert_fact`), `insertFacts` (`insert_facts`), `deleteFactsForPage` (`delete_facts_for_page`), `expireFact` (`expire_fact`), `listFactsByEntity` (`list_facts_by_entity`), `listFactsSince` (`list_facts_since`), `listFactsKeyset` (`list_facts_keyset`), `listFactsBySession` (`list_facts_by_session`), `listSupersessions` (`list_supersessions`), `countUnconsolidatedFacts` (`count_unconsolidated_facts`), `findCandidateDuplicates` (`find_candidate_duplicates`), `consolidateFact` (`consolidate_fact`), `findTrajectory` (`find_trajectory`), `getFactsHealth` (`get_facts_health`), `migrateFactsToCanonical` (`migrate_facts_to_canonical`).
- **Postgres tables:** `facts` (also the rows ontology reads; `superseded_by` is SET NULL on delete).
- **Keys:** `F 0x01 <fact id>` row; indexes under `F 0x02 <source> 0x00 <entity> 0x00 <valid_from us> <id>`, `F 0x03 <source> 0x00 <session> ...`, `F 0x04 <source> <created_at us> <id>` (keyset), `F 0x05 <source> 0x00 <source_markdown_slug> 0x00 <row_num>` (fence key, unique). `M next_fact_id`. Offer `pub(crate)` row reads and writes to the ontology family.
- **Depends on:** None for the core members. Three cases also read takes (`countUnconsolidatedFacts`, `getFactsHealth`, the `listFactsByEntity` consolidation filter) and one needs the transactions family (keyset across a shared timestamp inside `transaction`). `findCandidateDuplicates` with an embedding refuses until vectors land; the keyword arm uses the keyword family's ranker. Source delete is not served yet (see "Page delete cascade").
- **Estimate:** about 4 days.
- **Notes:** `listFactsKeyset` cursors are microsecond ISO text; `grep` is ILIKE with wildcards treated literally. `migrateFactsToCanonical` rewrites `entity_slug`, `source_markdown_slug` and `row_num` only.
- **Parity cases (22, in `facts.test.ts`, `sync-aliases.test.ts`):**
  - `facts.test.ts`: insertFact stores defaults and every supplied field; listFactsByEntity reads it back
  - `facts.test.ts`: listFactsByEntity orders newest valid_from first and pages with limit/offset
  - `facts.test.ts`: listFactsByEntity filters by kind, visibility, session, grep (wildcards literal) and consolidation
  - `facts.test.ts`: expireFact (forget) hides a fact from active reads, keeps history, and is idempotent
  - `facts.test.ts`: expireFact with supersededBy/successorFrom records the successor and ends validity
  - `facts.test.ts`: insertFact with supersedeId inserts the successor and closes the old fact atomically
  - `facts.test.ts`: listSupersessions filters by since, visibility and limit, newest supersession first
  - `facts.test.ts`: activeOnly reads drop validity-lapsed rows; activeOnly:false keeps them
  - `facts.test.ts`: listFactsSince windows on creation time, or on event time with eventTime
  - `facts.test.ts`: listFactsSince narrows by entity, session, kind, visibility, grep and audit rows before the limit
  - `facts.test.ts`: listFactsBySession returns a session newest first and honors filters and paging
  - `facts.test.ts`: listFactsKeyset pages oldest-first by (created_at, id) with no gaps or repeats, across two rows that share a timestamp
  - `facts.test.ts`: listFactsKeyset applies visibility, entity, session, grep and audit narrowing before the limit
  - `facts.test.ts`: insertFacts stores fence rows in order, resolves superseded-by row refs, and skips duplicate row numbers
  - `facts.test.ts`: insertFacts deleteForPageFirst replaces a page atomically; deleteFactsForPage spares excluded source prefixes and other pages
  - `facts.test.ts`: countUnconsolidatedFacts counts active entity-bound facts and ignores audit rows
  - `facts.test.ts`: findCandidateDuplicates (recency arm) returns active same-entity facts newest first, capped by k
  - `facts.test.ts`: findCandidateDuplicates (embedding arm) ranks by cosine and only compares same-model current vectors
  - `facts.test.ts`: findCandidateDuplicates (keyword arm) ranks the entity bucket by shared terms
  - `facts.test.ts`: findTrajectory returns the typed-claim history chronologically, world-only unless local
  - `facts.test.ts`: getFactsHealth partitions active/expired/consolidated and ranks top entities
  - `sync-aliases.test.ts`: migrateFactsToCanonical moves active phantom facts, leaves expired ones, and is idempotent

### ontology

Ontology dimensions over facts.

- **Files:** `gbrain-store/src/ontology.rs`, `gbrain-napi/src/families/ontology.rs`, `store-members/ontology.ts`.
- **Tag:** `N` (`ONTOLOGY`). Cascade on page delete: no.
- **Members (4), capability:** `ontology` (4).
- **Store and binding:** `mergeOntologyFact` (`merge_ontology_fact`), `getOntology` (`get_ontology`), `discoverOntologyDimensions` (`discover_ontology_dimensions`), `findOntologyConflicts` (`find_ontology_conflicts`).
- **Postgres tables:** `facts` rows that have a `dimension` (no table of its own).
- **Keys:** Reads and writes fact rows through the facts family's `pub(crate)` helpers. `N <source> 0x00 <entity> 0x00 <dimension> 0x00 <valid_from us> <id>` for the dimension index and the stint dedup key.
- **Depends on:** facts (build it first, by the same person).
- **Estimate:** about 2 days.
- **Notes:** `value_hash` must reproduce `computeContentHash` exactly (trim, lowercase, NFKC, first 16 hex characters); `dimension` must reproduce `normalizeDimension` and the alias lexicon. The parity cases are in `timeline.test.ts`.
- **Parity cases (4, in `timeline.test.ts`):**
  - `timeline.test.ts`: mergeOntologyFact inserts, dedups, corroborates and forward-supersedes; getOntology reads asof
  - `timeline.test.ts`: novel dimensions quarantine; includeQuarantined and visibility filters change what getOntology returns
  - `timeline.test.ts`: findOntologyConflicts surfaces a backdated disagreement but not a forward supersession
  - `timeline.test.ts`: discoverOntologyDimensions rolls up entities and observations per dimension

### takes

Takes and synthesis evidence.

- **Files:** `gbrain-store/src/takes.rs`, `gbrain-napi/src/families/takes.rs`, `store-members/takes.ts`.
- **Tag:** `A` (`TAKE`). Cascade on page delete: yes.
- **Members (10), capability:** `takes` (10).
- **Store and binding:** `addTakesBatch` (`add_takes_batch`), `listTakes` (`list_takes`), `searchTakes` (`search_takes`), `updateTake` (`update_take`), `supersedeTake` (`supersede_take`), `resolveTake` (`resolve_take`), `getScorecard` (`get_scorecard`), `getCalibrationCurve` (`get_calibration_curve`), `addSynthesisEvidence` (`add_synthesis_evidence`), `listActiveTakesForPages` (`list_active_takes_for_pages`).
- **Postgres tables:** `takes` (unique `(page_id, row_num)`), `synthesis_evidence`, read of `take_grade_cache` for `ungradedFirst`.
- **Keys:** `A 0x01 <take id>` row; `A 0x02 <page id> <row_num u32>` to the take id (unique); `A 0x03 <synthesis page id> <take page id> <row_num>` evidence; `A 0x04 <take page id> <row_num> <synthesis page id>` reverse evidence. `M next_take_id`. `remove_page_rows` deletes the page's takes and every evidence row that names it.
- **Depends on:** Core page helpers for slug and visibility joins. Vector search over takes and take embeddings belong to core (vectors, embeddings); the `takes` capability is reported only after those land.
- **Estimate:** about 4 days.
- **Notes:** `weight` is REAL: clamp and round as `buildTakeRows` does, then store as `f32`. `since_date` is text compared after padding, not a date. `searchTakes` is a trigram `word_similarity` score: share the keyword family's trigram code once it exists, or build `pg_trgm` scoring in this family and let keyword call it.
- **Parity cases (19, in `code-eval-salience.test.ts`, `facts.test.ts`, `links.test.ts`, `takes.test.ts`):**
  - `code-eval-salience.test.ts`: batchLoadEmotionalInputs returns tags and active takes per page; slug filter narrows
  - `code-eval-salience.test.ts`: setEmotionalWeightBatch counts changed rows only, is source-keyed, and feeds getRecentSalience ordering
  - `facts.test.ts`: listFactsByEntity filters by kind, visibility, session, grep (wildcards literal) and consolidation
  - `facts.test.ts`: countUnconsolidatedFacts counts active entity-bound facts and ignores audit rows
  - `facts.test.ts`: getFactsHealth partitions active/expired/consolidated and ranks top entities
  - `links.test.ts`: getSalienceScores combines emotional weight and take count
  - `takes.test.ts`: addTakesBatch inserts rows, is idempotent per (page, row_num), updates changed rows in place, clamps weight
  - `takes.test.ts`: listTakes filters by page, holder, kind, active, resolved and holder allow-list
  - `takes.test.ts`: listTakes orders newest-first by default and by weight or since_date on request; pages with limit/offset
  - `takes.test.ts`: listTakes scopes to a source through the take page
  - `takes.test.ts`: updateTake changes weight/since_date/source only, clamps weight, and rejects a missing row
  - `takes.test.ts`: supersedeTake appends the new row, deactivates the old one, and refuses missing or resolved rows
  - `takes.test.ts`: resolveTake derives quality/outcome, stores resolution metadata, and is immutable
  - `takes.test.ts`: getScorecard counts bets, accuracy, Brier and partial/unresolvable rates, scoped by holder, domain, dates, allow-list and source
  - `takes.test.ts`: getCalibrationCurve bins resolved correct/incorrect bets by weight and honors holder, bucket size and allow-list
  - `takes.test.ts`: addSynthesisEvidence inserts provenance rows once per (synthesis, take page, take row)
  - `takes.test.ts`: listActiveTakesForPages groups active takes per page in row order, filters by allow-list, and keys empty pages
  - `takes.test.ts`: searchTakes ranks active takes by trigram similarity and applies holder allow-list, source and limit
  - `takes.test.ts`: take embeddings: write, read back, vector search, and staleness accounting

### contradictions

Contradiction runs and the contradiction cache.

- **Files:** `gbrain-store/src/contradictions.rs`, `gbrain-napi/src/families/contradictions.rs`, `store-members/contradictions.ts`.
- **Tag:** `Q` (`CONTRADICTIONS`). Cascade on page delete: no.
- **Members (5), capability:** `contradictions` (5).
- **Store and binding:** `writeContradictionsRun` (`write_contradictions_run`), `loadContradictionsTrend` (`load_contradictions_trend`), `getContradictionCacheEntry` (`get_contradiction_cache_entry`), `putContradictionCacheEntry` (`put_contradiction_cache_entry`), `sweepContradictionCache` (`sweep_contradiction_cache`).
- **Postgres tables:** `eval_contradictions_runs`, `eval_contradictions_cache`.
- **Keys:** `Q 0x01 <run_id>` run; `Q 0x02 <ran_at us> 0x00 <run_id>` trend index; `Q 0x03 <a hash> 0x00 <b hash> 0x00 <model> 0x00 <prompt version> 0x00 <truncation policy>` cache entry.
- **Depends on:** None.
- **Estimate:** about half a day.
- **Notes:** `wilson_ci_*` and `cost_usd_total` are REAL (`f32`). The cache TTL defaults to 30 days with a 60-second minimum.
- **Parity cases (2, in `takes.test.ts`):**
  - `takes.test.ts`: writeContradictionsRun is idempotent on run_id; loadContradictionsTrend returns runs newest first with parsed JSON
  - `takes.test.ts`: judge cache: put/get by the full 5-part key, upsert refreshes the verdict, other keys miss

### dream

Dream verdicts.

- **Files:** `gbrain-store/src/dream.rs`, `gbrain-napi/src/families/dream.rs`, `store-members/dream.ts`.
- **Tag:** `Y` (`DREAM_VERDICT`). Cascade on page delete: no.
- **Members (3), capability:** `dream_verdicts` (3).
- **Store and binding:** `getDreamVerdict` (`get_dream_verdict`), `putDreamVerdict` (`put_dream_verdict`), `sweepDreamVerdicts` (`sweep_dream_verdicts`).
- **Postgres tables:** `dream_verdicts`.
- **Keys:** `Y <file_path> 0x00 <content_hash>`.
- **Depends on:** None.
- **Estimate:** about half a day.
- **Notes:** A get hides expired rows; a put replaces every field and sets `judged_at` to now.
- **Parity cases (1, in `takes.test.ts`):**
  - `takes.test.ts`: putDreamVerdict/getDreamVerdict round-trip by (file, hash); a re-put replaces; sweep spares live rows

### eval_capture

Captured eval candidates and capture failures.

- **Files:** `gbrain-store/src/eval_capture.rs`, `gbrain-napi/src/families/eval_capture.rs`, `store-members/eval-capture.ts`.
- **Tag:** `Z` (`EVAL_CAPTURE`). Cascade on page delete: no.
- **Members (5), capability:** `eval_capture` (5).
- **Store and binding:** `logEvalCandidate` (`log_eval_candidate`), `listEvalCandidates` (`list_eval_candidates`), `deleteEvalCandidatesBefore` (`delete_eval_candidates_before`), `logEvalCaptureFailure` (`log_eval_capture_failure`), `listEvalCaptureFailures` (`list_eval_capture_failures`).
- **Postgres tables:** `eval_candidates`, `eval_capture_failures`.
- **Keys:** `Z 0x01 <id>` candidate; `Z 0x02 <id>` failure; `M next_eval_candidate_id`, `M next_eval_failure_id`. Expose `pub(crate) fn remove_retrieved_slugs(tx, source_id, slugs)` for page_ops.
- **Depends on:** None.
- **Estimate:** about half a day.
- **Notes:** Read the PGLite `ORDER BY` for both list members before porting; `retrieved_chunk_ids` has no FK, so a chunk delete does not touch it.
- **Parity cases (3, in `code-eval-salience.test.ts`):**
  - `code-eval-salience.test.ts`: logEvalCandidate round-trips every field through listEvalCandidates, with tool filter and limit
  - `code-eval-salience.test.ts`: listEvalCandidates since-window and deleteEvalCandidatesBefore split old from new rows
  - `code-eval-salience.test.ts`: logEvalCaptureFailure records reasons; listEvalCaptureFailures filters by since

### code_edges

Code call edges between chunks and symbols.

- **Files:** `gbrain-store/src/code_edges.rs`, `gbrain-napi/src/families/code_edges.rs`, `store-members/code-edges.ts`.
- **Tag:** `H` (`CODE_EDGE`). Cascade on page delete: yes.
- **Members (5), capability:** `code_edges` (5).
- **Store and binding:** `addCodeEdges` (`add_code_edges`), `deleteCodeEdgesForChunks` (`delete_code_edges_for_chunks`), `getCallersOf` (`get_callers_of`), `getCalleesOf` (`get_callees_of`), `getEdgesByChunk` (`get_edges_by_chunk`).
- **Postgres tables:** `code_edges_chunk`, `code_edges_symbol`.
- **Keys:** `H 0x01 <edge id>` row; `H 0x02 <from chunk id> <edge id>`; `H 0x03 <to chunk id> <edge id>`; `H 0x04 <source> 0x00 <to symbol> 0x00 <edge id>`.
- **Depends on:** Core chunk ids. Postgres deletes edges when their chunk is deleted. Page delete reaches this family through `remove_page_rows`; a chunk replace (`upsertChunks`) needs a chunk-delete hook from core. Ask core for it before the case that replaces chunks.
- **Estimate:** about 1 to 2 days.
- **Notes:** The chunk and symbol tables share one `LIMIT` in the PGLite union; keep that.
- **Parity cases (3, in `code-eval-salience.test.ts`):**
  - `code-eval-salience.test.ts`: addCodeEdges splits resolved and unresolved edges, is idempotent, and getCallers/getCallees/getEdgesByChunk read them
  - `code-eval-salience.test.ts`: getCallersOf/getCalleesOf scope by the anchor chunk source unless allSources is set
  - `code-eval-salience.test.ts`: deleteCodeEdgesForChunks wipes edges in both directions across resolved and unresolved tables

### salience

Emotional weight and salience of pages.

- **Files:** `gbrain-store/src/salience.rs`, `gbrain-napi/src/families/salience.rs`, `store-members/salience.ts`.
- **Tag:** `s` (`SALIENCE`). Cascade on page delete: yes.
- **Members (4), capability:** `salience` (4).
- **Store and binding:** `batchLoadEmotionalInputs` (`batch_load_emotional_inputs`), `setEmotionalWeightBatch` (`set_emotional_weight_batch`), `getRecentSalience` (`get_recent_salience`), `getSalienceScores` (`get_salience_scores`).
- **Postgres tables:** `pages.emotional_weight`, `pages.salience_touched_at`; reads `tags` and `takes`.
- **Keys:** `s <page id>` holds emotional weight (`f32`) and the touched time. Removed by `remove_page_rows`.
- **Depends on:** takes (take counts and active takes; same group). `getPage` returns `emotional_weight` and `salience_touched_at`: fill in this family's `page_columns` hook (built; "Core hooks").
- **Estimate:** about 1 to 2 days.
- **Notes:** `setEmotionalWeightBatch` counts changed rows only. Round to `f32` before comparing, as Postgres `REAL` does.
- **Parity cases (3, in `code-eval-salience.test.ts`, `links.test.ts`):**
  - `code-eval-salience.test.ts`: batchLoadEmotionalInputs returns tags and active takes per page; slug filter narrows
  - `code-eval-salience.test.ts`: setEmotionalWeightBatch counts changed rows only, is source-keyed, and feeds getRecentSalience ordering
  - `links.test.ts`: getSalienceScores combines emotional weight and take count

### stats

Brain statistics, health and the ingest log.

- **Files:** `gbrain-store/src/stats.rs`, `gbrain-napi/src/families/stats.rs`, `store-members/stats.ts`.
- **Tag:** `n` (`INGEST_LOG`). Cascade on page delete: no.
- **Members (6), capability:** `health` (4), `ingest_log` (2).
- **Store and binding:** `getStats` (`get_stats`), `getHealth` (`get_health`), `logIngest` (`log_ingest`), `getIngestLog` (`get_ingest_log`), `listEnrichCandidates` (`list_enrich_candidates`), `findAnomalies` (`find_anomalies`).
- **Postgres tables:** Counts over every table; `ingest_log`.
- **Keys:** `n <created_at us> <id>` ingest log row; `M next_ingest_log_id`.
- **Depends on:** Reads every family. `getHealth` reads extraction stamps and embedding coverage, so finish it last; the embedding counts refuse until the embeddings family lands, unless the store has no chunks. `listEnrichCandidates` and `findAnomalies` read salience and timeline.
- **Estimate:** about 2 to 3 days.
- **Notes:** Health lists order with `COLLATE "C"` (byte order). `getStats` counts links only when both ends are in scope.
- **Parity cases (6, in `code-eval-salience.test.ts`, `config-ingest.test.ts`):**
  - `code-eval-salience.test.ts`: listEnrichCandidates picks thin pages by type, counts inbound links, orders and limits, and scopes by source
  - `code-eval-salience.test.ts`: findAnomalies flags a cohort with unusual activity today and respects source scope and sigma
  - `config-ingest.test.ts`: getStats counts pages, chunks, embeddings, links, tags and timeline entries
  - `config-ingest.test.ts`: getStats and getHealth confine to a source scope
  - `config-ingest.test.ts`: getHealth reports coverage, orphans, missing embeddings and the score parts
  - `config-ingest.test.ts`: logIngest then getIngestLog returns entries newest-first with a limit and source scope

### raw_files

Raw source data and files attached to pages.

- **Files:** `gbrain-store/src/raw_files.rs`, `gbrain-napi/src/families/raw_files.rs`, `store-members/raw-files.ts`.
- **Tag:** `r` (`RAW_FILES`). Cascade on page delete: yes.
- **Members (5), capability:** `raw_data` (2), `files` (3).
- **Store and binding:** `putRawData` (`put_raw_data`), `getRawData` (`get_raw_data`), `upsertFile` (`upsert_file`), `getFile` (`get_file`), `listFilesForPage` (`list_files_for_page`).
- **Postgres tables:** `raw_data` (page CASCADE), `files` (`page_id` SET NULL, `page_slug` text).
- **Keys:** `r 0x01 <page id> 0x00 <source name>` raw data; `r 0x02 <source> 0x00 <storage path>` file; `r 0x03 <page id> 0x00 <file id>` page index. `remove_page_rows` deletes raw data and clears `page_id` on files (it keeps the file rows).
- **Depends on:** Core page helpers.
- **Estimate:** about 1 day.
- **Notes:** `raw_data.data` is JSONB: Postgres stores object keys sorted by length then bytes; reproduce that key order on output.
- **Parity cases (4, in `versions-raw.test.ts`):**
  - `versions-raw.test.ts`: putRawData upserts per (page, source); getRawData filters by source
  - `versions-raw.test.ts`: raw data follows the page soft-delete; includeDeleted opts in; sources scope same-slug pages
  - `versions-raw.test.ts`: upsertFile creates then no-ops on same hash, updates in place on a new hash; getFile reads by identity
  - `versions-raw.test.ts`: listFilesForPage returns the files attached to that page only

### link_queries

Link and graph members the links and graph capabilities still refuse.

- **Files:** `gbrain-store/src/link_queries.rs`, `gbrain-napi/src/families/link_queries.rs`, `store-members/link-queries.ts`.
- **Tag:** `q` (`LINK_QUERIES`). Cascade on page delete: no.
- **Members (10), capability:** `links` (6), `graph` (4).
- **Store and binding:** `replaceDerivedLinks` (`replace_derived_links`), `replaceDerivedLinksBatch` (`replace_derived_links_batch`), `removeLinksByPagesAndSource` (`remove_links_by_pages_and_source`), `listLinkSources` (`list_link_sources`), `getBacklinkCounts` (`get_backlink_counts`), `rewriteLinks` (`rewrite_links`), `relationalFanout` (`relational_fanout`), `relationalChainHop` (`relational_chain_hop`), `getAdjacencyBoosts` (`get_adjacency_boosts`), `findOrphanPages` (`find_orphan_pages`).
- **Postgres tables:** `links` (through `links.rs`), `pages`.
- **Keys:** No new rows for most members; `q` is for derived-link bookkeeping if `replaceDerivedLinks` needs it (`q <source> 0x00 <origin page id> ...`). Link rows themselves are written only through the `links.rs` helpers.
- **Depends on:** Core link helpers. Ask core for any write helper the derived-link replace needs. `rewriteLinks` follows the page id and is a no-op on links (one case also needs aliases).
- **Estimate:** about 3 days.
- **Notes:** `getLinks`/`getBacklinks` with a source list constrain both ends; a scalar source constrains only the from side. `relationalFanout` and `relationalChainHop` must keep the PGLite depth and order.
- **Parity cases (10, in `links.test.ts`, `sync-aliases.test.ts`):**
  - `links.test.ts`: removeLinksByPagesAndSource deletes only the named provenance for the named pages
  - `links.test.ts`: listLinkSources counts edges per provenance, count DESC then name ASC
  - `links.test.ts`: replaceDerivedLinks swaps one origin\'s derived edges and leaves manual edges alone
  - `links.test.ts`: replaceDerivedLinksBatch replaces many origins in one call
  - `links.test.ts`: relationalFanout walks typed edges, excludes mentions by default and orders deterministically
  - `links.test.ts`: relationalChainHop orients and collapses edges from frontier page ids
  - `links.test.ts`: getBacklinkCounts counts distinct linkers per page id, excluding mentions
  - `links.test.ts`: getAdjacencyBoosts aggregates in-set linkers only
  - `links.test.ts`: findOrphanPages: islanded default vs inbound mode, with source scope
  - `sync-aliases.test.ts`: rewriteLinks after updateSlug is a no-op: links follow the page id, not the slug

### timeline_queries

Timeline reads by date and event projections.

- **Files:** `gbrain-store/src/timeline_queries.rs`, `gbrain-napi/src/families/timeline_queries.rs`, `store-members/timeline-queries.ts`.
- **Tag:** `u` (`TIMELINE_QUERIES`). Cascade on page delete: no.
- **Members (5), capability:** `timeline` (5).
- **Store and binding:** `getTimelineForDate` (`get_timeline_for_date`), `getSince` (`get_since`), `getOnThisDay` (`get_on_this_day`), `getLastSeen` (`get_last_seen`), `upsertEventProjection` (`upsert_event_projection`).
- **Postgres tables:** `timeline_entries`, `pages.effective_date`.
- **Keys:** Reads and writes core timeline rows (`E`, `D`, `G`) only through the timeline entry helpers ("Core hooks"). `u <date> 0x00 <entry id>` date index if a read needs one, kept by a core hook in `timeline.rs`; event projections indexed under `u 0x01 <event_page_id be8> <date>`.
- **Depends on:** The timeline entry helpers and the `remove_event_projections` stub (both built; fill in the stub). Ask core for a date index hook if a scan is too slow.
- **Estimate:** about 1 to 2 days.
- **Notes:** Dates are `YYYY-MM-DD` text. `getOnThisDay` matches month and day across years.
- **Parity cases (5, in `timeline.test.ts`):**
  - `timeline.test.ts`: upsertEventProjection updates in place on the same (event, date) and refuses missing pages
  - `timeline.test.ts`: getTimelineForDate returns one day or its ISO week, ordered by event effective_date
  - `timeline.test.ts`: getSince filters by lower-bound date and event kind
  - `timeline.test.ts`: getOnThisDay returns the same month-day from prior years only
  - `timeline.test.ts`: getLastSeen finds an entity via its own page or an event who, bounded by asof

### keyword

Keyword search members the keyword_search capability still refuses, and title trigrams.

- **Files:** `gbrain-store/src/keyword.rs`, `gbrain-napi/src/families/keyword.rs`, `store-members/keyword.ts`.
- **Tag:** `R` (`TRIGRAM`). Cascade on page delete: no.
- **Members (5), capability:** `keyword_search` (5).
- **Store and binding:** `countKeywordPages` (`count_keyword_pages`), `searchKeywordPages` (`search_keyword_pages`), `searchTitles` (`search_titles`), `searchKeywordChunks` (`search_keyword_chunks`), `findByTitleFuzzy` (`find_by_title_fuzzy`).
- **Postgres tables:** `content_chunks.search_vector`, `pages.search_vector`, title trigrams.
- **Keys:** Postings stay core (`T`). `R <source> 0x00 <trigram> 0x00 <page id>` title trigram postings, kept by a core hook in `write_page`.
- **Depends on:** Core search postings and the `ts_rank` compatibility ranker (design D5). Ports `pg_trgm` similarity for `findByTitleFuzzy` and `searchTitles`; the takes family reuses it.
- **Estimate:** about 3 days.
- **Notes:** Every keyword case except the one in `search.tsv` must match PGLite exactly, order and score within `1e-6`.
- **Parity cases (4, in `links.test.ts`, `search.test.ts`):**
  - `links.test.ts`: findByTitleFuzzy returns the best title match above the threshold, honoring prefix and source
  - `search.test.ts`: countKeywordPages and searchKeywordPages page through strict keyword matches
  - `search.test.ts`: searchKeywordChunks returns chunk-grain rows where searchKeyword returns one row per page
  - `search.test.ts`: searchTitles finds pages by title, falls back to relaxed OR, and honors filters

### chunk_queries

Chunk reads the chunks capability still refuses.

- **Files:** `gbrain-store/src/chunk_queries.rs`, `gbrain-napi/src/families/chunk_queries.rs`, `store-members/chunk-queries.ts`.
- **Tag:** `c` (`CHUNK_QUERIES`). Cascade on page delete: no.
- **Members (4), capability:** `chunks` (4).
- **Store and binding:** `getChunkPage` (`get_chunk_page`), `getChunkWindows` (`get_chunk_windows`), `countChunklessPagesWithContent` (`count_chunkless_pages_with_content`), `listChunklessPagesWithContent` (`list_chunkless_pages_with_content`).
- **Postgres tables:** `content_chunks`, `pages`.
- **Keys:** Reads core chunk rows (`K`) through `chunks.rs` helpers; `c` only if a read needs an index.
- **Depends on:** Core chunk helpers. Two cases also read embeddings (core).
- **Estimate:** about 1 to 2 days.
- **Notes:** Chunkless pages exclude quarantined and `embed_skip` pages.
- **Parity cases (6, in `chunks.test.ts`):**
  - `chunks.test.ts`: upsertChunks replaces a page chunk set: edited text, new indexes, dropped tail
  - `chunks.test.ts`: getChunkPage pages by chunk_index range and reports total and max index
  - `chunks.test.ts`: getChunkWindows reads requested chunk ranges for authorized sealed pages only
  - `chunks.test.ts`: countChunklessPagesWithContent and listChunklessPagesWithContent find pages that were never chunked
  - `chunks.test.ts`: deleteChunks removes every chunk of one page and leaves the others
  - `chunks.test.ts`: the same slug in two sources keeps separate chunk sets under sourceId scoping

### vectors (core)

Chunk vectors and vector search.

- **Files:** `gbrain-store/src/vectors.rs`, `gbrain-napi/src/families/vectors.rs`, `store-members/vectors.ts`.
- **Tag:** `X` (`VECTOR`). Cascade on page delete: yes.
- **Members (2), capability:** `vector_search` (1), `takes` (1).
- **Store and binding:** `searchVector` (`search_vector`), `searchTakesVector` (`search_takes_vector`).
- **Postgres tables:** Chunk and take vectors (`embedding` columns), the vector index.
- **Keys:** `X` (core sub-layout).
- **Depends on:** The coming vector store work (HNSW or exact scan choice, design phase 2).
- **Estimate:** core.
- **Notes:** Cosine score is `1 - distance`, within `1e-6` of pgvector.
- **Parity cases (3, in `search.test.ts`, `takes.test.ts`):**
  - `search.test.ts`: searchVector ranks by cosine similarity and applies filters and paging
  - `search.test.ts`: searchVector: a dense page cannot starve the page-grain result
  - `takes.test.ts`: take embeddings: write, read back, vector search, and staleness accounting

### embeddings (core)

Embedding state of chunks and pages.

- **Files:** `gbrain-store/src/embeddings.rs`, `gbrain-napi/src/families/embeddings.rs`, `store-members/embeddings.ts`.
- **Tag:** `B` (`EMBEDDING_STATE`). Cascade on page delete: yes.
- **Members (14), capability:** `embeddings` (10), `takes` (4).
- **Store and binding:** `getEmbeddingsByChunkIds` (`get_embeddings_by_chunk_ids`), `countStaleChunks` (`count_stale_chunks`), `sumStaleChunkChars` (`sum_stale_chunk_chars`), `setPageEmbeddingSignature` (`set_page_embedding_signature`), `invalidateStaleSignatureEmbeddings` (`invalidate_stale_signature_embeddings`), `invalidateContentDriftEmbeddings` (`invalidate_content_drift_embeddings`), `listStaleChunks` (`list_stale_chunks`), `readEmbeddingStateCounts` (`read_embedding_state_counts`), `listEmbeddingStateRows` (`list_embedding_state_rows`), `getChunksWithEmbeddings` (`get_chunks_with_embeddings`), `updateTakeEmbeddings` (`update_take_embeddings`), `getTakeEmbeddings` (`get_take_embeddings`), `countStaleTakes` (`count_stale_takes`), `listStaleTakes` (`list_stale_takes`).
- **Postgres tables:** Embedding columns and state on `content_chunks`, `pages.embedding_signature`, take embeddings.
- **Keys:** `B` (core sub-layout).
- **Depends on:** vectors.
- **Estimate:** core.
- **Notes:** Reports the active embedding column the way the registry does.
- **Parity cases (9, in `chunks.test.ts`, `search.test.ts`, `takes.test.ts`):**
  - `chunks.test.ts`: getChunks includeEmbedding returns stored vectors; getChunksWithEmbeddings reads the full rows
  - `chunks.test.ts`: countStaleChunks, sumStaleChunkChars and listStaleChunks agree on which chunks lack a vector
  - `chunks.test.ts`: setPageEmbeddingSignature drives signature-aware stale counts and invalidateStaleSignatureEmbeddings
  - `chunks.test.ts`: invalidateContentDriftEmbeddings leaves vectors whose text still matches their embed-time hash
  - `chunks.test.ts`: readEmbeddingStateCounts and listEmbeddingStateRows classify every chunk and chunkless page
  - `chunks.test.ts`: deleteChunks removes every chunk of one page and leaves the others
  - `chunks.test.ts`: the same slug in two sources keeps separate chunk sets under sourceId scoping
  - `search.test.ts`: getEmbeddingsByChunkIds returns stored vectors keyed by chunk id
  - `takes.test.ts`: take embeddings: write, read back, vector search, and staleness accounting

### transactions (core)

Transactions and the page-key lock queue.

- **Files:** `gbrain-store/src/transactions.rs`, `gbrain-napi/src/families/transactions.rs`, `store-members/transactions.ts`.
- **Tag:** `w` (`LOCK_QUEUE`). Cascade on page delete: no.
- **Members (3), capability:** `transactions` (3).
- **Store and binding:** `transaction` (`transaction`), `transactionDirect` (`transaction_direct`), `lockPageKeys` (`lock_page_keys`).
- **Postgres tables:** No table: the BrainEngine `transaction` callback across napi, and the page-key lock queue.
- **Keys:** `w` (core sub-layout).
- **Depends on:** A store transaction that stays open across several napi calls from one TypeScript callback.
- **Estimate:** core, 3 days or more.
- **Notes:** `lockPageKeys` must order and release like the Postgres advisory locks.
- **Parity cases (9, in `facts.test.ts`, `lifecycle.test.ts`, `pages.test.ts`, `raw-sql.test.ts`, `segmented-body.test.ts`):**
  - `facts.test.ts`: listFactsKeyset pages oldest-first by (created_at, id) with no gaps or repeats, across two rows that share a timestamp
  - `lifecycle.test.ts`: transaction commits writes made through the tx handle and returns the callback value
  - `lifecycle.test.ts`: transaction rolls back every write when the callback throws and rethrows the same error
  - `lifecycle.test.ts`: a failed transaction leaves the engine usable for the next transaction
  - `lifecycle.test.ts`: transactionDirect commits on success and rolls back on throw
  - `lifecycle.test.ts`: a nested transaction joins the outer one: an outer throw rolls back inner writes too
  - `pages.test.ts`: lockPageKeys holds keys inside a transaction
  - `raw-sql.test.ts`: executeRawDirect answers like executeRaw and joins an open transaction
  - `segmented-body.test.ts`: a segmented page publishes generation 1 from staged texts and manifest rows

### relations (core)

The relation API that replaces raw SQL.

- **Files:** `gbrain-store/src/relations.rs`, `gbrain-napi/src/families/relations.rs`, `store-members/relations.ts`.
- **Tag:** `v` (`RELATION_CATALOG`). Cascade on page delete: no.
- **Members (5), capability:** `raw_sql` (5).
- **Store and binding:** `runMigration` (`run_migration`), `executeRaw` (`execute_raw`), `executeRawDirect` (`execute_raw_direct`), `keywordBoundedRead` (`keyword_bounded_read`), `withReservedConnection` (`with_reserved_connection`).
- **Postgres tables:** The relation API that replaces raw SQL (design D18).
- **Keys:** `v` (core sub-layout).
- **Depends on:** Track 2 of the design (moving raw SQL behind typed members).
- **Estimate:** core, not in the Dec 1 scope.
- **Notes:** `executeRaw` and the other members refuse for Dec 1.
- **Parity cases (5, in `lifecycle.test.ts`, `raw-sql.test.ts`):**
  - `lifecycle.test.ts`: withReservedConnection passes the callback value through, propagates errors, and leaves the engine usable
  - `raw-sql.test.ts`: executeRaw binds parameters, returns typed rows and sees the typed writes
  - `raw-sql.test.ts`: executeRawDirect answers like executeRaw and joins an open transaction
  - `raw-sql.test.ts`: runMigration runs every statement of a multi-statement script
  - `raw-sql.test.ts`: keywordBoundedRead runs the read and returns its value; a throw propagates and the engine stays usable

## Cases that need more than one family

These parity cases call members of several families. Each turns green only when every family it names is built;
until then it must still end on the refusal of the first refused member it reaches.

| File | Case | Families |
|---|---|---|
| `chunks.test.ts` | deleteChunks removes every chunk of one page and leaves the others | chunk_queries, embeddings |
| `chunks.test.ts` | the same slug in two sources keeps separate chunk sets under sourceId scoping | chunk_queries, embeddings |
| `code-eval-salience.test.ts` | batchLoadEmotionalInputs returns tags and active takes per page; slug filter narrows | salience, takes |
| `code-eval-salience.test.ts` | setEmotionalWeightBatch counts changed rows only, is source-keyed, and feeds getRecentSalience ordering | salience, takes |
| `facts.test.ts` | listFactsByEntity filters by kind, visibility, session, grep (wildcards literal) and consolidation | facts, takes |
| `facts.test.ts` | listFactsKeyset pages oldest-first by (created_at, id) with no gaps or repeats, across two rows that share a timestamp | facts, transactions |
| `facts.test.ts` | countUnconsolidatedFacts counts active entity-bound facts and ignores audit rows | facts, takes |
| `facts.test.ts` | getFactsHealth partitions active/expired/consolidated and ranks top entities | facts, takes |
| `links.test.ts` | getSalienceScores combines emotional weight and take count | salience, takes |
| `raw-sql.test.ts` | executeRawDirect answers like executeRaw and joins an open transaction | relations, transactions |
| `segmented-body.test.ts` | a segmented page publishes generation 1 from staged texts and manifest rows | page_body, transactions |
| `sync-aliases.test.ts` | rewriteLinks after updateSlug is a no-op: links follow the page id, not the slug | aliases, link_queries |
| `takes.test.ts` | take embeddings: write, read back, vector search, and staleness accounting | embeddings, takes, vectors |

## File ownership

| Files | Owner |
|---|---|
| The shared files listed in "Shared files no family edits" | core |
| `gbrain-store/src/<module>.rs`, `gbrain-napi/src/families/<module>.rs`, `store-members/<file>.ts` | the family named by the file |
| `test/rust-expected-divergence/<family>.tsv`, `rust/docs/store/<family>.md` | the family named by the file |
| `test/engine-parity/<area>.test.ts` | shared, append-only: a family may add a case for its own members, and never changes another family's case |
| `test/engine-parity/coverage.tsv` | generated (`bun test/engine-parity/coverage.ts --write`); never hand-merged |
| `src/core/<pglite,postgres>-engine*`, `src/core/engine-sql/*` | not touched: the Rust engine matches them, it does not change them |

Two families may both need a helper from a third (for example the trigram scorer that keyword and takes both use).
The family that owns the records the helper reads writes it, as a `pub(crate)` function in its own module; the
other family calls it. If both families are in progress at once, they agree on the signature first.

## Work plan toward Dec 1

About 52 days of family work are open, against about 9 or 10 working days until Dec 1, so six people working at
once is the plan. Every group below can start now; none waits for another group to finish before its first
member lands. Within a group, build in the order shown.

| Group | Families (in order) | Can start now | Estimate | Waits on |
|---|---|---|---|---|
| 1. Page reads and deletes | page_ops | yes | about 9 days | nothing to start; `deletePages` calls the eval_capture helper, which group 5 builds first (about half a day) |
| 2. Page state | extraction, then aliases | yes | about 10 days | `updateSlug` uses the core rename helper (built) |
| 3. Page bodies | page_body | yes | about 7 to 8 days | vector input to `stageSegmentChunks` refuses until embeddings; one case needs transactions |
| 4. Memory records | dream, contradictions, facts, ontology, raw_files, stats | yes | about 9 days | three facts cases need takes (group 5); `getHealth` last |
| 5. Takes and salience | eval_capture (first), takes, salience, code_edges | yes | about 7 to 8 days | the `takes` capability needs vectors and embeddings (core); code_edges needs the core chunk-delete hook |
| 6. Graph and search reads | timeline_queries, chunk_queries, link_queries, keyword | yes | about 9 days | keyword needs the `ts_rank` compatibility ranker; two chunk cases need embeddings |

Groups 1 and 2 share the `pages` capability: `pages` is reported only when page_ops, extraction and aliases are all
done. Group 2 is the longest and sets the critical path. If time runs short, the candidates to leave refused for
Dec 1 are `purgeDeletedPages`, `sweepSegments` and `getHealth`; each is a single member that refuses cleanly, so the
rest of its family still ships.

The estimates are judgments from the size of the PGLite code each member reproduces, not measurements.

### What stays with core and what it waits on

| Core item | Waits on | Needed by |
|---|---|---|
| Page-columns hook (`page_columns.rs`): family values that `getPage` returns (`emotional_weight`, `contextual_retrieval_mode`, segmented-body fields) | built | salience, aliases, page_body; extraction listed, likely unused |
| `pages::rename_page` helper | built | aliases (`updateSlug`) |
| Chunk-delete hook (`cascade::remove_chunk_rows`) | nothing | code_edges |
| Timeline entry helpers (`next_entry_id`, `read_entry`, `put_entry`) | built | timeline_queries (`upsertEventProjection`) |
| Event projection delete (`timeline_queries::remove_event_projections`, called by `remove_page`) | built; the family fills in the body | timeline_queries |
| Index hooks in `write_page` and `timeline.rs` if a family needs one | a family asking | page_ops, keyword, timeline_queries |
| `ts_rank` compatibility ranker | nothing | keyword, facts keyword arm |
| vectors (`X`): chunk and take vectors, vector search | the coming vector store work | embeddings, takes capability, page_body chunk vectors, `findCandidateDuplicates` with an embedding |
| embeddings (`B`): stale counts, signatures, embedding state | vectors | stats `getHealth`, chunk_queries shared cases, takes capability |
| transactions (`w`): the BrainEngine `transaction` callback across napi and `lockPageKeys` | a store transaction that stays open across napi calls | the nine cases that open a transaction |
| relations (`v`): the relation API in place of raw SQL | Track 2 of the design (D18) | not in the Dec 1 scope; `executeRaw` and the rest keep refusing |
| Source delete and its `cascade::remove_source_rows` list | nothing | facts and other source-keyed records |
