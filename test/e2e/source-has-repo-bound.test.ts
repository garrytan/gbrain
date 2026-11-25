/**
 * The privacy notice's repository check keeps the 1 s database bound the single statement it replaced had (Postgres).
 *
 * sourceHasRepo (search/ignored-privacy-labels.ts) reads the source row and, for `default`, the `sync.repo_path` config
 * value. A client-side race would give up on a stalled read without cancelling it, leaving a backend waiting and a pool
 * slot held after the notice returned. With the read bounded on the server (statement timeout), the answer returns in about
 * the bound and no backend is left waiting on the lock.
 *
 * Protects: a notice read behind a locked `config` table returns within the bound, counts as "has a repo" (an unreadable
 * answer does), and leaves no backend waiting on the lock.
 * Fails when the config read is only abandoned by the client (a backend still waits) or has no bound at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { sourceHasRepo } from '../../src/core/search/ignored-privacy-labels.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const LOCK_MS = 4_000;

(process.env.DATABASE_URL ? describe : describe.skip)('sourceHasRepo database bound', () => {
  let engine: BrainEngine;
  let databaseUrl = '';
  let close: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close;
    await engine.executeRaw(`UPDATE sources SET local_path = NULL, config = '{}'::jsonb WHERE id = 'default'`);
    await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
  }, 120_000);
  afterAll(async () => { await close(); });

  test('a stalled config read ends on the server within the bound and leaves no backend waiting', async () => {
    const locker = postgres(databaseUrl, { max: 1, prepare: false });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const held = locker.begin(async (sql) => {
      await sql.unsafe('LOCK TABLE config IN ACCESS EXCLUSIVE MODE');
      locked();
      await new Promise((r) => setTimeout(r, LOCK_MS));
    });
    await isLocked;
    try {
      const started = Date.now();
      const answer = await sourceHasRepo(engine, 'default');
      const took = Date.now() - started;
      // Read it straight after the notice returns: a client-side race would leave its query waiting here.
      const [{ n }] = await engine.executeRaw<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM config%'");
      expect({ answer, quick: took < 2_500, waiting: n }).toEqual({ answer: true, quick: true, waiting: 0 });
    } finally {
      await held.catch(() => undefined);
      await locker.end();
    }
  }, 30_000);
});
