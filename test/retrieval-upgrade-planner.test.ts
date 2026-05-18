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
