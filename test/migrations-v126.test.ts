/**
 * v0.45.7 ambient recall (issue #1) — migration v126 (session_context_state).
 *
 * Pinned contracts:
 * 1. Migration v126 exists in the MIGRATIONS array with the canonical name
 *    and is flagged idempotent.
 * 2. Table created cleanly via initSchema() on PGLite, with the exact column
 *    set/types, client_id DEFAULT 'local', jsonb '[]' literal defaults, and
 *    nullable last_wake_at.
 * 3. Composite PK (source_id, client_id, session_id) — rejects a duplicate
 *    triple; same (source_id, session_id) under a DIFFERENT client_id
 *    coexists (the eng-1B two-harnesses-one-source isolation property).
 * 4. session_context_state_updated_idx present for the updated_at prune scan.
 * 5. Upgrade path: drop the table, rewind the version ledger to 125, re-run
 *    runMigrations — v126 alone recreates it, and the migrated shape matches
 *    the fresh-bootstrap shape exactly (drift guard: migrate.ts DDL vs the
 *    schema blob, same contract as test/e2e/schema-drift.test.ts pins for
 *    Postgres).
 * 6. Re-running migrations afterwards is idempotent (0 applied).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/**
 * Capture the observable shape of session_context_state: ordered columns
 * (name/type/nullability/default), ordered PK columns, and index defs.
 * Used both for direct assertions and the fresh-vs-migrated drift guard.
 */
async function captureShape() {
  const columns = await engine.executeRaw<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    // Name-ordered ON PURPOSE (cathedral 5): additive columns land at CREATE
    // position on fresh bootstrap but ALTER-append on the migrated path, so
    // ordinal_position legitimately differs — the drift guard compares the
    // column SET + types + defaults, never physical order.
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'session_context_state'
      ORDER BY column_name`,
  );
  const pk = await engine.executeRaw<{ column_name: string }>(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_name = tc.table_name
      WHERE tc.table_name = 'session_context_state'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
  );
  const indexes = await engine.executeRaw<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'session_context_state'
      ORDER BY indexname`,
  );
  return { columns, pk: pk.map(r => r.column_name), indexes };
}

describe('migration v126 — session_context_state', () => {
  test('v126 exists in MIGRATIONS with canonical name and idempotent flag', () => {
    const v126 = MIGRATIONS.find(m => m.version === 126);
    expect(v126).toBeDefined();
    expect(v126?.name).toBe('session_context_state');
    expect(v126?.idempotent).toBe(true);
  });

  test('LATEST_VERSION >= 126', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(126);
  });

  test('table is created and queryable after initSchema()', async () => {
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM session_context_state`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('table has expected columns with expected types and defaults', async () => {
    const { columns } = await captureShape();
    const byName = Object.fromEntries(columns.map(c => [c.column_name, c]));
    expect(Object.keys(byName).sort()).toEqual([
      'checkpoint_manifest', // cathedral 5 — added by migration v132
      'client_id',
      'last_wake_at',
      'session_id',
      'source_id',
      'standing_entities',
      'surfaced_slugs',
      'updated_at',
    ]);
    expect(byName.source_id.data_type).toBe('text');
    expect(byName.client_id.data_type).toBe('text');
    expect(byName.session_id.data_type).toBe('text');
    expect(byName.standing_entities.data_type).toBe('jsonb');
    expect(byName.surfaced_slugs.data_type).toBe('jsonb');
    expect(byName.checkpoint_manifest.data_type).toBe('jsonb');
    expect(byName.checkpoint_manifest.is_nullable).toBe('NO');
    expect(byName.checkpoint_manifest.column_default).toContain('[]');
    expect(byName.last_wake_at.data_type).toBe('timestamp with time zone');
    expect(byName.updated_at.data_type).toBe('timestamp with time zone');
    // last_wake_at is the only nullable column (no wake yet).
    expect(byName.source_id.is_nullable).toBe('NO');
    expect(byName.client_id.is_nullable).toBe('NO');
    expect(byName.session_id.is_nullable).toBe('NO');
    expect(byName.standing_entities.is_nullable).toBe('NO');
    expect(byName.surfaced_slugs.is_nullable).toBe('NO');
    expect(byName.last_wake_at.is_nullable).toBe('YES');
    expect(byName.updated_at.is_nullable).toBe('NO');
    // client_id defaults to the 'local' sentinel (CLI/hook path); jsonb
    // columns default to the '[]' DDL literal.
    expect(byName.client_id.column_default).toContain('local');
    expect(byName.standing_entities.column_default).toContain('[]');
    expect(byName.surfaced_slugs.column_default).toContain('[]');
    expect(byName.updated_at.column_default).toContain('now()');
  });

  test('composite PK is (source_id, client_id, session_id) in that order', async () => {
    const { pk } = await captureShape();
    expect(pk).toEqual(['source_id', 'client_id', 'session_id']);
  });

  test('PK rejects duplicate (source_id, client_id, session_id) triple', async () => {
    await engine.executeRaw(
      `INSERT INTO session_context_state (source_id, client_id, session_id)
         VALUES ('default', 'local', 'sess-dup')`,
    );
    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO session_context_state (source_id, client_id, session_id)
           VALUES ('default', 'local', 'sess-dup')`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('same (source_id, session_id) under a different client_id coexists', async () => {
    // eng 1B: two harnesses in one source must not stomp each other's cursor —
    // client_id is part of the key, so both rows insert cleanly.
    await engine.executeRaw(
      `INSERT INTO session_context_state (source_id, client_id, session_id)
         VALUES ('default', 'harness-a', 'sess-shared'),
                ('default', 'harness-b', 'sess-shared')`,
    );
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM session_context_state
        WHERE source_id = 'default' AND session_id = 'sess-shared'`,
    );
    expect(rows[0].count).toBe(2);
  });

  test('defaults fire on insert: client_id=local, jsonb=[], last_wake_at NULL', async () => {
    await engine.executeRaw(
      `INSERT INTO session_context_state (source_id, session_id)
         VALUES ('default', 'sess-defaults')`,
    );
    const rows = await engine.executeRaw<{
      client_id: string;
      standing_entities: unknown;
      surfaced_slugs: unknown;
      last_wake_at: string | null;
      updated_at: string | null;
    }>(
      `SELECT client_id, standing_entities, surfaced_slugs, last_wake_at, updated_at
         FROM session_context_state
        WHERE source_id = 'default' AND session_id = 'sess-defaults'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe('local');
    // jsonb defaults round-trip as empty arrays (coerce for driver shape).
    const standing =
      typeof rows[0].standing_entities === 'string'
        ? JSON.parse(rows[0].standing_entities)
        : rows[0].standing_entities;
    const surfaced =
      typeof rows[0].surfaced_slugs === 'string'
        ? JSON.parse(rows[0].surfaced_slugs)
        : rows[0].surfaced_slugs;
    expect(standing).toEqual([]);
    expect(surfaced).toEqual([]);
    expect(rows[0].last_wake_at).toBeNull();
    expect(rows[0].updated_at).not.toBeNull();
  });

  test('session_context_state_updated_idx index is created', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'session_context_state'
          AND indexname = 'session_context_state_updated_idx'`,
    );
    expect(rows.length).toBe(1);
  });

  test('drop + rewind to v125 → runMigrations recreates the fresh-bootstrap shape', async () => {
    // Drift guard: capture the fresh-bootstrap shape (schema blob), then drop
    // the table, rewind the version ledger, and re-run migrations so v126's
    // DDL + the v132 checkpoint_manifest ALTER recreate it. The two shapes
    // must match exactly — a divergence means migrate.ts drifted from
    // src/schema.sql / pglite-schema.ts.
    const fresh = await captureShape();
    expect(fresh.columns.length).toBe(8); // 7 (v126) + checkpoint_manifest (v132)

    await engine.executeRaw(`DROP TABLE IF EXISTS session_context_state`);
    await engine.setConfig('version', '125');

    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    const migrated = await captureShape();
    expect(migrated).toEqual(fresh);
  }, 30000);

  test('re-running migrations after the rewind round-trip is idempotent (0 applied)', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
  }, 30000);

  test('source DDL pins the table, key shape, sentinel default, and index', () => {
    const v126 = MIGRATIONS.find(m => m.version === 126);
    expect(v126).toBeDefined();
    // v126 ships one engine-agnostic sql block (no sqlFor split) — both
    // engines run the same DDL.
    expect(v126?.sqlFor).toBeUndefined();
    expect(v126?.sql).toContain('CREATE TABLE IF NOT EXISTS session_context_state');
    expect(v126?.sql).toContain(`DEFAULT 'local'`);
    expect(v126?.sql).toContain('PRIMARY KEY (source_id, client_id, session_id)');
    expect(v126?.sql).toContain('session_context_state_updated_idx');
  });
});

describe('MIGRATIONS registry integrity (pre-landing review guard)', () => {
  test('versions are UNIQUE — a cross-PR number collision fails loudly instead of silently skipping', () => {
    // Two migrations sharing a version is the silent-death shape: whichever
    // lands second is skipped forever on brains already at that version
    // (runMigrations gates on version > current). Historical array order is
    // NOT ascending (early entries were reordered) — uniqueness is the
    // load-bearing invariant.
    const versions = MIGRATIONS.map((m) => m.version);
    const unique = new Set(versions);
    expect(unique.size).toBe(versions.length);
  });
});
