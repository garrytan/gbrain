# Pinned questions (`questions.rs`)

`gbrain questions pin`, `refresh`, `list`, `status` and `unpin`, and the `standing_questions` cycle phase, keep their
records in two tables: `pinned_questions` (one row per pin: the question, its scope, state, refresh lease, answer text,
watermark and spend) and `question_evidence` (one row per cited pointer of a published answer revision). They are typed
engine members with one SQL implementation for PGLite and Postgres (`src/core/engine-sql/question-store.ts`, byte for
byte the statements `src/core/questions/store.ts` and `refresh.ts` sent through `executeRaw`; pinned by
`test/question-store-sql-pin.test.ts`). The Rust store serves the same members from `rust/crates/gbrain-store/src/questions.rs`
(`questions/join.rs` for the two reads that join the records), through `src/core/rust-engine/store-members/question-store.ts`
and `rust/crates/gbrain-napi/src/families/question_store.rs`. `test/engine-parity/question-store.test.ts` runs every member on
all three arms.

## Members

| Member | What it does |
| --- | --- |
| `readPinRow(sourceId, slug, forUpdate)` | the pin's row, or null. `forUpdate` reads the same row: the store has one writer, which a publication's transaction already holds. |
| `listPinRows({ sourceIds, states, includeArchived })` | the rows by source id in byte order (`COLLATE "C"`), then creation time, then id. `sourceIds` and `states` filter when not null (an empty list matches nothing); without `states`, archived pins show only with `includeArchived`. |
| `insertPinRow(pin)` | the new row, or null when `(source_id, slug)` has one (`ON CONFLICT DO NOTHING`). Column defaults: state and publish mode from the caller, `origin 'pin'`, revision 1, answer revision 0, spend 0. A duplicate does not use up an id (Postgres' `nextval` does; no member shows the number). |
| `updatePinRowState(id, patch)` | the changed row, or null for an unknown id. Each null field is kept; `setInactiveReason` false keeps the reason. The revision goes up by one. Archiving stamps `archived_at` once (`COALESCE(archived_at, now())`) and drops the lease token and expiry (the owner stays); any other state clears `archived_at`. |
| `acquirePinLease(id, token, owner, ttlMs)` | the leased row when the pin is not archived and has no live lease: no token, no expiry, or an expiry before now. Sets token, owner, `now() + ttl` (the interval rounds to the microsecond, halves to even), `last_attempt_at`, and counts the attempt. Does not touch `updated_at`. |
| `releasePinLease(id, token, error, spendUsd)` | drops the lease the token holds, records `error`, adds the spend; nothing when another lease holds the pin. |
| `addPinSpend(id, usd)` | adds `usd` to the spend (`double` arithmetic). |
| `recordPinBlocked(id, code)` | stamps `last_attempt_at` and `last_error` unless a live lease holds the pin. A token with no expiry holds it here (`NULL < now()` is not true), unlike the lease statement. |
| `lockPinRowForPublish(id)` | `{ revision, lease_token, state }`, or null. |
| `publishPinAnswer(id, publish)` | the answer text, the next answer revision, `last_refresh_at` and `watermark_at` now, the watermark, spend added, the lease dropped, `last_error` cleared. |
| `deleteQuestionEvidence(questionId)` | deletes every evidence row of the pin. |
| `insertQuestionEvidence(rows)` | inserts the rows in order. |
| `listQuestionEvidenceJoin(questionId, answerRevision)` | one row per evidence row of that revision (by evidence id) with the `p_`, `f_`, `t_` and `k_` columns of the page (live or soft-deleted, with its source's `archived`), fact (same source), timeline entry and take it cites; the hashes are the `md5` texts of `src/core/questions/freshness.ts`. A cited row that is absent gives nulls, except `f_valid_until_passed` and `f_source_quarantined`, which are false. |
| `listPublishedQuestionAnswers(sourceId)` | `{ answer, published_at, cited }` of every pin of the source that holds an answer: the page ids its current answer revision cites. |

A publication runs inside `engine.transaction`: the members called on the transaction handle run on the bound store, so
`now()` is the transaction's clock for the whole publication (as Postgres `now()` is the transaction start) and a rollback
keeps nothing of the answer, the evidence or the id counters.

`pages.generation`: the join returns `p_generation` through one helper, `page_generation` in `questions/join.rs`, which
reads 1 until the store keeps a per-page counter (`// TODO(lane15-merge): p.generation`). The members that return or compare
a page generation (`rust-engine/question-stops.ts`) still refuse by name.

## Keys

All under the two-byte family tag `~q` (`keys::QUESTIONS`; `docs/designs/RUST_ENGINE_INTERFACES.md`, "Tag registry"):

| Key | Value |
| --- | --- |
| `~q 0x01 id(BE8)` | one `pinned_questions` row (`PinRecord`, every column; the id is `M next_pinned_question_id`) |
| `~q 0x02 source_id 0x00 slug` | the pin's id (BE8): the unique `(source_id, slug)` index |
| `~q 0x03 question_id(BE8) evidence_id(BE8)` | one `question_evidence` row (`EvidenceRecord`; the id is `M next_question_evidence_id`) |
| `~q 0x04` | kept for a `question_evidence` index; unused |

Floats: `REAL` `cooldown_days` is kept as `f32` bits and `DOUBLE PRECISION` `spend_usd` as `f64` bits, so arithmetic is
Postgres' and NaN and the infinities survive; a non-finite value crosses the binding as its Postgres text (`NaN`,
`Infinity`, `-Infinity`) and the TypeScript member reads it back with `Number()`. Times come back as ISO text and the
TypeScript member turns them into `Date`s.

Not kept: the secondary index `pinned_questions_state_idx` (a listing scans the table).

## Shadow seed

`pinned_questions` and `question_evidence` are seed relations (`seed/questions.rs`): rows copy with their ids, times and
leases, a NULL takes the table's default, a second pin on a taken `(source_id, slug)` is the unique-index error, and each
import raises its id counter. The follow side removes a pin (`seed/follow/remove_ops.rs`, which also drops its index key) and
an evidence row (found by `question_id` and `id`). The write map (`src/shadow/write-map.ts`) names each write member with a
selector: pins by `id` or `(source_id, slug)`, evidence by `question_id` (`deleteQuestionEvidence` marks it `del`).

The auto-think import (`src/core/questions/auto-think-migration.ts`) runs inside a SQL schema migration and stays raw SQL: it
fills `pinned_questions` on PGLite and Postgres before any engine member exists, and the shadow seed copies what it wrote.
