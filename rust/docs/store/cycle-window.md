# The brain store: the cycle's changed-page window

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A per-source cycle that runs no sync lists the pages changed since its last cycle (`listSourceChangedPages`,
`src/core/cycle/source-window.ts`). It read the listing instant and the page window through `executeRaw`. PGLite and
Postgres run the same SQL, now in `src/core/engine-sql/cycle-reads.ts`. The store answers from its page records
(`crates/gbrain-store/src/cycle_window.rs`) and has no keys of its own. The caller reads the source's stamped cursor with
`readSourceState`. The TypeScript members are in `src/core/rust-engine/store-members/cycle-reads.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readCycleListingInstant()` | UTC ISO text with microseconds | `readCycleListingInstant` |
| `brain.listSourceChangedPagesAfter(sourceId, since, slug, limit)` | `[{ slug, updated_at }]`, at most `limit` | `listSourceChangedPagesAfter` |

## What each member answers

| Member | Notes |
| --- | --- |
| `readCycleListingInstant` | The SQL engines move the instant back to just before the oldest transaction open on another connection (at most ten minutes), so a page that commits late still lands after the cursor. With multi-user mode off the store answers now: no write registers. In multi-user mode explicit transactions run optimistically, so the store keeps the start of every open write (`open_writes.rs`: each explicit transaction from its begin to its commit or rollback, each plain write for its whole call) and answers one millisecond before the oldest, never more than ten minutes before now, the same rule. |
| `listSourceChangedPagesAfter` | The source's live pages after the cursor `(since, slug)`, ordered by `(updated_at, slug bytes)`; every page when `since` is `null`. `since` must be UTC ISO text (the shape the cursor is written in); any other shape refuses, where Postgres would cast any timestamp text. `updated_at` is UTC ISO with microseconds. |

The caller compares the listing instant with the last page's `updated_at` as text: both are fixed-width UTC ISO, so text
order is time order. It used a `timestamptz` comparison in SQL for the same answer.
