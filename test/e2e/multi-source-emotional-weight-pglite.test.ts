/**
 * v0.29 E2E — multi-source UPDATE safety (codex C4#3).
 *
 * pages.slug is unique only within a source_id. A slug-only UPDATE would
 * fan out across sources and corrupt other sources' rows. This test seeds
 * pages with the SAME slug under two different source_ids, runs
 * setEmotionalWeightBatch for one of them, and asserts the other source's
 * row is untouched.
 *
 * Regression guard: if a future maintainer drops the source_id from the
 * UPDATE WHERE clause, this test fires.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  // Register a second source so we can put pages with the same slug
  // across two source_ids. (default source is auto-seeded on schema init.)
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('src-b', 'Test Source B')`
  );
  // Same slug under both sources.
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('default', 'shared/page', 'note', 'Default copy', 'A')`
  );
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('src-b', 'shared/page', 'note', 'src-b copy', 'B')`
  );
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.29 E2E — setEmotionalWeightBatch is multi-source safe', () => {
  test('UPDATE on (slug=shared, source_id=default) leaves src-b untouched', async () => {
    const updated = await engine.setEmotionalWeightBatch([
      { slug: 'shared/page', source_id: 'default', weight: 0.42 },
    ]);
    expect(updated).toBe(1); // exactly one row touched

    // Verify both rows independently.
    const defRow = await engine.executeRaw<{ slug: string; source_id: string; emotional_weight: number }>(
      `SELECT slug, source_id, emotional_weight FROM pages
        WHERE slug = 'shared/page' AND source_id = 'default'`
    );
    const srcBRow = await engine.executeRaw<{ slug: string; source_id: string; emotional_weight: number }>(
      `SELECT slug, source_id, emotional_weight FROM pages
        WHERE slug = 'shared/page' AND source_id = 'src-b'`
    );
    expect(defRow.length).toBe(1);
    expect(srcBRow.length).toBe(1);
    expect(Number(defRow[0].emotional_weight)).toBeCloseTo(0.42, 5);
    // src-b row stays at default 0.0.
    expect(Number(srcBRow[0].emotional_weight)).toBe(0);
  });

  test('two updates in one batch hit the right sources', async () => {
    const updated = await engine.setEmotionalWeightBatch([
      { slug: 'shared/page', source_id: 'default', weight: 0.10 },
      { slug: 'shared/page', source_id: 'src-b',    weight: 0.20 },
    ]);
    expect(updated).toBe(2);
    const rows = await engine.executeRaw<{ source_id: string; emotional_weight: number }>(
      `SELECT source_id, emotional_weight FROM pages WHERE slug = 'shared/page' ORDER BY source_id`
    );
    expect(rows.length).toBe(2);
    const byid = Object.fromEntries(rows.map(r => [r.source_id, Number(r.emotional_weight)]));
    expect(byid.default).toBeCloseTo(0.10, 5);
    expect(byid['src-b']).toBeCloseTo(0.20, 5);
  });

  test('non-existent (slug, source_id) tuple is silently skipped (no error)', async () => {
    const updated = await engine.setEmotionalWeightBatch([
      { slug: 'shared/page',   source_id: 'default',   weight: 0.50 },  // exists
      { slug: 'nope/missing',  source_id: 'default',   weight: 0.99 },  // doesn't exist
      { slug: 'shared/page',   source_id: 'src-zzz',   weight: 0.99 },  // wrong source_id
    ]);
    // Only the existing tuple is updated.
    expect(updated).toBe(1);
  });

  test('empty batch returns 0', async () => {
    const updated = await engine.setEmotionalWeightBatch([]);
    expect(updated).toBe(0);
  });
});
