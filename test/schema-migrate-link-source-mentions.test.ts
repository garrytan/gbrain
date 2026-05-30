/**
 * Regression tests for migration v95 (link_source CHECK widening).
 *
 * Pins three contracts:
 *   1. Fresh-init brain accepts link_source='mentions' (schema-embedded.ts
 *      + pglite-schema.ts widened CHECK is the source of truth for fresh
 *      installs).
 *   2. Migration v95 is registered with the expected name + shape.
 *   3. Migration v95 is idempotent — re-running on an already-migrated
 *      brain is a no-op (the DROP IF EXISTS + ADD CONSTRAINT pattern).
 *
 * Hermetic via PGLite. No DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';

const MIGRATION_VERSION = 95;
const MIGRATION_NAME = 'links_link_source_check_includes_mentions';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('migration v95 — links_link_source_check_includes_mentions', () => {
  test('registered with expected version + name', () => {
    const m = MIGRATIONS.find(m => m.version === MIGRATION_VERSION);
    expect(m).toBeDefined();
    expect(m!.name).toBe(MIGRATION_NAME);
  });

  test('LATEST_VERSION >= 95 so the migration is part of canonical sequence', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(MIGRATION_VERSION);
  });

  test('SQL shape — widens CHECK to include all 4 source values', () => {
    const m = MIGRATIONS.find(m => m.version === MIGRATION_VERSION)!;
    const sql = (m.sql || '') + ' ' + ((m.sqlFor?.pglite as string) || '');
    expect(sql).toContain("'mentions'");
    expect(sql).toContain("'markdown'");
    expect(sql).toContain("'frontmatter'");
    expect(sql).toContain("'manual'");
    // DROP IF EXISTS pattern for re-runnability
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS links_link_source_check/i);
  });

  test('PGLite branch present (engine parity)', () => {
    const m = MIGRATIONS.find(m => m.version === MIGRATION_VERSION)!;
    expect(m.sqlFor?.pglite).toBeDefined();
    expect(m.sqlFor!.pglite!.length).toBeGreaterThan(0);
  });
});

describe('fresh-init brain (post-migration v95) accepts link_source=mentions', () => {
  test('two pages can be linked with link_source=mentions', async () => {
    const slugA = `mentions-source-${Math.random().toString(36).slice(2, 8)}`;
    const slugB = `mentions-target-${Math.random().toString(36).slice(2, 8)}`;
    await engine.putPage(slugA, {
      type: 'note',
      title: 'A',
      compiled_truth: 'a body',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage(slugB, {
      type: 'person',
      title: 'B',
      compiled_truth: 'b body',
      timeline: '',
      frontmatter: {},
    });
    await engine.addLinksBatch([
      {
        from_slug: slugA,
        to_slug: slugB,
        link_type: 'mentions',
        link_source: 'mentions',
        context: 'auto-link test',
      },
    ]);
    const rows = await engine.executeRaw<{ link_source: string }>(
      `SELECT l.link_source
       FROM links l
       JOIN pages p ON p.id = l.from_page_id
       WHERE p.slug = $1`,
      [slugA],
    );
    expect(rows.some(r => r.link_source === 'mentions')).toBe(true);
  });

  test('CHECK still rejects an unknown source value (widening did not nullify the gate)', async () => {
    const slugA = `bad-source-a-${Math.random().toString(36).slice(2, 8)}`;
    const slugB = `bad-source-b-${Math.random().toString(36).slice(2, 8)}`;
    await engine.putPage(slugA, { type: 'note', title: 'A', compiled_truth: 'a', timeline: '', frontmatter: {} });
    await engine.putPage(slugB, { type: 'person', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: {} });
    // 'inferred' is NOT in allow-list ∪ {'mentions'} — must reject.
    await expect(
      engine.addLinksBatch([
        {
          from_slug: slugA,
          to_slug: slugB,
          link_type: 'mentions',
          link_source: 'inferred' as any,
          context: 'should reject',
        },
      ]),
    ).rejects.toThrow();
  });

  test('idempotent re-application via runMigration — DROP IF EXISTS + ADD pattern survives second run', async () => {
    const m = MIGRATIONS.find(m => m.version === MIGRATION_VERSION)!;
    const pgliteSql = m.sqlFor!.pglite!;
    // runMigration uses engine.db.exec which handles multi-statement SQL,
    // unlike executeRaw which goes through db.query (single statement only).
    await expect(engine.runMigration(MIGRATION_VERSION, pgliteSql)).resolves.toBeUndefined();
    // Insert with link_source='mentions' must still work after re-running.
    const slugA = `idem-a-${Math.random().toString(36).slice(2, 8)}`;
    const slugB = `idem-b-${Math.random().toString(36).slice(2, 8)}`;
    await engine.putPage(slugA, { type: 'note', title: 'A', compiled_truth: 'a', timeline: '', frontmatter: {} });
    await engine.putPage(slugB, { type: 'company', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: {} });
    await engine.addLinksBatch([
      { from_slug: slugA, to_slug: slugB, link_type: 'mentions', link_source: 'mentions', context: '' },
    ]);
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM links l
       JOIN pages p ON p.id = l.from_page_id
       WHERE p.slug = $1 AND l.link_source = 'mentions'`,
      [slugA],
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});
