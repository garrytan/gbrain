/**
 * Track 2 on Postgres: the typed reads that replaced a preparer's `executeRaw` statements
 * (persistence/bounded-reads.ts `TYPED_PREPARATION_READS`) keep master's server-side bound.
 * Master's helpers called `executeRaw` through the preparer's bounded view, which refused a read
 * past the deadline and ended a lock-blocked one on the server at the budget; the typed methods
 * bypass that hook, so the engine runs them under the view's read deadline itself
 * (postgres-engine.ts `preparationRead`).
 *
 * Protects, for both preparer views (managed sync with `engineReads`, page and maintenance without):
 * - a seal-state lookup (`projectionBelowSafeFence`) after the budget ran out is refused as the
 *   member's `preparation_deadline` before any SQL is sent (sqlstate null);
 * - while another session holds `pages` ACCESS EXCLUSIVE, the lookup ends as `preparation_deadline`
 *   at the budget, and no statement of it is left running on the server;
 * - without a deadline the same read answers as before.
 * Fails when a typed preparation read goes back to the unbounded pool path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { boundedReads, PreparationDeadlineError } from '../../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../../src/core/persistence/claim-phase.ts';
import { projectionBelowSafeFence } from '../../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

let engine: PostgresEngine | undefined;
let databaseUrl = '';
let close: (() => Promise<void>) | undefined;
let pageId = 0;
const SEAL_SQL_MARK = 'SELECT chunker_version FROM pages WHERE id=';

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
  engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close;
  await engine.putPage('notes/seal-probe', { type: 'note', title: 'Seal probe', compiled_truth: 'A note.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  const [row] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id='default' AND slug='notes/seal-probe'`);
  pageId = Number(row!.id);
}, 120_000);
afterAll(async () => { await close?.(); });

const views = [['managed sync (engineReads)', { engineReads: true }], ['page/maintenance preparer', {}]] as const;

describe.skipIf(!hasDatabase())('typed preparation reads keep the preparation deadline (Postgres)', () => {
  test('without a deadline the seal-state read answers as before', async () => {
    expect(await engine!.getPageSealState(pageId)).not.toBeNull();
    expect(typeof await projectionBelowSafeFence(boundedReads(engine!, startClaimPhase()), pageId)).toBe('boolean');
  });

  for (const [name, opts] of views) {
    test(`${name}: an expired budget refuses the seal-state read before it is sent`, async () => {
      const reads = boundedReads(engine!, startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts);
      const error = await projectionBelowSafeFence(reads, pageId).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(PreparationDeadlineError);
      expect((error as PreparationDeadlineError).code).toBe('preparation_deadline');
      expect((error as PreparationDeadlineError).sqlstate).toBeNull();
    });

    test(`${name}: a lock-blocked seal-state read ends at the budget and leaves nothing on the server`, async () => {
      const holder = postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} });
      const dropped = Promise.withResolvers<void>();
      const acquired = Promise.withResolvers<void>();
      const tx = holder.begin(async sql => { await sql.unsafe('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE'); acquired.resolve(); await dropped.promise; })
        .catch(error => { acquired.reject(error); });
      try {
        await acquired.promise;
        const budgetMs = 500;
        const started = Date.now();
        const reads = boundedReads(engine!, startClaimPhase(started, undefined, budgetMs), opts);
        // The lock is dropped well after the bound: an unbounded read would wait for it and then answer.
        const release = setTimeout(() => dropped.resolve(), 6_000);
        const error = await projectionBelowSafeFence(reads, pageId).then(() => null, (e: unknown) => e);
        clearTimeout(release);
        const elapsed = Date.now() - started;
        expect(error).toBeInstanceOf(PreparationDeadlineError);
        expect((error as PreparationDeadlineError).code).toBe('preparation_deadline');
        expect(elapsed).toBeLessThan(budgetMs + 3_000);
        const active = await holder.unsafe(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE $1`,
          [`${SEAL_SQL_MARK}%`]);
        expect(Array.from(active)).toEqual([]);
      } finally {
        dropped.resolve();
        await tx;
        await holder.end();
      }
    }, 30_000);
  }
});
