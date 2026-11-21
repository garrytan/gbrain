/**
 * Parity for the managed sync run's journal reads (engine-sql/sync-run-reads.ts): the admitted-request read of
 * persistence/sync-admitted.ts `readAdmitted` and the two reads of the `concurrent_write` proof
 * (persistence/sync-concurrent-write.ts `concurrentWriteProof`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1) readAdmittedWriteRequests returns the asked principal's rows under the named request ids,
 *    each once, never another principal's, and only committed ones when asked; readPageRevisionWriter names a page's
 *    live revision and the journal row that wrote it inside its source, or null; readRevisionWriterRequest projects that
 *    journal row, or null; and concurrentWriteProof proves a non-sync write that changed the page and nothing else.
 *  - Regression: a read that serves another principal's request lets a sync pass publish work it never admitted; a
 *    wrong writer or revision holds a file as `concurrent_write` without proof, or overwrites a database-only write.
 *  - Why existing coverage misses it: the three statements ran through `executeRaw`, which the Rust engine refuses,
 *    and test/sync-owner-lane-processing-6696.test.ts runs on PGLite and Postgres only. The statement texts are pinned
 *    by test/engine-sql-caller-raw-sql-pins.test.ts.
 *  - Seam: requests are admitted, claimed and completed through the journal members; a page's writer is stamped by a
 *    transaction whose write settings name the request, as the persistence scope sets them. Row ids differ between
 *    arms, so they are compared by role; revisions by presence and equality.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { refusesInput } from './input-refusal.ts';
import { readAdmitted } from '../../src/core/persistence/sync-admitted.ts';
import { concurrentWriteProof } from '../../src/core/persistence/sync-concurrent-write.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

const { parityTest } = parityArms(testBackends());

const rid = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const UNKNOWN = 'e0000000-0000-4000-8000-0000000000ff';
const SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];
let claims = 0;

/** Admits one request of `local_cli:principalId` (queued), and completes it as `terminal` when given; returns its row id. */
async function admit(engine: BrainEngine, n: number, principalId: string, opts: { operation?: string; kind?: string; pageId?: number | null;
  terminal?: 'committed' | 'failed' } = {}): Promise<string> {
  const source = await engine.readSourceMembership('default');
  const keys = [`principal:local_cli:${principalId}`, 'brain'];
  const operation = opts.operation ?? 'put_page';
  await engine.lockPersistenceCounters(keys);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId, requestId: rid(n), operation, sourceId: 'default', sourceIncarnation: source!.incarnation,
    pageId: opts.pageId ?? null, slug: `notes/req-${n}`, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64),
    intent: { kind: opts.kind ?? operation, slug: `notes/req-${n}` }, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096,
    targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued',
    deferredRefreshId: null,
  });
  if (!opts.terminal) return row.id;
  await engine.stampWriteClaim(row.id, `c1000000-0000-4000-8000-0000000000${String(++claims).padStart(2, '0')}`, 60_000, JSON.stringify({ phase: 'parity' }));
  await engine.completeWriteRow({
    id: row.id, state: opts.terminal, outcome: { status: 'ok' }, errorCode: opts.terminal === 'failed' ? 'parity_error' : null,
    errorMessage: opts.terminal === 'failed' ? 'parity' : null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null, resultBytes: 100,
    counterKeys: keys, intentBytes: 100, retainedBytes: 500, terminalReservation: 4096, probePurges: false,
  });
  return row.id;
}

/** A request row named by its request id, state and principal, with its column names (the row shape both callers read). */
const view = (rows: WriteRequest[]) => rows.map(r => ({ request_id: String(r.request_id).toLowerCase(), state: r.state, principal: `${r.principal_kind}:${r.principal_id}`,
  operation: r.operation, columns: Object.keys(r).sort().join(',') })).sort((a, b) => a.request_id.localeCompare(b.request_id));

parityTest('readAdmittedWriteRequests reads only the asked principal\'s requests, each once, and only committed ones when asked', {
  methods: ['readAdmittedWriteRequests', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'completeWriteRow', 'readSourceMembership'],
}, async (engine) => {
  await admit(engine, 1, 'writer-a', { terminal: 'committed' });
  await admit(engine, 2, 'writer-a');
  await admit(engine, 3, 'writer-b', { terminal: 'committed' });
  await admit(engine, 4, 'writer-a', { terminal: 'failed' });
  const asked = [rid(1), rid(2), rid(3), rid(4), UNKNOWN, rid(1).toUpperCase()];
  const cursor = { authority: { writer: { principal: { kind: 'local_cli', id: 'writer-a' } } } } as never;
  const members = [
    { requestId: rid(1), intent: {} }, { requestId: rid(2), intent: {} },
    { requestId: rid(3), intent: { syncAuthority: { writer: { principal: { kind: 'local_cli', id: 'writer-b' } } } } },
  ] as never;
  const out = {
    all: view(await engine.readAdmittedWriteRequests('local_cli', 'writer-a', asked, false)),
    committed: view(await engine.readAdmittedWriteRequests('local_cli', 'writer-a', asked, true)),
    otherKind: view(await engine.readAdmittedWriteRequests('mcp_token', 'writer-a', asked, false)),
    none: view(await engine.readAdmittedWriteRequests('local_cli', 'writer-a', [], false)),
    perPrincipal: view(await readAdmitted(engine, cursor, members)),
    perPrincipalCommitted: view(await readAdmitted(engine, cursor, members, true)),
  };
  const ids = (rows: Array<{ request_id: string }>) => rows.map(r => r.request_id);
  expect([ids(out.all), ids(out.committed), ids(out.otherKind), ids(out.perPrincipal), ids(out.perPrincipalCommitted)])
    .toEqual([[rid(1), rid(2), rid(4)], [rid(1)], [], [rid(1), rid(2), rid(3)], [rid(1), rid(3)]]);
  return out;
});

parityTest('readPageRevisionWriter and readRevisionWriterRequest name a page\'s writer, and concurrentWriteProof proves only a non-sync write', {
  methods: ['readPageRevisionWriter', 'readRevisionWriterRequest', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'applyTransactionSettings', 'putPage', 'transaction'],
}, async (engine) => {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  const plain = await engine.putPage('notes/plain', { type: 'note', title: 'Plain', compiled_truth: 'plain', timeline: '' });
  const page = await engine.putPage('notes/raced', { type: 'note', title: 'Raced', compiled_truth: 'v1', timeline: '' });
  const pageId = Number(page.id);
  const before = await engine.readPageRevisionWriter(pageId, 'default');
  const writer = await admit(engine, 10, 'writer-a', { operation: 'put_page', pageId, terminal: 'committed' });
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(SETTINGS, [writer, 'local_cli', 'writer-a']);
    await tx.putPage('notes/raced', { type: 'note', title: 'Raced', compiled_truth: 'v2 from the database', timeline: '' });
  });
  const after = await engine.readPageRevisionWriter(pageId, 'default');
  const role = (id: string | null | undefined) => id == null ? id : id === writer ? 'writer' : `other:${typeof id}`;
  // Page ids are per-arm sequences: the projected page id is compared by the page it names.
  const request = (r: Awaited<ReturnType<BrainEngine['readRevisionWriterRequest']>>, expectedPage: number) =>
    r && { ...r, page_id: Number(r.page_id) === expectedPage ? 'page' : r.page_id, incarnation: r.incarnation === incarnation ? 'live' : r.incarnation };
  const proof = (expected: string | null, inc = incarnation, kind = 'managed_sync_import', error = 'revision_conflict') =>
    concurrentWriteProof(engine, { sourceId: 'default', incarnation: inc, pending: { pageId, intent: { kind, expected_revision: expected } as never },
      done: { error_code: error } as never });
  const proven = await proof(before!.revision);
  // A page written by a managed sync request proves nothing (the race is the sync's own).
  const syncPage = await engine.putPage('notes/synced', { type: 'note', title: 'Synced', compiled_truth: 'v1', timeline: '' });
  const syncWriter = await admit(engine, 11, 'writer-a', { operation: 'sync', kind: 'managed_sync_import', pageId: Number(syncPage.id), terminal: 'committed' });
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(SETTINGS, [syncWriter, 'local_cli', 'writer-a']);
    await tx.putPage('notes/synced', { type: 'note', title: 'Synced', compiled_truth: 'v2', timeline: '' });
  });
  const synced = await engine.readPageRevisionWriter(Number(syncPage.id), 'default');
  const out = {
    plain: { ...(await engine.readPageRevisionWriter(Number(plain.id), 'default')), revision: 'present' },
    before: { revision: typeof before?.revision, writer: role(before?.writer) },
    after: { revisionChanged: after?.revision !== before?.revision, revision: typeof after?.revision, writer: role(after?.writer) },
    otherSource: await engine.readPageRevisionWriter(pageId, 'no-such-source'),
    absentPage: await engine.readPageRevisionWriter(pageId + 100_000, 'default'),
    request: request(await engine.readRevisionWriterRequest(after!.writer!), pageId),
    requestUpper: request(await engine.readRevisionWriterRequest(after!.writer!.toUpperCase()), pageId),
    absentRequest: await engine.readRevisionWriterRequest(UNKNOWN),
    syncRequest: request(await engine.readRevisionWriterRequest(synced!.writer!), Number(syncPage.id)),
    proven: proven && { ...proven, revision: proven.revision === after!.revision },
    sameRevision: await proof(after!.revision),
    otherIncarnation: await proof(before!.revision, 'f0000000-0000-4000-8000-000000000000'),
    notImport: await proof(before!.revision, incarnation, 'put_page'),
    notConflict: await proof(before!.revision, incarnation, 'managed_sync_import', 'parity_error'),
    syncWritten: await concurrentWriteProof(engine, { sourceId: 'default', incarnation, pending: { pageId: Number(syncPage.id),
      intent: { kind: 'managed_sync_import', expected_revision: '0' } as never }, done: { error_code: 'revision_conflict' } as never }),
  };
  expect(out.proven).toEqual({ request_id: rid(10), operation: 'put_page', revision: true });
  expect([out.after.writer, out.plain.writer, out.request?.state, out.request?.page_id, out.sameRevision, out.otherIncarnation, out.notImport, out.notConflict, out.syncWritten])
    .toEqual(['writer', null, 'committed', 'page', null, null, null, null, null]);
  return out;
});

parityTest('the sync run reads refuse a malformed request id instead of answering nothing', {
  methods: ['readAdmittedWriteRequests', 'readRevisionWriterRequest'],
}, async (engine) => {
  const refuses = refusesInput;
  return {
    admitted: await refuses(engine.readAdmittedWriteRequests('local_cli', 'writer-a', ['not-a-uuid'], false)),
    writerRequest: await refuses(engine.readRevisionWriterRequest('not-a-uuid')),
    // Control: a well-formed id that names no request answers nothing.
    admittedUnknown: await engine.readAdmittedWriteRequests('local_cli', 'writer-a', [UNKNOWN], false),
    writerUnknown: await engine.readRevisionWriterRequest(UNKNOWN),
  };
});
