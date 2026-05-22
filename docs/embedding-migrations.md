# Switching embedding models or dimensions on an existing brain

GBrain stores embeddings in a fixed-dimension `vector(N)` column on
`content_chunks`. If you switch to a model with a different dimension
(e.g. `openai:text-embedding-3-large` 1536 → `zeroentropyai:zembed-1`
1280, or `voyage:voyage-4-large` 2048), the on-disk column type doesn't
change automatically.

`gbrain init`, `gbrain doctor`, and `gbrain embed --stale` all detect
this mismatch and refuse to silently proceed. This doc is the recipe
they point at.

## Why we don't do this automatically

Switching dimensions requires:

1. Dropping the HNSW vector index (pgvector won't survive an `ALTER COLUMN TYPE`).
2. Altering the column type (Postgres only — PGLite cannot do this).
3. Wiping every existing embedding (the old vectors are unusable in the new space).
4. Re-embedding the entire corpus (can take hours on a 50K-page brain and costs $1-100 in API calls depending on model).
5. Conditionally recreating the index (HNSW supports up to 2000 dimensions per pgvector; above that you must use exact scans).

That's not an upgrade-time auto-run. It's a deliberate, expensive
operation. Run it when you've decided you actually want the new model.

## PGLite (default install)

**PGLite cannot `ALTER COLUMN TYPE vector(N)`.** pgvector ships as
embedded WASM, not a native extension, and the WASM build rejects the
column-type alter with `could not access file "$libdir/vector"`. The
SQL recipe below works against Postgres only.

The path that works on PGLite is **wipe-and-reinit**. v0.37 ships a
single-command wrapper:

```bash
gbrain reinit-pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280
```

This backs up the existing brain to `<path>.bak`, runs `gbrain init`
with the new flags (preserving every other field in
`~/.gbrain/config.json`), and re-syncs the brain repo. Add `--no-sync`
to skip the resync, `--yes` to skip the TTY confirmation, `--json` for
structured output.

Equivalent by hand:

```bash
# 1. Back up the existing brain (in case you want to roll back).
mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak

# 2. Re-init with the new model + dimensions. `gbrain init` writes
#    the schema sized to the new dim, and (as of v0.37) preserves
#    every other field in ~/.gbrain/config.json (chat model,
#    expansion model, API keys).
gbrain init --pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280

# 3. Re-import your brain repo. `gbrain sync` reads the brain repo
#    from disk and re-creates the page rows.
gbrain sync

# 4. Re-embed. The embed pipeline now uses the new model and the
#    column accepts the new dim.
gbrain embed --stale
```

If your brain repo is large enough that re-syncing from disk is
expensive (>50K pages), see the Postgres section below — migrating to
Postgres temporarily lets you run the SQL recipe, then migrate back to
PGLite.

`GBRAIN_HOME` users: substitute the active database path (or use
`gbrain config get database_path` to find it).

## Postgres (Supabase / self-hosted)

Postgres supports the in-place column alter. Replace `<NEW_DIMS>` with
your target dimension count.

```sql
BEGIN;

-- 1. Drop the HNSW index. It can't survive the column type change.
DROP INDEX IF EXISTS idx_chunks_embedding;

-- 2. Alter the column type.
ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(<NEW_DIMS>);

-- 3. Clear stale embeddings so they don't survive into the new space.
UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;

-- 4. Recreate the HNSW index ONLY IF dims <= 2000. Above that, leave it
--    indexless and rely on exact scans (gbrain searchVector handles this
--    automatically — search just gets slower, not broken).
-- For dims <= 2000 (e.g. 1024, 1280, 1536, 768):
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- For dims > 2000 (e.g. 2048 Voyage 4 Large): skip step 4.

COMMIT;
```

Then re-init config with the new model:

```bash
gbrain init --supabase \
  --embedding-model <provider:model> \
  --embedding-dimensions <NEW_DIMS>
```

And re-embed:

```bash
gbrain embed --stale
```

## A note on `gbrain config set`

Pre-v0.37 docs recommended `gbrain config set embedding_model X` to
switch models. **This is a no-op for the embed pipeline.** `config set`
writes the DB plane; the embed gateway reads the file plane
(`~/.gbrain/config.json`). The pre-v0.37 recipe shipped the lie because
the contract wasn't surfaced.

As of v0.37, `gbrain config set embedding_model` and `gbrain config set
embedding_dimensions` REFUSE and print the wipe-and-reinit recipe.

To change schema-sizing fields, use `gbrain init` (PGLite) or the SQL
recipe (Postgres). Both update the file plane AND the schema together.

## Verify

After the recipe lands, `gbrain doctor --fast` should report green and
`gbrain doctor` should pass the `embedding_width_consistency` check:

```
✓ embedding_width_consistency   dim parity: config 1280 / column vector(1280)
```

If it doesn't, file an issue with the doctor output and the steps you
ran.

## v0.37+ followups

- Auto-fallback to alternative embedding providers when the primary
  fails quota/auth. Tracked; requires explicit `--try-fallback`
  consent because mixing provider vectors silently corrupts retrieval.
