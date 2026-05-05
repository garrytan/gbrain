/**
 * Wipe per-test data on a connected PGLite engine without dropping the schema.
 * Used by tests that share one engine across the file (beforeAll) and need a
 * clean slate per test (beforeEach).
 *
 * Why this exists: PGLite WASM cold-start + initSchema() is ~20s on CI runners.
 * Spinning up a fresh engine per test (the prior beforeEach pattern) multiplies
 * that across every test in every file. Sharing one engine and wiping data
 * is two orders of magnitude faster.
 *
 * Canonical block (copy verbatim into PGLite-using test files; enforced by
 * scripts/check-test-isolation.sh rules R3 + R4):
 *
 *   import { PGLiteEngine } from '../src/core/pglite-engine.ts';
 *   import { resetPgliteState } from './helpers/reset-pglite.ts';
 *
 *   let engine: PGLiteEngine;
 *
 *   beforeAll(async () => {
 *     engine = new PGLiteEngine();
 *     await engine.connect({});
 *     await engine.initSchema();
 *   });
 *
 *   afterAll(async () => {
 *     await engine.disconnect();
 *   });
 *
 *   beforeEach(async () => {
 *     await resetPgliteState(engine);
 *   });
 *
 * Why this exact shape:
 *   - `beforeAll` creates one engine per file (~20s schema init paid once).
 *   - `beforeEach` resets user data without re-creating the engine.
 *   - `afterAll(disconnect)` is REQUIRED. The v0.26.4 parallel runner loads
 *     multiple test files into one bun process per shard; without disconnect,
 *     engines leak across file boundaries within a shard process.
 *
 * Implementation:
 *   1. TRUNCATE every public table CASCADE, including `sources` (so tests
 *      that register their own sources don't leak rows into the next test).
 *   2. Re-seed the default source row that pages.source_id's DEFAULT FKs
 *      against. Without this, the next page insert would fail FK validation.
 *   3. Preserve `schema_version` — it carries the migration ledger that
 *      initSchema() populates; wiping it would make migration helpers think
 *      the brain is on v0.
 *
 * Identifier-quoted defensively against pathological table names.
 */
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const PRESERVE_TABLES = new Set(['schema_version']);

export async function resetPgliteState(engine: PGLiteEngine): Promise<void> {
  const rows = await engine.executeRaw<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
  );
  const targets = rows
    .map(r => r.tablename)
    .filter(name => !PRESERVE_TABLES.has(name));
  if (targets.length === 0) return;
  const quoted = targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ');
  await engine.executeRaw(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
  // Re-seed the default source row that initSchema() inserts. Mirrors the
  // INSERT in src/core/pglite-schema.ts so the FK target survives reset.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ('default', 'default', '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
  );
}
