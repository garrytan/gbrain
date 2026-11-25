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
hold `gbrain_fact_fingerprint_v1(claim)`, and every read matches both. Postgres rows written before v341 can hold
`gbrain_fact_fingerprint_v2(claim)` (whitespace by the database locale); the SQL reads match that hash too. The store
never wrote one: it folds the explicit `is_pg_space` list, which `gbrain_fact_fingerprint` folds on every engine. Deleting a source removes its rows (the table's
`ON DELETE CASCADE`, through `cascade::remove_source_rows`). A slug rename (`updateSlug`) moves them in its own
transaction (`move_subject_in`, the same move `moveFactWithdrawalSubject` makes).

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `hasCoveringFactWithdrawal` | `has_covering_fact_withdrawal`: four point reads (`*` and the subject, the hash and the v1 hash of the claim) | `SELECT 1 … fact_hash IN ($3, v2($5), v1($5)) AND (subject='*' OR subject=$4)` |
| `isFactWithdrawn` | `is_fact_withdrawn`: point reads for each visibility (the given one, or both when null), the hash and the v1 hash of the claim, and subject `*`, the entity and the member page; then the purge tombstones (hash only; `*` and the entity). A null entity or member page matches nothing | `SELECT 1 FROM fact_withdrawals … UNION ALL SELECT 1 FROM fact_purges … LIMIT 1` |
| `isFactPurged` | `is_fact_purged` (facts/purge_ledger.rs): point reads for subject `*` and the entity; a visibility outside the CHECK matches nothing | `SELECT 1 FROM fact_purges … AND (subject='*' OR subject=$4) LIMIT 1` |
| `insertFactWithdrawal` | `insert_fact_withdrawal`: false when the key exists, which keeps its time | `INSERT … COALESCE($5::timestamptz, now()) ON CONFLICT DO NOTHING RETURNING` |
| `listFactWithdrawalDates` | `list_fact_withdrawal_dates`: per claim, point reads (subject given) or a scan of source and visibility (subject null); the minimum time per row number, sorted by row number | `min(withdrawn_at) … GROUP BY row_num` (no order) |
| `moveFactWithdrawalSubject` | `move_fact_withdrawal_subject`: same slugs do nothing; otherwise each row moves unless the new subject already has the key | `MOVE_WITHDRAWAL_SUBJECT_SQL` |
| `hasFactWithdrawalForSubject` | `has_fact_withdrawal_for_subject`: a scan of the source | `SELECT 1 … subject=$2 LIMIT 1` |
| `listFactWithdrawalKeys` | `list_fact_withdrawal_keys`: sorted by visibility, fact_hash and subject in byte order, then cut to `limit` | `ORDER BY visibility, fact_hash, subject LIMIT $2` |
| `readFactCacheWatermark` | `read_fact_cache_watermark`: a scan of the source's withdrawals for the count and the newest time (ISO, microseconds); the access digest is `md5` of every folder rule (`source_id/rule_id/prefix/readers/revision`, by source and rule id in byte order) and `md5` of every pending or invalid prefix (`source_id/prefix/reason/revision`, by source, prefix and reason), joined by `:` | `SELECT count(*)::int, to_char(max(withdrawn_at) AT TIME ZONE 'UTC', …), md5(… access_rules) \|\| ':' \|\| md5(… access_pending_coverage) FROM fact_withdrawals WHERE source_id = $1` |
| `readTrustGeneration` | `read_trust_generation`: the store's commit sequence as decimal text; it moves on every commit, a superset of the trigger events that bump the SQL generation, so a cache keyed on it rebuilds after any write | `SELECT generation::text AS generation FROM trust_policy_state WHERE id = 1`, bumped by deferred WHEN-guarded triggers (eligibility/generation-schema.ts) |
| `readSourcePurgeFlags` | `read_source_purge_flags`: `facts` from the fact purge ledger (any tombstone of the source, [facts.md](facts.md) "The fact purge ledger"); `takes` from the take purge ledger (any tombstone of the source, [facts.md](facts.md) "The take purge ledger"), read in the same snapshot | `EXISTS (… fact_purges …), EXISTS (… take_purges …)` |
| `listPurgedTakeRows` | `list_purged_take_rows` (facts/take_purges.rs): per take row, the claim's fingerprint, then point reads for subject `*` and the subject, or one scan of the source's take tombstones when the subject is null; each matched row number once, ascending. The TS member refuses a row number outside 32 bits, which the SQL's `row_num integer` column refuses | `SELECT DISTINCT i.row_num FROM jsonb_to_recordset($2…) JOIN take_purges p …` (no set order) |

### The forget commit (`trust::withdrawal_commit`)

The statements a `forget` commits around the ledger writes (`recordFactWithdrawal` in publication mode,
`persistence/forget-prepare.ts`) and the read a `fact_withdrawn` refusal names (`factWithdrawnRefusal`,
`facts/single-prepare.ts`). They read and write the `F 0x01`, page and withdrawal records; no new key prefix.

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `lockFactForWithdrawal` | `lock_fact_for_withdrawal`: a point read of the source's fact (the store's one writer is the lock); `worldOnly` admits a world fact or a private one on `memberPage`, the floor drops a hidden row; no outcome-marker filter | `SELECT visibility, fact, <subject> … FOR UPDATE` |
| `queueWithdrawalReview` | `queue_withdrawal_review`: the decide review queue's enqueue, kind `withdraw`, `b_ref` `*` | `INSERT INTO decide_review_queue … ON CONFLICT DO NOTHING` |
| `listSegmentedPagesBySlug` | `list_segmented_pages_by_slug`: a page whose `compiled_truth` and `timeline` are both null, by id | `SELECT id, slug … body_storage = 'segmented'` |
| `bumpWithdrawnPageRevisions` | `bump_withdrawn_page_revisions`: a new knowledge revision for each inline page, its projection revision and embedding signature cleared | `UPDATE pages SET knowledge_revision = gen_random_uuid() … RETURNING` |
| `readPageRevisions` | `read_page_revisions`: point reads by id, by id | `SELECT id, slug, knowledge_revision … id = ANY($1)` |
| `appendFactForgetReason` | `append_fact_forget_reason`: the `concat_ws(' \| ', NULLIF(context, ''), note)` rule through `write_fact` | `UPDATE facts SET context = concat_ws(…)` |
| `readFactWithdrawnRow` | `read_fact_withdrawn_row`: point reads for subject `*`, the entity and the owned page and both fingerprints; the most specific subject first, then the newest; under the floor only a withdrawal some row of which the caller sees, or that no row backs | `SELECT subject, visibility, withdrawn_at … GROUP BY … ORDER BY` |
| `readFactWithdrawnBacking` | `read_fact_withdrawn_backing`: whether the caller sees one (`visible`) and fails to see one (`hidden`) of the expired rows the withdrawal reached; requires the floor | `SELECT bool_or(…) AS visible, bool_or(NOT …) AS hidden …` |

### The forget commit (`trust::withdrawal_commit`)

The statements a `forget` commits around the ledger writes (`recordFactWithdrawal` in publication mode,
`persistence/forget-prepare.ts`) and the read a `fact_withdrawn` refusal names (`factWithdrawnRefusal`,
`facts/single-prepare.ts`). They read and write the `F 0x01`, page and withdrawal records; no new key prefix.

| Member | Store method | PGLite statement |
| --- | --- | --- |
| `lockFactForWithdrawal` | `lock_fact_for_withdrawal`: a point read of the source's fact (the store's one writer is the lock); `worldOnly` admits a world fact or a private one on `memberPage`, the floor drops a hidden row; no outcome-marker filter | `SELECT visibility, fact, <subject> … FOR UPDATE` |
| `queueWithdrawalReview` | `queue_withdrawal_review`: the decide review queue's enqueue, kind `withdraw`, `b_ref` `*` | `INSERT INTO decide_review_queue … ON CONFLICT DO NOTHING` |
| `listSegmentedPagesBySlug` | `list_segmented_pages_by_slug`: a page whose `compiled_truth` and `timeline` are both null, by id | `SELECT id, slug … body_storage = 'segmented'` |
| `bumpWithdrawnPageRevisions` | `bump_withdrawn_page_revisions`: a new knowledge revision for each inline page, its projection revision and embedding signature cleared | `UPDATE pages SET knowledge_revision = gen_random_uuid() … RETURNING` |
| `readPageRevisions` | `read_page_revisions`: point reads by id, by id | `SELECT id, slug, knowledge_revision … id = ANY($1)` |
| `appendFactForgetReason` | `append_fact_forget_reason`: the `concat_ws(' \| ', NULLIF(context, ''), note)` rule through `write_fact` | `UPDATE facts SET context = concat_ws(…)` |
| `readFactWithdrawnRow` | `read_fact_withdrawn_row`: point reads for subject `*`, the entity and the owned page and both fingerprints; the most specific subject first, then the newest; under the floor only a withdrawal some row of which the caller sees, or that no row backs | `SELECT subject, visibility, withdrawn_at … GROUP BY … ORDER BY` |
| `readFactWithdrawnBacking` | `read_fact_withdrawn_backing`: whether the caller sees one (`visible`) and fails to see one (`hidden`) of the expired rows the withdrawal reached; requires the floor | `SELECT bool_or(…) AS visible, bool_or(NOT …) AS hidden …` |

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
| `listUnreadablePrivacyHoldIds` | `list_unreadable_privacy_hold_ids`: each listed id once, ascending; a `supersede_fact` proposal whose before state names `visibility` whose target fact is missing (or not in `facts`) or one `VisibilityWidening::admits` refuses (the caller's member page and private-facts grant, sent by `storeVisibility`); a caller the member cannot model refuses | `SELECT tp.id FROM trust_proposals tp LEFT JOIN facts f … AND (f.id IS NULL OR NOT (<memberFactAdmitSql> OR <grantedPrivateFactSql>))` |
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
request, the single-fact prepare, the repair and review lanes) and the meta-hook watermark. The `facts` guard
`gbrain_preserve_fact_withdrawal` is built (`facts/withdrawal_guard.rs`): every fact write (`write_fact`) saves a row
that is not expired and matches a withdrawal of its claim as expired at the earliest such withdrawal, with
`valid_until` no later than it (`facts::purge::earliest_withdrawal`; a member-page row matches only its page's
withdrawals, an unbacked name key any subject but an owned memory page). Every update member that sets a watched
column on a row it can leave active runs it too (facts.md, "Captured-facts and rehome repair").

Rust guesses and gaps (1x parity):

- A visibility other than `private` or `world` refuses with `invalid_argument`; Postgres raises a CHECK violation.
- An unknown source refuses with `source_not_found`; Postgres raises a foreign-key violation.
- `withdrawnAt` must be the ISO form `Date#toISOString` gives (or the store's own microsecond form); any other text
  refuses with `invalid_argument`, where Postgres casts many spellings to `timestamptz`.
- A NUL byte in any text argument refuses with `invalid_argument`, as Postgres refuses one in `text`.
- A negative `limit` refuses with `invalid_argument`; Postgres raises `LIMIT must not be negative`.
- The fingerprint is a copy of the facts family's (facts.rs on the facts-sites line). `pg_lower_char` follows the code
  points probed on PGLite (`LOWER_KEEP`); a Postgres built with a different Unicode table can differ.

`listPendingContradictions` (the `trust review` read of a pending `decide_proposals` pair of two active facts) is the
decide-proposals family's `list_pending_contradictions` (eval-capture, `eval_capture/decide_proposals.rs`): the pending
proposals whose two facts both sit in the proposal's source and are active (not expired, `valid_until` unset or in the
future), oldest first, at most 1000, with the new fact's tier, entity and claim, the slug of either fact and both claim
values. An optional source and an ISO `since` filter by the proposal.

## Derivation trust (`trust::derivation`)

The derived-row trust writes and counts. They read and write the page, take, timeline and fact records and keep no
key of their own. The `derivation_inputs` edges are kept by `generations/derivation_inputs.rs` (facts.md, "Derivation
inputs"): `recordDerivationEdges` writes them and `listDerivedRows` reads one hop of `derivedRowsFrom`.

| Member | Store method | PGLite statement (src/core/engine-sql/derivation-trust.ts) |
| --- | --- | --- |
| `lowerTrustTier` | `lower_trust_tier`: pages only (the member refuses `takes` and `timeline_entries`); lowers each listed page, soft-deleted included, whose stored rank is above the tier; keeps the revision; returns the ids lowered by id | `UPDATE pages SET trust_tier=$2,write_origin=$3::text::jsonb WHERE id=ANY($1::bigint[]) AND rank > rank RETURNING id` |
| `countDerivedRowTaint` | `count_derived_row_taint`: pages, takes or timeline entries whose `write_origin` holds a `taint_inputs` key (jsonb `?`), and of those the ones stored `external_untrusted` | `SELECT count(*) FILTER (…) … FROM <table>` |
| `countDerivedFactTaint` | served by `facts/trust_owner.rs` `count_derived_fact_taint` (rust/docs/store/facts.md) | `SELECT count(*) FILTER (…) … FROM facts` |
| `countDerivedFactTaint` | `count_derived_fact_taint` in `facts/trust_owner.rs` (rust/docs/store/facts.md): the same count on facts | `SELECT count(*) FILTER (…) … FROM facts` |
| `stampPageFrontmatter` | `stamp_page_frontmatter`: merges `retired_by`/`retired_at` into soft-deleted pages, or `source_hash` into live `atom` pages; a page the merge leaves unchanged is not written | `UPDATE pages SET frontmatter=frontmatter\|\|jsonb_build_object(…) WHERE …` |

Rust guesses and gaps (1x parity):

- A frontmatter stamp that changes a page moves its revision, as the `gbrain_advance_page_revision` trigger does; a
  stamp that changes nothing keeps it (Postgres runs the `UPDATE` and the trigger sees no content change either).
- `propagateTierLowering` (src/core/trust/propagation.ts) walks the rows derived from a lowered row through
  `derivedRowsFrom`, lowers them and queues `needs_rederive` through `executeRaw`, so on a Rust brain every
  `lowerToDerivedTier` that lowers a row then stops with `raw_sql`.

`listPendingContradictions` (the `trust review` read of a pending `decide_proposals` pair of two active facts) is the
decide-proposals family's `list_pending_contradictions` (eval-capture, `eval_capture/decide_proposals.rs`): the pending
proposals whose two facts both sit in the proposal's source and are active (not expired, `valid_until` unset or in the
future), oldest first, at most 1000, with the new fact's tier, entity and claim, the slug of either fact and both claim
values. An optional source and an ISO `since` filter by the proposal.

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
| `deleteStaleWriteGateReceipts` | `delete_stale_write_gate_receipts`: removes receipts older than the cutoff, except those on a hold still `held`; a retention whose cutoff is past the timestamp range is `invalid_argument` and deletes nothing | `DELETE … make_interval(days => $1) AND NOT (… h.status = 'held')` |
| `upsertWriteGateHold` | `upsert_write_gate_hold`: a known key reopens the hold (status `held`, decision cleared, `seen_count` + 1), keeps its id and kind | `INSERT … ON CONFLICT (source_id, slug, fingerprint, detector_version) DO UPDATE` |
| `listWriteGateHoldRows` | `list_write_gate_hold_rows`: filters on status, kind, source list or source and `beforeId`; sorted by id descending, cut to `limit` | `… ORDER BY id DESC LIMIT $n` |
| `getWriteGateHoldRow` | `get_write_gate_hold_row`: a point read | `… WHERE id = $1` |
| `decideWriteGateHold` | `decide_write_gate_hold`: only a `held` hold moves to `released` or `dropped` | `UPDATE … WHERE id = $1 AND status = 'held'` |

The owner's allow rules (`trust_allow_rules`, `trust/allow_rules.rs`; `gbrain trust allow add|remove|list`):

| Member | Store | Mirrors |
| --- | --- | --- |
| `addTrustAllowRule` | `add_trust_allow_rule`: `{ source_active: false }` and nothing written when the source is missing or archived; else the rule inserted (`created: true`), or the active rule already holding (source, prefix or '', family or '') returned unchanged (`created: false`), which still uses up one id as the sequence does. The table's CHECKs (prefix 1 to 2048 characters, a known reason family, a reason up to 500 characters) refuse with `constraint_violation` and take no id (a known difference: Postgres' sequence uses one up) | `SELECT id FROM sources … NOT archived`, then `INSERT … ON CONFLICT DO NOTHING RETURNING *`, then the active row `ORDER BY id LIMIT 1` |
| `removeTrustAllowRule` | `remove_trust_allow_rule`: an active rule gets `removed_at` and `removed_by` and frees its active key; the row stays as the receipt. Null for a removed or unknown id | `UPDATE … SET removed_at = now() … WHERE id = $1 AND removed_at IS NULL RETURNING *` |
| `readTrustAllowRule` | `read_trust_allow_rule`: a point read, active or removed | `SELECT * … WHERE id = $1` |
| `listTrustAllowRuleRows` | `list_trust_allow_rules`: by id; active only unless `includeRemoved`; an empty source list reads every source | `… ORDER BY id` |

Keys: `t 0x0f id` (8-byte big-endian) holds every rule; `t 0x10 source \0 uri_prefix \0 reason_family` holds the active
rule's id (the partial unique index `trust_allow_rules_active_unique`). Ids come from the `trust_allow_rules` counter. A
source delete removes the source's rules (`ON DELETE CASCADE`). The TypeScript member answers a rule id that is not a
whole number with Postgres' bigint error (22P02) and a whole id below 1 with null. The shadow seed copies the rules and
the follow keeps them (`rust/docs/store/seed.md`). The family came in without a format bump (`format.md`).

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
| `listPageQuoteTiers` | `list_page_quote_tiers`: the type and tier of each listed page record (deleted or not) by id, or of the live pages with the slug in the listed sources, by id, once each; both forms or neither is an invalid argument | `SELECT id, type, trust_tier FROM pages WHERE id = ANY($1::bigint[])` / `… WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL ORDER BY id` |
| `listValidTimeIdentities` | `list_valid_time_identities` (`trust/valid_time.rs`): the live pages with the slug in the source scope, by source in byte order, at most six, with the source's checkout and the no-caller page policy's verdict | `… ORDER BY p.source_id COLLATE "C" LIMIT 6` |
| `pickValidTimeEdition` | `pick_valid_time_edition`: the edition in force on a date over the page and its `V` version records, the competing ordinals, the history counts and the prune marks (`successor_pruned`, the page's `version_history_gap_at`) | the `WITH rows AS (…)` pick |

| `listAmendmentsNotApplied` | `list_amendments_not_applied` (`link_queries/link_temporal.rs`): the live pages with an `amends` link to the page whose relationship start in the scope is after the edition and on or before the date, or absent; under the source and page-policy filters, by slug then source, bytewise | `SELECT f.slug, … min(lr.first_start) … GROUP BY f.slug, f.source_id ORDER BY f.slug COLLATE "C" …` |
| `readPageVersionEdition` | `read_page_version_edition` (`trust/valid_time.rs`): the page's `V` version record with the fields an edition reads, `body_storage` `inline` unless the snapshot is segmented; null for another page or an unknown id | `SELECT id, title, … FROM page_versions WHERE id = $1 AND page_id = $2` |
| `readCursorEdition` | `read_cursor_edition` (`trust/valid_time.rs`): whether the page record (deleted or not) is still at the revision, and the newest `V` version record at it; null when the page is gone | `SELECT (p.knowledge_revision::text = $2) AS current, (SELECT max(v.id) …) FROM pages p WHERE p.id = $1` |
| `pageAwaitsRederive` | served: true when a page with the id exists and the store's `needs_rederive` queue (`generations/needs_rederive.rs`, written by `markNeedsRederive`) names it | `SELECT count(*)::int AS n FROM pages p WHERE p.id = $1 AND NOT NOT EXISTS (… needs_rederive …)` |
| `listHeldRows` | `list_held_rows` (`trust/held_rows.rs`): the page's take or timeline records among the ids whose stored tier ranks above the writer (the named `writer`, else the declared tier of the write trust context; a name that is no tier ranks 0) or, with `pending`, that a pending `forget` proposal targets; `{ id, trust_tier }` by id. A take or timeline record stored before its tier reads `unknown`; any other table refuses with `invalid_argument`. The `FOR UPDATE` lock adds nothing under the store's one writer | `SELECT x.id, x.trust_tier FROM takes|timeline_entries x WHERE x.page_id = $1 AND x.id = ANY($2) AND (rank > writer OR OPEN_CONTEST) ORDER BY x.id FOR UPDATE` |
| `listGuardedTakeRows` | `list_guarded_take_rows` (`trust/held_rows.rs`): the batch guard of `gbrain extract takes` (`guardTakeRows`). The stored takes on the batch's pages that a `gone` entry deletes or an incoming row of the same page and number changes (another claim, kind or holder, or deactivates an active take), and that rank above the declared tier of the write trust context or, with `pending`, that a pending `forget` proposal targets; `{ id, page_id, row_num, trust_tier, change }` by page then row, once per matching entry, `change` `removed`, `replaced` or `deactivated`. An empty batch reads nothing | `SELECT x.id, … CASE … END AS change FROM takes x LEFT JOIN jsonb_to_recordset($1) n … LEFT JOIN jsonb_to_recordset($2) g … WHERE x.page_id = ANY($3) AND (rank > writer OR OPEN_CONTEST) … ORDER BY x.page_id, x.row_num FOR UPDATE OF x` |

- `beginSnapshotRead` needs a store transaction, which a Rust brain does not serve in this landing (a later landing adds
  it). It sets no isolation level: a store transaction holds the one writer from its start, so its reads
  see one state. With `readOnly` it calls `setTransactionReadOnly` (`transactions.md`), so every later write in the
  transaction refuses with Postgres's SQLSTATE `25006` and leaves nothing.
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
- The belief history reads (`readBeliefHistoryRows`, `listVisibleBeliefLifetimes`) are store members over the
  ledger's rows (`trust::belief_history`, "The belief ledger", below). Their members refuse only a labelled-only
  caller, whose floor the page policy cannot carry.
- `listAmendmentsNotApplied` refuses a date that is not `YYYY-MM-DD`, a non-integer page id or limit and a caller
  whose remote floor is not the page policy of no readers (a labelled-only caller); any other caller reads the floor
  (`test/engine-parity/valid-time-member-reads.test.ts`). A failure is an error: the old read answered an empty list for any failure.
- `pickValidTimeEdition` also refuses a date that is not `YYYY-MM-DD`. It reads the history the store keeps after its
  version prune (`pages.md`, "Version prune"). `reason` is a version's stored change reason and `introduced_because`
  the reason of the edition before, unless that edition's successor was pruned; under `excludePrivate` a reason reads
  only when the version that replaced it is visible and was not pruned, as on PGLite. `gap_at` is the page's
  `version_history_gap_at`.

- Pinned by `test/engine-parity/trust-tier-reads.test.ts` on every arm and by `tests/trust_tier_reads.rs` and `tests/valid_time.rs`.

## The belief ledger (`trust::belief_events`, `trust::belief_lifetimes`, `trust::belief_redactions`, `trust::belief_history`, `trust::belief_coverage`, `trust::belief_state`)
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


The store keeps the belief ledger's four tables (src/core/belief/schema.ts) and serves the eleven statements of
src/core/engine-sql/belief-ledger.ts as store members (src/core/rust-engine/store-members/belief-ledger.ts), the
history reads (`readBeliefHistoryRows`, `listVisibleBeliefLifetimes`), the source probes (`readLedgerSource`,
`listCoveredSources`), the coverage reads src/core/belief/coverage.ts makes (`trust::belief_coverage`) and the
state reads of src/core/engine-sql/belief-state.ts (`trust::belief_state`). The history, source and state reads keep
no keys of their own; the coverage reads use the baseline index.

| Key | Value | PGLite row or index |
| --- | --- | --- |
| `t 0x09 0x00 source \0 incarnation \0 id` | the event record | `belief_events` |
| `t 0x09 0x01 event_key` (raw bytes) | the event's `0x00` key | `UNIQUE (event_key)` |
| `t 0x09 0x02 publication_id` | `{observed_at_us}` | `belief_commit_marks` |
| `t 0x09 0x03 source \0 subject_kind \0 subject_key \0 id` | incarnation | `belief_events_subject` |
| `t 0x09 0x04 publication_id \0 id` | `recorded_at_us` | `belief_events_publication` |
| `t 0x09 0x05 source \0 run \0 slug \0 id` | incarnation, baseline events only | the `cause->>'run'` baseline reads |
| `t 0x0a 0x00 page_lifetime` | the lifetime record | `belief_page_lifetimes` |
| `t 0x0a 0x01 incarnation \0 slug` | the open lifetime | `belief_page_lifetimes_open` (partial unique) |
| `t 0x0a 0x02 page_id \0 page_lifetime` | empty, open lifetimes only | the moved read's `page_id = ANY` |
| `t 0x0b source \0 claim_fp \0 id` | incarnation | `belief_events_claim_fp` |
| `t 0x0c 0x00 id` | the suppression record | `belief_redactions` |
| `t 0x0c 0x01 source \0 subject_key \0 id` | empty | `belief_redactions_subject` |
| `t 0x0c 0x02 source \0 field_hash \0 id` | empty | `belief_redactions_field_hash` |

Ids are 8 bytes big-endian, from the `belief_events` and `belief_redactions` counters; a page id is 4 bytes with the
sign bit flipped. UUIDs are stored as Postgres prints them (lowercase, hyphenated); the uuid input takes the
hyphenated form or 32 hex digits, either case. Event and lifetime times are the store clock at each row
(`clock_timestamp()`); a suppression's `created_at` is the transaction clock (`now()`).

Differences from the design sketch: the open-lifetime key has no source (the unique index is on incarnation and
slug alone); a suppression is keyed by id alone, since a release names ids across every source; the subject index
carries `subject_kind`, as `belief_events_subject` does; and `t 0x09 0x04` is new, for the commit mark's newest
`recorded_at`. The page tier index the trust module doc reserved moves from `t 0x09` to `t 0x0d`. `t 0x09 0x05` is
written for a `baseline` event whose slug and `cause.run` (a string) have no NUL; it came without a format bump,
because enable refused on this engine before it, so no store could hold a baseline event without the index.

- `insertBeliefEvents` casts every row first (uuid, timestamptz, jsonb, `decode(hex)`), then inserts in `ord` order
  (a null `ord` last). Each row takes an id, a skipped one too, as the `BIGSERIAL` default runs before
  `ON CONFLICT DO NOTHING`; a key already recorded, by an earlier row of the same call included, is skipped. A row
  fails on its first NOT NULL column, then on the `subject_kind`, `origin` and `tier_basis` checks, and the call
  writes nothing. The ids its rows took stay used, as a Postgres sequence's do: a failed call outside a store
  transaction raises the counter past them in a write of its own, so the next call's ids match Postgres's.
- `markBeliefCommits` reads the clock once and marks each listed publication whose newest event is not after it,
  unless it has a mark.
- `mintBeliefLifetime` answers the lifetime already open at the pair, or fails on the primary key for a lifetime id
  already used. `renameBeliefLifetime` moves an open or an ended lifetime; an open one moved onto a pair with
  another open lifetime fails on `belief_page_lifetimes_open`. `readOpenBeliefLifetimes` answers a pair given twice
  twice, as the `unnest` join does. `readMovedBeliefLifetimes` matches the page by id in any source, deleted or not.
- `readBeliefRedactions` answers each matching suppression once, in id order. `releaseBeliefRedactions` updates the
  listed ids in any source.
- `readBeliefTombstones` reads the fact half from the fact purge ledger (`F 0x0F`, any visibility and any subject)
  and the take half from the take purge ledger (`facts.md`, "The take purge ledger"). A fingerprint found in both
  halves, or asked twice, is answered once.
- `readLegacyClaimFingerprints` and `readLegacyBeliefTombstones` make no store call and answer none: they find a claim
  recorded or purged under the pre-v341 Postgres fingerprint, which the store never held (it folds the explicit
  `is_pg_space` list).
- `readBeliefHistoryRows` reads the source's current incarnation by id, ascending or descending, in batches, with
  the slug, subject key, recorded-time window, subject key list and `beforeId` filters. Each row carries
  `stream_visible` (the stream lifetime is open, its page live at the same source and slug, the same page when the
  lifetime names one, and the page passes the caller's floor; for facts and takes it is not quarantined; null with no
  live page), `later_private` (a later private event of the same claim fingerprint and kind) and `take_holder` (the
  event's own holder, else the newest earlier one of the key). A key with a `derived.hidden` event in any incarnation
  hides its events below that marker and its backfill events. `listVisibleBeliefLifetimes` answers each listed
  lifetime once, in uuid text order, when it is open and its page is live and passes the floor.
- `readLedgerSource` reads the newest coverage event of the current incarnation that is not `coverage.restored`, and
  answers `purgesPossible` from the purge epoch and the fact, take and page purge ledgers. In batch mode it adds the
  store's one managed-mode row and the plan mode it would replace, which the store does not change.
  `listCoveredSources` lists, in byte order, the sources with a coverage event about the key in their current
  incarnation. Inside a transaction a batch probe with coverage active sets the transaction's `plan_cache_mode` to
  `force_generic_plan` (store-members/transactions.ts keeps it; the store has no planner, so it changes nothing else).
- The coverage reads (`trust::belief_coverage`): `readLatestBeliefCoverage` answers the newest coverage event of the
  current incarnation that is not `coverage.restored` (run, recorded time, id), or none for an unknown source.
  `hasBeliefBaseline` and `countBeliefBaselineSlugs` read the baseline index of one run in any incarnation.
  `listBeliefBaselinePending` lists, in byte order after the cursor, the slugs of live and soft-deleted pages, of
  unexpired page-less database-only facts (their entity) and of unexpired slot facts with no row (their page), less
  the run's baselined slugs and the skip list, up to the limit. The source row lock `enableBeliefLedger` and
  `disableBeliefLedger` take is `lockSourceRow`, a plain read here: the store runs one write transaction at a time.
- The state reads (`trust::belief_state`): `readBeliefStateRows` reads each stream of the source (a listed slug, or a
  listed page id in the source): its live or soft-deleted page, the unexpired fence facts it projects and the
  unexpired database-only facts about it, its takes, the links and transitions whose origin, else from, page it is,
  and those rows' endpoint pages with their source incarnation. A page's `visible` is judged by the no-caller page
  policy and `large` is a segmented body or an inline body over the creation limit. The store keeps no
  per-transaction write counters, so `counts` and `entity_pages` are null and every part is read, as on a database
  with `track_counts` off. The member adds the transaction's `gbrain.write_trust_tier` and restores the plan mode the
  batch probe replaced. Transitions are found by a scan of every transition record (no owner index), as
  `links_touching_page` does. `readBeliefFactsById` answers the listed fact rows that exist.
- No table has a foreign key, so a source delete keeps the ledger's rows, as Postgres does; a source created again
  has another incarnation, and the reads by incarnation do not see the old rows. The suppression and claim reads are
  by source id and do see them, as on Postgres.
- Pinned by `test/engine-parity/belief-ledger.test.ts` on every arm and by the unit tests in each module.

## The belief side of a purge (`trust::belief_purge`)

The store serves the purge statements of src/core/engine-sql/belief-purge.ts
(src/core/rust-engine/store-members/belief-purge.ts). They keep no keys of their own.

- `bumpSourcePurgeEpoch` raises the source record's `purge_epoch` by one and answers the new value; an unknown source
  answers null, as the `UPDATE ... RETURNING` finds no row.
- `hasBeliefEvents` answers whether the source has a belief event of any incarnation: the first key under
  `t 0x09 0x00 source \0`.
- `registerPurgeRedaction` adds a suppression under the `t 0x0c` keys unless one with the same source, subject, field,
  purge request and field hash exists. Its `created_at` is the transaction clock.
- `releasePurgeRedactionsForField` binds each suppression of one field of one subject to the releasing publication and
  hash. It skips one already released to that hash and one whose redacted text has that hash, and answers the purge
  request of each released row, in id order.
- `replayPagePurges` and `countPagePurgeTombstones` live with the page purge ledger (`facts.md`, `facts/page_purges.rs`).
- `readPurgeReplaySchema` makes no store call: the store always has the live schema, so it answers every listed store
  and every probed table and column as present.
- Pinned by `test/engine-parity/belief-purge-probes.test.ts` on every arm and by the unit tests in each module.

## Tier-only row changes (`trust::row_tier`)

`setRowTier` (trust/page-handlers.ts) and `queueTierProjection` (trust/page-write.ts) through typed members
(`src/core/engine-sql/row-tier.ts`), for a fact, a take or a page:

- `readRowTrustTier(table, id)`: `{ trust_tier }`, or null for no row.
- `setRowTrustTier(table, id, tier, decision)`: the tier by name, and `owner_decision` merged into `write_origin`
  (`COALESCE(write_origin, '{}') || jsonb_build_object('owner_decision', decision)`); `[id]`, or `[]` for no row. The
  stamp runs as an UPDATE that names both columns: a raise needs the promotion the caller opens, an undeclared writer's
  raise is refused, a lowering is kept. A page goes through the page trust restore (`pages.rs`).
- `readTierProjectionPage(table, id)`: `{ source_id, slug }` of a fact's markdown page (none without one), a take's page
  or the page itself, in any state.

The members add no keys.

## Label guards (`trust::label_guards`)

The `page_label_guards` table (GST-2521): the trust tier an owner label write set on a page. One record per page:

`t 0x0e page_id` (8 bytes, big-endian; `t 0x0a` is the belief ledger's page lifetimes) -> `{"tier": <tier>, "set_at_us": <i64>}`

`writePageLabelGuard` ([label_door.md](label_door.md)) writes and deletes it. A hard page delete removes it (the
table's `ON DELETE CASCADE`, through `cascade::remove_page_rows`). The guard's readers (`labelGuardTier` and the
deletion and graduation inventories) still read the table through `executeRaw`, which the Rust engine refuses.
