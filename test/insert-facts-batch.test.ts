/**
 * v0.32.2 — engine.insertFacts batch + deleteFactsForPage tests.
 *
 * Exercises the new BrainEngine surface on a real PGLite engine. Tests:
 *   - Batch insert N rows persists row_num + source_markdown_slug
 *   - Empty batch is a no-op
 *   - Returns ids in input-order
 *   - v51 partial UNIQUE index rolls back the whole batch on a collision
 *   - deleteFactsForPage scopes by (source_id, source_markdown_slug);
 *     never touches other pages or pre-v51 NULL-source_markdown_slug rows
 *   - deleteFactsForPage on an empty page returns deleted:0 (idempotent)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { NewFact } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seed alt sources for the multi-source isolation tests below. The
  // 'default' source is already created by initSchema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `INSERT INTO sources (id, name, config) VALUES
       ('work', 'work', '{}'::jsonb),
       ('home', 'home', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Wipe the facts table between tests so the v51 partial UNIQUE
  // index can't leak across cases.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
});

type BatchFact = NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number };

const fixtureFact = (rowNum: number, overrides: Partial<BatchFact> = {}): BatchFact => ({
  fact: `Claim ${rowNum}`,
  kind: 'fact',
  entity_slug: 'people/alice',
  visibility: 'world',
  notability: 'medium',
  source: 'test:fixture',
  confidence: 1.0,
  row_num: rowNum,
  source_markdown_slug: 'people/alice',
  ...overrides,
});

describe('engine.insertFacts — batch insert', () => {
  test('empty batch returns inserted:0, ids:[]', async () => {
    const r = await engine.insertFacts([], { source_id: 'default' });
    expect(r).toEqual({ inserted: 0, ids: [], warnings: [], deleted: 0 });
  });

  test('single-row batch inserts and persists v51 columns', async () => {
    const r = await engine.insertFacts([fixtureFact(1)], { source_id: 'default' });
    expect(r.inserted).toBe(1);
    expect(r.ids).toHaveLength(1);

    const rows = await engine.listFactsByEntity('default', 'people/alice');
    expect(rows).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      'SELECT row_num, source_markdown_slug FROM facts WHERE id = $1',
      [r.ids[0]],
    );
    expect(persisted.rows[0]).toMatchObject({
      row_num: 1,
      source_markdown_slug: 'people/alice',
    });
  });

  test('multi-row batch preserves input order in returned ids', async () => {
    const r = await engine.insertFacts(
      [fixtureFact(1, { fact: 'first' }), fixtureFact(2, { fact: 'second' }), fixtureFact(3, { fact: 'third' })],
      { source_id: 'default' },
    );
    expect(r.inserted).toBe(3);
    expect(r.ids).toHaveLength(3);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, fact, row_num FROM facts ORDER BY row_num',
    );
    expect(rows.rows.map((r: { fact: string }) => r.fact)).toEqual(['first', 'second', 'third']);
    expect(rows.rows.map((r: { id: number }) => r.id)).toEqual(r.ids);
  });

  test('all NewFact fields persist alongside v51 columns', async () => {
    const validFrom = new Date(Date.UTC(2026, 0, 1));
    const validUntil = new Date(Date.UTC(2026, 11, 31));
    const r = await engine.insertFacts(
      [fixtureFact(1, {
        fact: 'Specific claim',
        kind: 'commitment',
        visibility: 'private',
        notability: 'high',
        context: 'Detailed context',
        valid_from: validFrom,
        valid_until: validUntil,
        confidence: 0.85,
      })],
      { source_id: 'default' },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got = await (engine as any).db.query(
      `SELECT fact, kind, visibility, notability, context, valid_from, valid_until,
              source, confidence, row_num, source_markdown_slug
       FROM facts WHERE id = $1`,
      [r.ids[0]],
    );
    expect(got.rows[0]).toMatchObject({
      fact: 'Specific claim',
      kind: 'commitment',
      visibility: 'private',
      notability: 'high',
      context: 'Detailed context',
      source: 'test:fixture',
      confidence: 0.85,
      row_num: 1,
      source_markdown_slug: 'people/alice',
    });
  });

  test('v51 partial UNIQUE index rolls back the whole batch on collision', async () => {
    // Seed row #1 first.
    await engine.insertFacts([fixtureFact(1, { fact: 'seeded' })], { source_id: 'default' });

    // Now try to batch-insert rows that include a colliding row_num=1.
    let threw = false;
    try {
      await engine.insertFacts(
        [
          fixtureFact(2, { fact: 'second' }),
          fixtureFact(1, { fact: 'collides' }),  // row_num=1 on same (source_id, source_markdown_slug)
          fixtureFact(3, { fact: 'third' }),
        ],
        { source_id: 'default' },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Verify the transaction rolled back — only the seeded row should remain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT fact FROM facts ORDER BY id');
    expect(rows.rows.map((r: { fact: string }) => r.fact)).toEqual(['seeded']);
  });

  test('different source_markdown_slug values DO NOT collide on the same row_num', async () => {
    // The partial UNIQUE index keys on (source_id, source_markdown_slug,
    // row_num). Two different entity pages with row_num=1 each should
    // both insert cleanly.
    const r = await engine.insertFacts(
      [
        fixtureFact(1, { source_markdown_slug: 'people/alice', entity_slug: 'people/alice' }),
        fixtureFact(1, { source_markdown_slug: 'people/bob', entity_slug: 'people/bob' }),
      ],
      { source_id: 'default' },
    );
    expect(r.inserted).toBe(2);
  });

  test('different source_id values DO NOT collide on same (markdown_slug, row_num)', async () => {
    // Multi-source brain support: same fence row on two sources is two
    // distinct DB rows. Verified by the partial UNIQUE index including
    // source_id as the leading column.
    const r1 = await engine.insertFacts(
      [fixtureFact(1, { source_markdown_slug: 'people/alice' })],
      { source_id: 'work' },
    );
    const r2 = await engine.insertFacts(
      [fixtureFact(1, { source_markdown_slug: 'people/alice' })],
      { source_id: 'home' },
    );
    expect(r1.inserted).toBe(1);
    expect(r2.inserted).toBe(1);
  });
});

describe('engine.deleteFactsForPage', () => {
  test('empty page (no matching rows) returns deleted:0', async () => {
    const r = await engine.deleteFactsForPage('people/nobody', 'default');
    expect(r).toEqual({ deleted: 0 });
  });

  test('deletes all rows for the given (source_id, source_markdown_slug) pair', async () => {
    await engine.insertFacts(
      [
        fixtureFact(1, { fact: 'A1' }),
        fixtureFact(2, { fact: 'A2' }),
        fixtureFact(3, { fact: 'A3' }),
      ],
      { source_id: 'default' },
    );

    const r = await engine.deleteFactsForPage('people/alice', 'default');
    expect(r.deleted).toBe(3);

    const rows = await engine.listFactsByEntity('default', 'people/alice');
    expect(rows).toHaveLength(0);
  });

  test('does NOT touch other pages with the same source_id', async () => {
    await engine.insertFacts(
      [fixtureFact(1, { source_markdown_slug: 'people/alice', entity_slug: 'people/alice' })],
      { source_id: 'default' },
    );
    await engine.insertFacts(
      [fixtureFact(1, { source_markdown_slug: 'people/bob', entity_slug: 'people/bob', fact: 'about bob' })],
      { source_id: 'default' },
    );

    const r = await engine.deleteFactsForPage('people/alice', 'default');
    expect(r.deleted).toBe(1);

    // Bob's row survives.
    const bobRows = await engine.listFactsByEntity('default', 'people/bob');
    expect(bobRows).toHaveLength(1);
  });

  test('does NOT touch the same page on a different source_id', async () => {
    await engine.insertFacts(
      [fixtureFact(1, { fact: 'work alice' })],
      { source_id: 'work' },
    );
    await engine.insertFacts(
      [fixtureFact(1, { fact: 'home alice' })],
      { source_id: 'home' },
    );

    const r = await engine.deleteFactsForPage('people/alice', 'work');
    expect(r.deleted).toBe(1);

    const homeRows = await engine.listFactsByEntity('home', 'people/alice');
    expect(homeRows).toHaveLength(1);
    expect(homeRows[0].fact).toBe('home alice');
  });

  test('does NOT touch pre-v51 rows with NULL source_markdown_slug', async () => {
    // Pre-v51 rows live in a different keyspace. Seed one via direct
    // single-row insertFact (which doesn't set source_markdown_slug).
    await engine.insertFact(
      {
        fact: 'pre-v51 row',
        entity_slug: 'people/alice',
        source: 'mcp:extract_facts',
      },
      { source_id: 'default' },
    );

    // Also seed a v51 row for the same page.
    await engine.insertFacts(
      [fixtureFact(1, { fact: 'v51 row' })],
      { source_id: 'default' },
    );

    // deleteFactsForPage targets source_markdown_slug = 'people/alice'.
    // The pre-v51 row has source_markdown_slug = NULL, so it survives.
    const r = await engine.deleteFactsForPage('people/alice', 'default');
    expect(r.deleted).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remaining = await (engine as any).db.query(
      `SELECT fact, source_markdown_slug FROM facts WHERE entity_slug = 'people/alice'`,
    );
    expect(remaining.rows).toHaveLength(1);
    expect(remaining.rows[0].fact).toBe('pre-v51 row');
    expect(remaining.rows[0].source_markdown_slug).toBeNull();
  });
});

describe('insertFacts + deleteFactsForPage round-trip (the reconciliation pattern)', () => {
  test('delete-then-reinsert produces fresh ids but identical fence content', async () => {
    // This is the pattern the extract_facts cycle phase uses on each page.
    const first = await engine.insertFacts(
      [
        fixtureFact(1, { fact: 'A' }),
        fixtureFact(2, { fact: 'B' }),
      ],
      { source_id: 'default' },
    );
    expect(first.inserted).toBe(2);

    // Reconcile: delete-then-reinsert.
    await engine.deleteFactsForPage('people/alice', 'default');
    const second = await engine.insertFacts(
      [
        fixtureFact(1, { fact: 'A' }),
        fixtureFact(2, { fact: 'B' }),
      ],
      { source_id: 'default' },
    );

    // Fresh ids (the SERIAL counter advanced).
    expect(second.ids).not.toEqual(first.ids);
    // Same row count, same content.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, row_num, source_markdown_slug FROM facts ORDER BY row_num`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ fact: 'A', row_num: 1, source_markdown_slug: 'people/alice' });
    expect(rows.rows[1]).toMatchObject({ fact: 'B', row_num: 2, source_markdown_slug: 'people/alice' });
  });
});

describe('engine.insertFacts — v0.42 (#3014) supersession transport', () => {
  const struck = (rowNum: number, supersededByRow: number, overrides: Partial<BatchFact> = {}): BatchFact =>
    fixtureFact(rowNum, {
      expired_at: new Date('2026-06-01T00:00:00Z'),
      superseded_by_row: supersededByRow,
      ...overrides,
    });

  test('struck row resolves superseded by #N to the target fact id + persists expired_at', async () => {
    // Row 1 struck, superseded by row 2 (active). Same batch.
    const r = await engine.insertFacts(
      [struck(1, 2, { fact: 'old claim' }), fixtureFact(2, { fact: 'new claim' })],
      { source_id: 'default' },
    );
    expect(r.warnings).toEqual([]);
    const targetId = r.ids[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      `SELECT row_num, superseded_by, expired_at FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(Number(persisted.rows[0].superseded_by)).toBe(Number(targetId));
    expect(persisted.rows[0].expired_at).not.toBeNull();
    // The active target keeps superseded_by NULL.
    expect(persisted.rows[1].superseded_by).toBeNull();

    // The row surfaces in listSupersessions (superseded_by filter, option B).
    const sup = await engine.listSupersessions('default');
    expect(sup.some(s => s.id === r.ids[0] && s.superseded_by === Number(targetId))).toBe(true);
  });

  test('reference to a pre-existing target row (not in this batch) still resolves', async () => {
    // Insert the target first (its own batch), then the struck row later.
    const target = await engine.insertFacts([fixtureFact(2, { fact: 'survivor' })], { source_id: 'default' });
    const r = await engine.insertFacts([struck(1, 2, { fact: 'retired' })], { source_id: 'default' });
    expect(r.warnings).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      `SELECT superseded_by FROM facts WHERE row_num = 1 AND source_markdown_slug = 'people/alice'`,
    );
    expect(Number(persisted.rows[0].superseded_by)).toBe(Number(target.ids[0]));
  });

  test('dangling reference (#N absent) → superseded_by NULL + warning, expired_at still set', async () => {
    const r = await engine.insertFacts([struck(1, 99, { fact: 'orphaned' })], { source_id: 'default' });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('absent from the fence');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      `SELECT superseded_by, expired_at FROM facts WHERE row_num = 1 AND source_markdown_slug = 'people/alice'`,
    );
    expect(persisted.rows[0].superseded_by).toBeNull();
    expect(persisted.rows[0].expired_at).not.toBeNull();
  });

  test('self-reference (#N == own row) → superseded_by NULL + warning', async () => {
    const r = await engine.insertFacts([struck(1, 1, { fact: 'ouroboros' })], { source_id: 'default' });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('references itself');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      `SELECT superseded_by FROM facts WHERE row_num = 1 AND source_markdown_slug = 'people/alice'`,
    );
    expect(persisted.rows[0].superseded_by).toBeNull();
  });

  test('chain (#N names another struck row) → superseded_by NULL + warning', async () => {
    // Row 1 superseded by #2; row 2 is itself struck (superseded by #3).
    const r = await engine.insertFacts(
      [struck(1, 2, { fact: 'link a' }), struck(2, 3, { fact: 'link b' }), fixtureFact(3, { fact: 'live tail' })],
      { source_id: 'default' },
    );
    // Row 1 → row 2 is a chain (row 2 struck) → NULL + warning.
    // Row 2 → row 3 (live) resolves cleanly.
    expect(r.warnings.some(w => w.includes('struck'))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      `SELECT row_num, superseded_by FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(persisted.rows[0].superseded_by).toBeNull();          // row 1: chain rejected
    expect(Number(persisted.rows[1].superseded_by)).toBe(Number(r.ids[2])); // row 2 → row 3
  });

  test('int4-overflow reference (11-digit #N) resolves as dangling — never throws', async () => {
    // The fence parser accepts any finite #N; an 11-digit value would
    // overflow the int4 row_num comparison in the resolution SELECT and
    // abort the whole cycle. The guard treats it as a dangling reference:
    // NULL superseded_by + warning, expired_at still set, no exception.
    const r = await engine.insertFacts(
      [struck(1, 99999999999, { fact: 'points at an absurd row' })],
      { source_id: 'default' },
    );
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('absent from the fence');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await (engine as any).db.query(
      `SELECT superseded_by, expired_at FROM facts WHERE row_num = 1 AND source_markdown_slug = 'people/alice'`,
    );
    expect(persisted.rows[0].superseded_by).toBeNull();
    expect(persisted.rows[0].expired_at).not.toBeNull();
  });
});

describe('engine.insertFacts — v0.42 (#3014) atomic deleteForPageFirst reconcile', () => {
  test('replaces the page atomically and reports the deleted count', async () => {
    await engine.insertFacts(
      [fixtureFact(1, { fact: 'old one' }), fixtureFact(2, { fact: 'old two' })],
      { source_id: 'default' },
    );
    const r = await engine.insertFacts(
      [fixtureFact(1, { fact: 'new one' })],
      { source_id: 'default' },
      { deleteForPageFirst: { slug: 'people/alice', excludeSourcePrefixes: ['cli:'] } },
    );
    expect(r.inserted).toBe(1);
    expect(r.deleted).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((x: { fact: string }) => x.fact)).toEqual(['new one']);
  });

  test('a failing insert rolls the wipe back — the page is never left emptied', async () => {
    // Seed the page's current rows (the ones a pre-fix separate-commit delete
    // would have destroyed before the insert threw).
    await engine.insertFacts(
      [fixtureFact(1, { fact: 'keeper one' }), fixtureFact(2, { fact: 'keeper two' })],
      { source_id: 'default' },
    );

    // The insert batch collides with itself (two row_num=1) AFTER the delete
    // has already run inside the same transaction. The v51 UNIQUE index
    // throws on the second row_num=1, rolling the whole transaction back.
    let threw = false;
    try {
      await engine.insertFacts(
        [fixtureFact(1, { fact: 'replacement a' }), fixtureFact(1, { fact: 'dup collides' })],
        { source_id: 'default' },
        { deleteForPageFirst: { slug: 'people/alice', excludeSourcePrefixes: ['cli:'] } },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Atomicity: the delete rolled back with the failed insert, so the
    // original rows survive rather than the page being silently emptied.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((x: { fact: string }) => x.fact)).toEqual(['keeper one', 'keeper two']);
  });

  test('cli:-origin rows survive the atomic wipe (excludeSourcePrefixes honored)', async () => {
    await engine.insertFacts(
      [
        fixtureFact(1, { fact: 'fence row', source: 'fence:reconcile' }),
        fixtureFact(2, { fact: 'conversation row', source: 'cli:think' }),
      ],
      { source_id: 'default' },
    );
    const r = await engine.insertFacts(
      [fixtureFact(1, { fact: 'fresh fence row', source: 'fence:reconcile' })],
      { source_id: 'default' },
      { deleteForPageFirst: { slug: 'people/alice', excludeSourcePrefixes: ['cli:'] } },
    );
    expect(r.deleted).toBe(1); // only the fence row was wiped
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((x: { fact: string }) => x.fact)).toEqual(['fresh fence row', 'conversation row']);
  });
});
