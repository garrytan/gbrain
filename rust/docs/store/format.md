# The brain store: Store formats

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A brain's store format is the number in `FORMAT` and in the format record inside `records.redb`
(`format_version`). A build opens the formats in `FORMAT_VERSIONS` (`addon.formatVersions`), which is
always `1..=FORMAT_VERSION` (`crates/gbrain-store/src/format.rs`). A brain at an older format is
upgraded to `FORMAT_VERSION` when it opens, every step in one write transaction (`upgrade_format` in
`crates/gbrain-store/src/lib.rs`); a brain at a newer format is refused.

## The registry

Every format number is claimed here before any branch writes it. A branch that needs a new format
adds a `reserved` row with the next free number, then turns it into `shipped` in the commit that sets
`FORMAT_VERSION` to it. Two branches cannot both take a number: the second one's row collides with
the first one's in review, and `tests/format_registry.rs` fails CI when `FORMAT_VERSION` is not the
last shipped row, when a number repeats or skips, or when a reserved row is not above it.

| Format | Status | Change | Branch and commit | Upgrade from the previous format |
|---|---|---|---|---|
| 1 | shipped | The first store: the chunk statistics and the unfinished-request counters are one JSON record each. | rust-engine/main, 6e605ac901 ("Rust engine: a brain can be opened, closed and refused a second time") | None: a new brain starts here. |
| 2 | shipped | Each counter is its own record, so concurrent writers do not conflict on one shared record. | concurrency-proto-2, 9ebbbd5570 ("A brain upgrades its counter records to format 2 when it opens"), merged into rust-engine/main by 6ce6c835b7 | On open, in one write transaction: the `chunk_stats` and `journal_counters` records are added to the per-counter records and deleted. |
| 3 | shipped | Projection jobs are a 26-byte binary record instead of JSON, and the commit sequence moves from `\0seq` to `M\0seq`, beside the id counters. | rust-engine/projection-coalesce, f610e8a386 | On open, in one write transaction (`compact_format_2_jobs`): every queued projection job is rewritten in the compact form. The old sequence key is read until the first commit, which moves it in the same transaction. |
| 4 | shipped | The store keeps keyword postings (`R`, `keyword/index.rs`) and every write keeps them in step, so the keyword members read postings instead of scanning every page. A fresh brain starts with a complete, empty index. | rust-engine/keyword-index, the commit "Rust brains upgrade to store format 4 and build their keyword index in the background" (plan: rust-engine/keyword-index-plan, docs/plans/rust-keyword-index.md, D6a) | On open, in one write transaction (`keyword::reset_index` in `upgrade_format`): every `R` record is deleted and an incomplete index state with cursor 0 is written. A background build then fills the postings 256 pages per transaction (`keyword/index_build.rs`) and marks the index complete; until then the members scan. Closing the brain stops the build, and the next open resumes it from the cursor. |
| 5 | shipped | A take record carries its `trust_tier` and `write_origin` (`trust/row_trust.rs`), stamped by every takes writer (`takes::store_take`) as PGLite's `trust_tier_stamp` trigger stamps them, so the fence guard's held-row read (`listHeldRows`) serves takes. | rust-engine/take-tiers-format5, the commit "Rust brains move to store format 5, so an older build cannot rewrite a take without its trust tier"; the take stamp is rust-engine/row-trust-facts-takes (b87e43aeb2), served by rust-engine/take-tiers | On open: nothing is rewritten. A take stored before the tier has no trust field and reads `unknown`, the column default (as the Postgres `trust_tiers` migration's `DEFAULT 'unknown'`). The step only moves the format number, so a build without the field refuses the brain instead of rewriting a take without its tier. The keyword index of a format-4 brain stays as it is (`keyword::reset_index` runs only from format 3 or older). |

## Older builds

An older build never changes a brain at a newer format. `Store::open` refuses it before anything is
written, with `format_unknown` and this message:

```
this brain has store format {v}, newer than the formats this build opens ([…]); nothing was changed
```

`[…]` is the opening build's `FORMAT_VERSIONS`. The TypeScript engine maps the refusal to
`rust_store_unreadable` with `reason: format_unknown` (`src/core/rust-engine/store-errors.ts`), whose
hint is "For a newer format, upgrade gbrain". The brain stays as the newer build left it, so
upgrading gbrain again opens it with nothing lost.

`FORMAT` is read first, so the record file is not opened at all. When `FORMAT` is missing, the format
record decides: this build reads it through a read-only open of `records.redb` (`redb_kv::peek`),
which takes no write lock, runs no recovery and commits nothing. A build at format 2 or older opens
the file for writing instead. It still refuses before any record is written, but closing the file
commits redb's allocator state, so the header bytes of `records.redb` change while every record stays
the same. A record file that needs crash recovery cannot be read read-only; it is opened normally,
recovered and then refused.

To go back to an older build, export the brain and import it there: `gbrain export --dir <dir>` on
the Rust brain, then `gbrain import <dir>` into a brain the older build opens. Export on a Rust brain
writes the same file tree, byte for byte, as PGLite does for the same pages, so the older build reads
the pages back as it would from a PGLite export (`test/rust-export.serial.test.ts`). The export
carries pages, tags, frontmatter, timelines, fact fences with withdrawals struck through, and
segmented bodies; `export --source` and `--restore-only` still refuse on a Rust brain.

An older build at the same format can open a brain that holds keys it does not know, and ignores
them. Known case: the re-derive queue (`needs_rederive`, keys `h 0x0C`, `generations/needs_rederive.rs`)
came in without a format bump. An older build at the same format ignores its marks: it shows the rows a
purge marked, and it corrupts nothing. The next store-format bump must make an older build refuse a
store that holds `h 0x0C` marks. Owner: lane 4, until another lane takes the next format bump.

Pinned by `older_build_tests` in `crates/gbrain-store/src/lib.rs`: a format-3 brain opened by a build
that knows `[1, 2]`, and the next format against every build from format 1 on, with and without
`FORMAT`, compare every file byte for byte before and after the refused open.

There is no downgrade: an older build cannot open a newer brain. `gbrain export` does not run on a
Rust brain yet (it needs `executeRaw`), so the only way back today is to import the original Markdown
into a brain the older build opens, which loses what exists only in the Rust brain. The design keeps
this open until `rust` can be selected (`docs/designs/RUST_ENGINE.md`, "Open before `rust` can be
selected").
