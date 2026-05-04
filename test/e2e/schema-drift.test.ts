/**
 * E2E schema drift gate (issue #588, v0.26.3).
 *
 * Spins up a fresh PGLite instance and a fresh Postgres database, runs each
 * engine's `initSchema()` end-to-end (bootstrap + schema replay + migrations),
 * snapshots `information_schema.columns` from both, then diffs the snapshots
 * via the pure helper in `test/helpers/schema-diff.ts`.
 *
 * Catches the v0.26.1 bug class: someone adds columns to one engine path
 * (raw schema.sql, raw pglite-schema.ts, or a sqlFor branch in a migration)
 * but forgets the other side. Both engines must produce the same end-state.
 *
 * Out of scope: detecting "manual ALTER TABLE on production Postgres that
 * never made it into source files" (the actual v0.26.1 trigger). That
 * requires comparing prod's information_schema against source — a separate
 * `gbrain doctor --schema-audit` mechanism deferred to v0.26.4.
 *
 * Skips gracefully when DATABASE_URL is unset (matches the existing E2E
 * pattern in test/e2e/postgres-bootstrap.test.ts and test/e2e/postgres-jsonb.test.ts).
 *
 * Run: DATABASE_URL=postgresql://... bun test test/e2e/schema-drift.test.ts
 *  Or: bun run ci:local  (the full Docker-backed gate)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  type SchemaSnapshot,
  type SnapshotQueryRow,
  snapshotSchema,
  diffSnapshots,
  formatDiffForFailure,
  isCleanDiff,
} from '../helpers/schema-diff.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  console.log('Skipping E2E schema drift gate (DATABASE_URL not set)');
}

// Tier 3 opt-out: this file constructs a fresh in-memory PGLite to compare
// against fresh Postgres. If GBRAIN_PGLITE_SNAPSHOT is set (ci:local sets it
// for unit shards), PGLite would boot post-initSchema with a snapshot — fine
// for the comparison, but we want the canonical path here.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

/**
 * Tables that exist in src/schema.sql but are intentionally absent from
 * src/core/pglite-schema.ts (and from the migrations chain on the PGLite
 * side). Whenever something is added to this list, add an inline reason.
 */
const PG_ONLY_TABLES = [
  // Legacy file-storage tables. PGLite brains never adopted the embedded
  // `files` table; storage tiering on PGLite is filesystem-only.
  'files',
  'file_migration_ledger',
];

describe.skipIf(skip)('schema drift: PGLite ↔ Postgres post-initSchema parity (E2E)', () => {
  let pglite: PGLiteEngine;
  let pg: PostgresEngine;
  let pgliteSnap: SchemaSnapshot;
  let pgSnap: SchemaSnapshot;

  beforeAll(async () => {
    // PGLite side: in-memory, run the canonical initSchema.
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();

    // Postgres side: connect to the test database, run the canonical initSchema.
    // The test container at `bun run ci:local` provides a fresh DB; outside that
    // path we rely on the caller having set DATABASE_URL to a fresh DB.
    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    await pg.initSchema();

    // Snapshot both. PGLite returns `{rows}`, postgres.js returns the array.
    const pgliteDb = (pglite as any).db;
    pgliteSnap = await snapshotSchema(async (sql) => {
      const r = await pgliteDb.query(sql);
      return r.rows as SnapshotQueryRow[];
    });

    const pgConn = (pg as any).sql;
    pgSnap = await snapshotSchema(async (sql) => {
      const r = await pgConn.unsafe(sql);
      return r as unknown as SnapshotQueryRow[];
    });
  }, 60_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    if (pg) await pg.disconnect();
  });

  test('post-initSchema schemas are equivalent (modulo allowlist)', () => {
    const diff = diffSnapshots(pgSnap, pgliteSnap, { allowlistPgOnlyTables: PG_ONLY_TABLES });
    if (!isCleanDiff(diff)) {
      throw new Error(`Schema drift detected:\n${formatDiffForFailure(diff)}`);
    }
    expect(isCleanDiff(diff)).toBe(true);
  });

  // Sentinel cases. Each is the v0.26.1 bug class for one specific table.
  // Failing here gives a tighter blame message than the global parity test.
  for (const sentinel of ['oauth_clients', 'mcp_request_log', 'access_tokens', 'eval_candidates']) {
    test(`regression #588: ${sentinel} columns match across engines`, () => {
      const pgCols = pgSnap.get(sentinel);
      const pgliteCols = pgliteSnap.get(sentinel);
      expect(pgCols, `${sentinel} missing from Postgres post-initSchema`).toBeDefined();
      expect(pgliteCols, `${sentinel} missing from PGLite post-initSchema`).toBeDefined();
      const diff = diffSnapshots(
        new Map([[sentinel, pgCols!]]),
        new Map([[sentinel, pgliteCols!]]),
        { allowlistPgOnlyTables: [] },
      );
      if (!isCleanDiff(diff)) {
        throw new Error(`Drift on ${sentinel}:\n${formatDiffForFailure(diff)}`);
      }
    });
  }

  test('Postgres-only tables on the allowlist are still absent from PGLite', () => {
    // Defensive: if someone adds `files` to PGLite without removing it from
    // the allowlist, we want to know — the allowlist would silently shadow
    // a real divergence in coverage policy.
    for (const t of PG_ONLY_TABLES) {
      expect(pgSnap.has(t), `${t} should be in Postgres schema`).toBe(true);
      expect(pgliteSnap.has(t), `${t} unexpectedly added to PGLite — remove from allowlist`).toBe(false);
    }
  });
});
