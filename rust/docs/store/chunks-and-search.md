# The brain store: Chunks and keyword search

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page's text is indexed as chunks (`chunk_source` is `compiled_truth`, `timeline`, `fenced_code` or
`image_asset`; a chunk is one record plus one posting per word). The store's own `putPage`, unless it is
given `index: false`, installs the chunks in the same transaction as the page: `opts.chunks` when the
caller passes `ChunkInput[]`, otherwise the built-in chunker (paragraphs packed to about 1500 characters;
simpler than the TypeScript chunker). The TypeScript engine does not use that: its `putPage` passes
`index: false` and writes no chunks, and only `sealChunks` (or `upsertChunks` with `seal: true`) seals.
`upsertChunks` without `seal` never seals. Sealing sets `text_projection_revision = knowledge_revision`.
Search serves only pages in that state, as PGLite does, so a tag change, soft delete or restore hides a
page from search until the store's indexing `putPage` or a seal indexes it again. Vectors are not stored; `embedding` is
`null`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.putPage(slug, page, { ..., chunks? })` | as above; `chunks` replaces the page's chunks | `putPage` plus `upsertChunks` |
| `brain.upsertChunks(slug, chunks, { sourceId?, expectedRevision?, seal?, searchTimeline? }?)` | `null`; writes the page's chunks as PGLite does: chunks not in `chunks` are removed, a chunk whose text is unchanged keeps the metadata the write leaves null, an empty list unseals the page. `page_not_found`, `revision_conflict` (`expectedRevision` only checks), `invalid_argument` for a bad `chunk_source`. With `seal: true` the chunks replace the old ones outright and are sealed to the page's revision (PGLite's `sealChunks`); `searchTimeline`, the sanitized timeline, is then kept for the page keyword vector (see "Search timeline" in `pages.md`) | `upsertChunks` |
| `brain.getChunks(slug, { sourceId?, sourceIds?, includeDeleted? }?)` | `Chunk[]` in index order, `embedding: null`; `[]` unless the page is sealed at its current revision; the slug is matched as written; soft-deleted pages are read, as PGLite reads them. The TypeScript engine refuses more than one distinct `sourceIds` entry | `getChunks` |
| `brain.deleteChunks(slug, { sourceId? }?)` | `null`; the page stays | `deleteChunks` |
| `brain.countChunks()` | number of chunks in the brain | none |
| `brain.searchKeyword(query, opts?)` | `SearchResult[]` (`slug, page_id, title, type, source_id, chunk_text, chunk_source, chunk_id, chunk_index, score, stale`, plus `effective_date` when set). `stale` is PGLite's rule: the page's `updated_at` is older than the newest `created_at` of its timeline entries | `searchKeyword` |

`searchKeyword` is not parity with PGLite. Ranking is BM25 over chunks with index-wide statistics
(`k1` 1.2, `b` 0.75), not the Postgres `ts_rank`, so scores and order differ. There is no stemming;
the English stop words are dropped from the query (a query of only stop words keeps them); each CJK
character is its own term; `websearch` syntax (quotes, `or`, `-`) is not interpreted. Like PGLite:
every term must match, a page is one result represented by its best chunk, order is `score DESC,
page_id ASC, chunk_id ASC`, `limit` defaults to 20 and is clamped to 100, soft-deleted pages,
archived sources, image chunks and pages whose frontmatter has a `quarantine` or `pinned_question` key (whatever its value) are hidden, `test/`, `attachments/` and `.raw/` slugs are hidden
(`include_slug_prefixes` opts back in; `exclude_slug_prefixes` adds to them), and `type`, `types`,
`exclude_slugs`, `sourceId`, `sourceIds` (wins), `detail: "low"` (compiled-truth chunks), `language`
and `symbolKind` filter. `where`, `afterDate` and `beforeDate` reject `invalid_argument` instead of
being ignored. A query reads the posting list of every term, so cost grows with the number of
matching chunks.
