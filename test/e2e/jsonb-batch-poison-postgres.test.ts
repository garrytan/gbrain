// gbrain#1861 regression — Postgres lane (DATABASE_URL-gated).
//
// This is the engine that actually crashed: postgres.js serialized free-text
// `context` into a Postgres text[] literal that `array_in` rejected with
// "malformed array literal", aborting the whole `extract links --stale` sweep.
// The PGLite sibling (test/links-timeline-jsonb-poison.test.ts) may not
// reproduce the original crash because PGLite uses a different array serializer,
// so this gated test is the true regression lock. It runs in CI lanes that set
// DATABASE_URL and skips gracefully elsewhere.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

const SKIP = !hasDatabase();
const d = SKIP ? describe.skip : describe;

const POISON =
  'Zoom: https://zoom.us/j/95178948505?pwd=YmdFRWxXbWZadlNkaG9iNC9CYW12QT09, ' +
  '"Q2 sync" — notes {a,b}, path C:\\Users\\x, em–dash } and { trailing';
const NUL = String.fromCharCode(0);

let engine: PostgresEngine;

async function seed(slug: string) {
  await engine.putPage(slug, {
    title: slug, type: 'concept' as never,
    compiled_truth: 'body long enough to pass any minimum length backstop',
    timeline: '', frontmatter: {}, source_path: `${slug}.md`,
  });
}

async function pageId(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug],
  );
  return rows[0].id;
}

d('JSONB batch poison — Postgres (#1861)', () => {
  beforeAll(async () => { engine = await setupDB(); });
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    // Clean the three target tables between cases.
    const conn = getConn();
    await conn.unsafe('TRUNCATE links, timeline_entries, takes, pages CASCADE');
  });

  it('addLinksBatch round-trips poison context (the original crash)', async () => {
    await seed('from-page'); await seed('to-page');
    const n = await engine.addLinksBatch([
      { from_slug: 'from-page', to_slug: 'to-page', link_type: 'mentions',
        context: POISON, link_source: 'manual' },
    ]);
    expect(n).toBe(1);
    const links = await engine.getLinks('from-page', { sourceId: 'default' });
    expect(links[0].context).toBe(POISON);
  });

  it('strips embedded NUL in link context', async () => {
    await seed('a'); await seed('b');
    await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mentions',
        context: `before${NUL}after`, link_source: 'manual' },
    ]);
    const links = await engine.getLinks('a', { sourceId: 'default' });
    expect(links[0].context).toBe('beforeafter');
  });

  it('addTimelineEntriesBatch round-trips poison summary/detail/source', async () => {
    await seed('meeting-page');
    const n = await engine.addTimelineEntriesBatch([
      { slug: 'meeting-page', date: '2026-06-04', source: POISON,
        summary: POISON, detail: POISON },
    ]);
    expect(n).toBe(1);
    const rows = await engine.executeRaw<{ summary: string; detail: string; source: string }>(
      `SELECT te.summary, te.detail, te.source FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id WHERE p.slug = 'meeting-page'`,
    );
    expect(rows[0].summary).toBe(POISON);
    expect(rows[0].detail).toBe(POISON);
    expect(rows[0].source).toBe(POISON);
  });

  it('addTakesBatch round-trips poison claim + native number/bool/null', async () => {
    await seed('take-page');
    const pid = await pageId('take-page');
    const n = await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: POISON, kind: 'fact', holder: 'garry',
        weight: 0.74, active: false },
    ]);
    expect(n).toBe(1);
    const rows = await engine.executeRaw<{
      claim: string; weight: number | string; active: boolean; since_date: string | null;
    }>(`SELECT claim, weight, active, since_date FROM takes t
        JOIN pages p ON p.id = t.page_id WHERE p.slug = 'take-page' AND t.row_num = 1`);
    expect(rows[0].claim).toBe(POISON);
    expect(Number(rows[0].weight)).toBeCloseTo(0.75, 5);
    expect(rows[0].active).toBe(false);
    expect(rows[0].since_date).toBeNull();
  });
});
