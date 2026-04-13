# Nomic Embed Text Migration Design

**Goal**

Switch GBrain's default embedding model from `bge-m3` to `nomic-embed-text` across both local/offline and Postgres/pgvector paths, while preserving retrieval quality by applying model-specific task prefixes for document and query embeddings.

**Scope**

- Change the default local embedding model to `nomic-embed-text`
- Add model-aware input transformation for embedding requests
- Use `search_document:` for chunk/document embedding and `search_query:` for query embedding when the active model is `nomic-embed-text`
- Keep existing behavior for non-nomic models to preserve backward compatibility
- Migrate Postgres pgvector storage from `vector(1536)` to `vector(768)`
- Update tests, migration coverage, and user-facing docs
- Provide explicit re-embedding guidance for upgraded brains

**Non-Goals**

- Add a generic provider plugin system
- Add per-model prompt configuration in user config
- Change chunking strategy
- Add dimension auto-detection from remote runtimes

**Current State**

- Local/offline defaults use `embedding_provider: "local"` and `embedding_model: "bge-m3"`
- The local provider sends raw text to Ollama-compatible `/api/embed`
- Chunk embeddings and query embeddings both use raw text
- SQLite stores vectors as `BLOB`, so dimension changes are tolerated
- Postgres stores vectors as `vector(1536)`, so switching to a 768-dim model requires schema migration

**Design**

1. **Model-aware embedding input shaping**

Introduce a small embedding preparation layer in `src/core/embedding.ts` that distinguishes between:

- document/chunk embedding
- query embedding

Rules:

- If the active model is `nomic-embed-text`, prefix document inputs with `search_document: ` and query inputs with `search_query: `
- Otherwise keep the original input unchanged

This keeps the behavior explicit without over-generalizing to arbitrary prompt templates.

2. **Provider metadata**

Extend provider capability metadata so callers can tell which model family is active and whether task prefixes should be applied. The capability should remain minimal and tied to actual behavior needed by GBrain.

3. **Chunk embedding path**

`embedChunks(...)` should always run document/chunk texts through the new document preparation path before batching. This automatically covers:

- `import`
- `sync`
- `embed --stale`
- `embed --all`

4. **Query embedding path**

`hybridSearch(...)` should call a dedicated query embedding function instead of the generic raw-text embedding function. This ensures query prefixes are applied only where needed.

5. **Postgres migration**

Add a new migration that:

- drops the HNSW vector index on `content_chunks.embedding`
- alters `content_chunks.embedding` from `vector(1536)` to `vector(768)`
- updates config values such as `embedding_dimensions`
- recreates the vector index

Operational consequence:

- old stored vectors become incompatible with the new query vectors
- users must rebuild embeddings after upgrade with `gbrain embed --all`

6. **Defaults and docs**

Update all local/offline defaults, examples, and tests from `bge-m3` to `nomic-embed-text`, and document the required role prefixes and Postgres re-embedding requirement.

**Files**

- `src/core/embedding/provider.ts`
  - Change default local model
  - Expose minimal model family metadata
- `src/core/embedding.ts`
  - Add document/query preparation helpers
  - Route generic embedding calls through explicit modes
- `src/core/search/hybrid.ts`
  - Use query-specific embedding path
- `src/core/config.ts`
  - Update local defaults
- `src/commands/init.ts`
  - Local init output should reflect the new default
- `src/core/migrate.ts`
  - Add pgvector dimension migration
- `src/schema.sql`
  - Update baseline Postgres schema defaults to `vector(768)` and config metadata
- `src/core/schema-embedded.ts`
  - Regenerate from `src/schema.sql`
- `test/local-offline.test.ts`
  - Add/adjust behavior coverage for nomic prefixes and defaults
- `test/config.test.ts`
  - Update defaults
- `test/migrate.test.ts`
  - Extend migration coverage if possible at unit level
- `README.md`
- `docs/local-offline.md`
- `docs/local-offline.ko.md`
- `docs/GBRAIN_VERIFY.md`

**Risks**

- Postgres migration may fail if the existing HNSW index is not dropped/recreated correctly
- Existing brains with mixed embeddings will produce degraded search until `gbrain embed --all` completes
- Tests that assume `bge-m3` as the local default will need synchronized updates

**Verification Plan**

- Red-green tests for prefix shaping on chunk and query paths
- Config/init tests for new default model
- Migration tests for version bump and migration registration
- Local runtime smoke test with actual `ollama pull nomic-embed-text` already completed
- Focused Bun test runs for changed areas, then a broader regression subset

**Rollout**

1. Merge code + docs
2. Release with migration note
3. In upgraded Postgres brains, run `gbrain init` to apply migrations
4. Run `gbrain embed --all` to rebuild vectors with `nomic-embed-text`
