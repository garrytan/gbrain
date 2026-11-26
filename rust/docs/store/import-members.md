# The brain store: import members

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page import runs a few page and chunk statements around its chunk write: the safe-fence read, the
origin refresh, the chunker stamp, the text projection seal, the in-place chunk moves and the
vector-reuse read. PGLite and Postgres run them from `src/core/engine-sql/pages.ts`,
`engine-sql/chunks.ts` and `engine-sql/sources.ts`. The store answers the same members from its page,
chunk, posting and vector records and the source record's `chunker_version` field
(`crates/gbrain-store/src/import_members.rs`); it adds no keys.
`replaceDerivedAliases` is in the aliases family ([aliases.md](aliases.md)).

Each write member has an `_in` function that runs in the caller's write transaction, so a page
transaction can run it among its other steps. PGLite's row locks are plain reads here: the store runs
one write at a time.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getPageSealState(pageId)` | the page's `chunker_version` (0 when it has none), or `null` for a missing, soft-deleted or segmented page. The TypeScript member returns `{ chunker_version }` or `null` | `getPageSealState` |
| `brain.refreshPageOrigin(slug, { sourceId, sourcePath, sourceUri })` | nothing. Sets a live page's `source_path` and, when `sourceUri` is not `null`, its `source_uri`. A missing or soft-deleted page, or one that already holds both, changes nothing. An origin another live page of the source holds is `origin_claimed`, as the unique index `pages_live_origin_key` refuses it | `refreshPageOrigin` |
| `brain.setChunkerVersion(slug, version, sourceId?)` | nothing. Sets the page's `chunker_version`, live or soft deleted; a missing page changes nothing. `version` is the text JavaScript binds (`String(version)`), cast as Postgres casts text to `smallint`: a fraction or other text is `invalid_argument` (`invalid input syntax for type smallint: "1.5"`), a value outside -32768..32767 is `invalid_argument` (`value "40000" is out of range for type smallint`) | `setChunkerVersion` |
| `brain.readSourceChunkerVersion(sourceId)` | the chunker version on the source record, or `null` before the first stamp and for an unknown source | `readSourceChunkerVersion` |
| `brain.setSourceChunkerVersion(sourceId, version)` | whether the source exists. Stamps `version` on the source record; an unknown source changes nothing. The TypeScript member returns nothing | `setSourceChunkerVersion` |
| `brain.writeTextProjectionSeal(slug, { sourceId, revision, timelineText })` | nothing. When `revision` equals the page's `knowledge_revision` (case-insensitive, as a uuid compares), sets `text_projection_revision` and records `timelineText` as the timeline the keyword index reads. A page whose revision moved on, or a missing page, changes nothing. A `revision` that is not a uuid is `invalid_argument` (`invalid input syntax for type uuid: "nope"`) | `writeTextProjectionSeal` |
| `brain.moveChunkIndexes(pageId, waves)` | nothing. Each wave is a list of `{ id, to, projected_byte_start?, projected_byte_end? }`. Wave by wave, each chunk of the page with the id moves to `to` with its postings and vector; a chunk that lands (`to >= 0`) takes the move's span (`NULL` when the move has none), a parked one (`to < 0`) keeps its own. An id the page does not hold is ignored. A wave that leaves two chunks at one index is `constraint_violation` (`duplicate key value violates unique constraint "idx_chunks_page_index"`) | `moveChunkIndexes` |
| `brain.getChunkReuseRows(slug, sourceId?)` | `[{ chunk_index, embedding_input_hash, contextual_retrieval_mode, text_only, unembedded }]`, every stored chunk of the page (soft deleted or not), by chunk index. `text_only` is true when the chunk's embedded text hash equals the hash of its text; `unembedded` when it has no vector and no recorded input or text hash | `getChunkReuseRows` |

## Differences from PGLite

- **A chunk left at a negative index.** PGLite lets a call end with a parked chunk (negative
  `chunk_index`). A chunk key holds an unsigned index, so the store refuses such a call with
  `invalid_argument` and writes nothing. A parked index inside a call is fine. A Rust brain is never a
  managed publication, so the planner's move budget is unbounded and every parked chunk lands in the
  same call.
- **Hashes.** `getChunkReuseRows` compares the sha256 text hash the store keeps, not md5. The store
  keeps no image or multimodal vector, so those columns read as `NULL`.
- **Stats.** `moveChunkIndexes` moves postings with their chunks; the document count and term
  statistics of the keyword index do not change, as a move adds and removes nothing.
- **A claimed origin.** `refreshPageOrigin` refuses an origin another live page of the source holds with
  `origin_claimed` itself; PGLite leaves it to the unique index `pages_live_origin_key`, whose violation the
  caller maps.
- **Error codes.** The refusals carry the store codes (`invalid_argument`, `constraint_violation`,
  `origin_claimed`) with Postgres's message text, not SQLSTATE codes.

## TypeScript members

The store's binding has all the methods above, but the TypeScript engine serves only one of them. The only member
`src/core/rust-engine/store-members/import-members.ts` exports is `getPageSealState` (line 7), which calls the binding
method of the same name through `storeCall` (capability `pages`, `src/core/rust-engine/members.ts:57`). No
`store-members` module exports `refreshPageOrigin`, `setChunkerVersion`, `readSourceChunkerVersion`,
`setSourceChunkerVersion`, `writeTextProjectionSeal`, `moveChunkIndexes`, `getChunkReuseRows` or
`replaceDerivedAliases` (`store-members/aliases.ts` does not export it), so each of those still refuses a Rust brain
with `engine_capability_missing` (capabilities `pages` and `chunks`, `members.ts:56-61, 158-161`). The native methods
exist and the store tests run them; no TypeScript member calls them yet. `getPageSealState` is exercised in
`test/persistence-bounded-reads.test.ts`.
