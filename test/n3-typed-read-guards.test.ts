/**
 * The N3 reads that master issued through `executeRaw` keep what `executeRaw` gave them, now that they are typed engine
 * members (postgres-engine.ts `engineRead`): a request that already aborted sends no statement (GBRA-156), a doctor read
 * ends at the doctor's statement deadline (statement-deadline.ts BOUNDED_TYPED_READS), and a segmented-page read a
 * preparer makes ends at the claim clock's abort (persistence/bounded-reads.ts TYPED_PREPARATION_READS, #8155).
 *
 * Protects:
 * - each member that routes through `engineRead` refuses inside an aborted request with the request's AbortError and
 *   sends no statement, as `executeRaw` does;
 * - a request that aborts while a multi-statement read's first statement runs sends no second statement;
 * - the pin: the members that route through `engineRead` are exactly the members this file covers;
 * - the queue-health reads and the belief-coverage source read are in BOUNDED_TYPED_READS (the doctor deadline cases for
 *   them are in test/doctor-typed-reads-deadline.test.ts and doctor-typed-reads-stall.test.ts);
 * - the two segmented-page reads a preparation reaches end at the claim clock's abort and discard their connection.
 * Fails when `engineRead` skips the request-abort check, a member stops routing through it, or a member leaves
 * BOUNDED_TYPED_READS or TYPED_PREPARATION_READS.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { boundedReads, TYPED_PREPARATION_READS } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { BOUNDED_TYPED_READS } from '../src/core/statement-deadline.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});
const SPEC = { waitingThreshold: 1, oldWaitingHours: 1, windowHours: 24, stalledAfterHours: 1 };

/** Every member that postgres-engine.ts routes through `engineRead`. */
const CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  resolveCaseSensitiveAliases: (e) => e.resolveCaseSensitiveAliases(['a'], ['default']),
  readPageTitle: (e) => e.readPageTitle('default', 'people/a'),
  readPageAliasRows: (e) => e.readPageAliasRows(['default'], ['people/a']),
  readEntityAliasRows: (e) => e.readEntityAliasRows('default', ['people/a']),
  listForcedCutSeqs: (e) => e.listForcedCutSeqs(1, 1),
  readSegmentedVersionBodyBytes: (e) => e.readSegmentedVersionBodyBytes(1, 1),
  listCoveredSources: (e) => e.listCoveredSources('subject'),
  listExportWithdrawals: (e) => e.listExportWithdrawals('default'),
  readExportWithdrawalLedgerBytes: (e) => e.readExportWithdrawalLedgerBytes('default'),
  readQueueHealthSignals: (e) => e.readQueueHealthSignals(SPEC),
  listWaitingByQueue: (e) => e.listWaitingByQueue(),
  readQueueDivergence: (e) => e.readQueueDivergence({ windowHours: 24, ttlReasonPrefix: 'ttl:' }),
  listQueueWedgeCounts: (e) => e.listQueueWedgeCounts(),
  listPrivateQueueHealth: (e) => e.listPrivateQueueHealth(),
  readWedgeSignals: (e) => e.readWedgeSignals('default', ['sync']),
  readOldestWaitingAge: (e) => e.readOldestWaitingAge('default'),
  listStuckActiveJobsByName: (e) => e.listStuckActiveJobsByName(),
};
/** The members a doctor check reaches. */
const DOCTOR = ['listCoveredSources', 'listExportWithdrawals', 'readExportWithdrawalLedgerBytes', 'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth', 'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName'];
/** The members a segmented-page preparation reaches. */
const PREPARATION = ['listForcedCutSeqs', 'readSegmentedVersionBodyBytes'];

test('a request that aborts while the first statement of a multi-statement read runs sends no second statement', async () => {
  const controller = new AbortController();
  const { fake, engine } = fakeEngine(() => { controller.abort(new Error('client went away')); return []; });
  const error = await withRequestSignal(controller.signal, () => engine.readQueueHealthSignals(SPEC)).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().length).toBe(1);
});

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('client went away'));
  return controller.signal;
}

function fakeEngine(responder?: Parameters<typeof makeFakeSql>[0]) {
  const fake = makeFakeSql(responder);
  const counts = { discards: 0, releases: 0 };
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
  return { fake, counts, engine: engine as unknown as BrainEngine };
}

test('every engineRead member has a case, and the bounded sets list the members they must', () => {
  const proto = PostgresEngine.prototype;
  const members = Object.getOwnPropertyNames(proto).filter(name => {
    const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
    return name !== 'constructor' && name !== 'engineRead' && typeof fn === 'function' && String(fn).includes('this.engineRead(');
  });
  expect(members.sort()).toEqual(Object.keys(CALLS).sort());
  for (const member of DOCTOR) expect(BOUNDED_TYPED_READS.has(member), member).toBe(true);
  for (const member of PREPARATION) expect(TYPED_PREPARATION_READS.has(member), member).toBe(true);
});

for (const [member, call] of Object.entries(CALLS)) {
  test(`${member} refuses inside an aborted request, as executeRaw did, and sends no statement`, async () => {
    const { fake, engine } = fakeEngine();
    const error = await withRequestSignal(aborted(), () => call(engine)).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name, `${member} ran inside an aborted request`).toBe('AbortError');
    expect((error as Error).message).toBe('client went away');
    expect(fake.statements().length).toBe(0);
  });
}

for (const member of PREPARATION) {
  test(`${member} stalled on its connection ends at the preparation clock's abort and discards the connection`, async () => {
    const { counts, engine } = fakeEngine(stmt => (/page_body_manifest|page_versions/.test(stmt.text) ? never() : undefined));
    const controller = new AbortController();
    const reason = { code: 'preparation_deadline' };
    const reads = boundedReads(engine, startClaimPhase(Date.now(), controller.signal, 60_000));
    const call = CALLS[member]!(reads);
    setTimeout(() => controller.abort(reason), 20);
    const outcome = await Promise.race([call.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
    expect(outcome).toBe(reason);
    expect(counts).toEqual({ discards: 1, releases: 0 });
  });
}
