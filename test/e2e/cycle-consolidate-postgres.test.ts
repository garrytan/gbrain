/**
 * v0.31 E2E — dream-cycle `consolidate` phase against real Postgres.
 *
 * Mirrors test/cycle-consolidate.test.ts (PGLite) on Postgres so the
 * postgres-engine codepaths (sql.begin transaction, advisory locks,
 * unsafe('::vector') casts on insertFact / findCandidateDuplicates,
 * the addTakesBatch postgres-js unnest path) get exercised end-to-end
 * with the consolidate phase on top.
 *
 * Skips gracefully when DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { runPhaseConsolidate } from '../../src/core/cycle/phases/consolidate.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

const oldDate = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
function unitVec(): string {
  const a = new Float32Array(1536);
  a[0] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

d('cycle consolidate phase (Postgres)', () => {
  test('promotes 4 same-vector facts about an entity into 1 take, never DELETE', async () => {
    const engine = getEngine();
    // Seed a page so consolidate has somewhere to put the take.
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title) VALUES ('people/post-cons-alice', 'person', 'Alice')`,
    );
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'people/post-cons-alice'`,
    );
    const pageId = pageRows[0].id;

    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, confidence, valid_from, embedding, embedded_at)
         VALUES ('default', 'people/post-cons-alice', $1, 'fact', 'test', 0.9, $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`postgres consolidate fact ${i}`, oldDate(), unitVec()],
      );
    }

    const result = await runPhaseConsolidate(engine, {});
    expect(result.details.facts_consolidated).toBe(4);
    expect(result.details.takes_written).toBe(1);

    // Take row created, points at our page.
    const takes = await engine.executeRaw<{ page_id: number; kind: string; weight: number; holder: string }>(
      `SELECT page_id, kind, weight, holder FROM takes WHERE page_id = $1`,
      [pageId],
    );
    expect(takes.length).toBe(1);
    expect(takes[0].kind).toBe('fact');
    expect(takes[0].holder).toBe('self');
    expect(takes[0].weight).toBeCloseTo(0.9, 2);

    // All 4 facts marked consolidated, NEVER deleted.
    const facts = await engine.executeRaw<{
      id: number; consolidated_at: Date | null; consolidated_into: number | null;
    }>(
      `SELECT id, consolidated_at, consolidated_into FROM facts
       WHERE entity_slug = 'people/post-cons-alice' ORDER BY id`,
    );
    expect(facts.length).toBe(4);
    for (const f of facts) {
      expect(f.consolidated_at).not.toBeNull();
      expect(f.consolidated_into).not.toBeNull();
    }
  });

  test('skips bucket below the 24h age threshold', async () => {
    const engine = getEngine();
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title) VALUES ('cons-recent', 'concept', 'Recent') ON CONFLICT DO NOTHING`,
    );
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-recent', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`recent fact ${i}`, recent, unitVec()],
      );
    }
    const result = await runPhaseConsolidate(engine, {});
    // 'cons-recent' bucket should be skipped (oldest fact too young).
    const takes = await engine.executeRaw<{ id: number }>(
      `SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = 'cons-recent'`,
    );
    expect(takes.length).toBe(0);
    expect(result.details.buckets_skipped).toBeGreaterThanOrEqual(1);
  });

  test('dryRun does not write rows even when bucket is eligible', async () => {
    const engine = getEngine();
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title) VALUES ('cons-dryrun-pg', 'concept', 'Dry') ON CONFLICT DO NOTHING`,
    );
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-dryrun-pg', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`dryrun fact ${i}`, oldDate(), unitVec()],
      );
    }
    const before = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = 'cons-dryrun-pg'`,
    );
    const result = await runPhaseConsolidate(engine, { dryRun: true });
    expect(result.details.dryRun).toBe(true);
    expect(result.details.facts_consolidated).toBe(3);
    expect(result.details.takes_written).toBe(1);
    const after = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = 'cons-dryrun-pg'`,
    );
    // dry-run pretends; real take count unchanged.
    expect(Number(after[0].count)).toBe(Number(before[0].count));
  });
});
