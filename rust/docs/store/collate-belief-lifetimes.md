# The brain store: belief ledger page lifetimes

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The belief ledger gives each page a lifetime, its identity in the ledger (`src/core/belief/lifetimes.ts`): minted at the
page's first need, kept across a rename, ended by a hard delete or by a recreate at the same slug. PGLite and Postgres run
the statements over `belief_page_lifetimes`, now in `src/core/engine-sql/collate-belief-lifetimes.ts`. The store answers from
its lifetime records (`crates/gbrain-store/src/belief_ledger.rs`, which also serves the orphan read of
[collate-belief-reads.md](collate-belief-reads.md)). The TypeScript members are in
`src/core/rust-engine/store-members/collate-belief-lifetimes.ts`.

Nothing in a shipped Rust brain calls these yet. `readLedgerSource` (in `store-members/persistence.ts`) reports no coverage,
so no batch opens and no lifetime is written until it does. The members are classified `belief_ledger`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readOpenLifetimes(sourceId, incarnations, slugs)` | `[{ page_lifetime, source_incarnation, slug, page_id }]` | `readOpenLifetimes` |
| `brain.mintLifetime(sourceId, incarnation, slug, pageId)` | the open lifetime's uuid | `mintLifetime` |
| `brain.endLifetime(lifetime)` | nothing | `endLifetime` |
| `brain.renameLifetime(lifetime, slug, pageId)` | nothing | `renameLifetime` |
| `brain.readMovedLifetimes(pageIds)` | `[{ page_id, source_incarnation, page_lifetime }]` | the page join in `resolveLifetimes` |

## Keys

Under the facts family (`F`). A text part ends with a NUL byte, and no text column may hold one.

| Key | Value |
| --- | --- |
| `F 0x20 <source> 0x00 <slug> 0x00 <lifetime uuid>` | the lifetime record as JSON. A scan of one source meets lifetimes in slug byte order |
| `F 0x26 <lifetime uuid>` | the lifetime's key above: `end` and `rename` name a lifetime by uuid alone |

A rename moves the record to its new slug's key and rewrites the index entry. The test-only lifetime seed writes through the
same function, so the seed and the members share one layout.

## What each member answers

| Member | Rule |
| --- | --- |
| `readOpenLifetimes` | The open lifetime at each (incarnation, slug) pair of the source; `incarnations[i]` pairs with `slugs[i]`, and unequal lengths refuse the call. A pair with no open lifetime answers nothing. The SQL also filters on the source (`l.source_id = $3`): an incarnation names one source, so no answer changes |
| `mintLifetime` | Opens a lifetime for the page at (incarnation, slug), or answers the one already open there. The uuid is the store's |
| `endLifetime` | Closes an open lifetime at the call's clock; a closed or unknown uuid changes nothing. A text that is not a uuid refuses the call |
| `renameLifetime` | Moves the lifetime to the slug and page hint. An open lifetime may not take a slug another lifetime holds open at the same incarnation: the call refuses with `constraint_violation` and nothing moves. A closed lifetime holds no slug, so it may. An unknown uuid changes nothing |
| `readMovedLifetimes` | For each page id that names a page, the open lifetimes at the page's slug whose hint is that page, in page id order. The SQL joins `pages` on id and slug and names no source; the store reads the page's own source |

## Differences from the SQL engines

- `readMovedLifetimes` looks at the source of the page the id names. The SQL join would also match an open lifetime of a
  different source that carries the same page id hint at the same slug; no writer produces one.
- A lifetime's `started_at` is the call's clock reading (`clock_timestamp()` in SQL).
