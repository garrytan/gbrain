/**
 * Engine parity for a write to a worktree-bound source: after `gbrain sources writer claim`, a put_page to the claimed
 * source is admitted, prepared against the checkout file, published and committed on every engine, and a refusal at
 * publication ends the request in a terminal state through recovery.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a put_page to the claimed source commits the page and writes its file into the checkout. A storage
 *    refusal at the publication boundary moves the request to recovering (its recovery record kept), and the recovery
 *    pass ends it `failed` with the refusal's code: no page, no file, never left pending.
 *  - Regression: an engine that refuses a step of the bound publication (the held-import check, the recovery record,
 *    the publication stamp, markRecovering or recoverPublication's writes), so a claimed source takes no write, or a
 *    refused publication stays recovering with nothing to finish it.
 *  - Why existing coverage misses it: test/persistence-*.test.ts run on PGLite and Postgres only; the Rust engine
 *    refused every raw-SQL step of the bound publication (engine-sql/publication-journal.ts).
 *  - Seam: the publication fault hook (persistence/fault-points.ts) throws the refusal; real engines, real Git checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { readLocalWriter } from '../../src/core/persistence/identity.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { completeWrite } from '../../src/core/persistence/journal.ts';
import type { PagesRecoveryRecord, WriteRequest } from '../../src/core/persistence/model.ts';

const { parityTest } = parityArms(testBackends());

async function withClaimedCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-bound-write-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
      await createSource(engine, backend, 'work', {}, root);
      const expected_state = await writerAdminState(engine);
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state });
      try { return await run(root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const NO_WORKTREE = 'f0000000-0000-4000-8000-0000000000f1';
const RECORD: PagesRecoveryRecord = { version: 3, target: 'pages', root: '/parity', ownerEpoch: '1', attempt: TOKEN, files: [] };

/** Admits one request to `default` and claims it under TOKEN; returns its journal id. */
async function claimedRequest(engine: BrainEngine, requestId: string): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(KEYS);
  const { id } = await engine.insertWriteRequest({ principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page',
    sourceId: 'default', sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null });
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  return id;
}
const recoveryBytes = async (engine: BrainEngine) => Number((await engine.lockPersistenceCounters(['brain'])).find(r => r.key === 'brain')!.recovery_bytes);
const shape = (row: WriteRequest | null) => row && { state: row.state, token: row.execution_token, recovery: row.recovery ?? null,
  recoveryBytes: Number(row.recovery_bytes), blocked: row.blocked_reason ?? null, errorCode: row.error_code ?? null, started: row.publication_started === true };

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'work', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

describe('a write to a worktree-bound source', () => {
  parityTest('the publication journal store: a recovery is recorded once, marked, blocked, requeued and cleared', {
    methods: ['publicationJournalStore'],
  }, async (engine) => {
    const id = await claimedRequest(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const reservation = { id, executionToken: TOKEN, recovery: RECORD, bytes: 40, keys: KEYS };
    const first = await engine.transaction(async (tx) => {
      const journal = await tx.publicationJournalStore();
      await journal.lockSource('default');
      await journal.shareWorktree(NO_WORKTREE);
      await journal.stagingDurability();
      const recorded = [await journal.recordRecovery(reservation, true), await journal.recordRecovery(reservation, true)];
      const staging = await journal.recoveryStaging('persistence_requests', id);
      await journal.growRecoveryStaging('persistence_requests', id, { ...RECORD, ownerEpoch: '2' }, 10);
      await journal.markRecovering(id, TOKEN, 'publication_failed', { code: 'storage_error', message: 'first' });
      await journal.markRecovering(id, TOKEN, 'publication_failed', { code: 'other_error', message: 'second' });
      const marked = shape(await tx.lockWriteRequest(id));
      const notTerminal = await journal.clearKnownRecovery(id, KEYS, { ...RECORD, ownerEpoch: '2' });
      const capacity = shape(await journal.blockCapacity(id));
      const blocked = shape(await journal.blockRecovery(id, 'unexpected_file_bytes'));
      const started = shape(await journal.markPublicationStarted(id));
      const requeued = shape(await journal.requeueRecovered(id, { persistence: { git_state: 'committed' } }, true));
      const missing = { held: await journal.heldBehindImport('default', 'notes/parity-example', 999), blocker: await journal.recoveryBlocker(NO_WORKTREE, id),
        path: await journal.ownerPath(NO_WORKTREE), owner: await journal.shareWorktreeOwner(NO_WORKTREE),
        staging: await journal.recoveryStaging('persistence_effects', 999_999) };
      return { recorded, staging: staging && { ...staging, recovery_bytes: Number(staging.recovery_bytes) }, marked, notTerminal, capacity, blocked, started, requeued, missing };
    });
    expect(first).toEqual({
      recorded: [true, false],
      staging: { recovery: RECORD, recovery_bytes: 40, source_id: 'default' },
      marked: { state: 'recovering', token: TOKEN, recovery: { ...RECORD, ownerEpoch: '2' }, recoveryBytes: 50, blocked: 'publication_failed', errorCode: 'storage_error', started: false },
      notTerminal: false,
      capacity: { state: 'recovering', token: TOKEN, recovery: { ...RECORD, ownerEpoch: '2' }, recoveryBytes: 50, blocked: 'writer_pool_capacity', errorCode: 'storage_error', started: false },
      blocked: { state: 'recovering', token: TOKEN, recovery: { ...RECORD, ownerEpoch: '2' }, recoveryBytes: 50, blocked: 'unexpected_file_bytes', errorCode: 'storage_error', started: false },
      started: { state: 'recovering', token: TOKEN, recovery: { ...RECORD, ownerEpoch: '2' }, recoveryBytes: 50, blocked: 'unexpected_file_bytes', errorCode: 'storage_error', started: true },
      requeued: { state: 'queued', token: null, recovery: null, recoveryBytes: 0, blocked: null, errorCode: null, started: false },
      missing: { held: null, blocker: false, path: null, owner: null, staging: null },
    });
    // The record's 40 bytes stay reserved until the caller releases them (recoverPublication's addPersistenceCounters).
    expect(await recoveryBytes(engine)).toBe(40);
    await engine.addPersistenceCounters('brain', { recovery_bytes: -40 });

    // A terminal request's known record is cleared once, releasing its bytes; a second request's record by its locked bytes.
    const terminal = await claimedRequest(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const other = await claimedRequest(engine, 'b0000000-0000-4000-8000-0000000000b3');
    const cleared = await engine.transaction(async (tx) => {
      const journal = await tx.publicationJournalStore();
      await journal.recordRecovery({ ...reservation, id: terminal, bytes: 30 }, true);
      await journal.recordRecovery({ ...reservation, id: other, bytes: 20 }, false);
      const reserved = await recoveryBytes(tx);
      await completeWrite(tx, (await tx.lockWriteRequest(terminal))!, 'failed', {}, { code: 'storage_error', message: 'parity' });
      const known = [await journal.clearKnownRecovery(terminal, KEYS, RECORD), await journal.clearKnownRecovery(terminal, KEYS, RECORD)];
      await journal.clearRecovery(other, KEYS, 20);
      return { reserved, known, released: await recoveryBytes(tx), terminal: shape(await tx.lockWriteRequest(terminal)), other: shape(await tx.lockWriteRequest(other)) };
    });
    expect(cleared).toEqual({ reserved: 50, known: [true, false], released: 0,
      terminal: { state: 'failed', token: TOKEN, recovery: null, recoveryBytes: 0, blocked: null, errorCode: 'storage_error', started: false },
      other: { state: 'running', token: TOKEN, recovery: null, recoveryBytes: 0, blocked: null, errorCode: null, started: false } });
  });

  parityTest('claim the checkout, put_page to the bound source: the page and its file are written', {
    methods: ['worktreeClaimStore'],
    requires: 'managed_persistence',
    timeout: 120_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/bob-example', content: '---\ntype: note\ntitle: Bob Example\n---\nWorks at widget-co.\n', request_id: randomUUID() } });
    const page = await engine.getPage('notes/bob-example', { sourceId: 'work' });
    const file = join(root, 'notes', 'bob-example.md');
    const answers = { title: page?.title ?? null, file: existsSync(file) ? readFileSync(file, 'utf8').includes('Works at widget-co.') : false };
    expect(answers).toEqual({ title: 'Bob Example', file: true });
    return answers;
  }));

  parityTest('a refusal at publication moves the request to recovering, then ends it failed: no page, no file', {
    methods: ['worktreeClaimStore'],
    requires: 'managed_persistence',
    timeout: 120_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    const request_id = randomUUID();
    // The local writer registers on the first write, so it is read after the submit starts.
    const stored = async () => engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
    // The request as the recovery pass leaves it, before its recovery record is cleared: terminal, the record still held.
    // markRecovering is the only route to that pass from a refused publication, and no seam sits between the two.
    type Seen = { state: string; recovery: boolean; blocked_reason: string | null };
    let recovered = null as Seen | null;
    const seen: FaultPoint[] = [];
    installFaultHook(async (point) => {
      seen.push(point);
      if (point === 'publication:before_publication') throw new OperationError('storage_error', 'Injected refusal at publication.', 'Test fault.');
      if (point === 'publication_recovery:before_clear') {
        const row = await stored();
        recovered = row && { state: row.state, recovery: row.recovery != null, blocked_reason: row.blocked_reason };
      }
    });
    let code: string | undefined;
    try {
      await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
        params: { slug: 'notes/carol-example', content: '---\ntype: note\ntitle: Carol Example\n---\nWorks at widget-co.\n', request_id } });
    } catch (e) {
      // The held admission refusal ends the case on Rust (see `requires`); every other refusal is the answer.
      if ((e as { code?: string }).code === 'engine_capability_missing') throw e;
      code = (e as { code?: string }).code;
    } finally { installFaultHook(undefined); }
    const final = await stored();
    const page = await engine.getPage('notes/carol-example', { sourceId: 'work' });
    const answers = { code, recovered, seen: seen.includes('publication_recovery:before_clear'),
      final: final && { state: final.state, error_code: final.error_code, recovery: final.recovery != null },
      page: page?.title ?? null, file: existsSync(join(root, 'notes', 'carol-example.md')) };
    expect(answers).toEqual({ code: 'storage_error', recovered: { state: 'failed', recovery: true, blocked_reason: null }, seen: true,
      final: { state: 'failed', error_code: 'storage_error', recovery: false }, page: null, file: false });
    return answers;
  }));
});
