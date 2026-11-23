/**
 * The N4 reads that master issued through `executeRaw` keep what `executeRaw` gave them, now that they are typed engine
 * members: a request that already aborted sends no statement (GBRA-156), and the source-list read a doctor check makes
 * ends at the doctor's statement deadline (statement-deadline.ts BOUNDED_TYPED_READS).
 *
 * Protects:
 * - each N4 read member, on the Postgres engine inside an aborted request, rejects with the request's AbortError and
 *   sends no statement;
 * - outside an aborted request the same member still sends its statement;
 * - the source-list read is in BOUNDED_TYPED_READS and the clock, mention and basename reads are in TYPED_PREPARATION_READS.
 * Fails when a member stops refusing an aborted request, or leaves one of those sets.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { TYPED_PREPARATION_READS } from '../src/core/persistence/bounded-reads.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { BOUNDED_TYPED_READS } from '../src/core/statement-deadline.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { N4_CALLS } from './helpers/n4-read-calls.ts';

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('client went away'));
  return controller.signal;
}

function fakeEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { fake, engine: engine as unknown as BrainEngine };
}

test('the source-list read is a bounded typed read and the preparation reads are listed', () => {
  expect(BOUNDED_TYPED_READS.has('listSourceRecords')).toBe(true);
  for (const member of ['readDatabaseClock', 'readMentionLastPass', 'findExactBasenameCandidates']) expect(TYPED_PREPARATION_READS.has(member), member).toBe(true);
});

for (const [member, call] of Object.entries(N4_CALLS)) {
  test(`${member} refuses inside an aborted request, as executeRaw did, and sends no statement`, async () => {
    const { fake, engine } = fakeEngine();
    const error = await withRequestSignal(aborted(), () => call(engine)).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name, `${member} ran inside an aborted request`).toBe('AbortError');
    expect((error as Error).message).toBe('client went away');
    expect(fake.statements().length).toBe(0);
  });

  test(`${member} outside an aborted request still sends a statement`, async () => {
    const { fake, engine } = fakeEngine();
    await call(engine).catch(() => undefined);
    expect(fake.statements().length).toBeGreaterThan(0);
  });
}
