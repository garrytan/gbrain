/**
 * v0.31 Phase 6 — dream-cycle `consolidate` phase tests.
 *
 * Pins:
 *   - Below-threshold buckets are skipped (count < 3 OR oldest < 24h)
 *   - Cluster of >=2 same-vector facts produces 1 take, marks all facts consolidated
 *   - Never DELETE — facts stay as audit trail
 *   - dryRun honored
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';

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
  // Clean facts + takes between tests for hermetic state.
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM takes`);
});

const oldDate = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
const recentDate = () => new Date(Date.now() - 60 * 1000).toISOString();
function unitVec(): string {
  const a = new Float32Array(1536);
  a[0] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

async function seedPage(slug: string): Promise<number> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title) VALUES ($1, 'concept', 'Test') ON CONFLICT DO NOTHING`,
    [slug],
  );
  const r = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return r[0].id;
}

describe('runPhaseConsolidate', () => {
  test('below threshold (count < 3) → skipped', async () => {
    await seedPage('cons-skip-count');
    for (let i = 0; i < 2; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-skip-count', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.takes_written).toBe(0);
  });

  test('all facts too recent → bucket processed but skipped, 0 work', async () => {
    await seedPage('cons-skip-age');
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-skip-age', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`fact ${i}`, recentDate(), unitVec()],
      );
    }
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.buckets_skipped).toBeGreaterThanOrEqual(1);
  });

  test('happy path: 4 same-vector facts on a page → 1 take, all consolidated', async () => {
    const pageId = await seedPage('people/alice-example');
    expect(pageId).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at)
         VALUES ('default', 'people/alice-example', $1, 'fact', 'test', $2::timestamptz, 0.9, $3::vector, $2::timestamptz)`,
        [`alice fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runPhaseConsolidate(engine, {});
    expect(r.details.facts_consolidated).toBe(4);
    expect(r.details.takes_written).toBe(1);

    // Take row created on the right page.
    const takes = await engine.executeRaw<{ page_id: number; kind: string; weight: number; holder: string }>(
      `SELECT page_id, kind, weight, holder FROM takes`,
    );
    expect(takes.length).toBe(1);
    expect(takes[0].page_id).toBe(pageId);
    expect(takes[0].kind).toBe('fact');
    expect(takes[0].holder).toBe('self');
    expect(takes[0].weight).toBeCloseTo(0.9, 2);

    // Facts marked consolidated, NEVER deleted.
    const facts = await engine.executeRaw<{ id: number; consolidated_at: Date | null; consolidated_into: number | null }>(
      `SELECT id, consolidated_at, consolidated_into FROM facts ORDER BY id`,
    );
    expect(facts.length).toBe(4);
    for (const f of facts) {
      expect(f.consolidated_at).not.toBeNull();
      expect(f.consolidated_into).not.toBeNull();
    }
  });

  test('dryRun honored: counters tick but no rows written', async () => {
    await seedPage('cons-dryrun');
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-dryrun', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`dryrun fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runPhaseConsolidate(engine, { dryRun: true });
    expect(r.details.dryRun).toBe(true);
    expect(r.details.facts_consolidated).toBe(3);
    expect(r.details.takes_written).toBe(1);
    const takes = await engine.executeRaw<{ id: number }>(`SELECT id FROM takes`);
    expect(takes.length).toBe(0);
    const facts = await engine.executeRaw<{ id: number; consolidated_at: Date | null }>(
      `SELECT id, consolidated_at FROM facts ORDER BY id`,
    );
    for (const f of facts) {
      expect(f.consolidated_at).toBeNull();
    }
  });

  test('skips bucket when no matching page exists in source', async () => {
    // Don't seed a page — entity_slug 'no-page' won't resolve.
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'no-page', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`orphan fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runPhaseConsolidate(engine, {});
    // Bucket processed (passes count + age gates) but cluster skipped (no page).
    expect(r.details.buckets_processed).toBeGreaterThanOrEqual(1);
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.takes_written).toBe(0);
  });
});
