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
  type IndexSnapshot,
  type IndexSnapshotRow,
  snapshotSchema,
  diffSnapshots,
  formatDiffForFailure,
  isCleanDiff,
  snapshotIndexes,
  diffIndexSnapshots,
  isCleanIndexDiff,
  formatIndexDiffForFailure,
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
 *
 * v0.27.1: `files` removed from this list — multimodal ingestion needed
 * binary-asset metadata on PGLite, and migration v36 adds the table on
 * the PGLite side mirroring the Postgres v0.18 shape verbatim. Now a
 * parity-required table on both engines.
 */
const PG_ONLY_TABLES = [
  // file_migration_ledger drives the v0.18 storage-object rewrite on
  // Postgres. PGLite never had blob storage so the ledger has no consumer.
  'file_migration_ledger',
];

/**
 * Index names that exist on exactly one engine on purpose. Same discipline as
 * PG_ONLY_TABLES: every entry carries an inline reason, and the defensive test
 * below fails if an entry stops being one-sided (a stale allowlist row would
 * silently shadow future drift).
 */
const INDEX_ALLOWLIST: string[] = [
  // Lives on file_migration_ledger, which is on PG_ONLY_TABLES above (PGLite
  // never had blob storage, so neither the table nor its index exist there).
  'idx_file_migration_ledger_status',
  // Migration 76 creates this partial GIN on minion_jobs.data on Postgres only
  // (sqlFor.pglite is deliberately empty): PGLite's single-host doctor audit
  // query is fine with a sequential scan, per the migration's own comment.
  'minion_jobs_doctor_run_id_idx',
];

describe.skipIf(skip)('schema drift: PGLite ↔ Postgres post-initSchema parity (E2E)', () => {
  let pglite: PGLiteEngine;
  let pg: PostgresEngine;
  let pgliteSnap: SchemaSnapshot;
  let pgSnap: SchemaSnapshot;
  let pgliteIdxSnap: IndexSnapshot;
  let pgIdxSnap: IndexSnapshot;

  beforeAll(async () => {
    // PGLite side: in-memory, run the canonical initSchema.
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();

    // Postgres side: ensure the test database is FRESH before initSchema.
    // v0.37.2.0 fix: previously the test trusted the caller to pass a fresh
    // DATABASE_URL, but `gbrain doctor` (used by the CLAUDE.md E2E bootstrap
    // ritual) populates `content_chunks.model DEFAULT` from the configured
    // gateway model. On a re-run, `CREATE TABLE IF NOT EXISTS` is a no-op so
    // the stale default sticks while PGLite (always fresh-in-memory) gets the
    // engine fallback. That produced a phantom drift unrelated to schema
    // parity.
    //
    // SAFETY GATE (codex P0, tightened in v0.37.2.0): DROP SCHEMA public CASCADE is
    // destructive. The db name MUST always look test-shaped — no env-var override
    // bypasses that floor. GBRAIN_TEST_DB=1 only relaxes the localhost requirement
    // so CI environments where the host is a service name (e.g. "postgres") can
    // still reset. If the db name doesn't match the test pattern, nothing nukes it.
    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    const pgConnPre = (pg as any).sql;

    const url = new URL(DATABASE_URL!);
    const dbName = url.pathname.replace(/^\//, '');
    const host = url.hostname;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
    // db-name pattern is the floor: gbrain_test, *_test, test_*, *_e2e.
    // Required REGARDLESS of any override — a production db named "production_data"
    // cannot be reset even with GBRAIN_TEST_DB=1.
    const looksLikeTestDb = /^(gbrain_test|.*_test|test_.*|.*_e2e)$/i.test(dbName);
    const ciOptIn = process.env.GBRAIN_TEST_DB === '1';
    // resetAllowed semantics: db name is test-shaped AND (localhost OR ci-opt-in).
    // Neither host nor env-var alone is sufficient.
    const resetAllowed = looksLikeTestDb && (isLocalhost || ciOptIn);

    if (resetAllowed) {
      await pgConnPre.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    } else {
      // Surface a loud, paste-ready hint. The test will still try initSchema;
      // if the caller already had a fresh DB the parity check passes anyway.
      const reason = !looksLikeTestDb
        ? `db name "${dbName}" doesn't match the test pattern (gbrain_test, *_test, test_*, *_e2e). ` +
          `GBRAIN_TEST_DB=1 does NOT override this — db name is the hard floor.`
        : `host="${host}" is non-local AND GBRAIN_TEST_DB=1 is not set. ` +
          `Set GBRAIN_TEST_DB=1 to allow non-local hosts (e.g. CI service names) — ` +
          `but only when the db name is already test-shaped.`;
      console.warn(`[schema-drift] Skipping DROP SCHEMA — ${reason}`);
    }

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

    // Index snapshots (plan D1): same engines, pg_catalog-based helper query.
    pgliteIdxSnap = await snapshotIndexes(async (sql) => {
      const r = await pgliteDb.query(sql);
      return r.rows as IndexSnapshotRow[];
    });
    pgIdxSnap = await snapshotIndexes(async (sql) => {
      const r = await pgConn.unsafe(sql);
      return r as unknown as IndexSnapshotRow[];
    });
  }, 60_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    if (pg) await pg.disconnect();
  }, 30_000);

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

  // ─── plan D1 — index parity ─────────────────────────────────────────
  // The column-level drift gate above stays green when an index lands on one
  // engine but not the other (the v0.34 W4-5 class: hot-path composite index
  // silently missing on one side). snapshotIndexes/diffIndexSnapshots have
  // existed in test/helpers/schema-diff.ts since v0.34 D7 but were never wired
  // to real engines until now.
  describe('index parity: PGLite ↔ Postgres post-initSchema (plan D1)', () => {
    test('post-initSchema index sets are equivalent (modulo allowlist)', () => {
      const diff = diffIndexSnapshots(pgIdxSnap, pgliteIdxSnap, { allowlist: INDEX_ALLOWLIST });
      if (!isCleanIndexDiff(diff)) {
        throw new Error(`Index drift detected:\n${formatIndexDiffForFailure(diff)}`);
      }
      expect(isCleanIndexDiff(diff)).toBe(true);
    });

    test('allowlisted indexes are still one-sided (Postgres-only)', () => {
      // Defensive mirror of the PG_ONLY_TABLES test: a stale allowlist entry
      // would silently shadow real drift on that index forever.
      for (const name of INDEX_ALLOWLIST) {
        expect(pgIdxSnap.has(name), `${name} should exist on Postgres`).toBe(true);
        expect(pgliteIdxSnap.has(name), `${name} unexpectedly added to PGLite — remove from INDEX_ALLOWLIST`).toBe(false);
      }
    });

    // The three ON-CONFLICT-load-bearing unique indexes. Each backs an
    // `ON CONFLICT` target in a write path; if one goes missing (or loses its
    // predicate/expression), those writes start throwing 42P10 at runtime.
    // Assert them by their REAL names with a direct pg_indexes query per
    // engine so a failure names the exact engine and the exact index.
    const ON_CONFLICT_INDEXES: Array<{
      name: string;
      table: string;
      /** Substrings that must appear in the whitespace-normalized, lowercased indexdef. */
      defMust: string[];
    }> = [
      {
        // take-proposal idempotency (migration 125 / schema.sql): unique
        // EXPRESSION index — per-claim via md5(claim_text), no WHERE clause.
        name: 'take_proposals_idempotency_idx',
        table: 'take_proposals',
        defMust: [
          'create unique index',
          '(source_id, page_slug, content_hash, prompt_version, md5(claim_text))',
        ],
      },
      {
        // Life Chronicle event-projection dedup: partial unique on
        // (event_page_id, date) WHERE event_page_id IS NOT NULL.
        name: 'idx_timeline_event_dedup',
        table: 'timeline_entries',
        defMust: [
          'create unique index',
          '(event_page_id, date)',
          'where (event_page_id is not null)',
        ],
      },
      {
        // Facts ontology dedup (migration 122): partial unique keyed on the
        // deterministic value_hash, scoped WHERE dimension IS NOT NULL.
        name: 'idx_facts_ontology_dedup',
        table: 'facts',
        defMust: [
          'create unique index',
          '(source_id, entity_slug, dimension, value_hash, source_markdown_slug)',
          'where (dimension is not null)',
        ],
      },
    ];

    /** Match the diff helper's normalization: collapse whitespace, lowercase. */
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

    for (const idx of ON_CONFLICT_INDEXES) {
      test(`ON-CONFLICT index ${idx.name} exists with the right shape on both engines`, async () => {
        const sql = `
          SELECT indexname, tablename, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = '${idx.name}'
        `;
        const pgliteDb = (pglite as any).db;
        const pgConn = (pg as any).sql;
        const engines: Array<{ label: string; rows: Array<{ indexname: string; tablename: string; indexdef: string }> }> = [
          { label: 'Postgres', rows: (await pgConn.unsafe(sql)) as any },
          { label: 'PGLite', rows: (await pgliteDb.query(sql)).rows as any },
        ];
        for (const { label, rows } of engines) {
          expect(rows.length, `${idx.name} missing from ${label} pg_indexes`).toBe(1);
          const row = rows[0]!;
          expect(row.tablename, `${idx.name} on wrong table on ${label}`).toBe(idx.table);
          const def = norm(row.indexdef);
          for (const must of idx.defMust) {
            if (!def.includes(must)) {
              throw new Error(
                `${label}: ${idx.name} indexdef is missing "${must}".\n  Actual: ${row.indexdef}`,
              );
            }
          }
        }
      });
    }
  });
});
