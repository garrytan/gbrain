# The brain store: Trust

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The trust family owns the trust tier and write origin of pages, facts, takes and timeline entries, fact
withdrawals, the write gate (holds and receipts), trust review and the belief ledger. Its records start with
`keys::TRUST` (`t`); the key layout of each record is listed in its section below.

## The tier stamp (`trust::stamp`)

`crate::trust::stamp(ctx, table, row)` (crate-only) applies the rules of PGLite's `gbrain_stamp_trust_tier` BEFORE ROW
trigger (src/core/trust/schema.ts) to one row and returns the tier and origin to store. It reads and writes
nothing. The writer of the row calls it; the write context (`WriteTrust`) belongs to the caller, as PGLite's
transaction-local `gbrain.write_trust_tier`, `gbrain.write_origin`, `gbrain.write_trust_promotion`,
`gbrain.write_trust_backfill` and `gbrain.write_trust_keep` settings do.

| Case | PGLite trigger | `stamp` |
| --- | --- | --- |
| Writer above `operator_curated`, no covering promotion | raises `trust_raise_refused:` | `Err` code `trust_raise_refused` |
| INSERT | tier := writer or `unknown`, origin := setting | `Stamped { tier, origin: Set(origin) }` |
| INSERT under backfill | keeps the supplied tier; refuses one above `operator_curated` without promotion | `origin: Keep` |
| UPDATE raising the tier, promotion covers it | keeps the raise, stops | `origin: Keep` |
| UPDATE raising `unknown` under backfill, not to `user_confirmed` | keeps the raise, stops | `origin: Keep` |
| UPDATE raising the tier, no writer | raises `trust_raise_refused:` | `Err` |
| UPDATE raising the tier, a writer | clamps to the old tier, goes on | same |
| UPDATE changing content, table not kept | owner writer stamps its tier; a lower writer takes min(old, writer); a lowering in the same write also counts; origin replaced unless the write set it | same; `origin_set` tells `stamp` the write set it |

`TrustTier::from_setting` reads a setting as PGLite does: empty or absent is no tier, other text that names no
tier is refused with `invalid_argument` ("gbrain trust setting names no tier"; PGLite raises SQLSTATE 22023).
`TrustTable::content_columns` is `TRUST_CONTENT_COLUMNS`; a page's frontmatter counts without
`TRUST_EPHEMERAL_FRONTMATTER_KEYS` (`page_frontmatter_content`). `snapshot_version` is
`gbrain_snapshot_version_trust`: a new version row takes the page's tier and origin, and keeps a supplied one
only under backfill.

The caller decides `content_changed` by comparing the content columns of the old and new row; `stamp` does not
see the row.

Rust guesses and gaps (1x parity):

- The guest-source rules of the trigger are not built: `source_writer_restricted`, `guest_attribution_missing`,
  `guest_page_immutable`, the per-source tier ceiling and the `writer_coordinator_required` refusal of a role
  that cannot read `guest_sources`. The Rust store has no `guest_sources` table, so every source reads as a
  non-guest source.
- A refusal carries the trigger's message without the `trust_raise_refused: ` prefix (the code holds it) and
  without the trigger's DETAIL JSON (`op`, `writer`, `from`, `to`, `backfill`).
- A stored tier that names no tier reads as `unknown` (`TrustTier::stored`, as `storedTrustTier`); PGLite's
  trigger ranks such text 0, below `external_untrusted`. The Rust store never stores such text.
- A non-object frontmatter cannot occur: the Rust page record holds a JSON object.

## Fact withdrawals (`trust::withdrawals`)

The `fact_withdrawals` ledger (src/core/facts/withdrawal-schema.ts). One record per primary key:

`t 0x01 source \0 visibility \0 subject \0 fact_hash` -> `{"withdrawn_at_us": <i64>}`

`fact_hash` is `gbrain_fact_fingerprint(claim)` (`trust::fingerprint::fact_fingerprint`). Rows written before v174
hold `gbrain_fact_fingerprint_v1(claim)`, and every read matches both. Deleting a source removes its rows (the table's
`ON DELETE CASCADE`, through `cascade::remove_source_rows`). A slug rename does not move them; the rename callers call
`moveFactWithdrawalSubject`.

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `hasCoveringFactWithdrawal` | `has_covering_fact_withdrawal`: four point reads (`*` and the subject, the hash and the v1 hash of the claim) | `SELECT 1 … fact_hash IN ($3, v1($5)) AND (subject='*' OR subject=$4)` |
| `insertFactWithdrawal` | `insert_fact_withdrawal`: false when the key exists, which keeps its time | `INSERT … COALESCE($5::timestamptz, now()) ON CONFLICT DO NOTHING RETURNING` |
| `listFactWithdrawalDates` | `list_fact_withdrawal_dates`: per claim, point reads (subject given) or a scan of source and visibility (subject null); the minimum time per row number, sorted by row number | `min(withdrawn_at) … GROUP BY row_num` (no order) |
| `moveFactWithdrawalSubject` | `move_fact_withdrawal_subject`: same slugs do nothing; otherwise each row moves unless the new subject already has the key | `MOVE_WITHDRAWAL_SUBJECT_SQL` |
| `hasFactWithdrawalForSubject` | `has_fact_withdrawal_for_subject`: a scan of the source | `SELECT 1 … subject=$2 LIMIT 1` |
| `listFactWithdrawalKeys` | `list_fact_withdrawal_keys`: sorted by visibility, fact_hash and subject in byte order, then cut to `limit` | `ORDER BY visibility, fact_hash, subject LIMIT $2` |

Not built (they still run through `executeRaw`, which the Rust engine refuses): the reads that also read `fact_purges`
(`isFactWithdrawn`, the ambiguous-fence check, the export snapshot), the reads that join `facts` (the effect-target
request, the single-fact prepare, the repair and review lanes), the meta-hook watermark, and the `facts` insert guard
`gbrain_preserve_fact_withdrawal` (the facts family's insert calls it once the facts family lands on this line).

Rust guesses and gaps (1x parity):

- A visibility other than `private` or `world` refuses with `invalid_argument`; Postgres raises a CHECK violation.
- An unknown source refuses with `source_not_found`; Postgres raises a foreign-key violation.
- `withdrawnAt` must be the ISO form `Date#toISOString` gives (or the store's own microsecond form); any other text
  refuses with `invalid_argument`, where Postgres casts many spellings to `timestamptz`.
- A NUL byte in any text argument refuses with `invalid_argument`, as Postgres refuses one in `text`.
- A negative `limit` refuses with `invalid_argument`; Postgres raises `LIMIT must not be negative`.
- The fingerprint is a copy of the facts family's (facts.rs on the facts-sites line). `pg_lower_char` follows the code
  points probed on PGLite (`LOWER_KEEP`); a Postgres built with a different Unicode table can differ.

## The write gate (`trust::write_gate`)

Receipts record a flag or quarantine verdict on a persisted row (a page, fact, take, timeline entry or hold). Holds
keep a fact or take the gate quarantined until an operator releases or drops it. Keys:

- `t 0x02 id` → receipt record; `t 0x03 target_table\0target_id\0content_hash\0detector_version` → receipt id.
- `t 0x04 id` → hold record; `t 0x05 source\0slug\0fingerprint\0detector_version` → hold id.

Ids come from a per-table counter (`pages::next_id`), so they rise like the Postgres `bigserial`. Neither table has a foreign key in
Postgres, so a source or page delete leaves these rows, and the Rust store does the same (no source cascade).

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `upsertWriteGateReceipt` | `upsert_write_gate_receipt`: a new key gets a new id; a known key refreshes the verdict and `last_seen_at`, keeps the id and keeps the old `request_id` when the new one is null | `INSERT … ON CONFLICT (target_table, target_id, content_hash, detector_version) DO UPDATE` |
| `upsertPageWriteGateReceipt` | `upsert_page_write_gate_receipt`: the same on the live page `(source, slug)`; none when the page is missing or soft-deleted | `INSERT … SELECT 'pages', p.id::text … WHERE p.deleted_at IS NULL` |
| `deleteStalePageWriteGateReceipts` | `delete_stale_page_write_gate_receipts`: removes the page's receipts (live or soft-deleted page) whose hash differs | `DELETE … USING pages p … content_hash IS DISTINCT FROM $3` |
| `listWriteGateReceiptsFor` | `list_write_gate_receipts_for`: sorted by `last_seen_at` then id, both descending, cut to `limit` | `ORDER BY last_seen_at DESC, id DESC LIMIT $3` |
| `deleteStaleWriteGateReceipts` | `delete_stale_write_gate_receipts`: removes receipts older than the cutoff, except those on a hold still `held` | `DELETE … make_interval(days => $1) AND NOT (… h.status = 'held')` |
| `upsertWriteGateHold` | `upsert_write_gate_hold`: a known key reopens the hold (status `held`, decision cleared, `seen_count` + 1), keeps its id and kind | `INSERT … ON CONFLICT (source_id, slug, fingerprint, detector_version) DO UPDATE` |
| `listWriteGateHoldRows` | `list_write_gate_hold_rows`: filters on status, kind, source list or source and `beforeId`; sorted by id descending, cut to `limit` | `… ORDER BY id DESC LIMIT $n` |
| `getWriteGateHoldRow` | `get_write_gate_hold_row`: a point read | `… WHERE id = $1` |
| `decideWriteGateHold` | `decide_write_gate_hold`: only a `held` hold moves to `released` or `dropped` | `UPDATE … WHERE id = $1 AND status = 'held'` |

Not built (they still run through `executeRaw`, which the Rust engine refuses): the purge paths (`purge.ts`,
`page-purge.ts`, `purge-slug-stores.ts`, `source-delete.ts`), `owner-actions.ts`, `release-publish.ts`, the
eligibility SQL and fence overlay, the trust reads that join facts or takes, the `to_regclass` checks in
`trust/review.ts` and the doctor check.

Rust guesses and gaps (1x parity):

- A value the table's CHECK constraints refuse (target table, verdict, kind, status) refuses with `invalid_argument`;
  Postgres raises a CHECK violation.
- `detector_version` outside the `int4` range refuses with `invalid_argument`, as Postgres refuses it.
- A NUL byte in any text, text array or JSON string refuses with `invalid_argument`, as Postgres refuses one.
- A negative `limit` refuses with `invalid_argument`; Postgres raises `LIMIT must not be negative`.
- Timestamps are microseconds. PGLite's `now()` moves in whole milliseconds, so two writes in the same millisecond
  tie on `last_seen_at` there and fall back to the id order; the parity cases wait for the clock between writes.
