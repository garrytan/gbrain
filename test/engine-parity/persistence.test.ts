/**
 * BrainEngine parity — the write-journal members (engine-sql/persistence-journal.ts and persistence-claims.ts): the
 * limit read, the hold reads (held pages, held coverage, git sync holds, held fence results), one request's admission, claim and completion (in a transaction and member by member),
 * the publication's effects insert and the receipt's read of them, the claim upkeep (renewal, expiry, the claimable probe, the FIFO head read) and the admission reads (source membership, topology changes,
 * the ledger's source view), and the head-blocker probe (the earlier head a queued request waits behind).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the journal limit rows, the held-page and held-coverage reads, and the request lifecycle (lock the
 *    counters, insert the request, read it by request id and by journal id, stamp the claim, lock it, complete it)
 *    return the same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of these differently (a limit key outside the prefix, a missing sentinel
 *    row, a counter that is not charged or not released, a claim that does not stamp the state) changes which writes a
 *    brain admits and when they finish; the Rust engine has no SQL, so each statement has to exist as a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside journal.ts, limits.ts and
 *    held-reads.ts, which the parity cases cannot call (D18), so no case compared them across engines.
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). Generated values (the request's journal id, its
 *    sequence, time stamps, the source incarnation) are compared by shape or left out of the returned value.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, createSource, parityArms } from './harness.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { fenceHoldEntries, fenceReadOf } from '../../src/core/generations/fence.ts';
import { projectFactFenceGeneration } from '../../src/core/generations/adapters/fact-rows.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import type { ClaimHeadSpec, TopologyChange } from '../../src/core/engine-sql/persistence-claims.ts';
import type { QueuedPublicationEffect } from '../../src/core/engine-sql/persistence-journal.ts';
import { assertPageRequestIdentity, completeWrite, releaseUnpublishedClaim } from '../../src/core/persistence/journal.ts';
import { countPendingProjections, countProjectionRebuild, type CoverageRelevance } from '../../src/core/search/retrieval-coverage.ts';
import { CONSUMER_LIVE_MS, listHostConsumers, probeLiveFullConsumer, RESIDENT_CONSUMER_KINDS, startConsumerHeartbeat } from '../../src/core/persistence/consumer-heartbeat.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const REQUEST = 'b0000000-0000-4000-8000-0000000000b1';
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

/** The counters as numbers, keyed by counter key. */
const counters = (rows: Array<{ key: string; outstanding_count: number | string; intent_bytes: number | string; lifetime_ids: number | string; terminal_bytes: number | string }>) =>
  Object.fromEntries(rows.map(r => [r.key, { outstanding: Number(r.outstanding_count), intentBytes: Number(r.intent_bytes), lifetimeIds: Number(r.lifetime_ids), terminalBytes: Number(r.terminal_bytes) }]));

/** The request columns every arm stores the same way. */
const view = (row: WriteRequest | null) => row && {
  principal: `${row.principal_kind}:${row.principal_id}`, requestId: row.request_id, operation: row.operation, source: row.source_id,
  slug: row.slug, state: row.state, digest: row.digest, intent: row.intent, authority: row.authority, targetKind: row.target_kind,
  protocol: row.protocol_version, intentBytes: Number(row.intent_bytes), terminalReservation: Number(row.terminal_reservation),
  outcome: row.outcome ?? null, errorCode: row.error_code ?? null, idIsUuid: UUID.test(row.id), completed: row.completed_at != null,
};

const HOST = 'e0000000-0000-4000-8000-0000000000e1';
const OTHER_TOKEN = 'c0000000-0000-4000-8000-0000000000c2';

/** The insert one parity request uses; `requestId` and `state` vary per case. */
const insertRow = (incarnation: string, requestId = REQUEST) => ({
  principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId: 'default',
  sourceIncarnation: incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
  digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
  terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
  clientRequestId: null, state: 'queued' as const, deferredRefreshId: null,
});

/** Admits one queued request outside a transaction, as each member runs on its own; returns its journal id. */
async function admitDirect(engine: BrainEngine, requestId = REQUEST): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(KEYS);
  return (await engine.insertWriteRequest(insertRow(source!.incarnation, requestId))).id;
}

const WRITER = 'd0000000-0000-4000-8000-0000000000d1';
const OTHER_WRITER = 'd0000000-0000-4000-8000-0000000000d2';

/** A source-remove receipt of WRITER under REQUEST. */
const lifecycleRow = (incarnation: string) => ({
  principalId: WRITER, requestId: REQUEST, digest: 'e'.repeat(64), operation: 'remove', sourceId: 'default', sourceIncarnation: incarnation,
  worktreeIds: [], state: 'recovering' as const, recovery: { step: 1 }, recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096,
  outcome: { operation: 'remove', source_id: 'default' },
});

/** The receipt columns every arm stores the same way. */
const topologyView = (row: TopologyChange | null, incarnation: string) => row && {
  idIsUuid: UUID.test(row.id), principal: row.principal_id, request: row.request_id, digest: row.digest, operation: row.operation,
  source: row.source_id, incarnation: row.source_incarnation === incarnation, worktrees: row.worktree_ids, state: row.state,
  recovery: row.recovery, recoveryBytes: Number(row.recovery_bytes), intentBytes: Number(row.intent_bytes),
  terminalBytes: Number(row.terminal_bytes), outcome: row.outcome,
};

async function lifecycle(engine: BrainEngine) {
  const source = await engine.readLedgerSource('default');
  expect(source?.incarnation).toMatch(UUID);
  return engine.transaction(async (tx) => {
    const locked = counters(await tx.lockPersistenceCounters(KEYS));
    const inserted = await tx.insertWriteRequest({
      principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId: REQUEST, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    const charged = counters(await tx.lockPersistenceCounters(KEYS));
    const byRequest = await tx.readWriteRequest(PRINCIPAL.kind, PRINCIPAL.id, REQUEST);
    const byId = await tx.readWriteRequestById(inserted.id);
    const unknown = await tx.readWriteRequest(PRINCIPAL.kind, PRINCIPAL.id, 'b0000000-0000-4000-8000-0000000000b2');
    const claimed = await tx.stampWriteClaim(inserted.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const claim = claimed && { ...view(claimed), passedSync: claimed.passed_sync, seenSequence: claimed.seen_sequence, token: claimed.execution_token };
    const lockedRow = view(await tx.lockWriteRequest(inserted.id));
    const done = await tx.completeWriteRow({
      id: inserted.id, state: 'committed', outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: 'parity',
      consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500,
      terminalReservation: 4096, probePurges: true,
    });
    const completed = done && { ...view(done), purgeFacts: done.purge_has_facts, purgePages: done.purge_has_pages };
    const released = counters(await tx.lockPersistenceCounters(KEYS));
    return { locked, inserted: view(inserted), charged, byRequest: view(byRequest), sameRow: byId?.id === inserted.id, unknown, claim, lockedRow, completed, released };
  });
}

describe('engine parity: write journal', () => {
  parityTest('readJournalLimitRows returns the persistence.limits.* and page-body config rows, then the segmented-page row', { methods: ['setConfig', 'readJournalLimitRows'] }, async (engine) => {
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '10');
    await engine.setConfig('persistence.limits.brain_outstanding', '50');
    await engine.setConfig('pages.max_bytes', '2000000');
    await engine.setConfig('persistence.limitsx', 'not a limit');
    await engine.setConfig('parity.journal.other', 'not a limit');
    const rows = await engine.readJournalLimitRows();
    const keyed = rows.filter(r => r.key !== null).sort((a, b) => a.key!.localeCompare(b.key!));
    const sentinel = rows.filter(r => r.key === null);
    expect(keyed).toEqual([
      { key: 'pages.max_bytes', value: '2000000' },
      { key: 'persistence.limits.brain_outstanding', value: '50' },
      { key: 'persistence.limits.principal_lifetime_ids', value: '10' },
    ]);
    expect(sentinel).toEqual([{ key: null, value: null }]);
    expect(rows.at(-1)).toEqual({ key: null, value: null });
    return { keyed, sentinel };
  });

  parityTest('the hold reads are empty on a brain with no held files', { methods: ['readHeldPageRows', 'readHeldCoverageRows'] }, async (engine) => {
    const pages = await engine.readHeldPageRows(['1', '2']);
    const noPages = await engine.readHeldPageRows([]);
    const everySource = await engine.readHeldCoverageRows(null);
    const oneSource = await engine.readHeldCoverageRows(['default']);
    const answers = { pages, noPages, everySource, oneSource };
    expect(answers).toEqual({ pages: [], noPages: [], everySource: [], oneSource: [] });
    return answers;
  });

  parityTest('readGitHoldRecords finds no git sync holds on a brain with no held files, for every source, one source or one run', { methods: ['readGitHoldRecords'] }, async (engine) => {
    const everySource = await engine.readGitHoldRecords();
    const oneSource = await engine.readGitHoldRecords({ sourceIds: ['default'] });
    const oneRun = await engine.readGitHoldRecords({ sourceIds: ['default', 'other'], runId: 'run-1' });
    const answers = { everySource, oneSource, oneRun };
    expect(answers).toEqual({ everySource: [], oneSource: [], oneRun: [] });
    return answers;
  });

  parityTest('readGitHoldRetryRequest finds no pending retry-held request on a brain that never asked for one', { methods: ['readGitHoldRetryRequest'] }, async (engine) => {
    const request = await engine.readGitHoldRetryRequest('default:1');
    expect(request).toBeNull();
    return { request };
  });

  parityTest('readGitHoldReportInputs finds no hold summary and reads the source mirror flag as text', { methods: ['readGitHoldReportInputs'] }, async (engine, backend) => {
    const before = await engine.readGitHoldReportInputs('default', 'default:1');
    expect(before).toEqual({ summary: null, mirror: null });
    const absent = await engine.readGitHoldReportInputs('no-such-source', 'no-such-source:1');
    expect(absent).toEqual({ summary: null, mirror: null });
    await createSource(engine, backend, 'mirror-flag', { mirror_read_only: true });
    const mirrored = await engine.readGitHoldReportInputs('mirror-flag', 'mirror-flag:1');
    expect(mirrored).toEqual({ summary: null, mirror: 'true' });
    return { before, absent, mirrored };
  });

  parityTest('readWriteWatermarkRow reads the sync point and the outstanding requests of the source incarnation', {
    methods: ['readWriteWatermarkRow', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const read = async (id: string) => {
      const row = await engine.readWriteWatermarkRow(id);
      return { ...row, pending_min: row.pending_min == null ? null : Number(row.pending_min), pending_count: Number(row.pending_count),
        pending_since: row.pending_since != null, newest_sequence: row.newest_sequence == null ? null : Number(row.newest_sequence) };
    };
    const empty = { last_commit: null, last_sync_at: null, pending_min: null, pending_count: 0, pending_since: false, newest_sequence: null };
    const before = await read('default');
    const absent = await read('no-such-source');
    expect(before).toEqual(empty);
    expect(absent).toEqual(empty);
    await admitDirect(engine);
    const queued = await read('default');
    const absentAfter = await read('no-such-source');
    expect(queued).toMatchObject({ pending_count: 1, pending_since: true, newest_sequence: null });
    expect(queued.pending_min).not.toBeNull();
    expect(absentAfter).toEqual({ ...empty, newest_sequence: queued.pending_min });
    return { before, absent, queued, absentAfter };
  });

  parityTest('readSourceCheckoutRoot reads the source incarnation and its own path when this host binds no checkout', {
    methods: ['readSourceCheckoutRoot', 'readSourceMembership'],
  }, async (engine, backend) => {
    const membership = await engine.readSourceMembership('default');
    const own = await engine.readSourceCheckoutRoot('default', null);
    expect(own).toEqual({ incarnation: membership!.incarnation, root: null });
    await createSource(engine, backend, 'rooted', {}, '/var/tmp/parity-rooted');
    const rooted = await engine.readSourceCheckoutRoot('rooted', '00000000-0000-4000-8000-000000000001');
    expect(rooted?.root).toBe('/var/tmp/parity-rooted');
    const absent = await engine.readSourceCheckoutRoot('no-such-source', null);
    expect(absent).toBeNull();
    return { own: own && { root: own.root }, rooted: rooted && { root: rooted.root }, absent };
  });

  parityTest('readUnembeddedPageSummary counts the live pages of one source with a chunk that has no vector, skipping embed_skip', {
    methods: ['readUnembeddedPageSummary', 'putPage', 'sealChunks'],
  }, async (engine, backend) => {
    const read = async (id: string) => {
      const row = await engine.readUnembeddedPageSummary(id, 'embedding');
      return { pages: Number(row.pages), oldest: row.oldest instanceof Date, held: Number(row.held) };
    };
    const before = await read('default');
    expect(before).toEqual({ pages: 0, oldest: false, held: 0 });
    const note = (slug: string, frontmatter: Record<string, unknown> = {}, sourceId?: string) =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter }, sourceId ? { sourceId } : undefined);
    await createSource(engine, backend, 'elsewhere');
    await note('notes/waiting');
    await engine.sealChunks('notes/waiting', [{ chunk_index: 0, chunk_text: 'waiting', chunk_source: 'compiled_truth' }]);
    await note('notes/skipped', { embed_skip: { reason: 'manual' } });
    await engine.sealChunks('notes/skipped', [{ chunk_index: 0, chunk_text: 'skipped', chunk_source: 'compiled_truth' }]);
    await note('notes/other', {}, 'elsewhere');
    await engine.sealChunks('notes/other', [{ chunk_index: 0, chunk_text: 'other', chunk_source: 'compiled_truth' }], { sourceId: 'elsewhere' });
    const after = await read('default');
    expect(after).toEqual({ pages: 1, oldest: true, held: 0 });
    const absent = await read('no-such-source');
    expect(absent).toEqual({ pages: 0, oldest: false, held: 0 });
    return { before, after, absent };
  });

  parityTest('the held fence read is empty on a brain with no held fence result', { methods: ['listFenceHoldRows'] }, async (engine) => {
    const kinds = ['fact_fence', 'take_fence'];
    const everyOwner = await engine.listFenceHoldRows(['default'], kinds);
    const oneOwner = await engine.listFenceHoldRows(['default', 'other'], kinds, 'page:people/alice-example');
    const noSources = await engine.listFenceHoldRows([], kinds);
    const answers = { everyOwner, oneOwner, noSources };
    expect(answers).toEqual({ everyOwner: [], oneOwner: [], noSources: [] });
    return answers;
  });

  parityTest('readSourcePurgeEpoch reads a fresh source as 0 and an unknown source as null; readReasonPurgeTombstones finds none', {
    methods: ['readSourcePurgeEpoch', 'readReasonPurgeTombstones'],
  }, async (engine) => {
    const seen = {
      epoch: String(await engine.readSourcePurgeEpoch('default')),
      absent: await engine.readSourcePurgeEpoch('no-such-source'),
      tombstones: await engine.readReasonPurgeTombstones('default'),
      absentTombstones: await engine.readReasonPurgeTombstones('no-such-source'),
    };
    expect(seen).toEqual({ epoch: '0', absent: null, tombstones: [], absentTombstones: [] });
    return seen;
  });

  // Leak case: one source's tombstones never answer for another, and a bumped epoch is read as stored. The epoch moves
  // through the purge's typed bump (three purges) and the tombstones through the typed write a purge makes.
  parityTest('readReasonPurgeTombstones reads only the named source; readSourcePurgeEpoch reads a bumped epoch', {
    methods: ['bumpSourcePurgeEpoch', 'insertReasonPurgeTombstones', 'readSourcePurgeEpoch', 'readReasonPurgeTombstones'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'purged');
    for (let i = 0; i < 3; i++) await engine.bumpSourcePurgeEpoch('purged');
    await engine.insertReasonPurgeTombstones('purged', ['c1', 'c2'], ['notes/a.md', 'notes/b.md']);
    await engine.insertReasonPurgeTombstones('default', ['c3'], ['notes/c.md']);
    const order = (rows: Array<{ commit_sha: string; path: string }>) => rows.map(r => ({ commit_sha: r.commit_sha, path: r.path })).sort((a, b) => a.commit_sha.localeCompare(b.commit_sha));
    const seen = {
      epoch: String(await engine.readSourcePurgeEpoch('purged')),
      defaultEpoch: String(await engine.readSourcePurgeEpoch('default')),
      purged: order(await engine.readReasonPurgeTombstones('purged')),
      other: order(await engine.readReasonPurgeTombstones('default')),
    };
    expect(seen).toEqual({ epoch: '3', defaultEpoch: '0', purged: [{ commit_sha: 'c1', path: 'notes/a.md' }, { commit_sha: 'c2', path: 'notes/b.md' }], other: [{ commit_sha: 'c3', path: 'notes/c.md' }] });
    return seen;
  });

  parityTest('a fence publish reads its page and the held list reads its pages\' files', {
    methods: ['putPage', 'softDeletePage', 'readFenceOriginGone', 'readFenceHoldFiles'],
  }, async (engine) => {
    await engine.putPage('notes/filed', { type: 'note', title: 'Filed', compiled_truth: 'filed body', source_path: 'notes/filed.md' });
    await engine.putPage('notes/blank-path', { type: 'note', title: 'Blank', compiled_truth: 'blank body', source_path: '  ' });
    await engine.putPage('notes/db-only', { type: 'note', title: 'Db only', compiled_truth: 'db body' });
    await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'gone body', source_path: 'notes/gone.md' });
    await engine.softDeletePage('notes/gone');
    const origin = {
      live: await engine.readFenceOriginGone('default', 'notes/filed'),
      deleted: await engine.readFenceOriginGone('default', 'notes/gone'),
      missing: await engine.readFenceOriginGone('default', 'notes/never'),
      otherSource: await engine.readFenceOriginGone('other', 'notes/filed'),
    };
    const files = (await engine.readFenceHoldFiles(['default', 'other'], ['notes/filed', 'notes/blank-path', 'notes/db-only', 'notes/gone', 'notes/never']))
      .map(row => ({ ...row })).sort((a, b) => `${a.source_id}/${a.slug}`.localeCompare(`${b.source_id}/${b.slug}`));
    const answers = { origin, files, none: await engine.readFenceHoldFiles([], []) };
    expect(answers).toEqual({
      origin: { live: false, deleted: true, missing: true, otherSource: true },
      files: [
        { source_id: 'default', slug: 'notes/blank-path', database_only: true },
        { source_id: 'default', slug: 'notes/db-only', database_only: true },
        { source_id: 'default', slug: 'notes/filed', database_only: false },
      ],
      none: [],
    });
    return answers;
  });

  parityTest('gbrain get and doctor list no held fence result on a brain with none', {
    methods: ['putPage', 'listFenceHoldRows'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'alice body' });
    // `gbrain get` lists one page's holds; doctor's generation_held check lists every source's.
    const answers = { get: await fenceHoldEntries(engine, ['default'], { slug: 'people/alice-example' }), doctor: await fenceHoldEntries(engine, ['default', 'other']) };
    expect(answers).toEqual({ get: [], doctor: [] });
    return answers;
  });

  parityTest('a readable fence clears its page\'s hold under the generation key lock', {
    methods: ['transaction', 'lockGenerationKey', 'clearFenceHoldRows', 'listFenceHoldRows'],
  }, async (engine) => {
    const key = { sourceId: 'default', kind: 'fact_fence', ownerKey: 'page:people/alice-example' };
    const held = await engine.transaction(async tx => {
      await tx.lockGenerationKey('fact_fence:default:page:people/alice-example');
      await tx.clearFenceHoldRows(key);
      return tx.listFenceHoldRows(['default'], ['fact_fence', 'take_fence'], key.ownerKey);
    });
    expect(held).toEqual([]);
    return held;
  });

  parityTest('the generation ledger activates generation 1 then 2 and keeps one held row per key', {
    methods: ['transaction', 'putPage', 'readLiveGenerationRow', 'activateGenerationRows', 'recordHeldGenerationRow', 'listFenceHoldRows'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'alice body' });
    const key = { sourceId: 'default', kind: 'fact_fence', ownerKey: 'page:people/alice-example' };
    const row = (generation: number, operationId: string) => ({ generation, runId: null, operationId, inputPin: 'pin', inputSize: 4,
      completeness: '{"complete":true}', setHash: 'h', restoreOf: null, activationId: null, locator: null });
    const item = (itemKey: string, action: string) => ({ item_key: itemKey, identity_hash: itemKey, action, preimage: null, preimage_bytes: null, pending: false });
    const held = (holdId: string) => ({ holdId, runId: null, inputPin: null, inputSize: null, setHash: 'h', reason: 'no_proof', context: '{"slug":"people/alice-example"}',
      proposal: '[]', proposalBytes: 2 });
    const none = await engine.readLiveGenerationRow(key);
    const first = await engine.transaction(tx => tx.activateGenerationRows(key, null, row(1, 'op-1'), [item('row:a', 'published')]));
    const one = await engine.readLiveGenerationRow(key);
    await engine.transaction(tx => tx.activateGenerationRows(key, one!.id, row(2, 'op-2'), [item('row:a', 'kept'), item('row:b', 'published'), item('row:c', 'retired')]));
    const two = await engine.readLiveGenerationRow(key);
    await engine.transaction(tx => tx.recordHeldGenerationRow(key, held('hold-1')));
    await engine.transaction(tx => tx.recordHeldGenerationRow(key, held('hold-1')));
    const sameHold = (await engine.listFenceHoldRows(['default'], ['fact_fence'], key.ownerKey)).map(r => r.held_reason);
    await engine.transaction(tx => tx.recordHeldGenerationRow(key, held('hold-2')));
    const otherHold = (await engine.listFenceHoldRows(['default'], ['fact_fence'], key.ownerKey)).length;
    const answers = { none, firstIsNumber: typeof first === 'number', one: { generation: one?.generation, items: one?.items },
      two: { generation: two?.generation, input_pin: two?.input_pin, input_size: two?.input_size, locator: two?.locator,
        items: [...(two?.items ?? [])].sort((a, b) => a.item_key.localeCompare(b.item_key)) }, sameHold, otherHold };
    expect(answers).toEqual({ none: null, firstIsNumber: true, one: { generation: 1, items: [{ item_key: 'row:a', identity_hash: 'row:a' }] },
      two: { generation: 2, input_pin: 'pin', input_size: 4, locator: null, items: [{ item_key: 'row:a', identity_hash: 'row:a' }, { item_key: 'row:b', identity_hash: 'row:b' }] },
      sameHold: ['no_proof'], otherHold: 1 });
    return answers;
  });

  parityTest('a publication counts its failures, reads its replay and adds to its valve window', {
    methods: ['transaction', 'activateGenerationRows', 'recordHeldGenerationRow', 'heldGenerationRowsForInput', 'readHeldGenerationContext',
      'liveGenerationForOperation', 'countGenerationAttempt', 'clearGenerationAttempts', 'readGenerationValve', 'bumpGenerationValve'],
  }, async (engine) => {
    const key = { sourceId: 'default', kind: 'publish_parity', ownerKey: 'input:parity' };
    const row = (generation: number, operationId: string) => ({ generation, runId: 'r1', operationId, inputPin: 'pin', inputSize: 4,
      completeness: '{"complete":true}', setHash: 'h', restoreOf: null, activationId: null, locator: null });
    const item = (itemKey: string, action: string) => ({ item_key: itemKey, identity_hash: itemKey, action, preimage: null, preimage_bytes: null, pending: false });
    const counts = [];
    for (const code of ['a', 'b']) counts.push(await engine.transaction(tx => tx.countGenerationAttempt(key, 'hold-1', code)));
    await engine.transaction(tx => tx.clearGenerationAttempts('hold-1'));
    counts.push(await engine.transaction(tx => tx.countGenerationAttempt(key, 'hold-1', 'c')));
    const emptyValve = await engine.readGenerationValve(key, 'run:r1');
    const noReplay = await engine.liveGenerationForOperation('op-1');
    const first = await engine.transaction(tx => tx.activateGenerationRows(key, null, row(1, 'op-1'), [item('a', 'published'), item('b', 'published'), item('c', 'retired')]));
    const replay = await engine.liveGenerationForOperation('op-1');
    await engine.transaction(tx => tx.activateGenerationRows(key, first, row(2, 'op-2'), [item('a', 'kept')]));
    const afterSupersede = [await engine.liveGenerationForOperation('op-1'), await engine.liveGenerationForOperation('op-2')];
    // The activation deleted the key's attempt counter: the next count starts at one.
    const afterActivation = await engine.transaction(tx => tx.countGenerationAttempt(key, 'hold-1', 'd'));
    await engine.transaction(tx => tx.bumpGenerationValve(key, 'run:r1', 2));
    await engine.transaction(tx => tx.bumpGenerationValve(key, 'run:r1', 3));
    const valve = await engine.readGenerationValve(key, 'run:r1');
    await engine.transaction(tx => tx.recordHeldGenerationRow(key, { holdId: 'hold-x', runId: null, inputPin: 'pin', inputSize: 4, setHash: 'h', reason: 'valve',
      context: '{"window_retired":5}', proposal: '[]', proposalBytes: 2 }));
    const held = await engine.heldGenerationRowsForInput(key, 'pin');
    const otherPin = await engine.heldGenerationRowsForInput(key, 'pin-2');
    const context = await engine.readHeldGenerationContext(key, 'hold-x');
    const otherHold = await engine.readHeldGenerationContext(key, 'hold-y');
    await engine.transaction(tx => tx.clearGenerationAttempts('hold-1'));
    const answers = { counts, emptyValve, noReplay, replay, afterSupersede, afterActivation, valve, held, otherPin, context, otherHold };
    expect(answers).toEqual({ counts: [{ attempts: 1, codes: ['a'] }, { attempts: 2, codes: ['a', 'b'] }, { attempts: 1, codes: ['c'] }],
      emptyValve: { retired: null, owned: 0 }, noReplay: null, replay: 1, afterSupersede: [null, 2], afterActivation: { attempts: 1, codes: ['d'] },
      valve: { retired: 5, owned: 1 }, held: [{ hold_id: 'hold-x', item_set_hash: 'h', held_reason: 'valve' }], otherPin: [],
      context: { held_context: { window_retired: 5 } }, otherHold: null });
    return answers;
  });

  parityTest('a purge scrubs the generation ledger by page and by text', {
    methods: ['transaction', 'activateGenerationRows', 'recordHeldGenerationRow', 'readHeldGenerationContext', 'scrubGenerationPageRows', 'scrubGenerationTextRows'],
  }, async (engine) => {
    const live = { sourceId: 'default', kind: 'scrub_parity', ownerKey: 'page:notes/x' };
    const asking = { sourceId: 'default', kind: 'scrub_parity', ownerKey: 'input:x' };
    const fence = { sourceId: 'default', kind: 'fact_fence', ownerKey: 'page:notes/x' };
    const held = (holdId: string, context: string, proposal: string) => ({ holdId, runId: null, inputPin: holdId, inputSize: 1, setHash: 'h', reason: 'no_proof',
      context, proposal, proposalBytes: 2 });
    await engine.transaction(tx => tx.recordHeldGenerationRow(fence, held('hold-f', '{}', '[]')));
    await engine.transaction(tx => tx.recordHeldGenerationRow(asking, held('hold-a', '{"note":"Secret Words"}', '[{"key":"notes/x"}]')));
    await engine.transaction(tx => tx.activateGenerationRows(live, null, { generation: 1, runId: null, operationId: 'scrub-parity', inputPin: 'p', inputSize: 1,
      completeness: '{"fence":{"text":"secret words"}}', setHash: 'h', restoreOf: null, activationId: null, locator: null },
      [{ item_key: 'notes/x', identity_hash: 'x', action: 'published', preimage: { body: 'SECRET words' }, preimage_bytes: 9, pending: false }]));
    const byText = await engine.transaction(tx => tx.scrubGenerationTextRows('default', ['secret words']));
    const context = await engine.readHeldGenerationContext(asking, 'hold-a');
    const textAgain = await engine.transaction(tx => tx.scrubGenerationTextRows('default', ['secret words']));
    const byPage = await engine.transaction(tx => tx.scrubGenerationPageRows('default', ['fact_fence', 'take_fence'], 'notes/x'));
    const pageAgain = await engine.transaction(tx => tx.scrubGenerationPageRows('default', ['fact_fence', 'take_fence'], 'notes/x'));
    const answers = { byText, context, textAgain, byPage, pageAgain };
    expect(answers).toEqual({ byText: { derived_generation_items: 1, derived_generations: 2 }, context: { held_context: null },
      textAgain: { derived_generation_items: 0, derived_generations: 0 }, byPage: { derived_generation_items: 0, derived_generations: 1 },
      pageAgain: { derived_generation_items: 0, derived_generations: 0 } });
    return answers;
  });

  parityTest('a managed activation records, flips, gates, settles and lists its members', {
    methods: ['transaction', 'putPage', 'activateGenerationRows', 'recordGenerationActivation', 'markGenerationActivated', 'readGenerationActivationState',
      'settleGenerationMember', 'listPendingGenerationMembers', 'listGenerationOrphanCandidates'],
  }, async (engine) => {
    const key = { sourceId: 'default', kind: 'managed_parity', ownerKey: 'input:x' };
    const first = '00000000-0000-8000-a000-00000000ac01';
    const second = '00000000-0000-8000-a000-00000000ac02';
    await engine.putPage('notes/made', { type: 'note', title: 'Made', compiled_truth: 'made body' });
    const record = (activationId: string, slug: string, action: string) => engine.transaction(tx => tx.recordGenerationActivation(key,
      { activationId, expectedGeneration: 0, inputPin: 'p', setHash: 'h', members: [{ slug, action, identity: `id-${slug}`, before: null }] }));
    await record(first, 'notes/x', 'overwrite');
    await record(first, 'notes/made', 'create');
    const pendingState = await engine.readGenerationActivationState(first, 'notes/x', 'default');
    const id = await engine.transaction(async tx => {
      const made = await tx.activateGenerationRows(key, null, { generation: 1, runId: null, operationId: 'managed-parity', inputPin: 'p', inputSize: 1,
        completeness: '{"managed":true}', setHash: 'h', restoreOf: null, activationId: first, locator: null },
        [{ item_key: 'notes/x', identity_hash: 'id-notes/x', action: 'published', preimage: null, preimage_bytes: null, pending: true }]);
      await tx.markGenerationActivated(first, made);
      return made;
    });
    const liveState = await engine.readGenerationActivationState(first, 'notes/x', 'default');
    const pending = (await engine.listPendingGenerationMembers(['default'], 'managed_parity')).map(row => ({ ...row, generation_id: Number(row.generation_id) === id ? 'G' : row.generation_id }));
    await engine.transaction(tx => tx.settleGenerationMember(first, 'notes/x'));
    const settled = await engine.readGenerationActivationState(first, 'notes/x', 'default');
    await record(second, 'notes/made', 'create');
    const orphans = (await engine.listGenerationOrphanCandidates(['default'], null)).filter(row => row.kind === 'managed_parity').map(({ created_at: _c, ...row }) => row);
    const answers = { pendingState, liveState, pending, settled, orphans };
    expect(answers).toEqual({ pendingState: { state: 'pending', generation_state: null, pending: null }, liveState: { state: 'activated', generation_state: 'live', pending: true },
      pending: [{ source_id: 'default', kind: 'managed_parity', owner_key: 'input:x', generation_id: 'G', activation_id: first, slug: 'notes/x', item_action: 'published', identity: 'id-notes/x' }],
      settled: { state: 'activated', generation_state: 'live', pending: false },
      orphans: [{ source_id: 'default', kind: 'managed_parity', owner_key: 'input:x', activation_id: second, slug: 'notes/made' }] });
    return answers;
  });

  parityTest('the repair generations reads select by run, time, key and id, and read the held proposal', {
    methods: ['transaction', 'activateGenerationRows', 'recordHeldGenerationRow', 'readGenerationItemsByIds', 'listUnmatchedGenerationRows',
      'listRestorableGenerationRows', 'listHeldGenerationRows', 'readHeldGenerationProposal', 'listGenerationSourceIncarnations'],
  }, async (engine) => {
    const key = (ownerKey: string) => ({ sourceId: 'default', kind: 'repair_parity', ownerKey });
    const row = (generation: number, runId: string, completeness: string) => ({ generation, runId, operationId: `repair-parity-${runId}-${generation}`, inputPin: 'p',
      inputSize: 1, completeness, setHash: 'h', restoreOf: null, activationId: null, locator: null });
    const item = (action: string) => [{ item_key: 'notes/x', identity_hash: 'id-x', action, preimage: action === 'kept' ? { x: 1 } : null, preimage_bytes: null, pending: false }];
    const ids = await engine.transaction(async tx => {
      const prev = await tx.activateGenerationRows(key('a'), null, row(1, 'ra', '{}'), item('published'));
      const live = await tx.activateGenerationRows(key('a'), prev, row(2, 'ra', '{"unmatched":[{"slug":"notes/old","why":"no_subject","missing":null}]}'), item('kept'));
      await tx.activateGenerationRows(key('b'), null, row(1, 'rb', '{}'), []);
      await tx.recordHeldGenerationRow(key('c'), { holdId: 'hold-c', runId: 'ra', inputPin: null, inputSize: null, setHash: 'h', reason: 'shrunk', context: '{}',
        proposal: '[{"slug":"notes/p"}]', proposalBytes: 20 });
      return { prev, live };
    });
    const held = await engine.listHeldGenerationRows(['default'], 'repair_parity', { runId: 'ra' });
    const heldId = Number(held[0]?.id);
    const name = (id: unknown) => Number(id) === ids.live ? 'live' : Number(id) === ids.prev ? 'prev' : Number(id) === heldId ? 'held' : 'other';
    const answers = {
      items: (await engine.readGenerationItemsByIds([ids.live, ids.prev])).map(r => ({ ...r, generation_id: name(r.generation_id) })).sort((x, y) => x.generation_id.localeCompare(y.generation_id)),
      unmatched: (await engine.listUnmatchedGenerationRows(['default'], 'repair_parity', { runId: 'ra', ownerKey: 'a' })).map(r => ({ ...r, id: name(r.id) })),
      restorable: (await engine.listRestorableGenerationRows(['default'], 'repair_parity', { id: ids.live })).map(r => ({ ...r, id: name(r.id), prev_id: name(r.prev_id),
        generation: Number(r.generation), prev_generation: Number(r.prev_generation) })),
      noneSince: await engine.listRestorableGenerationRows(['default'], 'repair_parity', { since: '2999-01-01T00:00:00Z' }),
      held: held.map(r => ({ id: name(r.id), owner_key: r.owner_key, held_reason: r.held_reason, items: Number(r.items) })),
      proposal: await engine.readHeldGenerationProposal(heldId),
      proposalOfLive: await engine.readHeldGenerationProposal(ids.live),
      sources: (await engine.listGenerationSourceIncarnations(['default', 'elsewhere'])).map(r => r.id),
    };
    expect(answers).toEqual({
      items: [{ generation_id: 'live', item_key: 'notes/x', identity_hash: 'id-x', action: 'kept', preimage: { x: 1 } },
        { generation_id: 'prev', item_key: 'notes/x', identity_hash: 'id-x', action: 'published', preimage: null }],
      unmatched: [{ id: 'live', source_id: 'default', owner_key: 'a', activation_id: null, unmatched: [{ slug: 'notes/old', why: 'no_subject', missing: null }] }],
      restorable: [{ id: 'live', source_id: 'default', owner_key: 'a', generation: 2, prev_id: 'prev', prev_generation: 1 }],
      noneSince: [],
      held: [{ id: 'held', owner_key: 'c', held_reason: 'shrunk', items: 1 }],
      proposal: { proposal: [{ slug: 'notes/p' }], hold_id: 'hold-c' },
      proposalOfLive: null,
      sources: ['default'],
    });
    return answers;
  });

  parityTest('the facts fence evidence and restore reads: recorded keys, fence versions, the kept row move and the fence blocks', {
    methods: ['transaction', 'putPage', 'createVersion', 'insertFacts', 'listFactsForPage', 'activateGenerationRows', 'listRecordedFenceItemKeys',
      'hasBodylessPageVersion', 'listFenceVersionBodies', 'moveKeptFactRows', 'readGenerationFenceBlocks', 'listOwnedGenerationItems', 'readLiveGenerationId'],
  }, async (engine) => {
    const slug = 'notes/fence-parity';
    const key = { sourceId: 'default', kind: 'fact_fence', ownerKey: `page:${slug}` };
    const row = (generation: number, completeness: string) => ({ generation, runId: null, operationId: `fence-parity-${generation}`, inputPin: 'p', inputSize: 1,
      completeness, setHash: 'h', restoreOf: null, activationId: null, locator: null });
    const item = (item_key: string, action: string) => ({ item_key, identity_hash: `id-${item_key}`, action, preimage: null, preimage_bytes: null, pending: false });
    await engine.putPage(slug, { type: 'note', title: 'Fence parity', compiled_truth: 'one <!--- gbrain:facts:begin --> x' });
    await engine.createVersion(slug, { sourceId: 'default' });
    await engine.putPage(slug, { type: 'note', title: 'Fence parity', compiled_truth: 'two, no marker' });
    await engine.createVersion(slug, { sourceId: 'default' });
    const ids = await engine.transaction(async tx => {
      const prev = await tx.activateGenerationRows(key, null, row(1, '{"fence":{"body":"B1","timeline":null}}'), [item('row:1', 'published'), item('row:2', 'published')]);
      const live = await tx.activateGenerationRows(key, prev, row(2, '{}'), [item('row:1', 'kept'), item('row:2', 'retired')]);
      return { prev, live };
    });
    const name = (id: unknown) => Number(id) === ids.live ? 'live' : Number(id) === ids.prev ? 'prev' : 'other';
    const facts = await engine.insertFacts([1, 2].map(n => ({ fact: `fact ${n}`, kind: 'fact' as const, entity_slug: slug, source: 'test', row_num: n,
      source_markdown_slug: slug })), { source_id: 'default' });
    await engine.transaction(tx => tx.moveKeptFactRows('default', slug, facts.ids, [1]));
    const answers = {
      recorded: (await engine.listRecordedFenceItemKeys(key, ['row:1', 'row:2', 'row:3'])).map(r => r.item_key).sort(),
      bodyless: await engine.hasBodylessPageVersion('default', slug),
      versions: (await engine.listFenceVersionBodies('default', slug, null, 10)).map(r => r.compiled_truth),
      rows: (await engine.listFactsForPage('default', slug)).map(r => ({ fact: r.fact, row_num: Number(r.row_num) })).sort((x, y) => x.row_num - y.row_num),
      blocks: (await engine.readGenerationFenceBlocks([ids.live, ids.prev])).map(r => ({ id: name(r.id), fence: r.fence })).sort((x, y) => x.id.localeCompare(y.id)),
      owned: (await engine.listOwnedGenerationItems([ids.live, ids.prev])).map(r => `${name(r.generation_id)}:${r.item_key}`).sort(),
      live: name((await engine.readLiveGenerationId(key))?.id),
    };
    expect(answers).toEqual({
      recorded: ['row:1', 'row:2'],
      bodyless: false,
      versions: ['one <!--- gbrain:facts:begin --> x'],
      rows: [{ fact: 'fact 2', row_num: 2 }, { fact: 'fact 1', row_num: 3 }],
      blocks: [{ id: 'live', fence: null }, { id: 'prev', fence: { body: 'B1', timeline: null } }],
      owned: ['live:row:1', 'prev:row:1', 'prev:row:2'],
      live: 'live',
    });
    return answers;
  });

  parityTest('forgetting a fact reprojects its page\'s facts fence: the generation key lock, then the generation read', {
    methods: ['transaction', 'putPage', 'listFenceRetireCandidates', 'lockGenerationKey'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'alice body' });
    // The forget's page publication reprojects the fence (persistence/canonical-projections.ts) with the rows it still holds.
    const rows = [{ row_num: 1, fact: 'Alice keeps bees', visibility: 'world' }];
    const outcome = await engine.transaction(tx => projectFactFenceGeneration(tx, { sourceId: 'default', slug: 'people/alice-example',
      read: fenceReadOf({ body: '## Facts block', timeline: null }), incoming: JSON.stringify(rows), rows, writer: 'projection' }));
    expect(outcome).toMatchObject({ state: 'published', generation: 1, retiring: 0 });
    return outcome;
  });

  parityTest('one request is admitted, read, claimed, locked and completed, and its counters are charged then released', {
    methods: ['readLedgerSource', 'transaction', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequest', 'readWriteRequestById', 'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow'],
  }, async (engine) => {
    const result = await lifecycle(engine);
    expect(result.locked).toEqual({ brain: { outstanding: 0, intentBytes: 0, lifetimeIds: 0, terminalBytes: 0 }, [KEYS[0]!]: { outstanding: 0, intentBytes: 0, lifetimeIds: 0, terminalBytes: 0 } });
    expect(result.charged.brain).toEqual({ outstanding: 1, intentBytes: 100, lifetimeIds: 1, terminalBytes: 4096 });
    expect(result.inserted?.state).toBe('queued');
    expect(result.byRequest).toEqual(result.inserted);
    expect(result.sameRow).toBe(true);
    expect(result.unknown).toBeNull();
    expect(result.claim).toMatchObject({ state: 'running', passedSync: false, seenSequence: null, token: TOKEN });
    expect(result.lockedRow?.state).toBe('running');
    expect(result.completed).toMatchObject({ state: 'committed', outcome: { status: 'parity' }, completed: true, purgeFacts: false, purgePages: false });
    expect(result.released.brain).toMatchObject({ outstanding: 0, intentBytes: 0, lifetimeIds: 1 });
    return result;
  });

  parityTest('readSourcePurgeEpoch reads a fresh source as 0 and an unknown source as null; readReasonPurgeTombstones finds none', {
    methods: ['readSourcePurgeEpoch', 'readReasonPurgeTombstones'],
  }, async (engine) => {
    const seen = {
      epoch: String(await engine.readSourcePurgeEpoch('default')),
      absent: await engine.readSourcePurgeEpoch('no-such-source'),
      tombstones: await engine.readReasonPurgeTombstones('default'),
      absentTombstones: await engine.readReasonPurgeTombstones('no-such-source'),
    };
    expect(seen).toEqual({ epoch: '0', absent: null, tombstones: [], absentTombstones: [] });
    return seen;
  });

  // Leak case: one source's tombstones never answer for another, and a bumped epoch is read as stored. The Rust store
  // purges nothing (0 and none above), so the tombstone write stops on the raw_sql refusal.
  parityTest('each journal member works on its own, outside a transaction', {
    methods: ['readLedgerSource', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequest', 'readWriteRequestById', 'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow'],
  }, async (engine) => {
    const source = await engine.readLedgerSource('default');
    const locked = counters(await engine.lockPersistenceCounters(KEYS));
    const inserted = await engine.insertWriteRequest(insertRow(source!.incarnation));
    const charged = counters(await engine.lockPersistenceCounters(KEYS));
    const byRequest = view(await engine.readWriteRequest(PRINCIPAL.kind, PRINCIPAL.id, REQUEST));
    const byId = view(await engine.readWriteRequestById(inserted.id));
    const claimed = await engine.stampWriteClaim(inserted.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const lockedRow = view(await engine.lockWriteRequest(inserted.id));
    const missing = await engine.lockWriteRequest('a0000000-0000-4000-8000-0000000000a9');
    const done = await engine.completeWriteRow({
      id: inserted.id, state: 'failed', outcome: null, errorCode: 'parity_error', errorMessage: 'parity', consumerVersion: 'parity',
      consumerHostId: null, errorDetail: { reason: 'parity' }, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
      terminalReservation: 4096, probePurges: false,
    });
    const released = counters(await engine.lockPersistenceCounters(KEYS));
    const result = { locked, inserted: view(inserted), charged, byRequest, byId, claim: claimed && { ...view(claimed), passedSync: claimed.passed_sync, token: claimed.execution_token },
      lockedRow, missing, done: done && { ...view(done), detail: done.error_detail }, released };
    expect(result.byRequest).toEqual(result.inserted);
    expect(result.byId).toEqual(result.inserted);
    expect(result.claim).toMatchObject({ state: 'running', passedSync: false, token: TOKEN });
    expect(result.lockedRow?.state).toBe('running');
    expect(result.missing).toBeNull();
    expect(result.done).toMatchObject({ state: 'failed', errorCode: 'parity_error', completed: true, detail: { reason: 'parity' } });
    expect(result.released.brain).toMatchObject({ outstanding: 0, intentBytes: 0, lifetimeIds: 1 });
    return result;
  });

  parityTest('readWriteRequestProgress returns the progress columns of a queued, running and finished request, and null for an unknown id', {
    methods: ['readWriteRequestProgress', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const id = await admitDirect(engine);
    const progress = async () => {
      const row = await engine.readWriteRequestProgress(id);
      return row && { keys: Object.keys(row).sort(), state: row.state, errorCode: row.error_code ?? null, errorMessage: row.error_message ?? null,
        outcome: row.outcome ?? null, blocked: row.blocked_reason ?? null, deferredRefresh: row.deferred_refresh_id ?? null,
        deferredImport: row.deferred_import_from ?? null, completed: row.completed_at != null, updated: row.updated_at != null };
    };
    const queued = await progress();
    await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const running = await progress();
    await engine.completeWriteRow({
      id, state: 'failed', outcome: null, errorCode: 'parity_error', errorMessage: 'parity', consumerVersion: 'parity',
      consumerHostId: null, errorDetail: { reason: 'parity' }, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
      terminalReservation: 4096, probePurges: false,
    });
    const finished = await progress();
    const missing = await engine.readWriteRequestProgress('a0000000-0000-4000-8000-0000000000a9');
    expect(queued).toMatchObject({ state: 'queued', completed: false, errorCode: null });
    expect(queued?.keys).toEqual(['blocked_reason', 'completed_at', 'deferred_import_from', 'deferred_refresh_id', 'error_code', 'error_message', 'outcome', 'state', 'updated_at']);
    expect(running).toMatchObject({ state: 'running', completed: false });
    expect(finished).toMatchObject({ state: 'failed', errorCode: 'parity_error', errorMessage: 'parity', completed: true });
    expect(missing).toBeNull();
    return { queued, running, finished, missing };
  });

  parityTest('the consumer row members find no consumers of a host without one, a renewed row is gone after its delete, and the worktree stamp changes nothing', {
    methods: ['listHostConsumerRows', 'probeLiveConsumerRows', 'renewConsumerRow', 'deleteConsumerRow', 'stampWorktreeHeartbeats'],
  }, async (engine) => {
    // The Rust store keeps no consumer rows (one process owns its brain), so the case compares no list taken between renew and delete.
    const host = 'e0000000-0000-4000-8000-0000000000e7';
    const key = { hostId: host, pid: 1, nonce: 'parity-nonce' };
    const before = await engine.listHostConsumerRows(host);
    const probe = await engine.probeLiveConsumerRows({ ...key, kinds: RESIDENT_CONSUMER_KINDS, liveMs: CONSUMER_LIVE_MS });
    const renewed = await engine.renewConsumerRow({ ...key, pidNs: null, kind: 'serve', mode: 'full', restartRequired: false, rootBarrierAgeMs: null,
      pool: null, hostJsonPath: '/parity/host.json', persistenceHome: '/parity', mintedUnder: null, version: 'parity', purgeMs: 60_000, bootId: null, processStart: null });
    await engine.deleteConsumerRow(key);
    const missingDelete = await engine.deleteConsumerRow(key);
    await engine.stampWorktreeHeartbeats(host);
    const after = await engine.listHostConsumerRows(host, { direct: true });
    expect(before).toEqual([]);
    expect(probe).toEqual([]);
    expect(after).toEqual([]);
    return { before, probe, renewed, missingDelete, after };
  });

  // PGLite admits one process, so its callers answer without an engine call; the Postgres and Rust arms reach every
  // consumer row member. The row read after the stop goes to the engine on every arm.
  parityTest('a consumer heartbeat renews and stops without a failure, and leaves the host with no live owner',
    { methods: ['listHostConsumerRows'] }, async (engine) => {
    const host = 'e0000000-0000-4000-8000-0000000000e8';
    const listed = await listHostConsumers(engine, host);
    const owner = await probeLiveFullConsumer(engine, host);
    const heartbeat = startConsumerHeartbeat(engine, host, { kind: 'serve', mode: 'full', everyMs: 3_600_000,
      report: () => ({ restart_required: false, root_barrier_age_ms: null }), paths: { host_json_path: '/parity/host.json', persistence_home: '/parity', minted_under: null } });
    await heartbeat.renew();
    const failures = heartbeat.failures;
    await heartbeat.stop();
    const afterStop = await listHostConsumers(engine, host);
    const rowsAfterStop = await engine.listHostConsumerRows(host);
    expect(listed).toEqual([]);
    expect(owner).toBeNull();
    expect(failures).toBe(0);
    expect(afterStop).toEqual([]);
    expect(rowsAfterStop).toEqual([]);
    return { listed, owner, failures, afterStop, rowsAfterStop };
  });

  parityTest('countOutstandingBySource counts one principal\'s unfinished requests per source, most first and a tie in byte order', {
    methods: ['countOutstandingBySource', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine, backend) => {
    // `a-c` sorts before `ab` in byte order and after it in a linguistic collation, which skips the hyphen.
    for (const id of ['ab', 'a-c']) await createSource(engine, backend, id);
    const admit = async (sourceId: string, requestId: string, principalId = PRINCIPAL.id) => {
      const source = await engine.readSourceMembership(sourceId);
      const keys = [`principal:local_cli:${principalId}`, 'brain'];
      await engine.lockPersistenceCounters(keys);
      return (await engine.insertWriteRequest({ ...insertRow(source!.incarnation, requestId), sourceId, principalId, counterKeys: keys })).id;
    };
    const empty = await engine.countOutstandingBySource(PRINCIPAL.kind, PRINCIPAL.id);
    await admit('ab', 'b0000000-0000-4000-8000-0000000000c1');
    await admit('default', 'b0000000-0000-4000-8000-0000000000c2');
    await admit('a-c', 'b0000000-0000-4000-8000-0000000000c3');
    await admit('default', 'b0000000-0000-4000-8000-0000000000c4');
    await admit('ab', 'b0000000-0000-4000-8000-0000000000c5', 'other-writer');
    const finished = await admit('a-c', 'b0000000-0000-4000-8000-0000000000c6');
    await engine.stampWriteClaim(finished, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({
      id: finished, state: 'failed', outcome: null, errorCode: 'parity_error', errorMessage: 'parity', consumerVersion: 'parity',
      consumerHostId: null, errorDetail: { reason: 'parity' }, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
      terminalReservation: 4096, probePurges: false,
    });
    const result = {
      empty,
      writer: await engine.countOutstandingBySource(PRINCIPAL.kind, PRINCIPAL.id),
      other: await engine.countOutstandingBySource(PRINCIPAL.kind, 'other-writer'),
      otherKind: await engine.countOutstandingBySource('mcp', PRINCIPAL.id),
    };
    expect(result.empty).toEqual([]);
    expect(result.writer).toEqual([{ source_id: 'default', n: 2 }, { source_id: 'a-c', n: 1 }, { source_id: 'ab', n: 1 }]);
    expect(result.other).toEqual([{ source_id: 'ab', n: 1 }]);
    expect(result.otherKind).toEqual([]);
    return result;
  });

  parityTest('the managed-worktree admission reads answer no worktree, no refresh and no held write on a brain with none', {
    methods: ['readWorktreeAdmission', 'completeSyncedRefresh', 'hasDeferralRoom', 'readRefreshTiming', 'countHeldBehindImport'],
  }, async (engine) => {
    const worktreeId = 'f0000000-0000-4000-8000-0000000000a1';
    const refreshId = 'f0000000-0000-4000-8000-0000000000a2';
    const source = await engine.readSourceMembership('default');
    const key = { worktreeId, sourceId: 'default', sourceIncarnation: source!.incarnation, topologyGeneration: 0 };
    const result = {
      admission: await engine.readWorktreeAdmission(key),
      barrier: await engine.readWorktreeAdmission(key, { lockRefresh: true }),
      completed: await engine.completeSyncedRefresh(refreshId),
      room: await engine.hasDeferralRoom(worktreeId, 'import_deferral', 30_000),
      timing: await engine.readRefreshTiming(refreshId),
      held: await engine.countHeldBehindImport('default', null),
      heldByWriter: await engine.countHeldBehindImport('default', PRINCIPAL),
    };
    expect(result).toEqual({
      admission: { worktree: null, refresh: null, bound: false }, barrier: { worktree: null, refresh: null, bound: false },
      completed: false, room: true, timing: null, held: { count: 0, bytes: 0 }, heldByWriter: { count: 0, bytes: 0 },
    });
    return result;
  });

  parityTest('readCounterRows reads the existing counter rows in key byte order without creating or locking any', {
    methods: ['readCounterRows', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const empty = await engine.readCounterRows(KEYS);
    await admitDirect(engine);
    // `principal:a-c` sorts before `principal:ab` in byte order and after it in a linguistic collation.
    await engine.lockPersistenceCounters(['principal:ab', 'principal:a-c']);
    const rows = await engine.readCounterRows([...KEYS, 'brain', 'principal:ab', 'principal:a-c', 'principal:local_cli:missing']);
    const missing = await engine.readCounterRows(['principal:local_cli:missing']);
    expect(empty).toEqual([]);
    expect(rows.map(r => r.key)).toEqual(['brain', 'principal:a-c', 'principal:ab', 'principal:local_cli:parity-writer']);
    expect(missing).toEqual([]);
    return { empty, keys: rows.map(r => r.key), counters: counters(rows), missing };
  });

  parityTest('readAdmissionRate samples the latest admissions of one principal or the brain, with the brain\'s first request id', {
    methods: ['readAdmissionRate', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const empty = await engine.readAdmissionRate(null);
    const source = await engine.readSourceMembership('default');
    const admit = async (requestId: string, principalId = PRINCIPAL.id, clientRequestId: string | null = null) => {
      const keys = [`principal:local_cli:${principalId}`, 'brain'];
      await engine.lockPersistenceCounters(keys);
      return (await engine.insertWriteRequest({ ...insertRow(source!.incarnation, requestId), principalId, counterKeys: keys, clientRequestId })).id;
    };
    const first = await admit('b0000000-0000-4000-8000-0000000000d1');
    await admit('b0000000-0000-4000-8000-0000000000d2', PRINCIPAL.id, 'client-d2');
    const failed = await admit('b0000000-0000-4000-8000-0000000000d3', 'other-writer');
    await engine.stampWriteClaim(failed, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({
      id: failed, state: 'failed', outcome: null, errorCode: 'parity_error', errorMessage: 'parity', consumerVersion: 'parity',
      consumerHostId: null, errorDetail: { reason: 'parity', step: 2 }, resultBytes: 0, counterKeys: ['principal:local_cli:other-writer', 'brain'],
      intentBytes: 100, retainedBytes: 800, terminalReservation: 4096, probePurges: false,
    });
    const shape = (rate: Awaited<ReturnType<BrainEngine['readAdmissionRate']>>) => ({
      first: rate.first_request_id === first, admissions: rate.admissions, gross: rate.gross, net: rate.net,
      recent: rate.age_seconds !== null && rate.age_seconds >= 0 && rate.age_seconds < 3600,
    });
    const result = {
      empty,
      brain: shape(await engine.readAdmissionRate(null)),
      writer: shape(await engine.readAdmissionRate(PRINCIPAL)),
      other: shape(await engine.readAdmissionRate({ kind: PRINCIPAL.kind, id: 'other-writer' })),
      nobody: await engine.readAdmissionRate({ kind: 'mcp', id: PRINCIPAL.id }),
    };
    expect(result.empty).toEqual({ first_request_id: null, admissions: 0, age_seconds: null, gross: null, net: null });
    expect(result.brain).toMatchObject({ first: true, admissions: 3, recent: true });
    expect(result.writer).toMatchObject({ first: true, admissions: 2, gross: 4096, recent: true });
    expect(result.nobody).toMatchObject({ first_request_id: first, admissions: 0, age_seconds: null, gross: null, net: null });
    return { ...result, nobody: { ...result.nobody, first_request_id: result.nobody.first_request_id === first } };
  });

  parityTest('readSourceMembership returns the incarnation and archive flag, locked or not, and null for an unknown source', { methods: ['readSourceMembership'] }, async (engine) => {
    const plain = await engine.readSourceMembership('default');
    const locked = await engine.readSourceMembership('default', { lock: true });
    const unknown = await engine.readSourceMembership('parity-no-such-source');
    expect(plain?.incarnation).toMatch(UUID);
    expect(locked).toEqual(plain);
    expect(unknown).toBeNull();
    return { archived: plain?.archived, sameAsLocked: locked?.incarnation === plain?.incarnation, unknown };
  });

  parityTest('readLedgerSource reports no purges or coverage on a fresh brain, and the batch view adds the managed rows and plan mode', { methods: ['readLedgerSource'] }, async (engine) => {
    const plain = await engine.readLedgerSource('default');
    const batch = await engine.readLedgerSource('default', { batch: true });
    const unknown = await engine.readLedgerSource('parity-no-such-source');
    expect(batch?.incarnation).toBe(plain?.incarnation);
    expect(unknown).toBeNull();
    const strip = (s: typeof plain) => s && { ...s, incarnation: UUID.test(s.incarnation) };
    return { plain: strip(plain), batch: strip(batch), unknown };
  });

  parityTest('findTopologyChanges finds nothing for requests that changed no topology', { methods: ['findTopologyChanges'] }, async (engine) => {
    const one = await engine.findTopologyChanges(WRITER, [REQUEST]);
    const many = await engine.findTopologyChanges(WRITER, [REQUEST, OTHER_TOKEN]);
    expect({ one, many }).toEqual({ one: [], many: [] });
    return { one, many };
  });

  parityTest('a lifecycle receipt is stored, read back by (writer, request id), and a second one with the same id is refused', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'readTopologyChange'],
  }, async (engine) => {
    const before = await engine.readTopologyChange(WRITER, REQUEST);
    const source = await engine.readLedgerSource('default');
    const inserted = await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const read = await engine.readTopologyChange(WRITER, REQUEST);
    const otherWriter = await engine.readTopologyChange(OTHER_WRITER, REQUEST);
    const otherRequest = await engine.readTopologyChange(WRITER, OTHER_TOKEN);
    const duplicate = await engine.insertTopologyChange(lifecycleRow(source!.incarnation)).then(() => 'stored', () => 'refused');
    const answers = { before, inserted: topologyView(inserted, source!.incarnation), read: topologyView(read, source!.incarnation),
      sameRow: read?.id === inserted.id, otherWriter, otherRequest, duplicate };
    expect(answers).toMatchObject({ before: null, sameRow: true, otherWriter: null, otherRequest: null, duplicate: 'refused' });
    expect(answers.read).toEqual(answers.inserted);
    expect(answers.inserted).toMatchObject({ idIsUuid: true, incarnation: true, state: 'recovering', recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096 });
    return answers;
  });

  parityTest('readTopologyChangeDigest reads the digest a request id recorded for a source, whichever writer recorded it', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'readTopologyChangeDigest'],
  }, async (engine) => {
    const before = await engine.readTopologyChangeDigest(REQUEST, 'default');
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const answers = {
      before,
      stored: await engine.readTopologyChangeDigest(REQUEST, 'default'),
      upperCase: await engine.readTopologyChangeDigest(REQUEST.toUpperCase(), 'default'),
      otherSource: await engine.readTopologyChangeDigest(REQUEST, 'parity-no-such-source'),
      otherRequest: await engine.readTopologyChangeDigest(OTHER_TOKEN, 'default'),
    };
    expect(answers).toEqual({ before: null, stored: 'e'.repeat(64), upperCase: 'e'.repeat(64), otherSource: null, otherRequest: null });
    return answers;
  });

  parityTest('findTopologyChanges finds the request id a lifecycle receipt of the same writer used', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'findTopologyChanges'],
  }, async (engine) => {
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const answers = {
      used: await engine.findTopologyChanges(WRITER, [OTHER_TOKEN, REQUEST]),
      otherWriter: await engine.findTopologyChanges(OTHER_WRITER, [REQUEST]),
      unused: await engine.findTopologyChanges(WRITER, [OTHER_TOKEN]),
    };
    expect(answers).toEqual({ used: [{ request_id: REQUEST }], otherWriter: [], unused: [] });
    return answers;
  });

  parityTest('a page write may not reuse the request id of the writer\'s lifecycle receipt', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'readTopologyChange'],
  }, async (engine) => {
    const writer = { kind: 'local_cli', id: WRITER } as const;
    const outcome = (p: Promise<void>) => p.then(() => 'admitted', (e: { code?: string }) => e.code ?? 'error');
    const before = await outcome(assertPageRequestIdentity(engine, writer, REQUEST));
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const after = await outcome(assertPageRequestIdentity(engine, writer, REQUEST));
    const otherRequest = await outcome(assertPageRequestIdentity(engine, writer, OTHER_TOKEN));
    const answers = { before, after, otherRequest };
    expect(answers).toMatchObject({ before: 'admitted', otherRequest: 'admitted' });
    expect(answers.after).not.toBe('admitted');
    return answers;
  });

  parityTest('hasClaimableWrite is false on an empty journal and true once a queued request waits', { methods: ['hasClaimableWrite', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim'] }, async (engine) => {
    const empty = await engine.hasClaimableWrite(HOST, []);
    const id = await admitDirect(engine);
    const queued = { config: await engine.hasClaimableWrite(HOST, []), on: await engine.hasClaimableWrite(HOST, [], { priority: true }),
      off: await engine.hasClaimableWrite(HOST, [], { priority: false }), excluded: await engine.hasClaimableWrite(HOST, ['/parity/elsewhere']) };
    await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const claimed = await engine.hasClaimableWrite(HOST, []);
    const answers = { empty, queued, claimed };
    expect(answers).toEqual({ empty: false, queued: { config: true, on: true, off: true, excluded: true }, claimed: false });
    return answers;
  });

  parityTest('selectClaimableWrite takes the oldest queued request in a transaction, honours excluded and lane roots, and finds none once both are claimed', {
    methods: ['selectClaimableWrite', 'transactionDirect', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim'],
  }, async (engine) => {
    const head = (over: Partial<ClaimHeadSpec> = {}) => engine.transactionDirect(async tx => {
      const row = await tx.selectClaimableWrite<WriteRequest>({ hostId: HOST, excludeRoots: [], fifoRoots: [], laneRoots: [], nonce: 'parity-nonce', syncSeen: {},
        priority: null, leaseHolder: null, ...over });
      return row && row.request_id;
    });
    const empty = await head();
    const first = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const second = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const root = `db:${(await engine.readSourceMembership('default'))!.incarnation}`;
    const queued = {
      config: await head(), on: await head({ priority: true }), off: await head({ priority: false }), fifo: await head({ fifoRoots: [root] }),
      leaseHolder: await head({ leaseHolder: { lockPrefix: 'gbrain-sync:', pid: 1, host: 'parity-host' } }), seen: await head({ syncSeen: { [HOST]: '1' } }),
      excluded: await head({ excludeRoots: [root] }), otherExcluded: await head({ excludeRoots: ['db:parity-elsewhere'] }),
      laneFirst: await head({ laneRoots: [HOST], priority: true }), laneFifo: await head({ laneRoots: [HOST], priority: false }),
    };
    await engine.stampWriteClaim(first, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const behindRunning = await head();
    await engine.stampWriteClaim(second, OTHER_TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const claimed = await head();
    const answers = { empty, queued, behindRunning, claimed };
    const b1 = 'b0000000-0000-4000-8000-0000000000b1';
    expect(answers).toEqual({
      empty: null,
      queued: { config: b1, on: b1, off: b1, fifo: b1, leaseHolder: b1, seen: b1, excluded: null, otherExcluded: b1, laneFirst: b1, laneFifo: null },
      behindRunning: null, claimed: null,
    });
    return answers;
  });

  parityTest('readHeadBlockerRows names the earlier head a queued request waits behind, queued then running, readRecoveringHeadRow finds no recovering head, and a malformed uuid refuses', {
    methods: ['readHeadBlockerRows', 'readRecoveringHeadRow', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim'],
  }, async (engine) => {
    const b1 = 'b0000000-0000-4000-8000-0000000000b1';
    const b2 = 'b0000000-0000-4000-8000-0000000000b2';
    const unknown = 'a0000000-0000-4000-8000-0000000000a9';
    const probe = async (ids: string[], priority?: boolean) => (await engine.readHeadBlockerRows(ids, HOST, priority === undefined ? {} : { priority }))
      .map(row => ({
        request: row.request_id, worktree: row.worktree_id, owner: row.owner_host_id, worktreeState: row.worktree_state, backoff: row.backoff_until,
        claimable: row.claimable, fence: row.fence, effectRecovery: row.effect_recovery, mirrors: row.mirrors, requestRecovery: row.request_recovery,
        earlier: row.earlier?.map(e => ({ request: e.request_id, state: e.state, token: e.execution_token, lapsed: e.claim_lapsed,
          publication: e.publication_started, recovery: e.recovery, principal: `${e.principal_kind}:${e.principal_id}` })) ?? null,
        ahead: row.ahead,
      }))
      .sort((a, b) => a.request.localeCompare(b.request));
    const empty = await probe([unknown]);
    const first = await admitDirect(engine, b1);
    const second = await admitDirect(engine, b2);
    const queued = { config: await probe([first, second, unknown]), on: await probe([second], true), off: await probe([second], false) };
    await engine.stampWriteClaim(first, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const behindRunning = await probe([first, second]);
    const recovering = { queued: await engine.readRecoveringHeadRow(second), unknown: await engine.readRecoveringHeadRow(unknown) };
    const refusal = (run: () => Promise<unknown>) => run().then(() => 'answered', (e: Error) => /invalid input syntax for type uuid/.test(e.message) ? 'uuid refusal' : e.message);
    const malformed = { host: await refusal(() => engine.readHeadBlockerRows([second], 'not-a-uuid')), id: await refusal(() => engine.readHeadBlockerRows(['not-a-uuid'], HOST)),
      recovering: await refusal(() => engine.readRecoveringHeadRow('not-a-uuid')) };
    const answers = { empty, queued, behindRunning, recovering, malformed };
    const ref = (request: string, state: string, token: string | null) => ({ request, state, token, lapsed: false, publication: false, recovery: false,
      principal: `${PRINCIPAL.kind}:${PRINCIPAL.id}` });
    const row = (request: string, claimable: boolean, earlier: ReturnType<typeof ref>[] | null) => ({ request, worktree: null, owner: null, worktreeState: null, backoff: null,
      claimable, fence: null, effectRecovery: null, mirrors: null, requestRecovery: null, earlier, ahead: null });
    const waiting = row(b2, false, [ref(b1, 'queued', null)]);
    expect(answers).toEqual({
      empty: [],
      queued: { config: [row(b1, true, null), waiting], on: [waiting], off: [waiting] },
      behindRunning: [row(b2, false, [ref(b1, 'running', TOKEN)])],
      recovering: { queued: null, unknown: null },
      malformed: { host: 'uuid refusal', id: 'uuid refusal', recovering: 'uuid refusal' },
    });
    return answers;
  });

  parityTest('insertPublicationEffects inserts in queue order, skips a gated effect while auto-linking is off and keeps a kind already queued', {
    methods: ['insertPublicationEffects', 'transactionDirect', 'declarePersistence', 'setConfig', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const revision = 'e0000000-0000-4000-8000-0000000000e1';
    const insert = (requestId: string, effects: QueuedPublicationEffect[], rev: string | null = revision) => engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId, revision: rev, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null, effects });
    });
    const page = { slug: 'notes/parity', page_id: 1 };
    const first = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const queued = await insert(first, [{ kind: 'embedding', data: page }, { kind: 'facts-backstop', data: { ...page, visibility: 'private' } },
      { kind: 'links', data: { ...page, range: { from: 0, to: 4 } }, gated: true }]);
    const again = await insert(first, [{ kind: 'embedding', data: { ...page, retry: true } }]);
    await engine.setConfig('mcp.remote_auto_links', ' OFF ');
    const second = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const remoteOff = await insert(second, [{ kind: 'links', data: page, gated: true }, { kind: 'embedding', data: page }], null);
    await engine.setConfig('mcp.remote_auto_links', 'true');
    await engine.setConfig('auto_link', 'No');
    const third = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3');
    const autoLinkOff = await insert(third, [{ kind: 'links', data: page, gated: true }, { kind: 'git', data: page }]);
    await engine.setConfig('auto_link', 'yes');
    const fourth = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b4');
    const switchesOn = await insert(fourth, [{ kind: 'links', data: page, gated: true }]);
    const answers = { queued, again, remoteOff, autoLinkOff, switchesOn };
    expect(answers).toEqual({ queued: ['embedding', 'facts-backstop', 'links'], again: [], remoteOff: ['embedding'], autoLinkOff: ['git'], switchesOn: ['links'] });
    return answers;
  });

  parityTest('insertWithdrawalEffects queues a withdrawal\'s three effects in the withdrawal\'s transaction, keeps a queued kind, skips an unknown source and refuses a missing request', {
    methods: ['insertWithdrawalEffects', 'transaction', 'readRequestEffects', 'selectClaimableEffect', 'transactionDirect', 'declarePersistence', 'readSourceMembership',
      'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const id = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b5');
    const r1 = 'e0000000-0000-4000-8000-0000000000e1', r2 = 'e0000000-0000-4000-8000-0000000000e2';
    const targets = [{ slug: 'people/b', page_id: 2, revision: r2 }, { slug: 'people/a', page_id: 1, revision: r1 }];
    await engine.transaction(async tx => {
      await tx.insertWithdrawalEffects({ requestId: id, sourceId: 'default', targets });
      await tx.insertWithdrawalEffects({ requestId: id, sourceId: 'default', targets: [] });
      await tx.insertWithdrawalEffects({ requestId: 'b0000000-0000-4000-8000-0000000000ff', sourceId: 'no-such-source', targets });
    });
    const refusal = async (requestId: string) => {
      try { await engine.transaction(tx => tx.insertWithdrawalEffects({ requestId, sourceId: 'default', targets })); return 'ok'; }
      catch (e) { return /invalid input syntax for type uuid|violates foreign key constraint "persistence_effects_request_id_fkey"/.exec(String((e as Error).message))?.[0] ?? String(e); }
    };
    const refusals = { missing: await refusal('b0000000-0000-4000-8000-0000000000fe'), notUuid: await refusal('not-a-uuid') };
    const head = await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.selectClaimableEffect<Record<string, unknown>>(HOST, []);
    });
    const waiting = (kind: string) => ({ kind, state: 'queued', error_code: null, outcome: null, recovering: false });
    const answers = { effects: await engine.readRequestEffects(id), stray: await engine.readRequestEffects('b0000000-0000-4000-8000-0000000000ff'),
      head: { kind: head?.kind, data: head?.data, revision: head?.revision, source_id: head?.source_id, incarnation: head?.source_incarnation === incarnation,
        worktree_id: head?.worktree_id }, refusals };
    expect(answers).toEqual({ effects: [waiting('embedding'), waiting('git'), waiting('withdrawal-mirror')], stray: [],
      head: { kind: 'withdrawal-mirror', data: { version: 2, targets: [{ slug: 'people/a', page_id: 1, revision: r1 }, { slug: 'people/b', page_id: 2, revision: r2 }] },
        revision: null, source_id: 'default', incarnation: true, worktree_id: null },
      refusals: { missing: 'violates foreign key constraint "persistence_effects_request_id_fkey"', notUuid: 'invalid input syntax for type uuid' } });
    return answers;
  });

  parityTest('a withdrawal queued under an uppercase request id is stored and found by the mirror gate as Postgres reads a uuid', {
    methods: ['insertWithdrawalEffects', 'transaction', 'readRequestEffects', 'readMirrorGateRows', 'readSourceMembership', 'lockPersistenceCounters',
      'insertWriteRequest'],
  }, async (engine) => {
    const id = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b6');
    const upper = id.toUpperCase();
    const targets = [{ slug: 'people/a', page_id: 1, revision: 'e0000000-0000-4000-8000-0000000000e1' }];
    await engine.transaction(tx => tx.insertWithdrawalEffects({ requestId: upper, sourceId: 'default', targets }));
    await engine.transaction(tx => tx.insertWithdrawalEffects({ requestId: id, sourceId: 'default', targets }));
    // The id itself differs per arm, so each row says whether it carries the stored lowercase id.
    const gate = async (requestId: string) => (await engine.readMirrorGateRows([requestId])).map(row => ({ lowercase_id: row.request_id === id, state: row.state }));
    const answers = { lowercase: id === id.toLowerCase(), effects: (await engine.readRequestEffects(id)).map(e => e.kind), lower: await gate(id), upper: await gate(upper) };
    expect(answers).toEqual({ lowercase: true, effects: ['embedding', 'git', 'withdrawal-mirror'], lower: [{ lowercase_id: true, state: 'queued' }],
      upper: [{ lowercase_id: true, state: 'queued' }] });
    return answers;
  });

  parityTest('readRequestEffects reads a request\'s queued effects in kind order, or only its Git effect, and refuses a non-uuid id', {
    methods: ['readRequestEffects', 'insertPublicationEffects', 'transactionDirect', 'declarePersistence', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const page = { slug: 'notes/parity', page_id: 1 };
    const id = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const bare = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'links', data: page, gated: true }, { kind: 'git', data: { relative_path: 'notes/parity.md' } }, { kind: 'embedding', data: page }] });
    });
    let refusal = 'ok';
    try { await engine.readRequestEffects('not-a-uuid'); } catch (e) { refusal = /invalid input syntax for type uuid/.exec(String((e as Error).message))?.[0] ?? String(e); }
    const answers = { all: await engine.readRequestEffects(id), git: await engine.readRequestEffects(id, 'git'), none: await engine.readRequestEffects(bare),
      noGit: await engine.readRequestEffects(bare, 'git'), refusal };
    const waiting = (kind: string) => ({ kind, state: 'queued', error_code: null, outcome: null, recovering: false });
    expect(answers).toEqual({ all: [waiting('embedding'), waiting('git'), waiting('links')], git: [waiting('git')], none: [], noGit: [],
      refusal: 'invalid input syntax for type uuid' });
    return answers;
  });

  parityTest('listEmbeddingCandidates lists a re-queued embedding effect of a committed write with the characters its retry embeds', {
    methods: ['listEmbeddingCandidates', 'insertPublicationEffects', 'transactionDirect', 'declarePersistence', 'readSourceMembership', 'lockPersistenceCounters',
      'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'putPage', 'getPage'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    await engine.putPage('notes/parity', { type: 'note', title: 'Parity', compiled_truth: 'twelve chars', timeline: 'abc' });
    const pageId = (await engine.getPage('notes/parity'))!.id;
    const queue = async (requestId: string, data: Record<string, unknown>) => {
      const id = await admitDirect(engine, requestId);
      await engine.transactionDirect(async tx => {
        await tx.declarePersistence();
        return tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
          effects: [{ kind: 'embedding', data: { ...data, repair_requeued_at: 'parity' } }, { kind: 'git', data: { relative_path: 'notes/parity.md' } }] });
      });
      return id;
    };
    const commit = async (id: string) => {
      await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.completeWriteRow({
        id, state: 'committed', outcome: {}, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
        resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 0, terminalReservation: 4096, probePurges: false,
      });
    };
    const never = ['targets_parked', 'embedding_zero_norm'];
    const view = (rows: Awaited<ReturnType<BrainEngine['listEmbeddingCandidates']>>) =>
      rows.map(r => ({ source_id: r.source_id, slug: r.slug, request_id: r.request_id, state: r.state, attempts: r.attempts, chars: r.chars }));
    const page = await queue('b0000000-0000-4000-8000-0000000000b6', { slug: 'notes/parity', page_id: pageId });
    const targets = await queue('b0000000-0000-4000-8000-0000000000b7', { targets: [{ slug: 'notes/parity', page_id: pageId }, { slug: 'notes/parity', page_id: pageId }] });
    const queued = view(await engine.listEmbeddingCandidates(['default'], never));
    await commit(page);
    await commit(targets);
    const answers = { queued, committed: view(await engine.listEmbeddingCandidates(['default'], never)),
      otherSource: view(await engine.listEmbeddingCandidates(['other'], never)) };
    const row = (request_id: string, chars: number) => ({ source_id: 'default', slug: 'notes/parity-example', request_id, state: 'queued' as const, attempts: 0, chars });
    expect(answers).toEqual({ queued: [],
      committed: [row('b0000000-0000-4000-8000-0000000000b6', 15), row('b0000000-0000-4000-8000-0000000000b7', 30)], otherSource: [] });
    return answers;
  });

  // Doctor's stale_embedding_effects reads: the Rust engine answered them as always empty, though its store keeps the
  // effect rows. A failed (through a real claim) and a re-queued embedding effect of a committed write count; one of an
  // uncommitted write does not.
  parityTest('readStaleEmbeddingCounts and listStaleEmbeddingEffects count and list the failed and re-queued embedding effects of committed writes', {
    methods: ['readStaleEmbeddingCounts', 'listStaleEmbeddingEffects', 'insertPublicationEffects', 'transactionDirect', 'declarePersistence', 'selectClaimableEffect', 'stampEffectClaim', 'failEffectRow',
      'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'putPage', 'getPage'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    await engine.putPage('notes/parity', { type: 'note', title: 'Parity', compiled_truth: 'twelve chars', timeline: 'abc' });
    const pageId = (await engine.getPage('notes/parity'))!.id;
    const queue = async (requestId: string) => {
      const id = await admitDirect(engine, requestId);
      await engine.transactionDirect(async tx => {
        await tx.declarePersistence();
        return tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
          effects: [{ kind: 'embedding', data: { slug: 'notes/parity', page_id: pageId, repair_requeued_at: 'parity' } }, { kind: 'git', data: { relative_path: 'notes/parity.md' } }] });
      });
      return id;
    };
    const commit = async (id: string) => {
      await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.completeWriteRow({
        id, state: 'committed', outcome: {}, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
        resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 0, terminalReservation: 4096, probePurges: false,
      });
    };
    const view = (rows: Awaited<ReturnType<BrainEngine['listStaleEmbeddingEffects']>>) => rows.map(r => ({
      source_id: r.source_id, slug: r.slug, request_id: r.request_id, state: r.state,
      effect_id: /^\d+$/.test(r.effect_id) ? 'id' : r.effect_id, updated_at: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/.test(r.updated_at) ? 'stamp' : r.updated_at,
    }));
    const empty = { counts: await engine.readStaleEmbeddingCounts(null), rows: await engine.listStaleEmbeddingEffects(null) };
    // A failed embedding effect, failed through a real effect-worker claim (the only effect, so the claim takes it).
    const failedRequest = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000e5');
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: failedRequest, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'embedding', data: { slug: 'notes/parity', page_id: pageId } }] });
    });
    type Claimed = { id: string | number; kind: string; execution_token: string | null };
    const claimed = await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      const candidate = await tx.selectClaimableEffect<Claimed>(HOST, []);
      if (!candidate) return null;
      return tx.stampEffectClaim<Claimed>({ id: candidate.id, token: OTHER_TOKEN, ownerJson: JSON.stringify({ token: OTHER_TOKEN, owner: { pid: 1, nonce: 'n', start: 's' } }) });
    });
    await engine.failEffectRow({ id: claimed!.id, token: claimed!.execution_token, reason: 'parity_failed' });
    await commit(failedRequest);
    const first = await queue('b0000000-0000-4000-8000-0000000000e6');
    await queue('b0000000-0000-4000-8000-0000000000e7');
    const uncommitted = await engine.readStaleEmbeddingCounts(null);
    await commit(first);
    const rows = await engine.listStaleEmbeddingEffects(null);
    const answers = {
      empty, uncommitted,
      counts: await engine.readStaleEmbeddingCounts(null),
      scoped: await engine.readStaleEmbeddingCounts(['default']),
      other: await engine.readStaleEmbeddingCounts(['other']),
      rows: view(rows),
      otherRows: await engine.listStaleEmbeddingEffects(['other']),
    };
    const counts = (count: number, failed: number, requeued: number) => ({ count, failed, requeued });
    const row = (request_id: string, state: string) => ({ source_id: 'default', slug: 'notes/parity-example', request_id, state, effect_id: 'id', updated_at: 'stamp' });
    expect({ ...answers, claimedKind: claimed?.kind }).toEqual({
      empty: { counts: counts(0, 0, 0), rows: [] }, uncommitted: counts(1, 1, 0), counts: counts(2, 1, 1), scoped: counts(2, 1, 1), other: counts(0, 0, 0),
      rows: [row('b0000000-0000-4000-8000-0000000000e5', 'failed'), row('b0000000-0000-4000-8000-0000000000e6', 'queued')],
      otherRows: [], claimedKind: 'embedding',
    });
    return answers;
  });

  parityTest('the receipt-compaction reads list settled receipts before the cutoff and keep a receipt of an open managed-sync run', {
    methods: ['readReceiptCompactionWindow', 'listReceiptCompactionCandidates', 'countKeptFailedReceipts', 'writeOpCheckpointRecord', 'readSourceMembership',
      'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const empty = await engine.readReceiptCompactionWindow(-1);
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const settle = async (requestId: string, intent: Record<string, unknown>, state: 'committed' | 'failed') => {
      await engine.lockPersistenceCounters(KEYS);
      const { id } = await engine.insertWriteRequest({ ...insertRow(incarnation, requestId), intent });
      await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.completeWriteRow({
        id, state, outcome: {}, errorCode: state === 'failed' ? 'storage_error' : null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null,
        errorDetail: null, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 512, terminalReservation: 4096, probePurges: false,
      });
    };
    await settle('b0000000-0000-4000-8000-0000000000b8', { kind: 'put_page', slug: 'notes/parity-example', runId: 'run-parity' }, 'committed');
    await settle('b0000000-0000-4000-8000-0000000000b9', { kind: 'put_page', slug: 'notes/parity-example' }, 'failed');
    const ahead = await engine.readReceiptCompactionWindow(-1);
    const behind = await engine.readReceiptCompactionWindow(1);
    const view = async (states: string[], cutoff: string) => (await engine.listReceiptCompactionCandidates(states, cutoff, ahead.max_sequence!))
      .map(r => ({ request_id: r.request_id, state: r.state, source_id: r.source_id, terminal_reservation: r.terminal_reservation, sequence: typeof r.sequence as string }));
    const both = await view(['committed', 'failed'], ahead.cutoff);
    const committedOnly = await view(['committed'], ahead.cutoff);
    const tooOld = await view(['committed', 'failed'], behind.cutoff);
    await engine.writeOpCheckpointRecord('managed-sync', 'parity-run', [{ runId: 'run-parity', done: false }]);
    const openRun = await view(['committed', 'failed'], ahead.cutoff);
    const answers = { emptyMax: empty.max_sequence, cutoffShape: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(ahead.cutoff), maxSequence: typeof ahead.max_sequence,
      both, committedOnly, tooOld, openRun, keptAhead: await engine.countKeptFailedReceipts(ahead.cutoff), keptBehind: await engine.countKeptFailedReceipts(behind.cutoff) };
    const row = (request_id: string, state: string) => ({ request_id, state, source_id: 'default', terminal_reservation: '512', sequence: 'string' as string });
    const committed = row('b0000000-0000-4000-8000-0000000000b8', 'committed');
    const failed = row('b0000000-0000-4000-8000-0000000000b9', 'failed');
    expect(answers).toEqual({ emptyMax: null, cutoffShape: true, maxSequence: 'string', both: [committed, failed], committedOnly: [committed], tooOld: [],
      openRun: [failed], keptAhead: 1, keptBehind: 0 });
    return answers;
  });

  parityTest('the attribution-backfill reads list the rows exactly one committed request proves and count every unfilled row', {
    methods: ['listProvenAttributionTargets', 'countUnfilledAttribution', 'putPage', 'getPage', 'createVersion', 'readSourceMembership',
      'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const targets = (table: 'pages' | 'page_versions' | 'facts', sources = ['default']) => engine.listProvenAttributionTargets(table, sources);
    const unfilled = async (sources = ['default']) => ({ pages: await engine.countUnfilledAttribution('pages', sources),
      page_versions: await engine.countUnfilledAttribution('page_versions', sources), facts: await engine.countUnfilledAttribution('facts', sources) });
    const empty = { pages: await targets('pages'), unfilled: await unfilled() };
    await engine.putPage('notes/attrib-one', { type: 'note', title: 'One', compiled_truth: 'one', timeline: '' });
    await engine.putPage('notes/attrib-two', { type: 'note', title: 'Two', compiled_truth: 'two', timeline: '' });
    await engine.createVersion('notes/attrib-one');
    const one = (await engine.getPage('notes/attrib-one'))!;
    const two = (await engine.getPage('notes/attrib-two'))!;
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const commit = async (requestId: string, operation: string, outcome: Record<string, unknown>) => {
      await engine.lockPersistenceCounters(KEYS);
      const { id } = await engine.insertWriteRequest({ ...insertRow(incarnation, requestId), operation });
      await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.completeWriteRow({
        id, state: 'committed', outcome, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
        resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 0, terminalReservation: 4096, probePurges: false,
      });
    };
    const changed = (revision: unknown, extra: Record<string, unknown> = {}) => ({ status: 'created_or_updated', revision, ...extra });
    await commit('b0000000-0000-4000-8000-0000000000ba', 'put_page', changed(one.knowledge_revision));
    await commit('b0000000-0000-4000-8000-0000000000bb', 'edit_page', changed(two.knowledge_revision));
    await commit('b0000000-0000-4000-8000-0000000000bc', 'capture', changed(two.knowledge_revision));
    await commit('b0000000-0000-4000-8000-0000000000bd', 'put_page', changed(one.knowledge_revision, { noop: true }));
    await commit('b0000000-0000-4000-8000-0000000000be', 'put_page', { status: 'skipped', revision: one.knowledge_revision });
    const slugOf = (id: number) => id === one.id ? 'one' : id === two.id ? 'two' : String(id);
    const answers = { empty, pages: (await targets('pages')).map(slugOf), versions: (await targets('page_versions')).length, facts: await targets('facts'),
      unfilled: await unfilled(), other: await targets('pages', ['other']), otherUnfilled: await unfilled(['other']) };
    expect(answers).toEqual({ empty: { pages: [], unfilled: { pages: 0, page_versions: 0, facts: 0 } }, pages: ['one'], versions: 1, facts: [],
      unfilled: { pages: 2, page_versions: 1, facts: 0 }, other: [], otherUnfilled: { pages: 0, page_versions: 0, facts: 0 } });
    return answers;
  });

  parityTest('the drift-conflict reads group source_changed receipts by slug inside the window, fenced by prefix and page visibility', {
    methods: ['readDriftConflictBounds', 'listDriftConflictGroups', 'readDriftConflictDetails', 'readSourceMembership', 'lockPersistenceCounters',
      'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'putPage'],
  }, async (engine) => {
    const drift = 'The canonical file contains an uncoordinated local edit.';
    const unknown = await engine.readDriftConflictBounds('missing');
    const before = await engine.readDriftConflictBounds('default');
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    await engine.putPage('notes/drift-a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '' });
    await engine.putPage('notes/drift-b', { type: 'note', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: { visibility: 'private' } });
    const settle = async (n: string, operation: string, slug: string, intent: Record<string, unknown>, state: 'conflict' | 'committed' | 'failed',
      errorCode: string | null, errorMessage: string | null) => {
      await engine.lockPersistenceCounters(KEYS);
      const { id } = await engine.insertWriteRequest({ ...insertRow(incarnation, `d0000000-0000-4000-8000-0000000000${n}`), operation, slug, intent });
      await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.completeWriteRow({
        id, state, outcome: {}, errorCode, errorMessage, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
        resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 0, terminalReservation: 4096, probePurges: false,
      });
    };
    await settle('d1', 'put_page', 'notes/drift-a', { slug: 'notes/drift-a' }, 'committed', null, null);
    await settle('d2', 'put_page', 'notes/drift-a', { kind: 'managed_sync_import' }, 'conflict', 'source_changed', drift);
    await settle('d3', 'add_timeline_entry', 'notes/drift-a', { slug: 'notes/drift-a' }, 'conflict', 'source_changed', 'other');
    await settle('d4', 'put_page', 'notes/drift-b', { slug: 'notes/drift-b' }, 'conflict', 'source_changed', drift);
    await settle('d5', 'put_page', 'notes/drift-gone', { slug: 'notes/drift-gone' }, 'conflict', 'source_changed', drift);
    await settle('d6', 'put_page', 'people/drift-c', { slug: 'people/drift-c' }, 'conflict', 'source_changed', drift);
    await settle('d7', 'put_page', 'notes/drift-a', { slug: 'notes/drift-a' }, 'conflict', 'revision_conflict', drift);
    await settle('d8', 'put_page', 'notes/drift-a', { slug: 'notes/drift-a' }, 'committed', null, null);
    const bounds = (await engine.readDriftConflictBounds('default'))!;
    const top = BigInt(bounds.top!);
    const query = { incarnation: bounds.incarnation, floor: '0', through: String(top), requireLivePage: false, excludePrivate: false,
      after: '', limit: 10, driftMessage: drift };
    const groups = async (q: Partial<typeof query> & { slugPrefixes?: string[] }) => {
      const out = await engine.listDriftConflictGroups('default', { ...query, ...q });
      return { slugs: out.slugs, receipts: out.receipts, rows: out.rows.map(r => ({ ...r, first_seen: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.first_seen),
        last_seen: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.last_seen) })) };
    };
    const details = await engine.readDriftConflictDetails('default', ['notes/drift-a', 'notes/drift-b', 'notes/drift-gone'], { paths: true });
    const answers = {
      unknown, before: before && { incarnation: before.incarnation === incarnation, top: before.top, bottom: before.bottom },
      bounds: { incarnation: bounds.incarnation === incarnation, ordered: BigInt(bounds.bottom!) < top },
      all: await groups({}), paged: await groups({ after: 'notes/drift-a', limit: 1 }),
      window: await groups({ floor: String(top - 4n) }), notes: await groups({ slugPrefixes: ['notes/'] }),
      exact: await groups({ slugPrefixes: ['people/drift-c'] }), live: await groups({ requireLivePage: true }),
      visible: await groups({ requireLivePage: true, excludePrivate: true }), other: await engine.listDriftConflictGroups('default', { ...query, incarnation: TOKEN }),
      committed: details.committed.map(r => ({ slug: r.slug, request_id: r.request_id, completed: /Z$/.test(r.completed_at) })).sort((a, b) => a.slug.localeCompare(b.slug)),
      recorded: [...details.recorded].sort((a, b) => a.slug.localeCompare(b.slug)),
      noPaths: (await engine.readDriftConflictDetails('default', ['notes/drift-a'], { paths: false })).recorded,
      none: await engine.readDriftConflictDetails('default', [], { paths: true }),
    };
    const group = (slug: string, receipts: number, drift_receipts: number, producers: string[], n: string) =>
      ({ slug, receipts, drift_receipts, first_seen: true, last_seen: true, producers, last_request_id: `d0000000-0000-4000-8000-0000000000${n}` });
    const a = group('notes/drift-a', 2, 1, ['add_timeline_entry', 'put_page:managed_sync_import'], 'd3');
    const b = group('notes/drift-b', 1, 1, ['put_page'], 'd4');
    const gone = group('notes/drift-gone', 1, 1, ['put_page'], 'd5');
    const c = group('people/drift-c', 1, 1, ['put_page'], 'd6');
    expect(answers).toEqual({
      unknown: null, before: { incarnation: true, top: null, bottom: null }, bounds: { incarnation: true, ordered: true },
      all: { slugs: 4, receipts: 5, rows: [a, b, gone, c] }, paged: { slugs: 4, receipts: 5, rows: [b] },
      window: { slugs: 2, receipts: 2, rows: [gone, c] }, notes: { slugs: 3, receipts: 4, rows: [a, b, gone] },
      exact: { slugs: 1, receipts: 1, rows: [c] }, live: { slugs: 2, receipts: 3, rows: [a, b] }, visible: { slugs: 1, receipts: 2, rows: [a] },
      other: { slugs: 0, receipts: 0, rows: [] },
      committed: [{ slug: 'notes/drift-a', request_id: 'd0000000-0000-4000-8000-0000000000d8', completed: true }],
      recorded: [{ slug: 'notes/drift-a', source_path: null, source_uri: null }, { slug: 'notes/drift-b', source_path: null, source_uri: null }],
      noPaths: [], none: { committed: [], recorded: [] },
    });
    return answers;
  });

  parityTest('the failed-writes read lists guard, drift and moved-fact refusals, without a fact request a later batch recovered', {
    methods: ['listFailedWriteRequests', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const moved = 'The fact entity changed after extraction admission.';
    const query = { replayable: ['put_page', 'add_timeline_entry', 'remember'] };
    const empty = await engine.listFailedWriteRequests(['default'], { ...query, factsMovedMessages: [moved] });
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const settle = async (requestId: string, operation: string, slug: string, intent: Record<string, unknown>, state: 'failed' | 'conflict' | 'committed',
      errorCode: string | null, errorMessage: string | null, errorDetail: Record<string, unknown> | null = null) => {
      await engine.lockPersistenceCounters(KEYS);
      const { id } = await engine.insertWriteRequest({ ...insertRow(incarnation, requestId), operation, slug, intent });
      await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.completeWriteRow({
        id, state, outcome: {}, errorCode, errorMessage, consumerVersion: 'parity', consumerHostId: null, errorDetail,
        resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 0, terminalReservation: 4096, probePurges: false,
      });
      return id;
    };
    const guard = await settle('b0000000-0000-4000-8000-0000000000c1', 'put_page', 'notes/parity-example', { slug: 'notes/parity-example' }, 'failed',
      'writer_coordinator_required', 'refused', { origin: 'pending_import' });
    await settle('b0000000-0000-4000-8000-0000000000c2', 'put_page', 'notes/parity-example', { kind: 'managed_sync_import' }, 'conflict', 'source_changed', 'drifted');
    await settle('b0000000-0000-4000-8000-0000000000c3', 'remember', 'notes/parity-example', { fact: 'a' }, 'failed', 'storage_error', 'Publication failed (P0001): guard');
    await settle('b0000000-0000-4000-8000-0000000000c4', 'remember', 'notes/parity-example', { fact: 'b' }, 'failed', 'storage_error', 'disk full');
    await settle('b0000000-0000-4000-8000-0000000000c5', 'extract_facts', 'people/parity-example', { kind: 'managed_facts_entity', inputDigest: 'd1', batchKey: 'k1' },
      'conflict', 'revision_conflict', moved);
    const recovered = await settle('b0000000-0000-4000-8000-0000000000c6', 'extract_facts', 'people/parity-example',
      { kind: 'managed_facts_entity', inputDigest: 'd2', batchKey: 'k1' }, 'conflict', 'revision_conflict', moved);
    await settle('b0000000-0000-4000-8000-0000000000c7', 'extract_facts', 'people/parity-example', { kind: 'managed_facts_entity', inputDigest: 'd2', batchKey: 'k2' },
      'committed', null, null);
    const list = async (q: Parameters<BrainEngine['listFailedWriteRequests']>[1], sources = ['default']) =>
      (await engine.listFailedWriteRequests(sources, q)).map(r => ({
        request_id: r.request_id, operation: r.operation, slug: r.slug, state: r.state, error_code: r.error_code, origin: r.origin, producer: r.producer,
        page_id: r.page_id, intent: r.intent, authority: r.authority, digest: r.digest, created: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.created_at),
        id: UUID.test(r.id), sequence: /^\d+$/.test(r.sequence),
      }));
    const answers = { empty, plain: await list(query), facts: await list({ ...query, factsMovedMessages: [moved] }),
      byId: (await list({ ...query, factsMovedMessages: [moved], id: recovered })).map(r => r.request_id),
      guardById: (await list({ ...query, id: guard })).map(r => r.request_id), other: await list(query, ['other']) };
    const row = (n: string, operation: string, slug: string, state: string, error_code: string, intent: Record<string, unknown>, producer: string | null, origin: string | null = null) =>
      ({ request_id: `b0000000-0000-4000-8000-0000000000${n}`, operation, slug, state, error_code, origin, producer, page_id: null, intent,
        authority: { scopes: ['write'] }, digest: 'd'.repeat(64), created: true, id: true, sequence: true });
    const plain = [row('c1', 'put_page', 'notes/parity-example', 'failed', 'writer_coordinator_required', { slug: 'notes/parity-example' }, null, 'pending_import'),
      row('c2', 'put_page', 'notes/parity-example', 'conflict', 'source_changed', { kind: 'managed_sync_import' }, 'put_page:managed_sync_import'),
      row('c3', 'remember', 'notes/parity-example', 'failed', 'storage_error', { fact: 'a' }, null)];
    expect(answers).toEqual({ empty: [], plain, facts: [...plain, row('c5', 'extract_facts', 'people/parity-example', 'conflict', 'revision_conflict',
      { kind: 'managed_facts_entity', inputDigest: 'd1', batchKey: 'k1' }, 'extract_facts:managed_facts_entity')],
      byId: ['b0000000-0000-4000-8000-0000000000c6'], guardById: ['b0000000-0000-4000-8000-0000000000c1'], other: [] });
    return answers;
  });

  parityTest('the effect worker claims the due effect and settles each claim under its token, a stale token changing nothing', {
    methods: ['selectClaimableEffect', 'stampEffectClaim', 'renewEffectClaim', 'advanceEffectRow', 'completeEffectRow', 'retryEffectRow', 'retryBusyEffectRow',
      'requeueEffectRow', 'parkEffectRow', 'failEffectRow', 'readMirrorGateRows', 'readRequestEffects', 'insertPublicationEffects', 'transactionDirect',
      'declarePersistence', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'lockEffectGuard'],
  }, async (engine) => {
    type Row = { id: string | number; kind: string; state: string; attempts: number; error_code: string | null; data: Record<string, unknown>; outcome: unknown; execution_token: string | null };
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const id = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3');
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'embedding', data: { slug: 'notes/parity', page_id: 1, target_failures: 1 } }, { kind: 'git', data: { relative_path: 'notes/parity.md', target_failures: 2 } },
          { kind: 'links', data: { slug: 'notes/parity', page_id: 1 } }] });
    });
    const owner = { pid: 1, nonce: 'n', start: 's' };
    let n = 0;
    const claim = (dead: string[] = []) => engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      const candidate = await tx.selectClaimableEffect<Row>(HOST, dead);
      if (!candidate) return null;
      const token = `f0000000-0000-4000-8000-00000000000${++n}`;
      return tx.stampEffectClaim<Row>({ id: candidate.id, token, ownerJson: JSON.stringify({ token, owner }) });
    });
    const shape = (row: Row | null) => row && { kind: row.kind, state: row.state, attempts: Number(row.attempts), error_code: row.error_code, data: row.data, outcome: row.outcome };
    const ref = (row: Row | null) => ({ id: row!.id, token: row!.execution_token });
    const claims: unknown[] = [];
    const a = await claim(); claims.push(shape(a));
    const renewed = { stale: await engine.renewEffectClaim({ id: a!.id, token: OTHER_TOKEN }, { direct: true }), nullToken: await engine.renewEffectClaim({ id: a!.id, token: null }),
      held: await engine.renewEffectClaim(ref(a), { direct: true }) };
    const b = await claim(); claims.push(shape(b));
    const c = await claim(); claims.push(shape(c));
    const none = await claim();
    const deadOwner = shape(await engine.transactionDirect(async tx => { await tx.declarePersistence(); return tx.selectClaimableEffect<Row>(HOST, ['1:n:s']); }));
    await engine.completeEffectRow({ ...ref(a), outcomeJson: JSON.stringify({ embedding: 'skipped', reason: 'parity' }) });
    await engine.completeEffectRow({ ...ref(a), outcomeJson: JSON.stringify({ embedding: 'again' }) });
    await engine.retryEffectRow({ ...ref(b), reason: 'parity_retry', delayMs: 0 });
    await engine.failEffectRow({ ...ref(c), reason: 'parity_failed' });
    const b2 = await claim(); claims.push(shape(b2));
    await engine.advanceEffectRow({ ...ref(b2), slug: 'notes/a' });
    const b3 = await claim(); claims.push(shape(b3));
    await engine.requeueEffectRow({ ...ref(b3), dataJson: JSON.stringify({ relative_path: 'notes/parity.md', after_slug: 'notes/b' }), reason: 'parity_requeue', delayMs: 0 });
    const b4 = await claim(); claims.push(shape(b4));
    await engine.retryBusyEffectRow({ ...ref(b4), dataJson: JSON.stringify({ busy_retries: 1 }), delayMs: 0 });
    const b5 = await claim(); claims.push(shape(b5));
    await engine.parkEffectRow({ ...ref(b5), dataJson: JSON.stringify({ relative_path: 'notes/parity.md', parked: [{ slug: 'notes/a' }] }) });
    await engine.advanceEffectRow({ ...ref(b5), slug: 'notes/stale' });
    const refusals: string[] = [];
    for (const run of [() => engine.selectClaimableEffect('not-a-uuid', []), () => engine.readMirrorGateRows(['not-a-uuid']),
      () => engine.lockEffectGuard('not-a-uuid')]) {
      try { await run(); refusals.push('ok'); } catch (e) { refusals.push(/invalid input syntax for type uuid/.exec(String((e as Error).message))?.[0] ?? String(e)); }
    }
    const answers = { claims, renewed, none, deadOwner, gates: await engine.readMirrorGateRows([id]), effects: await engine.readRequestEffects(id), refusals,
      guard: [await engine.lockEffectGuard(null), await engine.lockEffectGuard('f0000000-0000-4000-8000-0000000000ff')] };
    expect(answers.none).toBeNull();
    expect(answers.renewed).toEqual({ stale: false, nullToken: false, held: true });
    expect(answers.effects).toEqual([
      { kind: 'embedding', state: 'committed', error_code: null, outcome: { embedding: 'skipped', reason: 'parity' }, recovering: false },
      { kind: 'git', state: 'failed', error_code: 'targets_parked', outcome: null, recovering: false },
      { kind: 'links', state: 'failed', error_code: 'parity_failed', outcome: null, recovering: false }]);
    expect(answers.refusals).toEqual(['invalid input syntax for type uuid', 'invalid input syntax for type uuid', 'invalid input syntax for type uuid']);
    expect(answers.guard).toEqual([null, null]);
    return answers;
  });

  parityTest('a target parked behind the withdrawal mirror is re-armable once that mirror commits, and only then', {
    methods: ['hasRearmableTargets', 'selectClaimableEffect', 'stampEffectClaim', 'completeEffectRow', 'insertPublicationEffects', 'transactionDirect',
      'declarePersistence', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const id = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b4');
    const parked = (code: string) => [{ slug: 'notes/parity', error_code: code }];
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'withdrawal-mirror', data: { slugs: ['notes/parity'] } }, { kind: 'git', data: { relative_path: 'notes/parity.md', parked: parked('withdrawal_mirror_failed') } },
          { kind: 'links', data: { slug: 'notes/parity', parked: parked('withdrawal_mirror_failed') } }] });
    });
    const probe = () => engine.hasRearmableTargets([id], 'withdrawal_mirror_failed');
    const before = await probe();
    const mirror = await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      const candidate = await tx.selectClaimableEffect<{ id: string | number; kind: string }>(HOST, []);
      return tx.stampEffectClaim<{ id: string | number; kind: string; execution_token: string }>({ id: candidate!.id, token: 'f0000000-0000-4000-8000-0000000000c1', ownerJson: '{}' });
    });
    await engine.completeEffectRow({ id: mirror!.id, token: mirror!.execution_token, outcomeJson: '{}' });
    const refusals: string[] = [];
    try { await engine.hasRearmableTargets(['not-a-uuid'], 'x'); refusals.push('ok'); } catch (e) { refusals.push(/invalid input syntax for type uuid/.exec(String((e as Error).message))?.[0] ?? String(e)); }
    const answers = { mirrorKind: mirror!.kind, before, after: await probe(), otherCode: await engine.hasRearmableTargets([id], 'some_other_code'),
      otherRequest: await engine.hasRearmableTargets(['b0000000-0000-4000-8000-0000000000ff'], 'withdrawal_mirror_failed'), refusals };
    expect(answers).toEqual({ mirrorKind: 'withdrawal-mirror', before: false, after: true, otherCode: false, otherRequest: false, refusals: ['invalid input syntax for type uuid'] });
    return answers;
  });

  parityTest('the idle probe sees a queued write and an effect, and an excluded root hides the write', {
    methods: ['probeIdleWork', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'insertPublicationEffects', 'transactionDirect', 'declarePersistence'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const spec = (excludedRoots: string[] = []) => ({ hostId: HOST, excludedRoots, publishing: false, retryingTopologies: [], laneRoots: [],
      cursor: { after: { source_incarnation: incarnation, slug: '' }, highWater: null }, abandonedBefore: null, foregroundPriority: null });
    const probe = async (excludedRoots?: string[]) => {
      const row = await engine.probeIdleWork(spec(excludedRoots));
      return row && { work: row.work, projection_work: row.projection_work, projection_last: row.projection_last };
    };
    const empty = await probe();
    const id = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b5');
    const queued = await probe();
    const excluded = await probe([`db:${incarnation}`]);
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'withdrawal-mirror', data: { slugs: ['notes/parity'] } }] });
    });
    const effect = await probe([`db:${incarnation}`]);
    const answers = { empty, queued, excluded, effect };
    const idle = { work: false, projection_work: false, projection_last: null };
    expect(answers).toEqual({ empty: idle, queued: { ...idle, work: true }, excluded: idle, effect: { ...idle, work: true } });
    return answers;
  });

  parityTest('the no-op embedding settle finds a queued effect whose page already carries current vectors and settles it once', {
    methods: ['probeNoopEmbeddingSettle', 'lockNoopEmbeddingWindow', 'readNoopEmbeddingCandidates', 'settleNoopEmbeddingRows', 'putPage', 'sealChunks',
      'setPageEmbeddingSignature', 'getPage', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'insertPublicationEffects',
      'transactionDirect', 'declarePersistence', 'readRequestEffects'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    await engine.putPage('notes/settle', { type: 'note', title: 'Settle', compiled_truth: 'settle body', timeline: '' });
    await installChunks(engine, 'notes/settle', [chunk(0, 'settle body', { embedding: basisEmbedding(3), model: 'model-a' })]);
    await engine.setPageEmbeddingSignature('notes/settle', { signature: 'sig-a' });
    const page = (await engine.getPage('notes/settle'))!;
    const requestId = 'b0000000-0000-4000-8000-0000000000b6';
    const empty = await engine.probeNoopEmbeddingSettle('0');
    const id = await admitDirect(engine, requestId);
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: id, revision: page.knowledge_revision!, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'embedding', data: { page_id: page.id } }] });
    });
    const due = await engine.probeNoopEmbeddingSettle('0');
    const candidates = (spec: { signature?: string; expectedModel?: string | null } = {}) => engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      const { newest, rows } = await tx.lockNoopEmbeddingWindow({ from: '0', limit: 50 });
      const found = await tx.readNoopEmbeddingCandidates({ hostId: HOST, signature: spec.signature ?? 'sig-a',
        expectedModel: spec.expectedModel === undefined ? 'model-a' : spec.expectedModel, column: 'embedding', window: rows.map(row => row.id),
        pageIds: rows.flatMap(row => row.page_id === null ? [] : [row.page_id]) });
      return { newestIsLast: newest === rows[rows.length - 1]?.id, pages: rows.map(row => row.page_id === page.id), found: found.map(c => ({ kind: c.kind, source_id: c.source_id, worktree_id: c.worktree_id, effect: c.id === rows[0]?.id })) };
    });
    const wrongSignature = await candidates({ signature: 'sig-b' });
    const wrongModel = await candidates({ expectedModel: 'model-b' });
    const noModel = await candidates({ expectedModel: null });
    const window = await candidates();
    const settle = () => engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      const { rows } = await tx.lockNoopEmbeddingWindow({ from: '0', limit: 50 });
      return (await tx.settleNoopEmbeddingRows(rows.map(row => row.id))).map(row => row.request_id);
    });
    const settled = await settle();
    const again = await settle();
    const after = await engine.probeNoopEmbeddingSettle('0');
    const effects = (await engine.readRequestEffects(id)).map(e => ({ kind: e.kind, state: e.state, error_code: e.error_code, outcome: e.outcome }));
    const answers = { empty, due, wrongSignature, wrongModel, noModel, window, settled: settled.map(r => r === id), again, after, effects };
    const none = { newestIsLast: true, pages: [true], found: [] };
    expect(answers).toEqual({ empty: false, due: true, wrongSignature: none, wrongModel: none, noModel: none,
      window: { newestIsLast: true, pages: [true], found: [{ kind: 'embedding', source_id: 'default', worktree_id: null, effect: true }] },
      settled: [true], again: [], after: false, effects: [{ kind: 'embedding', state: 'committed', error_code: null, outcome: {} }] });
    return answers;
  });

  parityTest('completeWrite with no lock held asks for synchronous commit, declares, locks and ends the claimed request', {
    methods: ['requireSynchronousCommit', 'declarePersistence', 'transaction', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest',
      'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow', 'readWriteRequestById'],
  }, async (engine) => {
    const id = await admitDirect(engine);
    const claimed = await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const done = await engine.transaction((tx) => completeWrite(tx, claimed as WriteRequest, 'failed', { status: 'parity' }, { code: 'parity_error', message: 'parity' }));
    const outside = await engine.requireSynchronousCommit();
    const stored = view(await engine.readWriteRequestById(id));
    const released = counters(await engine.lockPersistenceCounters(KEYS));
    const result = { done: view(done), stored, outside: outside ?? null, released: released.brain };
    expect(result.done).toMatchObject({ state: 'failed', errorCode: 'parity_error', completed: true });
    expect(result.stored).toEqual(result.done);
    expect(result.released).toMatchObject({ outstanding: 0, intentBytes: 0, lifetimeIds: 1 });
    return result;
  });

  parityTest('renewWriteClaim extends a claim held under its token and refuses any other token', { methods: ['renewWriteClaim', 'stampWriteClaim', 'readWriteRequestById'] }, async (engine) => {
    const id = await admitDirect(engine);
    await engine.stampWriteClaim(id, TOKEN, 1_000, JSON.stringify({ phase: 'preparing', token: TOKEN }));
    const before = await engine.readWriteRequestById(id);
    const held = await engine.renewWriteClaim({ id, token: TOKEN, leaseMs: 3_600_000, phaseJson: JSON.stringify({ phase: 'publishing', token: TOKEN }) });
    const renewed = await engine.readWriteRequestById(id);
    const keptPhase = await engine.renewWriteClaim({ id, token: TOKEN, leaseMs: 3_600_000, phaseJson: null });
    const kept = await engine.readWriteRequestById(id);
    const stranger = await engine.renewWriteClaim({ id, token: OTHER_TOKEN, leaseMs: 3_600_000, phaseJson: null });
    const unknown = await engine.renewWriteClaim({ id: 'a0000000-0000-4000-8000-0000000000a9', token: TOKEN, leaseMs: 1_000, phaseJson: null });
    const extended = new Date(renewed!.claim_expires_at!).getTime() - new Date(before!.claim_expires_at!).getTime() > 3_000_000;
    const answers = { held, phase: renewed?.claim_phase, keptPhase, keptPhaseValue: kept?.claim_phase, stranger, unknown, extended };
    expect(answers).toMatchObject({ held: true, phase: { phase: 'publishing' }, keptPhase: true, keptPhaseValue: { phase: 'publishing' }, stranger: false, unknown: false, extended: true });
    return answers;
  });

  parityTest('releaseUnpublishedClaim returns a claim to queued under its token so the writer claims it again', { methods: ['releaseUnpublishedClaim', 'stampWriteClaim', 'readWriteRequestById'] }, async (engine) => {
    const id = await admitDirect(engine);
    const pick = (row: Record<string, unknown> | null) => row && ({ state: row.state, token: row.execution_token ?? null, lease: row.claim_expires_at ?? null,
      blocked: row.blocked_reason ?? null, attempts: Number(row.preparation_attempts), phase: row.claim_phase ?? null });
    const first = await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'preparing', token: TOKEN }));
    // A release under another token changes nothing: the claim is still this writer's.
    await releaseUnpublishedClaim(engine, { ...(first as WriteRequest), execution_token: OTHER_TOKEN }, 'claim_lost');
    const strangerRow = pick(await engine.readWriteRequestById(id) as Record<string, unknown> | null);
    const stranger = strangerRow && { state: strangerRow.state, token: strangerRow.token, leased: strangerRow.lease !== null };
    // A transient failure (a lock timeout) releases the claim uncharged: queued, no token, no lease, no phase.
    await releaseUnpublishedClaim(engine, first as WriteRequest, 'database_contention');
    const released = pick(await engine.readWriteRequestById(id) as Record<string, unknown> | null);
    // The writer retries it: a second claim takes it, and a charged release counts one attempt and keeps the phase.
    const retry = await engine.stampWriteClaim(id, OTHER_TOKEN, 60_000, JSON.stringify({ phase: 'preparing', token: OTHER_TOKEN }));
    await releaseUnpublishedClaim(engine, retry as WriteRequest, 'preparation_deadline', { charge: true });
    const charged = pick(await engine.readWriteRequestById(id) as Record<string, unknown> | null);
    const result = { stranger, released, retried: (retry as WriteRequest | null)?.state ?? null, charged };
    expect(result).toEqual({
      stranger: { state: 'running', token: TOKEN, leased: true },
      released: { state: 'queued', token: null, lease: null, blocked: 'database_contention', attempts: 0, phase: null },
      retried: 'running',
      charged: { state: 'queued', token: null, lease: null, blocked: 'preparation_deadline', attempts: 1, phase: { phase: 'preparing', token: OTHER_TOKEN } },
    });
    return result;
  });

  parityTest('expireStaleWriteClaims returns an expired claim to queued, charges a preparing one when asked, and frees a dead owner\'s claim', {
    methods: ['expireStaleWriteClaims', 'stampWriteClaim', 'readWriteRequestById', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const expired = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const live = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const dead = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3');
    await engine.stampWriteClaim(expired, TOKEN, -60_000, JSON.stringify({ phase: 'preparing', token: TOKEN }));
    await engine.stampWriteClaim(live, OTHER_TOKEN, 3_600_000, JSON.stringify({ phase: 'preparing', token: OTHER_TOKEN }));
    const deadToken = 'c0000000-0000-4000-8000-0000000000c3';
    await engine.stampWriteClaim(dead, deadToken, 3_600_000, JSON.stringify({ phase: 'publishing', token: deadToken, owner: { pid: 4242, nonce: 'n1', start: 's1' } }));
    await engine.expireStaleWriteClaims({ hostId: HOST, charge: true, deadOwners: [] });
    const afterExpiry = await Promise.all([expired, live, dead].map(id => engine.readWriteRequestById(id)));
    await engine.expireStaleWriteClaims({ hostId: HOST, charge: true, deadOwners: ['4242:n1:s1'] });
    const afterDead = await engine.readWriteRequestById(dead);
    const state = (r: WriteRequest | null) => r && { state: r.state, token: r.execution_token ?? null, leased: r.claim_expires_at != null, attempts: Number(r.preparation_attempts) };
    const answers = { afterExpiry: afterExpiry.map(state), afterDead: state(afterDead) };
    expect(answers).toEqual({
      afterExpiry: [{ state: 'queued', token: null, leased: false, attempts: 1 }, { state: 'running', token: OTHER_TOKEN, leased: true, attempts: 0 },
        { state: 'running', token: deadToken, leased: true, attempts: 0 }],
      afterDead: { state: 'queued', token: null, leased: false, attempts: 0 },
    });
    return answers;
  });
});

/** Admits a queued request and completes it as committed outside a transaction; returns its journal id. */
async function completeDirect(engine: BrainEngine, requestId: string): Promise<string> {
  return completeAdmitted(engine, await admitDirect(engine, requestId));
}

/** Completes an admitted request as committed outside a transaction; returns its journal id. */
async function completeAdmitted(engine: BrainEngine, id: string): Promise<string> {
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  await engine.completeWriteRow({
    id, state: 'committed', outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: 'parity',
    consumerHostId: null, errorDetail: null, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
    terminalReservation: 4096, probePurges: false,
  });
  return id;
}

const TURN = { op: 'parity-housekeeping', hostId: HOST, leaseMs: 3_600_000, consumerKinds: ['serve', 'sync', 'jobs', 'autopilot', 'mcp'], consumerLiveMs: 30_000 };

describe('engine parity: write-journal housekeeping', () => {
  parityTest('claimHousekeepingTurn leases a free turn once, and completeHousekeepingTurn frees it after its interval', {
    methods: ['claimHousekeepingTurn', 'completeHousekeepingTurn'],
  }, async (engine) => {
    const first = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: 3_600_000 });
    const leased = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: 3_600_000 });
    const otherHost = await engine.claimHousekeepingTurn({ ...TURN, hostId: 'e0000000-0000-4000-8000-0000000000e2', intervalMs: 3_600_000 });
    await engine.completeHousekeepingTurn({ op: TURN.op, hostId: HOST });
    const inInterval = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: 3_600_000 });
    const afterInterval = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: -60_000 });
    const answers = { first, leased, otherHost, inInterval, afterInterval };
    expect(answers).toEqual({ first: true, leased: false, otherHost: true, inInterval: false, afterInterval: true });
    return answers;
  });

  parityTest('readReceiptBudget reads the retention setting, the brain\'s reserved terminal bytes and the cutoff', {
    methods: ['readReceiptBudget', 'setConfig', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const unset = await engine.readReceiptBudget('persistence.receipts.parity_retention_days', 30);
    await engine.setConfig('persistence.receipts.parity_retention_days', '45');
    await admitDirect(engine);
    const set = await engine.readReceiptBudget('persistence.receipts.parity_retention_days', 30);
    const cutoffShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
    const days = (Date.now() - Date.parse(set.cutoff)) / 86_400_000;
    const answers = { unsetRetention: unset.retention, retention: set.retention, used: Number(set.used), cutoffShape: cutoffShape.test(set.cutoff), cutoffDays: Math.round(days) };
    expect(answers).toEqual({ unsetRetention: null, retention: '45', used: 4096, cutoffShape: true, cutoffDays: 30 });
    return answers;
  });

  parityTest('listReservationsAfter walks the journal in sequence order past a cursor', {
    methods: ['listReservationsAfter', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const ids = [await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1'), await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2'),
      await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3')];
    const all = await engine.listReservationsAfter('0', 10);
    const firstTwo = await engine.listReservationsAfter('0', 2);
    const rest = await engine.listReservationsAfter(firstTwo.at(-1)!.sequence, 10);
    const ascending = all.every((r, i) => i === 0 || BigInt(r.sequence) > BigInt(all[i - 1]!.sequence));
    const answers = { all: all.map(r => ids.indexOf(r.id)), compacted: all.map(r => r.compacted), firstTwo: firstTwo.map(r => ids.indexOf(r.id)),
      rest: rest.map(r => ids.indexOf(r.id)), ascending, sequenceIsText: all.every(r => typeof r.sequence === 'string') };
    expect(answers).toEqual({ all: [0, 1, 2], compacted: [false, false, false], firstTwo: [0, 1], rest: [2], ascending: true, sequenceIsText: true });
    return answers;
  });

  parityTest('listTrueUpRequests returns only the terminal requests asked for, with their effect bytes', {
    methods: ['listTrueUpRequests', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const done = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const queued = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const rows = await engine.listTrueUpRequests<Record<string, unknown>>([done, queued, 'a0000000-0000-4000-8000-0000000000a9']);
    const none = await engine.listTrueUpRequests([]);
    const answers = { rows: rows.map(r => ({ done: r.id === done, principal: `${r.principal_kind}:${r.principal_id}`, outcome: r.outcome, authority: r.authority,
      terminalReservation: Number(r.terminal_reservation), compacted: r.compacted, effectBytes: r.effect_bytes, unfinished: r.unfinished })), none };
    expect(answers).toEqual({ rows: [{ done: true, principal: 'local_cli:parity-writer', outcome: { status: 'parity' }, authority: { scopes: ['write'] },
      terminalReservation: 800, compacted: false, effectBytes: '0', unfinished: false }], none: [] });
    return answers;
  });

  parityTest('trueUpReservations shrinks a settled request once, skips a stale or unsettled one, and releases the freed bytes', {
    methods: ['trueUpReservations', 'listTrueUpRequests', 'transaction', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'readCounterRows',
      'getConfig', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const settled = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const pending = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      await tx.insertPublicationEffects({ requestId: pending, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'embedding', data: { slug: 'notes/parity', page_id: 1 } }] });
    });
    await completeAdmitted(engine, pending);
    const listed = await engine.listTrueUpRequests<{ id: string; terminal_reservation: string | number; effect_bytes: string; unfinished: boolean }>([settled, pending]);
    const pendingBytes = listed.find(r => r.id === pending)!.effect_bytes;
    const trueUp = (rows: Array<{ id: string; old: number; kept: number; effects: string }>) => engine.transaction(async tx => {
      await tx.declarePersistence();
      await tx.lockPersistenceCounters(KEYS);
      return tx.trueUpReservations(rows);
    });
    const terminal = async () => Object.fromEntries(Object.entries(counters(await engine.readCounterRows(KEYS))).map(([k, v]) => [k, v.terminalBytes]));
    const before = await terminal();
    const stale = await trueUp([{ id: settled, old: 4096, kept: 300, effects: '0' }]);
    const effectsChanged = await trueUp([{ id: settled, old: 800, kept: 300, effects: '5' }]);
    const unsettled = await trueUp([{ id: pending, old: 4096, kept: 300, effects: pendingBytes }]);
    const unknown = await trueUp([{ id: 'a0000000-0000-4000-8000-0000000000a9', old: 800, kept: 300, effects: '0' }]);
    const shrunk = await trueUp([{ id: settled, old: 800, kept: 300, effects: '0' }]);
    const again = await trueUp([{ id: settled, old: 800, kept: 300, effects: '0' }]);
    const none = await trueUp([]);
    const after = await engine.listTrueUpRequests<{ id: string; terminal_reservation: string | number }>([settled, pending]);
    const answers = {
      listed: listed.map(r => ({ settled: r.id === settled, reservation: Number(r.terminal_reservation), effectBytes: r.effect_bytes, unfinished: r.unfinished }))
        .sort((a, b) => Number(b.settled) - Number(a.settled)),
      pendingBytesOverFloor: Number(pendingBytes) > 1024, before, stale, effectsChanged, unsettled, unknown, shrunk, again, none,
      reservations: after.map(r => ({ settled: r.id === settled, reservation: Number(r.terminal_reservation) })).sort((a, b) => Number(b.settled) - Number(a.settled)), counters: await terminal(),
      clamped: await engine.getConfig('persistence.true_up.clamped'),
    };
    expect(answers).toEqual({
      listed: [{ settled: true, reservation: 800, effectBytes: '0', unfinished: false }, { settled: false, reservation: 4096, effectBytes: pendingBytes, unfinished: true }],
      pendingBytesOverFloor: true, before: { 'principal:local_cli:parity-writer': 4896, brain: 4896 }, stale: 0, effectsChanged: 0, unsettled: 0, unknown: 0,
      shrunk: 500, again: 0, none: 0, reservations: [{ settled: true, reservation: 300 }, { settled: false, reservation: 4096 }],
      counters: { 'principal:local_cli:parity-writer': 4396, brain: 4396 }, clamped: null,
    });
    return answers;
  });

  parityTest('listCompactableReceipts lists finished receipts older than the retention, oldest first', {
    methods: ['listCompactableReceipts', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const first = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const second = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3');
    const retained = await engine.listCompactableReceipts<{ id: string }>(30);
    const due = await engine.listCompactableReceipts<{ id: string; state: string }>(-1);
    const answers = { retained: retained.length, due: due.map(r => ({ which: [first, second].indexOf(r.id), state: r.state })) };
    expect(answers).toEqual({ retained: 0, due: [{ which: 0, state: 'committed' }, { which: 1, state: 'committed' }] });
    return answers;
  });

  parityTest('readCapacityForecastInputs buckets the window per writer and day, with the history and what compaction frees', {
    methods: ['readCapacityForecastInputs', 'readLedgerSource', 'insertTopologyChange', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const empty = await engine.readCapacityForecastInputs({ light: true });
    const first = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const full = await engine.readCapacityForecastInputs();
    const light = await engine.readCapacityForecastInputs({ light: true });
    const day = new Date().toISOString().slice(0, 10);
    const days = (inputs: typeof full) => inputs.days.map(d => ({ ...d, today: d.day === day, day: undefined })).sort((a, b) => a.scope.localeCompare(b.scope));
    const answers = {
      emptyDays: empty.days, emptyHistory: empty.history && { ...empty.history, age_days: empty.history.age_days === null ? null : 'set' },
      counters: full.counters.map(c => ({ key: c.key, lifetimeIds: c.lifetime_ids })),
      days: days(full),
      history: full.history && { firstIsOldest: full.history.first_id === first, ageDays: Math.round(full.history.age_days ?? -1), compactionAgeDays: Math.round(full.history.compaction_age_days ?? -1) },
      reclaimScopes: full.reclaim.map(r => r.scope),
      lightReclaim: light.reclaim, lightTableBytes: light.tableBytes, lightDays: days(light),
    };
    expect(answers).toMatchObject({
      emptyDays: [], counters: [{ key: 'brain', lifetimeIds: '2' }, { key: 'principal:local_cli:parity-writer', lifetimeIds: '2' }],
      history: { firstIsOldest: true, ageDays: 0, compactionAgeDays: 0 }, reclaimScopes: ['principal:local_cli:parity-writer'], lightReclaim: [], lightTableBytes: null,
    });
    expect(answers.days.map(d => [d.scope, d.ids, d.gross, d.recent_ids, d.today])).toEqual([
      ['principal:local_cli:d0000000-0000-4000-8000-0000000000d1', '1', '4096', '1', true],
      ['principal:local_cli:parity-writer', '2', '4896', '2', true],
    ]);
    expect(answers.lightDays).toEqual(answers.days);
    return answers;
  });

  parityTest('readCapacityForecastInputs lists the counters in byte order of their keys, whatever the server locale', {
    methods: ['readCapacityForecastInputs', 'lockPersistenceCounters'],
  }, async (engine) => {
    // en_US.utf8 sorts a before B and ignores the punctuation of 'a-b' against 'ab'; byte order puts B first and '-' before 'b'.
    const keys = ['principal:local_cli:ab', 'principal:local_cli:a', 'principal:local_cli:B', 'principal:local_cli:a-b', 'brain'];
    await engine.lockPersistenceCounters(keys);
    const read = (await engine.readCapacityForecastInputs({ light: true })).counters.map(c => c.key);
    expect(read).toEqual(['brain', 'principal:local_cli:B', 'principal:local_cli:a', 'principal:local_cli:a-b', 'principal:local_cli:ab']);
    return read;
  });

  parityTest('page writes queue, re-queue and drop projection jobs, and the window read lists them in key order', {
    methods: ['putPage', 'sealChunks', 'softDeletePage', 'deletePage', 'restorePage', 'updateSlug', 'readPageSnapshot', 'readSourceMembership',
      'listPendingSegmentedProjections', 'selectProjectionWindowJobs'],
  }, async (engine) => {
    const page = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `${slug} body` });
    for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e']) await engine.putPage(slug, page(slug));
    // The same text again keeps the revision, so the job stays as it is.
    await engine.putPage('notes/a', page('notes/a'));
    await engine.sealChunks('notes/e', [{ chunk_index: 0, chunk_text: 'notes/e body', chunk_source: 'compiled_truth' }]);
    await engine.softDeletePage('notes/c');
    await engine.deletePage('notes/d');
    await engine.restorePage('notes/c');
    await engine.updateSlug('notes/b', 'notes/b2');
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const revisions = new Map<string, string>();
    for (const slug of ['notes/a', 'notes/b2', 'notes/c']) revisions.set(slug, (await engine.readPageSnapshot(slug))!.revision);
    const TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;
    const rows = (all: Awaited<ReturnType<BrainEngine['selectProjectionWindowJobs']>>) => all.map(r => ({
      lane: r.lane, ord: r.ord === null ? null : Number(r.ord), ordType: typeof r.ord, slug: r.slug,
      inc: r.source_incarnation === null ? null : r.source_incarnation === incarnation,
      revision: r.revision === null ? null : r.revision === revisions.get(r.slug ?? ''), highWater: r.high_water === null ? null : TS.test(r.high_water),
    })).sort((x, y) => (x.lane ?? '').localeCompare(y.lane ?? '') || (x.ord ?? 0) - (y.ord ?? 0) || (x.slug ?? '').localeCompare(y.slug ?? ''));
    const start = { after: { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, highWater: null };
    const first = await engine.selectProjectionWindowJobs(start, true);
    const highWater = first[0]!.high_water!;
    const wrapped = await engine.selectProjectionWindowJobs({ after: { source_incarnation: incarnation, slug: 'notes/a' }, highWater }, false);
    const later = await engine.selectProjectionWindowJobs({ ...start, highWater: '2999-01-01 00:00:00+00' }, true);
    const pending = await engine.listPendingSegmentedProjections({ limit: 10 });
    const anyPending = await engine.listPendingSegmentedProjections({ limit: 10, retryCooldown: false });
    const answers = { first: rows(first), wrapped: rows(wrapped), later: rows(later), pending, anyPending };
    const row = (lane: string, ord: number, slug: string) => ({ lane, ord, ordType: 'number' as const, slug, inc: true, revision: true, highWater: true });
    expect(answers).toEqual({
      first: [row('recent', 0, 'notes/a'), row('recent', 0, 'notes/b2'), row('recent', 0, 'notes/c'),
        row('window', 1, 'notes/a'), row('window', 2, 'notes/b2'), row('window', 3, 'notes/c')],
      wrapped: [row('recent', 0, 'notes/a'), row('recent', 0, 'notes/b2'), row('recent', 0, 'notes/c'),
        row('window', 1, 'notes/b2'), row('window', 2, 'notes/c'), row('window', 3, 'notes/a')],
      later: [row('window', 1, 'notes/a'), row('window', 2, 'notes/b2'), row('window', 3, 'notes/c')],
      pending: [], anyPending: [],
    });
    return answers;
  });

  parityTest('many writes to one page keep one projection job at its last revision, and sealing drains every job', {
    methods: ['putPage', 'sealChunks', 'readPageSnapshot', 'readSourceMembership', 'listPendingSegmentedProjections',
      'selectProjectionWindowJobs', 'countPendingProjectionPages', 'projectionRebuildProgress'],
  }, async (engine) => {
    const ALL: CoverageRelevance = { all: true, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false };
    const body = (slug: string, n: number) => `${slug} body ${n}`;
    const many = Array.from({ length: 8 }, (_, i) => `notes/many-${i}`);
    // Five changes to one page, the last one twice (the repeat keeps the revision), then one write to each of many pages.
    for (let n = 0; n < 5; n++) await engine.putPage('notes/hot', { type: 'note', title: 'hot', compiled_truth: body('notes/hot', n) });
    await engine.putPage('notes/hot', { type: 'note', title: 'hot', compiled_truth: body('notes/hot', 4) });
    for (const slug of many) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body(slug, 0) });
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const slugs = ['notes/hot', ...many];
    const revisions = new Map<string, string>();
    for (const slug of slugs) revisions.set(slug, (await engine.readPageSnapshot(slug))!.revision);
    const TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;
    const rows = (all: Awaited<ReturnType<BrainEngine['selectProjectionWindowJobs']>>) => all.map(r => ({
      lane: r.lane, ord: r.ord === null ? null : Number(r.ord), slug: r.slug,
      inc: r.source_incarnation === null ? null : r.source_incarnation === incarnation,
      revision: r.revision === null ? null : r.revision === revisions.get(r.slug ?? ''), highWater: r.high_water === null ? null : TS.test(r.high_water),
    })).sort((x, y) => (x.lane ?? '').localeCompare(y.lane ?? '') || (x.ord ?? 0) - (y.ord ?? 0) || (x.slug ?? '').localeCompare(y.slug ?? ''));
    const start = { after: { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, highWater: null };
    const reads = async () => ({
      window: rows(await engine.selectProjectionWindowJobs(start, true)),
      anyWindow: rows(await engine.selectProjectionWindowJobs(start, false)),
      pending: await engine.listPendingSegmentedProjections({ limit: 50, retryCooldown: false }),
      count: await countPendingProjections(engine, {}, ALL),
      rebuild: await countProjectionRebuild(engine, {}),
    });
    const queued = await reads();
    // The drain: sealing each page at its current revision drops its job.
    for (const slug of slugs) {
      const n = slug === 'notes/hot' ? 4 : 0;
      await installChunks(engine, slug, [chunk(0, body(slug, n))]);
    }
    const drained = await reads();
    const answers = { queued, drained };
    const sorted = [...slugs].sort();
    const row = (lane: string, ord: number, slug: string) => ({ lane, ord, slug, inc: true, revision: true, highWater: true });
    expect(answers.queued.window).toEqual([...sorted.map(slug => row('recent', 0, slug)), ...sorted.map((slug, i) => row('window', i + 1, slug))]);
    expect(answers.queued.count).toMatchObject({ total: 9 });
    const nulls = [{ lane: null, ord: null, slug: null, inc: null, revision: null, highWater: null }];
    expect(answers.drained.window).toEqual(nulls);
    expect(answers.drained.count).toMatchObject({ total: 0 });
    return answers;
  });

  parityTest('the window read walks the queue in byte order of slug from any cursor, whatever the server locale', {
    methods: ['putPage', 'readSourceMembership', 'selectProjectionWindowJobs'],
  }, async (engine) => {
    // Slugs are lower case. en_US.utf8 ignores the punctuation of 'a-b' and 'a_b' (so 'a1' sorts before them); byte order is a, a-b, a1, a_b, ab.
    const bytes = ['notes/a', 'notes/a-b', 'notes/a1', 'notes/a_b', 'notes/ab'];
    for (const slug of ['notes/ab', 'notes/a_b', 'notes/a1', 'notes/a', 'notes/a-b']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body` });
    }
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const window = async (afterSlug: string) => (await engine.selectProjectionWindowJobs({ after: { source_incarnation: incarnation, slug: afterSlug }, highWater: null }, false))
      .filter(r => r.lane === 'window').sort((x, y) => Number(x.ord) - Number(y.ord)).map(r => r.slug);
    // From each slug the window lists the later slugs in byte order, then wraps to the start: no job skipped or repeated.
    const walks: Record<string, Array<string | null>> = {};
    for (const slug of bytes) walks[slug] = await window(slug);
    walks[''] = await window('');
    const expected: Record<string, string[]> = { '': bytes };
    for (const [i, slug] of bytes.entries()) expected[slug] = [...bytes.slice(i + 1), ...bytes.slice(0, i + 1)];
    expect(walks).toEqual(expected);
    return walks;
  });

  parityTest('the projector claims, renews, releases, fails and deletes a queued job, one live claim at a time', {
    methods: ['putPage', 'readPageSnapshot', 'readSourceMembership', 'selectProjectionWindowJobs', 'claimSegmentedProjection',
      'renewSegmentedProjectionClaim', 'releaseSegmentedProjectionClaim', 'deleteProjectionJob', 'markProjectionRebuildFailed'],
  }, async (engine) => {
    await engine.putPage('notes/a', { type: 'note', title: 'a', compiled_truth: 'notes/a body' });
    const ref = { sourceId: 'default', slug: 'notes/a' };
    const job = { sourceIncarnation: (await engine.readSourceMembership('default'))!.incarnation, slug: 'notes/a',
      revision: (await engine.readPageSnapshot('notes/a'))!.revision };
    const other = { ...job, revision: '00000000-0000-4000-8000-000000000000' };
    const start = { after: { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, highWater: null };
    // Whether the job is in the window: with the retry cooldown (hides claimed and freshly failed jobs) and without it (lists every job).
    const seen = async () => ({
      cooldown: (await engine.selectProjectionWindowJobs(start, true)).some(r => r.lane === 'window' && r.slug === 'notes/a'),
      any: (await engine.selectProjectionWindowJobs(start, false)).some(r => r.lane === 'window' && r.slug === 'notes/a'),
    });
    const [a, b] = ['segmented_projecting:a', 'segmented_projecting:b'];
    const answers: Record<string, unknown> = {};
    answers.noPage = await engine.claimSegmentedProjection({ sourceId: 'default', slug: 'notes/none' }, a);
    answers.noSource = await engine.claimSegmentedProjection({ sourceId: 'no-such-source', slug: 'notes/a' }, a);
    answers.queued = await seen();
    answers.claim = await engine.claimSegmentedProjection(ref, a);
    answers.claimed = await seen();
    answers.second = await engine.claimSegmentedProjection(ref, b);
    answers.renewOther = await engine.renewSegmentedProjectionClaim(ref, b);
    answers.renew = await engine.renewSegmentedProjectionClaim(ref, a);
    answers.renewInTx = await engine.transaction(tx => tx.renewSegmentedProjectionClaim(ref, a));
    await engine.releaseSegmentedProjectionClaim(ref, b);
    answers.afterOtherRelease = await seen();
    // A live claim keeps the failed mark off.
    await engine.markProjectionRebuildFailed(job);
    answers.failWhileClaimed = await seen();
    await engine.releaseSegmentedProjectionClaim(ref, a);
    answers.released = await seen();
    await engine.markProjectionRebuildFailed(other);
    answers.failOtherRevision = await seen();
    await engine.markProjectionRebuildFailed(job);
    answers.failed = await seen();
    answers.reclaim = await engine.claimSegmentedProjection(ref, b);
    await engine.releaseSegmentedProjectionClaim(ref, b);
    await engine.deleteProjectionJob(other);
    answers.deleteOtherRevision = await seen();
    await engine.deleteProjectionJob(job);
    answers.deleted = await seen();
    answers.afterDelete = await engine.claimSegmentedProjection(ref, a);
    const both = { cooldown: true, any: true }, held = { cooldown: false, any: true }, none = { cooldown: false, any: false };
    expect(answers).toEqual({
      noPage: 'absent', noSource: 'absent', queued: both, claim: 'claimed', claimed: held, second: 'held', renewOther: false, renew: true,
      renewInTx: true, afterOtherRelease: held, failWhileClaimed: held, released: both, failOtherRevision: both,
      failed: held, reclaim: 'claimed', deleteOtherRevision: both, deleted: none, afterDelete: 'absent',
    });
    return answers;
  });

  parityTest('the projection queue reads find no pending job on a brain whose pages are projected', {
    methods: ['listPendingSegmentedProjections', 'selectProjectionWindowJobs'],
  }, async (engine) => {
    const pending = await engine.listPendingSegmentedProjections({ limit: 10 });
    const cooldownOff = await engine.listPendingSegmentedProjections({ limit: 10, retryCooldown: false, reasons: ['segmented_projecting'], exclude: ['x/y'] });
    const cursor = { after: { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, highWater: null };
    const window = await engine.selectProjectionWindowJobs(cursor, true);
    const anyWindow = await engine.selectProjectionWindowJobs(cursor, false);
    const nulls = [{ lane: null, ord: null, source_incarnation: null, slug: null, revision: null, high_water: null }];
    const answers = { pending, cooldownOff, window, anyWindow };
    expect(answers).toEqual({ pending: [], cooldownOff: [], window: nulls, anyWindow: nulls });
    return answers;
  });
});
