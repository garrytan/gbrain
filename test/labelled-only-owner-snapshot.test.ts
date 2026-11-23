/**
 * access/labelled-only.ts labelledOnlyFor inside a request's config snapshot (config-snapshot.ts withRequestConfigSnapshot)
 * on PGLite and Postgres (authoring gate, docs/TESTING.md#authoring-gate):
 *  - Contract: the owner is read live, so a former owner that another writer restricted after the request's snapshot
 *    was taken is labelled-only; the request's snapshot stays in place (a later getConfig answers from it, and the
 *    request-stable 'sources' read is not taken again).
 *  - Regression: labelledOnlyFor read the owner through getConfig, which answers from the snapshot, so the former owner
 *    was exempt for the rest of the request while the old SQL statement read config live and restricted it.
 *  - Seam: the owner change is a raw UPDATE, as another process's write is invisible to this request's snapshot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { labelledOnlyFor } from '../src/core/access/labelled-only.ts';
import { requestSnapshotRead, withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe(`labelledOnlyFor reads the owner live inside a request (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.setConfig('access.owner_member', 'alice-example');
    }, 60_000);
    afterAll(async () => { await close(); });

    test('a former owner restricted after the snapshot is labelled-only, and the snapshot and its sources read stay', async () => {
      let sourcesReads = 0;
      const sources = () => requestSnapshotRead(engine, 'sources', async () => ++sourcesReads);
      const out = await withRequestConfigSnapshot(engine, async () => {
        const before = await engine.getConfig('access.owner_member');
        await sources();
        // Another writer moves ownership to bob and gives alice the grant.
        await engine.executeRaw("UPDATE config SET value = 'bob-example' WHERE key = 'access.owner_member'");
        await engine.executeRaw('UPDATE access_members SET labelled_only = true WHERE id = $1', ['alice-example']);
        const verdict = await labelledOnlyFor(engine, [['member:alice-example']]);
        const after = await engine.getConfig('access.owner_member');
        await sources();
        return { before, verdict, after, sourcesReads };
      });
      expect(out).toEqual({ before: 'alice-example', verdict: true, after: 'alice-example', sourcesReads: 1 });
    });
  });
}
