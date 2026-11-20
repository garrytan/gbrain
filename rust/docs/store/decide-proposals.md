# The brain store: Decide proposals

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Four tables the decide loop keeps: `decide_proposals` (supersede proposals the conflict sweep leaves for the owner), `decide_review_proposals` (the review lane's proposals), `decide_review_queue` (the review lane's work queue) and `decide_sweep_deferred` (the conflict sweep's retry table). Store: `gbrain-store/src/eval_capture/decide_proposals.rs`. Binding: `gbrain-napi/src/families/decide_proposals.rs`. This landing carries the native store and binding with cargo tests; the SQL twin (`engine-sql/decide-proposals.ts`), the TypeScript member and the parity test arrive in a later landing, and nothing in TypeScript calls these members yet.

## Capability

All 16 members belong to the `eval_capture` capability, the one the five eval-capture members use. The tables share that family's key tag (`Z`) and no other capability describes them; a new capability name would need a new row in the engine capability list for no gain. `servedCapabilities()` reports `eval_capture` only when every one of its members is served; in this landing only the five eval-capture members are registered, so these 16 join them when their TypeScript members land.

## Members

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `insertDecideProposal(p)` | the new id, or `null` when `(sweep_id, pair_index)` is taken, or, for a sweep named `claim_conflicts:%`, when the fact pair is taken. The id is used up either way | `insertDecideProposal` |
| `getDecideProposal(id, lock?)` | the row or `null` | `getDecideProposal` |
| `listDecideProposalIds(sweepId, status)` | ids of one sweep in one status, by `pair_index` | `listDecideProposalIds` |
| `listDecideProposals({ status?, limit? }?)` | rows with both facts' text; default status `pending`, `all` for every status; oldest first; default limit 200 | `listDecideProposals` |
| `transitionDecideProposal(id, from, to, state?)` | `true` when the row was in `from`; sets the status, stamps `decided_at`, and a `null` or absent `state.before`/`after` keeps the stored value | `transitionDecideProposal` |
| `listDecideProposedPairs(sourceId, factId)` | ordered `{ a, b }` pairs in any status that name the fact | `listDecideProposedPairs` |
| `insertDecideReviewProposal(p)` | the new id, or `null` when `(kind, source_id, a_ref, b_ref, subject)` exists | `insertDecideReviewProposal` |
| `listDecideReviewProposals(status)` | rows by id; `all` for every status | `listDecideReviewProposals` |
| `getDecideReviewProposal(id, lock?)` | the row or `null` | `getDecideReviewProposal` |
| `transitionDecideReviewProposal(id, from, to)` | `true` when the row was in `from` | `transitionDecideReviewProposal` |
| `listDecideReviewProposalIds(sweepId, includeWithdrawals)` | pending ids of one sweep; withdrawals only when asked | `listDecideReviewProposalIds` |
| `readProposalReviewRates()` | per kind: pending count, oldest pending age in days, decisions in the last 30 days, over both proposal tables, in kind order | `readProposalReviewRates` |
| `listDueDecideReviewQueue(kind, sourceId, limit)` | due rows below 5 attempts, oldest due first | `listDueDecideReviewQueue` |
| `applyDecideReviewQueue(op)` | rows touched; `op` is `enqueue` (once per pair), `clear` or `defer` | `applyDecideReviewQueue` |
| `listDueDecideSweepDeferred(sourceId, limit)` | `{ fact_id, attempts }` rows due and below 5 attempts, by fact id | `listDueDecideSweepDeferred` |
| `applyDecideSweepDeferred(sourceId, op)` | rows touched; `op` is `defer` (back off), `relinked` (take new facts once) or `clear` | `applyDecideSweepDeferred` |

The queue and retry writes are one member each with an operation union (`applyDecideReviewQueue`, `applyDecideSweepDeferred`), not one member per statement, because the callers apply one write per call and the operations share their key.

## Records and keys

Every record starts with `keys::EVAL_CAPTURE` (`Z`) and a sub-tag in `0x30..=0x3F`; no new key tag was added.

| Key | Holds |
| --- | --- |
| `Z 0x30 <id u64 BE>` | a supersede proposal (JSON) |
| `Z 0x31 <sweep_id> 0 <pair_index i32, sign-flipped BE>` | the id: `UNIQUE (sweep_id, pair_index)`; a prefix scan is a sweep's proposals in pair-index order |
| `Z 0x32 <source_id> 0 <lo i64> <hi i64>` | the id: the partial unique index `decide_proposals_claim_pair_uidx`, kept only for sweeps named `claim_conflicts:%` |
| `Z 0x38 <id u64 BE>` | a review proposal (JSON) |
| `Z 0x39 <kind> 0 <source_id> 0 <a_ref> 0 <b_ref> 0 <subject>` | the id: the review proposals' unique key |
| `Z 0x3C <kind> 0 <source_id> 0 <a_ref> 0 <b_ref>` | a review-queue row |
| `Z 0x3D <slot> 0 <source_id> 0 <fact_id i64 flipped BE>` | a retry row |
| `M decide_proposal_next_id`, `M decide_review_proposal_next_id` | the id counters |

Text parts are NUL-terminated and a NUL byte inside one is `invalid_argument`. Integers that order keys are sign-flipped big-endian.

## Scans

Proposals are owner-reviewed rows, a few hundred at most, so lists scan a table (or the prefix a key names), filter and sort in memory. The rates scan both proposal tables and group by kind in Rust. The age and window read the store clock once per call, as `now()` is read once per Postgres statement; the 30-day window is `decided_at >= now - 30 days`. Back-off is `now + 10 minutes * attempts` for the review queue and `now + 30 minutes * attempts` for the sweep retries; both stop at 5 attempts.

## Transactions and `lock`

`engine.transaction` is not served on a Rust brain in this landing (it stays a typed refusal; the transactions family arrives later). The store's contract, for when it is: a bound `Store`'s `write` runs inside the transaction, and these members write through it, so a transaction caller that inserts or moves a proposal commits or rolls back with the rest. `lock` on `getDecideProposal` and `getDecideReviewProposal` is ignored. There is one writer, so a read inside a transaction already holds the row; PGLite and Postgres take `FOR UPDATE`.

## Differences from PGLite and Postgres

- Ids are taken before the unique keys are checked, as a BIGSERIAL does: a conflicting insert returns `null` and the id is gone. In Postgres a `NOT NULL` failure also takes an id; the store validates before it allocates, so a refused insert there takes none.
- The review queue's due order is `a_ref COLLATE "C", b_ref COLLATE "C"`. This is a deliberate pin: it makes Postgres order by bytes, as the store does, so the two do not depend on the database's locale.
- The supersede rows' `created_at` and `decided_at` are ISO strings with milliseconds on PGLite and Postgres. The store keeps microseconds; `store-members/decide-proposals.ts` cuts them to milliseconds (`new Date(s).toISOString()`). Review rows pass through as Postgres prints them (`created_at::text`).
- `REAL` columns (`p_supersede` and the like) are stored as `f32` and read back as the shortest decimal that names that `f32`, as Postgres prints a `real`. A value outside the `real` range is refused.
- `claim_conflicts:%` is a SQL `LIKE`, so `_` matches any one character: `claimXconflicts:a` counts as a claim sweep, `claims_conflicts:a` does not. The store uses the same matcher as the facts family.

## Not served: left as raw SQL

- The facts reads in `proposals-store.ts` (`maxFactId`, `factsAfter`, `factsByIds`, `conflictNeighbours`, `privateFactShare`) and in `review-lane.ts` (`withdrawAnchor`, `pagePairAnchor`) read the facts and pages stores, not these four tables.
- `answeredPairRefs` and `answeredSubjects` read `decision_receipts`.
- `requeueWithdrawnAnchorsNear` (in `review-lane.ts`) starts with a facts read and then runs `INSERT INTO decide_review_queue ... ON CONFLICT DO UPDATE SET next_attempt_at = LEAST(...)`. That upsert is a fifth queue operation no member covers. It stays raw because the facts read in front of it cannot run on a Rust engine anyway; move both when a facts read member exists.
- Other lanes' raw SQL on these tables (`facts/purge*.ts`, `facts/withdrawal.ts`, `facts/contested-claims.ts`, `trust/*`, `persistence/page-purge.ts`, `claim-conflicts.ts`'s `NOT EXISTS` on `decide_proposals`, the `commands/decide/proposals.ts` listings) is unchanged.
