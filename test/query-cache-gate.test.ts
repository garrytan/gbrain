/**
 * v0.40.3.0 — query-cache-gate.ts (cache invalidation gate)
 *
 * Pure unit tests for the two helpers. Both helpers are pure functions
 * (the validator) or take an engine argument (the snapshot builder); the
 * latter uses a PGLite engine to test the real SQL fragment.
 *
 * Coverage:
 *   - buildPageGenerationsSnapshot: empty pageIds, populated pageIds,
 *     bookmark capture, missing pages excluded (LEFT JOIN equivalent).
 *   - validateCacheRowAgainstPages: vacuously valid for legacy/empty,
 *     bookmark short-circuit, single-page bump invalidates, deleted page
 *     invalidates, multi-page partial bump invalidates, integer-JSONB
 *     shape regression (string-typed values).
 *   - CACHE_GATE_WHERE_CLAUSE: source-text shape regression (grep guards).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  buildPageGenerationsSnapshot,
  validateCacheRowAgainstPages,
  CACHE_GATE_WHERE_CLAUSE,
  type PageGenerationsSnapshot,
} from '../src/core/search/query-cache-gate.ts';

describe('validateCacheRowAgainstPages (pure validator)', () => {
  test('vacuously valid for legacy empty snapshot (regression: pre-v0.40.3.0 rows must serve)', () => {
    const snapshot: PageGenerationsSnapshot = {
      page_generations: {},
      max_generation_at_store: 0,
    };
    // Legacy row: stored when brain had MAX(generation)=0 (or column didn't exist).
    // Current brain has been heavily written. Bookmark says stale, snapshot is empty.
    const ok = validateCacheRowAgainstPages(snapshot, {
      max_generation: 999,
      page_generations: {},
    });
    expect(ok).toBe(true); // IRON-RULE: legacy rows serve.
  });

  test('bookmark short-circuit: MAX <= stored → valid without per-page work', () => {
    const snapshot: PageGenerationsSnapshot = {
      page_generations: { '1': 5, '2': 7 },
      max_generation_at_store: 10,
    };
    const ok = validateCacheRowAgainstPages(snapshot, {
      max_generation: 10, // No writes since store
      page_generations: { '1': 5, '2': 7 },
    });
    expect(ok).toBe(true);
  });

  test('single-page bumped invalidates', () => {
    const snapshot: PageGenerationsSnapshot = {
      page_generations: { '1': 5, '2': 7 },
      max_generation_at_store: 7,
    };
    const ok = validateCacheRowAgainstPages(snapshot, {
      max_generation: 8, // Bookmark fires
      page_generations: { '1': 5, '2': 8 }, // Page 2 bumped
    });
    expect(ok).toBe(false);
  });

  test('deleted page invalidates', () => {
    const snapshot: PageGenerationsSnapshot = {
      page_generations: { '1': 5, '2': 7 },
      max_generation_at_store: 7,
    };
    const ok = validateCacheRowAgainstPages(snapshot, {
      max_generation: 8,
      page_generations: { '1': 5, '2': undefined }, // Page 2 deleted
    });
    expect(ok).toBe(false);
  });

  test('multi-page partial bump invalidates', () => {
    const snapshot: PageGenerationsSnapshot = {
      page_generations: { '1': 5, '2': 7, '3': 9 },
      max_generation_at_store: 9,
    };
    const ok = validateCacheRowAgainstPages(snapshot, {
      max_generation: 10,
      page_generations: { '1': 5, '2': 7, '3': 10 }, // Only page 3 bumped
    });
    expect(ok).toBe(false);
  });

  test('codex D11 critical case: new page after store time → bookmark fires → empty snapshot is vacuously valid', () => {
    // Subtle: a brand-new page makes MAX increase but the cache row's
    // page_generations snapshot doesn't reference it. The bookmark
    // detects the corpus changed. Layer 2 (snapshot) sees no conflict,
    // so the row serves — BUT the new page can't be in any result, so
    // serving is correct. Closes codex #4 INSERT coverage gap.
    const snapshot: PageGenerationsSnapshot = {
      page_generations: { '1': 5, '2': 7 },
      max_generation_at_store: 7,
    };
    const ok = validateCacheRowAgainstPages(snapshot, {
      max_generation: 8, // Page 3 was created
      page_generations: { '1': 5, '2': 7 }, // Pages in snapshot unchanged
    });
    // Per the design: bookmark fires; Layer 2 confirms snapshot intact;
    // row serves. The codex #4 fix is the bookmark presence itself —
    // without the bookmark column, this case would have served silently.
    expect(ok).toBe(true);
  });
});

describe('buildPageGenerationsSnapshot (PGLite-backed)', () => {
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

  test('empty pageIds: snapshot has empty page_generations, MAX bookmark only', async () => {
    // Seed a page so MAX > 0.
    await engine.putPage('test/p1', {
      type: 'note',
      title: 'p1',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
    });
    const snap = await buildPageGenerationsSnapshot(engine, []);
    expect(snap.page_generations).toEqual({});
    expect(snap.max_generation_at_store).toBeGreaterThan(0);
  });

  test('populated pageIds: snapshot captures generation per page + MAX', async () => {
    const p1 = await engine.putPage('test/p1', {
      type: 'note',
      title: 'p1',
      compiled_truth: 'body1',
      timeline: '',
      frontmatter: {},
    });
    const p2 = await engine.putPage('test/p2', {
      type: 'note',
      title: 'p2',
      compiled_truth: 'body2',
      timeline: '',
      frontmatter: {},
    });
    const snap = await buildPageGenerationsSnapshot(engine, [p1.id, p2.id]);
    expect(Object.keys(snap.page_generations).length).toBe(2);
    expect(snap.page_generations[String(p1.id)]).toBeGreaterThan(0);
    expect(snap.page_generations[String(p2.id)]).toBeGreaterThan(0);
    expect(snap.max_generation_at_store).toBeGreaterThanOrEqual(
      Math.max(snap.page_generations[String(p1.id)], snap.page_generations[String(p2.id)]),
    );
  });

  test('integer-typed JSONB shape regression: stored values are numbers, not strings', async () => {
    const p1 = await engine.putPage('test/p1', {
      type: 'note',
      title: 'p1',
      compiled_truth: 'body1',
      timeline: '',
      frontmatter: {},
    });
    const snap = await buildPageGenerationsSnapshot(engine, [p1.id]);
    const v = snap.page_generations[String(p1.id)];
    expect(typeof v).toBe('number');
    expect(Number.isInteger(v)).toBe(true);
  });

  test('non-existent pageIds: skipped (LEFT JOIN equivalent — no entry in page_generations)', async () => {
    await engine.putPage('test/p1', {
      type: 'note',
      title: 'p1',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
    });
    // Pass two IDs: one valid, one that doesn't exist.
    const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages LIMIT 1`);
    const p1Id = rows[0].id;
    const snap = await buildPageGenerationsSnapshot(engine, [p1Id, 999999]);
    expect(snap.page_generations[String(p1Id)]).toBeGreaterThan(0);
    expect(snap.page_generations['999999']).toBeUndefined();
  });

  test('after content UPDATE: generation bumps and snapshot reflects new value', async () => {
    const p1 = await engine.putPage('test/p1', {
      type: 'note',
      title: 'p1',
      compiled_truth: 'body-v1',
      timeline: '',
      frontmatter: {},
    });
    const before = await buildPageGenerationsSnapshot(engine, [p1.id]);
    const beforeGen = before.page_generations[String(p1.id)];

    // Update compiled_truth (content allow-list column → trigger bumps).
    await engine.putPage('test/p1', {
      type: 'note',
      title: 'p1',
      compiled_truth: 'body-v2',
      timeline: '',
      frontmatter: {},
    });

    const after = await buildPageGenerationsSnapshot(engine, [p1.id]);
    const afterGen = after.page_generations[String(p1.id)];
    expect(afterGen).toBeGreaterThan(beforeGen);
  });
});

describe('CACHE_GATE_WHERE_CLAUSE (SQL shape regression)', () => {
  test('contains Layer 1 bookmark check (MAX(generation) <= qc.max_generation_at_store)', () => {
    expect(CACHE_GATE_WHERE_CLAUSE).toContain('MAX(generation)');
    expect(CACHE_GATE_WHERE_CLAUSE).toContain('qc.max_generation_at_store');
  });

  test('contains Layer 2 per-page snapshot (jsonb_each + LEFT JOIN)', () => {
    expect(CACHE_GATE_WHERE_CLAUSE).toContain('jsonb_each(qc.page_generations)');
    expect(CACHE_GATE_WHERE_CLAUSE).toContain('LEFT JOIN pages');
  });

  test('legacy empty-snapshot shortcut present (regression: pre-v0.40.3.0 rows must serve)', () => {
    expect(CACHE_GATE_WHERE_CLAUSE).toContain(`qc.page_generations = '{}'::jsonb`);
  });

  test('per-page mismatch path checks both deletion (NULL) and bump (!=)', () => {
    expect(CACHE_GATE_WHERE_CLAUSE).toContain('p.id IS NULL');
    expect(CACHE_GATE_WHERE_CLAUSE).toContain('p.generation <>');
  });
});
