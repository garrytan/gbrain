# The brain store: Vector search

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`searchVector` and `searchTakesVector`, served by an exact flat scan over the stored vectors
(`rust/crates/gbrain-store/src/vectors.rs`). The TypeScript members
(`src/core/rust-engine/store-members/vectors.ts`) resolve what PGLite's shared statement
(`src/core/search/vector-statement.ts`, `engine-sql/takes.ts`) resolves in TypeScript before it runs: the
limit clamp and its warning, `resolveHardExcludes`, the source scope, the source-boost map (already sorted
longest prefix first, empty at `detail: 'high'`), `requiresSafeChunks` and the model the guard requires. The
store gets plain values and answers PGLite's row shapes.

Keys: none. This family writes nothing. It reads the embeddings family's records (`B 'c'` chunk vectors,
`B 't'` take vectors, `B 'g'` the vector generation; see `embeddings.rs`) through `scan_chunk_vectors`,
`scan_take_vectors` and `vector_generation`, and every read goes through `Store::read`, so a search sees
one committed snapshot.

## searchVector

- Every stored chunk vector is a candidate. The page and chunk filters apply inside the scan, before
  ranking: soft delete, archived source, `quarantine` / `pinned_question` frontmatter, hard-exclude
  prefixes, `type` / `types`, `exclude_slugs`, the source scope, `detail: 'low'` (compiled-truth chunks
  only), `language`, `symbolKind`, the safe-chunk rule and the chunk's visibility (a chunk of a page whose
  chunks are not sealed to its current revision is not read).
- The model guard, as PGLite's: with a model, a vector counts only when the chunk's model label is that
  model and the chunk's text hash is the hash of its current text, or absent (`chunks::EmbedState`; the
  store keeps sha256 where PGLite keeps md5, and only equality is compared). With no model (PGLite's NULL),
  every vector counts unless the `embedding_migration.state` config row exists.
- Score: pgvector's cosine of the query and the stored float32 vector, summed in float64 and kept in
  [-1, 1], times the page's source factor (an unverified auto-extracted stub takes no factor). It matches
  PGLite within 1e-6. A zero vector on either side gives NaN; NaN ranks first, as Postgres orders it, and
  goes out as `null` (the member turns it back into `NaN`).
- One row per page, its best chunk (ties: the lower chunk id). Rows sort by score, then page id, then chunk
  id; `offset` and `limit` apply after the sort.

## How searchVector reads (the bounded scan)

The answer is the full scan's, byte for byte; only the reading order changes. Reading a page and its
chunks costs far more than scoring a vector, so the store scores first and reads only the pages that can rank:

1. Every chunk vector of the cached index is scored (`1 - (embedding <=> q)`, the same arithmetic as
   above), split across the machine's cores when there are at least 4,096 vectors. Helper threads come
   from one process-wide budget (cores minus one), so concurrent searches share the cores.
2. Each page gets a bound: the largest of `raw * f` over its best and worst raw score and every factor `f`
   the call can apply (1 and each source factor). A product is monotone in the raw for a fixed factor, so
   no chunk of the page can score above it. A NaN raw gives a NaN bound, which ranks first.
3. Pages are read in bound order. Each read applies every filter, the model guard and the source factor
   above, with the same code the full scan runs. The best `offset + limit` hits are kept; the scan stops
   when the next page's bound ranks strictly below the last kept hit (a tie is still read, since a lower
   page id wins it).

The full scan still answers a call when the stored vectors have more than one width (so the width refusal
stays the one above), when a source factor is not a finite number, and when `GBRAIN_RUST_VECTOR_SCAN=full`
is set (the bench's reference; read on every call). With no model and an embedding migration running, the
bounded scan returns no rows at once, as the full scan would.

Measured with `rust/bench/vector-scan.sh` (an invented corpus, 1536 dims, 2 chunks per page on average,
limit 50, 8 vCPU Xeon 6975P-C): unfiltered p50 165 ms before and 8.6 ms after at 10,000 pages, 887 ms
before and 28.5 ms after at 50,000 pages. A filter that keeps few pages reads more of them before the top
settles (a 4% source at 50,000 pages: 239 ms before, 74 ms after). `cosinesByChunkIds` still reads every
page (about 590 ms at 50,000 pages).

## searchTakesVector

Active takes with a vector, nearest first (ties: the lower take id; PGLite leaves a tie to the database).
Filters: the holder allow list (`null` reads every holder, a `null` element matches nothing), the source
scope on the take's page, and with an eligibility policy the page's soft delete and quarantine. The store also
reads `exclude_private` (the caller's page policy), `min_trust` (the trust floor over the take's stored tier) and
`suppress_flagged`. Rows have
the shape `searchTakes` returns, with the cosine as `score`.

## Differences from PGLite

- **Refusal code.** A query PGLite cannot parse and an offset its `LIMIT`/`OFFSET` cannot take refuse
  with `invalid_argument` and PostgreSQL's message, in PGLite's order: an empty vector, a NaN, an infinite
  value, then the candidate limit (`offset + max(limit * 5, 100)`: a fraction gives
  `invalid input syntax for type integer: "101.5"`, a negative one `LIMIT must not be negative`), then a
  negative offset. PGLite throws SQLSTATE `22000`, `22P02` and `2201X`; the store has no SQLSTATE codes.
- **Infinite and huge offsets.** JSON has no infinity, so the member sends a non-finite offset as text
  (`"Infinity"`), and the store gives PostgreSQL's integer-syntax message for it.
- **Dimensions.** A query whose length differs from a stored vector's refuses with
  `different vector dimensions <query> and <stored>`, as soon as the scan compares the first vector the
  filters admit. When the filters admit no vector, or the brain has none, nothing is compared and the
  answer is `[]` (PGLite fails the same way). The dimension check runs before the model guard.
- **No candidate pool.** Every admitted vector can rank (the bounded scan above only skips pages that
  cannot), so the HNSW pool knobs
  (`vectorLegacyGuard`, `hnswIterativeScan`) change nothing and `onVectorPoolMeta` is never called.
- **`excludePrivate`.** A truthy one hides the pages the page policy hides, as `facts/privacy.rs`
  `page_hidden` reads it (`privatePagesFilterForCaller('p')`: private visibility or access, derived pages
  whose origin is private, the member-access rules). The policy is checked per page before ranking, so a
  hidden page never takes a result slot and a limit counts only visible pages. The policy also carries the owner-only rule
  (`ownerOnly`, as `page_hidden` reads it): a page of an owner-only source never takes a slot, nor does a concept
  synthesized from one, and under the closed form no page is served while the brain holds an owner-only source. A page named in `owner_only_marks` (a hard delete of an owner-only input, `keyword.md`) stays hidden on every page-reading member, because the cache reads the sources and the marks together.
  The TypeScript member sends the policy (`honorAliases`, `entityPrivacy`, `ownerOnly`) as `exclude_private`; a caller whose policy is wider than the
  store's refuses (`private-provenance.ts`). `excludePrivate` also turns on the safe-chunk rule, as in
  PGLite (`requiresSafeChunks`). A safe reader sees a page only when its `chunker_version` is 4 or more,
  as in SQL (`chunker_version >= 4`) and the keyword gate: a page that records no version is not safe.
- **`where`.** Every key must hold; a key holds when the page's top-level frontmatter field equals one of its
  values or is a list holding one (`frontmatterWhereClauses`). The TypeScript member sends a string's numeric and
  boolean readings beside it (`search-filters.ts` `whereFields`), as the keyword members do. The filter applies per
  page before ranking, so a limit counts only kept pages. An absent or empty `where` keeps every page.
- **`afterDate` / `beforeDate`.** A page is dated by its `effective_date`, else its `updated_at` (a store page
  always has one, so the SQL's `created_at` arm never applies). A bound is strict unless its `*Inclusive` flag is
  set. The TypeScript member reads the bound as `$n::text::timestamptz` does under UTC (`search-filters.ts`
  `dateMicros`), for the ISO shapes; any other shape refuses with `engine_capability_missing`. The bounds apply per
  page before ranking, as the keyword members' do (`keyword::DateWindow`).
- **`minTrust`.** A page whose stamped trust tier ranks below the floor drops per page before ranking
  (`trustFloorSql`, the floor `buildVisibilityClause` adds), so a limit counts only kept pages. An unset or empty
  floor keeps every tier; a name that is no tier refuses with `invalid_argument` (`keyword::parse_trust_floor`).
- **`suppressFlagged`.** A page at or below `agent_written` with a `flag` receipt in an activation reason family
  drops per page before ranking (`activationSuppressedSql`, `trust::activation_suppressed`), so a limit counts only
  kept pages. A flag in another family, or on a page above `agent_written`, suppresses nothing.
- **Take options.** The store applies `exclude_private`, `min_trust` and `suppress_flagged` to
  `searchTakesVector`; the TypeScript member (`store-members/vectors.ts`) sends `excludePrivate`,
  `eligibility.floor` and `eligibility.suppressFlagged` as those three.
- **One vector column.** The store keeps only the text column `embedding`, as the embedding members do.
  An `embeddingColumn` that names another column (`embedding_image`, a registered column), and a brain
  whose config sets `search_embedding_column` or `embedding_columns`, refuse with
  `engine_capability_missing`. PGLite would read the other column.

## The index cache

`VectorIndex` holds one snapshot's decoded vectors and their squared norms. `VectorCache` keeps one index
per store, keyed by the vector generation (raised by every vector write), so a search after a write
rebuilds it, and an index built from an older snapshot never replaces a newer one. The `Store` holds
the cache (`Store::vectors`, made in `open_kv`), and both searches read it, so searches with no vector
write between them reuse one decoded index. The cache is fed only from committed snapshots.

## Where the vectors come from

Chunk vectors are written by the chunk writes (`upsertChunks` / `sealChunks` with an `embedding`), take
vectors by `updateTakeEmbeddings`; both raise the vector generation. The parity test
(`test/vector-embedding-parity.test.ts`, Rust arm) seeds its fixture through those writes and runs every
`searchVector` case. Its `hybridSearch` cases rank the same on the Rust arm as on PGLite.

## `cosinesByChunkIds`

The hybrid pipeline rescores the vector arm's candidates with `cosinesByChunkIds(ids, column, query)`, which the
store serves as an exact scan (`Store::cosines_by_chunk_ids`): one `{ id, cosine }` row per chunk that is
visible to `getEmbeddingsByChunkIds` and has a vector, and no row for an id that is missing, deleted or has no
vector. The score is the text-space cosine, and it is `0` when the stored vector has another dimension count
or either norm is zero. The TypeScript member returns a map of chunk id to cosine. A query pgvector cannot parse refuses `invalid_argument`. The TypeScript member refuses a
`column` other than `embedding` with `engine_capability_missing`, since the store keeps one vector column.
