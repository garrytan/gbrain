/**
 * GST-2462 on Postgres: the ignored-privacy-label notice reads that run on write and sync paths end on the server.
 * `gbrain sync` reads the pages a run stored for its end-of-run notice (`ignoredPrivacyLabelRunNotice`), and put_page
 * reads the stored page back (`withIgnoredPrivacyLabelNotice`). As plain autocommit statements they waited on
 * `LOCK TABLE pages IN ACCESS EXCLUSIVE MODE` held in another session for as long as the lock lasted, so a sync stalled
 * past its preparation budget behind a notice (#8933's full E2E, persistence-preparation-engine-reads-lock-postgres).
 *
 * Value: protects=NOTICE_READ_TIMEOUT_MS on every notice read; fails_when=a notice read is still waiting on the lock
 * after the bound plus slack, or the run notice / put_page result does not come back while the lock is held;
 * seam=none (the real functions against a real Postgres, the lock taken in a second session).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import { ignoredPrivacyLabelRunNotice, NOTICE_READ_TIMEOUT_MS, withIgnoredPrivacyLabelNotice } from '../../src/core/search/ignored-privacy-labels.ts';
import { hasDatabase } from './helpers.ts';

let engine: BrainEngine | undefined;
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const SLACK_MS = 3_000;
const LIMIT_MS = NOTICE_READ_TIMEOUT_MS + SLACK_MS;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
  engine = pg.engine; closePostgres = pg.close; databaseUrl = pg.databaseUrl;
}, 120_000);
afterAll(async () => { await closePostgres?.(); });

/** Runs `work` while another session holds `pages` ACCESS EXCLUSIVE; reports whether it came back within LIMIT_MS. */
async function underPagesLock<T>(work: () => Promise<T>): Promise<{ returned: boolean; value?: T; stillWaiting: string[] }> {
  const holder = postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} });
  const dropped = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const transaction = holder.begin(async sql => {
    await sql.unsafe('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE');
    acquired.resolve();
    await dropped.promise;
  }).catch(error => { acquired.reject(error); });
  try {
    await acquired.promise;
    const run = work();
    const outcome = await Promise.race([
      run.then(value => ({ returned: true as const, value })),
      Bun.sleep(LIMIT_MS).then(() => ({ returned: false as const })),
    ]);
    const waiting = Array.from(await holder.unsafe(
      `SELECT left(query, 120) AS query FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`)) as Array<{ query: string }>;
    dropped.resolve();
    await run.catch(() => undefined);
    return { ...outcome, stillWaiting: waiting.map(row => row.query) };
  } finally {
    dropped.resolve();
    await transaction;
    await holder.end();
  }
}

describe.skipIf(!hasDatabase())('ignored-privacy-label notice reads end at their bound under a held pages lock (Postgres, GST-2462)', () => {
  test('a sync run notice by slug and by time comes back as no notice, and leaves no statement waiting', async () => {
    for (const scope of [{ slugs: ['notes/locked-example'] }, { since: '2000-01-01T00:00:00Z' }]) {
      const result = await underPagesLock(() => ignoredPrivacyLabelRunNotice(engine!, 'default', scope, 'sync'));
      expect({ scope, returned: result.returned, value: result.value ?? null, stillWaiting: result.stillWaiting })
        .toEqual({ scope, returned: true, value: null, stillWaiting: [] });
    }
  }, 60_000);

  test('put_page returns its result with no notice while the stored page cannot be read', async () => {
    const notices: Notice[] = [];
    const written = { slug: 'notes/locked-example', status: 'created_or_updated' };
    const result = await underPagesLock(() => withIgnoredPrivacyLabelNotice({ engine: engine!, emitNotice: n => { notices.push(n); } }, 'default',
      { slug: 'notes/locked-example', content: '---\naccess: personal\n---\nBody.\n' }, written));
    expect({ returned: result.returned, value: result.value, notices, stillWaiting: result.stillWaiting })
      .toEqual({ returned: true, value: written, notices: [], stillWaiting: [] });
  }, 60_000);
});
