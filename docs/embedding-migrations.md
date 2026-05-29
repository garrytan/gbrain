# Switching Embedding Models Or Dimensions

Cortex stores embeddings in a fixed-dimension `vector(N)` column on
`content_chunks`. If a tenant moves to an embedding model with a different
dimension, the database column type and existing vectors must be handled
deliberately.

`cortex init`, `cortex doctor`, and `cortex embed --stale` detect dimension
mismatches and refuse to silently proceed. Use this recipe for hosted tenants
and development brains.

## Why This Is Manual

Switching dimensions requires:

1. Dropping the HNSW vector index.
2. Altering the column type in Postgres.
3. Clearing existing embeddings because old vectors are unusable in the new
   space.
4. Re-embedding the tenant corpus.
5. Recreating the index only when the new dimension is within pgvector's HNSW
   limit.

That can be expensive and should be scheduled as maintenance.

## Hosted Postgres Or Supabase

Replace `<NEW_DIMS>` with the target dimension count.

```sql
BEGIN;

DROP INDEX IF EXISTS idx_chunks_embedding;

ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(<NEW_DIMS>);

UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;

-- Only run this when <NEW_DIMS> <= 2000.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);

COMMIT;
```

Then update Cortex config and re-embed:

```bash
cortex init --supabase \
  --embedding-model <provider:model> \
  --embedding-dimensions <NEW_DIMS>

cortex embed --stale
```

For production SaaS, run this against the tenant database with normal change
control, backups, and a rollback plan.

## PGLite Development Brains

PGLite cannot alter `vector(N)` columns in place. For local demo or development
brains, use wipe-and-reinit:

```bash
cortex reinit-pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280
```

This backs up the prior local database, runs `cortex init` with the new sizing,
and replays configured sources. Add `--no-sync` to skip source replay, `--yes`
to skip confirmation, and `--json` for scripts.

## Verify

```bash
cortex doctor --fast
cortex doctor
```

The `embedding_width_consistency` check should report the same dimension in
config and in the database column.

## Notes

`cortex config set embedding_model` and `cortex config set
embedding_dimensions` are refused because config-only changes do not resize the
database column. Use `cortex init` plus the migration recipe so config and schema
move together.
