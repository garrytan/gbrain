/**
 * graph_coverage must count LIVE entity pages only.
 *
 * A brain whose only entity pages are soft-deleted has zero live entities, so
 * the check has to take its existing short-circuit ("No entity pages —
 * graph_coverage not applicable") rather than warn about coverage on pages the
 * rest of the system treats as gone.
 *
 * Without the deleted_at filter the WARN is unclearable: doctor recommends
 * `gbrain extract all`, but buildGazetteer (src/core/by-mention.ts) already
 * filters soft-deleted pages, so `extract links --by-mention` answers "No
 * linkable entity pages found" on the same brain. The two disagree about
 * whether entity pages exist at all.
 *
 * Reported on #3754 (deleted_at not filtered), doctor surface.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';

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

/** Two entity pages plus a plain note; the entity pages are then soft-deleted. */
async function seedSoftDeletedEntities(eng: PGLiteEngine): Promise<void> {
  const sql = sqlQueryForEngine(eng);
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    VALUES
      ('acme-example', 'default', 'company', 'Acme', '', '{}', 'sd1', now(), now()),
      ('alice-example', 'default', 'person', 'Alice', '', '{}', 'sd2', now(), now()),
      ('technical-a', 'default', 'note', 'Tech A', '', '{}', 'sd3', now(), now())
  `;
  await sql`UPDATE pages SET deleted_at = now() WHERE slug IN ('acme-example', 'alice-example')`;
}

/** Same shape, but the entity pages stay live — the control. */
async function seedLiveEntities(eng: PGLiteEngine): Promise<void> {
  const sql = sqlQueryForEngine(eng);
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    VALUES
      ('acme-example', 'default', 'company', 'Acme', '', '{}', 'lv1', now(), now()),
      ('alice-example', 'default', 'person', 'Alice', '', '{}', 'lv2', now(), now()),
      ('technical-a', 'default', 'note', 'Tech A', '', '{}', 'lv3', now(), now())
  `;
}

describe('graph_coverage counts live entity pages only (#3754, doctor surface)', () => {
  test('all entity pages soft-deleted -> takes the not-applicable short-circuit', async () => {
    await seedSoftDeletedEntities(engine);
    const checks = await buildChecks(engine, [], null);
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph, 'graph_coverage check must be present').toBeDefined();
    expect(graph!.message).toContain('No entity pages');
    // The unclearable WARN this guards against names a count and a percentage.
    expect(graph!.message).not.toMatch(/entity page(s)?\)/);
    expect(graph!.message).not.toMatch(/coverage \d+%/);
  });

  test('control: live entity pages still produce a real coverage report', async () => {
    await seedLiveEntities(engine);
    const checks = await buildChecks(engine, [], null);
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph, 'graph_coverage check must be present').toBeDefined();
    // Not the short-circuit — the filter must not hide live pages.
    expect(graph!.message).not.toContain('No entity pages');
    expect(graph!.message).toMatch(/coverage \d+%/);
  });

  test('a soft-deleted entity page does not inflate the reported denominator', async () => {
    const sql = sqlQueryForEngine(engine);
    await seedLiveEntities(engine);
    await sql`
      INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at, deleted_at)
      VALUES ('ghost-example', 'default', 'person', 'Ghost', '', '{}', 'gh1', now(), now(), now())
    `;
    const checks = await buildChecks(engine, [], null);
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph, 'graph_coverage check must be present').toBeDefined();
    // 2 live entity pages + 1 soft-deleted. The count doctor reports — and
    // divides its percentages by — must be the live 2.
    expect(graph!.message).toContain('(2 entity pages)');
    expect(graph!.message).not.toContain('(3 entity pages)');
  });
});
