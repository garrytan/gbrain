# The brain store: the page embedding lease and the per-page spend ledgers

Part of the segmented page body family ([page_body.md](page_body.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

A whole embed of a segmented page (`embedSegmentedRows`, `embedSegmentedPage`) takes a lease on the
page, plans what it may spend against the page's embedding budget, reserves it, calls the provider
and settles. A derivation reserves the same way on its own ledger. The SQL for both SQL engines is
in `src/core/engine-sql/page-spend.ts`; the callers are `page-embedding-lease.ts`,
`page-embedding-budget.ts` and `page-spend.ts`. The code is
`rust/crates/gbrain-store/src/page_body/page_spend.rs` (ledgers and reads) and
`rust/crates/gbrain-store/src/jobs/page_lease.rs` (the lease), the binding
`rust/crates/gbrain-napi/src/families/page_spend.rs` and the members
`src/core/rust-engine/store-members/page-spend.ts`.

| Member | Returns |
| --- | --- |
| `brain.takePageEmbeddingLease(id, holder, ttlMinutes, token)` | true when this holder now has the lease |
| `brain.renewPageEmbeddingLease(id, token, ttlMinutes)` | true when the row still carries `token` and its TTL moved |
| `brain.releasePageEmbeddingLease(id, token)` | null. Deletes the holder's row and every expired `embed-page:` row |
| `brain.listVectorlessChunkIndexes(pageId)` | the indexes of the page's visible chunks with no vector, ascending |
| `brain.readPageEmbeddingHolds(pageId)` | `{ marker, state, reason }`, or null for a missing page |
| `brain.writePageEmbeddingHold(pageId, reason, mode)` | null. `replace` holds over any row; `if_absent` writes a held row only when the page has none |
| `brain.openPageEmbeddingHold(pageId)` | null. The budget row goes `open` with no reason |
| `brain.lockPageSpendLedger(ledger)` | the ledger row (inserted when absent), with `stale_reservation` |
| `brain.writePageSpendReservation(ledger, write)` | the reservation window, or null when nothing is reserved or the row is gone |
| `brain.settlePageSpendReservation(ledger, settle)` | null. Books and drops one grant's hold, only inside the window it reserved in |
| `brain.listBudgetLimitedPageRows(opts)` | held and capped pages whose row still applies, newest row first, with `pending_chunks` and `pending_chars` |
| `brain.readPageSizeStateRows(sourceId, slugs)` | the source's live pages a size state may apply to, by slug |

The members that take a column serve `embedding` only (the store's one vector column); another
column refuses `engine_capability_missing`.

## The lease lock contract

A lease is one `gbrain_cycle_locks` row `embed-page:<page id>`. The store keeps it in the cycle-lock
keyspace (`m LOCK id -> LockRecord`), so `listCycleLocks` and the writer admin fingerprint see it
as PGLite's table does.

- `takePageEmbeddingLease` writes the row when none exists or its TTL has passed (`ttl_expires_at <
  now`), and reports whether it did. The TTL is `ttlMinutes` rounded to whole minutes, as
  `make_interval(mins => $n::int)` reads it.
- `renewPageEmbeddingLease` moves the TTL only while the row carries the holder's token.
- `releasePageEmbeddingLease` deletes the holder's row and every `embed-page:` row whose TTL has
  passed.
- A token must be a UUID; another value refuses `invalid_argument`, as the `::uuid` cast does.
- None of these blocks: the holder decides when to wait. Each is one store write, so two competing
  takes never both see the row free.

The lease shares no key with the fact family (`F` sub-tags such as `0x0F` and `0x10`): it lives in
the cycle-lock keyspace and the ledgers under `b 0x09`.

## The ledgers

Keys, under the page body tag: `b 0x09 <page id> 0x00` is the page's `page_embedding_budget` row,
and `b 0x09 <page id> 0x01 <family>` is a `page_derivation_spend` row (`facts` or `synopsis`). Both
go with the page (`ON DELETE CASCADE`). A reservation runs inside the caller's store transaction:
its single writer stands in for PGLite's `FOR UPDATE`.

Rules each member keeps from the SQL:

- A write to a missing page refuses `constraint_violation` (the foreign key); so does a negative
  spend, reservation or cap, and a state outside `open`, `held` and `capped` (the CHECKs).
- The reservation window is `reserved_at` in whole microseconds as text (`RESERVATION_WINDOW_SQL`).
  A new window is always later than the one it replaces, even on the same clock tick. A
  reservation older than one hour reads `stale_reservation`.
- A settle outside the window books nothing.
- `planPageEmbedding` marks a junk page held with `writePageEmbeddingHold(..., 'replace')` on the row
  it just inserted and locked; the result equals the old `UPDATE`.

## The budget rule

A budget row still applies (`budgetRowAppliesFilter`) when it is not `open` and the page's body is
over the inline threshold (`body_bytes` on a segmented page, else the byte length of its body
columns) or the reason holds a page of any size (`archive_backfill`, `archive_open_day`,
`call_import`). `page_budget_limited` is that rule for one page. The held-page list, the stale-chunk
counts, `listStaleChunks`, the content-drift sweep ([embeddings.md](embeddings.md)) and
`countEmbeddingHeldPages` ([link_queries.md](link_queries.md)) read it.
