/**
 * BrainEngine parity — raw_sql family (runMigration, executeRaw,
 * executeRawDirect, keywordBoundedRead).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the raw-SQL entry points answer the same rows on every SQL
 *    arm (PGLite always; Postgres with DATABASE_URL), see the writes the
 *    typed methods made, and keep their transaction and parameter contract.
 *    Every case declares `requires: 'raw_sql'`, so a Rust arm must refuse
 *    each call with `engine_capability_missing` reason `raw_sql` (D18) and
 *    is never compared on rows (test/engine-parity/arm-capabilities.ts).
 *  - Regression: an engine whose raw read misses a committed typed write,
 *    binds parameters differently, returns numbers as strings, runs a
 *    migration's statements partly, or leaks keywordBoundedRead's read
 *    transaction; the minion queue, migrations and doctor read through these.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts calls
 *    executeRaw only on Postgres, as a fixture, and never compares arms.
 *  - Seam: none. Real engines. Raw SQL is the method under test here, the one
 *    family where a case may call it.
 */
import { describe, expect } from 'bun:test';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

describe('engine parity: raw_sql', () => {
  parityTest(
    'executeRaw binds parameters, returns typed rows and sees the typed writes',
    { methods: ['putPage', 'executeRaw'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/raw-a', PAGE('Raw A', 'first'));
      await engine.putPage('notes/raw-b', PAGE('Raw B', 'second'));
      const scalar = await engine.executeRaw<{ n: number; s: string; nothing: null }>(
        'SELECT $1::int + 1 AS n, $2::text AS s, NULL AS nothing', [41, 'text'],
      );
      expect(scalar).toEqual([{ n: 42, s: 'text', nothing: null }]);
      const pages = await engine.executeRaw<{ slug: string; title: string }>(
        `SELECT slug, title FROM pages WHERE slug LIKE $1 AND deleted_at IS NULL ORDER BY slug`, ['notes/raw-%'],
      );
      const none = await engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', ['notes/nobody']);
      return { scalar, pages, none };
    },
  );

  parityTest(
    'executeRawDirect answers like executeRaw and joins an open transaction',
    { methods: ['putPage', 'executeRawDirect', 'transaction'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/direct', PAGE('Direct', 'body'));
      const direct = await engine.executeRawDirect<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['notes/direct']);
      // Inside a transaction the tx handle's direct read sees the tx's own uncommitted write.
      const inTx = await engine.transaction(async (tx) => {
        await tx.putPage('notes/direct-tx', PAGE('Direct tx', 'body'));
        return tx.executeRawDirect<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['notes/direct-tx']);
      });
      expect([direct, inTx]).toEqual([[{ slug: 'notes/direct' }], [{ slug: 'notes/direct-tx' }]]);
      return { direct, inTx };
    },
  );

  parityTest(
    'findLiveMinionClaim matches the queue and token only while the lease is live',
    { methods: ['findLiveMinionClaim'], requires: 'raw_sql' },
    async (engine) => {
      // The parity harness empties config while retaining the migrated schema.
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      const queue = new MinionQueue(engine);
      const live = await queue.add('readback-fixture', {}, { queue: 'readback' });
      expect((await queue.claim('worker:live', 30_000, 'readback', ['readback-fixture']))?.id).toBe(live.id);
      const expired = await queue.add('readback-fixture', {}, { queue: 'readback' });
      expect((await queue.claim('worker:expired', -1_000, 'readback', ['readback-fixture']))?.id).toBe(expired.id);

      const result = await engine.findLiveMinionClaim('readback', 'worker:live');
      expect(result).toMatchObject({ id: live.id, status: 'active', lock_token: 'worker:live' });
      const otherQueue = await engine.findLiveMinionClaim('other', 'worker:live');
      const otherToken = await engine.findLiveMinionClaim('readback', 'worker:other');
      const expiredLease = await engine.findLiveMinionClaim('readback', 'worker:expired');
      expect([otherQueue, otherToken, expiredLease]).toEqual([null, null, null]);
      return { status: result?.status, otherQueue, otherToken, expiredLease };
    },
  );

  parityTest(
    'runMigration runs every statement of a multi-statement script',
    { methods: ['runMigration', 'executeRaw'], requires: 'raw_sql' },
    async (engine) => {
      await engine.runMigration(9_000_001, `
        CREATE TABLE IF NOT EXISTS parity_raw_probe (id int PRIMARY KEY, label text NOT NULL);
        INSERT INTO parity_raw_probe (id, label) VALUES (1, 'one'), (2, 'two');
      `);
      const rows = await engine.executeRaw<{ id: number; label: string }>('SELECT id, label FROM parity_raw_probe ORDER BY id');
      await engine.runMigration(9_000_002, 'DROP TABLE parity_raw_probe;');
      const gone = await engine.executeRaw<{ present: boolean }>(`SELECT to_regclass('parity_raw_probe') IS NOT NULL AS present`);
      expect([rows, gone]).toEqual([[{ id: 1, label: 'one' }, { id: 2, label: 'two' }], [{ present: false }]]);
      return { rows, gone };
    },
  );

  parityTest(
    'keywordBoundedRead runs the read and returns its value; a throw propagates and the engine stays usable',
    { methods: ['putPage', 'keywordBoundedRead', 'getPage'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/bounded', PAGE('Bounded', 'body'));
      const read = await engine.keywordBoundedRead((db) =>
        db.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['notes/bounded']));
      const thrown = await engine.keywordBoundedRead(async () => { throw new Error('read refused'); })
        .then(() => 'no error', (e: unknown) => (e instanceof Error ? e.message : String(e)));
      const after = (await engine.getPage('notes/bounded'))?.title ?? null;
      expect([read, thrown, after]).toEqual([[{ slug: 'notes/bounded' }], 'read refused', 'Bounded']);
      return { read, thrown, after };
    },
  );
});
