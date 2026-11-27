/**
 * Engine parity for the four persistence sites the journal flip typed (Rust store-capabilities.ts reports
 * `persistence_journal`, and `managed_persistence` since bound-write-rust): the grouped admission (persistence/journal.ts
 * `admitWriteGroupInTransaction`, through page-batch.ts `admitBatch`), the owner's host-binding read
 * (persistence/effect-journal.ts `queuePublicationEffects`), the topology recovery scan
 * (persistence/topology-recovery.ts `recoverSourceTopologies`) and the segmented-storage gate's writer evidence
 * (persistence/writer-versions.ts `segmentedGateEvidence`), plus the ingest log's writer stamp that evidence reads.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through harness.ts) each
 *    site reads and writes through a typed engine member and answers the same: a grouped admission inserts one queued
 *    row per page in order and replays them by request id; the owner's binding is the claimed checkout's path, null for
 *    a worktree with none, and a non-uuid id refuses with the `::uuid` cast's message; the recovery scan lists a
 *    recovery row of this host's worktree after a cursor and none for another host; the gate evidence names the
 *    admitter and the importer (stamped with this binary's version and the segment-reader mark), and a day count the
 *    interval or the timestamp cannot hold refuses as Postgres refuses it. A grouped insert is one write: a refusal at a
 *    later item keeps no row and no counter charge. The replay read names each row once, whatever the id's letter case.
 *    A put_pages batch with no worktree writes every page on every arm. A worktree-bound put_page writes the page and
 *    its file on every arm.
 *    A remote put_page admission, alone or grouped, is admitted on every arm: its publication queues a mention-links
 *    effect, and that effect reads and writes through typed engine members (engine-sql/remote-links.ts).
 *  - Regression: each site sent SQL through executeRaw. On the Rust engine that refused raw_sql, so the store held both
 *    capabilities back (HELD_FOR_CALLERS) and a Rust brain had no write journal. Fail-first: on the parent head
 *    524768a179 every case fails on the Rust arm, at the capability check or at a member the engine did not have, and
 *    the ingest stamp was not written (the importer row's version was null). Before the bound write's preparation and
 *    publication were typed, the bound put_page case failed on Rust once managed_persistence was reported: the write was
 *    admitted, reached raw SQL in preparation and ended `failed` with a request row. Before the group
 *    insert was one store write, the later-item case kept the first item's row on Rust; before the replay read folded
 *    case, the mixed-case read returned one row twice; before the window start was checked, a day count of -1e100
 *    overflowed and refused as internal_error. While the links effect read through raw SQL, the Rust arm refused both
 *    remote admissions (`engine_capability_missing`, raw_sql) with no row and no charge.
 *    While the store did not serve the dream cycle's three journal reads (readDreamDeferralReceipt,
 *    listLaterPersistenceRequests, listCommittedOutputRequests), it withheld `persistence_journal` and the three
 *    admission, owner-binding and gate-evidence cases failed on the Rust arm at the capability check.
 *  - Why existing coverage misses it: the owner and admission parity cases admit one write at a time with no managed
 *    worktree; nothing admitted a group, read the owner binding, listed a recovery row, or read the gate evidence.
 *  - Seam: none. Real engines and the real sites; each case runs under its own GBRAIN_HOME. Generated ids and paths are
 *    compared by equality with another member's answer, never printed.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { VERSION } from '../../src/version.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, type WriteAdmission } from '../../src/core/persistence/journal.ts';
import { admitBatch, submitPageBatch } from '../../src/core/persistence/page-batch.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { segmentedGateEvidence } from '../../src/core/persistence/writer-versions.ts';

const { parityTest } = parityArms(testBackends());

const GROUP = ['d0000000-0000-4000-8000-0000000000d1', 'd0000000-0000-4000-8000-0000000000d2'] as const;
const UNKNOWN = 'd0000000-0000-4000-8000-0000000000df';
const RECOVERY = 'd0000000-0000-4000-8000-0000000000e1';
const WRITER = 'd0000000-0000-4000-8000-0000000000e2';
const GATE_REQUEST = 'd0000000-0000-4000-8000-0000000000e3';
const LATER = 'd0000000-0000-4000-8000-0000000000d3';
const BOUND = 'd0000000-0000-4000-8000-0000000000d4';
const BATCH = 'd0000000-0000-4000-8000-0000000000d5';
const REMOTE = 'd0000000-0000-4000-8000-0000000000d6';
const REMOTE_GROUP = ['d0000000-0000-4000-8000-0000000000d7', 'd0000000-0000-4000-8000-0000000000d8'] as const;
const RANGE_REFUSAL = /(interval|timestamp) out of range/;
const logger = { info() {}, warn() {}, error() {} };
/** The brain counter rows as text; Postgres reads the counts as BigInt. */
const counterText = async (engine: BrainEngine) => JSON.stringify(await engine.readCounterRows(['brain']), (_key, value) =>
  typeof value === 'bigint' ? String(value) : value);
const UUID_REFUSAL = /invalid input syntax for type uuid: "[^"]*"/;

/** 'ok', or the part of the refusal message `pattern` matches (the whole message when it does not match). */
async function outcome(run: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return pattern.exec(message)?.[0] ?? message;
  }
}

/** Runs `run` under a scratch GBRAIN_HOME, so this host's identity is minted there. */
async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-journal-sites-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => run(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A plain put_page admission of `slug`, built as a CLI put builds it. */
async function putAdmission(engine: BrainEngine, slug: string, requestId: string): Promise<{ ctx: OperationContext; admission: WriteAdmission }> {
  const source = await engine.readSourceMembership('default');
  const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return { ctx, admission: { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: { body: slug }, intent: { body: slug } } };
}

describe('engine parity: the persistence sites the journal flip typed', () => {
  parityTest('a grouped admission inserts one queued row per page in order, and replays them by request id', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'insertWriteRequestGroup', 'readWriteRequestsByRequestIds'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    // An unbound group needs only the journal; managed_persistence is checked for a bound group alone.
    expect(engine.capabilities.has('persistence_journal')).toBe(true);
    await registerLocalWriter(engine, 'cli');
    const pages = await Promise.all(GROUP.map((id, i) => putAdmission(engine, `notes/parity-group-${i}`, id)));
    const ctx = pages[0]!.ctx, admissions = pages.map(page => page.admission);
    const admitted = await admitBatch(ctx, 'parity-batch', admissions);
    const replayed = await admitBatch(ctx, 'parity-batch', admissions);
    const principal = admissions[0]!.principal;
    const direct = await engine.readWriteRequestsByRequestIds(principal.kind, principal.id, [GROUP[1], GROUP[0], GROUP[0], GROUP[0].toUpperCase(), UNKNOWN]);
    // An empty group inserts and charges nothing on every arm (the journal never sends one; the member must still agree).
    const first = admissions[0]!;
    const empty = await engine.insertWriteRequestGroup({ principalKind: principal.kind, principalId: principal.id, operation: first.operation,
      sourceId: first.sourceId, sourceIncarnation: first.sourceIncarnation, worktreeId: null, topologyGeneration: null, authority: first.authority,
      admitterVersion: VERSION, admitterHostId: localHostId(), counterKeys: ['brain'], items: [] });
    // A group whose later item repeats an admitted request id refuses whole: the new first item is not kept, and no
    // counter is charged (the one INSERT statement on SQL; one store write on Rust).
    const charged = await counterText(engine);
    const item = (requestId: string, slug: string) => ({ requestId, pageId: null, slug, digest: 'f'.repeat(64), intent: { body: slug }, intentBytes: 8,
      terminalReservation: 4096, clientRequestId: null });
    const later = await outcome(() => engine.transaction(tx => tx.insertWriteRequestGroup({ principalKind: principal.kind, principalId: principal.id,
      operation: first.operation, sourceId: first.sourceId, sourceIncarnation: first.sourceIncarnation, worktreeId: null, topologyGeneration: null,
      authority: first.authority, admitterVersion: VERSION, admitterHostId: localHostId(), counterKeys: ['brain'],
      items: [item(LATER, 'notes/parity-group-later'), item(GROUP[0], 'notes/parity-group-0')] })), /^$/);
    const answers = {
      rows: admitted.map(row => ({ request: row.request_id, slug: row.slug, state: row.state, operation: row.operation, worktree: row.worktree_id })),
      inOrder: Number(admitted[0]!.sequence) < Number(admitted[1]!.sequence),
      replaySame: replayed.map(row => row.id).join() === admitted.map(row => row.id).join(),
      direct: direct.map(row => row.request_id).sort(),
      empty: empty.length,
      laterRefused: later !== 'ok',
      laterKept: (await engine.readWriteRequestsByRequestIds(principal.kind, principal.id, [LATER])).length,
      chargeKept: await counterText(engine) === charged,
    };
    expect(answers).toEqual({
      rows: [
        { request: GROUP[0], slug: 'notes/parity-group-0', state: 'queued', operation: 'put_page', worktree: null },
        { request: GROUP[1], slug: 'notes/parity-group-1', state: 'queued', operation: 'put_page', worktree: null },
      ],
      inOrder: true, replaySame: true, direct: [...GROUP], empty: 0, laterRefused: true, laterKept: 0, chargeKept: true,
    });
    return answers;
  }));

  parityTest('the owner binding is the claimed checkout, and the recovery scan lists this host\'s recovery rows after a cursor', {
    methods: ['worktreeClaimStore', 'getWorktreeBinding', 'readOwnerHostBinding', 'readLedgerSource', 'insertTopologyChange', 'listTopologyRecoveries'],
    timeout: 60_000,
  }, async (engine, backend: ParityBackend) => withHome(async (home) => {
    // These are typed members the journal calls directly; none needs managed_persistence.
    expect(engine.capabilities.has('persistence_journal')).toBe(true);
    const root = join(home, 'checkout');
    await Bun.write(join(root, 'example.md'), 'generic example');
    await createSource(engine, backend, 'work', {}, root);
    try {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
      const host = localHostId();
      const binding = await engine.getWorktreeBinding('work', host);
      const worktree = binding!.worktree_id;
      const source = await engine.readLedgerSource('work');
      const change = await engine.insertTopologyChange({ principalId: WRITER, requestId: RECOVERY, digest: 'e'.repeat(64), operation: 'writer_claim',
        sourceId: 'work', sourceIncarnation: source!.incarnation, worktreeIds: [worktree], state: 'recovering', recovery: { worktreeId: worktree, step: 1 },
        recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096, outcome: null });
      const listed = await engine.listTopologyRecoveries(host, null, 16);
      const answers = {
        binding: (await engine.readOwnerHostBinding(worktree)) === root,
        unbound: await engine.readOwnerHostBinding(UNKNOWN),
        badBinding: await outcome(() => engine.readOwnerHostBinding('not-a-uuid'), UUID_REFUSAL),
        listed: listed.map(row => ({ self: row.id === change.id, source: row.source_id, state: row.state, recovery: row.recovery })),
        afterCursor: await engine.listTopologyRecoveries(host, change.id, 16),
        otherHost: await engine.listTopologyRecoveries(UNKNOWN, null, 16),
        badHost: await outcome(() => engine.listTopologyRecoveries('not-a-uuid', null, 16), UUID_REFUSAL),
      };
      expect(answers).toEqual({
        binding: true, unbound: null, badBinding: 'invalid input syntax for type uuid: "not-a-uuid"',
        listed: [{ self: true, source: 'work', state: 'recovering', recovery: { worktreeId: worktree, step: 1 } }],
        afterCursor: [], otherHost: [], badHost: 'invalid input syntax for type uuid: "not-a-uuid"',
      });
      // The worktree id differs per arm; the shared answer names it by its role.
      return { ...answers, listed: answers.listed.map(row => ({ ...row, recovery: { worktreeId: '<worktree>', step: 1 } })) };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));

  parityTest('the segmented gate evidence names the admitter and the importer, stamped with this binary\'s version and the segment-reader mark', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'insertWriteRequest', 'logIngest', 'readSegmentedGateEvidence'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    expect(engine.capabilities.has('persistence_journal')).toBe(true);
    await registerLocalWriter(engine, 'cli');
    const { admission } = await putAdmission(engine, 'notes/parity-gate', GATE_REQUEST);
    await admitWrite(engine, admission);
    await engine.logIngest({ source_type: 'parity', source_ref: 'parity-ref', pages_updated: [], summary: 'parity ingest' });
    const host = localHostId();
    // A live consumer (role resident) appears only where a consumer row exists; the arms are compared on the two roles
    // this case writes.
    const rows = (await segmentedGateEvidence(engine, 7)).filter(row => row.role === 'admitter' || row.role === 'importer');
    // The member's own rows are the ones segmentedGateEvidence labels, one for one.
    const raw = await engine.readSegmentedGateEvidence(7);
    expect(raw.filter(row => row.role === 'admitter' || row.role === 'importer').length).toBe(rows.length);
    const answers = rows.map(row => ({ role: row.role, host: row.host_id === host ? 'self' : row.host_id, principal: row.role === 'admitter' ? 'local_cli:<writer>' : row.principal,
      principalKind: row.principal.split(':')[0], current: row.version === VERSION, segment_reader: row.segment_reader, requests: row.requests,
      seen: typeof row.last_seen === 'string' && typeof row.first_seen === 'string' })).sort((a, b) => a.role.localeCompare(b.role));
    expect(answers).toEqual([
      { role: 'admitter', host: 'self', principal: 'local_cli:<writer>', principalKind: 'local_cli', current: true, segment_reader: true, requests: 1, seen: true },
      { role: 'importer', host: 'self', principal: 'ingest:parity', principalKind: 'ingest', current: true, segment_reader: true, requests: 1, seen: true },
    ]);
    // The window start is now() - days: a day count past the interval's day field, or a start the timestamp cannot
    // hold, refuses as Postgres refuses it; a far but storable start answers.
    const ranges = Object.fromEntries(await Promise.all([1e6, -1e8, 3e6, -1e9, 1e10, 1e100, -1e100, Number.NaN].map(async days =>
      [String(days), await outcome(() => engine.readSegmentedGateEvidence(days), RANGE_REFUSAL)] as const)));
    expect(ranges).toEqual({ '1000000': 'ok', '-100000000': 'ok', '3000000': 'timestamp out of range', '-1000000000': 'timestamp out of range',
      '10000000000': 'interval out of range', '1e+100': 'interval out of range', '-1e+100': 'interval out of range', NaN: 'interval out of range' });
    return { answers, ranges };
  }));

  parityTest('a put_pages batch with no worktree writes every page', {
    methods: ['declarePersistence', 'transaction', 'insertWriteRequestGroup', 'readWriteRequestsByRequestIds', 'readRequestEffects'],
    timeout: 90_000,
  }, async (engine) => withHome(async () => {
    await registerLocalWriter(engine, 'cli');
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, logger,
      config: { engine: engine.kind, embedding_disabled: true } } as unknown as OperationContext;
    const pages = [0, 1].map(i => ({ slug: `notes/parity-batch-${i}`, content: `---\ntype: note\ntitle: batch ${i}\n---\nBatch page ${i}.\n` }));
    try {
      const receipt = await submitPageBatch(ctx, { request_id: BATCH, pages, wait_ms: 30_000 }) as { pages?: Array<Record<string, unknown>> };
      const stored = await Promise.all(pages.map(async page => (await engine.getPage(page.slug, { sourceId: 'default' }))?.compiled_truth?.trim() ?? null));
      const answers = { statuses: (receipt.pages ?? []).map(page => page.status ?? page.state ?? null), stored };
      expect(answers.stored).toEqual(['Batch page 0.', 'Batch page 1.']);
      return answers;
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));

  parityTest('a worktree-bound put_page writes the page and its file', {
    methods: ['getWorktreeBinding'],
    requires: 'managed_persistence',
    timeout: 90_000,
  }, async (engine, backend: ParityBackend) => withHome(async (home) => {
    const root = join(home, 'checkout');
    await Bun.write(join(root, 'example.md'), 'generic example');
    await createSource(engine, backend, 'work', {}, root);
    const slug = 'concepts/parity-bound-example';
    const file = join(root, `${slug}.md`);
    try {
      await registerLocalWriter(engine, 'cli');
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
      expect(Boolean((await engine.getWorktreeBinding('work', localHostId()))?.worktree_id)).toBe(true);
      await engine.setConfig('sync.write_through', 'true');
      const ctx = { engine, sourceId: 'work', remote: false, dryRun: false, logger,
        config: { engine: engine.kind, embedding_disabled: true } } as unknown as OperationContext;
      const put = await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: '---\ntype: concept\ntitle: bound\n---\nStored.\n', request_id: BOUND } }) as Record<string, unknown>;
      const answers = { status: put.status, file: existsSync(file) && readFileSync(file, 'utf8').includes('Stored.'),
        page: (await engine.getPage(slug, { sourceId: 'work' }))?.compiled_truth?.trim() ?? null };
      expect(answers).toEqual({ status: 'created_or_updated', file: true, page: 'Stored.' });
      return answers;
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));
  for (const grouped of [false, true]) {
    parityTest(`a remote ${grouped ? 'grouped ' : ''}put_page admission is admitted on every arm`, {
      methods: ['readWriteRequestsByRequestIds', 'readCounterRows'],
      timeout: 60_000,
    }, async (engine) => withHome(async () => {
      await registerLocalWriter(engine, 'cli');
      // The stdio writer is the remote lane (an MCP agent's writes); it is not trusted to link inline, so publication
      // queues a mention-links effect.
      const stdio = await registerLocalWriter(engine, 'stdio');
      const ids = grouped ? [...REMOTE_GROUP] : [REMOTE];
      const pages = await Promise.all(ids.map((id, i) => putAdmission(engine, `notes/parity-remote-${i}`, id)));
      const remote = { kind: 'local_stdio' as const, id: stdio.id };
      const admissions = pages.map(page => ({ ...page.admission, principal: remote,
        authority: { ...page.admission.authority, principal: remote, remote: true, autoLinkTrusted: false } }));
      const principal = admissions[0]!.principal;
      const charged = await counterText(engine);
      const rows = grouped ? await admitBatch(pages[0]!.ctx, 'parity-remote-batch', admissions) : [await admitWrite(engine, admissions[0]!)];
      const stored = await engine.readWriteRequestsByRequestIds(principal.kind, principal.id, ids);
      const answers = { states: rows.map(row => row.state), remote: rows.map(row => row.authority?.remote), stored: stored.length,
        charged: await counterText(engine) !== charged };
      expect(answers).toEqual({ states: ids.map(() => 'queued'), remote: ids.map(() => true), stored: ids.length, charged: true });
      return answers;
    }));
  }
});
