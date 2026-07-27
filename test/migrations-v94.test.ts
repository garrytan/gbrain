import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// v0.41.2 R-MIG IRON-RULE regression: v94 take_domain_assignments table
//
// Pinned contracts:
// 1. Migration v94 exists in the MIGRATIONS array with the canonical name.
// 2. Table created cleanly via initSchema() on a fresh PGLite.
// 3. Composite PK (take_id, domain) prevents duplicate (take, domain) pairs.
// 4. FK to takes(id) with ON DELETE CASCADE — deleting a take cascades assignments.
// 5. CHECK constraint on confidence in [0, 1].
// 6. Index idx_take_domain_assignments_domain present for aggregator JOIN direction.
// 7. Pre-existing takes can co-exist with NULL assignment state (backward-compat:
//    aggregator skips takes lacking domain assignment without erroring).
// 8. PGLite + Postgres parity: schema-shape grep on migrate.ts ensures both
//    sql: and sqlFor.pglite include the same CREATE TABLE + index DDL.

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

describe('v0.41.2 R-MIG: take_domain_assignments migration v94', () => {
  test('v94 exists in MIGRATIONS with canonical name', () => {
    const v94 = MIGRATIONS.find(m => m.version === 94);
    expect(v94).toBeDefined();
    expect(v94?.name).toBe('take_domain_assignments');
  });

  test('LATEST_VERSION >= 94', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(94);
  });

  test('table is created and queryable after initSchema()', async () => {
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM take_domain_assignments`
    );
    expect(rows[0].count).toBe(0);
  });

  test('table has expected columns with expected types', async () => {
    const cols = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'take_domain_assignments'
        ORDER BY ordinal_position`
    );
    const byName = Object.fromEntries(cols.map(c => [c.column_name, c]));
    expect(Object.keys(byName).sort()).toEqual([
      'assigned_at',
      'confidence',
      'domain',
      'pack',
      'source',
      'take_id',
    ]);
    expect(byName.take_id.is_nullable).toBe('NO');
    expect(byName.domain.is_nullable).toBe('NO');
    expect(byName.pack.is_nullable).toBe('NO');
    expect(byName.source.is_nullable).toBe('YES'); // optional manual-assignment source
    expect(byName.confidence.is_nullable).toBe('NO');
    expect(byName.assigned_at.is_nullable).toBe('NO');
  });

  test('composite PK (take_id, domain) rejects duplicate (take, domain) pair', async () => {
    // Seed a page + take to satisfy FK
    await engine.putPage('test/seed-1', {
      title: 'seed',
      type: 'person',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/seed-1' LIMIT 1`
    );
    const pageId = pageRow[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'seed claim', 'take', 'garry')`,
      [pageId]
    );
    const takeRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 LIMIT 1`,
      [pageId]
    );
    const takeId = takeRow[0].id;

    await engine.executeRaw(
      `INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'deal_success', 'gbrain-investor')`,
      [takeId]
    );
    // Second insert with same (take_id, domain) violates PK
    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'deal_success', 'gbrain-investor')`,
        [takeId]
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('multi-domain assignment for same take is permitted', async () => {
    await engine.putPage('test/seed-multi', {
      title: 'seed',
      type: 'person',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/seed-multi' LIMIT 1`
    );
    const pageId = pageRow[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'multi-domain claim', 'take', 'garry')`,
      [pageId]
    );
    const takeRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 LIMIT 1`,
      [pageId]
    );
    const takeId = takeRow[0].id;

    // Same take, two domains — should both insert cleanly
    await engine.executeRaw(
      `INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'deal_success', 'gbrain-investor')`,
      [takeId]
    );
    await engine.executeRaw(
      `INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'market_call', 'gbrain-investor')`,
      [takeId]
    );
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM take_domain_assignments WHERE take_id = $1`,
      [takeId]
    );
    expect(rows[0].count).toBe(2);
  });

  test('FK ON DELETE CASCADE removes assignments when take is deleted', async () => {
    await engine.putPage('test/seed-cascade', {
      title: 'seed',
      type: 'person',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/seed-cascade' LIMIT 1`
    );
    const pageId = pageRow[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'cascade claim', 'take', 'garry')`,
      [pageId]
    );
    const takeRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 LIMIT 1`,
      [pageId]
    );
    const takeId = takeRow[0].id;

    await engine.executeRaw(
      `INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'deal_success', 'gbrain-investor')`,
      [takeId]
    );
    expect(
      (await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM take_domain_assignments WHERE take_id = $1`,
        [takeId]
      ))[0].count
    ).toBe(1);

    await engine.executeRaw(`DELETE FROM takes WHERE id = $1`, [takeId]);
    expect(
      (await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM take_domain_assignments WHERE take_id = $1`,
        [takeId]
      ))[0].count
    ).toBe(0);
  });

  test('CHECK constraint rejects confidence outside [0, 1]', async () => {
    await engine.putPage('test/seed-check', {
      title: 'seed',
      type: 'person',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/seed-check' LIMIT 1`
    );
    const pageId = pageRow[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'check claim', 'take', 'garry')`,
      [pageId]
    );
    const takeRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 LIMIT 1`,
      [pageId]
    );
    const takeId = takeRow[0].id;

    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO take_domain_assignments (take_id, domain, pack, confidence) VALUES ($1, 'deal_success', 'gbrain-investor', 1.5)`,
        [takeId]
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO take_domain_assignments (take_id, domain, pack, confidence) VALUES ($1, 'deal_success', 'gbrain-investor', -0.1)`,
        [takeId]
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('idx_take_domain_assignments_domain index is created', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'take_domain_assignments'
          AND indexname = 'idx_take_domain_assignments_domain'`
    );
    expect(rows.length).toBe(1);
  });

  test('aggregator JOIN direction returns assignments per domain', async () => {
    // Seed 3 takes, assign 2 to deal_success and 1 to market_call
    for (let i = 1; i <= 3; i++) {
      await engine.putPage(`test/agg-${i}`, {
        title: `seed ${i}`,
        type: 'person',
        compiled_truth: '',
        frontmatter: {},
        timeline: '',
      });
      const pageRow = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = 'test/agg-${i}' LIMIT 1`
      );
      const pageId = pageRow[0].id;
      await engine.executeRaw(
        `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, $2, 'take', 'garry')`,
        [pageId, `agg claim ${i}`]
      );
      const takeRow = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM takes WHERE page_id = $1 LIMIT 1`,
        [pageId]
      );
      const takeId = takeRow[0].id;
      const domain = i <= 2 ? 'deal_success' : 'market_call';
      await engine.executeRaw(
        `INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, $2, 'gbrain-investor')`,
        [takeId, domain]
      );
    }
    const per = await engine.executeRaw<{ domain: string; n: number }>(
      `SELECT a.domain AS domain, COUNT(*)::int AS n
         FROM take_domain_assignments a
         JOIN takes t ON t.id = a.take_id
        WHERE t.holder = 'garry'
        GROUP BY a.domain
        ORDER BY a.domain`
    );
    expect(per).toEqual([
      { domain: 'deal_success', n: 2 },
      { domain: 'market_call', n: 1 },
    ]);
  });

  test('PGLite + Postgres parity — source DDL matches between sql and sqlFor.pglite', () => {
    const v94 = MIGRATIONS.find(m => m.version === 94);
    expect(v94).toBeDefined();
    expect(v94?.sql).toContain('CREATE TABLE IF NOT EXISTS take_domain_assignments');
    expect(v94?.sql).toContain('REFERENCES takes(id) ON DELETE CASCADE');
    expect(v94?.sql).toContain('PRIMARY KEY (take_id, domain)');
    expect(v94?.sql).toContain('idx_take_domain_assignments_domain');
    expect(v94?.sqlFor?.pglite).toContain('CREATE TABLE IF NOT EXISTS take_domain_assignments');
    expect(v94?.sqlFor?.pglite).toContain('REFERENCES takes(id) ON DELETE CASCADE');
    expect(v94?.sqlFor?.pglite).toContain('PRIMARY KEY (take_id, domain)');
    expect(v94?.sqlFor?.pglite).toContain('idx_take_domain_assignments_domain');
  });

  test('pre-existing takes without assignment co-exist (backward compat)', async () => {
    await engine.putPage('test/legacy-take', {
      title: 'legacy',
      type: 'person',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/legacy-take' LIMIT 1`
    );
    const pageId = pageRow[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'unassigned claim', 'take', 'garry')`,
      [pageId]
    );
    // Aggregator JOIN: takes with no assignment should produce zero rows
    // (aggregator skips them; calibration_profile widening must handle this gracefully)
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM takes t
         LEFT JOIN take_domain_assignments a ON a.take_id = t.id
        WHERE t.page_id = $1 AND a.domain IS NULL`,
      [pageId]
    );
    expect(rows[0].count).toBe(1);
  });
});
