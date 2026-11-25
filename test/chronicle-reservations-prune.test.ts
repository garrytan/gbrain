/**
 * The two-day prune of the chronicle judge reservations on the SQL engines (chronicle/ledger.ts
 * `pruneChronicleReservations`, engine-sql/chronicle-ledger.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the prune deletes every reservation taken more than 48 hours ago and keeps the rest; the 24 h count
 *    reads only the newest. PGLite, and Postgres with DATABASE_URL.
 *  - Regression: none on these engines; the prune moved from a raw statement in ledger.ts to a typed member with the
 *    same SQL text. This pins the boundary the parity case cannot seed (test/engine-parity/chronicle-reservations.test.ts;
 *    the Rust store pins it with its clock in rust/crates/gbrain-store/tests/chronicle_ledger.rs).
 *  - Why existing coverage misses it: no test ran the prune against aged rows.
 *  - Seam: none. The fixture back-dates rows with SQL, which only these engines take.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pruneChronicleReservations } from '../src/core/chronicle/ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`[${backend}] the chronicle reservation prune`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => undefined;
    beforeAll(async () => {
      if (backend === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        engine = pglite;
      }
    }, 120_000);
    afterAll(async () => {
      if (backend === 'pglite') await engine.disconnect();
      else await close();
    });

    test('deletes the reservations older than 48 hours and keeps the rest', async () => {
      for (const [page, age] of [[1, '49 hours'], [2, '47 hours'], [3, '1 hour']] as const) {
        await engine.executeRaw(`INSERT INTO chronicle_judge_reservations (source_id, page_id, content_hash, reserved_at)
          VALUES ('default', $1, 'h', now() - $2::interval)`, [page, age]);
      }
      await pruneChronicleReservations(engine);
      const rows = await engine.executeRaw<{ page_id: number | string }>('SELECT page_id FROM chronicle_judge_reservations ORDER BY page_id');
      expect({ kept: rows.map(r => Number(r.page_id)), lastDay: await engine.countRecentChronicleReservations() })
        .toEqual({ kept: [2, 3], lastDay: 1 });
    });
  });
}
