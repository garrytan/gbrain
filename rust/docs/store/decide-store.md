# The brain store: Decide store

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The decide store holds four tables of `gbrain decide` that used to run as raw SQL in `src/core/ai/decide/store.ts`:
`decide_state`, `decide_spend`, `decision_receipts` and `decide_calibrations`. It lives inside the eval_capture
family (tag `Z`, sub-tags `0x10..=0x1F`, see [eval_capture.md](eval_capture.md)). Rust: `gbrain-store/src/eval_capture/decide_store.rs`
plus `decide_store/receipts.rs` and `decide_store/calibrations.rs`; binding: `gbrain-napi/src/families/decide_store.rs`;
TypeScript members: `src/core/rust-engine/store-members/decide-store.ts`. The shared SQL module for PGLite and
Postgres is `src/core/engine-sql/decide-store.ts`, and `src/core/ai/decide/store.ts` calls these engine members.
Parity test: `test/engine-parity/decide-store.test.ts`.

Timestamps cross the binding as ISO strings; the TypeScript members turn them into `Date`s. All 20 members are capability `eval_capture`.

## Members

| Member | Table | Answers |
| --- | --- | --- |
| `readDecideState(key)`, `upsertDecideState(key, value)`, `deleteDecideState(key)`, `ensureDecideState(key, value)` | `decide_state` | the value or `null`; `ensure` inserts only when absent and answers the stored value |
| `insertDecideSpend(rows)`, `dailyDecideSpend(since)`, `listDecideSpendBySlot()` | `decide_spend` | a request id keeps its first row; the daily total adds typesafe spend from `since` on (and the remote part); per-slot totals in byte order of the slot |
| `insertDecideReceipts(rows)`, `pruneDecideReceipts(days)` | `decision_receipts` | the batch is all or nothing; a prune answers the number of receipts removed and keeps spend at least 31 days |
| `listDecideReceiptStats`, `decideSlotUsage`, `decideConflictNoEntityCounts`, `listDecideReplayReceipts`, `listDecideResolvedModels`, `listDecideMixedModelDecisions` | `decision_receipts` | aggregates over a window of whole hours |
| `insertDecideCalibration(row)`, `storeDecideQualification(id, q)`, `listDecideCalibrations({ slot?, includeRetired? })`, `getDecideCalibration(id)`, `setDecideCalibrationRetired(id, retired)` | `decide_calibrations` | the new id; nothing; rows ordered by slot (byte order), newest first, then id; the row or `null`; whether the row exists |

## Keys and counters

| Key | Holds |
| --- | --- |
| `Z 0x10 <state key utf8>` | one state record |
| `Z 0x11 <request_id utf8>` | one spend row (the primary key) |
| `Z 0x12 <created_at u64 BE><seq u64 BE>` | time index of spend rows, value = request id; walking it is insertion order |
| `Z 0x13 <id u64 BE>` | one receipt |
| `Z 0x14 <created_at u64 BE><id u64 BE>` | time index of receipts |
| `Z 0x15 <id u64 BE>` | one calibration |
| `M decide_spend_seq`, `M decide_receipt_id`, `M decide_calibration_id` | counters; ids count up from 1 and are never reused |

Records are JSON. `REAL` columns are kept as the bit pattern of the `f32` Postgres would store and read back as the
number Postgres prints for it.

## Tightenings and differences from PGLite and Postgres

- Rust refuses what Postgres would coerce: a string for an integer column, a fractional integer, a number outside
  `int4`/`int8`, a `REAL` outside single-precision range or one that underflows to zero, a NUL byte in text, and a null
  in a `NOT NULL` column. A refused write records nothing (`invalid_argument` or `constraint_violation`).
- `NaN` and `Infinity` reach Rust as `null` through JSON and are refused; Postgres would store them.
- A window is a whole number of hours; a null or `NaN` window is refused and a non-whole one is `invalid_argument`. A window
  that reaches before 4713 BC or past 294276 AD is refused as Postgres's "timestamp out of range".
- Days are 24 hours (no daylight-saving nuance).
- Orderings that Postgres leaves to the database collation (the calibration list by `slot`, for one) use byte order
  in Rust. The SQL engines use the database's collation, so rows whose keys compare differently by bytes and by
  locale can come out in a different order.
- Replay ties break by insertion id.
- A mean adds in insertion order, as a heap scan does.
- A refused calibration insert uses no id on Rust; Postgres `BIGSERIAL` consumes one. Parity cases never assert an id after
  a refusal.
- A negative or absent calibration id reads as absent; a fractional, `NaN`, infinite or out-of-range id is refused.
- PGLite's clock has millisecond resolution, so rows of one millisecond tie; the parity test spaces batches by 20 ms.
- Rust cannot backdate rows, so windows driven by the clock (the 24 hour spend window edge, receipt window edges, the 31
  day spend floor) are pinned by the cargo tests in `gbrain-store/tests/decide_store.rs`, not by the parity file.
- An orphaned receipt record (a prune that removed the time index but not the record) would not be observable through any
  member; the prune removes both.

## Not served

`src/core/ai/decide/egress.ts` still reads `pages` through `privatePagesFilterFragment` with raw SQL. A Rust brain refuses that
call loudly. `review-lane.ts` and `proposals-store.ts` read `decision_receipts` raw and belong to other member groups.

## Tests

`gbrain-store/tests/decide_store.rs` (28 cases) covers the native store. The cross-engine parity file
`test/engine-parity/decide-store.test.ts` runs the members on PGLite, Postgres and the Rust store; the clock-window
edges and the insertion-order sum have cargo coverage only (see above).
