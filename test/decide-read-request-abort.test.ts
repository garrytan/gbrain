/**
 * GBRA-156 for the typed decide reads (postgres-engine.ts `decideRead`). On master these reads went through
 * `engine.executeRaw`, which refuses every statement of a request whose signal has fired (`throwIfRequestAborted`),
 * so a request nobody waits for sends no more decide queries and holds no more connections. The typed members run
 * through `preparationRead`, whose no-deadline path goes straight to the autocommit executor.
 *
 * Protects: each typed decide read, called inside a request whose signal already aborted, rejects with the request's
 * AbortError and sends no statement, exactly as `executeRaw` does.
 * Fails when `decideRead` or a moved open-loop, timeline-read or write-side member skips the request-abort check.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** Every member that postgres-engine.ts routes through `decideRead`. */
const CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  readDecideState: (e) => e.readDecideState('request_abort_probe'),
  dailyDecideSpend: (e) => e.dailyDecideSpend(new Date(Date.now() - 86_400_000)),
  listDecideReceiptStats: (e) => e.listDecideReceiptStats({ sinceHours: 24 }),
  decideSlotUsage: (e) => e.decideSlotUsage(24),
  listDecideResolvedModels: (e) => e.listDecideResolvedModels(24),
  listDecideMixedModelDecisions: (e) => e.listDecideMixedModelDecisions(24),
  listDecideCalibrations: (e) => e.listDecideCalibrations({ includeRetired: true }),
};

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

test('every decideRead member has a case', () => {
  // The engine's own runtime surface: every prototype method whose body routes through decideRead.
  const proto = PostgresEngine.prototype;
  const members = Object.getOwnPropertyNames(proto).filter(name => {
    const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
    return name !== 'constructor' && name !== 'decideRead' && typeof fn === 'function' && String(fn).includes('this.decideRead(');
  });
  expect(members.sort()).toEqual(Object.keys(CALLS).sort());
});

test('control: executeRaw refuses a statement of an aborted request and sends nothing', async () => {
  const { fake, engine } = fakeEngine();
  const error = await withRequestSignal(aborted(), () => engine.executeRaw('SELECT 1')).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().length).toBe(0);
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

/**
 * The typed members that replaced `executeRaw` statements in the open-loop, timeline-read and write-side-read moves
 * (engine-sql/open-loops.ts, timeline-reads.ts, write-misc.ts) refuse an aborted request the same way: reads and
 * writes alike, with or without a read deadline. The arguments never reach SQL, so a placeholder stands in for each.
 */
const any = undefined as never;
const MOVED_CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  readSourceState: (e) => e.readSourceState('default'),
  readSourceStateShareLock: (e) => e.readSourceState('default', { lock: 'share' }),
  readAdmissionSource: (e) => e.readAdmissionSource('default'),
  sharedSkillPackTablePresent: (e) => e.sharedSkillPackTablePresent(),
  listSharedSkillPackRoots: (e) => e.listSharedSkillPackRoots('host'),
  getWorktreeBinding: (e) => e.getWorktreeBinding('default', null),
  hasExtractedEvents: (e) => e.hasExtractedEvents('default', 1),
  listActiveAccessMembers: (e) => e.listActiveAccessMembers(),
  hasLabelledOnlyMember: (e) => e.hasLabelledOnlyMember(),
  listAccessTokens: (e) => e.listAccessTokens(),
  notifierCoverageRecorded: (e) => e.notifierCoverageRecorded(),
  readOpCheckpointKeys: (e) => e.readOpCheckpointKeys('op', 'fingerprint'),
  readHealthMemoClock: (e) => e.readHealthMemoClock(),
  listSynopsisSourceIds: (e) => e.listSynopsisSourceIds(),
  expireMemoryProposals: (e) => e.expireMemoryProposals('reason'),
  listAwaitingMemoryProposals: (e) => e.listAwaitingMemoryProposals(10),
  readMemoryProposal: (e) => e.readMemoryProposal('user', 'id', 'request'),
  purgeMemoryProposals: (e) => e.purgeMemoryProposals(30),
  readPendingProposalSummary: (e) => e.readPendingProposalSummary(),
  listMemoryProposalRows: (e) => e.listMemoryProposalRows({ sourceId: null, all: true, limit: 10, afterAt: null, afterId: null }),
  listOwnerProposalRows: (e) => e.listOwnerProposalRows('request'),
  attachSourcePath: (e) => e.attachSourcePath('default', '/tmp/brain'),
  sampleEffectiveDates: (e) => e.sampleEffectiveDates(),
  sampleEffectiveDateSources: (e) => e.sampleEffectiveDateSources(),
  readMaxTimelineEntryId: (e) => e.readMaxTimelineEntryId(),
  listStoredTimelineRowsOrdered: (e) => e.listStoredTimelineRowsOrdered(1),
  deleteTimelineRows: (e) => e.deleteTimelineRows(1, []),
  storedTimelineRowsByPageIds: (e) => e.storedTimelineRowsByPageIds([1]),
  countSegmentedTimelinePages: (e) => e.countSegmentedTimelinePages(['default'], 10),
  countTimelineCommentMarkupRows: (e) => e.countTimelineCommentMarkupRows(['default']),
  listTimelineOrphanPages: (e) => e.listTimelineOrphanPages({ afterId: 0, limit: 10 }),
  upsertOpenLoop: (e) => e.upsertOpenLoop(any),
  closeOpenLoop: (e) => e.closeOpenLoop('default', 1, 'done', 'test'),
  listOpenLoops: (e) => e.listOpenLoops(),
  readEntityOpenLoops: (e) => e.readEntityOpenLoops('people/a', 'default', 10),
};

test('every moved member that routes through the abort check has a case', () => {
  const proto = PostgresEngine.prototype;
  const members = Object.getOwnPropertyNames(proto).filter(name => {
    const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
    const body = typeof fn === 'function' ? String(fn) : '';
    return name !== 'constructor' && !['writeMiscRead', 'timelineBoundedRead'].includes(name)
      && /(whenNotAborted\(|this\.(writeMiscRead|timelineBoundedRead)\()/.test(body);
  });
  expect(members.sort()).toEqual(Object.keys(MOVED_CALLS).filter(name => name !== 'readSourceStateShareLock').sort());
});

for (const [member, call] of Object.entries(MOVED_CALLS)) {
  test(`${member} refuses inside an aborted request and sends no statement`, async () => {
    const { fake, engine } = fakeEngine();
    const error = await withRequestSignal(aborted(), () => call(engine)).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name, `${member} ran inside an aborted request`).toBe('AbortError');
    expect((error as Error).message).toBe('client went away');
    expect(fake.statements().length).toBe(0);
  });
}

/**
 * A request that aborts while a member's first statement is running must not send the member's next statement.
 * `executeRaw` refused every statement of an aborted request, so the two members that run a second statement
 * (a count, then a sample; an upsert, then the row lookup) check before each one.
 */
test('countSegmentedTimelinePages sends no sample statement when the request aborts during the count', async () => {
  const controller = new AbortController();
  const fake = makeFakeSql(() => { controller.abort(new Error('client went away')); return [{ pages: 1, rows: 1 }]; });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const error = await withRequestSignal(controller.signal, () => (engine as unknown as BrainEngine).countSegmentedTimelinePages(['default'], 10)).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().length).toBe(1);
});

test('upsertOpenLoop sends no row lookup when the request aborts during the insert', async () => {
  const controller = new AbortController();
  const fake = makeFakeSql(() => { controller.abort(new Error('client went away')); return []; });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const loop = { sourceId: 'default', dedupKey: 'thread:a', loopType: 'unanswered_inbound', summary: 's', evidence: [], detector: 'deterministic_thread' } as never;
  const error = await withRequestSignal(controller.signal, () => (engine as unknown as BrainEngine).upsertOpenLoop(loop)).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().length).toBe(1);
});
