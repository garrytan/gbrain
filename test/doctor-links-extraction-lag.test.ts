/**
 * Tests for the `links_extraction_lag` doctor check (v0.42.7, #1696).
 * Hermetic PGLite. Bulk-seeds pages via raw SQL (the check only does COUNT +
 * countStalePagesForExtraction — no real ingestion needed).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Bulk-insert N pages under a source; all start with links_extracted_at NULL. */
async function seedPages(n: number, sourceId = 'default', prefix = 'p'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
     SELECT $1 || '/' || g, $2, 'concept', 'T' || g, '', '', '{}'::jsonb, $1 || 'h' || g, now(), now()
       FROM generate_series(1, $3) g`,
    [prefix, sourceId, n],
  );
}

describe('links_extraction_lag doctor check', () => {
  test('no pages → ok (not applicable)', async () => {
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('no pages');
  });

  test('<100 pages, no --source → ok (vacuous-skip)', async () => {
    await seedPages(50);
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('too few');
  });

  test('>100 pages, all un-extracted → warn (>20%)', async () => {
    await seedPages(120);
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('un-extracted edges');
    expect(c.message).toContain('gbrain extract --stale');
    expect((c.details as any).pct).toBe(100);
  });

  test('>100 pages, all stamped fresh → ok', async () => {
    await seedPages(120);
    await engine.executeRaw(`UPDATE pages SET links_extracted_at = now()`);
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Extraction current');
  });

  test('warn-only by default: 100% stale does NOT fail without fail-pct', async () => {
    await seedPages(120);
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('warn'); // never 'fail' by default
  });

  test('GBRAIN_EXTRACTION_LAG_FAIL_PCT opts into hard fail', async () => {
    await seedPages(120);
    await withEnv({ GBRAIN_EXTRACTION_LAG_FAIL_PCT: '50' }, async () => {
      const c = await checkLinksExtractionLag(engine);
      expect(c.status).toBe('fail');
      expect(c.message).toContain('fail threshold');
    });
  });

  test('GBRAIN_EXTRACTION_LAG_WARN_PCT raises the warn bar', async () => {
    // 10 of 120 stale = ~8%. Default warn 20% → ok. Lower to 5% → warn.
    await seedPages(120);
    await engine.executeRaw(`UPDATE pages SET links_extracted_at = now() WHERE slug NOT IN (SELECT slug FROM pages ORDER BY id LIMIT 10)`);
    const ok = await checkLinksExtractionLag(engine);
    expect(ok.status).toBe('ok');
    await withEnv({ GBRAIN_EXTRACTION_LAG_WARN_PCT: '5' }, async () => {
      const warn = await checkLinksExtractionLag(engine);
      expect(warn.status).toBe('warn');
    });
  });

  test('--source scope: small source IS assessed (no vacuous-skip)', async () => {
    // 10 pages under source 'dept-x' — below the 100 floor, but explicit
    // --source means we assess it anyway (mirrors orphan_ratio).
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('dept-x', 'Dept X', '{}'::jsonb) ON CONFLICT DO NOTHING`);
    await seedPages(10, 'dept-x', 'dx');
    const c = await checkLinksExtractionLag(engine, { sourceId: 'dept-x' });
    expect(c.status).toBe('warn'); // all 10 stale, assessed despite < 100
    expect(c.message).toContain("source 'dept-x'");
  });

  test('pre-v112 brain (column missing) → ok (graceful)', async () => {
    await seedPages(120);
    // Simulate a pre-v112 brain by dropping the column.
    await engine.executeRaw(`ALTER TABLE pages DROP COLUMN links_extracted_at`);
    try {
      const c = await checkLinksExtractionLag(engine);
      expect(c.status).toBe('ok');
      expect(c.message).toContain('pre-v112');
    } finally {
      // Restore so resetPgliteState's TRUNCATE-only reset leaves a valid schema
      // for the next test (the column is re-added; data is wiped by beforeEach).
      await engine.executeRaw(`ALTER TABLE pages ADD COLUMN links_extracted_at TIMESTAMPTZ`);
    }
  });
});
