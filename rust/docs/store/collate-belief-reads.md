# The brain store: belief ledger page lifetimes

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The belief ledger gives each page a lifetime (`belief_page_lifetimes`, `src/core/belief/lifetimes.ts`): minted at the page's
first need, ended by a hard delete or a recreate at the same slug. The doctor's integrity check lists the open lifetimes whose
page is gone (`orphanLifetimes`, `src/core/belief/coverage-report.ts`). PGLite and Postgres run the statement, now in
`src/core/engine-sql/collate-belief-reads.ts`. The store answers from its own records
(`crates/gbrain-store/src/belief_ledger.rs`). The TypeScript member is in
`src/core/rust-engine/store-members/collate-belief-reads.ts`.

Only this read is served. The ledger's writes (`enableBeliefLedger`, the events, the lifetimes) are `executeRaw` on the SQL
engines and are not served here, so a shipped Rust brain holds no lifetime and the read answers an empty set. The parity
suite fills the family through a test-only seed ([test-seeds.md](test-seeds.md)).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listOrphanLifetimes(sourceId, limit, deep)` | `{ total, rows: [{ slug, page_lifetime, reason }] }` | `listOrphanLifetimes` (`no_page`; `no_lifetime` when `deep`) |
| `brain.seedBeliefPageLifetimes(sourceId, slugs)` | the slugs it minted for (test-only, `test-seeds` build) | `mintLifetime` for each page |

## What the read answers

| Rule | Notes |
| --- | --- |
| Which lifetimes | The source's open lifetimes (`ended_at IS NULL`) at its current incarnation, so a removed or recreated source answers nothing (the SQL joins `sources` on the incarnation) |
| Orphan | The source holds no page row at the lifetime's slug. A soft-deleted page is still a row, as in `NOT EXISTS (SELECT 1 FROM pages ...)` |
| Order | Slug bytes, then lifetime uuid text bytes (`COLLATE "C"`) |
| Limit | `max(1, limit)` rows; `total` counts every orphan (`count(*) OVER ()`) |
| Unknown source | Zero orphans |
| The deep read | With `deep`, the source's events (any incarnation) that name a page lifetime no lifetime record holds, in any source (the SQL has no source test on the lifetime), one row for each distinct slug and lifetime, reason `no_lifetime`. They sort and count with the `no_page` rows. Events are the store's belief events ([collate-belief-writes.md](collate-belief-writes.md)); a shipped brain writes none yet |

## Keys

The facts family (`F`) takes the rows under a sub-tag its records do not use (the facts use `0x01`-`0x0B` and `0x0F`):
`F 0x20 <source> 0x00 <slug> 0x00 <page lifetime uuid>` -> the lifetime record (JSON: lifetime, source, incarnation, slug, page
id hint, start and end microseconds). A scan of one source meets its lifetimes in slug byte order. The table has no foreign key
to `sources`, so a removed source keeps its rows, as on the SQL engines.
