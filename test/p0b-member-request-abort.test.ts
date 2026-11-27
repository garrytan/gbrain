/**
 * Typed members that replaced an `executeRaw` call must refuse a cancelled request before EVERY statement, as master's
 * `executeRaw` does (GBRA-156): a client that went away must not start work on the pool. Part P-0b moved these reads and
 * writes (belief ledger, purge epoch, withdrawals, projection jobs, write gate receipts, write context, topology and
 * request probes, link and chunk reads) onto the plain `engineSql` / `autocommitSql` executors, which do not check the
 * request signal; each now wraps its executor with `refuseAborted` (engine-sql/abort-aware.ts).
 *
 * Protects, for each listed member:
 * - run outside a request, it sends at least one statement (so the call below reaches the executor and the zero count
 *   under an aborted request means the refusal, not a short-circuit on the arguments);
 * - run under an aborted request, it rejects with the request's AbortError and sends no statement.
 * Fails when a member is routed through an executor without the abort check.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { derivationScope } from '../src/core/page-body/segment-derive.ts';

const UUID = '00000000-0000-0000-0000-000000000001';

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

const receipt = { content_hash: 'h', tier: 'agent_written', detector_version: 1, verdict: 'flag' as const, reason_families: [], reasons: [], detector_error: false, request_id: null };
const beliefRow = {
  event_key: 'aa', source_id: 'default', source_incarnation: UUID, page_lifetime: UUID, slug: 'a', subject_kind: 'page', subject_key: 'a', event_type: 'created',
  origin: 'o', trust_tier: 'agent_written', writer_tier: null, tier_basis: 'b', visibility: 'world', publication_id: UUID, ord: 1, source_time: null, valid_from: null,
  valid_until: null, value: null, value_hash: null, prior_hash: null, state_hash: 'h', cause: '{}', claim_fp: null, purged: false, redacted_fields: null,
};

// Writes on the autocommit executor, and reads on the plain engine executor, that master ran through executeRaw.
const MEMBERS: Array<[string, (e: BrainEngine) => Promise<unknown>]> = [
  ['bumpSourcePurgeEpoch', e => e.bumpSourcePurgeEpoch('default')],
  ['deleteProjectionJob', e => e.deleteProjectionJob({ sourceIncarnation: UUID, slug: 'a', revision: UUID })],
  ['endBeliefLifetime', e => e.endBeliefLifetime(UUID)],
  ['insertBeliefEvents', e => e.insertBeliefEvents([beliefRow])],
  ['insertFactWithdrawal', e => e.insertFactWithdrawal('default', 'world', 'claim', 'subject', null)],
  ['sealImportedPage', e => e.sealImportedPage('a', { sourceId: 'default', revision: UUID, timelineText: '', chunkerVersion: 1 })],
  ['setWriteContext', e => e.setWriteContext({ sourceIds: ['default'], requestId: null, principalKind: 'owner', principalId: 'o', tier: '', origin: '' })],
  ['upsertPageWriteGateReceipt', e => e.upsertPageWriteGateReceipt('default', 'a', receipt)],
  ['findTopologyChanges', e => e.findTopologyChanges('p', ['r'])],
  ['hasBeliefEvents', e => e.hasBeliefEvents('default')],
  ['hasPersistenceTable', e => e.hasPersistenceTable('persistence_brain')],
  ['listManagedRootBindings', e => e.listManagedRootBindings(UUID)],
  ['listPurgedTakeRows', e => e.listPurgedTakeRows('default', [{ id: 1, claim: 'c', holder: 'h' } as never], null)],
  ['readBeliefFactsById', e => e.readBeliefFactsById([1])],
  ['readOpenBeliefLifetimes', e => e.readOpenBeliefLifetimes([{ incarnation: UUID, slug: 'a' }])],
  ['readOwnerHostBinding', e => e.readOwnerHostBinding(UUID)],
  ['readSourcePurgeFlags', e => e.readSourcePurgeFlags('default')],
  ['readWriteRequestsByRequestIds', e => e.readWriteRequestsByRequestIds('owner', 'o', ['r'])],
  ['hasUnsealedPages', e => e.hasUnsealedPages({ sourceIds: ['default'], excludePrivate: false, excludeSlugPrefixes: [] } as never)],
  ['readLinkContextMatches', e => e.readLinkContextMatches([{ sourceId: 'default', name: 'a' } as never])],
  ['readLinkContextOriginPages', e => e.readLinkContextOriginPages([1])],
  ['readManifest', e => e.readManifest(1, { generation: 1 })],
  ['deleteChunksExcept', e => e.deleteChunksExcept('a', [1], { sourceId: 'default' })],
];

for (const [name, call] of MEMBERS) {
  test(`${name} sends a statement outside a request`, async () => {
    const { fake, engine } = fakeEngine();
    await call(engine).catch(() => undefined);
    expect(fake.statements().length).toBeGreaterThan(0);
  });

  test(`${name} refuses a cancelled request and sends nothing`, async () => {
    const { fake, engine } = fakeEngine();
    const error = await withRequestSignal(aborted(), () => call(engine)).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name).toBe('AbortError');
    expect(fake.statements()).toHaveLength(0);
  });
}

// The two-statement call sites whose second statement used to be a refused executeRaw: the request aborts while the
// first statement settles, and the second must not be sent.
test('derivationScope sends no manifest read after the request aborts during the page head read', async () => {
  const controller = new AbortController();
  const fake = makeFakeSql(stmt => {
    if (stmt.text.includes('body_storage')) { controller.abort(new Error('client went away')); return [{ id: 1, body_storage: 'segmented', body_generation: '1' }]; }
    return [];
  });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const error = await withRequestSignal(controller.signal, () => derivationScope(engine as unknown as BrainEngine, { id: 1, slug: 'x', source_id: 'default' } as never)).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().filter(s => s.text.includes('page_body_manifest'))).toHaveLength(0);
});

test('a projection replacement sends no DELETE after the request aborts during the keep-state read, inside its transaction', async () => {
  const controller = new AbortController();
  const fake = makeFakeSql(stmt => {
    if (stmt.text.includes('embedding_input_hash')) { controller.abort(new Error('client went away')); return []; }
    return [];
  });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const column = { name: 'embedding', dimensions: 1536 } as never;
  const error = await withRequestSignal(controller.signal, () => (engine as unknown as BrainEngine).transaction(async tx => {
    await tx.readChunkKeepState(1, null, column);
    await tx.deleteChunksExcept('a', [1], { sourceId: 'default' });
  })).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().filter(s => s.text.startsWith('DELETE FROM content_chunks'))).toHaveLength(0);
});

test('deleteChunksExcept outside a request still sends its DELETE inside a transaction', async () => {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await (engine as unknown as BrainEngine).transaction(async tx => { await tx.deleteChunksExcept('a', [1], { sourceId: 'default' }); });
  expect(fake.statements().some(s => s.text.includes('DELETE FROM content_chunks') && s.lane === 'tx')).toBe(true);
});
