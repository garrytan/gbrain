# The brain store: the code traversal cache

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"), in the code-edges family
([code_edges.md](code_edges.md)): the rules there apply to every method here.

`code_blast` and `code_flow` memoise each traversal in the `code_traversal_cache` table. A row is one answer, keyed by
`(symbol_qualified, depth, source_id)` and stamped with the `cluster_generation` it was computed at. The cache module
(`src/core/code-intel/traversal-cache.ts`) calls three engine members; the SQL for PGLite and Postgres lives once in
`src/core/engine-sql/code-traversal-cache.ts` and the native store serves the same members
(`src/core/rust-engine/store-members/code-traversal-cache.ts`, `rust/crates/gbrain-store/src/code_edges/traversal_cache.rs`).

| JS | Resolves | Used by |
| --- | --- | --- |
| `brain.getCodeTraversalCache({ symbol_qualified, depth, source_id, cluster_generation })` | `{ response_json, computed_at, cluster_generation }`, or `null` when no row has the key at that exact generation. `computed_at` is a `Date`, `response_json` the stored value | `getCachedTraversal` |
| `brain.putCodeTraversalCache(key, response, maxChunkUpdatedAt, xminMax)` | nothing. Inserts the row; on its key replaces the response, the timestamps, `xmin_max` and the generation and restarts `computed_at` | `putCachedTraversal` |
| `brain.clearCodeTraversalCache({ sourceId } \| { allSources: true })` | the number of rows removed: one source's, or every row | `clearTraversalCache`, the `code_traversal_cache_clear` operation |

Keys (tag `g`, `keys::CODE_TRAVERSAL_CACHE`; text parts hold no NUL):

- `g 0x01 <id u64 BE>` holds the row (`CacheRecord`, JSON).
- `g 0x02 <symbol> NUL <source> NUL <depth>` holds the id: the unique index. `depth` is the `int4` as four big-endian
  bytes with the sign bit flipped.
- `g 0x03 <source> NUL <id>` holds nothing: the rows of one source, for the by-source clear.

The id comes from the sequence `next_code_traversal_cache`. Every put takes one, also a put that lands on an existing
key, as the `SERIAL` default of `INSERT .. ON CONFLICT` does.

Matching Postgres:

- The response comes back in the key order and number form `jsonb` prints: shorter keys first, then bytes; `1e21` and
  `1e-7` as JS numbers; `-0` as `0`. The store normalises the value on the way in (`jsonb`), so the read needs no work.
- A bind Postgres rejects throws from the member and stores nothing: a fractional or out-of-`int4` depth, a fractional
  generation or `xmin_max`, a NUL in a text key or in the response, an undefined response, a lone surrogate in the
  response. The cache module logs `[traversal-cache] put failed` and goes on, so a get of that key is a miss.
- A lone surrogate in a text key becomes U+FFFD, as the Postgres driver sends it.
- Rows do not follow a source: the table has no foreign key to `sources`, so removing a source leaves its rows.

Differences from PGLite and PostgreSQL (each ends on a typed `engine_capability_missing` refusal from the member, which
the cache module rethrows, never a silent difference):

- A `max_chunk_updated_at` that is not an ISO-8601 timestamp (`2026-01-02` and other loose spellings the SQL parser
  accepts) but may be a time Postgres reads (it has a digit, or is a word such as `epoch` or `now`). Text with no
  digit that is not such a word is the bind error Postgres raises, logged and skipped as on PGLite.
- There is no snapshot-isolation path to refuse: `OPTS.useSnapshotIsolation` is absent from the code and `xmin_max`
  is stored but never read.

Tests: `rust/crates/gbrain-store/tests/code_traversal_cache.rs` (store), `test/engine-parity/traversal-cache.test.ts`
(every arm), `test/code-intel/traversal-cache.test.ts` (the cache module on PGLite).
