/**
 * BrainEngine parity — the persistence readers that list text keys (source ids, slugs, fingerprints, paths) sort them by
 * byte on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the managed-persistence doctor, sync, purge and recovery readers that return rows or name a first row in
 *    text-key order (orphan, pre-activation, freshness, movement, parked-group, terminal-failure and moved-root listings;
 *    purge selections, purge parks, sync tombstones; the reconcile audit's pages and its keyset cursor; moved-page
 *    verdicts; origin twin counts and revival refusals; manual link fences; recovery resolutions, suppressed writes,
 *    sync-failure acknowledgements and hold listings) return the same order on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1, where each case stops on the typed raw_sql refusal):
 *    byte order, as PGLite sorts and as Postgres sorts with `COLLATE "C"`.
 *  - Regression: on an en_US Postgres these reads sorted by the locale, which skips punctuation (`ab` before `a-z`), so
 *    a doctor list, a purge preview, a refusal naming "the first" source or edge, and the reconcile audit's pages and
 *    `next_after` cursor came back in another order than on PGLite, and a page crossing a cursor could repeat or vanish.
 *  - Why existing coverage misses it: the cases used ids that sort the same in every locale, and CI's Postgres runs in
 *    C.UTF-8. Every case here mixes `a-z`, `ab`, `a.b` and `a_b`; run it against an en_US Postgres to see it fail.
 *  - Seam: none. Rows are seeded through the production writers where one exists (putPage, recordPurgeFailure) and raw
 *    SQL for persistence tables that only the managed lifecycle writes; the readers run unchanged.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, enableBeliefCoverage, parityArms } from './harness.ts';
import { seedTypedEffects, seedTypedRequest, settleTypedEffects } from '../helpers/persistence-typed-seed.ts';
import { seedHostBinding, seedSource, seedSourceBinding, seedWorktree } from './persistence-fixtures.ts';

type Backend = Parameters<typeof createSource>[1];

/** Source ids every engine accepts (the Rust store takes a-z, 0-9 and -) that a locale and a byte sort still order apart. */
const SOURCE_IDS = ['ab', 'a-z', 'a-y'] as const;
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { listOrphanBindings } from '../../src/core/persistence/orphan-bindings.ts';
import { preActivationClaims } from '../../src/core/persistence/pre-activation-release.ts';
import { readSyncFreshness } from '../../src/core/persistence/sync-freshness.ts';
import { readSourceMovement } from '../../src/core/persistence/sync-movement.ts';
import { readParkedGroups } from '../../src/core/persistence/parked-groups.ts';
import { movedPhysicalRoot } from '../../src/core/persistence/physical-root.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { recordPurgeFailure, readPurgeParks, PURGE_PARK_LIMIT, purgeParkKey } from '../../src/core/persistence/purge-parks.ts';
import { selectPurgeCandidates } from '../../src/core/persistence/purge-deleted.ts';
import { readUnreviewedSyncTombstones, SYNC_DELETE_TOMBSTONE_OP } from '../../src/core/persistence/sync-delete-tombstones.ts';
import { auditCanonicalSource } from '../../src/core/persistence/reconcile-audit.ts';
import { assertRevivalUnclaimed } from '../../src/core/persistence/origin-guard.ts';
import { ORIGIN_INDEX, originTwinCounts } from '../../src/core/persistence/origin-index.ts';
import { prepareManualLinkMutation } from '../../src/core/persistence/manual-links.ts';
import { readMovedPage } from '../../src/core/persistence/moved-pages.ts';
import { readResolutions, RESOLUTION_OP } from '../../src/core/persistence/recovery-resolve.ts';
import { listSuppressedWrites } from '../../src/core/persistence/refusal-breaker.ts';
import { acknowledgeManagedSyncFailures } from '../../src/core/persistence/sync-failures.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP, readGitHoldListing } from '../../src/core/persistence/sync-holds.ts';
import { refreshWorktree } from '../../src/core/persistence/worktree-refresh.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { commitFile, git, page as refreshPage } from '../helpers/worktree-refresh-fixture.ts';
import { withTopologyLocks } from '../../src/core/persistence/topology-locks.ts';

const { parityTest } = parityArms(testBackends());

/** Runs `run` with a private GBRAIN_HOME, so the host identity file and locks never touch the real one. */
async function inHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-collate-pb-'));
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

/** bindEach through the typed seeders (persistence-fixtures.ts), so the rows land on the Rust store too. */
async function bindEachTyped(engine: BrainEngine, backend: Backend, ids: readonly string[], real: boolean): Promise<Map<string, { worktree: string; incarnation: string }>> {
  const made = new Map<string, { worktree: string; incarnation: string }>();
  for (const id of ids) {
    const incarnation = real ? await seedSource(engine, backend, id) : randomUUID();
    const worktree = await seedWorktree(engine);
    await seedSourceBinding(engine, id, incarnation, worktree);
    made.set(id, { worktree, incarnation });
  }
  return made;
}

/** One worktree per id, a binding for each, and (with `real`) a source row behind it. */
async function bindEach(engine: BrainEngine, ids: readonly string[], real: boolean): Promise<Map<string, { worktree: string; incarnation: string }>> {
  const made = new Map<string, { worktree: string; incarnation: string }>();
  for (const id of ids) {
    const incarnation = real ? await addSource(engine, id) : randomUUID();
    const worktree = await addWorktree(engine);
    await bind(engine, id, incarnation, worktree);
    made.set(id, { worktree, incarnation });
  }
  return made;
}

describe('persistence binding listings sort source ids by byte', () => {
  parityTest('listOrphanBindings lists orphan bindings by byte source id, and its limit keeps the byte-first ones', {
    methods: ['worktreeClaimStore'],
  }, async (engine, backend) => {
    await bindEachTyped(engine, backend, SOURCE_IDS, false);
    const all = (await listOrphanBindings(engine)).map(row => row.source_id);
    const limited = (await listOrphanBindings(engine, { limit: 2 })).map(row => row.source_id);
    expect(all).toEqual(byteOrder(SOURCE_IDS));
    expect(limited).toEqual(byteOrder(SOURCE_IDS).slice(0, 2));
    return { all, limited };
  });

  parityTest('listSourceBindingsForMovement lists the claimed sources by byte id, each with its worktree owner', {
    methods: ['writerReleaseStore', 'listSourceBindingsForMovement'],
  }, async (engine, backend) => inHome(async home => {
    // Source ids the validator accepts: en_US sorts them `ab, a-y, a-z`; bytes put `ab` last.
    const ids = ['ab', 'a-z', 'a-y'];
    const root = join(home, 'brains', 'root');
    for (const id of ids) mkdirSync(join(root, id), { recursive: true });
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    await withEnv({ GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await (await engine.writerReleaseStore()).setBrainEnabled(false);
      for (const id of ids) {
        await createSource(engine, backend, id, {}, join(root, id));
        await claimWorktree(engine, id, join(root, id));
      }
    });
    const host = localHostId();
    const rows = await engine.listSourceBindingsForMovement(null);
    const one = await engine.listSourceBindingsForMovement(['a-z']);
    const listed = rows.map(row => ({ source: row.source_id, owned: row.owner_host_id === host, worktree: row.worktree_id === rows[0]!.worktree_id }));
    expect(listed).toEqual(byteOrder(ids).map(source => ({ source, owned: true, worktree: true })));
    expect(one.map(row => row.source_id)).toEqual(['a-z']);
    return { listed, one: one.map(row => row.source_id) };
  }));

  parityTest('preActivationClaims, readSyncFreshness and readSourceMovement list bound sources by byte id, and a claim lists its roots by byte path', {
    methods: ['worktreeClaimStore'],
  }, async (engine, backend) => inHome(async () => {
    const made = await bindEachTyped(engine, backend, SOURCE_IDS, true);
    const host = localHostId();
    const other = randomUUID();
    const worktree = made.get('ab')!.worktree;
    await seedHostBinding(engine, worktree, host, '/collate/ab');
    await seedHostBinding(engine, worktree, other, '/collate/a-z');
    const claims = await preActivationClaims(engine as never);
    const fresh = await readSyncFreshness(engine, { behind: async () => null, commitTimes: async () => new Map() });
    const moved = await readSourceMovement(engine);
    expect(claims.map(claim => claim.source_id)).toEqual(byteOrder(SOURCE_IDS));
    expect(claims.find(claim => claim.source_id === 'ab')!.roots).toEqual(['/collate/a-z', '/collate/ab']);
    expect(fresh.map(row => row.source_id)).toEqual(byteOrder(SOURCE_IDS));
    expect(moved.map(row => row.source_id)).toEqual(byteOrder(SOURCE_IDS));
    return { claims: claims.map(claim => ({ id: claim.source_id, roots: claim.roots })), fresh: fresh.map(row => row.source_id), moved: moved.map(row => row.source_id) };
  }));
});


interface SeedRequest {
  source: string; incarnation: string; slug?: string; state?: string; operation?: string; errorCode?: string | null; intent?: Record<string, unknown> | null;
  completed?: boolean; digest?: string; worktree?: string | null; errorDetail?: Record<string, unknown> | null;
}

/** One persistence_requests row (a terminal one by default), written the way the managed journal does: inside a transaction at protocol 2. */
async function seedRequest(engine: BrainEngine, r: SeedRequest): Promise<{ id: string; requestId: string }> {
  const requestId = randomUUID();
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    const [row] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,intent,error_code,worktree_id,completed_at)
      VALUES ('local_cli','collate',$1::uuid,$2,$3,$4::uuid,$5,$6,'{}'::jsonb,0,0,$7,$8::text::jsonb,$9,$10::uuid,${(r.completed ?? true) ? 'now()' : 'NULL'}) RETURNING id::text AS id`,
    [requestId, r.operation ?? 'put_page', r.source, r.incarnation, r.slug ?? 'notes/x', r.digest ?? 'x', r.state ?? 'failed', r.intent === undefined ? null : JSON.stringify(r.intent),
      r.errorCode ?? null, r.worktree ?? null]);
    return { id: row!.id, requestId };
  });
}

describe('persistence doctor groupings sort source ids and codes by byte', () => {
  parityTest('readParkedGroups lists parked Git targets by byte source id, then byte code', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'parkEffectRow', 'listParkedGroupRows'],
  }, async (engine, backend) => {
    const codes = ['c_b', 'c-z', 'cb', 'c.b'];
    for (const id of ['ab', 'a-z']) {
      await createSource(engine, backend, id);
      const request = await seedTypedRequest(engine, { source: id, operation: 'put_page' });
      await seedTypedEffects(engine, { ...request, source: id }, [{ kind: 'git' }]);
    }
    // The worker parks each Git effect's targets, one per code.
    await settleTypedEffects(engine, () => ({ to: 'parked', data: { parked: codes.map(code => ({ slug: 'notes/x', error_code: code })) } }));
    const groups = (await readParkedGroups(engine)).map(group => `${group.source_id}:${group.code}`);
    expect(groups).toEqual(['a-z', 'ab'].flatMap(id => byteOrder(codes).map(code => `${id}:${code}`)));
    return groups;
  });
});

describe('moved-checkout members and topology refusals name sources by byte', () => {
  // managed_persistence held for callers: a moved checkout is read through the managed worktree it belongs to, which a Rust brain refuses.
  parityTest('movedPhysicalRoot lists the members of a moved checkout by byte source id', {
    methods: ['writerReleaseStore', 'worktreeClaimStore'], requires: 'managed_persistence',
  }, async (engine, backend) => inHome(async home => {
    const root = join(home, 'brains', 'old', 'root');
    const members = [...SOURCE_IDS];
    for (const id of members) mkdirSync(join(root, id), { recursive: true });
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    await withEnv({ GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await (await engine.writerReleaseStore()).setBrainEnabled(false);
      for (const id of members) {
        await seedSource(engine, backend, id, join(root, id));
        await claimWorktree(engine, id, join(root, id));
      }
      await (await engine.writerReleaseStore()).setBrainEnabled(true);
    });
    const moved = join(home, 'brains', 'moved-root');
    renameSync(root, moved);
    const found = await movedPhysicalRoot(engine as never, moved, localHostId());
    expect(found).not.toBeNull();
    const ids = found!.members.map(member => member.sourceId);
    expect(ids).toEqual(byteOrder(members));
    return ids;
  }));

  parityTest('a topology lock refusal names the byte-first member of the worktree that holds the root', {
    methods: ['worktreeClaimStore', 'readPersistenceBrainId', 'listHostTopologyRows', 'listWorktreeMembers'],
  }, async (engine, backend) => inHome(async () => {
    const owner = randomUUID();
    const worktree = await seedWorktree(engine, owner);
    for (const id of SOURCE_IDS) await seedSourceBinding(engine, id, await seedSource(engine, backend, id), worktree);
    await seedHostBinding(engine, worktree, localHostId(), '/collate/root');
    const refusal = await withTopologyLocks(engine, 'unbound', async () => 'locked', '/collate/root/inside', 0)
      .then(() => null, (error: Error) => error);
    expect(refusal).not.toBeNull();
    const named = /The worktree holding source (\S+) is owned/.exec((refusal as { suggestion?: string }).suggestion ?? '')?.[1];
    expect(named).toBe(byteOrder(SOURCE_IDS)[0]);
    return named;
  }));
});

const TOMBSTONE_SOURCES = ['ab', 'a-z'] as const;

/** Every slug of MIXED_SLUGS in both TOMBSTONE_SOURCES, soft-deleted at one instant 48 hours ago (so only the keys break the tie). */
async function seedTombstones(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<Array<{ source_id: string; slug: string; deleted_us: string }>> {
  for (const source of TOMBSTONE_SOURCES) {
    await createSource(engine, backend, source);
    for (const slug of MIXED_SLUGS) {
      await engine.putPage(slug, { type: 'note', title: `${source} ${slug}`, compiled_truth: `body of ${source} ${slug}`, timeline: '' }, { sourceId: source });
    }
  }
  await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '48 hours' WHERE source_id = ANY($1::text[])", [[...TOMBSTONE_SOURCES]]);
  return engine.executeRaw<{ source_id: string; slug: string; deleted_us: string }>(
    'SELECT source_id, slug, floor(extract(epoch FROM deleted_at)*1000000)::bigint::text AS deleted_us FROM pages WHERE source_id = ANY($1::text[])', [[...TOMBSTONE_SOURCES]]);
}

/** Tombstone keys in the order a byte sort gives. */
const BYTE_TOMBSTONES = byteOrder(TOMBSTONE_SOURCES).flatMap(source => BYTE_SLUGS.map(slug => `${source}/${slug}`));

describe('purge reads sort tombstones and park records by byte', () => {
  parityTest('selectPurgeCandidates on an unmanaged brain lists parked tombstones by byte source id, then byte slug', {
    methods: ['executeRaw', 'putPage'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const tombstones = await seedTombstones(engine, backend);
    for (const source of TOMBSTONE_SOURCES) await enableBeliefCoverage(engine, backend, source);
    for (const row of tombstones) for (let i = 0; i < PURGE_PARK_LIMIT; i++) await recordPurgeFailure(engine as never, { ...row, code: 'purge_failed', reason: 'the delete failed' });
    const selection = await selectPurgeCandidates(engine, 24);
    const parked = selection.parked.map(row => `${row.source_id}/${row.slug}`);
    expect(selection.managed).toBe(false);
    expect(parked).toEqual(BYTE_TOMBSTONES);
    return parked;
  });

  parityTest('selectPurgeCandidates on a managed brain lists candidates by byte source id, then byte slug, and readPurgeParks lists records by byte key', {
    methods: ['executeRaw', 'putPage'], requires: 'raw_sql',
  }, async (engine, backend) => inHome(async () => {
    const tombstones = await seedTombstones(engine, backend);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    for (const row of tombstones) await recordPurgeFailure(engine as never, { ...row, code: 'purge_failed', reason: 'the delete failed' });
    const selection = await selectPurgeCandidates(engine, 24);
    const candidates = selection.candidates.map(row => `${row.source_id}/${row.slug}`);
    const keys = [...(await readPurgeParks(engine as never)).keys()];
    expect(selection.managed).toBe(true);
    expect(candidates).toEqual(BYTE_TOMBSTONES);
    expect(keys).toEqual(byteOrder(tombstones.map(row => purgeParkKey(row.source_id, row.slug, row.deleted_us))));
    // The deletion time differs between arms, so only the order of the keys is returned.
    return { candidates, keyOrder: keys.map(key => (JSON.parse(key) as string[]).slice(0, 2).join('/')) };
  }));

  // The Rust arm's stop, by design (RUST_ENGINE.md row 65): the tie this case checks needs tombstones of two sources deleted
  // at one instant, which a Rust brain cannot stamp (each soft delete takes its own store time), so the fixture is raw SQL and
  // the case stays on the SQL arms. The Rust store serves listUnreviewedSyncTombstones; rust/crates/gbrain-store/tests/repair_scans.rs
  // writes the records it reads.
  parityTest('readUnreviewedSyncTombstones lists sync-deleted tombstones by byte source id, then byte slug', {
    methods: ['executeRaw', 'putPage', 'listUnreviewedSyncTombstones'], requires: 'raw_sql',
  }, async (engine, backend) => {
    await seedTombstones(engine, backend);
    await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, completed_keys)
      SELECT $1, p.id::text, jsonb_build_array(jsonb_build_object('source_id', p.source_id, 'slug', p.slug, 'deleted_at', p.deleted_at)) FROM pages p WHERE p.deleted_at IS NOT NULL`, [SYNC_DELETE_TOMBSTONE_OP]);
    const rows = (await readUnreviewedSyncTombstones(engine, 24)).map(row => `${row.source_id}/${row.slug}`);
    expect(rows).toEqual(BYTE_TOMBSTONES);
    expect((await engine.listUnreviewedSyncTombstones(24)).map(row => `${row.source_id}/${row.slug}`)).toEqual(rows);
    return rows;
  });
});

describe('the reconcile audit pages by byte slug', () => {
  parityTest('auditCanonicalSource walks the pages of a source in byte slug order, and its next_after cursor neither repeats nor skips a page', {
    methods: ['putPage', 'worktreeClaimStore', 'writerReleaseStore', 'readPageDatabaseOnlyReason'],
  }, async (engine, backend) => inHome(async home => {
    const slugs = [...MIXED_SLUGS, 'b-x', 'b/x', 'bx'];
    const incarnation = await seedSource(engine, backend, 'ab');
    const worktree = await seedWorktree(engine, localHostId());
    await seedSourceBinding(engine, 'ab', incarnation, worktree);
    const root = join(home, 'canonical');
    mkdirSync(root, { recursive: true });
    await seedHostBinding(engine, worktree, localHostId(), root);
    for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '' }, { sourceId: 'ab' });
    const cursors: Array<string | null> = [];
    let inspected = 0;
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const report = await auditCanonicalSource(engine, 'ab', { limit: 2, ...(after === undefined ? {} : { after }) });
      inspected += report.inspected;
      cursors.push(report.next_after);
      if (report.complete) break;
      after = report.next_after!;
    }
    const bytes = byteOrder(slugs);
    expect(cursors).toEqual([bytes[1]!, bytes[3]!, null]);
    expect(inspected).toBe(slugs.length);
    return { cursors, inspected };
  }));
});

describe('origin reads sort source ids by byte', () => {
  const page = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `body of ${slug}`, timeline: '' });

  // The Rust arm's stop, by design (RUST_ENGINE.md row 66): twin pages (two live pages of one source with one source_path)
  // exist only on a SQL brain made before pages_live_origin_key, so the fixture drops that index through raw SQL. The Rust
  // store holds one live origin per source and refuses a second (origin_claimed), so it never has a twin to count.
  parityTest('originTwinCounts lists the sources holding twin pages by byte id, and its limit keeps the byte-first ones', {
    methods: ['executeRaw', 'putPage'], requires: 'raw_sql',
  }, async (engine, backend) => {
    await engine.executeRaw(`DROP INDEX IF EXISTS ${ORIGIN_INDEX.name}`);
    try {
      for (const id of MIXED_IDS) {
        await createSource(engine, backend, id);
        for (const slug of ['twin-one', 'twin-two']) await engine.putPage(slug, page(slug), { sourceId: id });
        await engine.executeRaw('UPDATE pages SET source_path = $2 WHERE source_id = $1', [id, 'shared.md']);
      }
      const all = (await originTwinCounts(engine)).map(row => row.source_id);
      const limited = (await originTwinCounts(engine, 3)).map(row => row.source_id);
      expect(all).toEqual([...BYTE_IDS]);
      expect(limited).toEqual(BYTE_IDS.slice(0, 3));
      return { all, limited };
    } finally {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw(ORIGIN_INDEX.sql);
    }
  });

  parityTest('assertRevivalUnclaimed checks the sources of a revived slug in byte id order, so the refusal names the byte-first source', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'listRevivalPages'],
  }, async (engine, backend) => {
    // In each source the revived page is deleted first, so the holder that takes over its file is the only live page of that origin.
    for (const id of ['ab', 'a-z']) {
      await createSource(engine, backend, id);
      await engine.putPage('notes/revived', { ...page('revived'), source_path: 'notes/revived.md' } as never, { sourceId: id });
      await engine.softDeletePage('notes/revived', { sourceId: id });
      await engine.putPage('notes/holder', { ...page('holder'), source_path: 'notes/revived.md' } as never, { sourceId: id });
    }
    const refusal = await engine.transaction(tx => assertRevivalUnclaimed(tx, 'notes/revived')).then(() => null, (error: Error) => error);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('source a-z ');
    return refusal!.message;
  });
});

describe('the revival read sorts sources by byte', () => {
  parityTest('listRevivalPages lists the tombstones of a slug by byte source id, of one source when named', {
    methods: ['putPage', 'softDeletePage', 'listRevivalPages'],
  }, async (engine, backend) => {
    for (const id of ['ab', 'a-z', 'live']) {
      await createSource(engine, backend, id);
      await engine.putPage('notes/revived', { type: 'note', title: 'revived', compiled_truth: 'x', timeline: '' }, { sourceId: id });
      if (id !== 'live') await engine.softDeletePage('notes/revived', { sourceId: id });
    }
    const all = (await engine.listRevivalPages('notes/revived', null)).map(row => row.source_id);
    const one = (await engine.listRevivalPages('notes/revived', 'ab')).map(row => row.source_id);
    const live = await engine.listRevivalPages('notes/revived', 'live');
    expect(all).toEqual(['a-z', 'ab']);
    expect({ one, live: live.length }).toEqual({ one: ['ab'], live: 0 });
    return { all, one, live: live.length };
  });
});

describe('manual link reads sort text keys by byte', () => {
  const page = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `body of ${slug}`, timeline: '' });
  const SRC = 'lk';

  async function linkFixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1], targets: readonly string[]) {
    await createSource(engine, backend, SRC);
    await engine.putPage('people/from', page('from'), { sourceId: SRC });
    for (const slug of targets) await engine.putPage(slug, page(slug), { sourceId: SRC });
    return Number((await engine.readPageSnapshot('people/from', { sourceId: SRC }))!.page.id);
  }
  const request = (operation: string, pageId: number, intent: Record<string, unknown>) => ({
    request_id: randomUUID(), operation, slug: 'people/from', source_id: SRC, page_id: pageId, intent,
    authority: { remote: false },
  }) as never;

  parityTest('an add_link refused for undated statements names the byte-first target among several unattributed relationships', {
    methods: ['executeRaw', 'putPage', 'readPageSnapshot'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const targets = MIXED_SLUGS.map(slug => `people/${slug}`);
    const fromId = await linkFixture(engine, backend, targets);
    // Each target holds two fenced edges and a statement stored before rows had sources, so every target is refusable.
    for (const slug of targets) {
      for (const source of ['manual', 'crm']) {
        await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, origin_page_id, origin_field, context)
          SELECT $1, t.id, 'works_at', $4, $1, 'links_fence', '' FROM pages t WHERE t.source_id=$2 AND t.slug=$3`, [fromId, SRC, slug, source]);
      }
      await engine.executeRaw(`INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
        SELECT $2, $1, t.id, 'works_at', 'start', '2020-01-01', 'manual', $1 FROM pages t WHERE t.source_id=$2 AND t.slug=$3`, [fromId, SRC, slug]);
    }
    const refusal = await prepareManualLinkMutation(engine, request('add_link', fromId, { to: 'people/new-target' }), { engine: engine.kind } as never)
      .then(() => null, (error: Error) => error);
    expect(refusal).not.toBeNull();
    expect((refusal as { code?: string }).code).toBe('link_dates_unattributed');
    const named = /The link to (\S+) \(/.exec(refusal!.message)?.[1];
    expect(named).toBe(byteOrder(targets)[0]);
    return named;
  });

  parityTest('a remove_link names the edges it kept for the page text in byte order of link type, then of source', {
    methods: ['putPage', 'readPageSnapshot', 'addLink', 'transaction'],
  }, async (engine, backend) => {
    const fromId = await linkFixture(engine, backend, ['people/target']);
    const kinds = ['ab', 'a-z', 'a.b', 'a_b'];
    for (const type of kinds) {
      for (const source of ['mentions', 'markdown', 'frontmatter']) {
        await engine.addLink('people/from', 'people/target', '', type, source, undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
      }
    }
    const prepared = await prepareManualLinkMutation(engine, request('remove_link', fromId, { to: 'people/target' }), { engine: engine.kind } as never);
    const outcome = await engine.transaction(tx => prepared.apply(tx)) as { derived_from_text?: Array<{ link_type: string; link_source: string }> };
    const derived = (outcome.derived_from_text ?? []).map(edge => `${edge.link_type}/${edge.link_source}`);
    const expected = byteOrder(kinds).flatMap(type => byteOrder(['mentions', 'markdown', 'frontmatter']).map(source => `${type}/${source}`));
    expect(derived).toEqual(expected);
    return derived;
  });
});

describe('moved-page verdicts sort the pages they name by byte', () => {
  const page = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `body of ${slug}`, timeline: '' });
  const SRC = 'mv';
  const GIT_IDENTITY = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

  /** A repository whose first commit adds `files` and whose second commit deletes `gone` and adds `added`. */
  function repo(root: string, files: Record<string, string>, gone: readonly string[], added: Record<string, string>) {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, ...GIT_IDENTITY }, stdio: 'pipe' });
    const write = (entries: Record<string, string>) => {
      for (const [path, content] of Object.entries(entries)) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), content);
      }
    };
    mkdirSync(root, { recursive: true });
    git('init', '-q', '-b', 'main');
    write(files);
    git('add', '-A'); git('commit', '-q', '-m', 'add');
    for (const path of gone) rmSync(join(root, path));
    write(added);
    git('add', '-A'); git('commit', '-q', '-m', 'delete');
  }

  /** A live page of SRC at `sourcePath` (putPage stores the path it is given), with frontmatter id `frontmatterId` when named. */
  async function livePage(engine: BrainEngine, slug: string, sourcePath: string, frontmatterId?: string) {
    await engine.putPage(slug, { ...page(slug), source_path: sourcePath, ...(frontmatterId ? { frontmatter: { id: frontmatterId } } : {}) } as never, { sourceId: SRC });
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: SRC }))!;
    return { page_id: Number(snapshot.page.id), slug, revision: String(snapshot.revision), path: sourcePath };
  }

  // Slugs whose first five differ between byte order and an en_US locale, which files `a-z` and `a/z` after `ae`.
  const SIX = ['a-z', 'a/z', 'ab', 'ac', 'ad', 'ae'];

  parityTest('a ghost page whose file name is shared names the byte-first five live pages, not the locale-first five', {
    methods: ['putPage', 'readPageSnapshot'],
  }, async (engine, backend) => inHome(async home => {
    await createSource(engine, backend, SRC);
    const root = join(home, 'repo');
    repo(root, { 'old/note.md': 'alpha\n' }, ['old/note.md'], { 'new/other.md': 'unrelated\n' });
    const old = await livePage(engine, 'ghost', 'old/note.md');
    for (const [index, slug] of SIX.entries()) await livePage(engine, slug, `dir${index}/note.md`);
    const verdict = await readMovedPage(engine, { sourceId: SRC, root, old });
    expect(verdict).toMatchObject({ verdict: 'held', reason: 'first_blob_differs' });
    const candidates = (verdict as { candidates: string[] }).candidates;
    expect(candidates).toEqual(byteOrder(SIX).slice(0, 5));
    return candidates;
  }));

  parityTest('a ghost page with no file-name match names the byte-first five live pages that share its frontmatter id', {
    methods: ['putPage', 'readPageSnapshot'],
  }, async (engine, backend) => inHome(async home => {
    await createSource(engine, backend, SRC);
    const root = join(home, 'repo');
    repo(root, { 'old/note.md': 'alpha\n' }, ['old/note.md'], { 'new/other.md': 'unrelated\n' });
    const old = await livePage(engine, 'ghost', 'old/note.md', 'shared-id');
    for (const [index, slug] of SIX.entries()) await livePage(engine, slug, `dir${index}/elsewhere.md`, 'shared-id');
    const verdict = await readMovedPage(engine, { sourceId: SRC, root, old });
    expect(verdict).toMatchObject({ verdict: 'held', reason: 'same_id_body_differs' });
    const candidates = (verdict as { candidates: string[] }).candidates;
    expect(candidates).toEqual(byteOrder(SIX).slice(0, 5));
    return candidates;
  }));

  parityTest('a shared survivor lists the other deleted paths that still back a live page in byte path order', {
    methods: ['putPage', 'readPageSnapshot'],
  }, async (engine, backend) => inHome(async home => {
    await createSource(engine, backend, SRC);
    const root = join(home, 'repo');
    const deleted = ['del/ab.md', 'del/a-z.md', 'del/a.b.md', 'del/a_b.md'];
    repo(root, Object.fromEntries(deleted.map(path => [path, 'shared\n'])), deleted, { 'new/moved.md': 'shared\n' });
    const old = await livePage(engine, 'ghost', 'del/ab.md');
    for (const [index, path] of deleted.slice(1).entries()) await livePage(engine, `backed-${index}`, path);
    await livePage(engine, 'survivor', 'new/moved.md');
    const verdict = await readMovedPage(engine, { sourceId: SRC, root, old });
    expect(verdict).toMatchObject({ verdict: 'held', reason: 'shared_survivor' });
    const listed = /^(.*?) were deleted holding/.exec((verdict as { detail: string }).detail)?.[1];
    expect(listed).toBe(['del/ab.md', ...byteOrder(deleted.slice(1))].join(', '));
    return listed;
  }));
});

describe('checkpoint and receipt listings sort their text keys by byte', () => {
  /** Inserts one op_checkpoints row. */
  const checkpoint = (engine: BrainEngine, op: string, fingerprint: string, record: Record<string, unknown>) =>
    engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)', [op, fingerprint, JSON.stringify([record])]);
  /** The same row through the typed `writeOpCheckpointRecord`. */
  const typedCheckpoint = (engine: BrainEngine, op: string, fingerprint: string, record: Record<string, unknown>) =>
    engine.writeOpCheckpointRecord(op, fingerprint, [record]);

  parityTest('readResolutions returns the finished resolutions of one preview hash in byte fingerprint order', {
    methods: ['writeOpCheckpointRecord', 'listPreviewHashCheckpoints'],
  }, async (engine) => {
    for (const fingerprint of MIXED_SLUGS) await typedCheckpoint(engine, RESOLUTION_OP, fingerprint, { preview_hash: 'H', fingerprint });
    await typedCheckpoint(engine, RESOLUTION_OP, 'other', { preview_hash: 'not-H', fingerprint: 'other' });
    const found = (await readResolutions(engine, 'H')).map(entry => (entry as unknown as { fingerprint: string }).fingerprint);
    expect(found).toEqual([...BYTE_SLUGS]);
    return found;
  });

  parityTest('listSuppressedWrites lists the slugs the breaker holds back in byte order, and its limit keeps the byte-first ones', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'getConfig', 'listRefusalBreakerRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    for (const slug of MIXED_SLUGS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await seedTypedRequest(engine, { source: 'ab', slug, operation: 'submit_job', state: 'failed', errorCode: 'revision_conflict', intent: {}, digest: `d-${slug}` });
      }
    }
    const all = (await listSuppressedWrites(engine, 'ab')).map(row => row.slug);
    const limited = (await listSuppressedWrites(engine, 'ab', 3)).map(row => row.slug);
    expect(all).toEqual([...BYTE_SLUGS]);
    expect(limited).toEqual(BYTE_SLUGS.slice(0, 3));
    return { all, limited };
  });

  parityTest('acknowledgeManagedSyncFailures refuses every matching failure in byte fingerprint order', {
    methods: ['readSourceState', 'writeOpCheckpointRecord', 'listSourceManagedSyncFailures'],
  }, async (engine, backend) => {
    const incarnation = await seedSource(engine, backend, 'ab');
    for (const fingerprint of MIXED_SLUGS) {
      await typedCheckpoint(engine, 'managed-sync-failure', fingerprint, {
        source_id: 'ab', source_incarnation: randomUUID(), path: 'shared.md', code: 'x', message: 'x', request_id: null, run_id: 'r', target: null,
        cursor_key: fingerprint, phase: 'discovery', state: 'failed', observation_id: fingerprint, first_seen: 'x', attempts: 1,
      });
    }
    const outcome = await acknowledgeManagedSyncFailures(engine, { sourceId: 'ab', incarnation, root: '/collate', gitRoot: '/collate', target: 'x' }, 'shared.md');
    expect(outcome.cleared).toEqual([]);
    const refused = outcome.refused.map(entry => entry.failure.observation_id);
    expect(outcome.refused.every(entry => entry.reason === 'source_changed')).toBe(true);
    expect(refused).toEqual([...BYTE_SLUGS]);
    return refused;
  });

  parityTest('acknowledgeManagedSyncFailures clears a failure the imported state settles and keeps one a live page still claims', {
    methods: ['readSourceState', 'writeOpCheckpointRecord', 'putPage', 'listSourceManagedSyncFailures', 'listLiveOriginPages', 'deleteManagedSyncFailureObservation'],
  }, async (engine, backend) => {
    const incarnation = await seedSource(engine, backend, 'ab');
    await engine.putPage('notes/claimed', { type: 'note', title: 'claimed', compiled_truth: 'claimed body', timeline: '', source_path: 'claimed.md' }, { sourceId: 'ab' });
    const record = (path: string) => ({ source_id: 'ab', source_incarnation: incarnation, path, code: 'x', message: 'x', request_id: null, run_id: 'r', target: null,
      cursor_key: path, phase: 'discovery', state: 'failed', observation_id: `o-${path}`, first_seen: 'x', attempts: 1 });
    for (const path of ['gone.md', 'claimed.md']) await typedCheckpoint(engine, 'managed-sync-failure', path, record(path));
    // The imported commit is empty, so it holds neither file: a file no live page claims is settled.
    const root = mkdtempSync(join(tmpdir(), 'gbrain-collate-ack-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'empty');
      const run = { sourceId: 'ab', incarnation, root, gitRoot: root, target: git('rev-parse', 'HEAD') };
      const gone = await acknowledgeManagedSyncFailures(engine, run, 'gone.md');
      const claimed = await acknowledgeManagedSyncFailures(engine, run, 'claimed.md');
      const again = await acknowledgeManagedSyncFailures(engine, run, 'gone.md');
      const left = (await engine.listSourceManagedSyncFailures('ab')).map(row => (row.failure as { path: string }).path);
      // A row that now records another observation is kept.
      const kept = await engine.deleteManagedSyncFailureObservation('claimed.md', 'o-other');
      expect(kept).toBe(false);
      expect(gone.cleared.map(f => f.path)).toEqual(['gone.md']);
      expect(claimed.refused.map(entry => entry.reason)).toEqual(['not_deleted']);
      expect(again).toEqual({ cleared: [], refused: [] });
      expect(left).toEqual(['claimed.md']);
      return { gone: gone.cleared.map(f => f.path), claimed: claimed.refused.map(entry => entry.reason), again, left, kept };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  parityTest('readGitHoldListing lists each source in byte id order and its holds in byte fingerprint order, within the limit', {
    methods: ['readSourceState', 'writeOpCheckpointRecord'],
  }, async (engine, backend) => {
    for (const id of ['ab', 'a-z']) {
      const incarnation = await seedSource(engine, backend, id);
      await typedCheckpoint(engine, GIT_HOLD_SUMMARY_OP, `${id}:${incarnation}`, { count: MIXED_SLUGS.length });
      for (const slug of MIXED_SLUGS) await typedCheckpoint(engine, GIT_HOLD_OP, `${id}/${slug}`, { source_id: id, incarnation, code: 'x', path: slug });
    }
    const listing = await readGitHoldListing(engine, ['ab', 'a-z'], 3);
    expect(listing.map(entry => entry.sourceId)).toEqual(['a-z', 'ab']);
    for (const entry of listing) expect(entry.holds.map(hold => (hold as unknown as { path: string }).path)).toEqual(BYTE_SLUGS.slice(0, 3));
    return listing.map(entry => ({ id: entry.sourceId, holds: entry.holds.map(hold => (hold as unknown as { path: string }).path) }));
  });
});

describe('a worktree refresh orders its member sources by byte', () => {
  // managed_persistence held for callers: the refresh needs a managed sync of each member, which a Rust brain refuses.
  parityTest('refreshWorktree plans the members of one worktree in byte id order, so the topology fence accepts the plan and the refresh completes', {
    methods: ['writerReleaseStore', 'worktreeClaimStore'], requires: 'managed_persistence',
  }, async (engine, backend) => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-collate-refresh-'));
    try {
      return await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        try {
          const remote = join(dir, 'origin.git'), upstream = join(dir, 'upstream'), root = join(dir, 'brain');
          const members = [...SOURCE_IDS];
          execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
          execFileSync('git', ['clone', '-q', remote, upstream], { stdio: 'ignore' });
          git(upstream, 'checkout', '-q', '-b', 'main');
          for (const id of members) commitFile(upstream, `${id}/one.md`, refreshPage(`${id} one`, `The first ${id} observation.`));
          git(upstream, 'push', '-q', 'origin', 'main');
          execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
          await registerLocalWriter(engine, 'cli');
          await (await engine.writerReleaseStore()).setBrainEnabled(false);
          for (const id of members) {
            await createSource(engine, backend, id, { remote_url: remote }, join(root, id));
            await claimWorktree(engine, id, join(root, id));
          }
          await (await engine.writerReleaseStore()).setBrainEnabled(true);
          for (const id of members) await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true });
          const dry = await refreshWorktree(engine, 'ab', { dryRun: true });
          expect(dry.status).toBe('dry_run');
          expect(dry.source_ids).toEqual(byteOrder(members));
          commitFile(upstream, 'ab/two.md', refreshPage('ab two', 'A later ab observation.'));
          git(upstream, 'push', '-q', 'origin', 'main');
          const done = await refreshWorktree(engine, 'ab', { fetchTimeoutMs: 60_000 });
          expect(done.status).toBe('completed');
          return { planned: dry.source_ids, status: done.status };
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
