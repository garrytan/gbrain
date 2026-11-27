/**
 * Projection readiness cache on Postgres: an answer read on an old REPEATABLE READ snapshot stays inside its transaction.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a probe that runs inside a REPEATABLE READ transaction reads the generation live (the page clock is a
 *    sequence) but the readiness rows on the transaction's snapshot, so it can store an answer older than the generation
 *    it is stored under. That answer must never reach a probe outside the transaction: after the transaction, a search
 *    on the brain gets the same readiness as a probe with the cache off, which is the answer PGLite gives. Inside the
 *    transaction the cached answer equals an uncached one, because both read the same snapshot.
 *  - Regression: the cache is keyed by the engine object, and each transaction runs on its own engine object
 *    (Object.create in every engine's transaction). A cache keyed by anything shared by the brain (the connection pool,
 *    the database, a module-level map with one key) would serve the stale `ready` to the next search after a page
 *    write committed in another session.
 *  - Why existing coverage misses it: test/projection-readiness.test.ts runs on PGLite, which has one connection, so no
 *    write can commit while a snapshot is open; the parity cases open no REPEATABLE READ transaction.
 *  - Seam: none. A second postgres.js connection commits the page write.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  __resetProjectionReadinessCacheForTests, PROJECTION_READINESS_CACHE_ENV, probeProjectionReadiness,
} from '../src/core/search/projection-readiness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
let engine: PostgresEngine;
let brainUrl: string;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(DATABASE_URL);
  engine = pg.engine; brainUrl = pg.databaseUrl; close = pg.close;
}, 120_000);
afterAll(async () => { await close?.(); });
beforeEach(async () => {
  if (!DATABASE_URL) return;
  __resetProjectionReadinessCacheForTests();
  await engine.executeRaw('DELETE FROM pages');
});

// An unsealed page: its chunker version is not current, so readiness reports it pending.
const insertPage = `INSERT INTO pages (source_id, slug, title, type, page_kind, compiled_truth, chunker_version, frontmatter)
  VALUES ('default', 'notes/committed-elsewhere', 'Committed elsewhere', 'concept', 'markdown', 'body', 999, '{}'::jsonb)`;

const pgTest = DATABASE_URL ? test : test.skip;

pgTest('an answer cached on an old REPEATABLE READ snapshot is not reused after the transaction', async () => {
  await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
    const uncached = () => withEnv({ [PROJECTION_READINESS_CACHE_ENV]: '0' }, () => probeProjectionReadiness(engine));
    const other = postgres(brainUrl, { max: 1, prepare: false });
    try {
      // The generation is only read while no other transaction on the server is open; a shared test server can have
      // one open when the snapshot is taken, so take the snapshot again (bounded) until it is read.
      let inside: Awaited<ReturnType<typeof snapshotRead>> | undefined;
      async function snapshotRead() {
        return engine.transaction(async tx => {
          await tx.beginSnapshotRead({ readOnly: true });
          // The first read takes the snapshot; the brain has no page yet.
          await tx.executeRaw('SELECT count(*) FROM pages');
          await other.unsafe(insertPage);
          const generation = await tx.readProjectionReadinessGeneration();
          const cached = await probeProjectionReadiness(tx);
          const again = await probeProjectionReadiness(tx);
          const fresh = await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: '0' }, () => probeProjectionReadiness(tx));
          return { generation, cached, again, fresh };
        });
      }
      for (let attempt = 0; attempt < 50 && typeof inside?.generation !== 'string'; attempt++) {
        if (attempt > 0) { await engine.executeRaw('DELETE FROM pages'); await Bun.sleep(100); }
        inside = await snapshotRead();
      }
      if (!inside) throw new Error('unreachable');
      // The hole: the generation already counts the committed write, and the answer stored under it is the snapshot's.
      expect(typeof inside.generation).toBe('string');
      expect(inside.cached.status).toBe('ready');
      // Inside the transaction the cache changes nothing: an uncached probe reads the same snapshot.
      expect(inside.again).toBe(inside.cached);
      expect(inside.fresh).toEqual(inside.cached);
      // After it, the brain's generation is the one the stale answer was stored under, yet the search reads again.
      let base = await engine.readProjectionReadinessGeneration();
      for (let attempt = 0; attempt < 50 && base === null; attempt++) { await Bun.sleep(100); base = await engine.readProjectionReadinessGeneration(); }
      expect(base).toBe(inside.generation);
      const after = await probeProjectionReadiness(engine);
      expect(after.status).toBe('projection_pending');
      expect(after).toEqual(await uncached());
    } finally { await other.end(); }
  });
}, 60_000);
