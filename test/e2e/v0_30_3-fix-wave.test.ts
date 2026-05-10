/**
 * E2E coverage for the v0.30.3 fix wave.
 *
 * Codex-mandated test gate C3 (from /codex review of v0.30.3 plan): pin
 * that brains rewound to pre-v39 (PGLite < 41) shapes upgrade cleanly
 * through the assembled wave. Three regression scenarios:
 *
 *   1. Pre-v39 brain (missing modality + embedding_image columns) survives
 *      `initSchema` because pr-741 added these columns to
 *      `applyForwardReferenceBootstrap`. Pre-#741, the schema replay
 *      crashed with `column "modality" does not exist`.
 *
 *   2. Pre-v40 brain (missing emotional_weight + effective_date +
 *      effective_date_source) survives `initSchema`. Pre-#741, replay
 *      crashed with `column "effective_date" does not exist`.
 *
 *   3. Pre-v41 PGLite brain (missing import_filename + salience_touched_at)
 *      survives `initSchema`. Pre-#741, replay crashed on the same
 *      `column "..." does not exist` class.
 *
 * Pattern follows test/e2e/v0_28_5-fix-wave.test.ts: spin up a fresh
 * LATEST brain, surgically drop the columns the bootstrap is supposed to
 * restore, reset config.version, then re-call initSchema and assert the
 * brain advances to LATEST_VERSION with no crash. PGLite-only.
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

describe('v0.30.3 wave — pre-v39/v40/v41 forward-reference bootstrap (#741)', () => {
  test('pre-v39 brain (missing modality + embedding_image) re-runs initSchema cleanly', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      // Rewind to a pre-v39 shape — drop columns the bootstrap claims to
      // restore (modality + embedding_image). v39 = multimodal_dual_column_v0_27_1.
      await db.exec(`
        DROP INDEX IF EXISTS idx_chunks_embedding_image;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_image CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS modality CASCADE;
        UPDATE config SET value = '38' WHERE key = 'version';
      `);

      // Re-run initSchema. Pre-#741 this crashed with
      // `column "modality" does not exist` during schema replay.
      await engine.initSchema();

      const versionRow = await db.query(`SELECT value FROM config WHERE key = 'version'`);
      expect(Number(versionRow.rows[0].value)).toBe(LATEST_VERSION);

      // Confirm the rewound columns are restored.
      const modality = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='content_chunks' AND column_name='modality'`,
      );
      expect(modality.rows.length).toBeGreaterThan(0);

      const embeddingImage = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='content_chunks' AND column_name='embedding_image'`,
      );
      expect(embeddingImage.rows.length).toBeGreaterThan(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('pre-v40 brain (missing emotional_weight + effective_date) re-runs initSchema cleanly', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      // Rewind to a pre-v40 shape — drop emotional_weight + effective_date +
      // effective_date_source. v40 = pages_emotional_weight + effective_date.
      await db.exec(`
        ALTER TABLE pages DROP COLUMN IF EXISTS emotional_weight CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS effective_date CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS effective_date_source CASCADE;
        UPDATE config SET value = '39' WHERE key = 'version';
      `);

      await engine.initSchema();

      const versionRow = await db.query(`SELECT value FROM config WHERE key = 'version'`);
      expect(Number(versionRow.rows[0].value)).toBe(LATEST_VERSION);

      const emotional = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='pages' AND column_name='emotional_weight'`,
      );
      expect(emotional.rows.length).toBeGreaterThan(0);

      const effective = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='pages' AND column_name='effective_date'`,
      );
      expect(effective.rows.length).toBeGreaterThan(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('pre-v41 PGLite brain (missing import_filename + salience_touched_at) re-runs initSchema cleanly', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      // Rewind to pre-v41 — drop import_filename + salience_touched_at.
      await db.exec(`
        ALTER TABLE pages DROP COLUMN IF EXISTS import_filename CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS salience_touched_at CASCADE;
        UPDATE config SET value = '40' WHERE key = 'version';
      `);

      await engine.initSchema();

      const versionRow = await db.query(`SELECT value FROM config WHERE key = 'version'`);
      expect(Number(versionRow.rows[0].value)).toBe(LATEST_VERSION);

      const importFn = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='pages' AND column_name='import_filename'`,
      );
      expect(importFn.rows.length).toBeGreaterThan(0);

      const salience = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='pages' AND column_name='salience_touched_at'`,
      );
      expect(salience.rows.length).toBeGreaterThan(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('pre-v34 brain (compounded v0.20 + v0.26.3 + v39-v41 wedge) walks forward cleanly', async () => {
    // The "user stuck on v0.20-era PGLite brain hitting v0.30.0" scenario:
    // multiple bootstrap forward-reference gaps compounded. This is the
    // headline upgrade-path claim in the v0.30.3 release notes.
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      await db.exec(`
        -- v0.20 surface (Cathedral II columns)
        DROP INDEX IF EXISTS idx_chunks_search_vector;
        DROP INDEX IF EXISTS idx_chunks_symbol_qualified;
        DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
        DROP FUNCTION IF EXISTS update_chunk_search_vector;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS parent_symbol_path CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS doc_comment CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS symbol_name_qualified CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS search_vector CASCADE;

        -- v0.26.3 surface
        DROP INDEX IF EXISTS idx_mcp_log_agent_time;
        ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS agent_name CASCADE;
        ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS params CASCADE;
        ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS error_message CASCADE;

        -- v0.27 surface
        DROP INDEX IF EXISTS idx_subagent_messages_provider;
        ALTER TABLE subagent_messages DROP COLUMN IF EXISTS provider_id CASCADE;

        -- v39-v41 surface (the wave's bootstrap fixes)
        DROP INDEX IF EXISTS idx_chunks_embedding_image;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_image CASCADE;
        ALTER TABLE content_chunks DROP COLUMN IF EXISTS modality CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS emotional_weight CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS effective_date CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS effective_date_source CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS import_filename CASCADE;
        ALTER TABLE pages DROP COLUMN IF EXISTS salience_touched_at CASCADE;

        UPDATE config SET value = '13' WHERE key = 'version';
      `);

      // Walk all the way forward from a deeply-rewound state.
      await engine.initSchema();

      const versionRow = await db.query(`SELECT value FROM config WHERE key = 'version'`);
      expect(Number(versionRow.rows[0].value)).toBe(LATEST_VERSION);
    } finally {
      await engine.disconnect();
    }
  });
});
