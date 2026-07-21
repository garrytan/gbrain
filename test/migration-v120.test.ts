/**
 * Migration v120 — schema-lint hardening (#1647 / #171).
 *
 * Validates the search_path pin lands on the PGLite trigger functions and that
 * the migration is idempotent. (PGLite is Postgres 17.5, so this also
 * empirically confirms `ALTER FUNCTION ... SET search_path` runs on PGLite —
 * the engine-asymmetry concern from the eng-review codex pass.) The
 * security_invoker + auto_enable_rls assertions are Postgres-only and live in
 * the Postgres bootstrap E2E.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

describe('migration v120 — search_path hardening', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema(); // applies all migrations through LATEST_VERSION (incl. v120)
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('PGLite trigger functions carry SET search_path after migrations', async () => {
    const rows = await engine.executeRaw<{ proname: string; proconfig: unknown }>(
      `SELECT p.proname, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('bump_page_generation_fn','bump_page_generation_clock_fn','update_page_search_vector')`,
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      // proconfig is a text[] like {search_path=pg_catalog, public}; coerce to a
      // string so the assertion is robust to driver array shape.
      expect(JSON.stringify(r.proconfig ?? [])).toContain('search_path=');
    }
  }, 30000);

  test('re-running migrations after initSchema is idempotent (0 applied, no error)', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
  }, 30000);
});
