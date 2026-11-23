/**
 * The two typed access reads a write's caller record needs, readLiveMember (access/caller.ts memberIdentityFor) and
 * readFolderAccess (folderAccessFor), keep the preparation deadline the raw statements they replaced had.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on Postgres, through a preparer's bounded view (persistence/bounded-reads.ts `boundedReads`, with or
 *    without `engineReads`), each read is refused before any statement is sent once the budget ran out, ends at the
 *    clock's abort with the abort reason and discards its stalled connection, and stamps the claim's last statement.
 *    With no deadline each still runs through the engine's own executeRaw. On PGLite a preparer's view is the engine
 *    itself, so neither the reads nor a raw statement take a deadline there: both answer past the budget.
 *  - Regression: before the typed members, caller.ts ran the member and folder statements through the view's
 *    executeRaw, which bounded them. The typed members were not in `TYPED_PREPARATION_READS` and ran on the plain
 *    pool, so a lookup blocked on a lock or a dead socket held a write's preparation past its deadline.
 *  - Why existing coverage misses it: test/typed-preparation-read-abort.test.ts and the Postgres e2e exercise only
 *    the seal-state read; nothing put the caller access reads behind a preparer's deadline.
 *  - Seam: the recording fake postgres.js client (test/helpers/fake-postgres-sql.ts); PGLite runs in memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { FOLDER_COVERAGE_SQL } from '../src/core/engine-sql/access-control.ts';
import { boundedReads, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { makeFakeSql, type FakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});
const MEMBER_MARK = 'FROM access_members m';
const FOLDER_MARK = 'FROM access_pending_coverage';

const reads = [
  ['readLiveMember', MEMBER_MARK, (e: BrainEngine) => e.readLiveMember('member', 'alice-example')],
  ['readFolderAccess', FOLDER_MARK, (e: BrainEngine) => e.readFolderAccess(['member:alice-example'])],
] as const;
const views = [['managed sync (engineReads)', { engineReads: true }], ['page/maintenance preparer', {}]] as const;

function fakeEngine(fake: FakeSql): PostgresEngine {
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return engine;
}

describe('caller access reads keep the preparation deadline (Postgres)', () => {
  for (const [name, mark, run] of reads) {
    for (const [view, opts] of views) {
      test(`${view}: ${name} past the budget is refused before any statement is sent`, async () => {
        const fake = makeFakeSql();
        const view$ = boundedReads(fakeEngine(fake), startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts);
        const error = await run(view$).then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(PreparationDeadlineError);
        expect((error as PreparationDeadlineError).code).toBe('preparation_deadline');
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

    test(`without a deadline ${name} runs through the engine's own executeRaw`, async () => {
      const fake = makeFakeSql();
      const engine = fakeEngine(fake);
      const sent: string[] = [];
      engine.executeRaw = (async (sql: string) => { sent.push(sql); return []; }) as typeof engine.executeRaw;
      await run(boundedReads(engine, startClaimPhase()));
      expect(sent.some(text => text.includes(mark))).toBe(true);
      expect(fake.statements()).toEqual([]);
    });
  }
});

describe('caller access reads on PGLite match the raw statements: no preparation deadline', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('past the budget both typed reads and the folder statement they replaced still answer', async () => {
    const view = boundedReads(engine, startClaimPhase(Date.now() - 2_000, undefined, 1_000));
    expect(view).toBe(engine);
    expect(await view.readLiveMember('member', 'alice-example')).toBeNull();
    const raw = await view.executeRaw(FOLDER_COVERAGE_SQL);
    expect(await view.readFolderAccess(['member:alice-example'])).toEqual({ rules: [], coverage: raw as never });
  });
});
