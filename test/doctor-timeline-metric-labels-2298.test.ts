/**
 * Issue #2298 — timeline metric presentation contract.
 *
 * Authoritative upstream semantics (src/core/types.ts):
 *   - Metric A `timeline_coverage` (entity-scoped, fraction 0–1):
 *       eligible entity pages WITH a timeline entry / eligible entity pages
 *     -> surfaced by `graph_coverage` check AND `get_health` CLI entity line.
 *   - Metric B `timeline_coverage_score` (whole-brain, 0–15 brain-score component):
 *       all pages WITH a timeline entry / all pages
 *     -> surfaced by `brain_score` component breakdown AND (separately) CLI.
 *
 * The two have DIFFERENT numerators/denominators. This PR labels each
 * explicitly and keeps BOTH the entity CLI line and the whole-brain line.
 *
 * Tests (no private EriadorMu data, no production/home DB, no network):
 *   - numeric denominator assertions (Metric A = 50%, Metric B = 4/15)
 *   - doctor rendered-message assertions (exact labels, no ambiguous old label)
 *   - CLI rendered-output assertions (exact lines, guard matrix)
 *   - red/green: same assertions FAIL on origin/master, PASS on this branch
 *
 * Scoring formula UNCHANGED. Canonical PGLite fixture via resetPgliteState.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { formatResult } from '../src/cli.ts';

let engine: PGLiteEngine;

async function seedFourPages(eng: PGLiteEngine): Promise<void> {
  const sql = sqlQueryForEngine(eng);
  // 2 eligible entity pages, 2 technical/non-entity pages.
  // Only ONE entity page has a timeline entry; only ONE total page does.
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    VALUES
      ('acme-example', 'default', 'company', 'Acme', '', '{}', 'h1', now(), now()),
      ('alice-example', 'default', 'person', 'Alice', '', '{}', 'h2', now(), now()),
      ('technical-a', 'default', 'note', 'Tech A', '', '{}', 'h3', now(), now()),
      ('technical-b', 'default', 'note', 'Tech B', '', '{}', 'h4', now(), now())
  `;
  const companyId = (await sql`SELECT id FROM pages WHERE slug='acme-example'`)[0].id as number;
  await sql`INSERT INTO timeline_entries (page_id, date, source, summary, detail)
    VALUES (${companyId}, CURRENT_DATE, 'test', 'milestone', '{}')`;
}

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

describe('issue #2298 — numeric denominator semantics', () => {
  test('entity timeline coverage = 1/2 = 50% (2 eligible entities, 1 with timeline)', async () => {
    await seedFourPages(engine);
    const health = await engine.getHealth();
    expect(health.timeline_coverage).toBeDefined();
    expect(Math.round((health.timeline_coverage ?? 0) * 100)).toBe(50);
  });

  test('whole-brain timeline density = 1/4 -> score 4/15 (4 total pages, 1 with timeline)', async () => {
    await seedFourPages(engine);
    const health = await engine.getHealth();
    expect(health.timeline_coverage_score).toBeDefined();
    expect(health.timeline_coverage_score).toBe(4);
  });

  test('the two metrics use independent denominators', async () => {
    await seedFourPages(engine);
    const health = await engine.getHealth();
    expect(Math.round((health.timeline_coverage ?? 0) * 100)).toBe(50);
    expect(health.timeline_coverage_score ?? 0).toBe(4);
    // 50% (entity, /2) != 26.7% (whole-brain, /4). Provably distinct.
    expect(Math.round(((health.timeline_coverage_score ?? 0) / 15) * 100)).not.toBe(50);
  });
});

describe('issue #2298 — doctor rendered-message contract', () => {
  test('graph_coverage renders entity-scoped label with 50%', async () => {
    await seedFourPages(engine);
    const checks = await buildChecks(engine, [], null);
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph, 'graph_coverage check must be present').toBeDefined();
    expect(graph!.message).toContain('entity timeline coverage 50%');
    // ambiguous old label must NOT be present
    expect(graph!.message).not.toMatch(/timeline 50%/);
    expect(graph!.message).not.toMatch(/timeline \(entity, brain score\)/);
  });

  test('brain_score renders whole-brain density label 4/15', async () => {
    await seedFourPages(engine);
    const checks = await buildChecks(engine, [], null);
    const brain = checks.find((c) => c.name === 'brain_score');
    expect(brain, 'brain_score check must be present').toBeDefined();
    expect(brain!.message).toContain('timeline density (all pages) 4/15');
    // wrong labels must NOT be present
    expect(brain!.message).not.toMatch(/timeline 4\/15/);
    expect(brain!.message).not.toMatch(/timeline \(entity, brain score\)/);
    // brain-score component must NOT carry the word "entity" (it is whole-brain)
    const timelinePart = brain!.message.split('timeline density (all pages) 4/15')[0] + 'timeline density (all pages) 4/15';
    expect(timelinePart).not.toMatch(/entity/);
  });
});

describe('issue #2298 — CLI get_health rendered-output contract', () => {
  function fakeHealth(overrides: Record<string, unknown>): any {
    return {
      embed_coverage: 1, missing_embeddings: 0, stale_pages: 0, orphan_pages: 0,
      link_coverage: 1, timeline_coverage: 0.5, timeline_coverage_score: 4,
      most_connected: [], ...overrides,
    };
  }

  test('both entity and whole-brain lines render, no undefined/15', () => {
    const out = formatResult('get_health', fakeHealth({}));
    expect(out).toContain('Timeline coverage (entity pages): 50.0%');
    expect(out).toContain('Timeline density (all pages): 4/15');
    expect(out).not.toContain('undefined/15');
    expect(out).not.toContain('Timeline coverage (entities)');
    expect(out).not.toMatch(/timeline \(entity, brain score\)/);
    expect(out).not.toMatch(/bare "timeline 4\/15"/);
  });

  test('guard matrix: entity present, whole-brain absent -> only entity line', () => {
    const out = formatResult('get_health', fakeHealth({ timeline_coverage_score: undefined }));
    expect(out).toContain('Timeline coverage (entity pages): 50.0%');
    expect(out).not.toContain('Timeline density (all pages)');
    expect(out).not.toContain('undefined/15');
  });

  test('guard matrix: whole-brain present, entity absent -> only whole-brain line', () => {
    const out = formatResult('get_health', fakeHealth({ timeline_coverage: undefined }));
    expect(out).toContain('Timeline density (all pages): 4/15');
    expect(out).not.toContain('Timeline coverage (entity pages)');
    expect(out).not.toContain('undefined/15');
  });

  test('guard matrix: both absent -> neither timeline line, never undefined/15', () => {
    const out = formatResult('get_health', fakeHealth({ timeline_coverage: undefined, timeline_coverage_score: undefined }));
    expect(out).not.toContain('Timeline coverage (entity pages)');
    expect(out).not.toContain('Timeline density (all pages)');
    expect(out).not.toContain('undefined/15');
  });
});
