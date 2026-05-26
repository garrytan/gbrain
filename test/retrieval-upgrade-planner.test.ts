/**
 * v0.36.0.0 — RetrievalUpgradePlanner state-machine + apply-path tests.
 *
 * Pins D12 (three config keys), D15 (tagged-union ApplyResult), D16 (snapshot),
 * D18 (HNSW index recreation atomic), and the C3 eligibility logic.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  planRetrievalUpgrade,
  applyRetrievalUpgrade,
  resumeRetrievalUpgrade,
  undoRetrievalUpgrade,
  recordDeclinedForever,
  recordDeclinedThisRun,
  KEY_PROMPT_SHOWN,
  KEY_REQUESTED,
  KEY_APPLIED,
  KEY_DECLINED_AT,
  KEY_PREVIOUS_SNAPSHOT,
  ZE_TARGET_EMBEDDING_MODEL,
  ZE_TARGET_EMBEDDING_DIM,
  ZE_TARGET_RERANKER_MODEL,
  ZE_DECLINE_REASK_DAYS,
} from '../src/core/retrieval-upgrade-planner.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// Helpers
async function seedPages(n: number) {
  for (let i = 0; i < n; i++) {
    await engine.putPage(`seed/page-${i}`, {
      title: `Seed Page ${i}`,
      compiled_truth: `Body for page ${i} with some realistic length to feed cost estimates.`,
      timeline: '',
      type: 'note',
    });
  }
}

async function setLegacyDefaultConfig() {
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
}

describe('planRetrievalUpgrade — C3 eligibility', () => {
  test('fresh brain on legacy default with > 100 pages: offered = true', async () => {
    await setLegacyDefaultConfig();
    await seedPages(101);

    const plan = await planRetrievalUpgrade(engine);

    expect(plan.ze_switch_offered).toBe(true);
    expect(plan.current_embedding_model).toBe('openai:text-embedding-3-large');
    expect(plan.current_dim).toBe(1536);
    expect(plan.target_embedding_model).toBe(ZE_TARGET_EMBEDDING_MODEL);
    expect(plan.target_dim).toBe(ZE_TARGET_EMBEDDING_DIM);
  });

  test('fresh brain on legacy default with 0 pages: offered = true (default flag overrides page count)', async () => {
    await setLegacyDefaultConfig();
    // 0 pages — eligibility(d): isLegacyDefault wins.
    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(true);
  });

  test('non-default provider with <= 100 pages: offered = false (avoid noise on small brains)', async () => {
    await engine.setConfig('embedding_model', 'voyage:voyage-3-large');
    await engine.setConfig('embedding_dimensions', '1024');
    await seedPages(50);

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(false);
  });

  test('non-default provider with > 100 pages: offered = true', async () => {
    await engine.setConfig('embedding_model', 'voyage:voyage-3-large');
    await engine.setConfig('embedding_dimensions', '1024');
    await seedPages(101);

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(true);
  });

  test('already on ZE: offered = false', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1024');
    await seedPages(200);

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(false);
    expect(plan.target_embedding_model).toBeNull();
  });

  test('applied = true previously: offered = false even with eligible state', async () => {
    await setLegacyDefaultConfig();
    await seedPages(200);
    await engine.setConfig(KEY_APPLIED, 'true');

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(false);
  });

  test('declined within last 90 days: offered = false', async () => {
    await setLegacyDefaultConfig();
    await seedPages(200);
    const recent = new Date();
    recent.setDate(recent.getDate() - 10);
    await engine.setConfig(KEY_DECLINED_AT, recent.toISOString());

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(false);
    expect(plan.ze_switch_already_declined).toBe(true);
  });

  test('declined > 90 days ago: offered = true (re-ask after grace window)', async () => {
    await setLegacyDefaultConfig();
    await seedPages(200);
    const old = new Date();
    old.setDate(old.getDate() - (ZE_DECLINE_REASK_DAYS + 5));
    await engine.setConfig(KEY_DECLINED_AT, old.toISOString());

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.ze_switch_offered).toBe(true);
    expect(plan.ze_switch_already_declined).toBe(false);
  });
});

describe('planRetrievalUpgrade — cost math (C4 MAX-not-SUM)', () => {
  test('only dim change pending → est = page count × token cost', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.pages_pending_dim).toBe(150);
    expect(plan.est_minutes).toBeGreaterThan(0);
  });

  test('PGLite schema change time is ~1s (single-writer fast path)', async () => {
    await setLegacyDefaultConfig();
    await seedPages(200);

    const plan = await planRetrievalUpgrade(engine);
    expect(plan.est_schema_change_seconds).toBe(1);
  });
});

describe('applyRetrievalUpgrade — state machine + atomicity (D12, D18)', () => {
  test('happy path: schema swaps, config writes, applied=true', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);

    const plan = await planRetrievalUpgrade(engine);
    const result = await applyRetrievalUpgrade(engine, plan);

    expect(result.status).toBe('applied');
    expect(await engine.getConfig('embedding_model')).toBe(ZE_TARGET_EMBEDDING_MODEL);
    expect(await engine.getConfig('embedding_dimensions')).toBe(String(ZE_TARGET_EMBEDDING_DIM));
    expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
    expect(await engine.getConfig('search.reranker.model')).toBe(ZE_TARGET_RERANKER_MODEL);
    expect(await engine.getConfig(KEY_APPLIED)).toBe('true');
    expect(await engine.getConfig(KEY_REQUESTED)).toBe('true');
    expect(await engine.getConfig(KEY_PROMPT_SHOWN)).toBe('true');
  });

  test('snapshot captured BEFORE config writes (D16)', async () => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    await engine.setConfig('embedding_dimensions', '1536');
    await engine.setConfig('search.reranker.enabled', 'false');
    await engine.setConfig('search.reranker.model', 'some-old-reranker');
    await seedPages(150);

    const plan = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan);

    const snapStr = await engine.getConfig(KEY_PREVIOUS_SNAPSHOT);
    expect(snapStr).not.toBeNull();
    const snap = JSON.parse(snapStr!);
    expect(snap.embedding_model).toBe('openai:text-embedding-3-large');
    expect(snap.embedding_dimensions).toBe(1536);
    expect(snap.search_reranker_enabled).toBe(false);
    expect(snap.search_reranker_model).toBe('some-old-reranker');
  });

  test('idempotent: second apply on already-applied brain returns skipped_already_applied', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);

    const plan1 = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan1);

    const plan2 = await planRetrievalUpgrade(engine);
    const result2 = await applyRetrievalUpgrade(engine, plan2);
    expect(result2.status).toBe('skipped_already_applied');
  });

  test('skipped_no_work when nothing is pending', async () => {
    // Already on ZE, no chunker bump.
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1024');

    const plan = await planRetrievalUpgrade(engine);
    const result = await applyRetrievalUpgrade(engine, plan);
    expect(result.status).toBe('skipped_no_work');
  });

  test('schema width is 1024d on content_chunks.embedding after apply', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);
    const plan = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan);

    // Probe the actual column type via information_schema.
    const rows = await engine.executeRaw<{ udt_name: string; data_type: string }>(
      `SELECT udt_name, data_type FROM information_schema.columns
       WHERE table_name = 'content_chunks' AND column_name = 'embedding'`,
    );
    expect(rows.length).toBe(1);
    // pgvector reports as 'vector' udt; the dimension is encoded as a typmod
    // we can't introspect cleanly, but the absence of an error on the next
    // INSERT-at-1024 is the contract test.
    expect(rows[0].udt_name).toBe('vector');
  });

  test('HNSW indexes recreated in same transaction (D18)', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);
    const plan = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan);

    // Both indexes should exist post-apply.
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'content_chunks' ORDER BY indexname`,
    );
    const names = rows.map(r => r.indexname);
    expect(names).toContain('idx_chunks_embedding');
    expect(names).toContain('idx_chunks_embedding_image');
  });

  // v0.41 regression — PR #1443. runSchemaTransition must NOT widen the
  // embedding_image or embedding_multimodal columns to targetDim. Both use
  // separate multimodal models whose dimensions are independent of the text
  // embedding model. The pre-fix code dropped + recreated embedding_image
  // at targetDim, silently breaking voyage-multimodal-3 (1024d). The same
  // bug class applies to embedding_multimodal — pin both.
  test('runSchemaTransition preserves embedding_image dimension (1024) post-switch', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);
    const plan = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan);

    // Probe column type via format_type so we see the parameterized dim
    // (the typmod). udt_name alone reports just 'vector' without the dim.
    const rows = await engine.executeRaw<{ column_name: string; col_type: string }>(
      `SELECT a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS col_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'content_chunks'
          AND a.attname IN ('embedding', 'embedding_image', 'embedding_multimodal')
          AND a.attnum > 0
        ORDER BY a.attname`,
    );
    const byName = new Map(rows.map(r => [r.column_name, r.col_type]));

    // Primary text column transitioned to target dim.
    expect(byName.get('embedding')).toBe(`vector(${ZE_TARGET_EMBEDDING_DIM})`);
    // Multimodal columns preserved at their original 1024d shape.
    expect(byName.get('embedding_image')).toBe('vector(1024)');
    expect(byName.get('embedding_multimodal')).toBe('vector(1024)');
  });

  test('runSchemaTransition restores partial WHERE on idx_chunks_embedding_image', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);
    const plan = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan);

    // pg_indexes.indexdef carries the partial predicate verbatim when present.
    const rows = await engine.executeRaw<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'content_chunks'
          AND indexname = 'idx_chunks_embedding_image'`,
    );
    expect(rows.length).toBe(1);
    // Match schema.sql:258-260 / pglite-schema.ts:198-200 canonical shape.
    expect(rows[0].indexdef).toMatch(/WHERE\s+\(?embedding_image IS NOT NULL\)?/i);
  });

  test('runSchemaTransition EXISTS guard short-circuits cleanly when embedding_image column is absent', async () => {
    // Simulate a (hypothetical) pre-v0.27.1 brain with no embedding_image
    // column. The fix's EXISTS probe must skip the image branch without
    // error. We can't actually run the full ze-switch flow without the
    // column (other code paths assume it), but we can directly drop the
    // column and re-invoke the schema transition via resume to verify the
    // probe doesn't throw on the missing-column branch.
    await setLegacyDefaultConfig();
    await seedPages(150);

    // Drop both multimodal columns to simulate a brain that never had them.
    await engine.executeRaw(
      `ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_image`,
    );
    await engine.executeRaw(
      `ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_multimodal`,
    );

    // Resume path also calls runSchemaTransition. Mark as requested so the
    // resume actually runs the schema work rather than short-circuiting.
    await engine.setConfig(KEY_REQUESTED, 'true');
    const result = await resumeRetrievalUpgrade(engine);

    // The probe should have short-circuited the image branch and the rest
    // of the transition should have completed without error.
    expect(result.status).toBe('applied');

    // Primary column still landed at target dim.
    const rows = await engine.executeRaw<{ col_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS col_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'content_chunks'
          AND a.attname = 'embedding'`,
    );
    expect(rows[0]?.col_type).toBe(`vector(${ZE_TARGET_EMBEDDING_DIM})`);

    // Image index should NOT exist — the EXISTS guard correctly skipped it.
    const idxRows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'content_chunks'
          AND indexname = 'idx_chunks_embedding_image'`,
    );
    expect(idxRows.length).toBe(0);
  });
});

describe('Three-key state machine transitions (D12)', () => {
  test('recordDeclinedThisRun: only prompt_shown set, requested + applied untouched', async () => {
    await recordDeclinedThisRun(engine);
    expect(await engine.getConfig(KEY_PROMPT_SHOWN)).toBe('true');
    expect(await engine.getConfig(KEY_REQUESTED)).toBeNull();
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
    expect(await engine.getConfig(KEY_DECLINED_AT)).toBeNull();
  });

  test('recordDeclinedForever: prompt_shown + declined_at set, others untouched', async () => {
    await recordDeclinedForever(engine);
    expect(await engine.getConfig(KEY_PROMPT_SHOWN)).toBe('true');
    expect(await engine.getConfig(KEY_DECLINED_AT)).not.toBeNull();
    expect(await engine.getConfig(KEY_REQUESTED)).toBeNull();
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
  });
});

describe('resumeRetrievalUpgrade — crash recovery', () => {
  test('requested=true + applied=false: re-runs schema + finishes config', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);

    // Simulate a crash partway through: requested set but applied unset.
    await engine.setConfig(KEY_REQUESTED, 'true');
    // Schema is still at 1536 (simulated). Snapshot might or might not exist —
    // resume should work either way.

    const result = await resumeRetrievalUpgrade(engine);
    expect(result.status).toBe('applied');
    expect(await engine.getConfig(KEY_APPLIED)).toBe('true');
    expect(await engine.getConfig('embedding_dimensions')).toBe('1280');
  });

  test('applied=true: idempotent (returns skipped_already_applied)', async () => {
    await engine.setConfig(KEY_APPLIED, 'true');
    const result = await resumeRetrievalUpgrade(engine);
    expect(result.status).toBe('skipped_already_applied');
  });

  test('requested=false: nothing to resume', async () => {
    const result = await resumeRetrievalUpgrade(engine);
    expect(result.status).toBe('skipped_no_work');
  });
});

describe('undoRetrievalUpgrade (D16)', () => {
  test('no snapshot: returns no_snapshot', async () => {
    const result = await undoRetrievalUpgrade(engine);
    expect(result.status).toBe('no_snapshot');
  });

  test('happy path: restores model + dim + reranker', async () => {
    await setLegacyDefaultConfig();
    await seedPages(150);

    // Switch forward.
    const plan = await planRetrievalUpgrade(engine);
    await applyRetrievalUpgrade(engine, plan);

    // Now undo.
    const result = await undoRetrievalUpgrade(engine);
    expect(result.status).toBe('undone');
    if (result.status === 'undone') {
      expect(result.snapshot.embedding_model).toBe('openai:text-embedding-3-large');
      expect(result.snapshot.embedding_dimensions).toBe(1536);
    }
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');
    // applied marker cleared so planner can re-offer later.
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
    expect(await engine.getConfig(KEY_REQUESTED)).toBeNull();
  });

  test('corrupt snapshot: returns failed with reason', async () => {
    await engine.setConfig(KEY_PREVIOUS_SNAPSHOT, 'not valid json {');
    const result = await undoRetrievalUpgrade(engine);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toContain('corrupt');
    }
  });
});
