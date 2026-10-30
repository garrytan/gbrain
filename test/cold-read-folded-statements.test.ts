/**
 * #7147 follow-up: statements a cold one-shot read no longer pays.
 *
 * 1. Protects: inside one request snapshot, source resolution reads the sources
 *    table once (tier 4, tier 5.5 and the federated set used to read it three
 *    ways) and resolves exactly what live reads resolve; `requestSnapshotRead`
 *    lives as long as its snapshot and a write operation drops it; the
 *    graduation connect gate reads the custody row in one statement, treats a
 *    missing table as no row and still throws every other error.
 * 2. Fails when: a resolver tier reads the sources table itself again inside a
 *    snapshot, the memo outlives its snapshot or a write, the gate probes
 *    to_regclass first again, or it swallows an error that is not 42P01.
 * 3. Existing coverage: test/config-request-snapshot.test.ts counts config
 *    reads only; the source-resolver tests mock SQL text outside any snapshot;
 *    test/graduation-state.test.ts checks the gate's refusals, not its
 *    statements. test/e2e/cli-read-startup-round-trips.test.ts counts the same
 *    statements through the CLI on Postgres.
 * 4. Seam: none. Statements are counted on the PGLite handle the engine uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { requestSnapshotRead, withRequestConfigSnapshot, withoutRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { localFederatedSourceIds, resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { assertGraduationConnectAllowed } from '../src/core/persistence/graduation-custody.ts';
import { readGraduationConnectRow } from '../src/core/persistence/graduation-schema.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let root: string;
const statements: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => { statements.push(sql.replace(/\s+/g, ' ').trim()); return query(sql, ...rest); };
  root = mkdtempSync(join(tmpdir(), 'gbrain-cold-read-folded-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; sql: string[] }> {
  statements.length = 0;
  const value = await fn();
  return { value, sql: [...statements] };
}

/** Whole-table reads of sources (an exact-id existence check is a separate statement). */
const sourceScans = (sql: string[]) => sql.filter(s => /\bFROM sources\b/.test(s) && !/\bid = \$1\b/.test(s));

describe('source resolution inside one request snapshot', () => {
  for (const shape of ['tier 4 (cwd inside a registered source)', 'tier 5.5 (one non-default source)'] as const) {
    test(`${shape}: one sources read, the same source and federated set as live reads`, async () => {
      const active = join(root, 'source-a-example');
      const archived = join(root, 'source-b-example');
      mkdirSync(active, { recursive: true });
      mkdirSync(archived, { recursive: true });
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config, archived) VALUES
        ('source-a', 'source-a', $1, '{"federated": true}'::jsonb, false),
        ('source-b', 'source-b', $2, '{"federated": true}'::jsonb, true),
        ('source-c', 'source-c', NULL, '{"federated": true}'::jsonb, false)`, [active, archived]);
      const cwd = shape.startsWith('tier 4') ? active : root;
      const resolve = async () => {
        const resolved = await resolveSourceWithTier(engine, null, cwd);
        return { ...resolved, federated: await localFederatedSourceIds(engine, resolved.source_id, resolved.tier) };
      };
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        const live = await counted(resolve);
        const snapshot = await counted(() => withRequestConfigSnapshot(engine, resolve));
        expect(live.value.source_id).toBe('source-a');
        expect(snapshot.value).toEqual(live.value);
        expect(sourceScans(live.sql).length).toBeGreaterThan(1);
        expect(sourceScans(snapshot.sql)).toEqual([`SELECT id, local_path, archived, config, EXISTS (SELECT 1 FROM pages WHERE source_id = 'default' AND deleted_at IS NULL) AS default_has_pages FROM sources ORDER BY id`]);
      });
    });
  }
});

describe('requestSnapshotRead', () => {
  test('loads once per snapshot, never outside one, and again after a write operation', async () => {
    let loads = 0;
    const load = async () => ++loads;
    expect(requestSnapshotRead(engine, 'k', load)).toBeUndefined();
    await withRequestConfigSnapshot(engine, async () => {
      expect(await requestSnapshotRead(engine, 'k', load)).toBe(1);
      expect(await requestSnapshotRead(engine, 'k', load)).toBe(1);
      expect(requestSnapshotRead({}, 'k', load)).toBeUndefined();
      await withoutRequestConfigSnapshot(async () => { expect(requestSnapshotRead(engine, 'k', load)).toBeUndefined(); });
      expect(await requestSnapshotRead(engine, 'k', load)).toBe(2);
    });
    expect(requestSnapshotRead(engine, 'k', load)).toBeUndefined();
    expect(loads).toBe(2);
  });
});

describe('the graduation connect gate', () => {
  test('reads the custody row in one statement, with no table probe', async () => {
    const { sql } = await counted(() => assertGraduationConnectAllowed(engine, {}));
    expect(sql).toEqual(['SELECT role, run_id::text AS run_id, state, source_data_dir FROM persistence_graduation WHERE singleton = 1']);
  });

  test('a database without the custody table has no row; any other failure still throws', async () => {
    const bare = new PGlite();
    try {
      const reader = { executeRaw: async (sql: string) => (await bare.query(sql)).rows } as unknown as BrainEngine;
      expect(await readGraduationConnectRow(reader)).toBeNull();
      await expect(assertGraduationConnectAllowed(reader, {})).resolves.toBeUndefined();
      const denied = { executeRaw: async () => { throw Object.assign(new Error('permission denied for table persistence_graduation'), { code: '42501' }); } } as unknown as BrainEngine;
      await expect(assertGraduationConnectAllowed(denied, {})).rejects.toThrow(/permission denied/);
    } finally {
      await bare.close();
    }
  });
});
