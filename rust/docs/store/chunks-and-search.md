# The brain store: Chunks and keyword search

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page's text is indexed as chunks (`chunk_source` is `compiled_truth`, `timeline`, `fenced_code` or
`image_asset`; a chunk is one record; its keyword postings belong to the keyword index, `keyword.md`). The store's own `putPage`, unless it is
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
| `brain.searchKeyword(query, opts?)` | the rows of `brain.searchKeywordArm(query, query, opts?)` (see below) | `searchKeyword` |

One difference in `upsertChunks`: with `sealChunkerVersion`, `pageId` and `deferSeal`, PGLite does not check
`pageId` and writes the rows into the page with that id. The store refuses another page's id with or without
`deferSeal`, so a sealed write never lands in a page the slug does not name.

`brain.searchKeyword(query, opts?)` answers exactly what `brain.searchKeywordArm(query, query, opts?)` answers: the
keyword arm's statement (`keyword.md`) with the query as both the match and the rank query, over the live keyword
index. `opts` is the arm's options (`limit`, `offset`, `type`, `types`, `sources`, `hardExcludes`, `excludeSlugs`,
`detailLow`, `where`, `afterDate`, `beforeDate` and the rest of `KeywordOptions`). Until store format 14 it was a BM25
search over its own word postings (`T`), which no TypeScript member called; format 14 dropped those postings and
their upkeep on every chunk write, and its upgrade deletes them in one write transaction (`legacy_postings.rs`).
The TypeScript `searchKeyword` member is unchanged, and it runs the arm and its retries (`keyword.md`).
