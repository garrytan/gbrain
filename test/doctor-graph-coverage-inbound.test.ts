/**
 * test/doctor-graph-coverage-inbound.test.ts — #4191.
 *
 * doctor's graph_coverage used to count an entity as covered only when it
 * had an OUTBOUND link (from_page_id), while onboard's entity_link_coverage
 * counts INBOUND links (to_page_id EXISTS, target 70%). A brain of
 * inbound-only entities — the normal shape: meeting/note pages link TO
 * people and companies — read healthy in onboard and warned in doctor on
 * the same data. graph_coverage now counts CONNECTED entities (inbound OR
 * outbound) with the same 70% target, so the two checks can't contradict
 * each other on inbound-only brains.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Insert `count` synthetic person pages `<prefix>-1` .. `<prefix>-<count>`. */
async function insertPeople(eng: PGLiteEngine, prefix: string, count: number): Promise<void> {
  const sql = sqlQueryForEngine(eng);
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    SELECT ${prefix}::text || '-' || g, 'default', 'person', 'Person ' || g, '', '{}', ${prefix}::text || '-h' || g, now(), now()
    FROM generate_series(1, ${count}::int) AS g
  `;
}

/**
 * Enough person pages to clear the small-N coverage floor, each LINKED TO
 * (inbound only) from one note page and each with a timeline entry, so the
 * timeline half of the check stays green and the assertion isolates the
 * link-direction predicate.
 */
async function seedInboundOnlyEntities(eng: PGLiteEngine): Promise<void> {
  const sql = sqlQueryForEngine(eng);
  await insertPeople(eng, 'inbound-example', MIN_ENTITY_PAGES_FOR_COVERAGE);
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    VALUES ('meetings/2026-04-03', 'default', 'note', 'Standup', '', '{}', 'in-note', now(), now())
  `;
  // Inbound-only: the note links TO every person; the people link to nothing.
  await sql`
    INSERT INTO links (from_page_id, to_page_id, link_type)
    SELECT n.id, e.id, 'mentions'
    FROM pages n, pages e
    WHERE n.slug = 'meetings/2026-04-03' AND e.type = 'person'
  `;
  await sql`
    INSERT INTO timeline_entries (page_id, date, summary)
    SELECT id, '2026-04-03', 'met at standup' FROM pages WHERE type = 'person'
  `;
}

describe('graph_coverage counts inbound-connected entities (#4191)', () => {
  test('inbound-only entities are covered — ok, no contradictory warn', async () => {
    await seedInboundOnlyEntities(engine);
    const checks = await buildChecks(engine, [], null);
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph, 'graph_coverage check must be present').toBeDefined();
    // Every person has an inbound link → 100% connected coverage, ok.
    expect(graph!.status).toBe('ok');
    expect(graph!.message).toContain('connected coverage (in/out)');
    expect(graph!.message).toContain('100%');
  });

  test('unlinked entities still warn, with the 70% target named', async () => {
    await insertPeople(engine, 'unlinked-example', MIN_ENTITY_PAGES_FOR_COVERAGE);
    const checks = await buildChecks(engine, [], null);
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph!.status).toBe('warn');
    expect(graph!.message).toContain('connected coverage (in/out) 0%');
    expect(graph!.message).toContain('target 70%');
  });
});
