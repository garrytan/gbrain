/**
 * BrainEngine parity — the persistence status, blocker, hold, catch-up and checkpoint readers that list text keys
 * (source ids, slugs, fingerprints, kinds, paths, lock ids) return them in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the writer status and writer admin state (bindings, legacy locks, counters, queue and effect summaries),
 *    the host-identity, deactivation, physical-root and graduation blocker lists, the parked-push, push-hold, catch-up and
 *    stalled-effect readers, the held-read stale stamp, the landing-gap and drift-conflict audits (pages, producers and the
 *    keyset cursor), the legacy-lock, derived-origin, managed-sync orphan and connector orphan listings, and the atom
 *    retirement ledger's newest-per-origin pick return the same rows in the same order on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1, where each case seeded and read
 *    through typed members runs to the end, and each case that still seeds or reads through raw SQL stops on the typed
 *    raw_sql refusal): byte order,
 *    as PGLite sorts and as Postgres sorts with `COLLATE "C"`.
 *  - Regression: on an en_US Postgres these reads sorted by the locale, which skips punctuation (`ab` before `a-z`), so a
 *    status list, a blocker list, a refusal naming "the first" source, a stale stamp taken from "the first" hold, and the
 *    drift audit's `next` cursor came back in another order than on PGLite, and a page crossing a cursor could repeat or vanish.
 *  - Why existing coverage misses it: the cases used ids that sort the same in every locale, and CI's Postgres runs in
 *    C.UTF-8. Every case here mixes `a-z`, `ab`, `a.b` and `a_b` (or the slug-safe `a-z`, `a/z`, `ab`); run it against an
 *    en_US Postgres to see it fail.
 *  - Seam: none. Rows are seeded through the typed journal and claim-store members where the case runs on Rust, and
 *    through raw SQL where it still stops there (persistence tables only the managed lifecycle writes); the readers run
 *    unchanged.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { seedTypedEffects, seedTypedRequest, settleTypedEffects } from '../helpers/persistence-typed-seed.ts';
import { seedHostBinding, seedSource, seedSourceBinding, seedWorktree } from './persistence-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import { withEnv } from '../helpers/with-env.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from '../../src/core/engine-sql/persistence-journal.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { ATOM_REEXTRACT_RETIRED_BY } from '../../src/core/persistence/atom-retirement-hold.ts';
import { orphanConnectorCheckpoints } from '../../src/core/persistence/connector-checkpoint-migration.ts';
import { hostIdentityMismatches } from '../../src/core/persistence/consumer-diagnostics.ts';
import { deactivationBlockers, physicalRootBlockers, deactivatePersistence } from '../../src/core/persistence/deactivation.ts';
import { readDerivedOriginParks, DERIVED_ORIGIN_PARK_OP } from '../../src/core/persistence/derived-origin-hold.ts';
import { readWriterDiagnostics } from '../../src/core/persistence/diagnostics.ts';
import { auditDriftConflicts } from '../../src/core/persistence/drift-conflicts.ts';
import { readStalledCatchups } from '../../src/core/persistence/effect-catchup.ts';
import { retryParkedEffects } from '../../src/core/persistence/effect-retry.ts';
import { retryParkedPushes } from '../../src/core/persistence/git-durability-administration.ts';
import { planGitDurabilityCatchUp, DURABILITY_NOT_ENABLED_REASON } from '../../src/core/persistence/git-durability-policy.ts';
import { readGitPushHolds } from '../../src/core/persistence/git-push-holds.ts';
import { graduationBlockers } from '../../src/core/persistence/graduation-drain.ts';
import { stampHeldHits } from '../../src/core/persistence/held-reads.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { readLandingGaps } from '../../src/core/persistence/landing-gaps.ts';
import { inspectLegacyWriterLocks } from '../../src/core/persistence/legacy-locks.ts';
import { classifyManagedSyncOrphans } from '../../src/core/persistence/managed-sync-orphans.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids the validator accepts (lower case, digits and `-`): en_US sorts them `ab, a-y, a-z`; bytes put `ab` last. */
const MIXED_SRC = ['ab', 'a-z', 'a-y'] as const;
const BYTE_SRC = ['a-y', 'a-z', 'ab'] as const;

/** Runs `run` with a private GBRAIN_HOME, so the host identity file and locks never touch the real one. */
async function inHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-collate-pa-'));
  try { return await withEnv({ GBRAIN_HOME: home }, () => run(home)); } finally { rmSync(home, { recursive: true, force: true }); }
}

async function addSource(engine: BrainEngine, id: string): Promise<string> {
  const [row] = await engine.executeRaw<{ incarnation: string }>(
    'INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT (id) DO UPDATE SET name=sources.name RETURNING incarnation::text AS incarnation', [id]);
  return row!.incarnation;
}

async function addWorktree(engine: BrainEngine, owner: string | null = null, state = 'active'): Promise<string> {
  const [row] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id,state) VALUES($1::uuid,$2) RETURNING id::text AS id', [owner, state]);
  return row!.id;
}

async function bind(engine: BrainEngine, sourceId: string, incarnation: string, worktreeId: string, relativePath = ''): Promise<void> {
  await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id,relative_path) VALUES($1,$2::uuid,$3::uuid,$4)',
    [sourceId, incarnation, worktreeId, relativePath]);
}

interface SeedRequest {
  source: string; incarnation: string; slug?: string; state?: string; operation?: string; errorCode?: string | null; intent?: Record<string, unknown> | null;
  completed?: boolean; worktree?: string | null; completedAt?: string;
}

/** One persistence_requests row (a terminal one by default), written the way the managed journal does: inside a transaction at protocol 2. */
async function seedRequest(engine: BrainEngine, r: SeedRequest): Promise<{ id: string; requestId: string }> {
  const requestId = randomUUID();
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    const [row] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,intent,error_code,worktree_id,completed_at)
      VALUES ('local_cli','collate',$1::uuid,$2,$3,$4::uuid,$5,'x','{}'::jsonb,0,0,$6,$7::text::jsonb,$8,$9::uuid,${(r.completed ?? true) ? (r.completedAt ? '$10::timestamptz' : 'now()') : 'NULL'}) RETURNING id::text AS id`,
    [requestId, r.operation ?? 'put_page', r.source, r.incarnation, r.slug ?? 'notes/x', r.state ?? 'failed', r.intent === undefined ? null : JSON.stringify(r.intent),
      r.errorCode ?? null, r.worktree ?? null, ...(r.completedAt ? [r.completedAt] : [])]);
    return { id: row!.id, requestId };
  });
}

interface SeedEffect {
  request: string; kind?: string; data?: Record<string, unknown>; state?: string; errorCode?: string | null; source: string; incarnation: string;
  worktree?: string | null; outcome?: Record<string, unknown> | null;
}

/** One persistence_effects row on `request`. */
async function seedEffect(engine: BrainEngine, e: SeedEffect): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,state,error_code,source_id,source_incarnation,worktree_id,outcome)
      VALUES ($1::uuid,$2,$3::text::jsonb,$4,$5,$6,$7::uuid,$8::uuid,$9::text::jsonb)`,
    [e.request, e.kind ?? 'git', JSON.stringify(e.data ?? {}), e.state ?? 'failed', e.errorCode ?? null, e.source, e.incarnation, e.worktree ?? null, e.outcome === undefined ? null : JSON.stringify(e.outcome)]);
  });
}

/**
 * One committed request of `source` on `worktree` with one Git effect that the effect worker failed with `code`, written
 * through the journal members the managed writer uses (`insertWriteRequest`, `completeWriteRow`, `insertPublicationEffects`,
 * then a claim by the worktree's `owner` and `failEffectRow`), so every engine arm holds the same rows.
 */
async function seedFailedWorktreeEffect(engine: BrainEngine, e: { source: string; incarnation: string; worktree: string; owner: string; code: string }): Promise<void> {
  const row = await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    return tx.insertWriteRequest({
      principalKind: 'local_cli', principalId: 'collate', requestId: randomUUID(), operation: 'put_page', sourceId: e.source,
      sourceIncarnation: e.incarnation, pageId: null, slug: 'notes/x', worktreeId: e.worktree, topologyGeneration: null, digest: 'x', intent: {},
      authority: {}, intentBytes: 0, terminalReservation: 0, targetKind: 'page', protocolVersion: 1, admitterVersion: 'v-collate',
      admitterHostId: null, counterKeys: [], clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
  });
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.completeWriteRow({ id: row.id, state: 'committed', outcome: null, errorCode: null, errorMessage: null, consumerVersion: 'v-collate',
      consumerHostId: null, errorDetail: null, resultBytes: 0, counterKeys: [], intentBytes: 0, retainedBytes: 0, terminalReservation: 0, probePurges: false });
    await tx.insertPublicationEffects({ requestId: row.id, revision: null, sourceId: e.source, sourceIncarnation: e.incarnation, worktreeId: e.worktree,
      effects: [{ kind: 'git', data: {} }] });
  });
  const effect = await engine.selectClaimableEffect<{ id: string | number }>(e.owner, []);
  if (!effect) throw new Error(`seedFailedWorktreeEffect: no claimable effect on worktree ${e.worktree}`);
  const token = randomUUID();
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.stampEffectClaim({ id: effect.id, token, ownerJson: JSON.stringify({ token, owner: { pid: 1, nonce: 'collate', start: 'collate' } }) });
    await tx.failEffectRow({ id: effect.id, token, reason: e.code });
  });
}

/** Held cycle-lock leases an hour long, taken through the typed `acquireCycleLock`. */
async function typedLockRows(engine: BrainEngine, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const taken = await engine.acquireCycleLock(id, { holderPid: 2_000_000_000, holderHost: 'collate-host', acquisitionToken: randomUUID(), ttlMinutes: 60, stealGraceSeconds: 0 });
    if (!taken) throw new Error(`typedLockRows: lease ${id} was not free`);
  }
}

async function checkpoint(engine: BrainEngine, op: string, fingerprint: string, keys: unknown[] = [], updatedAt = '2020-01-01T00:00:00Z'): Promise<void> {
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,$4::timestamptz)', [op, fingerprint, JSON.stringify(keys), updatedAt]);
}

describe('legacy writer lock and cycle-lock listings sort ids by byte', () => {
  parityTest('inspectLegacyWriterLocks and the deactivation lease blockers list lock ids by byte', {
    methods: ['acquireCycleLock', 'readCycleLocks'],
  }, async (engine) => inHome(async () => {
    await typedLockRows(engine, MIXED_IDS);
    const locks = (await inspectLegacyWriterLocks(engine)).map(lock => lock.id);
    const leases = (await deactivationBlockers(engine)).filter(blocker => blocker.kind === 'lease').map(blocker => blocker.id);
    expect(locks).toEqual([...BYTE_IDS]);
    expect(leases).toEqual([...BYTE_IDS]);
    return { locks, leases };
  }));
});

describe('writer diagnostics sort counters and effect kinds by byte', () => {
  parityTest('readWriterDiagnostics lists counters by byte key and the effect summary by byte kind', {
    methods: ['lockPersistenceCounters', 'insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'readWriterDiagnosticRows'],
  }, async (engine, backend) => inHome(async () => {
    for (const key of MIXED_IDS) await engine.lockPersistenceCounters([key]);
    await createSource(engine, backend, 'ab');
    for (const kind of MIXED_IDS) {
      const request = await seedTypedRequest(engine, { source: 'ab', state: 'committed' });
      await seedTypedEffects(engine, { ...request, source: 'ab' }, [{ kind }]);
    }
    const status = await readWriterDiagnostics(engine) as unknown as { counters: Array<{ key: string }>; effects: Array<{ kind: string; state: string }> };
    const counters = status.counters.map(counter => counter.key);
    const kinds = status.effects.map(effect => effect.kind);
    expect(counters).toEqual([...BYTE_IDS]);
    expect(kinds).toEqual([...BYTE_IDS]);
    return { counters, kinds };
  }));
});

describe('connector, derived-origin and atom-retirement readers sort by byte', () => {
  parityTest('orphanConnectorCheckpoints lists orphans by byte op, then byte fingerprint', {
    methods: ['writeOpCheckpointRecord', 'listOrphanConnectorCheckpoints'],
  }, async (engine) => {
    for (const fingerprint of MIXED_IDS) {
      await engine.writeOpCheckpointRecord('managed-connector', fingerprint, []);
      await engine.writeOpCheckpointRecord('managed-connector-retry', fingerprint, [{ checkpointKey: `k-${fingerprint}` }]);
    }
    const rows = await orphanConnectorCheckpoints(engine);
    const listed = rows.map(row => `${row.op}:${row.fingerprint}`);
    const limited = (await orphanConnectorCheckpoints(engine, { limit: 3 })).map(row => `${row.op}:${row.fingerprint}`);
    expect(listed).toEqual([...BYTE_IDS.map(id => `managed-connector:${id}`), ...BYTE_IDS.map(id => `managed-connector-retry:${id}`)]);
    expect(limited).toEqual(listed.slice(0, 3));
    return { listed, limited };
  });

  parityTest('readDerivedOriginParks lists parks oldest first, ties by fingerprint', {
    methods: ['putPage', 'softDeletePage', 'writeOpCheckpointRecords', 'listDerivedOriginParks'],
  }, async (engine) => {
    const ids: number[] = [];
    for (const slug of ['collate/one', 'collate/two', 'collate/three']) {
      const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '' });
      await engine.softDeletePage(slug);
      ids.push(Number(page.id));
    }
    // Every park is written by one statement, so all share one timestamp and the fingerprint breaks the tie. Page ids
    // are decimal text, which orders the same by byte or locale.
    await engine.writeOpCheckpointRecords(DERIVED_ORIGIN_PARK_OP, ids.map(id => ({ fingerprint: String(id), record: { page_id: id } })));
    const parks = (await readDerivedOriginParks(engine)).map(park => park.page_id);
    expect(parks).toEqual(byteOrder(ids.map(String)).map(Number));
    return parks.length;
  });

  parityTest('atomRetirementsSql keeps the byte-latest retirement of an origin as the latest', {
    methods: ['putPage', 'softDeletePage', 'listRestorableAtoms', 'countKeptAtomRetirements'],
  }, async (engine) => {
    const put = (slug: string, type: string, frontmatter: Record<string, unknown>) =>
      engine.putPage(slug, { type: type as never, title: slug, compiled_truth: 'x', timeline: '', frontmatter }, { sourceId: 'default' });
    await put('notes/origin', 'note', {});
    const retire = async (slug: string, hash: string, retiredAt: string) => {
      await put(slug, 'atom', { retired_by: ATOM_REEXTRACT_RETIRED_BY, source_slug: 'notes/origin', source_hash: hash, retired_at: retiredAt });
      await engine.softDeletePage(slug, { sourceId: 'default' });
    };
    // en_US puts `ab` before `a-z`, so a descending locale sort would pick `a-z`; bytes pick `ab`. The restorable atom
    // is the latest retirement of its origin (atomRetirementsSql's `latest`); the other counts as an older generation.
    await retire('atoms/older', 'hash-older', 'a-z');
    await retire('atoms/newer', 'hash-newer', 'ab');
    const latest = (await engine.listRestorableAtoms(['default'], null)).map(row => row.slug);
    const kept = await engine.countKeptAtomRetirements(['default']);
    expect({ latest, kept }).toEqual({ latest: ['atoms/newer'], kept: { origin_gone: 0, replaced: 0, older_generation: 1 } });
    return { latest, kept };
  });
});

describe('drift, stalled-effect and retry listings sort by byte', () => {
  parityTest('auditDriftConflicts pages slugs by byte through its keyset cursor and lists producers by byte', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'listDriftConflictGroups', 'readDriftConflictDetails'],
  }, async (engine, backend) => inHome(async () => {
    await createSource(engine, backend, 'ab');
    for (const slug of MIXED_SLUGS) {
      for (const operation of ['ab', 'a-z']) await seedTypedRequest(engine, { source: 'ab', slug, operation, state: 'conflict', errorCode: 'source_changed' });
    }
    const access = { trusted: true, excludePrivate: false };
    const pages: string[][] = [];
    const producers: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard++) {
      const report = await auditDriftConflicts(engine, 'ab', access, { limit: 1, ...(cursor ? { cursor } : {}) });
      pages.push(report.conflicts.map(row => row.slug));
      producers.push(...report.conflicts.map(row => row.producers));
      if (!report.next) { expect(report.complete).toBe(true); break; }
      cursor = report.next;
    }
    expect(pages).toEqual(BYTE_SLUGS.map(slug => [slug]));
    expect(producers).toEqual(BYTE_SLUGS.map(() => ['a-z', 'ab']));
    return { pages, producers };
  }));

  parityTest('auditDriftConflicts keeps byte-distinct slugs that a locale ranks as near-equal in separate groups', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'listDriftConflictGroups'],
  }, async (engine, backend) => inHome(async () => {
    // A soft hyphen (U+00AD) that a locale ignores, and NFC `é` beside NFD `e` + U+0301: distinct bytes that en_US ranks
    // as near-equal (equal at its first levels). The audit groups by `slug COLLATE "C"` (v350): each slug must stay its own
    // group with its own receipt count, its exact bytes and its byte position, as the default-collation grouping gave.
    const counts = new Map<string, number>([['notes/ab', 1], ['notes/a\u00adb', 2], ['notes/caf\u00e9', 3], ['notes/cafe\u0301', 4]]);
    await createSource(engine, backend, 'ab');
    for (const [slug, receipts] of counts) {
      for (let n = 0; n < receipts; n++) await seedTypedRequest(engine, { source: 'ab', slug, state: 'conflict', errorCode: 'source_changed' });
    }
    const access = { trusted: true, excludePrivate: false };
    const rows: Array<{ slug: string; receipts: number }> = [];
    let cursor: string | undefined;
    let totals: { slugs: number; receipts: number } | undefined;
    for (let guard = 0; guard < 6; guard++) {
      const report = await auditDriftConflicts(engine, 'ab', access, { limit: 1, ...(cursor ? { cursor } : {}) });
      totals ??= { slugs: report.totals.slugs, receipts: report.totals.receipts };
      rows.push(...report.conflicts.map(row => ({ slug: row.slug, receipts: row.receipts })));
      if (!report.next) { expect(report.complete).toBe(true); break; }
      cursor = report.next;
    }
    const expected = byteOrder([...counts.keys()]);
    expect(expected).toEqual(['notes/ab', 'notes/a\u00adb', 'notes/cafe\u0301', 'notes/caf\u00e9']);
    expect(rows.map(row => Buffer.from(row.slug, 'utf8').toString('hex'))).toEqual(expected.map(slug => Buffer.from(slug, 'utf8').toString('hex')));
    expect(rows.map(row => row.receipts)).toEqual(expected.map(slug => counts.get(slug)!));
    expect(totals).toEqual({ slugs: 4, receipts: 10 });
    return { rows, totals };
  }));

  parityTest('readStalledCatchups lists stalled sources by byte id', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'retryBusyEffectRow', 'listStalledCatchupRows'],
  }, async (engine, backend) => {
    for (const id of MIXED_SRC) {
      await createSource(engine, backend, id);
      const request = await seedTypedRequest(engine, { source: id, state: 'committed' });
      await seedTypedEffects(engine, { ...request, source: id }, [{ kind: 'git' }]);
    }
    // Each effect found its writer busy for an hour, as the worker records it.
    await settleTypedEffects(engine, () => ({ to: 'busy', data: { busy_since: new Date(Date.now() - 3_600_000).toISOString(), busy_retries: 2 } }));
    const stalled = (await readStalledCatchups(engine, undefined, 1000)).map(row => row.source_id);
    expect(stalled).toEqual([...BYTE_SRC]);
    return stalled;
  });

  parityTest('retryParkedEffects lists a request\'s tracked effects by byte kind', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'failEffectRow', 'listSourceRequestsByRequestId', 'listRetryTrackedEffects', 'lockEffectRow'],
  }, async (engine, backend) => inHome(async () => {
    localHostId();
    await createSource(engine, backend, 'ab');
    const request = await seedTypedRequest(engine, { source: 'ab', state: 'committed' });
    await seedTypedEffects(engine, { ...request, source: 'ab' }, MIXED_IDS.map(kind => ({ kind })));
    await settleTypedEffects(engine, () => ({ to: 'failed', reason: 'effect_failed' }));
    const report = await retryParkedEffects(engine, 'ab', request.requestId, true) as { effects: Array<{ kind: string }> } | null;
    const kinds = report!.effects.map(effect => effect.kind);
    expect(kinds).toEqual([...BYTE_IDS]);
    return kinds;
  }));
});

describe('the typed retry and held-hit reads sort by byte', () => {
  parityTest('the parked-effect retry reads find one source\'s request and list its tracked effects by byte kind', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'failEffectRow', 'readSourceRequestById',
      'listSourceRequestsByRequestId', 'listRetryTrackedEffects', 'lockEffectRow', 'transaction'],
  }, async (engine, backend) => {
    for (const id of ['ab', 'a-z']) await createSource(engine, backend, id);
    const request = await seedTypedRequest(engine, { source: 'ab', state: 'committed' });
    await seedTypedEffects(engine, { ...request, source: 'ab' }, MIXED_IDS.map(kind => ({ kind })));
    await settleTypedEffects(engine, () => ({ to: 'failed', reason: 'effect_failed' }));
    const byRequestId = await engine.listSourceRequestsByRequestId<{ id: string }>('ab', request.requestId);
    const otherSource = await engine.listSourceRequestsByRequestId('a-z', request.requestId);
    const byId = await engine.readSourceRequestById('ab', request.id) as { request_id: string } | null;
    const tracked = await engine.listRetryTrackedEffects<{ id: string | number; kind: string; state: string }>(request.id, false, []);
    const parkedOnly = await engine.listRetryTrackedEffects(request.id, true, []);
    const locked = await engine.transaction(tx => tx.lockEffectRow(tracked[0]!.id)) as { kind: string; error_code: string | null } | null;
    const out = {
      byRequestId: byRequestId.map(row => row.id === request.id), otherSource: otherSource.length, byId: byId?.request_id === request.requestId,
      tracked: tracked.map(row => `${row.kind}:${row.state}`), parkedOnly: parkedOnly.length, locked: locked && `${locked.kind}:${locked.error_code}`,
    };
    expect(out).toEqual({ byRequestId: [true], otherSource: 0, byId: true, tracked: BYTE_IDS.map(kind => `${kind}:failed`), parkedOnly: 0, locked: `${BYTE_IDS[0]}:effect_failed` });
    return out;
  });

  parityTest('readHeldHitRows lists a hit\'s holds by byte fingerprint and counts the holds that could affect the read', {
    methods: ['putPage', 'readSourceMembership', 'writeOpCheckpointRecord', 'readHeldHitRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    const { incarnation } = (await engine.readSourceMembership('ab'))!;
    const pageOf = async (slug: string, type: 'note' | 'meeting', title: string) => Number((await engine.putPage(slug, { type, title, compiled_truth: 'x', timeline: '' }, { sourceId: 'ab' })).id);
    const hit = await pageOf('notes/hit', 'note', 'Hit');
    const meeting = await pageOf('notes/meeting', 'meeting', 'Meeting');
    const worded = await pageOf('notes/worded', 'note', 'The Alpha plan');
    const other = await pageOf('notes/other', 'note', 'Alphabet');
    const hold = (path: string, page: number) => engine.writeOpCheckpointRecord(GIT_HOLD_OP, `ab:${incarnation}:${path}`,
      [{ version: 1, source_id: 'ab', incarnation, path, page_id: page, held_at: path, code: 'invalid_frontmatter' }]);
    for (const path of MIXED_IDS) await hold(path, hit);
    await hold('m', meeting);
    await hold('w', worded);
    await hold('o', other);
    const rows = await engine.readHeldHitRows({ pageIds: [String(hit)], sourceIds: ['ab'], types: ['meeting'],
      patterns: ['(^|[^[:alnum:]])alpha([^[:alnum:]]|$)'] }) as Array<{ record: { path: string } | null; revision: string | null; could_affect: number | string | null }>;
    const holds = rows.filter(row => row.record);
    const out = { paths: holds.map(row => row.record!.path), revisions: holds.every(row => typeof row.revision === 'string'),
      couldAffect: Number(rows.at(-1)!.could_affect) };
    // Every hold of the hit, the meeting page and the whole word `alpha`; `Alphabet` is no match.
    expect(out).toEqual({ paths: [...BYTE_IDS], revisions: true, couldAffect: MIXED_IDS.length + 2 });
    return out;
  });
});

describe('git durability and push-hold readers sort by byte', () => {
  parityTest('retryParkedPushes lists the requests it refused by byte source id', {
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => {
    const worktree = await addWorktree(engine, localHostId());
    for (const id of MIXED_SRC) {
      const incarnation = await addSource(engine, id);
      const request = await seedRequest(engine, { source: id, incarnation, state: 'committed', worktree });
      // An effect recorded under another incarnation of the source is refused `source_changed`, so each request lands in `refused`.
      await seedEffect(engine, { request: request.id, source: id, incarnation: randomUUID(), worktree, state: 'failed', errorCode: 'git_push_unavailable' });
    }
    const report = await retryParkedPushes(engine, worktree, true);
    const refused = report.refused.map(entry => entry.source_id);
    expect(report.requests).toBe(MIXED_SRC.length);
    expect(refused).toEqual([...BYTE_SRC]);
    return refused;
  }));

  parityTest('planGitDurabilityCatchUp lists the skipped Git effects by byte relative path, the newest of each path', {
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => {
    const incarnation = await addSource(engine, 'ab');
    const worktree = await addWorktree(engine);
    const planned = new Map<string, string>();
    for (const path of [...MIXED_IDS, MIXED_IDS[0]]) {
      const request = await seedRequest(engine, { source: 'ab', incarnation, state: 'committed', worktree });
      await seedEffect(engine, { request: request.id, source: 'ab', incarnation, worktree, state: 'committed', data: { relative_path: path, slug: `notes/${path}` },
        outcome: { reason: DURABILITY_NOT_ENABLED_REASON } });
      planned.set(path, request.id);
    }
    const effects = await planGitDurabilityCatchUp(engine, { worktree_id: worktree, source_id: 'ab', source_incarnation: incarnation });
    const paths = effects.map(effect => effect.relative_path);
    expect(paths).toEqual([...BYTE_IDS]);
    expect(effects.find(effect => effect.relative_path === MIXED_IDS[0])!.request_id).toBe(planned.get(MIXED_IDS[0]!)!);
    return paths;
  });

  parityTest('readGitPushHolds lists holds by byte source id and names the byte-first local path as the root', {
    methods: ['worktreeClaimStore', 'insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'selectClaimableEffect',
      'stampEffectClaim', 'failEffectRow', 'listGitPushHoldRows'],
  }, async (engine, backend) => {
    for (const id of MIXED_SRC) {
      const incarnation = await seedSource(engine, backend, id);
      // The worktree has an owner, so the effect worker's claim (`selectClaimableEffect` by owner host) can fail its effects.
      const owner = randomUUID();
      const worktree = await seedWorktree(engine, owner);
      await seedSourceBinding(engine, id, incarnation, worktree);
      // One checkout path per host of the worktree: the reader names the byte-first one.
      for (const path of MIXED_IDS) await seedHostBinding(engine, worktree, randomUUID(), `/collate/${path}`);
      for (const code of ['push_unconfirmed', 'git_push_unavailable']) {
        await seedFailedWorktreeEffect(engine, { source: id, incarnation, worktree, owner, code });
      }
    }
    const holds = await readGitPushHolds(engine);
    expect(holds.map(hold => hold.source_id)).toEqual([...BYTE_SRC]);
    expect(holds.map(hold => hold.root)).toEqual(BYTE_SRC.map(() => `/collate/${BYTE_IDS[0]}`));
    expect(holds.map(hold => hold.codes)).toEqual(BYTE_SRC.map(() => ['git_push_unavailable', 'push_unconfirmed']));
    return holds.map(hold => ({ source: hold.source_id, root: hold.root, codes: hold.codes }));
  });

  parityTest('readLandingGaps lists the missing pages of a source by byte slug', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const incarnation = await addSource(engine, 'ab');
    const worktree = await addWorktree(engine);
    await bind(engine, 'ab', incarnation, worktree);
    const completedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    for (const slug of MIXED_SLUGS) {
      await seedRequest(engine, { source: 'ab', incarnation, slug, state: 'committed', worktree, intent: { kind: 'managed_sync_import' }, completedAt });
    }
    const report = await readLandingGaps(engine, 'ab', { afterSeconds: 0 });
    expect(report.status).toBe('ok');
    const slugs = report.status === 'ok' ? report.pages.map(page => page.slug) : [];
    expect(slugs).toEqual([...BYTE_SLUGS]);
    return slugs;
  });
});

describe('topology status and blocker lists sort source ids by byte', () => {
  parityTest('writerAdminState folds bindings and legacy locks in byte order, and writer status lists bindings by byte source id', {
    methods: ['worktreeClaimStore', 'acquireCycleLock', 'readWriterAdminState'],
  }, async (engine, backend) => inHome(async () => withEnv({ GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
    for (const id of MIXED_SRC) await seedSourceBinding(engine, id, await seedSource(engine, backend, id), await seedWorktree(engine));
    await typedLockRows(engine, MIXED_IDS);
    // The admin state is a hash, so read the document it hashes: the typed member returns the one statement's JSON text.
    await writerAdminState(engine);
    const document = await engine.readWriterAdminState();
    const state = JSON.parse(document) as { bindings: unknown[][]; legacy_locks: unknown[][] };
    const folded = { bindings: state.bindings.map(row => row[0]), locks: state.legacy_locks.map(row => row[0]) };
    expect(folded).toEqual({ bindings: [...BYTE_SRC], locks: [...BYTE_IDS] });
    try {
      const status = await runPersistenceAdministration(engine, 'writer_status', {}) as { bindings: Array<{ source_id: string }> };
      const listed = status.bindings.map(row => row.source_id);
      expect(listed).toEqual([...BYTE_SRC]);
      return { folded, listed };
    } finally { await disposePersistenceConsumer(engine); }
  })));

  parityTest('hostIdentityMismatches lists the sources of a foreign worktree by byte id', {
    methods: ['worktreeClaimStore', 'listOwnerBindings'],
  }, async (engine, backend) => {
    const owner = randomUUID();
    const worktree = await seedWorktree(engine, owner);
    await seedHostBinding(engine, worktree, owner, '/collate/foreign');
    for (const id of MIXED_SRC) await seedSourceBinding(engine, id, await seedSource(engine, backend, id), worktree, id);
    const me = { id: randomUUID(), path: '/collate/host.json', persistence_home: '/collate/home', minted_under: { machine_id: 'collate-machine', home: 'a', gbrain_home: 'b', hostname: 'collate' } };
    const found = await hostIdentityMismatches(engine, me as never, { exists: () => true, marked: () => true, hostJsonMintedAt: Date.now() + 1_000_000 });
    expect(found.length).toBe(1);
    expect(found[0]!.source_ids).toEqual([...BYTE_SRC]);
    return found[0]!.source_ids;
  });

  /** One worktree per MIXED_SRC id owned by this host, bound at a missing path, with further hosts bound to `ab`'s worktree, written through the typed claim store. */
  async function seedOwnedCheckouts(engine: BrainEngine, backend: Parameters<typeof seedSource>[1]): Promise<Map<string, string>> {
    const host = localHostId();
    const worktrees = new Map<string, string>();
    for (const id of MIXED_SRC) {
      const worktree = await seedWorktree(engine, host);
      worktrees.set(id, worktree);
      await seedSourceBinding(engine, id, await seedSource(engine, backend, id), worktree);
      await seedHostBinding(engine, worktree, host, join(tmpdir(), 'gbrain-collate-pa-missing', id));
    }
    // Further hosts bound to one worktree, so its roots list more than one path.
    for (const path of MIXED_IDS) await seedHostBinding(engine, worktrees.get('ab')!, randomUUID(), `/collate/${path}`);
    return worktrees;
  }

  parityTest('physicalRootBlockers names owned checkouts by byte source id', {
    methods: ['worktreeClaimStore', 'writerReleaseStore'],
  }, async (engine, backend) => inHome(async () => {
    await seedOwnedCheckouts(engine, backend);
    const blockers = (await physicalRootBlockers(engine, 'managed')).map(blocker => blocker.source_id);
    expect(blockers).toEqual([...BYTE_SRC]);
    return blockers;
  }));

  parityTest('the deactivation preview of a managed brain lists a worktree\'s roots by byte path', {
    methods: ['worktreeClaimStore', 'writerReleaseStore'],
  }, async (engine, backend) => inHome(async () => {
    const worktrees = await seedOwnedCheckouts(engine, backend);
    await (await engine.writerReleaseStore()).setBrainEnabled(true);
    const report = await deactivatePersistence(engine, { dryRun: true });
    const roots = report.retired_worktrees.find(entry => entry.id === worktrees.get('ab'))!.roots;
    expect(roots.filter(root => root.startsWith('/collate/'))).toEqual(BYTE_IDS.map(path => `/collate/${path}`));
    return { roots: roots.length };
  }));

  parityTest('activation lists database-only sources by byte source id, with the lock query left in plain id order', {
    methods: ['writerReleaseStore', 'setConfig'],
  }, async (engine, backend) => inHome(async (home) => {
    await (await engine.writerReleaseStore()).setBrainEnabled(false);
    await engine.setConfig('sync.write_through', 'false');
    for (const id of MIXED_SRC) {
      const root = join(home, 'roots', id);
      mkdirSync(root, { recursive: true });
      await createSource(engine, backend, id, {}, root);
    }
    const report = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true });
    const listed = (report.database_only_sources ?? []).filter(id => (MIXED_SRC as readonly string[]).includes(id));
    expect(listed).toEqual([...BYTE_SRC]);
    return listed;
  }));

  parityTest('graduationBlockers names the byte-first source of a foreign worktree', {
    methods: ['worktreeClaimStore', 'listGraduationPendingRequests', 'listGraduationTopologyRecoveries', 'listGraduationEffectRecoveries',
      'listForeignHostBindings', 'hasOAuthBoundSourceColumn', 'listDanglingOAuthClients'],
  }, async (engine, backend) => {
    const worktree = await seedWorktree(engine, randomUUID());
    for (const id of MIXED_SRC) await seedSourceBinding(engine, id, await seedSource(engine, backend, id), worktree, id);
    await seedHostBinding(engine, worktree, randomUUID(), '/collate/foreign');
    const blockers = await graduationBlockers(engine, randomUUID());
    const foreign = blockers.find(blocker => blocker.kind === 'foreign_host_binding' && blocker.id.includes(':'))!;
    expect(foreign.argv![5]).toBe(BYTE_SRC[0]);
    expect(blockers.filter(blocker => blocker.kind === 'dangling_reference')).toEqual([]);
    return { source: foreign.argv![5], kinds: blockers.map(blocker => blocker.kind) };
  });

  // A known engine difference, named here and in RUST_ENGINE.md row 69: PGLite has no foreign key on
  // oauth_clients.bound_source_id (v085's sqlFor.pglite skips it), so a deleted source leaves its clients bound to a gone
  // id, which graduation then reports. Postgres (fk_oauth_clients_bound_source, ON DELETE SET NULL) and the Rust store
  // (jobs/oauth_clients.rs remove_source_rows) clear the binding. The case asserts that per engine family, and on every
  // arm that the dangling-client read and the graduation blockers name exactly the clients whose bound source is gone.
  parityTest('removing a source through deleteSourceRecord clears its OAuth clients\' binding on Postgres and Rust and keeps it on PGLite, and the dangling reads name exactly the clients left bound to a gone source', {
    methods: ['insertOauthClient', 'deleteSourceRecord', 'readOauthClient', 'hasOAuthBoundSourceColumn', 'listDanglingOAuthClients'],
  }, async (engine, backend) => {
    for (const id of MIXED_SRC) {
      await createSource(engine, backend, id);
      await engine.insertOauthClient({ client_id: `c-${id}`, client_name: `c-${id}`, scope: 'agents', bound_tools: null, source_id: null,
        bound_source_id: id, federated_read: [], delegated_namespace: 'prefixes', delegated_slug_prefixes: null, bound_max_concurrent: 1 } as never);
    }
    const removed = await engine.deleteSourceRecord('a-z');
    const live = new Set<string>(MIXED_SRC.filter(id => id !== 'a-z'));
    const bound = new Map<string, string | null>();
    for (const id of MIXED_SRC) {
      const row = await engine.readOauthClient(`c-${id}`) as { bound_source_id?: string | null } | null;
      bound.set(`c-${id}`, row?.bound_source_id ?? null);
    }
    const keptOnPglite = engine.kind === 'pglite';
    expect({ engine: engine.kind, binding: bound.get('c-a-z') }, keptOnPglite
      ? 'PGLite keeps a deleted source\'s bound_source_id (no foreign key on PGLite, RUST_ENGINE.md row 69)'
      : 'Postgres and Rust clear a deleted source\'s bound_source_id (ON DELETE SET NULL)')
      .toEqual({ engine: engine.kind, binding: keptOnPglite ? 'a-z' : null });
    const gone = [...bound].filter(([, source]) => source !== null && !live.has(source)).map(([client]) => client).sort();
    const dangling = (await engine.listDanglingOAuthClients()).map(c => c.client_id);
    const blockers = (await graduationBlockers(engine, randomUUID())).filter(blocker => blocker.kind === 'dangling_reference').map(blocker => blocker.id);
    expect({ dangling, blockers }).toEqual({ dangling: gone, blockers: gone.map(client => `oauth_clients.${client}`) });
    return { removed, others: ['c-ab', 'c-a-y'].map(client => bound.get(client)), danglingIsGone: true, blockersAreGone: true };
  });

  // The Rust arm's stop, by design (RUST_ENGINE.md row 67): an OAuth client bound to a source that does not exist is a
  // state only an unchecked SQL write makes (the rows go in with session_replication_role = replica). The Rust store
  // checks the reference and clears it when its source is removed, so it never holds one; the fixture is raw SQL.
  parityTest('graduationBlockers lists dangling OAuth clients by byte client id', {
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => {
    // An OAuth client bound to a source that does not exist (an FK only Postgres enforces, so the rows are written with it off).
    await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      for (const id of MIXED_IDS) await tx.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,bound_source_id) VALUES($1,$1,'gone-source')`, [id]);
    });
    const blockers = await graduationBlockers(engine, randomUUID());
    const clients = blockers.filter(blocker => blocker.kind === 'dangling_reference').map(blocker => blocker.id);
    expect(clients).toEqual(BYTE_IDS.map(id => `oauth_clients.${id}`));
    return clients;
  });
});

describe('held-read and managed-sync orphan readers sort by byte', () => {
  parityTest('stampHeldHits stamps a page from its byte-first hold', {
    methods: ['putPage', 'readSourceMembership', 'writeOpCheckpointRecord', 'readHeldCoverageRows', 'readHeldHitRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    const { incarnation } = (await engine.readSourceMembership('ab'))!;
    const page = await engine.putPage('notes/held', { type: 'note', title: 'held', compiled_truth: 'x', timeline: '' }, { sourceId: 'ab' });
    await engine.writeOpCheckpointRecord(GIT_HOLD_SUMMARY_OP, `ab:${incarnation}`, [{ count: 2, stale: 2 }]);
    // Two holds on one page: the first row read sets the stamp, and the byte-first fingerprint (`a-z`) is the 2020 hold.
    for (const [path, heldAt] of [['ab', '2021-01-01T00:00:00.000Z'], ['a-z', '2020-01-01T00:00:00.000Z']] as const) {
      await engine.writeOpCheckpointRecord(GIT_HOLD_OP, `ab:${incarnation}:${path}`, [{ version: 1, source_id: 'ab', incarnation, path, page_id: Number(page.id), held_at: heldAt, code: 'invalid_frontmatter' }]);
    }
    const hits: Array<{ page_id: number; stale?: { held_since: string; last_indexed_revision: string | null } }> = [{ page_id: Number(page.id) }];
    await stampHeldHits(engine, hits, { sourceId: 'ab' }, { all: false, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false });
    expect(hits[0]!.stale?.held_since).toBe('2020-01-01T00:00:00.000Z');
    return hits[0]!.stale?.held_since;
  });

  parityTest('classifyManagedSyncOrphans lists cursors and failure rows of one source by byte key', {
    methods: ['readSourceMembership', 'writeOpCheckpointRecords', 'listManagedSyncOrphanRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    const { incarnation } = (await engine.readSourceMembership('ab'))!;
    const retired = randomUUID();
    const keys = (prefix: string) => MIXED_IDS.map(id => `${prefix}-${id}`);
    // Every row of one kind is written by one statement, so all share one timestamp and the key breaks the tie.
    const rows = (prefix: string, record: Record<string, unknown>) => keys(prefix).map(fingerprint => ({ fingerprint, record }));
    await engine.writeOpCheckpointRecords('managed-sync', [...rows('live', { sourceId: 'ab', incarnation, runId: 'run-live', done: false }),
      ...rows('gone', { sourceId: 'ab', incarnation: retired, runId: 'run-gone', done: false })]);
    await engine.writeOpCheckpointRecords('managed-sync-failure', [...rows('fail', { source_id: 'ab', source_incarnation: incarnation, run_id: 'run-fail' }),
      ...rows('lost', { source_id: 'ab', source_incarnation: retired, run_id: 'run-lost' })]);
    const { orphans } = await classifyManagedSyncOrphans(engine);
    const by = (kind: string, reason: string) => orphans.filter(orphan => orphan.kind === kind && orphan.reason === reason).map(orphan => orphan.cursor_key);
    const listed = { cursors: by('unfinished_cursor', 'principal_unadoptable'), retiredCursors: by('unfinished_cursor', 'incarnation_retired'),
      failures: by('failure_row', 'no_cursor'), retiredFailures: by('failure_row', 'incarnation_retired') };
    expect(listed.cursors).toEqual(byteOrder(keys('live')));
    expect(listed.retiredCursors).toEqual(byteOrder(keys('gone')));
    expect(listed.failures).toEqual(byteOrder(keys('fail')));
    expect(listed.retiredFailures).toEqual(byteOrder(keys('lost')));
    return listed;
  });
});
