# The brain store: propose_takes failure tombstones

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

When the propose_takes phase cannot extract takes from a page run after run, it records a failure tombstone: a `rejected`
`take_proposals` row whose claim text is `(extraction failed: <code>)` (`src/core/cycle/propose-takes-failures.ts`). The
phase wrote and listed these through `executeRaw`. PGLite and Postgres run the same SQL, now in
`src/core/engine-sql/cycle-reads.ts`. The store answers from its own records (`crates/gbrain-store/src/take_proposals.rs`).
The TypeScript members are in `src/core/rust-engine/store-members/cycle-reads.ts`. Only the tombstone rows live here; the
proposal queue that promotes takes is a different family and is not served.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.recordFailureTombstone(input)` | `true` when it inserted, `false` when the claim was already recorded | `recordFailureTombstone` |
| `brain.listFailureTombstones(sourceId, claimPrefix)` | `[{ page_slug, claim_text, prompt_version, proposed_at }]` | `listFailureTombstones` |

## What each member answers

| Member | Notes |
| --- | --- |
| `recordFailureTombstone` | Inserts the row (kind `fact`, holder `brain`, weight 0, no domain, status `rejected`) unless the page already has the same claim for the same content hash and prompt version (the table's unique index on the claim's md5). An unknown source refuses with `source_not_found`, as the foreign key does. Text with a NUL byte refuses, as Postgres does. |
| `listFailureTombstones` | The source's `rejected` rows nobody acted on whose claim text starts with the prefix, ordered by page slug bytes. `proposed_at` is `timestamptz::text` (`2026-11-18 02:37:05.215+00`). |

## Keys

The takes family (`A`) has no free sibling tag byte to give a new family, so the rows sit under a sub-tag the takes records
do not use: `A 0x10 <source> 0x00 <page slug> 0x00 <content hash> 0x00 <prompt version> 0x00 <md5(claim)>`. The key is the
table's unique index, so one claim is one row and a scan of one source meets its rows in page-slug byte order. The id
counter is `M next_take_proposal_id`. A source's rows leave with the source (`cascade.rs`).
