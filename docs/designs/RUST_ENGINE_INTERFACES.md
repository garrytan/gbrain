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

- `rust/crates/gbrain-store/src/{lib.rs,keys.rs,kv.rs,redb_kv.rs,env.rs,error.rs,format.rs,cascade.rs,page_columns.rs,page_index.rs,test_support.rs}`
- `rust/crates/gbrain-store/src/{pages.rs,sources.rs,config.rs,chunks.rs,search.rs,links.rs,timeline.rs,journal.rs}`
  (the families core already built)
- `rust/crates/gbrain-napi/src/{lib.rs,store_binding.rs,binding.rs,error.rs,pool.rs}` and `families/mod.rs`
- `src/core/rust-engine/{members.ts,store.ts,store-codec.ts,store-errors.ts,store-capabilities.ts,errors.ts}`,
  `store-members/{index.ts,common.ts}` and the store-member files of the families core built
- `src/core/error-registry.ts`, `docs/guides/error-codes.md`, `rust/README.md`
- `test/engine-parity/{harness.ts,rust-arm.ts,coverage.ts}`, `test/rust-engine-shell.test.ts`,
  `test/rust-engine-store.test.ts`, `test/rust-arm-harness.test.ts`

The list files (`lib.rs`, `families/mod.rs`, `index.ts`, `cascade.rs`, `page_columns.rs`, `page_index.rs`, `page_projection.rs`, the reserved block in
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
| `M` | meta: format record, id counters (`M next_<name>`), chunk stats, per-page segment chunk views (`M chunk_segment_view/<page id>`), per-page search timelines (`M page_search_timeline/<page id>`), owner-only marks (`M owner_only_mark/pages/<page id>`) | core |
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
| `o` | live page origins: `o <source> 0x00 <source_path> 0x00 <page id>` | core (pages) |

Rules:

- Ids are big-endian `u64` (`keys::id_key`, `keys::page_id`). A chunk index is a big-endian `u32`. Text parts are
  UTF-8 joined by a `0x00` byte (`keys::text`); a text part never contains `0x00`.
- **One tag per family.** Each planned family has one reserved tag below, one constant per family in `keys.rs`
  (a tag claimed on a branch is listed in the "Tag registry" until its constant reaches this tree). A new family takes
  a two-byte tag, `~` then one byte (see "Tag registry"). Every byte after the tag belongs to the family's module, which documents its sub-layout in its header.
  Use a second byte as a sub-table marker when the family has more than one table (for example `F 0x01 <id>` for
  rows and `F 0x02 <source> 0x00 <entity> 0x00 <id>` for an index).
- **Never reuse, reorder or repurpose a byte.** A family that is not listed takes an unused byte in a reviewed
  change to the reserved list. Byte `0x00` belongs to the storage engine adapter. The one-byte tags are nearly all
  taken: claim a tag through the "Tag registry" below, and give a new family a two-byte tag (`~` then one byte).
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
- **Format.** `FORMAT_VERSION` 8 (`format.rs` lists each version; a build opens formats 1 to 8), `engineAbi` 1, a `FORMAT` file plus `records.redb`. New tags and new records under
  them do not change the format version: an older build never reads a tag it does not know, and a newer build reads
  an absent tag as "no rows". A family that changes the encoding of records that already exist on disk asks core.
  Format 2 keeps each chunk-stats and unfinished-request counter in its own record; a format-1 brain is upgraded in
  one write transaction when it opens, and a format-1-only build refuses a format-2 brain.

- **Store format-number ledger.** Landing order decides each number: the second lander merges the first lander's head
  with `--no-ff` and takes the next free number, so the chain stays contiguous. Check it at every intake that changes
  `FORMAT_VERSION`.

  | Format | Change | Head | State |
  | --- | --- | --- | --- |
  | 8 | The format on `rust-engine/main` | `rust-engine/main` | landed |
  | 9 | Keyed lookups (PR 10277) | `7896376b` | planned, lands after the Nov 26 shadow release |
  | 10 | `vector-rank-key` | `4930072d` | planned, lands after the Nov 26 shadow release |
  | 11 | Refresh evidence reads (head 2) | `66e6c7ae` | planned |
  | 12 | Keyed lookups 2 (PR 10328, stacked on PR 10277) | `7896376b` | planned, lands after the Nov 26 shadow release |
  | 13 | Packed keyword index | `7896376b` | planned |

  The next free number is 14. A head that takes a number that is not its own in this table renumbers before it lands.

- **`SHADOW_ADAPTER_VERSION` ledger** (`src/shadow/evidence-epoch.ts`). One version per distinct adapter source (the
  digest of `store-members/**`, `store-codec.ts` and `members.ts` that `test/shadow-evidence.test.ts` pins). A lander
  that changes the source takes the next number at its final merge and recomputes the digest in the same commit; a head
  never keeps its own number. Check it at every intake that touches `store-members/**` or `src/shadow`.

  | Version | Tree |
  | --- | --- |
  | 6 | `rust-engine/main` f9592f7a7e (sync 17) |
  | 7 | Batch 14, 7c85d5696f (persistence binding reads, store listings, sync identity share, stored spellings, phone, repair kinds) |
  | 8 | `rust-engine/main` a597e7a6c6 (batch 14 plus sync 18: master's profile-facet trajectory filter, the snapshot refusals) |
  | 9 | Batch 15 (soak counter, request index states, page window chunk reads, concept rebuild, slug-spelling repair, loud search refusals and the members tail) |
  | 10 | Sync 19, dac09d5610 (batch 15 merged with master c341d40de3) |
  | 11 | Batch 15b (labelled-only policy on Rust, the purge-receipt and purge-ledger members of the fact purge path) |

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
| code_edges (`code_traversal_cache`) | `g` | `CODE_TRAVERSAL_CACHE` | no |
| salience | `s` | `SALIENCE` | yes |
| stats | `n` | `INGEST_LOG` | no |
| raw_files | `r` | `RAW_FILES` | yes |
| link_queries | `q` | `LINK_QUERIES` | no |
| wanted_links | `q`, sub-tag `W` (shared with link_queries) | `LINK_QUERIES` | yes |
| link_temporal | `q`, sub-tags `R` and `T` (shared with link_queries) | `LINK_QUERIES` | yes |
| timeline_queries | `u` | `TIMELINE_QUERIES` | no |
| keyword | `R` | `TRIGRAM` | no |
| chunk_queries | `c` | `CHUNK_QUERIES` | no |
| vectors (core) | `X` | `VECTOR` | yes |
| embeddings (core) | `B` | `EMBEDDING_STATE` | yes |
| transactions (core) | `w` | `LOCK_QUEUE` | no |
| relations (core) | `v` | `RELATION_CATALOG` | no |
| persistence (core) | `d` (requests stay under `J` / `j`, local writers under `W`) | `PERSISTENCE` | no |
| jobs (core) | `m` | `JOBS` | no |
| trust | `t` | `TRUST` | no (the trust family asks core when it needs the page-delete hook) |
| telemetry | `a`, one sub-tag per table (below) | `TELEMETRY` | no |
| jobs, the `dream_synthesis_completions` archive | `f` | `DREAM_SYNTHESIS_COMPLETION` | no |
| entity_identities | `i` | `ENTITY_IDENTITY` | yes |
| persistence_journal, the `derived_generations` ledger (with its attempt counters and valve windows), the `derivation_inputs` edges and their input index (`h 0x0A`, `h 0x0B`) | `h` | `DERIVED_GENERATION` | no (a source delete removes its rows) |
| access_rules (folder rules, pending prefixes, policy state and revisions; the module owns the sub-tags) | `z` | `ACCESS_RULES` | no |
| guest_sources (writers and trust ceiling of each guest source) | `0` | `GUEST_SOURCE` | no (a source delete removes its row) |
| reason_purge_tombstones | `1` | `REASON_TOMBSTONE` | no |
| session_state | `y` | `SESSION_STATE` | no |
| access_members | `x`, sub-tags `0x01` members, `0x02` groups, `0x03` group members | `ACCESS_MEMBERS` | no |
| secret_store (the `secret_store` entries and `secret_store_occurrence` rows; the module owns the sub-tags) | `3` | `SECRET_STORE` | yes (a hard page delete clears the occurrences' `page_id`, the purge then removes the page's occurrences and the entries only they held; a source delete removes the source's entries) |
| family escape: the first byte of every two-byte family tag (`keys::family_tag`) | `~` | `FAMILY_ESCAPE` | no |

The telemetry family (`telemetry.rs`) holds search telemetry (`src/core/search/telemetry.ts`), MCP usage
(`src/core/mcp-usage.ts`), retrieval feedback (`src/core/feedback/`) and the budget ledger
(`src/core/budget/daily-ledger.ts`). The byte after `a` names the table, and the family documents the rest of each key
in its module header:

| Sub-tag | Constant | Table |
|---|---|---|
| `0x01` | `TELEMETRY_SEARCH` | `search_telemetry` |
| `0x02` | `TELEMETRY_MCP_REQUEST` | `mcp_request_log` |
| `0x03` | `TELEMETRY_MCP_ROLLUP` | `mcp_request_log_rollup` |
| `0x04` | `TELEMETRY_RETRIEVAL_EVENT` | `retrieval_events` |
| `0x05` | `TELEMETRY_RETRIEVAL_EVENT_PAGE` | `retrieval_event_pages` |
| `0x06` | `TELEMETRY_RETRIEVAL_EVENT_LINK` | `retrieval_event_links` |
| `0x07` | `TELEMETRY_FEEDBACK` | `retrieval_feedback` |
| `0x08` | `TELEMETRY_RETRIEVAL_WEIGHT` | `retrieval_weights` |
| `0x09` | `TELEMETRY_BUDGET_LEDGER` | `budget_ledger` |
| `0x0A` | `TELEMETRY_BUDGET_RESERVATION` | `budget_reservations` |
| `0x0B` | `TELEMETRY_CHAT_USAGE` | `chat_usage_log` |
| `0x0C` | `TELEMETRY_VOLUNTEER_EVENT` | `context_volunteer_events` (reserved; no writer on this branch yet) |
| `0x0D` | `TELEMETRY_VOLUNTEER_SEQUENCE` | the `context_volunteer_events` id counter (reserved) |
| `0x0E` | `TELEMETRY_CHRONICLE_ROW` | `chronicle_page_state` (a page or source delete removes its rows, `chronicle_state.rs`) |
| `0x0F` | `TELEMETRY_CHRONICLE_RESERVATION` | `chronicle_judge_reservations` (read by `countRecentChronicleReservations`) |
| `0x10` | `TELEMETRY_CHRONICLE_SEQUENCE` | the `chronicle_judge_reservations` id counter |
| `0x11` | `TELEMETRY_ACCESS_READ_LOG` | `access_read_log` (`access_read_log.rs`) |

`eval_candidates` stays with eval_capture (`Z`). A new telemetry table takes the next unused sub-tag in a reviewed
change to this table and to `keys.rs`.

### Tag registry

The one-byte tags on `rust-engine/main` are the "Key layout" and "Reserved tags" tables above: every capital letter,
every small letter but `x` and `y`, and the digits `1` and `2` (and `0` on rust-engine/guest-sources-rust). The "Reserved tags" row for `x` (`ACCESS_MEMBERS`)
records a claim whose constant is still only on the access branches, listed below as a branch claim. This table lists every other tag claimed on any
branch, and the reserved ones, with the owner who claimed it. The rules:

- **Claim before you write.** A branch that adds a one-byte tag adds its row here in the same commit, with status
  `branch <name>`; the row stays until the constant reaches `rust-engine/main`, and then the "Reserved tags" row is
  the record. No row may take a byte that another row or a constant of `keys.rs` holds.
- **The digits `4` to `9` need approval.** A digit tag is claimed only by a row whose status starts with `approved`,
  which the manager's review grants. Once this rule is on `rust-engine/main`, the trunk refuses any digit `4`-`9`
  tag in `keys.rs` without an approved row here (the test below fails).
- **Every later family takes a two-byte tag.** `~` (0x7E, `keys::FAMILY_ESCAPE`) is reserved as an escape and is
  never a one-byte family. A new family takes `~` then one byte (`keys::family_tag(b'a')` is `~a`), declared in
  `keys.rs` as `pub const NAME: [u8; 2] = family_tag(b'a');` with a row here. The family owns every byte after the
  two. `~` sorts after every letter and digit, so each two-byte family is one contiguous range after the one-byte
  tags, and a prefix scan of `~a` reads family `~a` only. The family byte is never `0x00`. Adding the escape and
  two-byte tags writes nothing on disk, so `FORMAT_VERSION` does not change.

| Tag | Constant | Owner | Status |
|---|---|---|---|
| `x` | `ACCESS_MEMBERS` | interfaces lane (session a9fd5b22) | branch rust-engine/access-rules-rust (row 32a-1) and the access branches stacked on it |
| `y` | `SESSION_STATE` | not named on the branch; the trunk names it at intake | branch rust-engine/sync-checkpoint and the branches that contain 4601da37e0 |
| `0` | `GUEST_SOURCE` | lane 6 (guest sources, row 32m-3) | branch rust-engine/guest-sources-rust (from rust-engine/collate-equal 4573663d7f) |
| `3` | `SECRET_STORE` | lane 10 | reserved (the trunk holds it for the secret store) |
| `~` | `FAMILY_ESCAPE` | core | main once this lands: the escape for two-byte family tags |
| `~e` | `PAGE_EXTRACTION_STATE` | lane 8 (rust-members-tail) | branch rust-engine/rust-members-tail: the `page_extraction_state` family (the extraction watermark and partial-input receipt of a page); a hard page delete removes the page's rows; the tag `2` stays free |
| `~g` | `GUEST_MARK` | lane 6 (guest-note save) | branch rust-engine/guest-note-save-rust: the `guest_marks` family (who a guest note was saved for); a hard page delete removes the page's mark |

Free one-byte tags: the digits `4` to `9` (approved rows only) and punctuation other than `~`, which stays unclaimed
unless a reviewed change to this table names it.

`rust/crates/gbrain-store/tests/keys_registry.rs` fails when two constants of `keys.rs` take one tag byte (or one
sub-tag of a family), when these tag tables and `keys.rs` disagree, when a Tag registry row takes a byte another
constant or row holds, when a digit `4`-`9` tag has no approved row, when a constant other than `FAMILY_ESCAPE` takes
`~`, and when two two-byte family tags share a byte or one has no row.

The `q` tag is shared. link_queries and wanted_links both key records as `q <source id> 0x00 ...`; the byte after
`0x00` is `W` for a wanted_links record (`q <origin source id> 0x00 W <origin page id BE8> ...`), `R` for a
link_temporal relationship state row and `T` for a link_temporal transition row, and link_queries uses any other byte.
`keys::LINK_QUERIES` stays the one constant for all three; no family adds a tag.

code_edges keeps a chunk index under its own tag `H`, after its row sub-tags `0x01` to `0x06`, because the chunk
store keys chunks by page and index, not by id:

- `H 0x07 <chunk id BE8>` -> the page id, then `0` for no `symbol_name` or `1` and the name's bytes: every chunk by id.
- `H 0x08 <symbol_name> 0x00 <chunk id BE8>` -> empty: the chunks by `symbol_name`.
- `H 0x09` -> empty: set once the index covers every chunk.

### Page delete cascade

`pages::remove_page` deletes a page's versions, chunks and postings (the chunk-delete hook below fires for those
chunks), links and timeline entries, then the event projections that name the page (`timeline_queries::remove_event_projections`, below), then calls
`cascade::remove_page_rows`, which calls `remove_page_rows(tx, page)` in each family marked "yes" above. Today every
one of those hooks is empty. A family fills in only its own hook, inside the same write transaction, so the page and
everything under it go together or not at all. Soft delete never cascades: reads hide rows whose page has
`deleted_at` set, as PGLite's `deleted_at IS NULL` joins do. `files.page_id` is SET NULL in Postgres, so the raw_files
hook clears the page reference on file rows instead of deleting them.

Facts are not cascaded on page delete (Postgres keys them by slug, not by page id); facts reads hide facts whose page
is soft deleted. Source delete is not served by the Rust engine yet, but its list, `cascade::remove_source_rows`, is
built ("Core hooks"), so a family with records keyed by source fills in its hook now.

### Core hooks

Core calls each hook below from its own write or read path, in the same transaction or snapshot, through one list
file that names every family that needs the hook. Each listed family already has the hook function in its own
file, with an empty body. A family fills in only its own body, and never changes a signature or a list. A family
that is not on a list and needs the hook asks core for a one-line addition to the list.

A family that needs a call from a chunk write (`chunks::write_chunk`) or a build once per brain open (`Store::open`
and `seed`) asks Ember first. Those calls run on every chunk write and every open, for every family. After the yes,
the family adds the call in its own commit, apart from its family code, so the core change can be reviewed alone.

All hooks are empty today, so they change no answer: every served member reads and writes exactly as before. The
last four parts of this section are not hooks. They are core page behavior: the page origin rule lets `putPage`
store `source_path`, the nullable page fields let a page record hold a segmented shell, the segmented guard keeps
`putPage` off such a page, and the search timeline keeps the timeline text of the page keyword vector.

#### Page columns (`page_columns.rs`)

```rust
// In salience.rs, aliases.rs, extraction.rs, page_body.rs and trust.rs:
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
  (`body_storage` and `body_bytes` of a segmented page), trust (`trust_tier` and the write provenance fields). Extraction is on the list too, but PGLite's `getPage`
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

#### Chunk delete (`cascade::remove_chunk_rows`)

```rust
// In code_edges.rs, vectors.rs and embeddings.rs:
pub(crate) fn remove_chunk_rows(tx: &mut dyn KvWrite, page_id: u64, chunk_ids: &[u64]) -> Result<()>;
```

Postgres deletes a row that references a `content_chunks` id when that chunk is deleted (`ON DELETE CASCADE`). Core
calls this hook, in the same write transaction, with the ids of the chunks that are gone. Their chunk records are
already deleted when it runs; the ids are sorted and all belong to `page_id`.

- `deleteChunks` and a hard page delete report every chunk of the page. On a page delete the hook fires before
  `remove_page_rows`.
- `upsertChunks`, `putPage` and every other chunk rewrite report only the chunks whose index the new set does not
  keep. A chunk that keeps its index keeps its id, as in Postgres, so its rows stay. The hook is not called when no
  chunk is gone.
- A segment chunk delete (`delete_occurrence_chunks`, `delete_generation_chunks`, see "Segment chunks") reports the
  chunks it removed.
- **Owners:** code_edges (edges whose from or to chunk is gone). vectors and embeddings are on the list because their
  records hang off chunk ids in this store, while Postgres keeps them on the chunk row; their hooks stay empty if
  they key nothing by chunk id.

#### Segment chunks (`chunks.rs`)

```rust
pub(crate) fn append_segment_chunks(tx: &mut dyn KvWrite, page_id: u64, generation: u64, chunks: &[SegmentChunkInput]) -> Result<Vec<u32>>;
pub(crate) fn publish_segment_chunks(tx: &mut dyn KvWrite, page_id: u64, generation: u64, offsets: BTreeMap<u64, u64>) -> Result<()>;
pub(crate) fn delete_occurrence_chunks(tx: &mut dyn KvWrite, page_id: u64, occurrences: &BTreeSet<u64>, max_generation: Option<u64>) -> Result<Vec<u64>>;
pub(crate) fn delete_generation_chunks(tx: &mut dyn KvWrite, page_id: u64, generation: u64, keep: &BTreeSet<u64>) -> Result<Vec<u64>>;
pub(crate) fn delete_chunks_matching(tx: &mut dyn KvWrite, page_id: u64, pred: &dyn Fn(&ChunkRecord) -> bool) -> Result<Vec<u64>>;
pub(crate) fn count_chunks_matching(read: &dyn KvRead, page_id: u64, pred: &dyn Fn(&ChunkRecord) -> bool) -> Result<usize>;
pub(crate) fn visible_chunks(read: &dyn KvRead, page_id: u64) -> Result<Vec<ChunkRecord>>;
pub(crate) fn forget_segment_view(tx: &mut dyn KvWrite, page_id: u64) -> Result<()>;
```

The chunk rows of a segmented page body: PGLite's `content_chunks.occurrence_id`, `local_ordinal`, `raw_byte_start`,
`raw_byte_end` and `body_generation` columns. The page_body family calls these from `stageSegmentChunks` and the
generation flip, inside its own write transaction. They check nothing about the page body: the caller has already
decided the write is allowed. The contract is the "Segment chunks" comment in `chunks.rs`.

- **Record.** A segment chunk is a normal chunk record (`K page_id chunk_index`) with its `segment` field set
  (`SegmentPlace`: occurrence, local ordinal, raw byte span, the body generation it was staged for). An inline chunk,
  which `upsertChunks` and `putPage` write, has no `segment`. Records written before the field existed read as inline
  chunks, so the store format version stays 1.
- **Append.** `append_segment_chunks` writes the chunks at the indexes after the page's highest `chunk_index`
  (staged, live and retired rows all count, as PGLite's `COALESCE(MAX(chunk_index), -1) + 1`), in input order, and
  returns those indexes. It checks `chunk_source` as `upsertChunks` does, strips NUL from the text, and keeps no
  vector.
- **Staged chunks stay hidden until the flip.** A segment chunk is visible when its `body_generation` is at or below
  the page's view generation; an inline chunk is always visible (PGLite's `chunkVisibleFilter`). The view generation
  is a per-page copy kept by `chunks.rs` (`M chunk_segment_view/<page id>`, with the live occurrence offsets), because
  the body generation lives in the page_body family. It is 0 until the first publish. Keyword postings exist only
  for visible chunks, so a staged chunk is not searchable. `count_chunks` counts every chunk record, staged and
  retired included, as PGLite does.
- **Publish.** The flip calls `publish_segment_chunks` in its transaction. It records the page's new generation and
  the manifest `byte_start` of each live occurrence, and writes or removes the postings of the chunks whose
  visibility changed.
- **`get_chunks` filters by the current body generation.** It returns the visible chunks only, in PGLite's document
  order: segment chunks whose occurrence has a live offset by `(byte_start, local_ordinal, chunk_index)`, then the
  rest by `(local_ordinal, inline last, chunk_index)`. The output has no segment fields, as PGLite's `getChunks`
  columns have none. `visible_chunks` gives other families the same list.
- **Delete by occurrence or by generation.** `delete_occurrence_chunks` removes the segment chunks of the given
  occurrences (at or below `max_generation` when given). `delete_generation_chunks` removes the segment chunks of one
  generation whose occurrence is not in `keep`. Both go through `delete_chunks_matching`, which removes the chunks
  and their postings, updates the stats, and fires `cascade::remove_chunk_rows` once with the sorted ids of the
  removed chunks (not at all when none match). `count_chunks_matching` counts first, for the flip's `retireMaxRows`
  bound.
- **Page delete.** The page_body family calls `forget_segment_view` when a page is deleted for good (from its
  `remove_page_rows`). `deleteChunks` keeps the view, because the page and its generation remain.

#### Source delete (`cascade::remove_source_rows`)

```rust
// In facts.rs, aliases.rs, code_edges.rs, link_queries.rs, raw_files.rs, page_body.rs, takes.rs and extraction.rs:
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()>;
```

Postgres deletes every row whose `source_id` references a deleted source (`ON DELETE CASCADE`). This hook is for a
family's records keyed by source, not by page; records under a page go through the page and chunk hooks.

- **No caller yet.** The Rust engine does not serve source delete (TypeScript deletes sources with raw SQL, which the
  Rust engine refuses). When core serves it, one write transaction removes each page of the source with
  `pages::remove_page` (so the page and chunk hooks fire), then calls this list, then deletes the source record.
- **Owners** (the Postgres tables that cascade on `sources.id`): facts (`facts`, `fact_withdrawals`), aliases
  (`slug_aliases`, `page_aliases`), code_edges (`code_edges_chunk`, `code_edges_symbol`), link_queries
  (its own `q` records and the wanted_links family's `wanted_links` records, `q <source> 0x00 W ...`), raw_files (`files`), page_body (`page_segment_texts`, `page_body_stagings` and the other segment
  tables), takes (`take_proposals`, `take_nudge_log`), extraction (`extract_atoms_page_state`).
- **Not on the list:** eval_capture (`eval_candidates.source_ids` is a text array with no foreign key) and stats
  (`ingest_log` has no foreign key). A family that is not listed and keys records by source asks core for one line.
- **Shared `q` prefix.** `link_queries::remove_source_rows` deletes everything under `q <source> 0x00`, so it owns the
  source-delete cascade for both link_queries and wanted_links. It must not narrow that prefix (for example to the
  link_queries sub-keys only), or a source delete leaves the source's wanted links behind. wanted_links has no
  `remove_source_rows` of its own.
- The stubs in `facts.rs`, `link_queries.rs` and `wanted_links.rs` use full paths (`crate::kv::KvWrite`, `crate::Result`), so they need no
  import line in a file that has none yet.

#### Rename slug rows (`cascade::rename_slug_rows`)

```rust
// In facts.rs (full paths, so the file needs no import line):
pub(crate) fn rename_slug_rows(tx: &mut dyn KvWrite, source_id: &str, old_slug: &str, new_slug: &str) -> Result<()>;
```

Records keyed by a page's `(source, slug)` rather than its id do not follow a rename by themselves. PGLite's
`updateSlug` moves them in the rename transaction with `moveSlugBindings` (`src/core/page-state/rename-alias.ts`),
after the page row moves and the rename alias is recorded, and only when a row moved and the slug changed. This list
is the store's `moveSlugBindings`.

- **Caller:** the aliases family's `update_slug`, in the rename transaction, after `pages::rename_page` and the alias
  record, only when the slug changed. Core does not call it: `rename_page` moves only the page. A refusal from a
  listed family is returned from the write closure, so the rename keeps nothing.
- **On the list:** facts (`fact_withdrawals`, `facts`). page_aliases rows belong to the aliases family, which moves
  them in `aliases.rs` itself, so aliases is not on the list.
- **Keyed by** `(source_id, old_slug, new_slug)`, not by page id. A family moves every record of `source_id` keyed by
  `old_slug`, whether or not a page with that slug was live.
- **PGLite statements, in order** (`$1` source, `$2` old slug, `$3` new slug). The first runs as written; each later
  one runs in its own savepoint, and a missing `facts` or `page_aliases` table, or a missing `dimension` or
  `value_hash` column, skips that statement. The store has every family's records, so it skips nothing.
  1. `fact_withdrawals`: delete the rows with `subject = $2`, and insert each again with `subject = $3`
     (`ON CONFLICT DO NOTHING`: a withdrawal the new subject already holds stays as it was).
  2. `dropRekeyDuplicates` for facts with `entity_slug = $2`, as if their entity were `$3`: take the moving rows
     with a non-null `dimension` and the rows already at the new key, group them by `(entity_slug,
     source_markdown_slug, dimension, value_hash, valid_from)` (each part non-null), and keep the first of each
     group: rows outside the conversation slot first, then unexpired rows, then rows not moving, then the lower id. A loser's `superseded_by` pointers move to the kept row (the kept row's own pointer
     to a loser becomes NULL); a conversation-slot loser keeps its row with `dimension`, `value`, `value_hash` and
     `dim_status` cleared; every other loser is deleted.
  3. `UPDATE facts SET entity_slug = $3 WHERE source_id = $1 AND entity_slug = $2`.
  4. Delete the facts with `source_markdown_slug = $3` and a non-null `row_num` that a fact with
     `source_markdown_slug = $2` holds the same `row_num` for (the old page's fence wins).
  5. `dropRekeyDuplicates` for facts with `source_markdown_slug = $2`, as if their `source_markdown_slug` were `$3`.
  6. `UPDATE facts SET source_markdown_slug = $3 WHERE source_id = $1 AND source_markdown_slug = $2`.
  7. page_aliases (aliases family): delete the rows at `slug = $3` that a row at `$2` holds with the same
     `alias_norm` and `origin`.
  8. page_aliases (aliases family): `UPDATE page_aliases SET slug = $3 WHERE source_id = $1 AND slug = $2`.
- Sync's rename paths (`commands/sync/renames.ts`, `rename-collision.ts`) call `moveSlugBindings` too; they run
  through `executeRaw`, which the Rust engine refuses.

#### Page index (`page_index::reindex_page`)

```rust
// In keyword.rs and page_ops.rs (full paths, so neither file needs an import line):
pub(crate) fn reindex_page(
    tx: &mut dyn crate::kv::KvWrite,
    before: Option<&crate::pages::PageRecord>,
    after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()>;
```

A family keeps its own index of page fields (title trigrams, slugs by content hash) in step with page writes, in the
same transaction. `before` is the page as stored before the write; `after` is the page as stored after it.

- `(None, Some(after))` is a new page, `(Some(before), Some(after))` is any change to a stored page (including a soft
  delete, a restore, a rename, where `before.slug` is the old slug, and a tag change), and `(Some(before), None)` is a
  hard delete, called before the page record is deleted.
- `pages::write_page` and `pages::remove_page` call it; every page write goes through one of them, so a family that
  writes pages through core keeps every index right with no extra step.
- It fires on writes only, and on every write: also when no field the family indexes changed (a tag change, a
  sealed text projection). Compare `before` and `after` and return early. One store call can fire it more than once:
  a `putPage` that chunks the page writes the page, then writes it again to seal its text projection.
- Cost: `write_page` reads the stored page once by id before it writes (the same read keeps the origin index).
- **Owners:** keyword (`R` title trigram postings) and page_ops (its `p` indexes). A family that is not listed and
  needs the hook asks core for one line.
- The timeline date index (`u`, timeline_queries) is a different hook in `timeline.rs`; core adds it when that family
  asks.

#### Page projection (`page_projection::queue_page_projection`)

```rust
// In persistence.rs (full paths, so the file needs no import line):
pub(crate) fn queue_page_projection(
    tx: &mut dyn crate::kv::KvWrite,
    before: Option<&crate::pages::PageRecord>,
    after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()>;
```

The persistence family keeps the page projection queue (Postgres `page_projection_jobs`) in step with page writes,
in the same transaction, as PGLite's `gbrain_queue_page_projection` trigger does on every `pages` insert, update and
delete.

- It gets the same `(before, after)` forms as the page index hook, from the same two callers: `pages::write_page`
  and `pages::remove_page`. It fires after the page index hook, and for a hard delete before the page record is
  deleted.
- What the body must do (the trigger's rules): delete the job when the page is hard deleted, soft deleted, moved to
  another slug or source, or when `text_projection_revision` equals `knowledge_revision`; write the job when the page
  is new or its `knowledge_revision` changed.
- **Owner:** persistence. The body is `persistence/projection_queue.rs` (`rust/docs/store/persistence.md`, "Projection queue").

#### Page origin (`source_path` on `putPage`)

A page's origin is the file it records (`source_path`). PGLite allows one live page per origin in a source
(`assertOriginUnclaimed` in `persistence/origin-guard.ts`, the partial unique index `pages_live_origin_key`). The
store keeps the same rule in `pages.rs`.

- **What is stored.** `putPage` stores `source_path` on the page record. A write without one keeps the stored path
  (`COALESCE`). `getPage`, `readPageSnapshot` and `listPages` return it; the page `putPage` returns does not, as in
  PGLite.
- **The refusal.** A write that leaves a page live refuses when another live page of the same source records the
  same origin. The origin is the path the write sends, else the path the page already has (so a write that revives a
  soft-deleted page is checked too). A live page that already records the origin is not checked again, and an empty
  path is never checked. `restorePage` checks every page it would revive, in source order, before it revives any.
- **The error.** The store returns `origin_claimed` with a JSON message (`source_id`, `source_path`, `holders`,
  `slug`). `store-errors.ts` maps it to PGLite's error: `page_identity_changed`, detail `origin_already_claimed`, with
  the same message, hint and fix. The write transaction returns the error, so a refused write stores nothing.
- **Comparison.** Paths compare as written. On Windows, `\` reads as `/` and case is folded, as PGLite does.
- **Index.** Core key `o` holds one entry per live page with a non-empty path. `write_page` reads the page as stored
  before it writes and moves the entry; `remove_page` deletes it. So a soft delete frees the origin and a rename keeps
  it. A family that writes a page through `write_page` keeps the index right with no extra step.
- **Still refused.** A source in source-root slug mode whose directory is below its repository root also matches
  the older repository-root spelling of a path. Only the files on disk settle that (`sameSyncOrigin`), so
  `store-members/pages.ts` refuses `putPage` with a `source_path` for such a source.
- **Advisory locks.** PGLite takes a lock per origin so that two writers serialize. The store has one writer at a
  time, so it needs none.
- **Write guards.** The origin check, the origin bind, the ingest stamp, the import seal, the valid-time body
  read, the append path's tail-digest body read and the page write gate's stored tier read are typed engine members
  (`readPageOrigin`, `listOriginClaims`, `bindPageOrigin`, `stampPageIngest`, `sealImportedPage`, `readLivePageBody`,
  `readInlinePageRegions`, `readStoredPageTier`; SQL in `engine-sql/write-guards.ts`). The store answers them in
  `write_guards.rs`, and `bindPageOrigin` runs the same origin check as `putPage`. See
  [`rust/docs/store/write-guards.md`](../../rust/docs/store/write-guards.md).
- **Page visibility guards.** A remote page write's reads of whether the caller sees a page, which of a list of
  pages it reads, the opening probe of its visibility check, whether a live page fails the privacy part alone, and a
  stored writer's slug fence are typed engine members (`readPageHiddenFromCaller`, `readCallerPageAccess`,
  `readWriteVisibilityProbe`, `readPagePrivacyHidden`, capability `pages`;
  `readWriterSlugFence`, capability `persistence_journal`; SQL in
  `engine-sql/page-visibility.ts`). The store answers the page reads in `page_visibility.rs` and the fence from
  its local writer registration; an OAuth client's fence and an unrendered caller policy refuse. See
  [`rust/docs/store/page-visibility.md`](../../rust/docs/store/page-visibility.md).
- **Large-page guard.** A remote put_page's read of the stored body size of the page it replaces is a typed engine
  member (`readStoredBodyBytes`, capability `pages`, SQL in `engine-sql/large-page.ts`). The store answers it in
  `large_page.rs`: a segmented page's `body_bytes`, else the UTF-8 bytes of its body columns. See
  [`rust/docs/store/large-page.md`](../../rust/docs/store/large-page.md).
- **Member-access flag.** The store sets config `access.restrictions_present` to `'1'` when it writes a page whose
  frontmatter has a top-level `readable_by` key, as the v282 trigger `pages_access_mark_restricted` does on PGLite and
  Postgres (`access_flag.rs`). It sets it from the page write hook, from every store write handle on the put of such
  a page record, and once at open from the page records already stored, as v282 does when it runs. The store keeps
  no access members, so the `access_members` trigger has no store half. See
  [`rust/docs/store/access-flag.md`](../../rust/docs/store/access-flag.md).
- **Fence reads.** The fence projection's retire read and the fence guard's trust read are typed engine members
  (`listFenceRetireCandidates`, capability `facts`, SQL in `engine-sql/facts.ts`; `listFenceFactRows`, capability
  `facts`, SQL in `engine-sql/trust-fence.ts`), and the fact rows adapter's before-state read and restore (`readFactPreimages`,
  `restoreFactPreimage`, capability `facts`, SQL in `engine-sql/facts.ts`; its consolidation reads `readGenerationRestored`
  and `clearTieHeldGenerationRows` are capability `persistence_journal`, SQL in `engine-sql/derived-generations.ts`), the extracted facts adapter's own-row read and retire (`listFactIdsBySourcePrefix`, `expireFactRows`, capability `facts`,
  SQL in `engine-sql/facts.ts`), the page generation adapters' page row read (`readGenerationPageRows`, capability
  `persistence_journal`, SQL in `engine-sql/generation-page-rows.ts`, store in `generations/page_rows.rs`), the atoms adapter's input and legacy evidence reads (`readAtomOriginInput`,
  `listProducerVersionRows`, `listAtomWriteReceipts`, capability `persistence_journal`, SQL in
  `engine-sql/generation-atom-reads.ts`, store in `generations/atom_reads.rs`), and the take rows
  adapter's before-state read (`readTakePreimages`, capability `takes`, SQL in `engine-sql/takes-reads.ts`, store in `takes/reads.rs`). The store answers them in `facts/fence.rs` in the default write
  context (no writer tier, nothing opened), so `listFenceFactRows` is empty until the Rust write context supplies the
  writer's tier and the opened ids. See [`rust/docs/store/facts.md`](../../rust/docs/store/facts.md). The fence
  guard's read of held timeline rows is the typed member `listHeldTimelineRows` (capability `timeline`, SQL in
  `engine-sql/trust-fence.ts`), served from `timeline/held.rs`; see "Held timeline rows" in
  [`rust/docs/store/timeline_queries.md`](../../rust/docs/store/timeline_queries.md). Its read of held takes is
  `listHeldTakeRows` (capability `takes`, the same SQL text `heldRows` sent), served from `takes/held.rs`; see "Held
  takes" in [`rust/docs/store/takes.md`](../../rust/docs/store/takes.md).
- **Parity case:** `pages.test.ts`: putPage records source_path and refuses a second live page of the same file.

#### Nullable page fields (`PageText` in `pages.rs`)

PGLite lets four `pages` columns hold NULL. The page record holds NULL in the same four. `rust/docs/store/pages.md`
("Nullable page fields") and the `PageText` and `PageRecord` doc comments carry the full contract.

| Field | Rust type | NULL means | Written as NULL by |
| --- | --- | --- | --- |
| `compiled_truth`, `timeline` | `PageText` | a segmented shell page: its body lives in segment texts. PGLite's `pages_body_storage_chk` makes both NULL exactly when `body_storage = 'segmented'`; an inline page holds a string (`''` when empty) | the page_body family (`createSegmentedPageShell`, a generation flip); never `putPage` |
| `content_hash` | `Option<String>` | a shell page whose body is not published yet, as `createSegmentedPageShell` leaves it | the page_body family; `putPage` always sets a hash |
| `chunker_version` | `Option<i16>` | a record written before the store recorded one. `putPage` writes PGLite's value (`rust/docs/store/pages.md`) and a seal writes the safe fence version | nothing new; not part of the page JSON (PGLite's `rowToPage` leaves it out) |

- **Reading in Rust.** A NULL body reads as `""` through `&str` (`Deref`), so inline readers (`auto_chunks`, sizes,
  text matching) see an empty body. Use `is_null` or `as_deref` where NULL and `""` differ.
- **Equality.** NULL is never equal to `""`. A writer that moves a page between segmented and inline sees a change.
- **Page JSON.** `getPage`, `readPageSnapshot`, `listPages` and version rows send each NULL as `null`. The TypeScript
  codec (`guardNullBody` in `store-codec.ts`, called by `toGetPage` and `toListPage`) turns a `null` body into
  PGLite's segmented page: `compiled_truth` and `timeline` read as `''` behind getters that throw
  `page_body_segmented` (`guardSegmentedBody`, as PGLite's `rowToPage` does). `content_hash` stays `null`.
  `guardNullBody` reads only whether the body is null, never the text: its row in
  `scripts/page-body-readers-baseline.tsv` is `META`.
- **Empty overwrite.** A blank `putPage` over a live shell rejects `empty_overwrite` (`(segmented)` in the message)
  unless `allowEmptyOverwrite`, as PGLite does.
- **Versions.** A version snapshot copies the page's NULLs.
- **Format.** Records written before these fields were nullable hold strings and read unchanged. A record without
  `chunker_version` reads it as NULL, and the store writes `chunker_version` only when it is set. This needs no
  format version of its own.

#### Segmented guard (`putPage` over a segmented page)

PGLite keeps a segmented page's body out of the row with the CHECK `pages_body_storage_chk` (migration v248): an
inline row holds both body columns, a segmented row holds neither. `putPage` writes the body as one string, so the
CHECK refuses it over a segmented page. The store does the same in `pages.rs` (`assert_body_inline`). A NULL body
marks the segmented page in the store (see "Nullable page fields").

- **Blank body, not allowed.** A blank `putPage` over a live segmented page rejects `empty_overwrite` first, as
  PGLite's data-loss guard does (see "Nullable page fields").
- **Every other write.** A `putPage` over a segmented page, live or soft-deleted, with a body or with
  `allowEmptyOverwrite`, rejects `constraint_violation` with PGLite's message:
  `new row for relation "pages" violates check constraint "pages_body_storage_chk"`. PGLite's `ON CONFLICT` update
  sets the body, revives the row and keeps `body_storage = 'segmented'`, so the CHECK refuses the row. The store
  refuses inside the write transaction, after the revision and origin checks, so it stores nothing. The journal path
  (`submit_page_mutation`) goes through the same function.
- **Error code.** PGLite throws the raw Postgres error (code `23514`); the store uses `constraint_violation` with the
  same message. The page_body family's `refreshPageBody` refuses a segmented page the same way.
- **Reads.** The page JSON sends a segmented body as `null`, and the TypeScript codec gives PGLite's guarded page
  (see "Nullable page fields"), so reading `compiled_truth` or `timeline` throws `page_body_segmented` on both engines.

**Readers that see a NULL body.** NULL reads as `""` through `&str`, which is right for some readers and wrong for
others. Each family below must give the PGLite answer for a segmented shell page:

| Family and reader | Member | Today | PGLite for a segmented shell | What the family must do |
| --- | --- | --- | --- | --- |
| chunk_queries `chunkless_pages` | `countChunklessPagesWithContent`, `listChunklessPagesWithContent` | a segmented page counts when its published `body_bytes` (page_body body state, `segmented_body_bytes`) is positive; an unpublished shell does not | includes a segmented page with `body_bytes > 0` (`engine-sql/chunks.ts`, the chunkless queries) and returns `''` for its body and timeline (`COALESCE`) | test segmented pages by `body_bytes`, not by the body text; output `""`, never `null` |
| chunk_queries `get_chunk_windows` | `getChunkWindows` | `segmented: false` on every page row | the page row says `segmented: true` and carries no body; chunk rows carry their occurrence and span | report `segmented` from the page's body storage and send no body for a segmented page |
| extraction `stale_row` | `listStalePagesForExtraction` (and its count) | outputs `null` for the body | lists the shell; `rowToStalePage` returns `''` | keep the shell in the list and output `""` |
| page_ops `snapshot_json` | `readPageSnapshotsBatch` | outputs `null` for the body and `content_hash` | returns the page through `rowToPage`, so its body getters throw `page_body_segmented`; `content_hash` is `null` | keep the `null` in the JSON and decode each page in TypeScript with `toGetPage`, which applies the guard |
| page_ops `domain_bank_row` | `listPrefixSampledPages`, `listCorpusSample` | includes the shell with a `null` body | excludes segmented pages (`body_storage = 'inline'` in both queries) | skip pages whose body is NULL |
| page_ops `revert_to_version` | `revertToVersion` | overwrites the body | refuses a segmented page or a segmented version before it writes (`engine-sql/pages.ts`, `revertToVersion`) | refuse in the same way before any write |

These readers already match PGLite and need no change: page_ops `find_duplicate_in` (a shell has no hash, so it never
matches), the prior byte sum in `read_page_snapshots_batch` (a shell adds 0), page_body `refresh_page_body` (it
refuses as above), and core `auto_chunks` (`putPage` never reaches a shell now).

#### Search timeline (`pages::search_timeline`)

```rust
pub(crate) struct SearchTimeline { pub revision: String, pub timeline: String }
pub(crate) fn search_timeline(read: &dyn KvRead, page_id: u64) -> Result<Option<SearchTimeline>>;
pub(crate) fn record_search_timeline(tx: &mut dyn KvWrite, page_id: u64, revision: &str, timeline: &str) -> Result<()>;
pub(crate) fn forget_search_timeline(tx: &mut dyn KvWrite, page_id: u64) -> Result<()>;
pub(crate) const SEARCH_TIMELINE_MAX_CHARS: usize = 65_536;
```

PGLite's page keyword vector is the title (weight A) plus `left(sanitizeRemoteBody(timeline), 65536)` (weight C),
set when the page's chunks are sealed (`sealPageTextProjection`). The sanitizer stays in TypeScript, so the seal
carries its output to the store.

- **Input.** TypeScript `sealChunks` sends `searchTimeline: sanitizeRemoteBody(timeline)` in the `upsertChunks`
  options (`UpsertChunksOptions::search_timeline`) next to `seal: true`. A segmented page (NULL timeline) sends none.
  A write without `seal` ignores it.
- **Record.** The store keeps `{ revision, timeline }` under `M page_search_timeline/<page id>`, in the seal's
  transaction: the page's `knowledge_revision` at the seal, and the text with NUL removed and cut to
  `SEARCH_TIMELINE_MAX_CHARS` characters (Postgres `left` counts characters).
- **Read.** The keyword family (`searchTitles`) reads it with `search_timeline`. The text describes the page's
  current text when `revision` equals the page's `text_projection_revision`. `None` means no seal sent the text since
  the last write that set the title or timeline.
- **Forget.** `pub(crate) fn forget_search_timeline(tx: &mut dyn KvWrite, page_id: u64) -> Result<()>` deletes it.
  PGLite's `trg_pages_search_vector` (`BEFORE INSERT OR UPDATE OF title, timeline`) puts the trigger form back on
  every write whose `SET` list names either column, also with an unchanged value. `write_page` calls it when the title or timeline changed (`write_page_setting_vector` every time, for the statements that SET them: `putPage`, the refresh, the flip), after it has built the page's trigger-form vector
  (`keyword::check_page_vector`) and refused a vector past the 1,048,575-byte tsvector cap with PGLite's "string is too
  long for tsvector" error. `record_search_timeline` takes the page title and refuses a sealed vector past the cap the same way. The page_body family calls it from
  `refresh_page_body` and the body generation flip (through `write_page_setting_vector`, the flip after it has stored its body state, so the check reads the incoming lead), and `seal_segmented_page` calls `record_search_timeline`. `rust/docs/store/pages.md` ("Search timeline") lists each PGLite
  statement.
- **Delete.** `remove_page` deletes it on a hard delete. A soft delete keeps it.
- **Other writers.** A family that seals a page by another path and has the sanitized text from TypeScript calls
  `record_search_timeline` in the same transaction, and a family whose PGLite SQL sets the title or timeline calls
  `forget_search_timeline`; no family touches the key directly.

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
- **Large integers from JavaScript.** N-API gives serde every JavaScript number above 2^31 as a double, so an
  argument field typed `i64` or `u64` fails to decode when JavaScript sends a large integer. Send a large integer from
  TypeScript as a float in milliseconds (an `f64` field) or as a string, and convert it in Rust. This applies to every
  family.

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
are rounded to `f32` before arithmetic, then computed in `f64`. The store's keyword ranking is the `ts_rank` and `ts_rank_cd` compatibility
ranker (design D5, `keyword/rank.rs`); it has no expected difference (`search.tsv` is empty), so every keyword, title
and trigram case must match exactly.

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

Batch page reads and writes of the `pages` and `page_versions` capabilities (served; `pages` stays unreported while its other members refuse).

- **Files:** `gbrain-store/src/page_ops.rs`, `gbrain-napi/src/families/page_ops.rs`, `store-members/page-ops.ts`.
- **Tag:** `p` (`PAGE_OPS`). Cascade on page delete: no.
- **Members (18), capability:** `pages` (17), `page_versions` (1).
- **Store and binding:** `readPageSnapshotsBatch` (`read_page_snapshots_batch`), `findDuplicatePage` (`find_duplicate_page`), `findDuplicatePages` (`find_duplicate_pages`), `deletePages` (`delete_pages`), `resolveSlugsByPaths` (`resolve_slugs_by_paths`), `softDeletePages` (`soft_delete_pages`), `purgeDeletedPages` (`purge_deleted_pages`), `findPages` (`find_pages`), `countPagesBy` (`count_pages_by`), `getAllSlugs` (`get_all_slugs`), `listAllPageRefs` (`list_all_page_refs`), `listPrefixSampledPages` (`list_prefix_sampled_pages`), `listCorpusSample` (`list_corpus_sample`), `getContentFlagsByPageIds` (`get_content_flags_by_page_ids`), `getUnverifiedExtractionPageIds` (`get_unverified_extraction_page_ids`), `getPageTimestamps` (`get_page_timestamps`), `getEffectiveDates` (`get_effective_dates`), `readAdmittedPageRefs` (`read_admitted_page_refs`), `readPageSynopses` (`read_page_synopses`), `readSeedTitleSlugs` (`read_seed_title_slugs`), `readLiveSlugs` (`read_live_slugs`), `readLivePageTypes` (`read_live_page_types`), `readTrigramCandidates` (`read_trigram_candidates`), `readPrefixCandidates` (`read_prefix_candidates`), `readPrefixDirs` (`read_prefix_dirs`), `readPrefixTitleMatches` (`read_prefix_title_matches`), `readNamedEntitySlugs` (`read_named_entity_slugs`), `revertToVersion` (`revert_to_version`).
- **Postgres tables:** `pages` (read and soft/hard delete through `pages.rs`), `page_versions` (revert).
- **Keys:** No rows of its own are needed for parity. Use `p` only for an index the reads need (for example `p 0x01 <source> 0x00 <source_path> 0x00 <slug>` for `resolveSlugsByPaths`, `p 0x02 <source> 0x00 <content_hash> 0x00 <page id>` for duplicate lookup), kept in step by the core page index hook (`page_index::reindex_page`; the stub is in `page_ops.rs`). For `resolveSlugsByPaths`, the core `o` key already indexes live pages by `source_path` ("Page origin"); it holds no soft-deleted pages, so a read that needs them keeps scanning `all_pages` or adds its own `p` index.
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
- **Members (8), capability:** `pages` (8).
- **Store and binding:** `countStalePagesForExtraction` (`count_stale_pages_for_extraction`), `listStalePagesForExtraction` (`list_stale_pages_for_extraction`), `readExtractionLagCounts` (`read_extraction_lag_counts`, the `links_extraction_lag` doctor row), `markPagesExtractedBatch` (`mark_pages_extracted_batch`), `markPagesAttendanceBlocked` (`mark_pages_attendance_blocked`), `countStaleFrontmatterKeyPages` (`count_stale_frontmatter_key_pages`), `listStaleFrontmatterKeyPages` (`list_stale_frontmatter_key_pages`), `stripStaleFrontmatterKeys` (`strip_stale_frontmatter_keys`).
- **Postgres tables:** `pages.links_extracted_at`, `pages.timeline_extracted_at`, attendance-blocked state, `page_extraction_state`; frontmatter key rewrites go through core `write_page`.
- **Keys:** `e <page id>` holds one record with the extraction stamps and the attendance-blocked flag for that page. Removed by `remove_page_rows`.
- **Depends on:** Core page helpers. `stripStaleFrontmatterKeys` changes a page body: it writes through `write_page` and the version rules core uses. `getStats`/`getHealth` (stats family) read these stamps.
- **Estimate:** about 4 to 5 days.
- **Notes:** A page is stale for extraction when its body changed after the stamp: compare `updated_at_us` (or the body revision) with the stamp, as the PGLite query does. Same capability (`pages`) as page_ops and aliases.
- **Parity cases (6, in `extraction.test.ts`):**
  - `extraction.test.ts`: countStalePagesForExtraction: NULL stamp, older-than-version and edited-since-stamp are stale; deleted and quarantined are not
  - `extraction.test.ts`: listStalePagesForExtraction pages by id keyset, scopes by source and carries the page content
  - `extraction.test.ts`: markPagesExtractedBatch returns the rows stamped: wrong-source and unknown refs match nothing, empty input is 0
  - `extraction.test.ts`: readExtractionLagCounts counts live, actionable-stale, attendance-blocked and held pages in each statement shape
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
- **Depends on:** `updateSlug` moves the page key (`P`) from the old slug to the new one through core's `pages::rename_page` (built; "Core hooks"). This family versions the page first (`pages::snapshot_in`), then calls `rename_page`, then records the alias, moves its own slug bindings (`page_aliases`, statements 7 and 8 of "Rename slug rows"), and calls `cascade::rename_slug_rows` for the facts records. Links, chunks, tags, timeline and versions follow the page id and need no change.
- **Estimate:** about 5 to 6 days.
- **Notes:** Same capability (`pages`) as page_ops and extraction. `resolveSlugWithAliasDetailed` returns how the slug was found; keep its result fields exact.
- **Known gap:** the Rust store keeps no `alias_text` and no `case_sensitive` flag on `page_aliases` rows, so `resolveCaseSensitiveAliases` is always empty, `readPageAliasRows` gives `alias_text: null`, and `replaceDerivedAliases` stays unserved until alias storage exists (`rust/docs/store/alias_fanout_reads.md`). `findPagesByTitles`, `resolveAliases` and `aliasCanonicalRefs` with `excludePrivate` serve a caller's reader identity and private-readable grant; they refuse with `engine_capability_missing` for a caller whose policy differs in any other way (folder rules, lineage, an owner read), and the caller's fail-open fallback reads that as no rows.
- **Parity cases (11, in `sync-aliases.test.ts` and `alias-trust.test.ts`):**
  - `sync-aliases.test.ts`: updateSlug renames a page in place, keeps its chunks, and returns 0 when the old slug is absent
  - `sync-aliases.test.ts`: updateSlug is source-scoped and rejects a path-traversal new slug
  - `sync-aliases.test.ts`: a rename records an alias: resolveSlugWithAlias maps the old slug to the new one, per source
  - `sync-aliases.test.ts`: setPageAliases replaces a page alias set; resolveAliases maps normalized aliases to slugs with source scope
  - `sync-aliases.test.ts`: updatePageContextualRetrievalState stamps the CR mode without touching the body
  - `sync-aliases.test.ts`: rewriteLinks after updateSlug is a no-op: links follow the page id, not the slug
  - `alias-trust.test.ts`: resolveAliases drops aliases of pages below the floor or flagged, and their titles no longer shadow a derived alias
  - `alias-trust.test.ts`: resolveAliases under excludePrivate drops aliases of hidden pages, and a hidden title no longer shadows a derived alias
  - `alias-trust.test.ts`: resolveAliases under excludePrivate applies a caller's reader identity and private-readable grant
  - `alias-trust.test.ts`: the search alias fan-out resolves an entity by its alias under excludePrivate and a trust floor
  - `alias-trust.test.ts`: resolveAliases lists mixed-case and non-ASCII aliases, and the pages of one alias, in byte order

### page_body

Segmented page bodies: segment texts, manifests, staging and derivations.

- **Files:** `gbrain-store/src/page_body.rs`, `gbrain-napi/src/families/page_body.rs`, `store-members/page-body.ts`.
- **Tag:** `b` (`PAGE_BODY`). Cascade on page delete: yes.
- **Members (16), capability:** `page_body` (16).
- **Store and binding:** `allocateBodyOccurrenceIds` (`allocate_body_occurrence_ids`), `stageSegmentTexts` (`stage_segment_texts`), `readSegmentTexts` (`read_segment_texts`), `stageManifestRows` (`stage_manifest_rows`), `readManifest` (`read_manifest`), `stageSegmentChunks` (`stage_segment_chunks`), `createSegmentedPageShell` (`create_segmented_page_shell`), `flipBodyGeneration` (`flip_body_generation`), `sealSegmentedPage` (`read_segmented_seal_lead`, `seal_segmented_page`), `openBodyStaging` (`open_body_staging`), `setBodyStagingState` (`set_body_staging_state`), `sweepSegments` (`sweep_segments`), `readSegmentDerivations` (`read_segment_derivations`), `upsertSegmentDerivations` (`upsert_segment_derivations`), `retireSegmentDerivations` (`retire_segment_derivations`), `refreshPageBody` (`refresh_page_body`).
- **Postgres tables:** `page_segment_texts`, `page_body_manifest`, `page_body_stagings`, `page_segment_derivations`, `page_derivation_spend`.
- **Keys:** `b 0x01 <source> 0x00 <sha256>` segment text; `b 0x02 <page id> <occurrence id> <gen_from> <staging id>` manifest row (ids big-endian); `b 0x03 <staging id>` staging; `b 0x04 <page id> ...` derivations; `M next_body_occurrence_id` for occurrence ids. Page-keyed rows go in `remove_page_rows`; segment texts are kept until `sweepSegments`, as in PGLite.
- **Depends on:** Core page helpers for `createSegmentedPageShell`, `flipBodyGeneration`, `sealSegmentedPage` and `refreshPageBody` (page record writes go through `write_page`; the seal records the sanitized lead with `record_search_timeline`). `stageSegmentChunks` writes chunk rows through the core segment chunk helpers (built; "Segment chunks"), and refuses any input that carries a vector (`engine_capability_missing`). The flip publishes the view generation (`publish_segment_chunks`) and retires chunks with the segment chunk deletes. The generation-1 parity case also needs the transactions family.
- **Estimate:** about 7 to 8 days: texts and manifest 1 to 2, flip and staging 3, sweep 2, derivations 1.
- **Notes:** Segment bodies are bytes; sha256 and bodies cross the binding as hex or `Buffer`. `flipBodyGeneration` and `sweepSegments` are each one store write.
- **Segment storage probe:** `hasSegmentStorage` (capability `page_body`, in `write_guards.rs`) is true when any segment text (`b 0x01`) or body staging (`b 0x03`) exists. The journal reads it before it looks for segmented pages.
- **Page write rows.** The fence projection's timeline and takes statements are typed engine members:
  `removeTimelineRows` and `updateTimelineDetails` (SQL in `engine-sql/timeline.ts`; the store answers them in
  `timeline_queries.rs` through the core helpers `remove_entry` and `recompute_latest`) and `matchTakeRows` and
  `deleteTakeRows` (SQL in `engine-sql/takes.ts`; answered in `takes.rs`). See
  [`timeline_queries.md`](../../rust/docs/store/timeline_queries.md) and [`takes.md`](../../rust/docs/store/takes.md).
- **Connect gate reads:** `hasPersistenceTable`, `listManagedRootBindings`, `readGraduationGateRow` and `listRetiredDeactivations` (capability `persistence_journal`, SQL in `engine-sql/connect-gate.ts`) are answered in TypeScript from the one unmanaged brain the store keeps; they replace the raw-SQL capability checks the graduation and deactivation gates used. Caller-visible change: an engine that refuses one of these members now refuses the connect (or the retired-marker cleanup) with `engine_capability_missing`, where the old `lacksRawSql` skip read it as "no custody row"; only a missing table (`42P01`) still reads as no row. See [`rust/docs/store/journal.md`](../../rust/docs/store/journal.md).
- **Parity cases (6, in `segmented-body.test.ts`, `sync-aliases.test.ts`):**
  - `segmented-body.test.ts`: a segmented page publishes generation 1 from staged texts and manifest rows
  - `segmented-body.test.ts`: a replace flips to generation 2, closes retired rows and refuses a stale generation
  - `segmented-body.test.ts`: sweepSegments deletes closed rows and unreferenced texts and expires stale stagings
  - `segmented-body.test.ts`: segment derivations upsert by (page, kind, occurrence), read in order and retire dead occurrences
  - `segmented-body.test.ts`: sealing a segmented page shows its chunks at the current revision, again after a replace that keeps older chunks
  - `sync-aliases.test.ts`: refreshPageBody rewrites body, timeline and content hash; skips soft-deleted pages and other sources

### facts

Facts and their supersession chains.

- **Files:** `gbrain-store/src/facts.rs`, `gbrain-napi/src/families/facts.rs`, `store-members/facts.ts`.
- **Tag:** `F` (`FACT`). Cascade on page delete: no.
- **Members (15), capability:** `facts` (15).
- **Store and binding:** `insertFact` (`insert_fact`), `insertFacts` (`insert_facts`), `deleteFactsForPage` (`delete_facts_for_page`), `expireFact` (`expire_fact`), `listFactsByEntity` (`list_facts_by_entity`), `listFactsSince` (`list_facts_since`), `listFactsKeyset` (`list_facts_keyset`), `listFactsBySession` (`list_facts_by_session`), `listSupersessions` (`list_supersessions`), `countUnconsolidatedFacts` (`count_unconsolidated_facts`), `findCandidateDuplicates` (`find_candidate_duplicates`), `consolidateFact` (`consolidate_fact`), `findTrajectory` (`find_trajectory`), `getFactsHealth` (`get_facts_health`), `migrateFactsToCanonical` (`migrate_facts_to_canonical`).
- **Postgres tables:** `facts` (also the rows ontology reads; `superseded_by` is SET NULL on delete).
- **Keys:** `F 0x01 <fact id>` row; indexes under `F 0x02 <source> 0x00 <entity> 0x00 <valid_from us> <id>`, `F 0x03 <source> 0x00 <session> ...`, `F 0x04 <source> <created_at us> <id>` (keyset), `F 0x05 <source> 0x00 <source_markdown_slug> 0x00 <row_num>` (fence key, unique). `M next_fact_id`. Offer `pub(crate)` row reads and writes to the ontology family.
  - Built so far beyond the core rows (rust/docs/store/facts.md is the record of the bytes): `F 0x08` and `F 0x09`
    open loops, `F 0x0A` and `F 0x0B` the `fact_relink_attempts` record (`upsertFactRelinkAttempt`,
    `listFactRelinkOutcomes`, `deleteFactRelinkMemos`, and the tried, paid and no-subject memos the doctor's unlinked
    reads use). The attempts have no foreign key, so a fact or page delete leaves them, as in Postgres.
    The relink writes `placeRelinkedFact` and `linkConversationFact` change `F 0x01` rows through `write_fact`, so
    the fence key `F 0x05` refuses a held position as the unique index does. `listConversationRelinkPages`, the
    conversation relink's page pick, reads the source's `F 0x01` rows and the tried memos.
  - The reads `remember` and `forget` make before admission are typed members (`engine-sql/memory-mutation-reads.ts`:
    `readSourceWriteRow`, `readSourceLocalPath`, `readFactEntitySlug`, `hasLiveFileBackedPage`, `factReadableUnder`,
    `readRemoteForgetTier` for the remote forget guard in `trust/supersede-handlers.ts`, and `readForgetTarget` for the
    fact a forget names in `persistence/forget-prepare.ts`, with `isFactEntityUnbacked`, `readLinkedFactCopies`,
    `hasHiddenFactCopy` and `ownerReachesFact` for what its withdrawal reaches, and `readFactWithdrawalClaim` for the
    claim `planFactWithdrawal` in `facts/withdrawal.ts` changes).
    The store serves them from the source, `F 0x01` and page records (`memory_mutation_reads.rs`, no new key prefix;
    rust/docs/store/memory_mutation_reads.md). The member refuses a non-integer fact id and a caller whose world rule
    a member page or a private-facts grant widens, a remote provenance floor that is not the no-caller one, and
    `ownerReachesFact` for an owner bound to a member whose policy texts match no reference rendering. Pinned by `test/engine-parity/memory-mutation-reads.test.ts`
    and `test/engine-parity/forget-reach-reads.test.ts`.
  - The forget commit is typed too (`engine-sql/trust-withdrawals.ts`): `lockFactForWithdrawal`, `queueWithdrawalReview`,
    `listSegmentedPagesBySlug`, `bumpWithdrawnPageRevisions`, `readPageRevisions` and `appendFactForgetReason`, and
    `readFactWithdrawnRow` and `readFactWithdrawnBacking` for the `fact_withdrawn` refusal of a remember. The store
    serves them in `trust/withdrawal_commit.rs` (rust/docs/store/trust.md "The forget commit"). Pinned by
    `test/engine-parity/forget-commit.test.ts` and `test/engine-parity/forget-remember.test.ts`. `recordFactWithdrawal`
    itself locks the claim with `readFactWithdrawalClaim` (`lock`) and queues its review with `applyDecideReviewQueue`,
    so `lockFactForWithdrawal`, `queueWithdrawalReview`, `listSegmentedPagesBySlug`, `bumpWithdrawnPageRevisions` and
    `readPageRevisions` have no caller in `src/` yet. Still raw on Rust: the purge sweep's commit transaction and
    post-commit work (`facts/purge.ts`) and the forget's post-commit chunk rebuild (`page-state/projections.ts`).
    The write-request forget (lane 4) reaches these members and the typed `lockSourceRow`, `readFactWithdrawalClaim`,
    `applyDecideReviewQueue` and `insertWithdrawalEffects` calls, so `recordFactWithdrawal` makes no raw statement but the
    ledger and fence reads.
  - The purge plan, dry run and `--match` reads are typed (`engine-sql/facts-purge.ts` from `purgeSubjectPageLive` to
    `listNearestFactsForPurge`, and `engine-sql/facts-purge-plan.ts`, four members to `listPurgeProbeItems`). The store serves
    them in `facts/purge_plan.rs`, `facts/purge_probe.rs` and `page_body/purge_scan.rs` (rust/docs/store/purge-plan.md);
    it probes `links`, `timeline_entries`, `raw_data`, `wanted_links` and every other inventory table it keeps (bytea
    `minion_attachments.content` included), answers 0 for the tables it keeps no rows of, and refuses only naming
    `raw_data` rows. On Rust a purge plan and its dry run complete and equal PGLite. Pinned by
    `test/engine-parity/purge-plan.test.ts`, `test/engine-parity/purge-dry-run.test.ts` and
    `test/purge-plan-sql-pin.test.ts`.
  - The reads withdrawal discovery makes (`discoverWithdrawalTargets`, `facts/withdrawal-discovery.ts`) are one typed
    member, `readWithdrawalDiscovery(read)` (`engine-sql/withdrawal-discovery.ts`), tagged by `kind`: `claim_keys`,
    `provenance_pages`, `claim_matches`, `inline_fence_pages`, `segment_fence_rows`, `split_fence_slots`,
    `target_pages` and `sample_slugs`. PGLite and Postgres run the statement text the call site ran. The store serves
    every kind from the `F 0x01` fact rows, the page records and the live segmented-body rows with facts slots
    (`facts/withdrawal_discovery.rs`, no new key prefix; rust/docs/store/facts.md). The member refuses a cursor, limit
    or id that is not a safe integer. Pinned by `test/engine-parity/withdrawal-discovery-reads.test.ts`.
  - The page statements a fact withdrawal runs (`recordFactWithdrawal`, `facts/withdrawal.ts`) are two typed members
    (capability `facts`, `engine-sql/withdrawal-pages.ts`): `listSegmentedPages(sourceId, slugs)` and
    `invalidateWithdrawnPages(sourceId, slugs)`. PGLite and Postgres run the statement text the call site ran. The
    store reads and rewrites page records (`facts/withdrawal_pages.rs`, no new key prefix; rust/docs/store/facts.md)
    and clears the page's embedding signature. Pinned by `test/engine-parity/withdrawal-forget.test.ts`.
  - The withdrawal check a prepared import runs on a malformed facts fence (`assertPreparedFactWithdrawals`,
    `facts/withdrawal.ts`) is one typed member (capability `facts`, `engine-sql/withdrawal-fence.ts`):
    `hasWithdrawnFenceClaim(sourceId, claims, subject)`. PGLite and Postgres run the statement text the call site
    ran. The store reads the withdrawal ledger (`t 0x01`) and the purge ledger (`F 0x0F`) with both fingerprints
    (`facts/withdrawal_fence.rs`, no new key prefix; rust/docs/store/facts.md). Pinned by
    `test/engine-parity/withdrawal-fence.test.ts`.
  - Four owner-facing facts trust reads (`engine-sql/facts-trust.ts`) are served by the Rust engine
    (`store-members/facts-trust-owner.ts`, `facts/trust_owner.rs`, no new key prefix): `readFactForOwnerAction`,
    `countDerivedFactTaint`, `listLexicalContestCandidates` and `listStandingPreferences`. They read the stamped trust
    columns and the write-gate receipts. `matchSavedFacts` is served too (`facts/saved_match.rs`), for the `english`
    FTS language and the `CORRECTION_CUE` cue only. Pinned by `test/engine-parity/facts-trust-owner.test.ts`.
    `listExtractorFactsForClassification` (`store-members/facts-repair.ts`, `facts/extractor_classify.rs`) reads its
    receipts from the write journal's committed requests. Pinned by `test/engine-parity/facts-repair.test.ts`.
    The four repair previews that list facts (`gbrain repair consolidate-ties`, `facts-rehome`, `ontology-facts` and `duplicate-facts`)
    read through `listClosedConsolidationTies`, `listPagelessEntityFacts`, `listOntologyFactCandidates` and `listDuplicateFactRows`
    (`facts/repair_previews.rs`); the apply of each still writes through raw SQL. Pinned by
    `test/engine-parity/repair-facts-previews.test.ts`.
    The previews of `fact-claim-dates` (`listFactsOnValidDay`), `url-clone-fences` (`readLivePageByPath`) and `purged-page-facts`
    (`listPurgedPageFactCandidates`) are typed the same way, and the `captured-facts` preview was already served. Their applies
    are typed too (`engine-sql/repair-applies.ts`, `rust/docs/store/repair-applies.md`), so they run on a Rust brain; a
    `fact-claim-dates` page move stops by name ("repair fact-claim-dates page write"). Pinned by
    `test/engine-parity/repair-facts-previews-2.test.ts`.
    The scan of `facts-home` (`listFactsHomeCandidates`, `listHeldHomeRows`, `listOrphanedFenceRows`) and `readFacts`' snapshots (`readFactSnapshots`) are served from `facts/repair_home.rs`, so a strict source's preview of facts that need no folder-access read is equal on Rust; `holdingPageFor` rethrows a capability refusal rather than reading it as `access_unreadable`. The `visibility` and `open-facts` previews are typed (`engine-sql/visibility-scans.ts`, `open-facts-scans.ts`, `open-twins.ts`); a `visibility` page item or fenced fact stops at "repair visibility page write" and the `open-facts` apply at "repair open-facts privacy scan". Pinned by `test/engine-parity/repair-facts-previews-3.test.ts`.
  - Held fence cells. The world-only fact read's check of which facts-fence row lines a caller may not see
    (`eligibility/stamp.ts` `heldFenceLines`, under get_page, get_chunks, think and search_exact) is the typed member
    `listHeldFenceCells` (capability `facts`, SQL in `engine-sql/cli-reads-ops.ts`, one statement for PGLite and
    Postgres pinned by `test/fixtures/goldens/remote-reads/statements.json`). The store answers it in
    `facts/held_cells.rs`. For a member caller the TypeScript member passes the caller's member page, principal and
    page policy, and the store admits that page's private facts as `memberFactAdmitSql` does. For a caller with a
    private-facts grant it passes the granted sources, and the store admits the rows `grantedPrivateFactSql` admits.
    A page policy the store does not render refuses, and `heldFenceLines` then holds every fence line (fail closed). Before the member existed the
    check ran through `executeRaw`, which the Rust engine refuses, so a Rust brain held every fence line. Parity:
    `held-fence-cells.test.ts`.
- **Depends on:** None for the core members. Three cases also read takes (`countUnconsolidatedFacts`, `getFactsHealth`, the `listFactsByEntity` consolidation filter) and one needs the transactions family (keyset across a shared timestamp inside `transaction`). `findCandidateDuplicates` with an embedding needs core vectors (built); the keyword arm uses the keyword family's ranker. Source delete is not served yet (see "Page delete cascade"). A page rename moves facts and withdrawals keyed by the old slug: `cascade::rename_slug_rows` calls `facts::rename_slug_rows` ("Rename slug rows").
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

#### Design note: the short member-access form (built)

A remote read on a brain whose config `access.restrictions_present` was unset when the request began
(`CallerAccess.restricted` false) renders the member-access part of every page and fact policy as the short form
`p.page_readers IS NULL AND p.folder_rule_ids IS NULL` (plus the owner-only part, the same in both forms;
`accessAllowedForAllSql` in `search/private-visibility.ts`). The store judges the short form itself: the TypeScript
members render their comparison texts under the caller's own `restricted` value and send `open` for a short-form
caller. They no longer map such a caller to the full form. This note records why that is safe.

- **The premise.** The short form equals the full form only when no page names readers, no access member exists, and
  no folder rule or pending folder prefix exists: Postgres sets the flag in the same transaction as the first of each
  (triggers of v282 and v283), and the flag is sticky. Under the premise, `readersAllowedSql`, `folderRulesAllowedSql`
  and `originAllowedSql` pass every page, so the short form skips them, the lineage read included.
- **Derived `page_readers`.** No new store state. The column is `gbrain_access_readers(frontmatter)`, recomputed by a
  trigger on every write of `frontmatter` or `page_readers`, so it is NULL exactly when the frontmatter has no
  top-level `readable_by` key. The store already reads that as `names_readers` (`facts/privacy.rs`); an invalid value
  derives `['!nobody']`, which is not NULL, so the page stays hidden in both.
- **Derived `folder_rule_ids`.** The column is `gbrain_access_folder_rules(source_id, slug)` from the applied rulebook
  (`access_rules`, `access_policy_state`), stamped at insert, rename and policy apply. The store keeps no access tables,
  so the value is NULL on every Rust page by construction. A later rulebook family must stamp it on the same writes and
  set the flag as v283 does, or the short form would show a folder-restricted page.
- **Where the premise could fail on a Rust brain, and how the store closes it.** A page record with `readable_by`
  that reached the store without setting the flag (a build before `access_flag.rs`, or a later write path that
  skips `pages::write_page`) would leave the flag unset. The short form still hides that page (its `page_readers` is
  not NULL), but it shows an atom, question, concept or event page derived from it, which the full form's origin
  test hides. The store closes this in `access_flag.rs`: every store write handle (`Store::write`) sets the flag on
  the put of a page record that names readers, whatever path made the put, and the first open of a brain with no
  scan record reads every page record (soft-deleted ones too, as v282) and sets the flag if one names readers.
  The scan runs once per brain, so a flag an operator unsets by hand stays unset, as on Postgres. When the scan
  cannot write, the open goes on and that process reads the flag as `'1'` if a page names readers or the read
  does not finish (`Store::flag_assumed`).
- **The change.** `PrivacyPolicy` has `open: bool` (default false). When true, a page that names readers fails the
  member-access part for every identity, as the short form's `page_readers IS NULL` does. The rest of the part
  (the origin walk) is read only when the store's own flag is `'1'`: a caller whose flag read was stale gets the
  full form's origin test, which fails closed. `storePrivacyPolicy` and `storePageTextPolicy` render their
  no-caller comparison texts under the caller's own `restricted` value and send `open`. The store reads live page
  state for each row, as the short form reads live columns, so a page that gains readers during the request is
  still hidden.
- **Parity.** `restriction-flag-reads.test.ts` and `unrestricted-caller-reads.test.ts` run both forms: an unflagged
  brain serves the short form, a flagged brain still hides a page derived from a `readable_by` origin, and a
  short-form caller with the member identity still does not see a `readable_by` page (the old mapping showed it).
  Postgres cannot seed the failed-premise brain (its trigger sets the flag), so the open-time scan and the write
  handle have store tests (`tests/access_flag.rs`, the unit tests in `access_flag.rs`).
- **Gain.** Honest text equality (no mapped caller) and no origin reads on unflagged Rust brains. Store test:
  `tests/page_visibility.rs` (`the_open_form_hides_every_page_that_names_readers_and_reads_the_store_flag_for_origins`).

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
- **Members (12), capability:** `takes` (12).
- **Store and binding:** `addTakesBatch` (`add_takes_batch`), `listTakes` (`list_takes`), `searchTakes` (`search_takes`), `updateTake` (`update_take`), `supersedeTake` (`supersede_take`), `resolveTake` (`resolve_take`), `getScorecard` (`get_scorecard`), `getCalibrationCurve` (`get_calibration_curve`), `addSynthesisEvidence` (`add_synthesis_evidence`), `listActiveTakesForPages` (`list_active_takes_for_pages`), `matchTakeRows` (`match_take_rows`), `deleteTakeRows` (`delete_take_rows`).
- **Postgres tables:** `takes` (unique `(page_id, row_num)`), `synthesis_evidence`, read of `take_grade_cache` for `ungradedFirst`.
- **Keys:** `A 0x01 <take id>` row; `A 0x02 <page id> <row_num u32>` to the take id (unique); `A 0x03 <synthesis page id> <take page id> <row_num>` evidence; `A 0x04 <take page id> <row_num> <synthesis page id>` reverse evidence. `M next_take_id`. `remove_page_rows` deletes the page's takes and every evidence row that names it.
- **Depends on:** Core page helpers for slug and visibility joins. Vector search over takes and take embeddings belong to core (vectors, embeddings; both built), so the `takes` capability is reported.
- **Estimate:** about 4 days.
- **Notes:** `weight` is REAL: clamp and round as `buildTakeRows` does, then store as `f32`. `since_date` is text compared after padding, not a date. `searchTakes` is a trigram `word_similarity` score: share the keyword family's trigram code once it exists, or build `pg_trgm` scoring in this family and let keyword call it.
- **Parity cases (21, in `code-eval-salience.test.ts`, `facts.test.ts`, `links.test.ts`, `takes.test.ts`):**
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
  - `takes.test.ts`: matchTakeRows lists the stored takes a fence row would collide with, null-safe, ascending, limited, for one page only
  - `takes.test.ts`: deleteTakeRows deletes the page takes at the listed row numbers with their evidence, and an empty list deletes nothing

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
- **Decide store (inside this family):** 20 more members serve the decide tables `decide_state`, `decide_spend`, `decision_receipts` and `decide_calibrations` under sub-tags `Z 0x10..=0x15` (record in rust/docs/store/decide-store.md): `readDecideState`, `upsertDecideState`, `deleteDecideState`, `ensureDecideState`, `insertDecideSpend`, `dailyDecideSpend`, `listDecideSpendBySlot`, `insertDecideReceipts`, `pruneDecideReceipts`, `listDecideReceiptStats`, `decideSlotUsage`, `decideConflictNoEntityCounts`, `listDecideReplayReceipts`, `listDecideResolvedModels`, `listDecideMixedModelDecisions`, `insertDecideCalibration`, `storeDecideQualification`, `listDecideCalibrations`, `getDecideCalibration`, `setDecideCalibrationRetired`. Parity: `test/engine-parity/decide-store.test.ts`.
- **Postgres tables:** `eval_candidates`, `eval_capture_failures`.
- **Keys:** `Z 0x01 <id>` candidate; `Z 0x02 <id>` failure; `M next_eval_candidate_id`, `M next_eval_failure_id`. Expose `pub(crate) fn remove_retrieved_slugs(tx, source_id, slugs)` for page_ops.
- **Depends on:** None.
- **Estimate:** about half a day.
- **Notes:** Read the PGLite `ORDER BY` for both list members before porting; `retrieved_chunk_ids` has no FK, so a chunk delete does not touch it.
- **Parity cases (3, in `code-eval-salience.test.ts`):**
  - `code-eval-salience.test.ts`: logEvalCandidate round-trips every field through listEvalCandidates, with tool filter and limit
  - `code-eval-salience.test.ts`: listEvalCandidates since-window and deleteEvalCandidatesBefore split old from new rows
  - `code-eval-salience.test.ts`: logEvalCaptureFailure records reasons; listEvalCaptureFailures filters by since

### calibration_profiles

Generated calibration profiles per holder and source (decide family, group B). Shares the eval_capture tag and capability.

- **Files:** `gbrain-store/src/eval_capture/calibration_profiles.rs`, `gbrain-napi/src/families/calibration_profiles.rs`, `store-members/calibration-profiles.ts`; the SQL is `src/core/engine-sql/calibration-profiles.ts`. Detail: `rust/docs/store/calibration-profiles.md`.
- **Tag:** `Z` (`EVAL_CAPTURE`), sub-tags `0x20` (record) and `0x21` (newest-first index). Cascade on source delete: the store removes the source's rows (`remove_source_rows`, unit-tested only: the Rust store serves no source delete yet).
- **Members (5), capability:** `eval_capture` (5): `getLatestCalibrationProfile`, `isCalibrationProfileUnchanged`, `insertCalibrationProfile`, `readVoiceGateHealth`, `purgeCalibrationProfilesByWave`.
- **Postgres tables:** `calibration_profiles`.
- **Parity cases (5, in `calibration-profiles.test.ts`):** newest profile with filters and id tie-break; unchanged check (REAL-rounded, NULL-safe); insert defaults and refusals that write nothing; voice-gate health over the 7-day window; wave purge dry run and delete.
- **Notes:** The other undo-wave statements (takes, take_grade_cache, take_nudge_log) stay raw SQL and refuse on a Rust brain.

### decide_proposals

The decide loop's four proposal tables (group C). All members use the `eval_capture` capability and its key tag.

- **Files:** `gbrain-store/src/eval_capture/decide_proposals.rs`, `gbrain-napi/src/families/decide_proposals.rs`, `store-members/decide-proposals.ts`, `src/core/engine-sql/decide-proposals.ts`.
- **Tag:** `Z` (`EVAL_CAPTURE`), sub-tags `0x30..=0x3D`. Cascade on page delete: no.
- **Members (16), capability:** `eval_capture` (16): `insertDecideProposal`, `getDecideProposal`, `listDecideProposalIds`, `listDecideProposals`, `transitionDecideProposal`, `listDecideProposedPairs`, `insertDecideReviewProposal`, `listDecideReviewProposals`, `getDecideReviewProposal`, `transitionDecideReviewProposal`, `listDecideReviewProposalIds`, `readProposalReviewRates`, `listDueDecideReviewQueue`, `applyDecideReviewQueue`, `listDueDecideSweepDeferred`, `applyDecideSweepDeferred`.
- **Postgres tables:** `decide_proposals`, `decide_review_proposals`, `decide_review_queue`, `decide_sweep_deferred`.
- **Keys and contract:** [rust/docs/store/decide-proposals.md](../../rust/docs/store/decide-proposals.md). `lock` on the two `get` members is ignored (one writer); `engine.transaction` is served.
- **Parity cases (8, in `decide-proposals.test.ts`).**

### code_edges

Code call edges between chunks and symbols.

- **Files:** `gbrain-store/src/code_edges.rs`, `gbrain-napi/src/families/code_edges.rs`, `store-members/code-edges.ts`.
- **Tag:** `H` (`CODE_EDGE`). Cascade on page delete: yes.
- **Members (5), capability:** `code_edges` (5).
- **Store and binding:** `addCodeEdges` (`add_code_edges`), `deleteCodeEdgesForChunks` (`delete_code_edges_for_chunks`), `getCallersOf` (`get_callers_of`), `getCalleesOf` (`get_callees_of`), `getEdgesByChunk` (`get_edges_by_chunk`).
- **Traversal cache (group D):** `getCodeTraversalCache` (`get_code_traversal_cache`), `putCodeTraversalCache` (`put_code_traversal_cache`), `clearCodeTraversalCache` (`clear_code_traversal_cache`), in `gbrain-store/src/code_edges/traversal_cache.rs` and `store-members/code-traversal-cache.ts`, under tag `g` (`CODE_TRAVERSAL_CACHE`, no cascade: the table has no foreign key). See `rust/docs/store/code-traversal-cache.md`.
- **Postgres tables:** `code_edges_chunk`, `code_edges_symbol`, `code_traversal_cache`.
- **Keys:** `H 0x01 <edge id>` row; `H 0x02 <from chunk id> <edge id>`; `H 0x03 <to chunk id> <edge id>`; `H 0x04 <source> 0x00 <to symbol> 0x00 <edge id>`.
- **Depends on:** Core chunk ids. Postgres deletes edges when their chunk is deleted. Fill in this family's `remove_chunk_rows` hook (built; "Core hooks"): it gets the ids of every chunk that is gone, on a chunk replace, `deleteChunks` and a hard page delete.
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
- **Members (7), capability:** `health` (5), `ingest_log` (2).
- **Store and binding:** `getStats` (`get_stats`), `getHealth` (`get_health`), `countOnboardSignal` (`count_onboard_signal`), `logIngest` (`log_ingest`), `getIngestLog` (`get_ingest_log`), `listEnrichCandidates` (`list_enrich_candidates`), `findAnomalies` (`find_anomalies`).
- **Postgres tables:** Counts over every table; `ingest_log`.
- **Keys:** `n <created_at us> <id>` ingest log row; `M next_ingest_log_id`.
- **Depends on:** Reads every family. `getHealth` reads extraction stamps and embedding coverage, so finish it last. The embedding counts read the stored vectors of the active column; a brain whose config names another column refuses (`rust/docs/store/stats.md`). `listEnrichCandidates` and `findAnomalies` read salience and timeline.
- **Estimate:** about 2 to 3 days.
- **Notes:** Health lists order with `COLLATE "C"` (byte order). `getStats` counts links only when both ends are in scope. `countOnboardSignal` is served because a production caller reaches it on a Rust brain: the MCP onboarding coach (`src/core/onboard/mcp-onboarding.ts:72`, started by `src/mcp/server.ts:551` and read by `src/mcp/dispatch.ts:1464`). It counts brain-wide, with no source scope.
- **Parity cases (7, in `code-eval-salience.test.ts`, `config-ingest.test.ts`, `search-reads.test.ts`):**
  - `code-eval-salience.test.ts`: listEnrichCandidates picks thin pages by type, counts inbound links, orders and limits, and scopes by source
  - `code-eval-salience.test.ts`: findAnomalies flags a cohort with unusual activity today and respects source scope and sigma
  - `config-ingest.test.ts`: getStats counts pages, chunks, embeddings, links, tags and timeline entries
  - `config-ingest.test.ts`: getStats and getHealth confine to a source scope
  - `config-ingest.test.ts`: getHealth reports coverage, orphans, missing embeddings and the score parts
  - `config-ingest.test.ts`: logIngest then getIngestLog returns entries newest-first with a limit and source scope
  - `search-reads.test.ts`: countOnboardSignal: the six onboarding counts under a per-source entity-type filter

### raw_files

Raw source data and files attached to pages.

- **Files:** `gbrain-store/src/raw_files.rs`, `gbrain-napi/src/families/raw_files.rs`, `store-members/raw-files.ts`.
- **Tag:** `r` (`RAW_FILES`). Cascade on page delete: yes.
- **Members (5), capability:** `raw_data` (2), `files` (3).
- **Store and binding:** `putRawData` (`put_raw_data`), `getRawData` (`get_raw_data`), `upsertFile` (`upsert_file`), `getFile` (`get_file`), `listFilesForPage` (`list_files_for_page`).
- **Postgres tables:** `raw_data` (page CASCADE), `files` (`page_id` SET NULL, `page_slug` text).
- **Keys:** `r 0x01 <page id> 0x00 <source name>` raw data; `r 0x02 <storage path>` file; `r 0x03 <page id> 0x00 <file id>` page index. `remove_page_rows` deletes raw data and clears `page_id` on files (it keeps the file rows).
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
- **Keys:** No new rows for most members; `q` is for derived-link bookkeeping if `replaceDerivedLinks` needs it (`q <source> 0x00 <origin page id> ...`). The byte `W` after `q <source> 0x00` belongs to wanted_links; link_queries keys never start with it there. `remove_source_rows` deletes the whole `q <source> 0x00` prefix, wanted links included, and must not narrow it. Link rows themselves are written only through the `links.rs` helpers.
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

### wanted_links

The `wanted_links` table reads and writes that `listWantedPages` needs: authored links whose target page does not
exist (`src/core/wanted-links-store.ts`). TypeScript reaches the table through `executeRaw` today, which the Rust
engine refuses.

- **Files:** `gbrain-store/src/wanted_links.rs` (stub, with an empty `remove_page_rows`).
- **Tag:** `q` (`LINK_QUERIES`), sub-tag `W`, shared with link_queries. Cascade on page delete: yes
  (`wanted_links.origin_page_id` is `ON DELETE CASCADE`).
- **Keys:** `q <origin source id> 0x00 W <origin page id BE8> ...`. `wanted_links.rs` defines the bytes after `W`.
- **Source delete:** no hook of its own. `link_queries::remove_source_rows` deletes the whole `q <source> 0x00`
  prefix, these records included.
- **Postgres tables:** `wanted_links`.

### link_temporal

Link temporal state: the `link_transitions` and `link_relationships` rows of temporal link types, the keyword index
rebuild counts and the retrieval coverage counts. Detail: `rust/docs/store/link_temporal.md`.

- **Files:** `gbrain-store/src/link_queries/link_temporal.rs`, `gbrain-store/src/link_queries/retrieval_coverage.rs`, `gbrain-napi/src/families/link_temporal.rs`, `store-members/link-temporal.ts`, `store-members/link-refresh.ts`.
- **Tag:** `q` (`LINK_QUERIES`), sub-tags `R` and `T`, shared with link_queries. Cascade on page delete: yes (`remove_page_rows` drops the rows whose from, to or origin page it is).
- **Keys:** `q <source> 0x00 R <from BE8> <to BE8> <link_type> 0x00 <scope>` (state row) and `q <source> 0x00 T <from BE8> <to BE8> <link_type> 0x00 <id BE8>` (transition); counter `M link_transition_id`.
- **Members (21), capability:** `links` (12), `keyword_search` (4, a no-op under `english`), `health` (5: `countEmbeddingHeldPages`, `countPendingProjectionPages`, `projectionRebuildProgress`, `readProjectionReadinessGeneration`, `readProjectionReadiness`).
- **Postgres tables:** `link_transitions`, `link_relationships`, `links.assertion_tense`; SQL in `src/core/engine-sql/link-temporal.ts`, `search-vector.ts`, `retrieval-coverage.ts`.
- **Parity cases:** `test/engine-parity/link-temporal.test.ts`, `test/engine-parity/retrieval-coverage.test.ts`.
- **Follow-ups:** When the transactions core item lands,
  the refresh after a link write and the temporal and wanted steps of a derived-link publication run in one store
  transaction, as on PGLite and Postgres.

### entity_identities

Cross-source identity groups (migration v137): manual links, lookups, the canonical twin. Detail: `rust/docs/store/entity_identities.md`.

- **Files:** `gbrain-store/src/entity_identities.rs`, `gbrain-napi/src/families/entity_identities.rs`, `store-members/entity-identities.ts`.
- **Tag:** `i` (`ENTITY_IDENTITY`). Cascade on page delete: yes (`remove_page_rows` drops the page's membership and its group key).
- **Keys:** `i 0x01 <page id BE8>` to the membership JSON; `i 0x02 <entity_id> 0x00 <page id BE8>` (empty, the group index).
- **Members (5), capability:** `entity_identities` (5): `linkEntityIdentityRow`, `unlinkEntityIdentityRow`, `listEntityIdentityRows`, `readEntityIdentityIdsForPages`, `readCanonicalTwin`.
- **Postgres tables:** `entity_identities`; SQL in `src/core/engine-sql/entity-identities.ts`.
- **Parity cases:** `test/engine-parity/entity-identities.test.ts`.
- **Known gap:** the store page policy has no owner-only rule, so the list refuses a policy read typed while an owner-only source exists (TODOS `rust-owner-only-page-policy`).

### secret_store

The secret store (GST-2988) and the page-store reads and writes of `gbrain repair secret-spans`. Detail: `rust/docs/store/secret-store.md`.

- **Files:** `gbrain-store/src/secret_store.rs`, `gbrain-store/src/repair_secret_spans.rs`, `gbrain-store/src/timeline_queries/redaction.rs`, `gbrain-napi/src/families/secret_store.rs`, `store-members/secret-store.ts`.
- **Tag:** `3` (`SECRET_STORE`). Cascade on page delete: yes (see the tag table).
- **Keys:** `3 0x01 <entry id>` the entry; `3 0x02 <source> 0x00 <value mac>` the entry id; `3 0x03 <entry id> 0x00 <occurrence id BE8>` and `3 0x05 <source> 0x00 <slug> 0x00 <occurrence id BE8>` and `3 0x06 <page id BE8> <occurrence id BE8>` (empty, the occurrence indexes); `3 0x04 <occurrence id BE8>` the occurrence. `M next_secret_occurrence_id`.
- **Members (31), capability:** `persistence_journal`: `findSecretEntryByMac`, `secretEntryExists`, `insertSecretEntry`, `insertSecretOccurrence`, `readSecretEntry`, `listSecretOccurrences`, `listSecretEntrySummaries`, `countSecretsByRule`, `listAllowedSecretMacs`, `listSecretKeysInUse`, `readSecretStoreSnapshot`, `insertBackupSecretEntry`, `readBackupEntryHold`, `insertBackupSecretOccurrence`, `deleteUnreferencedSecretEntry`, `listSecretHoldingPages`, `countUnreferencedSecretEntries`, `readRestorePageHit`, `markSecretEntryAllowed`, `readPageRedactionRow`, `readPageRedactionRows`, `listTimelineDedupRows`, `listVersionBodiesForRedaction`, `countPageVersionRows`, `setRetainedVersionBody`, `listChunkTextsForRedaction`, `deleteChunksByIds`, `setRedactedPageFields`, `readRawDataValue`, `setRawDataValue`, `setRedactedRowText`; the queue row after a rewrite is main's `queuePageProjectionJob`. `deletePageViewDigests` (capability `facts`) is served with no rows.
- **Postgres tables:** `secret_store`, `secret_store_occurrence`; SQL in `src/core/engine-sql/secret-store.ts`, `secret-spans-rows.ts`.
- **Parity cases:** `test/engine-parity/repair-secret-spans.test.ts`.
- **Known gaps:** none for the scan, the apply (inline and segmented) and the restore. On a Rust brain `clearCodeEdgesLeavingChunks` has no `edges_backfilled_at` marker to clear (the store keeps none), and a raw data row is named by its position, not a serial id.

### timeline_queries

Timeline reads by date and event projections.

- **Files:** `gbrain-store/src/timeline_queries.rs`, `gbrain-napi/src/families/timeline_queries.rs`, `store-members/timeline-queries.ts`.
- **Tag:** `u` (`TIMELINE_QUERIES`). Cascade on page delete: no.
- **Members (7), capability:** `timeline` (7).
- **Store and binding:** `getTimelineForDate` (`get_timeline_for_date`), `getSince` (`get_since`), `getOnThisDay` (`get_on_this_day`), `getLastSeen` (`get_last_seen`), `upsertEventProjection` (`upsert_event_projection`), `removeTimelineRows` (`remove_timeline_rows`), `updateTimelineDetails` (`update_timeline_details`).
- **Postgres tables:** `timeline_entries`, `pages.effective_date`.
- **Keys:** Reads and writes core timeline rows (`E`, `D`, `G`) only through the timeline entry helpers ("Core hooks"). `u <date> 0x00 <entry id>` date index if a read needs one, kept by a core hook in `timeline.rs`; event projections indexed under `u 0x01 <event_page_id be8> <date>`.
- **Depends on:** The timeline entry helpers and the `remove_event_projections` stub (both built; fill in the stub). Ask core for a date index hook if a scan is too slow.
- **Estimate:** about 1 to 2 days.
- **Notes:** Dates are `YYYY-MM-DD` text. `getOnThisDay` matches month and day across years.
- **Follow-up (timeline-member-dedupe):** `removeTimelineRows` (`engine-sql/timeline.ts`) and `deleteTimelineRows`
  (`engine-sql/timeline-reads.ts`) do the same work: delete a page's timeline rows that still match field for field,
  and report each date. The canonical projection (`persistence/canonical-projections.ts`) calls `removeTimelineRows`
  on the persistence branch and `deleteTimelineRows` on the CLI members branch. Both members stay, each with its own
  Rust store member, until a later change moves every caller to one of them and retires the other on all three
  engines and the Rust store.
- **Parity cases (8, in `timeline.test.ts`):**
  - `timeline.test.ts`: removeTimelineRows deletes only the rows that still match field for field, never an event projection or another page, and reports each deleted date
  - `timeline.test.ts`: removeTimelineRows reads dates as dates and keeps the page order of the deleted rows
  - `timeline.test.ts`: updateTimelineDetails rewrites a detail only while the stored one is still the preimage, on the page own rows
  - `timeline.test.ts`: upsertEventProjection updates in place on the same (event, date) and refuses missing pages
  - `timeline.test.ts`: getTimelineForDate returns one day or its ISO week, ordered by event effective_date
  - `timeline.test.ts`: getSince filters by lower-bound date and event kind
  - `timeline.test.ts`: getOnThisDay returns the same month-day from prior years only
  - `timeline.test.ts`: getLastSeen finds an entity via its own page or an event who, bounded by asof

### keyword

Keyword search members of the keyword_search capability (all served), and title trigrams.

- **Files:** `gbrain-store/src/keyword.rs`, `gbrain-napi/src/families/keyword.rs`, `store-members/keyword.ts`.
- **Tag:** `R` (`TRIGRAM`). Cascade on page delete: no.
- **Members (6), capability:** `keyword_search` (6).
- **Store and binding:** `searchKeyword` (`search_keyword`; the hybrid arm is in `keyword/arm.rs`), `countKeywordPages` (`count_keyword_pages`), `searchKeywordPages` (`search_keyword_pages`), `searchTitles` (`search_titles`), `searchKeywordChunks` (`search_keyword_chunks`), `findByTitleFuzzy` (`find_by_title_fuzzy`).
- **Postgres tables:** `content_chunks.search_vector`, `pages.search_vector`, title trigrams.
- **Keys:** The keyword index of store format 4 under the `R` tag (`TRIGRAM`), one kind byte after the tag: `0x00` the index state, `0x01` chunk and `0x02` page lexeme postings, `0x03` title trigrams, `0x04` slug basenames, `0x05`/`0x06` forward records (`keys.rs`, `rust/docs/store/keyword.md`, "Keys"). Until the state is complete every member scans the live pages and rebuilds vectors from text.
- **Depends on:** The family writes the `ts_rank` and `ts_rank_cd` compatibility rankers (design D5) in `keyword/rank.rs` over vectors built from the row text; the core `T` postings are not used; the facts keyword arm reuses the rankers. Ports `pg_trgm` similarity for `findByTitleFuzzy` and `searchTitles`; the takes family reuses it.
- **Estimate:** about 5 days: 3 for the members, about 2 for the `ts_rank` ranker (a judgment; the ranker came to this family after the first estimate).
- **Notes:** Every keyword case must match PGLite exactly, order and score within `1e-6`; `search.tsv` is empty.
- **Parity cases (4, in `links.test.ts`, `search.test.ts`):**
  - `links.test.ts`: findByTitleFuzzy returns the best title match above the threshold, honoring prefix and source
  - `search.test.ts`: countKeywordPages and searchKeywordPages page through strict keyword matches
  - `search.test.ts`: searchKeywordChunks returns chunk-grain rows where searchKeyword returns one row per page
  - `search.test.ts`: searchTitles finds pages by title, falls back to relaxed OR, and honors filters

### chunk_queries

Chunk reads of the chunks capability (served; the capability stays unreported while other chunk members refuse).

- **Files:** `gbrain-store/src/chunk_queries.rs`, `gbrain-napi/src/families/chunk_queries.rs`, `store-members/chunk-queries.ts`.
- **Tag:** `c` (`CHUNK_QUERIES`). Cascade on page delete: no.
- **Members (4), capability:** `chunks` (4).
- **Store and binding:** `getChunkPage` (`get_chunk_page`), `getChunkWindows` (`get_chunk_windows`), `countChunklessPagesWithContent` (`count_chunkless_pages_with_content`), `listChunklessPagesWithContent` (`list_chunkless_pages_with_content`).
- **Postgres tables:** `content_chunks`, `pages`.
- **Keys:** Reads core chunk rows (`K`) through `chunks.rs` helpers; `c` only if a read needs an index.
- **Depends on:** Core chunk helpers. Two cases also read embeddings (core, built).
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
- **Store and binding:** `searchVector` (`search_vector`), `searchTakesVector` (`search_takes_vector`). `searchTakesVector` is built in the takes files: `gbrain-store/src/takes/vector_search.rs`, `gbrain-napi/src/families/takes.rs` and `store-members/takes.ts`.
- **Postgres tables:** Chunk and take vectors (`embedding` columns), the vector index.
- **Keys:** `X` (core sub-layout).
- **Depends on:** Nothing. The store serves both members with an exact scan over the stored vectors (`rust/docs/store/vectors.md`).
- **Estimate:** built.
- **Notes:** Cosine score is `1 - distance`, within `1e-6` of pgvector. A query value outside the float4 range refuses with `invalid_argument`. A safe reader (`requireSafeChunks` or `excludePrivate`) sees a page only when its `chunker_version` is 4 or more.
- **Store field:** `Store` holds one `pub(crate) vectors: crate::vectors::VectorCache`, made with `Default` in
  `open_kv`, so a search passes `Some(&self.vectors)` to `load_index` and reuses the decoded vectors across reads.
  Core defines `VectorCache` as an empty struct at the end of `vectors.rs`. Git merges it into the family's file with
  no conflict and keeps both definitions, so the build fails (`E0428`): after the merge, delete core's empty struct
  and keep the family's. The cache must be fed from committed snapshots only, so a store bound to an open transaction
  gets its own cache and never shares the brain's: the transactions family's `bound_to` adds
  `vectors: vectors::VectorCache::default()` (without it the build fails with `E0063`).
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
- **Depends on:** vectors (built).
- **Estimate:** built (`rust/docs/store/embeddings.md`).
- **Notes:** Reports the active embedding column the way the registry does. A brain whose config names a vector column other than `embedding`, and a chunk that carries an image vector, still refuse with `engine_capability_missing`.
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
  - `pages.test.ts`: lockPageKeys refuses a missing source and a recreated one, and holds a key whose source matches
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

### New families from the CLI contract map

The CLI contract map (`docs/research/rust-cli-contract-map.md` on the `rust-cli-contract-map` branch) counts the CLI
and MCP sites that still reach the database through raw SQL. Four of its groups have no family yet. The four
sections below design them: persistence (map group 1, with groups 9 and 12), jobs (map group 4), trust (map group
3) and catalog probes (map groups 6 and 34). The map counts sites and calls; this section merges sites that read
the same rows into one member, so the member counts here are smaller than the site counts.

These four sections are design only. No file, tag, constant or list entry below exists yet. The tags are proposed:
core adds them to the reserved block in `keys.rs` and to the reserved tag table above in one reviewed change, and
until then no family writes under them. The free lowercase bytes today are `z` (`g` is the code traversal cache) (`d`, `m` and `t` are now reserved above, `a` is telemetry, `f` is the dream synthesis completion archive, `x` is access_members and `h` is the derived generation ledger). `secret_store` takes the digit `3`: every letter is taken or reserved, and tag `2` is free (the `embedding_holds` family was dropped at the main join).

| Family | Proposed tag | Proposed constant | Cascade on page delete | Owner |
|---|---|---|---|---|
| persistence (core) | `d` | `PERSISTENCE` | no | core |
| jobs (core) | `m` | `JOBS` | no | core |
| trust | `t` | `TRUST` | yes | group 4 (memory records), next to facts and contradictions |
| catalog probes (core) | none: no records | none | no | core |

Transaction rules shared by all four:

- **A typed operation in place of a lock.** Every claim, lease, cap check and fence in these sections is one store
  member that reads and writes in one store write transaction (D20, "Concurrency without PGLite-style locks" in
  `RUST_ENGINE.md`). TypeScript never holds a store lock across two calls. A member that PGLite runs as
  `SELECT ... FOR UPDATE` followed by an `UPDATE` is one member here, not two.
- **Same results, not same mechanism.** A store write transaction is serializable: today the store runs one write
  transaction at a time by default. With concurrent writes on (`GBRAIN_RUST_CONCURRENT_WRITES=1`), the store
  detects the conflict and runs the losing transaction again; it never commits both
  (`tests/jobs.rs` and `test/engine-parity/jobs.test.ts` race claimers against each other). So "read the first eligible row in PGLite's order, then change it" inside one
  write gives the result `FOR UPDATE SKIP LOCKED` gives: no row is claimed twice, and a second caller gets the next
  eligible row or none.
- **Inside a BrainEngine transaction.** A member called with a tx handle joins the open store transaction (the core
  transactions family, `w`). Members that PGLite runs only inside a transaction (map group 9) refuse with
  `engine_capability_missing` until the transactions family lands, as the other families do.
- **Refusal before the capability.** A family reports its capability only when every member under it is served.
  Until then each served member answers and each other member refuses, so a CLI path either gets PGLite's answer or a
  typed refusal, never a guess.

### persistence (core)

The write journal, its effects and recoveries, the operation checkpoints, the page projection queue and the sync
holds: the tables the TypeScript persistence coordinator reads and writes.

- **Files:** `gbrain-store/src/persistence.rs` (new), `gbrain-store/src/journal.rs` (exists),
  `gbrain-napi/src/families/persistence.rs`, `store-members/persistence.ts`.
- **Tag:** `d` (`PERSISTENCE`, proposed), next to the existing journal tags `J` / `j` (requests) and `W` (local
  writers). Cascade on page delete: no. The projection queue entry for a deleted page goes through the projection
  hook below, not the cascade list.
- **Members (about 60 after merging 180 sites), capability:** `persistence_journal`.
- **Store and binding:** grouped by the table they read. Every name is the BrainEngine member; the Rust method is the
  same name in snake_case (for example `claimNextWrite` and `claim_next_write`).
  - Brain and writers: `readPersistenceBrainId` (over the existing `get_brain_identity`), `readWriterVersionCutoff`,
    `readPersistenceBrainLock` (PGLite's `FOR SHARE` read becomes a plain read inside the caller's write),
    `getLocalWriter` (over the existing `read_local_writer`), `insertLocalWriterRow` (over `register_local_writer`),
    `readLocalWriterRow`, `readManagedModeRows`, `readLedgerSource`.
  - Requests (`persistence_requests`): `admitWrite` (over the existing `admit_write`), `getWriteRequest` (by id, by
    principal, or a list by principal: one member with a key option, in place of three readers),
    `getWriteReceipt`, `hasClaimableWrite`, `claimNextWrite`, `renewWriteClaim`, `completeWrite` (over
    `finish_write`), `releaseAbandonedWriteClaims`, `listWriteRequests` (one filtered list in place of the
    stalled, lost-caller, host-owned, expired-deferred, suppressed, drifted-since and carrying readers),
    `countWriteRequests` (the matching counts), `readMaxRequestSequence`, `recentWriterVersions`,
    `listCompactibleReceipts`, `compactReceipts`.
  - Effects (`persistence_effects`): `queuePublicationEffects`, `claimPersistenceEffect`, `completeEffect`,
    `releaseAbandonedEffectClaims`, `selectEffectRecoveries`, `listEffects` (one filtered list in place of the
    parked, stale-embedding, gated-mirror, true-up, withdrawal-mirror and rearmable readers), `countEffects`,
    `batchLinkEffectStates`, `trueUpRequestReceipts`.
  - Capacity (`persistence_counters`): `reserveCapacity(key, delta, cap)` (the compare-and-add D20 names, in place of
    `reserveWriteBudget`), `readPersistenceCounters` (one read for the counter, capacity and compaction readers),
    `readJournalLimits`.
  - Worktrees and bindings (`persistence_worktrees`, `persistence_source_bindings`, `persistence_host_bindings`,
    `persistence_worktree_refreshes`, `persistence_topology_changes`, `persistence_graduation`):
    `getWorktreeBinding`, `listCoordinationRoots`, `readCheckoutRoot`, `resolveSyncPersistenceMode`,
    `readSourceMovement`, `listWorktreeRefreshes`, `getTopologyChange` (by request), `listTopologyRecoveries`,
    `getGraduationRun`.
  - Consumers (`persistence_consumers`): `registerConsumer`, `heartbeatConsumer`, `claimSweep`,
    `countLivePersistenceConsumers`.
  - Operation checkpoints (`op_checkpoints`, `op_checkpoint_paths`): `readOpCheckpoint`, `listOpCheckpoints`,
    `writeOpCheckpoint`, `deleteOpCheckpoint`, all keyed by `(op, fingerprint)`. These four replace the separate
    readers for the fence census, sync holds, git holds, managed sync orphans and failures, tombstones, purge
    parks, credential reseal, soak counters, the housekeeping turn, `readSyncHoldHeldAt` and the trust backfill
    checkpoints: each of those is a checkpoint `op` with its own payload, and the TypeScript caller keeps decoding
    the payload.
  - Projection queue (`page_projection_jobs`): `selectProjectionJobWindow`, `clearProjectionJob`,
    `readProjectionBacklog` (one read for the backlog, drain preview, pending rebuilds, job reason and live-job
    readers).
  - Smaller tables: `memory_proposals` (`listMemoryProposals`, `expireMemoryProposals`,
    `deleteSettledMemoryProposals`, `summarizeMemoryProposals`), `page_purges` (`listPagePurges`),
    `sync_notifier_sources` and `sync_notifier_leases` (`readNotifierFreshness`), `sync_wanted_markers`
    (`readSyncFirstDue`), `persistence_writer_protocols` (`readWriterProtocols`).
  - Inside a transaction (map group 9): `declarePersistenceProtocol` and `declareDurablePersistence` (both become
    a store-side check of the writer protocol, with no session setting), `lockWriteRequest` and
    `lockSourceForAdmission` (become part of the admitting or claiming member's own write), `pageAdmissionSource`
    (a fixed answer: the Rust store has no row policies), `setSynchronousCommit`, `setPlannerSettingLocal` and
    `setStatementTimeoutLocal` (no-ops: the store commits durably and every call carries a deadline).
  - Shared skills (map group 12): the shared skills catalog and retention reads go through `listWriteRequests` and
    `getWriteReceipt`; the shared skill tables (`shared_skill_*`) are their own later family, not this one.
- **Postgres tables:** `persistence_brain`, `persistence_local_writers`, `persistence_requests`,
  `persistence_effects`, `persistence_counters`, `persistence_consumers`, `persistence_worktrees`,
  `persistence_source_bindings`, `persistence_host_bindings`, `persistence_worktree_refreshes`,
  `persistence_topology_changes`, `persistence_writer_protocols`, the graduation table, `op_checkpoints`,
  `op_checkpoint_paths`, `page_projection_jobs`, `memory_proposals`, `page_purges`, `sync_notifier_sources`,
  `sync_notifier_leases`, `sync_wanted_markers`.
- **Keys:** requests stay under `J` / `j` and local writers under `W` (the existing `journal.rs` layout; brain
  identity is in `M`). New records go under `d` with a sub-table byte:
  - `d 0x01 <request id BE8> <effect kind> 0x00 <effect id BE8>`: an effect; `d 0x02 <kind> 0x00 <state> 0x00
    <effect id BE8>`: the claim index.
  - `d 0x03 <counter key>`: a capacity counter.
  - `d 0x04 <worktree id>`, `d 0x05 <source id>`, `d 0x06 <host id>`: worktrees and bindings; `d 0x07 ...`:
    refreshes, topology changes and graduation runs.
  - `d 0x08 <consumer id>`: a consumer.
  - `d 0x09 <op> 0x00 <fingerprint>`: a checkpoint; `d 0x0a <op> 0x00 <fingerprint> 0x00 <path>`: a checkpoint path
    (deleted with its checkpoint in the same write, as the Postgres foreign key cascades).
  - `d 0x0b <source id> 0x00 <slug>`: a projection job; `d 0x0c <updated_at BE8> <source id> 0x00 <slug>`: the
    window index.
  - `d 0x0d ...` to `d 0x10`: proposals, purges, notifier rows and wanted markers.
- **Transaction rules:**
  - `claimNextWrite` reads the claimable requests in `CLAIM_ORDER` (`src/core/persistence/journal.ts`) with
    `claimableWriteSql`'s rules (foreground priority first when `foreground_priority` is on, then `sequence`),
    takes the first, and writes the claim with a new fencing token and the lease expiry, in one write.
    `renewWriteClaim` and `completeWrite` check the token in the same write and refuse a stale one. An expired lease
    is claimable again.
  - `claimPersistenceEffect` does the same for effects with a fenced `execution_token`; an expired or dead-owner
    claim is reclaimed.
  - `reserveCapacity` reads the counter, refuses when `delta` would pass `cap`, and writes the new value in one
    write. It replaces both the counter row lock and `reserveWriteBudget`.
  - `admitWrite` checks the idempotency key, the source, the capacity and the writer, then writes the request and its
    index, in one write. A retry with the same key returns the same request (`idempotency_conflict` when the payload
    differs), as the existing `admit_write` does.
- **Projection hook (core):** PGLite fills `page_projection_jobs` from the `gbrain_queue_page_projection` trigger
  on every page insert, update and delete. On Rust, core calls a projection hook from `write_page` and `remove_page`,
  like `page_index::reindex_page`. The hook deletes the job when the page is deleted, soft deleted, moved to another
  slug or source, or when `text_projection_revision` equals `knowledge_revision`, and writes the job when the page
  is new or its `knowledge_revision` changed. The persistence family fills in the body.
- **Depends on:** the transactions family (`w`) for map group 9; the projection hook (core); `journal.rs` (built).
- **Estimate:** about 15 days for the whole family. The first slice below is about 4 days.
- **Notes:** see "Persistence: option (a) or option (b)" below. On a brain with no managed worktree, the worktree,
  binding, topology and graduation reads answer "none" from an empty table, which is PGLite's answer on the same
  brain; they need records only when managed worktrees are served on Rust.
- **Parity cases:** none exist yet. The family adds `test/engine-parity/persistence.test.ts`. Its first cases: brain
  id is stable across reopen; a local writer reads back as registered; `admitWrite` with the same key returns the
  same request; `claimNextWrite` returns foreground requests first, then by sequence; two claims never return the
  same request; a stale fencing token cannot complete a write; an expired lease is claimable again;
  `reserveCapacity` refuses past the cap and writes nothing; a checkpoint and its paths are deleted together; a
  page write queues a projection job and a matching revision clears it. The existing
  `test/persistence-claim-lease.test.ts` and `test/persistence-capacity.test.ts` cases are the source for the
  expected answers.

#### Persistence: option (a) or option (b)

Two ways to serve the persistence paths on Rust:

- **(a) A `persistence` family of typed members**, as above. The TypeScript persistence coordinator stays as it is
  and calls the members; Rust stores the rows.
- **(b) A Rust journal that the write members call directly.** `putPage` and the other write members admit, apply
  and commit inside the store through `journal.rs` (`submit_page_mutation` already does this for one page), and the
  coordinator does not run on a Rust brain.

| Question | (a) typed members | (b) Rust journal |
|---|---|---|
| Matches the design | yes: "No Rust rewrite of the persistence coordinator" and D20's typed operations | no: it moves the coordinator into Rust |
| File publication (managed and git sources) | kept: the coordinator publishes files after the commit | lost: `submit_page_mutation` publishes no files |
| Post-commit effects (embedding, the links effect, mirrors) and holds | kept | lost, or rebuilt in Rust |
| Leases, claims, recovery records, worktree fences, refresh deferral | kept | not in `journal.rs` |
| Same answers as PGLite on the same brain | yes | no: parity diverges on every write that has an effect |
| Read sites (doctor, sync status, holds) | served by the members | still need a member or a fixed answer each, so (b) saves little |
| Work already done | `journal.rs` becomes the storage for requests and writers | `journal.rs` is the whole path |

Recommendation: **(a)**. It is the shape of every other family, the design already requires it, and it keeps the
answers equal to PGLite's. `journal.rs` is not wasted: its `J` / `j` and `W` records and its `admit_write`,
`finish_write`, `get_brain_identity` and local writer functions become the storage under the request and writer
members. `submit_page_mutation` can stay as a store-level path for store tests and the simulation; core decides.

Effect on Dec 1: none on the family plan above. The persistence paths are CLI work, outside the 54 days of family
work, so they do not move Dec 1 unless Dec 1 includes CLI writes on a Rust brain. Two notes for that decision:

- The quickest win is `readPersistenceBrainId` over the existing `get_brain_identity`. The contract map names it
  as the first refusal for 43 commands; with it served they reach their next member instead of refusing at the
  start.
- If Dec 1 includes CLI `put_page` and import on Rust, build this first slice first (about 4 days, core): brain id,
  local writers, `admitWrite` and `getWriteReceipt`, `claimNextWrite` and `completeWrite`, `readJournalLimits`,
  `readManagedModeRows`, and the hold reads (empty on a brain with no holds). The CLI also needs the `rust` case in
  `constructEngine`, which is on the `rust-engine/pr8-construct` branch, not on the base the contract map used.

### jobs (core)

The Minion job queue, cycle locks, spend and rate leases, and wake subscriptions.

- **Files:** `gbrain-store/src/jobs.rs`, `gbrain-napi/src/families/jobs.rs`, `store-members/jobs.ts`.
- **Tag:** `m` (`JOBS`, proposed). Cascade on page delete: no.
- **Members (about 40 after merging 60 sites, plus the queue members the sites do not reach), capability:**
  `minion_queue`.
- **Store and binding:** the Rust method is the member name in snake_case.
  - Admission and claim: `admitJob(spec)` (the idempotency key, coalescing, quota and caps, then the insert, in one
    write; in place of `insertOrCoalesceJob` and the three advisory locks), `submitChildJob`, `claimNextJob(queue,
    worker, lease)`, `renewJobLease`, `completeJob` (in place of `completeJobRow`; also rolls up the parent, the
    `rollUpChild` step), `failJob`, `reclaimStalledJobs`, `handleTimeouts`, `requeueDelayedJobs`, `pauseJob`,
    `resumeJob`, `retryJob` (in place of `getFailedJobForRetry`), `cancelJobs`, `removeTerminalJob`.
  - Reads: `getJob`, `getJobParentId`, `listJobs` (one filtered, paged list in place of `listJobsRecent`,
    `listJobPage`, `listActiveJobsOwned` and `listUnreviewedJobs`), `listDescendantJobIds` (in place of the recursive
    query), `listJobTreeOwners`, `listJobSubmitters`, `countWaitingAhead`, `countJobs` (one grouped count in place of
    the status, name, daily, source, cycle, legacy authority, stalled, timeout, dead absorb and dream, facts drain
    backlog and wedge signal counts), `oldestWaitingJob`, `lastCompletedJobAt`, `hasOverdueWatchdogSuspect`,
    `countTtlExpiredWaiting`, `queueFamilyStats`.
  - Messages: `insertInboxMessage`, `readInbox`, `appendSubagentMessage`, `listSubagentMessages`,
    `recordToolExecution`, `listToolExecutions`, `readJobAttachments`.
  - Spend and rate: `reserveBudget` (budget-meter's reservations), `acquireRateLease`, `releaseRateLease`.
  - Cycle locks: `acquireLease(id, ttl)`, `renewLease(token)`, `releaseLease(token)`, `assertLease(token)`,
    `listLeases` (one read in place of `readCycleLocks`, `listActiveCycleLocks` and `listLiveCycleLockIds`, with an
    id and live-only filter). The existing members `acquireCycleLock`, `refreshCycleLock`, `releaseCycleLock`,
    `readCycleLocks`, `deleteCycleLock` and `deleteCycleLockIfStale` keep their names and call these.
  - Wake: `countWakeSubscriptions`, `countPendingWakeForgets`.
- **Postgres tables:** `minion_jobs`, `minion_inbox`, `minion_attachments`, `subagent_messages`,
  `subagent_tool_executions`, `subagent_rate_leases`, `gbrain_cycle_locks`, `mcp_spend_reservations` (read with
  `mcp_spend_log` and `oauth_clients`), `wake_subscriptions`, `wake_forgets`.
- **Keys:**
  - `m 0x01 <job id BE8>`: a job; ids from `M next_job_id`.
  - `m 0x02 <queue> 0x00 <status> 0x00 <priority BE4 with sign flipped> <created_at BE8> <job id BE8>`: the claim
    index, kept in step with every status change in the same write. A forward scan of `m 0x02 <queue> 0x00
    waiting 0x00` gives PGLite's `priority ASC, created_at ASC` order.
  - `m 0x03 <parent id BE8> <child id BE8>`: children; `m 0x04 <queue> 0x00 <idempotency key>`: the key index.
  - `m 0x05 <job id BE8> <message id BE8>`: inbox and subagent messages; `m 0x06 ...`: tool executions and
    attachments.
  - `m 0x07 <lock id>`: a cycle lock; `m 0x08 <key>`: a rate lease or budget reservation.
  - `m 0x09 ...`: wake subscriptions and forgets.
- **How the store replaces `SKIP LOCKED` and the advisory locks:**
  - Claim. PGLite's claim (`src/core/minions/queue.ts`, the `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
    LOCKED LIMIT 1)`) picks the first waiting job in the queue whose name the worker handles, whose
    `submission_authority` is set, with the optional suspect and excluded-name filters, ordered by overdue first
    (when asked), then `priority`, then `created_at`. `claimNextJob` scans the claim index in that order, skips rows
    the filters drop, and in the same write sets `status = 'active'`, `claim_generation + 1`, a new `lock_token`,
    `lock_until` (from the row, then the handler map, then the worker default; row and map values clamped to 5,000
    to 3,600,000 ms), `timeout_at`, `attempts_started + 1`, `started_at` and `updated_at`. Because the write is
    serializable, two workers never get the same job, which is what `SKIP LOCKED` guarantees; a worker that loses a
    conflict retries and takes the next job.
  - Protocol checks. The `minion_queue_protocol` trigger becomes checks inside the same members: an insert needs
    `submission_authority` and `claim_generation = 0`; only a claim advances `claim_generation`; a spend-authorized
    job needs `spend_claim_token = claim_generation`. The member refuses with PGLite's message.
  - Completion. PGLite locks the parent `FOR UPDATE`, then updates the job `WHERE status = 'active' AND lock_token =
    $3`. `completeJob` checks the status and token, writes the job, and rolls up the parent, in one write. A stale
    token completes nothing and returns PGLite's "not active" answer.
  - Stall and timeout sweeps (`handleStalled`, `handleTimeouts`, the dead-letter path). PGLite selects with `SKIP
    LOCKED` and updates. Each sweep is one write that reads the expired rows and changes them, so a job claimed again
    in between is not swept twice.
  - Admission caps. PGLite takes `pg_advisory_xact_lock` on `minion_admission:<queue>:<name>:<key>`,
    `minion_quota:<owner>` and `minion_maxwaiting:<queue>:<name>:<group>` before it counts and inserts. `admitJob`
    counts and inserts in one write, so no second admission can see the count before the insert. The cases in
    `test/minions-admission.test.ts` stay as they are. Budget reservations (`budget-meter.ts`) and rate leases
    (`rate-leases.ts`) follow the same rule: count, check the cap, write, in one member.
  - Delegated admission and retry: one engine transaction. `admitJob` with a delegated client's policy runs the lock,
    a store probe (`capacityCheck: true`, which answers a coalesce or stops where the capacity check runs and writes
    nothing), the policy's capacity check and the store admission in one `transaction`, and `retryJob` runs its job
    read, policy and update in one. The store admits one write transaction at a time, so the policy's count and the
    insert are one admission. `lockOAuthClient` resolves with nothing to do: inside a transaction the store's single
    writer holds what the row lock holds.
  - Cycle locks. PGLite's acquire (`src/core/db-lock.ts`) is an upsert that takes a held row only when
    `ttl_expires_at` has passed and `last_refreshed_at` is null or older than the steal grace, and returns the fence
    `extract(epoch from acquired_at)`. `acquireLease` does the same check and write in one member and returns the same
    fence. Refresh and release match the id, holder pid and acquisition token. The fence check (`fenceLockRow`, `FOR
    KEY SHARE`) becomes `assertLease(token)`, called inside the writing member's own write, so a lease that expired
    refuses the write that depends on it.
  - Queue health reads. Eight members (`readQueueHealthSignals`, `listWaitingByQueue`, `readQueueDivergence`,
    `listQueueWedgeCounts`, `listPrivateQueueHealth`, `readWedgeSignals`, `readOldestWaitingAge`,
    `listStuckActiveJobsByName`) serve the doctor's queue checks, the advisor's stalled jobs and the submit-time
    probe (`src/core/engine-sql/jobs-health.ts`, `rust/docs/store/jobs-health.md`). `parity: test/engine-parity/jobs-health.test.ts`.
  - Spend reservations and the lease-pressure log. Eight members (`readJobSpendTree`, `insertSpendReservation`,
    `expireSpendReservations`, `settleSpendReservation`, `markSpendUsageUnknown`, `insertLeasePressure`,
    `countLeasePressure`, `listRecentLeasePressure`) serve `describeJobs`, the hold's insert, sweep, settle and
    unknown-usage mark, and the lease-pressure audit, `jobs stats` and the `subagent_health` check
    (`src/core/engine-sql/jobs-spend.ts`, `rust/docs/store/jobs-spend.md`). `parity: test/engine-parity/jobs-spend.test.ts`.
  - Spend ledger and client budgets. Ten members (`reserveClientSpend`, `reserveGroupSpend`, `readGroupSpendTotals`,
    `settleSpendWithLog`, `insertSpendLog`, `sumClientSpendSince`, `readClientBudgetUsd`, `insertOauthClient`,
    `updateOauthClientBudget`, `readAgentClientSpend`) serve `reserve`, `reserveGroup`, `readGroupSpend`, `settle`,
    `getClientDailyCapCents`, `getTodaySpendCents`, `recordSpend` and the admin agent spend view
    (`src/core/engine-sql/spend-log.ts`, `rust/docs/store/spend-log.md`). The other `oauth_clients` statements and the
    delegated admission's `effectiveDelegation` read stay raw and the Rust engine refuses them; no `oauth_clients`
    writer call site is switched. `parity: test/engine-parity/spend-log.test.ts`.
  - Subagent transcript and tool ledger. Seventeen members (`listSubagentMessages`, `insertSubagentMessage`, `listSubagentToolExecutions`,
    `recordSubagentToolExecutions`, `startSubagentToolExecution`, `completeSubagentToolExecution`, `failSubagentToolExecution`, the
    write-outcome, oneshot-ledger and byte-sum reads, and the dream cycle's provenance reads) serve `subagent_messages` and
    `subagent_tool_executions` (`src/core/engine-sql/jobs-subagent.ts`, `rust/docs/store/jobs-subagent.md`). `parity: test/engine-parity/jobs-subagent.test.ts`.
  - Wake subscriptions. Nineteen members serve the Wakeshift report-back tables (`wake_subscriptions`, `wake_crons`,
    `wake_cron_runs`, `wake_terms_acceptances`, `wake_forgets`): `openWakeWatch`, `listWakeWatches`, `endWakeWatches`,
    `countWakeWatches`, `readWakeDoctor`, `countPendingWakeForgets`, `listWakeCrons`, `addWakeCron`, `removeWakeCron`,
    `hasWakeCron`, `recordWakeCronRun`, `hasWakeTermsAcceptance`, `recordWakeTermsAcceptance` and, for the drainer,
    `listDueWakeWatches`, `claimWakeWatch`, `settleWakeWatch`, `queueWakeForget`, `claimWakeForgets`,
    `settleWakeForget` (`src/core/engine-sql/jobs-wake.ts`, `rust/docs/store/jobs-wake.md`). The tables have no
    foreign keys, so a deleted job, request or member changes nothing. `wakeshift/forget.ts` and `principalLive` stay on
    `executeRaw`. `parity: test/engine-parity/jobs-wake.test.ts`.
  - Wake. The `minion_job_notify` trigger's `pg_notify` has no store equivalent: a Rust worker uses the short poll,
    which `sync-queue-wake.ts` already chooses when LISTEN is not available.
- **Depends on:** the transactions family (`w`) for the members a caller runs inside its own transaction.
- **Estimate:** about 10 days. `src/core/minions/queue.ts` is about 2,600 lines, and the traced sites cover only
  the happy paths; submit, lock renewal, failure, timeouts and stall reclaim are in scope as well.
- **Notes:** `minion_queue` is reported only when the whole `MinionQueue` is served. The existing cycle lock members
  ship with this family.
- **Parity cases:** none exist yet. The family adds `test/engine-parity/jobs.test.ts`, with cases taken from
  `test/minions-admission.test.ts`, `test/minions-submission-authority.test.ts`,
  `test/minions-lease-full-retry.test.ts`, `test/db-lock-fencing.test.ts` and `test/cycle-lock-steal.serial.test.ts`:
  claim order (overdue, priority, created_at); two concurrent claims get different jobs; a stale lock token cannot
  complete; a completed child rolls up its parent; admission caps hold under concurrent submits; an idempotent
  submit coalesces; a stale cycle lock is taken only after the grace; a released or expired lease fails
  `assertLease`.

### trust

Trust tiers, the write gate, trust review, fact withdrawal and the belief ledger.

- **Files:** `gbrain-store/src/trust.rs`, `gbrain-napi/src/families/trust.rs`, `store-members/trust.ts`.
- **Tag:** `t` (`TRUST`, proposed). Cascade on page delete: yes (per-page tier and gate receipt records).
- **Members (about 35 after merging 64 sites), capability:** `trust` (proposed; core adds it to
  `ENGINE_CAPABILITIES`) for the policy, tier, gate, withdrawal and review members, and the existing
  `belief_ledger` for the belief members, so the belief part can ship later without holding the rest.
- **Store and binding:** the Rust method is the member name in snake_case.
  - Policy and gate: `readTrustGeneration` (the other half of the hot-memory cache identity; the store keeps no
    `trust_policy_state` and answers its commit sequence, which moves on every commit, a superset of the SQL
    generation's trigger events, so a Rust cache rebuilds after any write), `readWriteGateReceipt`, `clearStalePageGateReceipts`,
    `listWriteGateHolds`, `listTrustAllowRules`, `insertTrustProposal`, `listTrustProposals`.
  - Page tiers: `readPageTrustRows` (one read for the four sites that read page tiers), `readTrustTierCounts`,
    `lowerPageTrustTiers`, `relowerClaimedRows`, `readTaintInputPages`, `findPageVersionByTier`, `listFlaggedPages`,
    `listTrustClaimCandidates`, `listClaimedSourceTiers`, `countLegacyUnknownBySource`, `scanProvenanceDrift`,
    `guardFenceFactRows`.
  - Withdrawal: `insertFactWithdrawal`, `isFactWithdrawn` (one member for the current and v1 forms), `isFactPurged`,
    `planFactWithdrawal`, `listWithdrawals` (one filtered list for the discovery, dates and export readers),
    `hasSourcePurges`, `readFactCacheWatermark` (the hot-memory cache watermark: the source's withdrawal count, the
    newest withdrawal in UTC with microseconds, and the folder access digest, which the store reports as the digest of
    two empty tables because it keeps no folder rules; the newest withdrawal is UTC ISO text, not `::text`, which
    followed the session time zone; the text is a cache key only, so no answer changed).
  - Review: `insertWithdrawReviewItem`, `countPurgeReviewQueueRefs`.
  - Beliefs (`belief_ledger`): `readCoverageIntervals`, `listCoveredSources`, `readOpenLifetimes`,
    `mintBeliefLifetime`, `resolveBeliefLifetimes`, `readBeliefRedactions`, `readBeliefState`.
- **Postgres tables:** `trust_policy_state`, `trust_allow_rules`, `trust_proposals`, `write_gate_receipts`,
  `write_gate_holds`, `fact_withdrawals`, `fact_purges`, `take_purges`, `decide_review_queue`, `belief_events`,
  `belief_page_lifetimes`, `belief_commit_marks`, `belief_retier_manifest`, `belief_redactions`, and the
  `trust_tier` and write provenance columns of `pages`.
- **Keys:**
  - `t 0x01`: the policy state (one record); `t 0x02 <rule id BE8>`: allow rules; `t 0x03 <proposal id BE8>`:
    proposals.
  - `t 0x04 <page id BE8>`: a page's tier and write provenance; `t 0x05 <tier> 0x00 <page id BE8>`: the tier index.
  - `t 0x06 <page id BE8>`: a gate receipt; `t 0x07 <hold id BE8>`: a gate hold.
  - `t 0x08 <fact id BE8>`: a withdrawal; `t 0x09 ...`: fact and take purges; `t 0x0a ...`: review queue rows.
  - `t 0x10` to `t 0x14`: belief events, lifetimes, commit marks, retier manifest and redactions.
  - Built so far (rust/docs/store/trust.md is the record of the bytes): `t 0x01` fact withdrawals, `t 0x02` to
    `t 0x05` write gate receipts and holds, `t 0x06` to `t 0x08` trust proposals and their pending and by-row indexes.
    The proposed bytes above were not kept. A page's tier and write origin have no key: they are fields of the page
    record and of each version record, and no read looks a page up by tier, so there is no tier index. A later
    record kind takes `t 0x09`.
- **Transaction rules:** a tier change and its tier index change in one write. `lowerPageTrustTiers` and
  `relowerClaimedRows` read the current tier and write the lower one in the same write, so a concurrent raise is not
  lost. `insertFactWithdrawal` checks for an existing withdrawal and writes in one write (PGLite's unique key gives
  `constraint_violation`). Belief lifetimes are minted and resolved in the caller's transaction.
- **Page columns:** the Rust page record stores the stamped `trust_tier` and `write_origin` (built). `getPage` maps
  no trust column on any engine, so `trust::page_columns` adds none; `readPageTrustRows` and `createVersion` return
  them. Timeline entries still read the fixed `TIMELINE_DEFAULTS` tier in `store-codec.ts`.
- **Overlaps to settle before the first commit:** `fact_withdrawals` is on the facts family's (`F`) source-delete
  list; trust owns the table, and facts calls `trust::remove_source_rows` or drops the entry. The access tables
  (`access_rules`, `access_members`, `access_tokens`, `access_policy_state`, `oauth_clients`, `oauth_grant_audit`,
  `guest_sources`) belong to the `access` family in the contract map, not to trust.
  No access rules on Rust: `isFolderRestricted` answers false until an access-rule store exists, and the access-rule write refuses (`raw_sql`).
- **Depends on:** the facts family (fact ids and the withdrawal overlap); the page-columns hook (built).
- **Owner:** group 4 (memory records), after facts and contradictions.
- **Estimate:** about 8 days, plus about 4 for the belief ledger.
- **Notes:** the `tableExists` probes on `write_gate_holds` and `write_gate_receipts` become a check of the `trust`
  capability (see catalog probes).
- **Parity cases:** none exist yet. The family adds `test/engine-parity/trust.test.ts`, with cases taken from
  `test/trust-tier.test.ts`, `test/trust-generation.test.ts`, `test/write-gate-store.test.ts`,
  `test/fact-withdrawal-normalized.test.ts` and `test/belief-ledger-lifecycle.test.ts`: `getPage` returns the stored
  tier; lowering never raises; a withdrawn fact reads as withdrawn; a second withdrawal is refused; gate receipts
  clear when stale; a belief lifetime opens and resolves.

#### trust: what is built

The design above is the whole family. This part is built on the trust family's branch (caa958bbd3): trust tiers
and write provenance on content rows, and the trust records.

- **Files:** `gbrain-store/src/trust.rs` and `gbrain-store/src/trust/stamp.rs`, then the napi and TypeScript files of
  each trust member.
- **Tag:** `t` (`TRUST`). Cascade on page delete: not yet. The design above asks for it; the trust family asks core
  for the page-delete hook when it needs one.
- **Build order:** page `trust_tier` and `write_origin` first (returned through the page-columns hook), then
  `fact_withdrawals`, then `write_gate_holds` and `write_gate_receipts`.
- **`trust::stamp`:** `stamp(ctx: &WriteTrust, table: TrustTable, row: StampRow) -> Result<Stamped>` gives the
  tier and origin of one row, with the rules of the PGLite trigger `gbrain_stamp_trust_tier`
  (`src/core/trust/schema.ts`):
  - an insert gets the writer's tier, or `unknown` without one; a supplied tier counts only under backfill;
  - a content change by an owner-tier writer restamps the row; a lower writer sets the minimum of the stored tier
    and its own; a table in the keep list keeps its stored tier, and can still lower it;
  - a raise needs a promotion ceiling that covers it (or backfill from `unknown` to a tier below
    `user_confirmed`), and is otherwise refused with `trust_raise_refused`.
  - `WriteTrust` holds the writer tier, the origin, the promotion ceiling, the backfill flag and the keep list.
    `StampRow` is an insert with the supplied tier, or an update with the old and new tier, whether content changed
    and whether the origin was set. `Stamped` holds the tier and the origin (keep, or set).
  - The guest-source rules of the trigger are not in `stamp`: the store has no `guest_sources` records yet. The
    trigger keys those rules on a `guest_sources` row only, so a store page is stamped as a Postgres page in a source
    with no such row. No such row can exist on Rust: `guests/sources.ts` writes `guest_sources` through
    `executeRaw`, which the engine refuses, so `readGuestSourceRow` finding none is the true answer.
- **Trust hook (persistence owns it):** a typed `setWriteContext` member holds the attribution and trust settings of
  the open store write. The attribution seam (`persistence/context.ts`, the `set_config` calls) calls it on a Rust
  brain in place of `executeRaw`. `write_page` and the facts insert build a `WriteTrust` from it and call
  `trust::stamp`. A page version snapshot copies the page's tier and origin. The takes and timeline families call
  `stamp` when they write their rows. The statements are in
  [the put write path map](../research/rust-put-write-path.md#trust-hook).
- **Write trust context (built, store side):** `gbrain_store::write_trust` holds the six trust settings
  (`gbrain.write_trust_tier`, `gbrain.write_origin`, `gbrain.write_trust_promotion`, `gbrain.write_trust_backfill`,
  `gbrain.write_trust_keep`, `gbrain.write_open_facts`) on the open store, as text, with `set_config` /
  `current_setting(name, true)` semantics. Brain methods: `applyWriteTrust(names, values)`,
  `readWriteTrust(names)` (`(string | null)[]`) and `clearWriteTrust()`. The fence reads (`listFenceFactRows`,
  `listFenceRetireCandidates`) take the writer's tier and the opened ids from it (`Store::fence_context`);
  `trust::stamp` will take `Store::write_trust()` once the writers stamp. See
  [`rust/docs/store/write_trust.md`](../../rust/docs/store/write_trust.md).
- **Hook (built):** the Rust engine's `applyTransactionSettings` and `readTransactionSettings`
  (`store-members/transactions.ts`) route the six names to `applyWriteTrust` / `readWriteTrust` on the
  transaction's store. The attribution and source-scope names (`gbrain.write_sources`, `gbrain.write_request`,
  `gbrain.write_principal_kind`, `gbrain.write_principal_id`, `gbrain.git_protocol`) stay on the transaction in
  TypeScript. The transaction calls `clearWriteTrust()` when it ends, at commit and at rollback; a savepoint rollback
  restores both halves. Any other name refuses with `engine_capability_missing` (`setting=<name>` in the detail).
  Contract: [`rust/docs/store/transactions.md`](../../rust/docs/store/transactions.md), item 12. The trust half of
  `setWriteContext` will call the same store methods.
- **One writer rule:** the store admits one write transaction at a time (`kv.begin_write()` holds the writer), and
  each transaction's handle has its own context, which starts empty. Two transactions opened together run one after
  the other and never read each other's settings; the shared store never reads a transaction's settings. Pinned by
  `test/engine-parity/transaction-settings.test.ts` and the store test
  `a_second_transaction_waits_for_the_writer_and_starts_with_an_empty_context`.
- **Depends on:** nothing more for the settings of an open store write. A write outside a transaction stamps with no
  writer, which is `unknown`, as on PGLite.
- **Trust reads (built):** the read members that a production caller sends `minTrust` or `suppressFlagged` apply
  them on Rust through `TrustPolicy` (`rust/crates/gbrain-store/src/trust/eligibility.rs`), the twin of the
  trust floor and suppression clauses of `pageEligibleSql`. A name that is no tier refuses with `invalid_argument`.
  - Lifted, each with a caller: the page reads of `page-ops.ts` (which also take `excludePrivate`),
    `aliasCanonicalRefs`, `getSalienceScores`, `countWorldFacts`, `listFactsForRelevance`, `countUncomparableFacts`,
    the five keyword members, the link and graph reads (`getBacklinkCounts`, `getAdjacencyBoosts`,
    `supersedingPageSlugs`, `relationalFanout`, `relationalChainHop`, `listLivePageSummaries`,
    `listPagesTitledIn`; callers in hybrid search, relational recall, relational chains and the entity anchor) and
    `resolveFrozenHits` (the `assemble_evidence` delivery path). `findActiveSingleFact` and the other `SELECT *`
    fact reads return the stored `trust_tier` and `write_origin`.
  - No caller, still refused: `currentCodeChunksExist` and the code symbol members (the context read policy sends
    no floor), `findOrphanPages` and `listLinkSources`.
  - Ignored on purpose, as their SQL does: the raw-files, stats, ontology, timeline and chunk-page reads.
  - Built: `listSingleFactMetadata` (refused only under the remote floor) and `listUnpreviewedTrustFacts` read the
    stamped tier and origin (`facts/trust_reads.rs`), and `listSupersessions` and the four fact list reads
    (`listFactsByEntity`, `listFactsSince`, `listFactsKeyset`, `listFactsBySession`, which hot memory reads with the
    caller's eligibility) honour a read eligibility.
  - Built: the trust scan's cursor, claimed-source check and id ceilings are typed members
    (`engine-sql/trust-scan.ts`), served by `trust/scan_state.rs` and `persistence/trust_scan_cursor.rs`, so a scan on a
    Rust brain stops and resumes as on PGLite.
  - Built: the `executeRaw` reads of `trust_tier` in core memory, the eligibility scan, belief history, page history
    (`get_versions`) and valid time are typed members (`engine-sql/trust-tier-reads.ts`). The Rust store serves
    `listCorePageRows`, the pages and facts arms of `listTrustScanRows` and `countUnscannedTrustRows`,
    `listVersionTrustTiers` and `listVersionReasonWriters` (`trust/tier_reads.rs`), and the valid-time page lookup
    `listValidTimeIdentities`, `pickValidTimeEdition`, `readPageVersionEdition`, `readCursorEdition` (`trust/valid_time.rs`)
    and `listAmendmentsNotApplied`
    (`link_queries/link_temporal.rs`). `pageAwaitsRederive`, the purge check of `get_page`, `fetch` and `known_as_of`,
    answers false: the store keeps no `needs_rederive` queue. `beginSnapshotRead` (`engine-sql/transaction-settings.ts`) starts the valid-time,
    fuzzy `get_page` and export transactions as one `REPEATABLE READ` snapshot; the Rust member sets no isolation level, because a
    store transaction holds the one writer from its start, and it enforces `READ ONLY` with Postgres's `25006` refusal. It refuses the takes and timeline
    scan tables; the belief history members read the store's belief ledger (`trust/belief_history.rs`).
    The store prunes versions as PGLite does (`version_prune.rs`), so the pick reads the same marks, and it serves the
    fence fact append's holding-page prune (`pruneHoldingPageVersions`), its occupied-row read (`readFenceRowOccupant`)
    and its page tier restore (`restorePageTrust`, through the same trust stamp as the PGLite `UPDATE`).
    The fact purge's segmented writes are typed members the store serves (`engine-sql/segmented-purge-writes.ts`): the
    flip's staging lock (`lockBodyStagingState`) and stale chunk delete (`deleteUnstagedSegmentChunks`), the delete of the
    derivation rows a rewritten segment may hold (`deleteRewrittenSegmentDerivations`), the version read
    (`listPurgeVersionBodies`, `purge_version_bodies.rs`), and `createVersion` with the purge's `preimage`.
  - `resolveAliases` serves the floor, the flagged-page filter and `excludePrivate` on both the alias page and its
    title shadow (`alias-trust.test.ts`), a caller's reader identity and private-readable grant included; it still
    refuses `excludePrivate` for a caller whose member pages, grants or lineage widen the page policy, and the search
    fan-out reads that refusal as no aliases.
  - Not yet built: the scan cursor, the claim and `max(id)` reads of the eligibility scan, and the admin slug and lifetime reads still go through `executeRaw`. The takes members keep
    their refusal.
  - Pinned by `test/engine-parity/trust-reads.test.ts` and `test/engine-parity/trust-tier-reads.test.ts` on all three engines.

### catalog probes (core)

Doctor checks, migration probes and session settings that ask Postgres about itself. They keep no records, so this
family has no tag. Each probe either gets a fixed answer on Rust or answers from a capability.

- **Files:** `store-members/catalog.ts`, plus the relation catalog `rust/catalog/relations.json` the design plans
  (generated from the PGLite schema; it does not exist yet). The schema-verify answers wait on it.
- **Tag:** none. Cascade on page delete: no.
- **Members (about 20 after merging 35 sites), capability:** none of its own. A probe that reports a fixed answer is
  always served; a probe that depends on a family answers from that family's capability.
- **Rule:** a doctor check about Postgres internals reports "skipped: not applicable on this engine", never a pass
  it did not measure. A probe that feeds a decision (a migration step, a cap) gets the fixed answer below.

Fixed answers on Rust:

| Probe | Sites | Rust answer |
|---|---|---|
| `pg_proc`: `functionSearchPathProblems`, `functionBodyDrift` | doctor | not applicable: the store has no SQL functions |
| `set_config`: `setStatementTimeout`, `setStatementTimeoutLocal`, `setPlannerSettingLocal`, `setSynchronousCommit` | doctor, persistence | no-op: every store call carries a deadline and commits durably |
| `pg_stat_activity`: `probeOldestXactAge` | doctor | null: no long-lived session transactions |
| `pg_index`, planner statistics: `listExpressionIndexesWithoutStats`, `readPlannerStatsState`, the `pg_index` probe in `readJournalLimits` | doctor, persistence | empty or not applicable: no planner |
| `information_schema` and `pg_constraint` in migrations v0_14, v0_16, v0_18, v0_28, v0_31, v0_32_2 | migrations | not reached: a Rust brain upgrades with store format steps (`upgrade_format`) |
| schema verify: `listActualColumns`, `listActualTables`, `listTableColumns`, `readColumnNames`, `readColumnDefault`, `revisionColumnNotNull` | doctor, schema verify | from the relation catalog at the store format version (skipped until the catalog exists) |
| `listRelationNames`, `relationRowEstimate`, `persistenceRequestBytes`, `readRequestIndexStates`, `noteProjectionRebuilds` | doctor, persistence | from the relation catalog, or the owning family's count when it is served |
| `pg_policy`: `pageAdmissionSource` | persistence | none: the store has no row policies |
| `postgres_admin` checks (pooler, roles, server settings) | doctor | skipped: the capability is not reported |

Need a capability check:

| Probe | Sites | Rust answer |
|---|---|---|
| `tableExists` / `to_regclass` on a family table | `core-health`, `edge-validity` (`link_relationships`), `owner-host-stale` (persistence tables), `queue-assets`, `unlinked-facts` (`fact_relink_attempts`), `trust/owner-actions` (write gate tables), `listMissingRelations` | true only when the owning family's capability is reported |
| `probeLinksTable`, `probeLinkSourceConstraint` | link source check | the `links` capability; the constraint answer is "present", since the links family enforces it |
| `hasPgvectorExtension` | doctor, setup | the `vector_search` capability |
| `relationSizeBytes` | doctor | the owning family's size estimate when it reports one, otherwise "not measured" |

Counts that look like probes but read a family's rows go to that family, not here: `countRetirementsBySource` and
`countRestorableRetirements` (facts), `sumExtractionCostByKind` (extraction), `readActiveBiasTags` (eval_capture),
`countMcpRequestLogRows` (search telemetry), `countPendingWakeForgets` (jobs), `sampleVisibleEntityCoverage` and
`countPageTypePairs` (page_ops).

- **Depends on:** nothing for the fixed answers; each capability check depends on its family.
- **Estimate:** about 3 days.
- **Notes:** the capability checks need no new store member: `engine.capabilities` already answers them.
- **Parity cases:** none exist yet. A `test/engine-parity/catalog.test.ts` checks that each fixed answer and each
  capability answer matches the table above on the Rust arm, and that every doctor check that probes Postgres
  internals reports "skipped" on Rust, not a pass.

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

About 54 days of family work are open, against about 9 or 10 working days until Dec 1, so six people working at
once is the plan. Every group below can start now; none waits for another group to finish before its first
member lands. Within a group, build in the order shown.

| Group | Families (in order) | Can start now | Estimate | Waits on |
|---|---|---|---|---|
| 1. Page reads and deletes | page_ops | yes | about 9 days | nothing to start; `deletePages` calls the eval_capture helper, which group 5 builds first (about half a day) |
| 2. Page state | extraction, then aliases | yes | about 10 days | `updateSlug` uses the core rename helper (built) |
| 3. Page bodies | page_body | yes | about 7 to 8 days | `stageSegmentChunks` refuses a chunk that carries a vector; one case needs transactions |
| 4. Memory records | dream, contradictions, facts, ontology, raw_files, stats | yes | about 9 days | three facts cases need takes (group 5); `getHealth` last |
| 5. Takes and salience | eval_capture (first), takes, salience, code_edges | yes | about 7 to 8 days | the `takes` capability needs vectors and embeddings (core, built); code_edges uses the core chunk-delete hook (built) |
| 6. Graph and search reads | timeline_queries, chunk_queries, link_queries, keyword | yes | about 11 days | keyword writes the `ts_rank` compatibility ranker itself; two chunk cases need embeddings (core, built) |

Groups 1 and 2 share the `pages` capability: `pages` is reported only when page_ops, extraction and aliases are all
done. Groups 6 and 2 are the longest (about 11 and 10 days) and set the critical path. `sweepSegments` is served: it reads the version and journal
roots through narrow helpers of those families (rust/docs/store/page_body.md, "The sweep").
`purgeDeletedPages` and `getHealth` are served.

The estimates are judgments from the size of the PGLite code each member reproduces, not measurements.

The four families in "New families from the CLI contract map" (about 40 days in all) are not in the 54 days: they
serve CLI and MCP paths, not the parity suite. None of them moves Dec 1 unless Dec 1 includes CLI writes on a Rust
brain; then the first persistence slice (about 4 days, core) comes first.

### What stays with core and what it waits on

| Core item | Waits on | Needed by |
|---|---|---|
| Page-columns hook (`page_columns.rs`): family values that `getPage` returns (`emotional_weight`, `contextual_retrieval_mode`, segmented-body fields, `trust_tier`) | built | salience, aliases, page_body, trust; extraction listed, likely unused |
| `pages::rename_page` helper | built | aliases (`updateSlug`) |
| Chunk-delete hook (`cascade::remove_chunk_rows`) | built | code_edges; vectors and embeddings listed |
| Timeline entry helpers (`next_entry_id`, `read_entry`, `put_entry`, `remove_entry`, `recompute_latest`) | built | timeline_queries (`upsertEventProjection`, `removeTimelineRows`, `updateTimelineDetails`) |
| Event projection delete (`timeline_queries::remove_event_projections`, called by `remove_page`) | built; the family fills in the body | timeline_queries |
| Page index hook (`page_index::reindex_page`, called by `write_page` and `remove_page`) | built; the family fills in the body | keyword (`R` title trigrams), page_ops |
| Page projection hook (`page_projection::queue_page_projection`, called by `write_page` and `remove_page`) | built; the family fills in the body | persistence (`page_projection_jobs`) |
| Tags `d`, `m`, `t` (`PERSISTENCE`, `JOBS`, `TRUST`) and the empty `persistence.rs`, `jobs.rs` and `trust.rs` | built | persistence, jobs, trust |
| Timeline date index hook in `timeline.rs` | a family asking | timeline_queries |
| vectors (`X`): chunk and take vectors, vector search | built (exact scan) | embeddings, takes capability, page_body chunk vectors, `findCandidateDuplicates` with an embedding |
| embeddings (`B`): stale counts, signatures, embedding state | built | stats `getHealth`, chunk_queries shared cases, takes capability |
| transactions (`w`): the BrainEngine `transaction` callback across napi and `lockPageKeys` | a store transaction that stays open across napi calls | the nine cases that open a transaction; link_temporal (one transaction for the link refresh and the derived-link steps) |
| relations (`v`): the relation API in place of raw SQL | Track 2 of the design (D18) | not in the Dec 1 scope; `executeRaw` and the rest keep refusing |
| Source-delete list (`cascade::remove_source_rows`) | built; nothing calls it yet | facts, aliases, code_edges, link_queries, raw_files, page_body, takes, extraction |
| Source delete itself (a store member in place of the raw SQL) | nothing | serving `sources remove` on the Rust engine |
| `putPage` with `source_path`, and the one-live-page-per-origin refusal (`o` key) | built | page_ops (`resolveSlugsByPaths`) |
| Segment chunks (`chunks.rs`: append, publish, delete by occurrence or generation, `get_chunks` by body generation) | built | page_body (`stageSegmentChunks`, the flip) |
| Nullable page fields (`PageText`, `content_hash: Option`, `chunker_version: Option<i16>`; codec `guardNullBody`) | built | page_body (shell and flip writes) |
| Segmented guard (`putPage` refuses a segmented page with PGLite's CHECK message) | built | page_body; chunk_queries, extraction and page_ops match PGLite for a NULL body (see "Segmented guard") |
| Rename slug list (`cascade::rename_slug_rows`) | built; the aliases family calls it from `updateSlug` | facts (fills in its body), aliases (caller) |
| Search timeline (`pages::search_timeline`: the sanitized timeline `sealChunks` sends, kept per page at the sealed revision; `forget_search_timeline` on every write that sets the title or timeline) | built | keyword (`searchTitles`); page_body calls `forget_search_timeline` |
| Vector cache store field (`Store::vectors`, a `VectorCache` made in `open_kv`) | built | vectors (`load_index`) |
| Wanted links stub (`wanted_links.rs`: sub-tag `W` under `q`, an empty `remove_page_rows` on the page-delete list) | built; the family fills in the body | wanted_links (`listWantedPages`) |
| Chunk-write hook (`chunks::write_chunk` calls `code_edges::put_chunk_index(tx, id, page_id, symbol_name)` for every chunk record it writes) | built on code_edges' branch (`rust-lane-code-edges-index`, in its own commit); arrives with that merge | code_edges (chunk index `H 0x07`, `H 0x08`) |
| Open-time index build (`Store::open` calls `code_edges::build_chunk_index(&*kv)`, which indexes a brain written before the index once; `seed` calls `code_edges::seed_chunk_index(tx)`, which marks a new brain's empty index complete) | built on code_edges' branch (`rust-lane-code-edges-index`, in its own commit); arrives with that merge | code_edges (`H 0x09`) |
| Proposed tags `d`, `m`, `t` and constants `PERSISTENCE`, `JOBS`, `TRUST` in the reserved block of `keys.rs` | a yes on the new families | persistence, jobs, trust |
| Projection hook (`write_page` and `remove_page` keep `page_projection_jobs` as PGLite's `gbrain_queue_page_projection` trigger does) | the persistence family | persistence (projection queue) |
| `trust.rs` on the page-columns list (one line) | the trust family | trust (`trust_tier` and write provenance on `getPage`) |
| `trust` capability in `ENGINE_CAPABILITIES` | the trust family | trust |
