/**
 * BrainEngine parity — the bookkeeping repair kinds on seeded brains (batch 2 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain repair` connector-checkpoints, orphan-bindings, loop-facts, managed-sync-orphans and
 *    content-receipt-root give the same preview and the same apply result on PGLite, Postgres (DATABASE_URL) and the
 *    Rust engine (GBRAIN_TEST_RUST_ARM=1), on a brain seeded with the rows each kind reads, and the rows the apply
 *    leaves read the same afterwards.
 *  - Regression: each kind read its rows (sources, op_checkpoints, persistence bindings, open loops) through
 *    `executeRaw`, which a Rust brain refuses, so every one of them stopped before its first read there.
 *  - Why existing coverage misses it: the kinds' own tests (test/repair-*.test.ts, test/persistence-*.test.ts,
 *    test/connector-checkpoint-identity.test.ts, test/loops-close-fact.serial.test.ts) run on PGLite or Postgres
 *    only, and the runner's parity file (repair-runner.test.ts) previews these kinds on empty brains only.
 *  - Seam: none. Rows go in through typed writers (orphan bindings through the claim store). Generated values (run ids,
 *    the brain id, incarnations, ids, timestamps) are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { connectorCheckpointKeys, connectorIdentity } from '../../src/core/persistence/connector-identity.ts';
import {
  aliasProtectedConnectorCheckpoints, deleteOrphanConnectorCheckpoints, loadableConnectorKeys, orphanConnectorCheckpoints,
} from '../../src/core/persistence/connector-checkpoint-migration.ts';
import { CONNECTOR_STATE_OP } from '../../src/core/persistence/connector-state.ts';
import { deleteOrphanBinding, listOrphanBindings } from '../../src/core/persistence/orphan-bindings.ts';
import { classifyManagedSyncOrphans } from '../../src/core/persistence/managed-sync-orphans.ts';
import { staleOwnedContent } from '../../src/core/shared-skills/content-freshness.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;

/** A value with the generated parts reduced to their shape: SHA-256 digests, UUIDs and timestamps. */
function norm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(UUID, '<uuid>').replace(ISO, '<ts>'));
}

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return norm({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } });
}

const quiet = { info() {}, warn() {}, error() {} } as never;

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-bookkeeping-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Preview, then apply what the preview printed (bound by its hash), as `gbrain repair <kind>` and `--apply --expect` do. */
async function previewThenApply(engine: BrainEngine, kind: RepairKind) {
  const scope = await resolveRepairScope(engine);
  const preview = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true });
  const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet }))
    .run(kind, scope, { explicit: true, ...(preview.preview_hash ? { expect: preview.preview_hash } : {}) })
    .then(shape, (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
  return { preview: shape(preview), applied };
}

async function incarnationOf(engine: BrainEngine, sourceId: string): Promise<string> {
  const row = await engine.readSourceIncarnation(sourceId);
  expect(row).not.toBeNull();
  return row!.incarnation;
}

/** A Google connector source; its identity has one alias key (the interim key of #6561), so alias protection shows. */
const GOOGLE = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'REPAIR_PARITY_TOKEN' };

describe('engine parity: bookkeeping repair kinds on seeded brains', () => {
  parityTest('repair connector-checkpoints keeps a connector source\'s stable and alias rows and a fresh orphan', {
    methods: ['readSourceIncarnation', 'writeOpCheckpointRecord', 'readOpCheckpointRecord', 'readPersistenceBrainId', 'listConnectorSources',
      'listOrphanConnectorCheckpoints', 'countConnectorCheckpointsKeyed'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await createSource(engine, backend, 'gmail', GOOGLE, '/var/tmp/gbrain-parity-gmail');
    const incarnation = await incarnationOf(engine, 'gmail');
    const keys = connectorCheckpointKeys('gmail', incarnation, connectorIdentity('google', GOOGLE, '/var/tmp/gbrain-parity-gmail'));
    expect(keys.length).toBe(2);
    await engine.writeOpCheckpointRecord('managed-connector', keys[0]!, [{ generation: 1, state: { cursor: 'stable' } }]);
    await engine.writeOpCheckpointRecord('managed-connector', keys[1]!, [{ generation: 1, state: { cursor: 'alias' } }]);
    await engine.writeOpCheckpointRecord('managed-connector', 'f'.repeat(64), [{ generation: 1, state: null }]);
    const loadable = [...(await loadableConnectorKeys(engine)).values()].map(k => ({ id: k.id, alias: k.alias, archived: k.archived }));
    const run = await previewThenApply(engine, 'connector-checkpoints');
    const left = [keys[0]!, keys[1]!, 'f'.repeat(64)].map(async key => (await engine.readOpCheckpointRecord('managed-connector', key)) !== null);
    return { loadable, aliasProtected: await aliasProtectedConnectorCheckpoints(engine), ...run, left: await Promise.all(left) };
  }));

  parityTest('connector checkpoint cleanup bounded by a start time deletes an orphan row and retry pointer and keeps the loadable ones', {
    methods: ['readSourceIncarnation', 'writeOpCheckpointRecord', 'readOpCheckpointRecord', 'transaction', 'listConnectorSources',
      'listOrphanConnectorCheckpoints', 'deleteOrphanConnectorCheckpoint'], timeout: 60_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'gmail', GOOGLE, '/var/tmp/gbrain-parity-gmail');
    const incarnation = await incarnationOf(engine, 'gmail');
    const [stable] = connectorCheckpointKeys('gmail', incarnation, connectorIdentity('google', GOOGLE, '/var/tmp/gbrain-parity-gmail'));
    const orphan = 'e'.repeat(64);
    await engine.writeOpCheckpointRecord('managed-connector', stable!, [{ generation: 1 }]);
    await engine.writeOpCheckpointRecord('managed-connector', orphan, [{ generation: 1 }]);
    await engine.writeOpCheckpointRecord('managed-connector-retry', 'retry-loadable', [{ checkpointKey: stable }]);
    await engine.writeOpCheckpointRecord('managed-connector-retry', 'retry-orphan', [{ checkpointKey: orphan }]);
    const before = new Date(Date.now() + 60_000).toISOString();
    const aged = await orphanConnectorCheckpoints(engine, { minAgeDays: 7 });
    const found = await orphanConnectorCheckpoints(engine, { before });
    const removed = await deleteOrphanConnectorCheckpoints(engine, found, { before });
    const again = await deleteOrphanConnectorCheckpoints(engine, found, { before });
    const left = await Promise.all([['managed-connector', stable!], ['managed-connector', orphan], ['managed-connector-retry', 'retry-loadable'],
      ['managed-connector-retry', 'retry-orphan']].map(async ([op, key]) => (await engine.readOpCheckpointRecord(op!, key!)) !== null));
    return norm({ aged, found: found.map(row => ({ op: row.op, fingerprint: row.fingerprint, stamped: typeof row.updated_at === 'string' })), removed, again, left });
  });

  parityTest('repair orphan-bindings finds no binding to delete on a brain with sources and no writer bindings', {
    methods: ['readPersistenceBrainId', 'listAllSources', 'listOrphanBindings', 'deleteOrphanBinding'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await createSource(engine, backend, 'side', {}, '/var/tmp/gbrain-parity-side');
    const listed = await listOrphanBindings(engine);
    const deleted = await deleteOrphanBinding(engine, { source_id: 'gone', source_incarnation: randomUUID() });
    return { listed, deleted, ...(await previewThenApply(engine, 'orphan-bindings')) };
  }));

  parityTest('repair orphan-bindings deletes the bindings of a removed source and of a replaced incarnation, and keeps a live one', {
    methods: ['readPersistenceBrainId', 'listAllSources', 'listOrphanBindings', 'deleteOrphanBinding', 'transaction', 'worktreeClaimStore'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await createSource(engine, backend, 'side', {}, '/var/tmp/gbrain-parity-side');
    await createSource(engine, backend, 'kept', {}, '/var/tmp/gbrain-parity-kept');
    // An ownerless worktree and its source binding, through the claim store's typed writers (the rows a claim stores).
    const bind = async (sourceId: string, incarnation: string) => engine.transaction(async (tx) => {
      const store = await tx.worktreeClaimStore();
      const worktreeId = randomUUID();
      await store.insertWorktree({ id: worktreeId, ownerHostId: null });
      await store.insertSourceBinding({ sourceId, incarnation, worktreeId, relativePath: '' });
    });
    await bind('gone', randomUUID());
    await bind('side', randomUUID());
    await bind('kept', await incarnationOf(engine, 'kept'));
    const listed = (await listOrphanBindings(engine)).map(row => ({ source_id: row.source_id, reason: row.reason, pending: row.pending_requests }));
    const run = await previewThenApply(engine, 'orphan-bindings');
    return { listed, ...run, after: await listOrphanBindings(engine) };
  }));

  parityTest('repair loop-facts retires the commitment fact of a closed loop and keeps the fact an open loop still holds', {
    methods: ['insertFact', 'upsertOpenLoop', 'closeOpenLoop', 'loopFactDrift', 'closedLoopWithActiveFact', 'readPersistenceBrainId',
      'listSourceIncarnations', 'readLoopFactState', 'expireSourceFactNow'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const fact = async (text: string) => Number((await engine.insertFact({ fact: text, kind: 'commitment', entity_slug: null, visibility: 'private',
      source: 'test:repair-parity', embedding: null } as NewFact, { source_id: 'default' })).id);
    const at = '2026-03-01T10:00:00.000Z';
    const open = async (dedupKey: string, factId: number) => Number((await engine.upsertOpenLoop({ sourceId: 'default', dedupKey,
      loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: dedupKey, evidence: [], detector: 'manual',
      factId, lastActivityAt: at, openedAt: at })).id);
    const deck = await fact('send the deck');
    const call = await fact('call back');
    const done = await open('done', deck);
    const held = await open('held', call);
    await open('held-open', call);
    await engine.closeOpenLoop('default', done, 'done', 'manual');
    await engine.closeOpenLoop('default', held, 'dropped', 'manual');
    const run = await previewThenApply(engine, 'loop-facts');
    return {
      ...run,
      drift: (await engine.loopFactDrift(['default'], null)).length,
      doneStillActive: (await engine.closedLoopWithActiveFact('default', done)) !== null,
      heldStillActive: (await engine.closedLoopWithActiveFact('default', held)) !== null,
    };
  }));

  parityTest('repair managed-sync-orphans retires an unadoptable cursor with its manifest, a failure row with no cursor and a retired incarnation\'s cursor', {
    methods: ['readSourceIncarnation', 'writeOpCheckpointRecord', 'readOpCheckpointRecord', 'readPersistenceBrainId',
      'listManagedSyncOrphanRows', 'applyManagedSyncRetireLimits', 'retireManagedSyncCursor', 'deleteManagedSyncFailureRow',
      'deleteManagedSyncManifest'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const incarnation = await incarnationOf(engine, 'default');
    // Fixed ids: the listing prints the first 8 characters of the principal and of a retired incarnation.
    const writer = { authority: { writer: { principal: { kind: 'local_cli', id: '11111111-1111-4111-8111-111111111111' } } } };
    await engine.writeOpCheckpointRecord('managed-sync', 'cursor-a', [{ sourceId: 'default', incarnation, runId: 'run-a', done: false, index: 1, total: 3, ...writer }]);
    await engine.writeOpCheckpointRecord('managed-sync-manifest', 'run-a', [{ paths: ['notes/a.md'] }]);
    await engine.writeOpCheckpointRecord('managed-sync-failure', 'cursor-b', [{ source_id: 'default', source_incarnation: incarnation, run_id: 'run-b', request_id: null }]);
    await engine.writeOpCheckpointRecord('managed-sync', 'cursor-c', [{ sourceId: 'default', incarnation: '22222222-2222-4222-8222-222222222222', runId: 'run-c', done: false, ...writer }]);
    await engine.writeOpCheckpointRecord('managed-sync', 'cursor-d', [{ sourceId: 'default', incarnation, runId: 'run-d', done: true, ...writer }]);
    const classified = await classifyManagedSyncOrphans(engine, ['default']);
    const view = {
      orphans: classified.orphans.map(o => ({ kind: o.kind, cursor_key: o.cursor_key, reason: o.reason, run_id: o.run_id, principal: o.principal?.kind ?? null })),
      retained: classified.retained,
    };
    const run = await previewThenApply(engine, 'managed-sync-orphans');
    const left = await Promise.all([['managed-sync', 'cursor-a'], ['managed-sync-manifest', 'run-a'], ['managed-sync-failure', 'cursor-b'],
      ['managed-sync', 'cursor-c'], ['managed-sync', 'cursor-d']].map(async ([op, key]) => (await engine.readOpCheckpointRecord(op!, key!)) !== null));
    return norm({ classified: view, ...run, left });
  }));

  parityTest('repair content-receipt-root finds no receipt to rebind for a content source whose receipt has no owner binding', {
    methods: ['readSourceIncarnation', 'setConfig', 'readPersistenceBrainId', 'listOwnedContentRows'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await createSource(engine, backend, 'notes', {}, '/var/tmp/gbrain-parity-notes');
    const incarnation = await incarnationOf(engine, 'notes');
    await engine.setConfig(`shared_skills.content.v1.notes.${incarnation}`, JSON.stringify({ version: 1, source_id: 'notes', source_incarnation: incarnation,
      owned_root: true, stage: 'complete', status: 'ready', repository_kind: 'content_directory', root: '/var/tmp/gbrain-parity-elsewhere' }));
    return { stale: await staleOwnedContent(engine, ['notes']), ...(await previewThenApply(engine, 'content-receipt-root')) };
  }));

  /** The managed-sync and owned-content members called directly on fixed rows (no request rows, so no refusal holds). */
  async function managedSyncDirect(engine: BrainEngine) {
    const inc = await incarnationOf(engine, 'default');
    const retiredInc = '55555555-5555-4555-8555-555555555555';
    const principal = { authority: { writer: { principal: { kind: 'local_cli', id: '33333333-3333-4333-8333-333333333333' } } } };
    const pending = { requestId: '44444444-4444-4444-8444-444444444444', intent: { kind: 'managed_sync_checkpoint' } };
    // sync-adopt first: a clock that stamps both in one millisecond orders them by key, the same order.
    await engine.writeOpCheckpointRecord('managed-sync', 'sync-adopt', [{ sourceId: 'default', incarnation: inc, runId: 'run-adopt', done: false, ...principal }]);
    await engine.writeOpCheckpointRecord('managed-sync', 'sync-open', [{ sourceId: 'default', incarnation: inc, runId: 'run-open', done: false,
      index: 2, total: 2, syncOptions: {}, pending, ...principal }]);
    // The finished cursor supersedes the two above only when it is strictly newer.
    await new Promise(resolve => setTimeout(resolve, 5));
    await engine.writeOpCheckpointRecord('managed-sync', 'sync-retired', [{ sourceId: 'default', incarnation: retiredInc, runId: 'run-retired', done: false }]);
    await engine.writeOpCheckpointRecord('managed-sync', 'sync-done', [{ sourceId: 'default', incarnation: inc, runId: 'run-done', done: true }]);
    await engine.writeOpCheckpointRecord('managed-sync-failure', 'fail-a', [{ source_id: 'default', source_incarnation: inc, run_id: 'run-x', request_id: null }]);
    await engine.writeOpCheckpointRecord('managed-sync-failure', 'fail-r', [{ source_id: 'default', source_incarnation: retiredInc, run_id: 'run-y' }]);
    await engine.writeOpCheckpointRecord('managed-sync-failure', 'sync-open', [{ source_id: 'default', source_incarnation: inc }]);
    await engine.writeOpCheckpointRecord('managed-sync-manifest', 'run-open', [{ paths: [] }]);
    await engine.writeOpCheckpointRecord('managed-sync-manifest', 'run-gone', [{ paths: [] }]);
    await engine.writeOpCheckpointRecord('managed-sync-pass', `default:${inc}`, [{ obligations: { slug_mode: 'flat' }, telemetry: { pass_id: 'pass-1' } }]);
    const target = (cursorKey: string, incarnation: string | null, runId: string | null, requestId: string | null = null) =>
      ({ cursorKey, sourceId: 'default', incarnation, runId, requestId });
    const rows = await engine.listManagedSyncOrphanRows(['default']);
    const everySource = await engine.listManagedSyncOrphanRows(null);
    const noSource = await engine.listManagedSyncOrphanRows([]);
    const archived = await engine.listArchivedSourceIds();
    const failureKeys = (await engine.listManagedSyncFailureKeys(['fail-a', 'nope', 'fail-r'])).sort();
    const passKept = await engine.transaction(async tx => {
      await tx.applyManagedSyncRetireLimits();
      return tx.retireManagedSyncPassSlugMode(target(`default:${inc}`, inc, 'pass-1'), 'gbrain-sync:default');
    });
    const failureSharedKey = await engine.deleteManagedSyncFailureRow('sync-open', false);
    const manifestNamed = await engine.deleteManagedSyncManifest('run-open');
    const retire = {
      movedKept: await engine.retireManagedSyncCursor(target('sync-open', inc, 'run-open', pending.requestId), 'checkpoint_moved'),
      slugKept: await engine.retireManagedSyncCursor(target('sync-open', inc, 'run-open', pending.requestId), 'slug_mode_refused'),
      sameIncarnationKept: await engine.retireManagedSyncCursor(target('sync-open', inc, 'run-open'), 'retired'),
      doneKept: await engine.retireManagedSyncCursor(target('sync-done', inc, 'run-done'), 'adoption'),
      orphan: await engine.retireManagedSyncCursor(target('sync-open', inc, 'run-open'), 'orphan'),
      adopted: await engine.retireManagedSyncCursor(target('sync-adopt', inc, 'run-adopt'), 'adoption'),
      retired: await engine.retireManagedSyncCursor(target('sync-retired', retiredInc, 'run-retired'), 'retired'),
      again: await engine.retireManagedSyncCursor(target('sync-retired', retiredInc, 'run-retired'), 'retired'),
    };
    const failures = {
      current: await engine.deleteManagedSyncFailureRow('fail-a', false),
      retiredKeptAsCurrent: await engine.deleteManagedSyncFailureRow('fail-a', true),
      retired: await engine.deleteManagedSyncFailureRow('fail-r', true),
      sharedAfter: await engine.deleteManagedSyncFailureRow('sync-open', false),
    };
    const manifests = { open: await engine.deleteManagedSyncManifest('run-open'), gone: await engine.deleteManagedSyncManifest('run-gone'),
      missing: await engine.deleteManagedSyncManifest('run-missing') };
    await engine.setConfig('parity.locked-read', 'v1');
    const lockedConfig = await engine.transaction(async tx => [await tx.readConfigForUpdate('parity.locked-read'), await tx.readConfigForUpdate('parity.none')]);
    return {
      rows, everySourceCursors: everySource.cursors.map(c => c.cursor_key), noSource, archived, failureKeys, passKept, failureSharedKey,
      manifestNamed, retire, failures, manifests, owned: await engine.listOwnedContentRows(['default'], false),
      ownedEverySource: await engine.listOwnedContentRows(null, true), binding: await engine.readContentReceiptBinding('default'), lockedConfig,
    };
  }

  // Last, and prints no ids: on the Postgres arm the fact and loop ids keep counting across cases, and the loop-facts case prints them.
  parityTest('the bookkeeping members answer the same when called directly', {
    methods: ['readSourceIncarnation', 'writeOpCheckpointRecord', 'transaction', 'insertFact', 'upsertOpenLoop', 'listSourceIncarnations',
      'listConnectorSources', 'listOrphanConnectorCheckpoints', 'countConnectorCheckpointsKeyed', 'deleteOrphanConnectorCheckpoint',
      'listOrphanBindings', 'deleteOrphanBinding', 'readLoopFactState', 'expireSourceFactNow', 'setConfig',
      'listManagedSyncOrphanRows', 'listArchivedSourceIds', 'listManagedSyncFailureKeys', 'applyManagedSyncRetireLimits',
      'retireManagedSyncPassSlugMode', 'retireManagedSyncCursor', 'deleteManagedSyncFailureRow', 'deleteManagedSyncManifest',
      'listOwnedContentRows', 'readContentReceiptBinding', 'readConfigForUpdate'], timeout: 60_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'gmail', GOOGLE, '/var/tmp/gbrain-parity-gmail');
    const [stable] = connectorCheckpointKeys('gmail', await incarnationOf(engine, 'gmail'), connectorIdentity('google', GOOGLE, '/var/tmp/gbrain-parity-gmail'));
    const orphan = 'a'.repeat(64);
    await engine.writeOpCheckpointRecord('managed-connector', stable!, [{ generation: 1 }]);
    await engine.writeOpCheckpointRecord('managed-connector', orphan, [{ generation: 1 }]);
    const bounds = { before: new Date(Date.now() + 60_000).toISOString(), stateOp: CONNECTOR_STATE_OP };
    const incarnations = (await engine.listSourceIncarnations(['gmail', 'missing', 'default', 'gmail'])).map(row => row.id);
    const sources = (await engine.listConnectorSources()).map(row => ({ id: row.id, archived: row.archived, kind: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config)?.kind }));
    const locked = (await engine.transaction(tx => tx.listConnectorSources({ lock: true }))).map(row => row.id);
    const found = await engine.listOrphanConnectorCheckpoints([stable!], bounds, 10);
    const count = await engine.countConnectorCheckpointsKeyed([stable!, orphan, 'b'.repeat(64)]);
    const kept = await engine.deleteOrphanConnectorCheckpoint(found[0]!, [orphan], bounds);
    const deleted = await engine.deleteOrphanConnectorCheckpoint(found[0]!, [stable!], bounds);
    const again = await engine.deleteOrphanConnectorCheckpoint(found[0]!, [stable!], bounds);
    const bindings = await engine.listOrphanBindings({ limit: 10 });
    const binding = await engine.deleteOrphanBinding({ source_id: 'gone', source_incarnation: randomUUID() });
    const factId = Number((await engine.insertFact({ fact: 'send the deck', kind: 'commitment', entity_slug: null, visibility: 'private',
      source: 'test:repair-parity', embedding: null } as NewFact, { source_id: 'default' })).id);
    const at = '2026-03-01T10:00:00.000Z';
    const loopId = Number((await engine.upsertOpenLoop({ sourceId: 'default', dedupKey: 'deck', loopType: 'commitment_owed_by_me',
      counterpartyEmail: 'a@example.com', summary: 'deck', evidence: [], detector: 'manual', factId, lastActivityAt: at, openedAt: at })).id);
    const state = await engine.readLoopFactState(loopId);
    const missing = await engine.readLoopFactState(loopId + 1000);
    const otherSource = await engine.expireSourceFactNow(factId, 'gmail');
    const expired = await engine.expireSourceFactNow(factId, 'default');
    const expiredAgain = await engine.expireSourceFactNow(factId, 'default');
    const after = await engine.readLoopFactState(loopId);
    const managed = await managedSyncDirect(engine);
    return norm({
      managed,
      incarnations, sources, locked, found: found.map(row => ({ op: row.op, fingerprint: row.fingerprint, stamped: typeof row.updated_at === 'string' })),
      count, kept, deleted, again, bindings, binding,
      state: { loop: state.loop && { idMatches: Number(state.loop.id) === loopId, source_id: state.loop.source_id, status: state.loop.status, factMatches: Number(state.loop.fact_id) === factId },
        fact: state.fact && { idMatches: Number(state.fact.id) === factId, source_id: state.fact.source_id, expired: state.fact.expired_at !== null, fact: state.fact.fact },
        shared: state.shared },
      missing, otherSource, expired, expiredAgain, afterExpired: after.fact?.expired_at !== null,
    });
  });
});
