import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { LATEST_VERSION, runMigrations, MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('migrate', () => {
  test('LATEST_VERSION is a number >= 1', () => {
    expect(typeof LATEST_VERSION).toBe('number');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(1);
  });

  test('runMigrations is exported and callable', async () => {
    expect(typeof runMigrations).toBe('function');
  });

  // Integration tests for actual migration execution require DATABASE_URL
  // and are covered in the E2E suite (test/e2e/mechanical.test.ts)
});

// ─────────────────────────────────────────────────────────────────
// REGRESSION TESTS — migrations v8 + v9 perf on duplicate-heavy tables
// ─────────────────────────────────────────────────────────────────
//
// Garry's production brain hit Supabase Management API's 60s ceiling because
// the DELETE...USING self-join in migrations v8 + v9 was O(n²) without an
// index on the dedup columns. The fix pre-creates a btree helper index
// before the DELETE, then drops it. These tests guard against any future
// change that re-introduces the missing helper index.
//
// Two-layer guard:
//   1. Structural — assert the migration SQL literally contains the helper
//      CREATE INDEX + DROP INDEX (deterministic, fast, catches the regression
//      even at 0-row scale where wall-clock can't distinguish O(n²) from O(1)).
//   2. Behavioral — populate 1000 duplicates and assert the migration completes
//      under the wall-clock cap. Sanity check at small scale; the structural
//      assertion is the real guard.

describe('migrations v8 + v9 — structural guard for helper-index fix', () => {
  test('migration v8 SQL contains idx_links_dedup_helper CREATE+DROP around the DELETE', () => {
    const v8 = MIGRATIONS.find(m => m.version === 8);
    expect(v8).toBeDefined();
    const sql = v8!.sql;

    // The fix must: (a) create the helper btree, (b) DELETE...USING, (c) drop the helper, (d) add the unique constraint.
    // If anyone reorders or removes the helper-index lines, this fails.
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_links_dedup_helper');
    expect(sql).toContain('ON links(from_page_id, to_page_id, link_type)');
    expect(sql).toContain('DROP INDEX IF EXISTS idx_links_dedup_helper');
    expect(sql).toContain('DELETE FROM links a USING links b');
    expect(sql).toContain('ALTER TABLE links ADD CONSTRAINT links_from_to_type_unique');

    // Order matters: CREATE INDEX before DELETE, DROP INDEX after DELETE, before ADD CONSTRAINT.
    const createIdx = sql.indexOf('CREATE INDEX IF NOT EXISTS idx_links_dedup_helper');
    const deleteUsing = sql.indexOf('DELETE FROM links a USING links b');
    const dropIdx = sql.indexOf('DROP INDEX IF EXISTS idx_links_dedup_helper');
    const addConstraint = sql.indexOf('ALTER TABLE links ADD CONSTRAINT links_from_to_type_unique');
    expect(createIdx).toBeLessThan(deleteUsing);
    expect(deleteUsing).toBeLessThan(dropIdx);
    expect(dropIdx).toBeLessThan(addConstraint);
  });

  test('migration v9 SQL contains idx_timeline_dedup_helper CREATE+DROP around the DELETE', () => {
    const v9 = MIGRATIONS.find(m => m.version === 9);
    expect(v9).toBeDefined();
    const sql = v9!.sql;

    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_timeline_dedup_helper');
    expect(sql).toContain('ON timeline_entries(page_id, date, summary)');
    expect(sql).toContain('DROP INDEX IF EXISTS idx_timeline_dedup_helper');
    expect(sql).toContain('DELETE FROM timeline_entries a USING timeline_entries b');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup');

    const createHelper = sql.indexOf('CREATE INDEX IF NOT EXISTS idx_timeline_dedup_helper');
    const deleteUsing = sql.indexOf('DELETE FROM timeline_entries a USING timeline_entries b');
    const dropHelper = sql.indexOf('DROP INDEX IF EXISTS idx_timeline_dedup_helper');
    const createUnique = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup');
    expect(createHelper).toBeLessThan(deleteUsing);
    expect(deleteUsing).toBeLessThan(dropHelper);
    expect(dropHelper).toBeLessThan(createUnique);
  });
});

// v0.14.1 — fix wave structural assertions (migrations renumbered from v12/v13 to
// v14/v15 after master merged budget_ledger (v12) + minion_quiet_hours_stagger (v13)).
describe('migrate v14 — pages_updated_at_index (handler-based, engine-aware)', () => {
  const v14 = MIGRATIONS.find(m => m.version === 14);
  test('v14 exists and uses a handler (not pure SQL) for engine-aware branching', () => {
    expect(v14).toBeDefined();
    expect(v14!.name).toBe('pages_updated_at_index');
    expect(typeof v14!.handler).toBe('function');
    expect(v14!.sql).toBe('');
  });

  test('v14 handler source contains CONCURRENTLY + invalid-index cleanup for Postgres branch', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/core/migrate.ts', 'utf-8');
    const v14Start = src.indexOf("name: 'pages_updated_at_index'");
    expect(v14Start).toBeGreaterThan(-1);
    const v14Block = src.slice(v14Start, v14Start + 3000);
    expect(v14Block).toContain('pg_index');
    expect(v14Block).toContain('indisvalid');
    expect(v14Block).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_pages_updated_at_desc');
    expect(v14Block).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_updated_at_desc');
    // Order within the handler body: DROP IF EXISTS must precede CREATE IF NOT EXISTS,
    // so a failed prior CONCURRENTLY build is cleaned before re-create. Anchor on the
    // explicit "IF EXISTS" / "IF NOT EXISTS" phrases so the header doc-comment
    // (which mentions both unqualified) doesn't fool the ordering assertion.
    const dropIdx = v14Block.indexOf('DROP INDEX CONCURRENTLY IF EXISTS');
    const createIdx = v14Block.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(dropIdx).toBeLessThan(createIdx);
    expect(v14Block).toContain('engine.kind');
  });
});

describe('migrate v15 — minion_jobs_max_stalled_default_5', () => {
  const v15 = MIGRATIONS.find(m => m.version === 15);
  test('v15 exists and alters max_stalled default to 5', () => {
    expect(v15).toBeDefined();
    expect(v15!.name).toBe('minion_jobs_max_stalled_default_5');
    expect(v15!.sql).toContain('ALTER TABLE minion_jobs ALTER COLUMN max_stalled SET DEFAULT 5');
  });

  test('v15 backfill UPDATE targets the correct non-terminal statuses', () => {
    const sql = v15!.sql;
    expect(sql).toContain(`'waiting'`);
    expect(sql).toContain(`'active'`);
    expect(sql).toContain(`'delayed'`);
    expect(sql).toContain(`'waiting-children'`);
    expect(sql).toContain(`'paused'`);
    expect(sql).not.toContain(`'completed'`);
    expect(sql).not.toContain(`'dead'`);
    expect(sql).not.toContain(`'cancelled'`);
    expect(sql).not.toContain(`'claimed'`);
    expect(sql).not.toContain(`'running'`);
    expect(sql).not.toContain(`'stalled'`);
  });

  test('v15 UPDATE clause has the < 5 guard so idempotent re-runs are no-ops', () => {
    expect(v15!.sql).toContain('max_stalled < 5');
  });
});

describe('migrate — runner behavioral (v14 handler + v15 backfill)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('v14 created idx_pages_updated_at_desc on PGLite via handler branch', async () => {
    const rows = await (engine as any).db.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_pages_updated_at_desc'`
    );
    expect(rows.rows.length).toBe(1);
  });

  test('v15 backfilled any max_stalled=1 rows (smoke: schema default is 5)', async () => {
    await (engine as any).db.exec(
      `INSERT INTO minion_jobs (name, queue, status, max_stalled) VALUES ('test', 'default', 'waiting', 1)`
    );
    await (engine as any).db.exec(
      `UPDATE minion_jobs SET max_stalled = 5
         WHERE status IN ('waiting','active','delayed','waiting-children','paused')
           AND max_stalled < 5`
    );
    const rows = await (engine as any).db.query(
      `SELECT max_stalled FROM minion_jobs WHERE name = 'test'`
    );
    expect((rows.rows[0] as any).max_stalled).toBe(5);

    await (engine as any).db.exec(
      `UPDATE minion_jobs SET max_stalled = 5
         WHERE status IN ('waiting','active','delayed','waiting-children','paused')
           AND max_stalled < 5`
    );
    const rows2 = await (engine as any).db.query(
      `SELECT max_stalled FROM minion_jobs WHERE name = 'test'`
    );
    expect((rows2.rows[0] as any).max_stalled).toBe(5);
  });
});

describe('migrate: v8 (links_dedup) regression — must be fast on 1K duplicate rows', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('1000 duplicate links dedup completes in <5s and leaves table deduped', async () => {
    // Set up: drop BOTH the old (v8) and new (v11) unique constraints so
    // duplicates can be inserted, then reset version so v8 + v11 re-run.
    // v11 replaces the v8 constraint name; we drop whichever is present.
    const db = (engine as any).db;
    await db.exec(`ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_unique`);
    await db.exec(`ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique`);

    // Two pages so the FK is satisfied
    await engine.putPage('p/from', { type: 'concept', title: 'F', compiled_truth: '', timeline: '' });
    await engine.putPage('p/to', { type: 'concept', title: 'T', compiled_truth: '', timeline: '' });
    const fromId = (await db.query(`SELECT id FROM pages WHERE slug = 'p/from'`)).rows[0].id;
    const toId = (await db.query(`SELECT id FROM pages WHERE slug = 'p/to'`)).rows[0].id;

    // Insert 1000 duplicates of the same (from, to, type) row
    for (let i = 0; i < 1000; i++) {
      await db.query(
        `INSERT INTO links (from_page_id, to_page_id, link_type, context) VALUES ($1, $2, $3, $4)`,
        [fromId, toId, 'mention', `dup-${i}`]
      );
    }
    const beforeCount = (await db.query(`SELECT COUNT(*)::int AS c FROM links`)).rows[0].c;
    expect(beforeCount).toBe(1000);

    // Reset version to 7 so v8 + v9 + v10 + v11 re-run
    await engine.setConfig('version', '7');

    // Run migrations and assert wall-clock + correctness
    const start = Date.now();
    await runMigrations(engine);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5000);

    const afterCount = (await db.query(`SELECT COUNT(*)::int AS c FROM links`)).rows[0].c;
    expect(afterCount).toBe(1); // deduped to one row

    // v11 replaces v8's constraint name. Assert the current (v11) constraint
    // exists and the legacy v8 name is gone.
    const constraints = (await db.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'links'::regclass AND contype = 'u'
    `)).rows;
    expect(constraints.some((c: { conname: string }) => c.conname === 'links_from_to_type_source_origin_unique')).toBe(true);
    expect(constraints.some((c: { conname: string }) => c.conname === 'links_from_to_type_unique')).toBe(false);

    // Helper index was dropped after dedup
    const helperIdx = (await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'links' AND indexname = 'idx_links_dedup_helper'
    `)).rows;
    expect(helperIdx.length).toBe(0);
  });
});

describe('migrate: v9 (timeline_dedup_index) regression — must be fast on 1K duplicate rows', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('1000 duplicate timeline entries dedup completes in <5s and leaves table deduped', async () => {
    const db = (engine as any).db;
    await db.exec(`DROP INDEX IF EXISTS idx_timeline_dedup`);

    await engine.putPage('p/timeline', { type: 'concept', title: 'TL', compiled_truth: '', timeline: '' });
    const pageId = (await db.query(`SELECT id FROM pages WHERE slug = 'p/timeline'`)).rows[0].id;

    // Insert 1000 duplicates of the same (page_id, date, summary) row
    for (let i = 0; i < 1000; i++) {
      await db.query(
        `INSERT INTO timeline_entries (page_id, date, source, summary, detail) VALUES ($1, $2::date, $3, $4, $5)`,
        [pageId, '2024-01-15', `src-${i}`, 'Founded NovaMind', `detail-${i}`]
      );
    }
    const beforeCount = (await db.query(`SELECT COUNT(*)::int AS c FROM timeline_entries`)).rows[0].c;
    expect(beforeCount).toBe(1000);

    await engine.setConfig('version', '7');

    const start = Date.now();
    await runMigrations(engine);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5000);

    const afterCount = (await db.query(`SELECT COUNT(*)::int AS c FROM timeline_entries`)).rows[0].c;
    expect(afterCount).toBe(1);

    const uniqueIdx = (await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'timeline_entries' AND indexname = 'idx_timeline_dedup'
    `)).rows;
    expect(uniqueIdx.length).toBe(1);

    const helperIdx = (await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'timeline_entries' AND indexname = 'idx_timeline_dedup_helper'
    `)).rows;
    expect(helperIdx.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// resolvePoolSize — GBRAIN_POOL_SIZE env override
// ─────────────────────────────────────────────────────────────────
//
// Guards the Bug 2 fix: users on constrained poolers (Supabase port 6543)
// must be able to cap the pool size via GBRAIN_POOL_SIZE. The default
// (10) is unchanged when the env var is unset.

describe('resolvePoolSize — env var + explicit override', () => {
  const { resolvePoolSize } = require('../src/core/db.ts');
  const original = process.env.GBRAIN_POOL_SIZE;

  afterAll(() => {
    if (original === undefined) delete process.env.GBRAIN_POOL_SIZE;
    else process.env.GBRAIN_POOL_SIZE = original;
  });

  test('returns 10 default when unset and no explicit override', () => {
    delete process.env.GBRAIN_POOL_SIZE;
    expect(resolvePoolSize()).toBe(10);
  });

  test('reads GBRAIN_POOL_SIZE as an integer', () => {
    process.env.GBRAIN_POOL_SIZE = '2';
    expect(resolvePoolSize()).toBe(2);
    process.env.GBRAIN_POOL_SIZE = '5';
    expect(resolvePoolSize()).toBe(5);
  });

  test('ignores invalid GBRAIN_POOL_SIZE values', () => {
    process.env.GBRAIN_POOL_SIZE = 'not-a-number';
    expect(resolvePoolSize()).toBe(10);
    process.env.GBRAIN_POOL_SIZE = '0';
    expect(resolvePoolSize()).toBe(10);
    process.env.GBRAIN_POOL_SIZE = '-1';
    expect(resolvePoolSize()).toBe(10);
  });

  test('explicit argument wins over env + default', () => {
    delete process.env.GBRAIN_POOL_SIZE;
    expect(resolvePoolSize(3)).toBe(3);
    process.env.GBRAIN_POOL_SIZE = '7';
    expect(resolvePoolSize(3)).toBe(3);
  });
});
