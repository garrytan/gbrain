/**
 * E2E coverage for the v0.28.5 fix wave.
 *
 * Three regression scenarios this wave was shipped to fix:
 *
 *   1. PGLite upgrade wedge — a brain pinned at any version v0.13+ that
 *      hits `init --migrate-only` against current master used to crash with
 *      `column "..." does not exist`. The bootstrap's per-engine forward-
 *      reference probe now restores the missing columns before SCHEMA_SQL
 *      replays. Test: rewind a fresh-LATEST PGLite brain to a pre-v0.20
 *      shape (drop v0.20+v0.26.3+v0.27 columns + their indexes), then
 *      re-run initSchema and assert all migrations through LATEST_VERSION
 *      apply with no crash.
 *
 *   2. Embedding-dim corruption — `gbrain init --embedding-dimensions 768`
 *      previously created a `vector(1536)` column anyway because the schema
 *      blob hardcoded the dim. After v0.28.5 (cluster B / #641) the dim
 *      flag templates end-to-end. Test: fresh PGLite init configured for
 *      768-d, query the actual column type, assert it's `vector(768)`.
 *
 *   3. Existing-brain dim-mismatch hard error (A4) — re-init'ing an
 *      existing 1536-d brain with a different requested dim should refuse
 *      with the inline ALTER recipe instead of silently corrupting config.
 *      Test: build a brain at 1536, then call the helper init uses to
 *      detect mismatches, assert it surfaces the right (existing, requested)
 *      pair AND that the recipe message inlines all four steps including
 *      the conditional HNSW reindex (codex finding #8).
 *
 * PGLite-only — none of these require a real Postgres. The Postgres-side
 * bootstrap is covered by `test/e2e/postgres-bootstrap.test.ts`; this file
 * is the PGLite-side equivalent specifically for the wedge classes the
 * v0.28.5 wave fixed.
 *
 * Run: bun test test/e2e/v0_28_5-fix-wave.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import {
  readContentChunksEmbeddingDim,
  embeddingMismatchMessage,
} from '../../src/core/embedding-dim-check.ts';

describe('v0.28.5 cluster A — PGLite upgrade wedge regression', () => {
  test('pre-v0.20 brain (missing v0.20+v0.26.3+v0.27 columns) re-runs initSchema cleanly', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      // Build a fresh LATEST brain.
      await engine.initSchema();
      const db = (engine as any).db;

      // Rewind to a pre-v0.20 shape: drop the columns the v0.20+v0.26.3+v0.27
      // bootstrap claims to restore. CASCADE handles dependent indexes and
      // triggers. Also reset version so runMigrations replays.
      await db.exec(`
        DROP INDEX IF EXISTS idx_chunks_search_vector;
        DROP INDEX IF EXISTS idx_chunks_symbol_qualified;
        DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
        DROP FUNCTION IF EXISTS update_chunk_search_vector;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS parent_symbol_path CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS doc_comment CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS symbol_name_qualified CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS search_vector CASCADE;

        DROP INDEX IF EXISTS idx_mcp_log_agent_time;
        ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS agent_name CASCADE;
        ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS params CASCADE;
        ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS error_message CASCADE;

        DROP INDEX IF EXISTS idx_subagent_messages_provider;
        ALTER TABLE subagent_messages DROP COLUMN IF EXISTS provider_id CASCADE;

        UPDATE config SET value = '13' WHERE key = 'version';
      `);

      // Re-run initSchema — bootstrap must restore the dropped columns
      // before SCHEMA_SQL replay, and runMigrations must walk through LATEST.
      // Pre-v0.28.5 this crashed with `column "search_vector" does not exist`
      // OR `column "agent_name" does not exist` OR `column "provider_id"
      // does not exist`, depending on which stripped column the schema blob
      // hit first.
      await engine.initSchema();

      // Confirm we landed at LATEST.
      const versionRow = await engine.executeRaw<{ value: string }>(
        `SELECT value FROM config WHERE key = 'version'`,
      );
      expect(versionRow[0]?.value).toBe(String(LATEST_VERSION));

      // Confirm the v0.27 wedge column specifically is back. Codex's plan-
      // review caught that this is a composite-index second column —
      // earlier first-col-only extractors missed it.
      const providerCol = await engine.executeRaw<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'subagent_messages'
             AND column_name = 'provider_id'
         ) AS exists`,
      );
      expect(providerCol[0]?.exists).toBe(true);

      // Confirm the v0.20 + v0.26.3 columns are also restored.
      const searchVectorCol = await engine.executeRaw<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'content_chunks'
             AND column_name = 'search_vector'
         ) AS exists`,
      );
      expect(searchVectorCol[0]?.exists).toBe(true);

      const agentNameCol = await engine.executeRaw<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'mcp_request_log'
             AND column_name = 'agent_name'
         ) AS exists`,
      );
      expect(agentNameCol[0]?.exists).toBe(true);
    } finally {
      await engine.disconnect();
    }
  }, 60000);

  test('hasPendingMigrations correctly reports state across the upgrade lifecycle', async () => {
    const { hasPendingMigrations } = await import('../../src/core/migrate.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      // Fresh brain → no version row yet → defensive true.
      expect(await hasPendingMigrations(engine)).toBe(true);

      // After initSchema → version === LATEST → false.
      await engine.initSchema();
      expect(await hasPendingMigrations(engine)).toBe(false);

      // Rewind version → true again.
      await engine.setConfig('version', '13');
      expect(await hasPendingMigrations(engine)).toBe(true);

      // Re-apply → false. Closes the loop.
      await engine.initSchema();
      expect(await hasPendingMigrations(engine)).toBe(false);
    } finally {
      await engine.disconnect();
    }
  }, 60000);
});

describe('v0.28.5 cluster B — embedding dim corruption regression', () => {
  test('fresh init at non-default dims templates the column correctly', async () => {
    // The wedge: v0.27 silently created vector(1536) regardless of the
    // --embedding-dimensions flag. v0.28.5 (#641) plumbs the dim through
    // `getPGLiteSchema(dims)` so the column is templated correctly.
    const { configureGateway } = await import('../../src/core/ai/gateway.ts');
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 768,
      env: { ...process.env },
    });

    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const dim = await readContentChunksEmbeddingDim(engine);
      expect(dim.exists).toBe(true);
      expect(dim.dims).toBe(768);
    } finally {
      await engine.disconnect();
      // Reset gateway so subsequent tests in the suite see defaults again.
      configureGateway({ env: { ...process.env } });
    }
  }, 60000);

  test('large-dim init (>2000) templates the column without HNSW (Voyage 4 Large case)', async () => {
    // Codex finding #8: dims > 2000 cannot be HNSW-indexed in pgvector.
    // The schema templating path must skip the HNSW CREATE INDEX while
    // still creating the underlying `vector(N)` column.
    const { configureGateway } = await import('../../src/core/ai/gateway.ts');
    configureGateway({
      embedding_model: 'voyage:voyage-4-large',
      embedding_dimensions: 2048,
      env: { ...process.env },
    });

    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      // initSchema must NOT crash even though the HNSW index would otherwise
      // refuse a 2048-d vector column.
      await engine.initSchema();
      const dim = await readContentChunksEmbeddingDim(engine);
      expect(dim.exists).toBe(true);
      expect(dim.dims).toBe(2048);

      // Confirm the HNSW index was correctly skipped.
      const idx = await engine.executeRaw<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public'
             AND tablename = 'content_chunks'
             AND indexname = 'idx_chunks_embedding'
         ) AS exists`,
      );
      expect(idx[0]?.exists).toBe(false);
    } finally {
      await engine.disconnect();
      configureGateway({ env: { ...process.env } });
    }
  }, 60000);
});

describe('v0.28.5 A4 — existing-brain dim mismatch loud failure', () => {
  test('readContentChunksEmbeddingDim correctly identifies a brain at 1536 + mismatch message inlines all four steps', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      // Default initSchema with no gateway override → 1536.
      await engine.initSchema();
      const existing = await readContentChunksEmbeddingDim(engine);
      expect(existing.exists).toBe(true);
      expect(existing.dims).toBe(1536);

      // Simulate the user passing --embedding-dimensions 768 against this
      // existing 1536 brain. Build the mismatch message that init would
      // print to stderr before exiting 1.
      const msg = embeddingMismatchMessage({
        currentDims: existing.dims!,
        requestedDims: 768,
        requestedModel: 'ollama:nomic-embed-text',
        source: 'init',
      });

      // Codex finding #8: the recipe MUST inline the four steps including
      // a conditional reindex. 768 is HNSW-eligible, so the recipe should
      // include the HNSW CREATE INDEX line.
      expect(msg).toContain('vector(1536)');
      expect(msg).toContain('vector(768)');
      expect(msg).toContain('DROP INDEX IF EXISTS idx_chunks_embedding');
      expect(msg).toContain('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(768)');
      expect(msg).toContain('UPDATE content_chunks SET embedding = NULL');
      expect(msg).toContain('USING hnsw'); // HNSW reindex line for dims <= 2000
      expect(msg).toContain('docs/embedding-migrations.md');
      expect(msg).toContain('gbrain config set embedding_dimensions 768');
      expect(msg).toContain('gbrain embed --stale');
    } finally {
      await engine.disconnect();
    }
  }, 60000);

  test('mismatch message for dims > 2000 explicitly skips the HNSW reindex (codex finding #8)', () => {
    // The exact case the user pasting a recipe would otherwise crash on:
    // CREATE INDEX HNSW on a 2048-d vector column is rejected by pgvector.
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 2048,
      requestedModel: 'voyage:voyage-4-large',
      source: 'doctor',
    });

    expect(msg).toContain('vector(2048)');
    expect(msg).toContain('Skip reindex');
    expect(msg).toContain("exceeds pgvector's HNSW cap");
    // The HNSW CREATE INDEX line must NOT appear in the 2048-d recipe —
    // a user pasting it would crash trying to recreate the index.
    expect(msg).not.toMatch(/CREATE INDEX[^\n]*idx_chunks_embedding[^\n]*USING hnsw/);
  });
});
