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
 * The caller access reads (readLiveMember, readFolderAccess) and the typed reads swept into the set after them keep the
 * same bound while another session holds their table ACCESS EXCLUSIVE, and answer while budget is left (the source lock
 * read takes a row lock, which a read-only deadline transaction refuses).
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

const callerReads = [
  ['readLiveMember', 'access_members', 'FROM access_members m', (e: PostgresEngine) => e.readLiveMember('member', 'alice-example')],
  ['readFolderAccess', 'access_pending_coverage', 'FROM access_pending_coverage', (e: PostgresEngine) => e.readFolderAccess(['member:alice-example'])],
] as const;

type LockedRead = readonly [name: string, table: string, mark: string, run: (e: PostgresEngine) => Promise<unknown>];

/** Each read answers without a deadline and with budget left, is refused once the budget is spent, and ends at the budget while another session holds its table. */
function lockedTableCases(reads: readonly LockedRead[]): void {
  for (const [name, table, mark, run] of reads) {
    test(`${name}: without a deadline it answers as before`, async () => {
      await run(boundedReads(engine!, startClaimPhase()) as PostgresEngine);
    });

    for (const [view, opts] of views) {
      test(`${view}: ${name} with budget left answers`, async () => {
        await run(boundedReads(engine!, startClaimPhase(Date.now(), undefined, 10_000), opts) as PostgresEngine);
      });

      test(`${view}: an expired budget refuses ${name} before it is sent`, async () => {
        const reads = boundedReads(engine!, startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts) as PostgresEngine;
        const error = await run(reads).then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(PreparationDeadlineError);
        expect((error as PreparationDeadlineError).sqlstate).toBeNull();
      });

      test(`${view}: ${name} blocked on ${table} ends at the budget and leaves nothing on the server`, async () => {
        const holder = postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} });
        const dropped = Promise.withResolvers<void>();
        const acquired = Promise.withResolvers<void>();
        const tx = holder.begin(async sql => { await sql.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`); acquired.resolve(); await dropped.promise; })
          .catch(error => { acquired.reject(error); });
        try {
          await acquired.promise;
          const budgetMs = 500;
          const started = Date.now();
          const reads = boundedReads(engine!, startClaimPhase(started, undefined, budgetMs), opts) as PostgresEngine;
          const release = setTimeout(() => dropped.resolve(), 6_000);
          const error = await run(reads).then(() => null, (e: unknown) => e);
          clearTimeout(release);
          expect(error).toBeInstanceOf(PreparationDeadlineError);
          expect((error as PreparationDeadlineError).code).toBe('preparation_deadline');
          expect(Date.now() - started).toBeLessThan(budgetMs + 3_000);
          const active = await holder.unsafe(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE $1`,
            [`%${mark}%`]);
          expect(Array.from(active)).toEqual([]);
        } finally {
          dropped.resolve();
          await tx;
          await holder.end();
        }
      }, 30_000);
    }
  }
}

describe.skipIf(!hasDatabase())('caller access reads keep the preparation deadline (Postgres)', () => {
  lockedTableCases(callerReads);
});

/** The typed reads that replaced a raw write-preparation statement (test/typed-preparation-reads-sweep.test.ts); the clock read locks no table. */
const sweptReads: readonly LockedRead[] = [
  ['listGuestSourceIds', 'sources', 'SELECT s.id FROM sources s', e => e.listGuestSourceIds(['default'])],
  ['listStoredTimelineRowsOrdered', 'timeline_entries', 'FROM timeline_entries WHERE page_id', e => e.listStoredTimelineRowsOrdered(pageId)],
  ['matchTakeRows', 'takes', 'FROM takes k', e => e.matchTakeRows(pageId, [{ row_num: 1, claim: 'a claim', kind: 'take', holder: 'self' }], 10)],
  ['listFactWithdrawalDates', 'fact_withdrawals', 'JOIN fact_withdrawals w', e => e.listFactWithdrawalDates('default', [{ row_num: 1, claim: 'a claim', visibility: 'world' }], null)],
  ['listCorePageRows', 'pages', 'always_load', e => e.listCorePageRows({ limit: 10 })],
  // The segmented write path's reads a page preparation makes (stageSegmentedImport, the seal probe, chunk-vector reuse).
  ['readSegmentedLivePage', 'pages', 'body_generation, body_storage', e => e.readSegmentedLivePage(pageId)],
  ['listChunkedOccurrences', 'content_chunks', 'unnest($2::bigint[])', e => e.listChunkedOccurrences(pageId, [1], 1)],
  ['readRetiredChunkVectors', 'content_chunks', 'FROM content_chunks c JOIN pages p', e => e.readRetiredChunkVectors(pageId, [1], 'embedding')],
  ['hasStaleSegmentChunks', 'content_chunks', 'WITH RECURSIVE occ(o)', e => e.hasStaleSegmentChunks(pageId, 1, [1])],
  // The withdrawal overlay's '*' purge lookup (overlayCanonicalBodiesTyped), waiting on a locked fact_purges.
  ['listGlobalPurgeWithdrawals', 'fact_purges', 'FROM fact_purges', e => e.listGlobalPurgeWithdrawals('default', ['h'], false)],
  // A row lock: a read-only deadline transaction would refuse it, so "with budget left answers" pins the read-write bound.
  ['lockRegisteredSourceIds', 'sources', 'FROM sources WHERE id = ANY', e => e.lockRegisteredSourceIds(['default'])],
  // The owner write's reads of the stored page (persistence/page-visibility.ts ownerRewriteOf, authorizePageVisibility's hiddenUnder).
  ['readPagePrivacyHidden', 'pages', 'AS hidden FROM pages p', e => e.readPagePrivacyHidden('default', 'notes/seal-probe')],
  ['readLinkTargetPages', 'pages', 'AS visible', e => e.readLinkTargetPages('default', ['notes/seal-probe'], null)],
  ['readWriteVisibilityProbe', 'pages', 'AS identity_may_open', e => e.readWriteVisibilityProbe('default', 'notes/seal-probe')],
  ['readPageHiddenFromWriter', 'pages', 'SELECT 1 FROM pages WHERE source_id', e => e.readPageHiddenFromWriter('default', 'notes/seal-probe', { identities: [['member:alice-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false }, true)],
];

describe.skipIf(!hasDatabase())('typed reads swept into the preparation set keep the deadline (Postgres)', () => {
  lockedTableCases(sweptReads);
  test('readDatabaseClock: an expired budget refuses it before it is sent; with budget left it answers', async () => {
    for (const [, opts] of views) {
      const error = await (boundedReads(engine!, startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts) as PostgresEngine).readDatabaseClock().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(PreparationDeadlineError);
      expect(typeof await (boundedReads(engine!, startClaimPhase(Date.now(), undefined, 10_000), opts) as PostgresEngine).readDatabaseClock()).toBe('string');
    }
  });
});
