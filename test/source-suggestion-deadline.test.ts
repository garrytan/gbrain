/**
 * The "did you mean" read behind an unknown source id (src/core/source-resolver.ts `nearestSourceId`) under the
 * doctor's read deadline (src/core/statement-deadline.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when `--source`, `GBRAIN_SOURCE`, a dotfile or `sources.default` names a source that does not exist,
 *    resolution throws its "not found" error. Inside a doctor check the suggestion read that error makes is bounded by
 *    the doctor deadline: a connection that stops answering ends the read at the deadline, the connection is discarded,
 *    and the error comes back without a suggestion.
 *  - Regression: on master the suggestion was an `executeRaw` statement, which the deadline-bound engine ended at the
 *    deadline. A typed read outside `DEADLINE_BOUND_READS` runs to its end, so a stalled suggestion read outlives the
 *    doctor deadline and the check hangs.
 *  - Why existing coverage misses it: test/doctor-typed-reads-stall.test.ts calls each bounded member directly; it
 *    cannot see which member a resolver path calls.
 *  - Seam: no database. The Postgres engine runs on the recording fake (test/helpers/fake-postgres-sql.ts), as
 *    test/doctor-typed-reads-stall.test.ts does: the source-row check answers "no such source", every other read of
 *    `sources` never answers.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { deadlineBoundEngine, withStatementDeadline, type StatementDeadline } from '../src/core/statement-deadline.ts';
import { resolveSourceId, SourceTargetError } from '../src/core/source-resolver.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});
const DEADLINE_MS = 60;
/** Well under any wait the stalled read could end on its own, well over the timer's slack. */
const SETTLE_MS = 1_000;

test('a stalled suggestion read for an unknown --source ends by the doctor deadline and gives back its connection', async () => {
  const counts = { discards: 0, releases: 0 };
  const statements: string[] = [];
  const fake = makeFakeSql((stmt) => {
    if (!/FROM sources/i.test(stmt.text)) return undefined;
    statements.push(stmt.text);
    // The existence check for the named source: no such source.
    if (/WHERE id\s*=\s*\$1/i.test(stmt.text)) return [];
    return never();
  });
  const reserve = fake.sql.reserve;
  fake.sql.reserve = async () => {
    const r = await reserve();
    r.discard = () => { counts.discards++; };
    const release = r.release;
    r.release = () => { counts.releases++; release(); };
    return r;
  };
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const scope: StatementDeadline = { startedAt: Date.now(), deadlineAt: Date.now() + DEADLINE_MS, expired: false };
  const bound = deadlineBoundEngine(engine as unknown as BrainEngine);
  const outcome = await Promise.race([
    withStatementDeadline(scope, () => resolveSourceId(bound, 'notes', '/nowhere/in/particular', { skipLocalSignals: true }))
      .then(() => 'resolved', (error: unknown) => error),
    Bun.sleep(DEADLINE_MS + SETTLE_MS).then(() => 'still pending'),
  ]);
  expect(outcome, 'the suggestion read did not end by the doctor deadline').not.toBe('still pending');
  // The suggestion read was reached: the existence check and then one stalled read.
  expect(statements.length).toBeGreaterThanOrEqual(2);
  // The unknown source still gets its "not found" error, without a suggestion.
  expect(outcome).toBeInstanceOf(SourceTargetError);
  expect((outcome as Error).message).toBe(
    'Source "notes" not found or is archived. Available active sources: run `gbrain sources list` to see registered sources, ' +
      'or create/restore "notes" before retrying.',
  );
  expect(scope.expired).toBe(true);
  // The stalled connection is discarded, not given back to the pool; a read that answered may release its own.
  expect(counts.discards).toBe(1);
  expect((engine as unknown as { checkoutGauge: { snapshot(): Record<string, number> } }).checkoutGauge.snapshot().reserved).toBe(0);
}, 10_000);
