import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { hnswMaxDimsForType, readExistingEmbeddingShape } from '../vector-index.ts';

export const v045: Migration = {
  version: 45,
  name: 'facts_hot_memory_v0_31',
  // v0.31: hot memory layer — real-time working memory queryable across
  // sessions. Sits alongside `takes` (cold, markdown-mirrored) as the
  // ephemeral DB-only counterpart. Dream cycle's new `consolidate` phase
  // promotes facts → takes(kind='fact') overnight; the consolidated_into
  // pointer keeps facts as the audit trail.
  //
  // Schema decisions (from /plan-eng-review):
  //   - source_id TEXT (sources.id is TEXT — eE2). Per-source isolation;
  //     cross-brain federation stays agent-side.
  //   - kind CHECK constraint with 5 values; different decay halflives.
  //   - visibility column mirrors takes' world-default ACL contract (D21).
  //   - embedding column dim resolved at migration time from the
  //     `config.embedding_dimensions` row (matches content_chunks dim) so
  //     non-OpenAI brains (Voyage, etc.) work — codex F6 fix.
  //   - HALFVEC preferred (pgvector >= 0.7 needed); falls back to VECTOR
  //     with stderr warn on older pgvector — codex eE6 fix.
  //   - 5 partial indexes leading on source_id so every read uses the
  //     trust boundary as part of the index, not a callback.
  //   - consolidated_into BIGINT — takes.id is BIGSERIAL.
  sql: '',
  handler: async (engine: BrainEngine) => {
    // Step 1: resolve embedding dim from config table (already populated
    // by the schema-init __EMBEDDING_DIMS__ replacement on PGLite, or by
    // the seed config on Postgres). Default to 1536 (OpenAI text-embed-3-large).
    let embeddingDim = 1536;
    try {
      const dimRows = await engine.executeRaw<{ value: string }>(
        `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
      );
      if (dimRows.length > 0) {
        const parsed = parseInt(dimRows[0].value, 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 4096) {
          embeddingDim = parsed;
        }
      }
    } catch {
      // No config row yet — fall back to default. Fresh installs hit this
      // path on first initSchema; that's fine since the schema seeds
      // the row before subsequent migrations run.
    }

    // Step 2: pgvector version preflight for HALFVEC support (>=0.7).
    // PGLite ships a recent pgvector inside its WASM bundle; we still
    // probe to be honest about the column type.
    let useHalfvec = false;
    if (engine.kind === 'postgres') {
      try {
        const vrows = await engine.executeRaw<{ extversion: string }>(
          `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
        );
        if (vrows.length === 0) {
          throw new Error(
            `Migration v40 (facts hot memory) requires the pgvector extension. ` +
            `Install it via\n  CREATE EXTENSION vector;\n` +
            `then re-run \`gbrain apply-migrations --yes\`.`,
          );
        }
        const v = vrows[0].extversion;
        const parts = v.split('.');
        const major = parseInt(parts[0] ?? '0', 10);
        const minor = parseInt(parts[1] ?? '0', 10);
        // HALFVEC introduced in pgvector 0.7.0
        if (major > 0 || (major === 0 && minor >= 7)) {
          useHalfvec = true;
        } else {
          // Fall back to full-precision vector with stderr warning.
          // eslint-disable-next-line no-console
          console.warn(
            `[v40 facts] pgvector ${v} < 0.7 — falling back to VECTOR(${embeddingDim}). ` +
            `HALFVEC space savings unavailable; functionality otherwise identical. ` +
            `Upgrade pgvector to 0.7+ to enable HALFVEC.`,
          );
        }
      } catch (err) {
        // Re-throw the missing-extension error; tolerate other probe failures.
        if (err instanceof Error && err.message.includes('requires the pgvector')) throw err;
        // Probe failed for other reason — assume older pgvector and fall back.
      }
    } else {
      // PGLite: bundled pgvector is recent enough for HALFVEC. Use it.
      useHalfvec = true;
    }

    const existingShape = await readExistingEmbeddingShape(engine, 'facts');
    const columnType = existingShape?.type ?? (useHalfvec ? 'halfvec' : 'vector');
    const vecType = columnType.toUpperCase();
    // HNSW operator class must match the column type:
    //   VECTOR(n)  → vector_cosine_ops
    //   HALFVEC(n) → halfvec_cosine_ops
    const opclass = columnType === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
    const hnswMaxDims = hnswMaxDimsForType(columnType);
    const factsEmbeddingIndexSql = (existingShape?.dimensions ?? embeddingDim) <= hnswMaxDims
      ? `CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw
          ON facts USING hnsw (embedding ${opclass})
          WHERE embedding IS NOT NULL AND expired_at IS NULL;`
      : `-- idx_facts_embedding_hnsw skipped: pgvector HNSW ${columnType} indexes support
        -- at most ${hnswMaxDims} dimensions; exact vector scans remain available.`;
    // FK to sources is added in a separate ALTER TABLE rather than inline
    // on the column. Inline `REFERENCES` worked on PGLite but silently
    // got dropped by postgres.js's `unsafe()` multi-statement path on
    // Postgres in the v0.31 e2e run (table created without FK; CASCADE
    // delete didn't fire). Splitting the FK declaration out makes the
    // intent explicit and idempotent: the named constraint either
    // exists or doesn't, and the ALTER is a no-op on re-runs.
    const factsDDL = `
        CREATE TABLE IF NOT EXISTS facts (
          id                BIGSERIAL PRIMARY KEY,
          source_id         TEXT        NOT NULL DEFAULT 'default',
          entity_slug       TEXT,
          fact              TEXT        NOT NULL,
          kind              TEXT        NOT NULL DEFAULT 'fact'
                            CHECK (kind IN ('event','preference','commitment','belief','fact','idea')),
          visibility        TEXT        NOT NULL DEFAULT 'private'
                            CHECK (visibility IN ('private','world')),
          notability        TEXT        NOT NULL DEFAULT 'medium'
                            CHECK (notability IN ('high','medium','low')),
          context           TEXT,
          valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
          valid_until       TIMESTAMPTZ,
          expired_at        TIMESTAMPTZ,
          superseded_by     BIGINT      REFERENCES facts(id),
          consolidated_at   TIMESTAMPTZ,
          consolidated_into BIGINT,
          source            TEXT        NOT NULL,
          source_session    TEXT,
          confidence        REAL        NOT NULL DEFAULT 1.0
                            CHECK (confidence BETWEEN 0 AND 1),
          embedding         ${vecType}(${embeddingDim}),
          embedded_at       TIMESTAMPTZ,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- v0.32.2 (migration v51): fence round-trip columns. Both nullable
          -- because pre-v0.32 rows didn't have them; the v0_32_2 orchestrator
          -- backfills via fence-append. New rows from the markdown-first
          -- runFactsBackstop/runFactsPipeline paths populate them at insert
          -- time. The partial unique index below enforces (source_id,
          -- source_markdown_slug, row_num) uniqueness only once row_num is
          -- set, so legacy NULL rows don't collide with each other or block
          -- the backfill.
          row_num               INTEGER,
          source_markdown_slug  TEXT
        );

        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'facts_source_id_fkey'
              AND conrelid = 'facts'::regclass
          ) THEN
            ALTER TABLE facts
              ADD CONSTRAINT facts_source_id_fkey
              FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE;
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_facts_entity_active
          ON facts(source_id, entity_slug, valid_from DESC)
          WHERE expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_session
          ON facts(source_id, source_session, created_at DESC)
          WHERE expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_since
          ON facts(source_id, created_at DESC)
          WHERE expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_unconsolidated
          ON facts(source_id, entity_slug)
          WHERE consolidated_at IS NULL AND expired_at IS NULL;

        ${factsEmbeddingIndexSql}
      `;

    await engine.runMigration(40, factsDDL);

    // Step 3: enable RLS on Postgres when role has BYPASSRLS (v24/v29 pattern).
    // PGLite has no RLS engine.
    if (engine.kind === 'postgres') {
      await engine.runMigration(40, `
          DO $$
          DECLARE
            has_bypass BOOLEAN;
          BEGIN
            SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
            IF has_bypass THEN
              ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
            END IF;
          END $$;
        `);
    }
  },
};
