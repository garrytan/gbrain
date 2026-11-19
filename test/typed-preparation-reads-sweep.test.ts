/**
 * Typed engine reads that replaced a raw statement inside write preparation keep the preparation deadline the raw
 * statement had through the preparer's bounded view (persistence/bounded-reads.ts `TYPED_PREPARATION_READS`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for every read in the table, on Postgres and through either preparer view (with or without
 *    `engineReads`), the read past the budget is refused before its statement is sent; a read stalled on its connection
 *    ends at the clock's abort with the abort reason and its connection is discarded; the claim's last statement names
 *    the read. Without a deadline the read's statement goes out as before. On PGLite a preparer's view is the engine
 *    itself, so the read, like the raw statement it replaced, takes no deadline and answers past the budget.
 *  - Regression: each read replaced a raw statement a preparer sent through its bounded view; outside the set the
 *    typed read ran on the plain pool, so a lock or a dead connection held the preparation past its deadline.
 *  - Why existing coverage misses it: the deadline tests cover the seal-state read and the caller access reads only.
 *  - Seam: the recording fake postgres.js client (test/helpers/fake-postgres-sql.ts); PGLite runs in memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { boundedReads, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { makeFakeSql, type FakeSql } from './helpers/fake-postgres-sql.ts';

/** [member, a fragment of its statement, a call of it that sends the statement] */
const members: ReadonlyArray<readonly [string, string, (e: BrainEngine) => Promise<unknown>]> = [
  ['listGuestSourceIds', 'SELECT s.id FROM sources s WHERE s.id = ANY', e => e.listGuestSourceIds(['default'])],
  ['readDatabaseClock', 'clock_timestamp()', e => e.readDatabaseClock()],
  ['listStoredTimelineRowsOrdered', 'FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL', e => e.listStoredTimelineRowsOrdered(1)],
  ['matchTakeRows', 'FROM takes k', e => e.matchTakeRows(1, [{ row_num: 1, claim: 'a claim', kind: 'take', holder: 'self' }], 10)],
  ['listFactWithdrawalDates', 'JOIN fact_withdrawals w', e => e.listFactWithdrawalDates('default', [{ row_num: 1, claim: 'a claim', visibility: 'world' }], null)],
  ['listCorePageRows', 'FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter @>', e => e.listCorePageRows({ limit: 10 })],
  ['lockRegisteredSourceIds', 'FROM sources WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', e => e.lockRegisteredSourceIds(['default'])],
];
const views = [['managed sync (engineReads)', { engineReads: true }], ['page/maintenance preparer', {}]] as const;
const never = () => new Promise<never>(() => {});

function fakeEngine(fake: FakeSql): PostgresEngine {
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return engine;
}

describe('typed preparation reads keep the preparation deadline (Postgres)', () => {
  for (const [name, mark, run] of members) {
    test(`without a deadline ${name} sends its statement as before`, async () => {
      const fake = makeFakeSql();
      await run(boundedReads(fakeEngine(fake), startClaimPhase())).catch(() => undefined);
      expect(fake.statements().some(s => s.text.includes(mark))).toBe(true);
    });

    for (const [view, opts] of views) {
      test(`${view}: ${name} past the budget is refused before its statement is sent`, async () => {
        const fake = makeFakeSql();
        const reads = boundedReads(fakeEngine(fake), startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts);
        const error = await run(reads).then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(PreparationDeadlineError);
        expect((error as PreparationDeadlineError).sqlstate).toBeNull();
        expect(fake.statements().filter(s => s.text.includes(mark))).toEqual([]);
      });

      test(`${view}: ${name} stalled on its connection ends at the clock's abort and discards the connection`, async () => {
        const counts = { discards: 0, releases: 0 };
        const fake = makeFakeSql(stmt => (stmt.text.includes(mark) ? never() : undefined));
        const reserve = fake.sql.reserve;
        fake.sql.reserve = async () => {
          const r = await reserve();
          r.discard = () => { counts.discards++; };
          const release = r.release;
          r.release = () => { counts.releases++; release(); };
          return r;
        };
        const controller = new AbortController();
        const reason = { code: 'preparation_deadline' };
        const clock = startClaimPhase(Date.now(), controller.signal, 60_000);
        const call = run(boundedReads(fakeEngine(fake), clock, opts));
        setTimeout(() => controller.abort(reason), 20);
        const outcome = await Promise.race([call.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
        expect(outcome).toBe(reason);
        expect(counts).toEqual({ discards: 1, releases: 0 });
        expect(clock.lastSql?.label).toBe(`SELECT ${name}`);
      });
    }
  }
});

describe('typed preparation reads on PGLite match the raw statements: no preparation deadline', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  for (const [name, , run] of members) {
    test(`${name} answers past the budget`, async () => {
      const view = boundedReads(engine, startClaimPhase(Date.now() - 2_000, undefined, 1_000));
      expect(view).toBe(engine);
      await run(view);
    });
  }
});
