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
`FORMAT_VERSION` to it. An `opt-in` row is a format this build writes only when a switch is on, on top
of the base format `FORMAT_VERSION`: it is not the format a new brain gets, and `FORMAT_VERSIONS`
does not list it (today only the commit log format, `format::LOG_FORMAT_VERSION`). Two branches cannot both take a number: the second one's row collides with
the first one's in review, and `tests/format_registry.rs` fails CI when `FORMAT_VERSION` is not the
last shipped row, when a number repeats or skips, or when a reserved row is not above it.

| Format | Status | Change | Branch and commit | Upgrade from the previous format |
|---|---|---|---|---|
| 1 | shipped | The first store: the chunk statistics and the unfinished-request counters are one JSON record each. | rust-engine/main, 6e605ac901 ("Rust engine: a brain can be opened, closed and refused a second time") | None: a new brain starts here. |
| 2 | shipped | Each counter is its own record, so concurrent writers do not conflict on one shared record. | concurrency-proto-2, 9ebbbd5570 ("A brain upgrades its counter records to format 2 when it opens"), merged into rust-engine/main by 6ce6c835b7 | On open, in one write transaction: the `chunk_stats` and `journal_counters` records are added to the per-counter records and deleted. |
| 3 | shipped | Projection jobs are a 26-byte binary record instead of JSON, and the commit sequence moves from `\0seq` to `M\0seq`, beside the id counters. | rust-engine/projection-coalesce, f610e8a386 | On open, in one write transaction (`compact_format_2_jobs`): every queued projection job is rewritten in the compact form. The old sequence key is read until the first commit, which moves it in the same transaction. |
| 4 | shipped | The store keeps keyword postings (`R`, `keyword/index.rs`) and every write keeps them in step, so the keyword members read postings instead of scanning every page. A fresh brain starts with a complete, empty index. | rust-engine/keyword-index, the commit "Rust brains upgrade to store format 4 and build their keyword index in the background" (plan: rust-engine/keyword-index-plan, docs/plans/rust-keyword-index.md, D6a) | On open, in one write transaction (`keyword::reset_index` in `upgrade_format`): every `R` record is deleted and an incomplete index state with cursor 0 is written. A background build then fills the postings 256 pages per transaction (`keyword/index_build.rs`) and marks the index complete; until then the members scan. Closing the brain stops the build, and the next open resumes it from the cursor. |
| 5 | shipped | A take record carries its `trust_tier` and `write_origin` (`trust/row_trust.rs`), stamped by every takes writer (`takes::store_take`) as PGLite's `trust_tier_stamp` trigger stamps them, so the fence guard's held-row read (`listHeldRows`) serves takes. | rust-engine/take-tiers-format5, the commit "Rust brains move to store format 5, so an older build cannot rewrite a take without its trust tier"; the take stamp is rust-engine/row-trust-facts-takes (b87e43aeb2), served by rust-engine/take-tiers | On open: nothing is rewritten. A take stored before the tier has no trust field and reads `unknown`, the column default (as the Postgres `trust_tiers` migration's `DEFAULT 'unknown'`). The step only moves the format number, so a build without the field refuses the brain instead of rewriting a take without its tier. The keyword index of a format-4 brain stays as it is (`keyword::reset_index` runs only from format 3 or older). |
| 6 | shipped | The records are this build's shapes. The v0.60.766.0 Rust addon (the copy released on master, used by `gbrain engine shadow seed`) also stamped format 5 but kept page purge tombstones at `F 0x0C source \0 hash` (no trailing NUL), derived generations inline at `F 0x0E id`, and oauth clients without `created_at`; this build read those as missing tombstones, an empty `listUnwithdrawnFacts` and a `store_corrupt` error. Format 6 tells the two apart. | rust-engine/shadow-seed-compat, the commit "Shadow stores written by v0.60.766.0's seed are read correctly or refused with a re-seed message" | On open, in one write transaction (`seed/format_5.rs`, run for every brain below 6): an old tombstone key gets its trailing NUL; each `F 0x0E` generation is stored again in the `h` ledger through the seed's own writers and deleted; a client record without `created_at` is stored again as the seed stores a client (epoch `created_at`, column defaults). The result is the records this build's seed writes for the same rows (`seed/v0_60_766_tests.rs`, fixture `tests/fixtures/shadow_seed_v0_60_766`). A record that cannot be carried over (its source is gone, an item action Postgres would refuse, a key in both shapes) refuses the open with `shadow_reseed_required`, the record and the re-seed steps, and nothing changes. A disk or storage failure during the step (`store_io`, `store_corrupt`) is reported with its own code, not as `shadow_reseed_required`, and nothing changes. A brain this build wrote at format 5 has none of the old records, so for it only the number moves. The v0.60.766.0 addon refuses a format-6 brain as newer. |
| 7 | shipped | Take purges and loop mutes have their own key prefixes. Formats 6 and older kept both under `F 0x10` (`facts/take_purges.rs` and `facts/loops/mutes.rs`), so every take purge read scanned the mutes (a mute made the source report a take purge, and `listRecentPurgeRequests` failed with a corrupt-record error). Format 7 keeps take purges at `F 0x10` and puts loop mutes at `F 0x11`. | vorflux/store-key-0x10-split (from rust-engine/shadow-seed-compat, f08aa4ab40), the commit "Rust store: take purges and loop mutes no longer share a key prefix" | On open, in one write transaction (`facts/key_split.rs`, run for every brain below 7): every record under `F 0x10` is classified by its key and its value (a take purge has a trailing NUL and `purged_at_us`; a mute has `id`, `created_at_us` and a kind of `sender` or `thread`) and each mute is moved to `F 0x11`. A record that is neither, whose key and value disagree, or a mute whose new key is taken refuses the open with `shadow_reseed_required`, naming the record key and the re-seed steps, and nothing changes. A disk or storage failure during the step (`store_io`, `store_corrupt`) is reported with its own code, not as `shadow_reseed_required`, and nothing changes. A brain with no mute changes nothing but the number. A build that keeps both kinds at `F 0x10` refuses a format-7 brain as newer. |
| 8 | shipped | The shared-skill catalog's token secret and the access member links have their own key prefixes. Formats 7 and older kept both under `x 0x04` (`shared_skill_members.rs` and `access_member_links.rs`), so every link scan started on the secret's record and skipped it only because its key holds no NUL. No read returned the secret to a link caller, and no link write touched the secret; the two kinds shared a prefix by accident. Format 8 keeps the links at `x 0x04` and puts the token secret at `x 0x0d` (the secret is one record; a brain may hold thousands of links). | vorflux/store-key-x04-split (after vorflux/store-key-0x10-split, format 7), the commit "Rust store: the shared-skill token secret and the member links no longer share a key prefix" | On open, in one write transaction (`access_key_split.rs`, run for every brain below 8): every record under `x 0x04` is classified by its key and its value (the secret's key is exactly `x 0x04` and its value is `{ token_secret }`; a link has a valid system, a NUL and a valid external id, and its value is `{ member_id, created_at_us }`) and the secret is moved to `x 0x0d`. A record that is neither, whose key and value disagree, or a secret whose new key is taken refuses the open with `shadow_reseed_required`, naming the record key and the re-seed steps, and nothing changes. A brain with no secret yet (it mints one on its first read, now at `x 0x0d`) changes nothing but the number. A build that keeps both kinds at `x 0x04` refuses a format-8 brain as newer. |
| 9 | reserved | Held for the keyed lookups (`keyed_index.rs`, two-byte tag `~k`), shipped on that branch; this build does not open it. | rust-engine/keyed-lookups, rust-engine/keyed-lookups-2 | Defined on that branch. |
| 10 | reserved | Held for the vector rank keys, shipped on that branch; this build does not open it. | rust-engine/vector-rank-key | Defined on that branch. |
| 11 | reserved | Held by the trunk for the refresh evidence reads; this build does not open it. | rust-engine/refresh-evidence-reads | Defined on that branch. |
| 12 | reserved | Held for the keyed lookups' updated-order entry, shipped on that branch; this build does not open it. | rust-engine/keyed-lookups-2 | Defined on that branch. |
| 13 | reserved | Held by the trunk for lean keyword writes (its base format); this build does not open it. | rust-engine/lean-keyword-writes | Defined on that branch. |
| 14 | reserved | Held by the trunk for PR 10354; this build does not open it. | the trunk (PR 10354) | Defined on that branch. |
| 15 | reserved | Held by the trunk for the W6 core-edit notices; this build does not open it. | the trunk (W6 core-edit notices) | Defined on that branch. |
| 16 | opt-in | Held for the multi-user commit log. The commit log format: a brain opened with the commit log on (`GBRAIN_RUST_MULTIUSER=1`, [commit-log.md](commit-log.md)) keeps one commit record per transaction under tag `2`, written in the same redb commit as the data. Its records are the base format's shapes (the base format is kept in the format record as `log.base_format`); `FORMAT` and the format record also carry `log.since`, the position the log starts after. A build without the log refuses it as newer, so it never writes a commit the log would miss. Brains opened with the switch off never take this format. | rust-engine/mu-commit-log | On open with the log on, after the base format's own upgrade: `FORMAT` is stamped first, then one exclusive write stamps the format record and the log's meta record, then `FORMAT` is written again; nothing else changes. A later base-format upgrade of a log brain runs inside the log (logged) and keeps format 13. A writable open with the log off refuses; a read-only open reads it. |

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

To go back to an older build, import the original Markdown into a brain that build opens. `gbrain export --dir <dir>`
does not work on a Rust brain on this landing: the CLI export path runs inside `engine.transaction` and calls
`executeRaw` on the transaction (`src/commands/export.ts`), and the Rust BrainEngine serves neither
(`src/core/rust-engine/store-members/transactions.ts` exports no member), so both refuse with
`engine_capability_missing`. Data that exists only in the Rust brain is not recovered by importing the original
Markdown.

An older build at the same format can open a brain that holds keys it does not know, and ignores
them. Known case: the re-derive queue (`needs_rederive`, keys `h 0x0C`, `generations/needs_rederive.rs`)
came in without a format bump. An older build at the same format ignores its marks: it shows the rows a
purge marked, and it corrupts nothing. The next store-format bump must make an older build refuse a
store that holds `h 0x0C` marks. Owner: lane 4, until another lane takes the next format bump.

Second known case: the owner's allow rules (`trust_allow_rules`, keys `t 0x0f` and `t 0x10`, `trust/allow_rules.rs`)
came in at format 8 without a bump. A format-8 build without the family ignores those keys: it applies no allow rule,
so its write gate screens stricter, never looser, and `trust allow list` shows nothing. No scan in this build raises
`store_corrupt` on them (`tests/allow_rules_older_build.rs`: the copy check with and without its manifest, the keyword
index check, the snapshot copy, the read-only open, the keyspace catalog, the shadow follow's digest reads and the
neighbouring trust reads). The next store-format bump must make an older build refuse a store that holds `t 0x0f`
records. Owner: lane 4, until another lane takes the next format bump.

Pinned by `older_build_tests` in `crates/gbrain-store/src/lib.rs`: a format-3 brain opened by a build
that knows `[1, 2]`, and the next format against every build from format 1 on, with and without
`FORMAT`, compare every file byte for byte before and after the refused open.

There is no downgrade: an older build cannot open a newer brain. `gbrain export` does not run on a
Rust brain yet (it needs `executeRaw`), so the only way back today is to import the original Markdown
into a brain the older build opens, which loses what exists only in the Rust brain. The design keeps
this open until `rust` can be selected (`docs/designs/RUST_ENGINE.md`, "Open before `rust` can be
selected").
