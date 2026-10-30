/**
 * #6143: the base-schema replay (PostgresEngine.initSchema) is one implicit transaction that takes ACCESS EXCLUSIVE
 * locks as it goes, pages' triggers long before sources' managed_writer_guard. A live reader that holds sources and then
 * reads pages (the resident persistence consumer's idle probe did, on the nightly arm) closes a cycle with it, and
 * Postgres aborts the replay with deadlock_detected. The replay rolls back whole, so initSchema runs it again.
 * Forced: a reader transaction takes sources, waits until the replay is queued on sources, then reads pages. Postgres only.
 *
 * Postgres runs its deadlock check once per wait, deadlock_timeout after the wait began, and the backend that finds the
 * cycle aborts itself. The replay queues first, so with the default 1 s on both sides a reader delayed past 1 s (a loaded
 * runner, #7597) left the replay's one check before the cycle existed, and the reader's own check then aborted the reader.
 * The replay's sessions check at 5 s and the reader's at 60 s, so the replay is the victim whenever the reader starts
 * waiting within 5 s, and a reader later than that still fails as a deadlock of the reader rather than a hang.
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

describe.skipIf(!testBackends().includes('postgres'))('#6143 schema replay against a live reader', () => {
  test('a reader that holds sources and then reads pages no longer fails the replay with a deadlock', async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const reader = postgres(pg.databaseUrl, { max: 1, onnotice: () => {} });
    const watcher = postgres(pg.databaseUrl, { max: 1, onnotice: () => {} });
    const engine = new PostgresEngine();
    try {
      await watcher.unsafe(`ALTER DATABASE "${new URL(pg.databaseUrl).pathname.slice(1)}" SET deadlock_timeout = '5s'`);
      await engine.connect({ database_url: pg.databaseUrl, poolSize: 2 });
      expect(await engine.executeRaw<{ deadlock_timeout: string }>('SHOW deadlock_timeout')).toEqual([{ deadlock_timeout: '5s' }]);
      let replay: Promise<unknown> | undefined;
      await reader.begin(async sql => {
        await sql`SET LOCAL deadlock_timeout = '60s'`;
        await sql`SELECT 1 FROM sources LIMIT 1`;
        replay = engine.initSchema().then(() => 'ok', (error: { code?: string; message?: string }) => `${error.code ?? ''} ${error.message ?? error}`);
        for (let i = 0; i < 400; i++) {
          const [row] = await watcher<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = 'sources'::regclass`;
          if (row!.n > 0) break;
          await Bun.sleep(25);
        }
        await sql`SELECT 1 FROM pages LIMIT 1`;
      });
      expect(await replay).toBe('ok');
      expect(await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'managed_writer_guard' AND tgrelid = 'sources'::regclass")).toEqual([{ n: 1 }]);
    } finally { await reader.end(); await watcher.end(); await engine.disconnect(); await pg.close(); }
  }, 120_000);
});
