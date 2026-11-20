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
see the row. `trust::stamp_row(table, old, supplied, content_changed)` wraps it for a row whose writers never set
the tier or the origin (takes and timeline entries, `trust::RowTrust`): it reads the open write's context, starts
an update from the stored tier and origin, and stores `unknown` as no tier.

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
| `isFactWithdrawn` | `is_fact_withdrawn`: point reads for each visibility (the given one, or both when null), the hash and the v1 hash of the claim, and subject `*`, the entity and the member page; then the purge tombstones (hash only; `*` and the entity). A null entity or member page matches nothing | `SELECT 1 FROM fact_withdrawals … UNION ALL SELECT 1 FROM fact_purges … LIMIT 1` |
| `isFactPurged` | `is_fact_purged` (facts/purge_ledger.rs): point reads for subject `*` and the entity; a visibility outside the CHECK matches nothing | `SELECT 1 FROM fact_purges … AND (subject='*' OR subject=$4) LIMIT 1` |
| `insertFactWithdrawal` | `insert_fact_withdrawal`: false when the key exists, which keeps its time | `INSERT … COALESCE($5::timestamptz, now()) ON CONFLICT DO NOTHING RETURNING` |
| `listFactWithdrawalDates` | `list_fact_withdrawal_dates`: per claim, point reads (subject given) or a scan of source and visibility (subject null); the minimum time per row number, sorted by row number | `min(withdrawn_at) … GROUP BY row_num` (no order) |
| `moveFactWithdrawalSubject` | `move_fact_withdrawal_subject`: same slugs do nothing; otherwise each row moves unless the new subject already has the key | `MOVE_WITHDRAWAL_SUBJECT_SQL` |
| `hasFactWithdrawalForSubject` | `has_fact_withdrawal_for_subject`: a scan of the source | `SELECT 1 … subject=$2 LIMIT 1` |
| `listFactWithdrawalKeys` | `list_fact_withdrawal_keys`: sorted by visibility, fact_hash and subject in byte order, then cut to `limit` | `ORDER BY visibility, fact_hash, subject LIMIT $2` |
| `readFactCacheWatermark` | `read_fact_cache_watermark`: a scan of the source's withdrawals for the count and the newest time (ISO, microseconds); the access digest is `md5` of every folder rule (`source_id/rule_id/prefix/readers/revision`, by source and rule id in byte order) and `md5` of every pending or invalid prefix (`source_id/prefix/reason/revision`, by source, prefix and reason), joined by `:` | `SELECT count(*)::int, to_char(max(withdrawn_at) AT TIME ZONE 'UTC', …), md5(… access_rules) \|\| ':' \|\| md5(… access_pending_coverage) FROM fact_withdrawals WHERE source_id = $1` |
| `readTrustGeneration` | `read_trust_generation`: the store's commit sequence as decimal text; it moves on every commit, a superset of the trigger events that bump the SQL generation, so a cache keyed on it rebuilds after any write | `SELECT generation::text AS generation FROM trust_policy_state WHERE id = 1`, bumped by deferred WHEN-guarded triggers (eligibility/generation-schema.ts) |

## Trust proposals (`trust::proposals`)

The `trust_proposals` queue (src/core/trust/schema.ts): the decisions a guard files for the owner (a contested
supersession, a forget, a lowered page, a widening confirm). Keys:

- `t 0x06 id` → proposal record.
- `t 0x07 action\0target_table\0target_id\0related_table\0related_id` → the pending proposal's id (the partial
  unique index `trust_proposals_pending_unique`; ids in decimal, an absent related row as `''` and `0`, as its
  `COALESCE`). Only a `pending` proposal has this key.
- `t 0x08 table\0` + row id (8 bytes, big-endian) + proposal id (8 bytes) → empty: the proposals naming a row as
  target or related.

Ids come from `pages::next_id("trust_proposals")`. Deleting a source removes its proposals (`ON DELETE CASCADE`,
through `cascade::remove_source_rows`).

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `insertTrustProposal` | `insert_trust_proposal`: takes an id first, then returns the pending proposal of the same key with `created: false`, so a refused insert uses up an id as BIGSERIAL does | `INSERT … ON CONFLICT DO NOTHING RETURNING id`, then `SELECT id … status = 'pending'` |
| `getTrustProposal` | `get_trust_proposal`: a point read (the `FOR UPDATE` lock is the store's one writer) | `SELECT * … WHERE id = $1` |
| `listTrustProposals` | `list_trust_proposals`: filters on status (`all`), source, action and `since`; sorted by `created_at` then id, cut to the limit | `… ORDER BY created_at, id LIMIT $5` |
| `pendingTrustProposalsFor` | `pending_trust_proposals_for`: the pending proposals naming the row, by id | `… WHERE status = 'pending' AND (target … OR related …) ORDER BY id` |
| `updatePendingTrustProposalAfter` | `update_pending_trust_proposal_after`: a pending proposal only | `UPDATE … WHERE id = $1 AND status = 'pending'` |
| `transitionTrustProposal` | `transition_trust_proposal`: compare-and-set on status; sets `decided_at` for `accepted`, `rejected` and `undone`; keeps the pending key current | `UPDATE … WHERE id = $1 AND status = $2 RETURNING id` |

Rust guesses and gaps (1x parity):

- `proposer_principal_kind`, `proposer_principal_id` and `write_request_id` read NULL. PGLite fills them from the
  transaction's `gbrain.write_principal_kind`, `gbrain.write_principal_id` and `gbrain.write_request` settings. The
  store's write context carries them ([write_trust.md](write_trust.md)); the proposal writer does not read them yet.
- A move back to `pending` that another pending proposal already holds refuses with `constraint_violation`, where
  Postgres raises a unique violation; a status, action or table the CHECK constraints refuse refuses with
  `invalid_argument`. A source that does not exist refuses as the foreign key does.
- The guest-source rules are not modelled (there is no `guest_sources` table).

Not built (they still run through `executeRaw`, which the Rust engine refuses): the reads that also read `fact_purges`
(the store keeps that table now, rust/docs/store/facts.md "The fact purge ledger", but these reads do not read it yet:
the ambiguous-fence check, the export snapshot), the reads that join `facts` (the effect-target
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

`listPendingContradictions` (the `trust review` read of a pending `decide_proposals` pair of two active facts) answers
`[]` without a store call: the store keeps no `decide_proposals`, because `insertProposal` (ai/decide/proposals-store.ts)
writes one through `executeRaw`, which the Rust engine refuses.

## Derivation trust (`trust::derivation`)

The derived-row trust writes and counts. They read and write the page, take, timeline and fact records and keep no
key of their own. The `derivation_inputs` edges are not kept on this store line: `recordDerivationInputs` and
`derivedRowsFrom` (src/core/facts/derivation-inputs.ts) still send raw SQL.

| Member | Store method | PGLite statement (src/core/engine-sql/derivation-trust.ts) |
| --- | --- | --- |
| `lowerTrustTier` | `lower_trust_tier`: pages only (the member refuses `takes` and `timeline_entries`); lowers each listed page, soft-deleted included, whose stored rank is above the tier; keeps the revision; returns the ids lowered by id | `UPDATE pages SET trust_tier=$2,write_origin=$3::text::jsonb WHERE id=ANY($1::bigint[]) AND rank > rank RETURNING id` |
| `countDerivedRowTaint` | `count_derived_row_taint`: pages, takes or timeline entries whose `write_origin` holds a `taint_inputs` key (jsonb `?`), and of those the ones stored `external_untrusted` | `SELECT count(*) FILTER (…) … FROM <table>` |
| `countDerivedFactTaint` | `count_derived_fact_taint`: the same count on facts | `SELECT count(*) FILTER (…) … FROM facts` |
| `stampPageFrontmatter` | `stamp_page_frontmatter`: merges `retired_by`/`retired_at` into soft-deleted pages, or `source_hash` into live `atom` pages; a page the merge leaves unchanged is not written | `UPDATE pages SET frontmatter=frontmatter\|\|jsonb_build_object(…) WHERE …` |

Rust guesses and gaps (1x parity):

- A frontmatter stamp that changes a page moves its revision, as the `gbrain_advance_page_revision` trigger does; a
  stamp that changes nothing keeps it (Postgres runs the `UPDATE` and the trigger sees no content change either).
- `propagateTierLowering` (src/core/trust/propagation.ts) walks the rows derived from a lowered row through
  `derivedRowsFrom`, lowers them and queues `needs_rederive` through `executeRaw`, so on a Rust brain every
  `lowerToDerivedTier` that lowers a row then stops with `raw_sql`.

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

`listTrustAllowRuleRows` (the owner's allow rules, `trust_allow_rules`) answers `[]` without a store call: the store
keeps no allow rule, because `trust allow` writes one through `executeRaw`, which the Rust engine refuses. So
`trust review` and the write gate's allow check read an empty rule set on Rust instead of a refusal.

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

## Tier reads (`trust::tier_reads`)

Typed reads of the stamped tier and write origin that core memory, the trust scan and page history made through
`executeRaw` (src/core/engine-sql/trust-tier-reads.ts). They read fields of the page, fact, take, timeline and version records, so
the family adds no key prefix. Versions have no by-id index: the version reads scan the `V` keys once per call.

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `listCorePageRows` | `list_core_page_rows`: live pages with `always_load: true` under the source, exclude and page-policy (`facts/privacy.rs`) filters; with an eligibility, less pages with a `quarantine` key and pages below the floor (`TrustPolicy`), plus the tier, origin and `suppressed` mark. `withdrawn` is a withdrawal of the source with subject `*` or the slug. By source then slug, bytewise | `SELECT … FROM pages p WHERE p.frontmatter @> '{"always_load": true}' … ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"` |
| `listTrustScanRows` | `list_trust_scan_rows`: live pages, facts, takes or timeline entries (those of a page that exists, deleted or not; each row carries its page's source) above `afterId` whose stored tier is listed, by id; a take's or timeline entry's `write_origin` keeps Postgres's jsonb key order | `SELECT … WHERE p.id > $1 AND p.trust_tier = ANY($2) ORDER BY p.id LIMIT n` |
| `countUnscannedTrustRows` | `count_unscanned_trust_rows`: the same rows, at or below `until` when set | `SELECT count(*) …` |
| `listVersionTrustTiers` | `list_version_trust_tiers`: the snapshot tier of each listed version, by id | `SELECT pv.id, pv.trust_tier FROM page_versions pv WHERE pv.id = ANY($1)` |
| `listVersionReasonWriters` | `list_version_reason_writers`: the type and tier of the page's next snapshot, else of the page (deleted or not) | `LEFT JOIN LATERAL (… ORDER BY n.id LIMIT 1)` |
| `listPageRefsByIds` | `list_page_refs_by_ids`: the source, slug and type of each listed page record (deleted or not), by id, once each; an unknown or negative id answers nothing | `SELECT id, source_id, slug, type FROM pages WHERE id = ANY($1::bigint[]) ORDER BY id` |
| `listValidTimeIdentities` | `list_valid_time_identities` (`trust/valid_time.rs`): the live pages with the slug in the source scope, by source in byte order, at most six, with the source's checkout and the no-caller page policy's verdict | `… ORDER BY p.source_id COLLATE "C" LIMIT 6` |
| `pickValidTimeEdition` | `pick_valid_time_edition`: the edition in force on a date over the page and its `V` version records, the competing ordinals and the history counts, plus `history_unpruned` | the `WITH rows AS (…)` pick |
| `listAmendmentsNotApplied` | `list_amendments_not_applied` (`link_queries/link_temporal.rs`): the live pages with an `amends` link to the page whose relationship start in the scope is after the edition and on or before the date, or absent; under the source and page-policy filters, by slug then source, bytewise | `SELECT f.slug, … min(lr.first_start) … GROUP BY f.slug, f.source_id ORDER BY f.slug COLLATE "C" …` |
| `readPageVersionEdition` | `read_page_version_edition` (`trust/valid_time.rs`): the page's `V` version record with the fields an edition reads, `body_storage` `inline` unless the snapshot is segmented; null for another page or an unknown id | `SELECT id, title, … FROM page_versions WHERE id = $1 AND page_id = $2` |
| `readCursorEdition` | `read_cursor_edition` (`trust/valid_time.rs`): whether the page record (deleted or not) is still at the revision, and the newest `V` version record at it; null when the page is gone | `SELECT (p.knowledge_revision::text = $2) AS current, (SELECT max(v.id) …) FROM pages p WHERE p.id = $1` |
| `pageAwaitsRederive` | none: the store keeps no `needs_rederive` queue (only a raw-SQL purge writes one, and `executeRaw` refuses), so the member answers false | `SELECT count(*)::int AS n FROM pages p WHERE p.id = $1 AND NOT NOT EXISTS (… needs_rederive …)` |

- `beginSnapshotRead` has no store method: a store transaction holds the one writer from its start, so its reads see
  one state. It does not enforce `READ ONLY`; a write in that transaction lands.
- `listCorePageRows` serves a caller with a reader identity or a private-readable grant: with `forCaller` its
  `excludePrivate` policy carries them (`callerReaders`), and the remote floor is the no-reader policy (`noReaders`).
  Pinned by `test/engine-parity/core-page-member-reads.test.ts`.
- `listValidTimeIdentities` serves a caller with a reader identity or a private-readable grant: its `excludePrivate`
  policy carries them (`callerReaders`), and the `world` mark, which never reads the caller's readers, is the
  no-reader policy (`noReaders`). `pickValidTimeEdition` serves the same callers when the caller's snapshot policy is
  the canonical one for those readers: a version that names readers is visible when one of them is in the policy's
  identity, and a private version when the page's source is a private-readable source and the page is not a pinned
  question. Both pinned by `test/engine-parity/valid-time-member-reads.test.ts` and `tests/valid_time.rs`.
- The other TypeScript members refuse a caller page policy that is not the no-caller one and a cursor, limit or id that is
  not an integer; the trust scan reads pages, facts, takes and timeline entries. The store refuses any other
  table and a NUL byte with `invalid_argument`.
- The belief history reads (`readBeliefHistoryRows`, `listVisibleBeliefLifetimes`) refuse in their TypeScript
  members before any store call, for every input: the store keeps no belief ledger, so it could only answer an empty
  one (TODOS.md `rust-belief-ledger`).
- `listAmendmentsNotApplied` refuses a date that is not `YYYY-MM-DD`, a non-integer page id or limit and a caller
  whose remote floor is not the page policy of no readers (a labelled-only caller); any other caller reads the floor
  (`test/engine-parity/valid-time-member-reads.test.ts`). A failure is an error: the old read answered an empty list for any failure.
- `pickValidTimeEdition` also refuses a date that is not `YYYY-MM-DD` and a history PGLite would have pruned
  (`history_unpruned`: more large inline versions than PGLite keeps, a segmented version, or a holding page over the
  kept count; TODOS.md `rust-version-prune`). The store keeps no change reason, so `reason` and
  `introduced_because` read null (TODOS.md `rust-version-change-reason`), and no gap or pruned successor.
- Pinned by `test/engine-parity/trust-tier-reads.test.ts` on every arm and by `tests/trust_tier_reads.rs` and `tests/valid_time.rs`.

## Trust scan state (`trust::scan_state`, `persistence::trust_scan_cursor`)

The statements `gbrain trust scan` (src/core/eligibility/scan.ts) ran through `executeRaw`, now typed members in
src/core/engine-sql/trust-scan.ts. A scan on a Rust brain saves its cursor, stops after `maxBatches` and resumes where
it stopped, as on PGLite; doctor `trust_scan` reads the same cursor. No new key prefix.

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `readTrustScanCursor` | `read_trust_scan_cursor`: the `completed_keys` of the `op_checkpoints` row (`trust_scan`, `v1`), or null | `SELECT completed_keys AS keys FROM op_checkpoints WHERE op = $1 AND fingerprint = $2` |
| `writeTrustScanCursor` | `write_trust_scan_cursor`: the row's keys replaced with the array, in jsonb key order, stamped now | `INSERT INTO op_checkpoints … ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()` |
| `listClaimPendingSourceIds` | `list_claim_pending_source_ids`: the sources whose config has a `trust_claimed_at` key, `trust_tier` `operator_curated`, a `kind` (`''` when absent) that is not a connector kind and no `trust_claim_lifted_at` key, archived ones included, by id | `SELECT s.id FROM sources s WHERE <claimPendingSql> ORDER BY s.id` |
| `readTrustScanCeilings` | `read_trust_scan_ceilings`: each of pages, facts, takes and timeline entries' max id over every stored row (soft-deleted pages included), 0 when empty | `SELECT max(id) AS n FROM <table>`, once per table |

- The cursor row is the parent row of the resumable-op checkpoints (rust/docs/store/persistence.md, "Op checkpoints"):
  the same key and value, so `readOpCheckpointKeys`, `writeOpCheckpointKeys` and `purgeStaleCheckpoints` see it as
  they see the Postgres row. The SQL texts are scan.ts's, not those members' (they read child paths and return text).
- The TypeScript member sends the connector kinds (`CONNECTOR_SOURCE_KINDS`), so the list stays in one place.
- The SQL orders by `s.id COLLATE "C"` and the store sorts the ids by bytes, so every engine lists them in one order
  whatever the database collation. The order only names the ids in the scan's refusal.
- Pinned by `test/engine-parity/trust-tier-reads.test.ts` (a scan that stops and resumes; doctor `trust_scan`) on every
  arm, by `tests/trust_scan_state.rs` and by the `persistence::trust_scan_cursor` unit tests.
