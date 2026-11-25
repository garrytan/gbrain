# Pinned questions (`questions.rs`)

`gbrain questions pin`, `refresh`, `list`, `status` and `unpin`, and the `standing_questions` cycle phase, keep their
records in two tables: `pinned_questions` (one row per pin) and `question_evidence` (one row per cited pointer of a published
answer revision). The pin rows are main's records (`jobs/pinned_questions.rs`, [pinned-questions.md](pinned-questions.md):
`m 0x2F id`, `m 0x30 source_id 0x00 slug`) with its three members, `insertPinnedQuestion`, `readPinnedQuestion` and
`listPinnedQuestions` (`src/core/engine-sql/pinned-questions.ts`). The members below are the rest of what `questions/store.ts`
and `questions/refresh.ts` sent through `executeRaw`: one SQL implementation for PGLite and Postgres
(`src/core/engine-sql/question-store.ts`, byte for byte, pinned by `test/question-store-sql-pin.test.ts`), and on the Rust
store the pin writes are in `jobs/pinned_questions.rs` and the evidence in `questions.rs` (`questions/join.rs` for the two
reads that join them), through `src/core/rust-engine/store-members/question-store.ts` and
`rust/crates/gbrain-napi/src/families/question_store.rs`. `test/engine-parity/question-store.test.ts` runs every member on all
three arms.

## Members

| Member | What it does |
| --- | --- |
| `readPinnedQuestionForUpdate(sourceId, slug)` | the pin's row, or null: the same row `readPinnedQuestion` reads (the row lock of `SELECT ... FOR UPDATE` is the store's one writer, which the caller's transaction already holds). |
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

Pin rows: main's, `m 0x2F id` and `m 0x30 source_id 0x00 slug` (`jobs/pinned_questions.rs`). The evidence family is the two-byte
tag `~q` (`keys::QUESTIONS`; `docs/designs/RUST_ENGINE_INTERFACES.md`, "Tag registry"):

| Key | Value |
| --- | --- |
| `~q 0x01`, `~q 0x02` | reserved and unused, never to be reused: the pin rows live at `m 0x2F` / `m 0x30` |
| `~q 0x03 question_id(BE8) evidence_id(BE8)` | one `question_evidence` row (`EvidenceRecord`; the id is `M next_question_evidence_id`) |
| `~q 0x04` | kept for a `question_evidence` index; unused |

Floats: `spend_usd` (`DOUBLE PRECISION`) adds as an `f64`; a finite value is stored as the JSON number main's record always
held, NaN and the infinities as their Postgres text (a record holding null reads as NaN), and a non-finite value crosses the
binding as that text (`NaN`, `Infinity`, `-Infinity`) and the TypeScript member reads it back with `Number()`. `cooldown_days`
(`REAL`) is main's `f64`; the seed keeps the shortest decimal that names the `f32`. Times come back as ISO text and the TypeScript
member turns them into `Date`s. `updated_at` is not kept (no member reads it).

Not kept: the secondary index `pinned_questions_state_idx` (a listing scans the table).

## Shadow seed

`pinned_questions` and `question_evidence` are seed relations (`seed/questions.rs`; main's seed did not copy pins): pins copy
into main's records (`m 0x2F` / `m 0x30`) with their ids, times and leases, a NULL takes the table's default, a second pin on
a taken `(source_id, slug)` is the unique-index error, and the import raises the `pinned_questions` sequence; evidence copies
to `~q 0x03` and raises `M next_question_evidence_id`. The follow side removes a pin (`seed/follow/remove_ops.rs` calls
`jobs::remove_pinned_question`, which also drops its index key) and an evidence row (found by `question_id` and `id`). The
write map (`src/shadow/write-map.ts`) names each write member with a selector: pins by `id` or `(source_id, slug)`, evidence
by `question_id` (`deleteQuestionEvidence` marks it `del`).

The auto-think import (`src/core/questions/auto-think-migration.ts`) runs inside a SQL schema migration and stays raw SQL: it
fills `pinned_questions` on PGLite and Postgres before any engine member exists, and the shadow seed copies what it wrote.
