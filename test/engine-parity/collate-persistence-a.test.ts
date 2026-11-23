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
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1, where each case stops on the typed raw_sql
 *    refusal): byte order, as PGLite sorts and as Postgres sorts with `COLLATE "C"`.
 *  - Regression: on an en_US Postgres these reads sorted by the locale, which skips punctuation (`ab` before `a-z`), so a
 *    status list, a blocker list, a refusal naming "the first" source, a stale stamp taken from "the first" hold, and the
 *    drift audit's `next` cursor came back in another order than on PGLite, and a page crossing a cursor could repeat or vanish.
 *  - Why existing coverage misses it: the cases used ids that sort the same in every locale, and CI's Postgres runs in
 *    C.UTF-8. Every case here mixes `a-z`, `ab`, `a.b` and `a_b` (or the slug-safe `a-z`, `a/z`, `ab`); run it against an
 *    en_US Postgres to see it fail.
 *  - Seam: none. Rows are seeded through raw SQL for persistence tables that only the managed lifecycle writes; the readers
 *    run unchanged.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { seedHostBinding, seedSource, seedSourceBinding, seedWorktree } from './persistence-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from '../../src/core/engine-sql/persistence-journal.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { atomRetirementsSql, ATOM_REEXTRACT_RETIRED_BY } from '../../src/core/persistence/atom-retirement-hold.ts';
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

async function hostBind(engine: BrainEngine, worktreeId: string, hostId: string, localPath: string): Promise<void> {
  await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)',
    [worktreeId, hostId, localPath, `${localPath}.lock`]);
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

async function lockRows(engine: BrainEngine, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,ttl_expires_at) VALUES ($1,$2,'collate-host',now()+interval '1 hour')`, [id, 2_000_000_000]);
  }
}

async function checkpoint(engine: BrainEngine, op: string, fingerprint: string, keys: unknown[] = [], updatedAt = '2020-01-01T00:00:00Z'): Promise<void> {
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,$4::timestamptz)', [op, fingerprint, JSON.stringify(keys), updatedAt]);
}

describe('legacy writer lock and cycle-lock listings sort ids by byte', () => {
  parityTest('inspectLegacyWriterLocks and the deactivation lease blockers list lock ids by byte', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => {
    await lockRows(engine, MIXED_IDS);
    const locks = (await inspectLegacyWriterLocks(engine)).map(lock => lock.id);
    const leases = (await deactivationBlockers(engine)).filter(blocker => blocker.kind === 'lease').map(blocker => blocker.id);
    expect(locks).toEqual([...BYTE_IDS]);
    expect(leases).toEqual([...BYTE_IDS]);
    return { locks, leases };
  }));
});

describe('writer diagnostics sort counters and effect kinds by byte', () => {
  parityTest('readWriterDiagnostics lists counters by byte key and the effect summary by byte kind', {
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => {
    for (const key of MIXED_IDS) await engine.executeRaw('INSERT INTO persistence_counters(key) VALUES($1)', [key]);
    const incarnation = await addSource(engine, 'ab');
    for (const kind of MIXED_IDS) {
      const request = await seedRequest(engine, { source: 'ab', incarnation, state: 'committed' });
      await seedEffect(engine, { request: request.id, kind, source: 'ab', incarnation, state: 'queued' });
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
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    for (const fingerprint of MIXED_IDS) {
      await checkpoint(engine, 'managed-connector', fingerprint);
      await checkpoint(engine, 'managed-connector-retry', fingerprint, [{ checkpointKey: `k-${fingerprint}` }]);
    }
    const rows = await orphanConnectorCheckpoints(engine);
    const listed = rows.map(row => `${row.op}:${row.fingerprint}`);
    const limited = (await orphanConnectorCheckpoints(engine, { limit: 3 })).map(row => `${row.op}:${row.fingerprint}`);
    expect(listed).toEqual([...BYTE_IDS.map(id => `managed-connector:${id}`), ...BYTE_IDS.map(id => `managed-connector-retry:${id}`)]);
    expect(limited).toEqual(listed.slice(0, 3));
    return { listed, limited };
  });

  parityTest('readDerivedOriginParks lists parks oldest first, ties by fingerprint', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const ids: number[] = [];
    for (const slug of ['collate/one', 'collate/two', 'collate/three']) {
      const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth,deleted_at) VALUES($1,'note',$1,'x',now()) RETURNING id`, [slug]);
      ids.push(Number(page!.id));
    }
    // Every park shares one timestamp, so the fingerprint breaks the tie. Page ids are decimal text, which orders the same by byte or locale.
    for (const id of ids) await checkpoint(engine, DERIVED_ORIGIN_PARK_OP, String(id), [{ page_id: id }], '2021-01-01T00:00:00Z');
    const parks = (await readDerivedOriginParks(engine)).map(park => park.page_id);
    expect(parks).toEqual(byteOrder(ids.map(String)).map(Number));
    return parks.length;
  });

  parityTest('atomRetirementsSql keeps the byte-latest retirement of an origin as the latest', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const retire = async (slug: string, hash: string, retiredAt: string) => {
      await engine.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,frontmatter,deleted_at) VALUES($1,'atom',$1,'x',$2::text::jsonb,now())`,
        [slug, JSON.stringify({ retired_by: ATOM_REEXTRACT_RETIRED_BY, source_slug: 'notes/origin', source_hash: hash, retired_at: retiredAt })]);
    };
    // en_US puts `ab` before `a-z`, so a descending locale sort would pick `a-z`; bytes pick `ab`.
    await retire('atoms/older', 'hash-older', 'a-z');
    await retire('atoms/newer', 'hash-newer', 'ab');
    const rows = await engine.executeRaw<{ slug: string; latest: boolean }>(`SELECT slug,latest FROM (${atomRetirementsSql()}) r ORDER BY slug`);
    const latest = rows.filter(row => row.latest).map(row => row.slug);
    expect(latest).toEqual(['atoms/newer']);
    return latest;
  });
});

describe('drift, stalled-effect and retry listings sort by byte', () => {
  parityTest('auditDriftConflicts pages slugs by byte through its keyset cursor and lists producers by byte', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => {
    const incarnation = await addSource(engine, 'ab');
    for (const slug of MIXED_SLUGS) {
      for (const operation of ['ab', 'a-z']) await seedRequest(engine, { source: 'ab', incarnation, slug, operation, state: 'conflict', errorCode: 'source_changed' });
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
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => {
    // A soft hyphen (U+00AD) that a locale ignores, and NFC `é` beside NFD `e` + U+0301: distinct bytes that en_US ranks
    // as near-equal (equal at its first levels). The audit groups by `slug COLLATE "C"` (v333): each slug must stay its own
    // group with its own receipt count, its exact bytes and its byte position, as the default-collation grouping gave.
    const counts = new Map<string, number>([['notes/ab', 1], ['notes/a\u00adb', 2], ['notes/caf\u00e9', 3], ['notes/cafe\u0301', 4]]);
    const incarnation = await addSource(engine, 'ab');
    for (const [slug, receipts] of counts) {
      for (let n = 0; n < receipts; n++) await seedRequest(engine, { source: 'ab', incarnation, slug, state: 'conflict', errorCode: 'source_changed' });
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
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => {
    for (const id of MIXED_SRC) {
      const incarnation = await addSource(engine, id);
      const request = await seedRequest(engine, { source: id, incarnation, state: 'committed' });
      await seedEffect(engine, { request: request.id, source: id, incarnation, state: 'queued', errorCode: 'writer_busy',
        data: { busy_since: new Date(Date.now() - 3_600_000).toISOString(), busy_retries: 2 } });
    }
    const stalled = (await readStalledCatchups(engine, undefined, 1000)).map(row => row.source_id);
    expect(stalled).toEqual([...BYTE_SRC]);
    return stalled;
  });

  parityTest('retryParkedEffects lists a request\'s tracked effects by byte kind', {
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => {
    localHostId();
    const incarnation = await addSource(engine, 'ab');
    const request = await seedRequest(engine, { source: 'ab', incarnation, state: 'committed' });
    for (const kind of MIXED_IDS) await seedEffect(engine, { request: request.id, kind, source: 'ab', incarnation, state: 'failed', errorCode: 'effect_failed' });
    const report = await retryParkedEffects(engine, 'ab', request.requestId, true) as { effects: Array<{ kind: string }> } | null;
    const kinds = report!.effects.map(effect => effect.kind);
    expect(kinds).toEqual([...BYTE_IDS]);
    return kinds;
  }));
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
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => {
    for (const id of MIXED_SRC) {
      const incarnation = await addSource(engine, id);
      const worktree = await addWorktree(engine);
      await bind(engine, id, incarnation, worktree);
      // One checkout path per host of the worktree: the reader names the byte-first one.
      for (const path of MIXED_IDS) await hostBind(engine, worktree, randomUUID(), `/collate/${path}`);
      for (const code of ['push_unconfirmed', 'git_push_unavailable']) {
        const request = await seedRequest(engine, { source: id, incarnation, state: 'committed', worktree });
        await seedEffect(engine, { request: request.id, source: id, incarnation, worktree, state: 'failed', errorCode: code });
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
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => inHome(async () => withEnv({ GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
    for (const id of MIXED_SRC) await bind(engine, id, await addSource(engine, id), await addWorktree(engine));
    await lockRows(engine, MIXED_IDS);
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
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const owner = randomUUID();
    const worktree = await addWorktree(engine, owner);
    await hostBind(engine, worktree, owner, '/collate/foreign');
    for (const id of MIXED_SRC) await bind(engine, id, await addSource(engine, id), worktree, id);
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
    methods: ['executeRaw', 'setConfig'], requires: 'raw_sql',
  }, async (engine) => inHome(async (home) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.setConfig('sync.write_through', 'false');
    for (const id of MIXED_SRC) {
      const root = join(home, 'roots', id);
      mkdirSync(root, { recursive: true });
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
    }
    const report = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true });
    const listed = (report.database_only_sources ?? []).filter(id => (MIXED_SRC as readonly string[]).includes(id));
    expect(listed).toEqual([...BYTE_SRC]);
    return listed;
  }));

  parityTest('graduationBlockers names the byte-first source of a foreign worktree and lists dangling OAuth clients by byte client id', {
    methods: ['executeRaw', 'transaction'], requires: 'raw_sql',
  }, async (engine) => {
    const worktree = await addWorktree(engine, randomUUID());
    for (const id of MIXED_SRC) await bind(engine, id, await addSource(engine, id), worktree, id);
    await hostBind(engine, worktree, randomUUID(), '/collate/foreign');
    // An OAuth client bound to a source that does not exist (an FK only Postgres enforces, so the rows are written with it off).
    await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      for (const id of MIXED_IDS) await tx.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,bound_source_id) VALUES($1,$1,'gone-source')`, [id]);
    });
    const blockers = await graduationBlockers(engine, randomUUID());
    const foreign = blockers.find(blocker => blocker.kind === 'foreign_host_binding' && blocker.id.includes(':'))!;
    const clients = blockers.filter(blocker => blocker.kind === 'dangling_reference').map(blocker => blocker.id);
    expect(foreign.argv![5]).toBe(BYTE_SRC[0]);
    expect(clients).toEqual(BYTE_IDS.map(id => `oauth_clients.${id}`));
    return { source: foreign.argv![5], clients };
  });
});

describe('held-read and managed-sync orphan readers sort by byte', () => {
  parityTest('stampHeldHits stamps a page from its byte-first hold', {
    methods: ['executeRaw', 'readHeldCoverageRows'], requires: 'raw_sql',
  }, async (engine) => {
    const incarnation = await addSource(engine, 'ab');
    const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES('ab','notes/held','note','held','x') RETURNING id`);
    await checkpoint(engine, GIT_HOLD_SUMMARY_OP, `ab:${incarnation}`, [{ count: 2, stale: 2 }]);
    // Two holds on one page: the first row read sets the stamp, and the byte-first fingerprint (`a-z`) is the 2020 hold.
    for (const [path, heldAt] of [['ab', '2021-01-01T00:00:00.000Z'], ['a-z', '2020-01-01T00:00:00.000Z']] as const) {
      await checkpoint(engine, GIT_HOLD_OP, `ab:${incarnation}:${path}`, [{ version: 1, source_id: 'ab', incarnation, path, page_id: Number(page!.id), held_at: heldAt, code: 'invalid_frontmatter' }]);
    }
    const hits: Array<{ page_id: number; stale?: { held_since: string; last_indexed_revision: string | null } }> = [{ page_id: Number(page!.id) }];
    await stampHeldHits(engine, hits, { sourceId: 'ab' }, { all: false, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false });
    expect(hits[0]!.stale?.held_since).toBe('2020-01-01T00:00:00.000Z');
    return hits[0]!.stale?.held_since;
  });

  parityTest('classifyManagedSyncOrphans lists cursors and failure rows of one source by byte key', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const incarnation = await addSource(engine, 'ab');
    const retired = randomUUID();
    const keys = (prefix: string) => MIXED_IDS.map(id => `${prefix}-${id}`);
    // Every row of one kind shares one timestamp, so the key breaks the tie.
    for (const key of keys('live')) await checkpoint(engine, 'managed-sync', key, [{ sourceId: 'ab', incarnation, runId: 'run-live', done: false }]);
    for (const key of keys('gone')) await checkpoint(engine, 'managed-sync', key, [{ sourceId: 'ab', incarnation: retired, runId: 'run-gone', done: false }]);
    for (const key of keys('fail')) await checkpoint(engine, 'managed-sync-failure', key, [{ source_id: 'ab', source_incarnation: incarnation, run_id: 'run-fail' }]);
    for (const key of keys('lost')) await checkpoint(engine, 'managed-sync-failure', key, [{ source_id: 'ab', source_incarnation: retired, run_id: 'run-lost' }]);
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
