// gbrain#1861 regression — batch inserts must survive free-text "poison"
// payloads (calendar/Zoom context: commas, quotes, backslashes, braces,
// em-dashes) that the old unnest(${arr}::text[]) array-literal path rejected
// with Postgres "malformed array literal".
//
// PGLite half (always-on). PGLite uses a different array serializer than
// postgres.js, so it may not reproduce the ORIGINAL crash — but it locks the
// new jsonb_to_recordset path's behavior everywhere CI runs. The Postgres lane
// (test/e2e/jsonb-batch-poison-postgres.test.ts) is the one that actually
// crashed pre-fix.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// The exact shape from the #1861 crash report: Zoom URL with ?pwd=, commas,
// double-quotes, a Windows backslash path, braces, and an em-dash.
const POISON =
  'Zoom: https://zoom.us/j/95178948505?pwd=YmdFRWxXbWZadlNkaG9iNC9CYW12QT09, ' +
  '"Q2 sync" — notes {a,b}, path C:\\Users\\x, em–dash } and { trailing';

// U+0000 — Postgres jsonb rejects it; the row builders strip it. Built via
// fromCharCode so no literal NUL byte ever lands in this source file.
const NUL = String.fromCharCode(0);

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

describe('addLinksBatch — JSONB poison (#1861)', () => {
  it('round-trips calendar free-text context without throwing', async () => {
    await seed('from-page');
    await seed('to-page');
    const n = await engine.addLinksBatch([
      { from_slug: 'from-page', to_slug: 'to-page', link_type: 'mentions',
        context: POISON, link_source: 'manual' },
    ]);
    expect(n).toBe(1);
    const links = await engine.getLinks('from-page', { sourceId: 'default' });
    expect(links).toHaveLength(1);
    expect(links[0].context).toBe(POISON); // byte-identical
  });

  it('strips embedded NUL but preserves the rest', async () => {
    await seed('a'); await seed('b');
    await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mentions',
        context: `before${NUL}after`, link_source: 'manual' },
    ]);
    const links = await engine.getLinks('a', { sourceId: 'default' });
    expect(links[0].context).toBe('beforeafter');
  });

  it('null origin_slug leaves origin_page_id NULL', async () => {
    await seed('a'); await seed('b');
    await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mentions', link_source: 'manual' },
    ]);
    const rows = await engine.executeRaw<{ origin_page_id: number | null }>(
      `SELECT l.origin_page_id FROM links l JOIN pages p ON p.id = l.from_page_id
       WHERE p.slug = 'a'`,
    );
    expect(rows[0].origin_page_id).toBeNull();
  });

  it('collapses an intra-batch duplicate (ON CONFLICT DO NOTHING)', async () => {
    await seed('a'); await seed('b');
    const dup = { from_slug: 'a', to_slug: 'b', link_type: 'mentions',
      context: POISON, link_source: 'manual' as const };
    const n = await engine.addLinksBatch([dup, dup]);
    expect(n).toBe(1);
    const links = await engine.getLinks('a', { sourceId: 'default' });
    expect(links).toHaveLength(1);
  });

  it('round-trips a non-null link_kind through the jsonb recordset', async () => {
    await seed('a'); await seed('b');
    await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mentions', context: POISON,
        link_source: 'mentions', link_kind: 'typed_ner' },
    ]);
    const rows = await engine.executeRaw<{ link_kind: string | null }>(
      `SELECT l.link_kind FROM links l JOIN pages p ON p.id = l.from_page_id
       WHERE p.slug = 'a'`,
    );
    expect(rows[0].link_kind).toBe('typed_ner'); // new recordset column, exercised non-NULL
  });

  it('leaves link_kind NULL when omitted (legacy/plain)', async () => {
    await seed('a'); await seed('b');
    await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mentions', link_source: 'manual' },
    ]);
    const rows = await engine.executeRaw<{ link_kind: string | null }>(
      `SELECT l.link_kind FROM links l JOIN pages p ON p.id = l.from_page_id
       WHERE p.slug = 'a'`,
    );
    expect(rows[0].link_kind).toBeNull();
  });
});

describe('addTimelineEntriesBatch — JSONB poison (#1861)', () => {
  it('round-trips free-text summary/detail/source without throwing', async () => {
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

  it('strips embedded NUL in summary', async () => {
    await seed('m');
    await engine.addTimelineEntriesBatch([
      { slug: 'm', date: '2026-06-04', summary: `a${NUL}b`, detail: '' },
    ]);
    const rows = await engine.executeRaw<{ summary: string }>(
      `SELECT te.summary FROM timeline_entries te JOIN pages p ON p.id = te.page_id
       WHERE p.slug = 'm'`,
    );
    expect(rows[0].summary).toBe('ab');
  });
});

describe('addTakesBatch — JSONB poison + native-type parity (#1861)', () => {
  it('round-trips free-text claim and native number/bool/null fields', async () => {
    await seed('take-page');
    const pid = await pageId('take-page');
    const n = await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: POISON, kind: 'fact', holder: 'garry',
        weight: 0.74, active: false }, // since_date/until_date/source omitted -> null
    ]);
    expect(n).toBe(1);
    const rows = await engine.executeRaw<{
      claim: string; weight: number | string; active: boolean; since_date: string | null;
    }>(`SELECT claim, weight, active, since_date FROM takes t
        JOIN pages p ON p.id = t.page_id WHERE p.slug = 'take-page' AND t.row_num = 1`);
    expect(rows[0].claim).toBe(POISON);            // free-text claim survives
    expect(Number(rows[0].weight)).toBeCloseTo(0.75, 5); // 0.74 -> 0.05 grid
    expect(rows[0].active).toBe(false);            // JSON boolean round-trips
    expect(rows[0].since_date).toBeNull();         // omitted -> SQL NULL
  });

  it('strips embedded NUL from the free-text claim', async () => {
    await seed('tp-nul');
    const pid = await pageId('tp-nul');
    await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: `a${NUL}b`, kind: 'fact', holder: 'h' },
    ]);
    const rows = await engine.executeRaw<{ claim: string }>(
      `SELECT claim FROM takes t JOIN pages p ON p.id = t.page_id
       WHERE p.slug = 'tp-nul' AND t.row_num = 1`,
    );
    expect(rows[0].claim).toBe('ab');
  });

  it('clamps out-of-range weight (>1) to 1.0', async () => {
    await seed('tp2');
    const pid = await pageId('tp2');
    await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: 'c', kind: 'fact', holder: 'h', weight: 1.5 },
    ]);
    const rows = await engine.executeRaw<{ weight: number | string }>(
      `SELECT weight FROM takes t JOIN pages p ON p.id = t.page_id
       WHERE p.slug = 'tp2' AND t.row_num = 1`,
    );
    expect(Number(rows[0].weight)).toBeCloseTo(1.0, 5);
  });

  it('DO UPDATE upserts an existing (page_id, row_num)', async () => {
    await seed('tp3');
    const pid = await pageId('tp3');
    await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: 'first', kind: 'fact', holder: 'h' },
    ]);
    await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: 'second', kind: 'fact', holder: 'h' },
    ]);
    const rows = await engine.executeRaw<{ claim: string; n: number | string }>(
      `SELECT claim, (SELECT count(*) FROM takes t2 JOIN pages p2 ON p2.id = t2.page_id
                      WHERE p2.slug = 'tp3') AS n
       FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = 'tp3' AND t.row_num = 1`,
    );
    expect(rows[0].claim).toBe('second');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('round-trips nullable/native take fields (superseded_by, until_date, non-null source)', async () => {
    await seed('tp4');
    const pid = await pageId('tp4');
    await engine.addTakesBatch([
      { page_id: pid, row_num: 1, claim: 'c', kind: 'fact', holder: 'h',
        superseded_by: 7, until_date: '2027-01-01', source: POISON },
    ]);
    const rows = await engine.executeRaw<{
      superseded_by: number | string | null; until_date: string | null; source: string;
    }>(`SELECT superseded_by, until_date::text AS until_date, source FROM takes t
        JOIN pages p ON p.id = t.page_id WHERE p.slug = 'tp4' AND t.row_num = 1`);
    expect(Number(rows[0].superseded_by)).toBe(7);   // native int column
    expect(rows[0].until_date).toBe('2027-01-01');    // text/date round-trip
    expect(rows[0].source).toBe(POISON);              // non-null free-text source
  });
});

describe('scalar addLink — NUL strip on free-text context (#1861 codex #3)', () => {
  it('addLink strips NUL from context', async () => {
    await seed('a'); await seed('b');
    await engine.addLink('a', 'b', `before${NUL}after`, 'mentions', 'manual');
    const links = await engine.getLinks('a', { sourceId: 'default' });
    expect(links[0].context).toBe('beforeafter');
  });
});
