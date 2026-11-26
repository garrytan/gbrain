# The brain store: Chunks and keyword search

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page's text is indexed as chunks (`chunk_source` is `compiled_truth`, `timeline`, `fenced_code` or
`image_asset`; a chunk is one record plus one posting per word). The store's own `putPage`, unless it is
given `index: false`, installs the chunks in the same transaction as the page: `opts.chunks` when the
caller passes `ChunkInput[]`, otherwise the built-in chunker (paragraphs packed to about 1500 characters;
simpler than the TypeScript chunker). The TypeScript engine does not use that: its `putPage` passes
`index: false` and writes no chunks, and only `sealChunks` (or `upsertChunks` with `seal: true`) seals.
`upsertChunks` without `seal` never seals. Sealing sets `text_projection_revision = knowledge_revision`.
A plain `upsertChunks` (no `seal`, no `sealChunkerVersion`) also follows PGLite's `chunkWriteInvalidations`:
unless the page is at the safe fence version (4 or more) and the write repeats its stored chunks exactly
(the same indexes, text, source and modality, and no metadata field set to a new value), the page's
`chunker_version` becomes -1 before the write. A refresh of the same snapshot keeps it.
Chunk ids follow PGLite: a seal (`sealChunks`, `upsertChunks` with `seal`) and the store's own indexing
`putPage` replace the page's chunks, so every chunk gets a new id from the shared counter in chunk order and
the old ids are gone (a chunk id from before reads as stale); a plain `upsertChunks` keeps the id of a chunk
whose index it rewrites, as PGLite's `ON CONFLICT (page_id, chunk_index)` does.
Search serves only pages in that state, as PGLite does, so a tag change, soft delete or restore hides a
page from search until the store's indexing `putPage` or a seal indexes it again. A chunk's text vector is stored with it
(`embeddings.md`); an image vector (`embedding_image`) is not stored, and a chunk that carries one is refused.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.putPage(slug, page, { ..., chunks? })` | as above; `chunks` replaces the page's chunks | `putPage` plus `upsertChunks` |
| `brain.upsertChunks(slug, chunks, { sourceId?, expectedRevision?, seal?, searchTimeline? }?)` | `null`; writes the page's chunks as PGLite does: chunks not in `chunks` are removed, a chunk whose text is unchanged keeps the metadata the write leaves null, an empty list unseals the page. Before that, an embedded chunk (its vector's text hash is its text) follows its exact chunk (source and text) to a new index with its id, vector and timestamps, as `moveDisplacedChunksAndPrune` does, so a chunk inserted above it does not cost its vector. `page_not_found`, `revision_conflict` (`expectedRevision` only checks), `invalid_argument` for a bad `chunk_source`, and `invalid_state` for a plain write (no `seal: true`, empty list included) on a segmented page, before anything is written, so it never replaces the page's segment chunks. With `seal: true` the chunks replace the old ones outright and are sealed to the page's revision (PGLite's `sealChunks`); `searchTimeline`, the sanitized timeline, is then kept for the page keyword vector (see "Search timeline" in `pages.md`) | `upsertChunks` |
| `brain.upsertChunks(slug, chunks, { sourceId?, sealChunkerVersion, pageId?, deferSeal? })` | `null`; the import's sealed replacement (its caller removed the rows it replaces earlier in the same transaction). Only the indexes in `chunks` are written; every other chunk and the text seal stay as they were, and `chunker_version` becomes `sealChunkerVersion` (an empty `chunks` only sets the version). The version is the text JavaScript binds, cast as Postgres casts text to `smallint`: a fraction, a value outside -32768..32767, `NaN` or a NUL is `invalid_argument`. `pageId` with `chunks` names the page the caller wrote in this transaction: another page's id is `invalid_argument` (`Page <slug> (source=<id>) is not the page this transaction wrote`). With `deferSeal` too the version is left to the caller. `page_not_found` for a missing page; `invalid_argument` with `seal: true` | `upsertChunks` |
| `brain.getChunks(slug, { sourceId?, sourceIds?, includeDeleted?, includeEmbedding?, includeUnsealed?, requireSafeChunks?, excludePrivate? }?)` | `Chunk[]` in index order, `embedding: null` unless `includeEmbedding` is set, which returns each stored text vector (`embeddings.md`); `[]` unless the page is sealed at its current revision, or `includeUnsealed` is set, which reads the live body's chunks of a page that is not sealed; `[]` with `requireSafeChunks` unless the page's chunks are at the safe fence chunker version (the `chunk_queries` safe-chunk test); the slug is matched as written; soft-deleted pages are read, as PGLite reads them. The TypeScript engine refuses more than one distinct `sourceIds` entry | `getChunks` Under `excludePrivate` (the caller's page policy, `facts/privacy.rs` `page_hidden`) a hidden page has no chunks to read; the TypeScript member also turns on the safe-chunk fence then, as `requiresSafeChunks` does. |

| `brain.deleteChunks(slug, { sourceId? }?)` | `null`; the page stays | `deleteChunks` |
| `brain.countChunks()` | number of chunks in the brain | none |
| `brain.searchKeyword(query, opts?)` | `SearchResult[]` (`slug, page_id, title, type, source_id, chunk_text, chunk_source, chunk_id, chunk_index, score, stale`, plus `effective_date` when set). `stale` is PGLite's rule: the page's `updated_at` is older than the newest `created_at` of its timeline entries | `searchKeyword` |

One difference in `upsertChunks`: with `sealChunkerVersion`, `pageId` and `deferSeal`, PGLite does not check
`pageId` and writes the rows into the page with that id. The store refuses another page's id with or without
`deferSeal`, so a sealed write never lands in a page the slug does not name.

This is the core BM25 method. The TypeScript `searchKeyword` member no longer calls it: it runs the `ts_rank` arm in
`keyword.md`, and this method stays in the addon unused. `searchKeyword` here is not parity with PGLite. Ranking is BM25 over chunks with index-wide statistics
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
