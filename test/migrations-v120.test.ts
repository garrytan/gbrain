import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';

// v120 page_links_view_security_invoker — close the RLS bypass on the
// page_links view.
//
// Pinned contracts:
// 1. Migration v120 exists in MIGRATIONS with the canonical name.
// 2. The migration SQL flips the view to security_invoker (the actual fix).
// 3. After initSchema() on a fresh PGLite brain, the page_links view carries
//    reloption security_invoker=on (so it honors the caller's RLS instead of
//    reading the RLS-protected links table as the view owner).
// 4. The view still projects the same narrow (id, from_page_id, to_page_id)
//    shape the engine queries depend on — the security fix must not change
//    the view's columns.

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('v120: page_links_view_security_invoker', () => {
  test('v120 exists in MIGRATIONS with canonical name', () => {
    const v120 = MIGRATIONS.find(m => m.version === 120);
    expect(v120).toBeDefined();
    expect(v120?.name).toBe('page_links_view_security_invoker');
  });

  test('LATEST_VERSION >= 120', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(120);
  });

  test('migration SQL sets security_invoker on the view', () => {
    const v120 = MIGRATIONS.find(m => m.version === 120);
    // engine-agnostic sql (runs identically on Postgres + PGLite)
    expect(v120?.sql).toContain('security_invoker = on');
    expect(v120?.sql).toContain('CREATE OR REPLACE VIEW page_links');
  });

  test('page_links view carries security_invoker=on after initSchema()', async () => {
    const rows = await engine.executeRaw<{ reloptions: string[] | null }>(
      `SELECT c.reloptions AS reloptions
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'page_links' AND c.relkind = 'v'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].reloptions ?? []).toContain('security_invoker=on');
  });

  test('view still projects the narrow (id, from_page_id, to_page_id) shape', async () => {
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'page_links'
        ORDER BY ordinal_position`
    );
    expect(cols.map(c => c.column_name)).toEqual([
      'id',
      'from_page_id',
      'to_page_id',
    ]);
  });
});
