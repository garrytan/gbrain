import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { acquirePageEmbeddingLease } from '../src/core/page-embedding-lease.ts';
import { assertWriterAdminState, writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) describe(`writer admin state and page embedding leases (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });
  const lockIds = async () => (await engine.executeRaw<{ id: string }>('SELECT id FROM gbrain_cycle_locks ORDER BY id')).map(row => row.id);

  test('an embedding lease taken and released between review and apply leaves the reviewed state valid', async () => {
    const reviewed = await writerAdminState(engine);
    {
      await using _lease = await acquirePageEmbeddingLease(engine, 1);
      expect(await lockIds()).toEqual(['embed-page:1']);
      expect(await writerAdminState(engine)).toBe(reviewed);
    }
    expect(await lockIds()).toEqual([]);
    await assertWriterAdminState(engine, reviewed, false);
  });

  test('a writer lock row taken after review still refuses the reviewed state', async () => {
    const reviewed = await writerAdminState(engine);
    const lock = await tryAcquireDbLock(engine, 'gbrain-sync');
    expect(lock).not.toBeNull();
    try {
      expect(await lockIds()).toEqual(['gbrain-sync']);
      await expect(assertWriterAdminState(engine, reviewed, false)).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    } finally { await lock!.release(); }
    await assertWriterAdminState(engine, reviewed, false);
  });
});
