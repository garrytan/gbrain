# Switching embedding models or dimensions on an existing brain

GBrain stores embeddings in a fixed-dimension `vector(N)` column on
`content_chunks`. If you switch to a model with a different dimension
(e.g. `text-embedding-3-large` 1536 → `voyage-multilingual-large-2` 2048,
or back to a smaller model like `nomic-embed-text` 768), the on-disk
column type doesn't change automatically.

`gbrain init` and `gbrain doctor` both detect and refuse to silently
proceed in this case. This doc is the recipe they point at.

## Why we don't do this automatically

Switching dimensions requires:

1. Dropping the HNSW vector index (pgvector won't survive an `ALTER COLUMN TYPE`).
2. Altering the column type.
3. Wiping every existing embedding (the old vectors are unusable in the new space).
4. Re-embedding the entire corpus (can take hours on a 50K-page brain and costs $1-100 in API calls depending on model).
5. Conditionally recreating the index (HNSW supports up to 2000 dimensions per pgvector; above that you must use exact scans).

That's not an upgrade-time auto-run. It's a deliberate, expensive
operation. Run it when you've decided you actually want the new model.

## Recipe — manual `psql` against your brain

Replace `<NEW_DIMS>` with your target dimension count.

```sql
BEGIN;

-- 1. Drop the HNSW index. It can't survive the column type change.
DROP INDEX IF EXISTS idx_chunks_embedding;

-- 2. Alter the column type. (You can DROP COLUMN + ADD COLUMN instead
--    if the existing data is already gone — same end state.)
ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(<NEW_DIMS>);

-- 3. Clear stale embeddings so they don't survive into the new space.
--    Either truncate (faster, drops all chunks) or null out (preserves
--    chunk text so re-embed regenerates without re-chunking):
UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;

-- 4. Recreate the HNSW index ONLY IF dims <= 2000. Above that, leave it
--    indexless and rely on exact scans (gbrain searchVector handles this
--    automatically — search just gets slower, not broken).
-- For dims <= 2000 (e.g. 1024, 1536, 768):
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- For dims > 2000 (e.g. 2048 Voyage 4 Large): skip step 4.

COMMIT;
```

Then update gbrain's config so it knows the new dim:

```bash
gbrain config set embedding_model <model>
gbrain config set embedding_dimensions <NEW_DIMS>
```

And re-embed the corpus:

```bash
gbrain embed --stale
```

## PGLite (local brain)

Same recipe, but you connect to the embedded database differently:

```bash
gbrain config get database_url   # confirm engine: pglite
# Open a psql-equivalent — for PGLite, the easiest path is to write a small
# script that imports PGLiteEngine and runs the SQL via engine.executeRaw.
# Or migrate to Postgres temporarily (gbrain migrate --to supabase) if you
# want a real psql connection.
```

For most PGLite users the simpler path is to **wipe and re-init** if your
corpus is small enough that re-syncing is faster than hand-crafting the
migration:

```bash
mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak
gbrain init --pglite --embedding-dimensions <NEW_DIMS>
gbrain sync   # re-imports your brain repo from disk
```

## Verify

After the recipe lands, `gbrain doctor --fast` should report green and
`gbrain doctor` (full) should say check 8b passes:

```
✓ embedding_provider     dim parity: config 768 / column vector(768) / live probe 768
```

If it doesn't, file an issue with the doctor output and the SQL you ran.

## v0.29+ plans

`gbrain migrate-embedding-dim --to <N>` is a tracked TODO. It will run
the recipe above with progress reporting + an explicit confirmation
gate. Until that lands, this manual recipe is the canonical path.
