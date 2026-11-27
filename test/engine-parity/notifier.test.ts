/**
 * BrainEngine parity — the commit notifier's host lease and host source list (engine-sql/notifier.ts):
 * claimNotifierLease (notifier/store.ts claimLease) and listNotifierHostSourceRows (notifier/resident.ts
 * listHostSources). Three arms: PGLite always, Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the first claim on a host wins with fence 1; the same owner renews and keeps its fence; another owner
 *    loses while the lease is live and reads the holder (owner, fence, kind, pid, a future expiry, live); once the lease
 *    expired the other owner takes it over and the fence goes up by one, and the earlier owner then loses to it. The
 *    host source list has every source that is not archived, in id order, with its path, its config and no managed
 *    binding, owner host, root or syncer; listHostSources then watches a classic source bound to this host whose path is
 *    a git checkout, and skips the rest with a reason.
 *  - Regression: an engine that refuses either member leaves a brain's resident notifier with no lease and no sources,
 *    so commits on that host are never synced (the Rust brain's resident was switched off for this). An engine that
 *    bumps the fence on a renewal, lets a second owner take a live lease, keeps a stale owner after a takeover, lists an
 *    archived source or drops a source with no path would run two notifiers on one host, or watch the wrong sources.
 *  - Why existing coverage misses it: test/pathological/s-notifier-residents.test.ts and
 *    test/notifier-sync-disabled-gst2515.test.ts run PGLite or Postgres only, and the notifier's other tests use the
 *    in-memory store (test/helpers/notifier-memory-store.ts); nothing ran the lease or the source list on a Rust brain.
 *  - Seam: none. Real engines, typed members only; the expiry case waits out a 1 ms lease. Expiry times are compared as
 *    "in the future", never by value.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotifierLeaseClaim } from '../../src/core/engine-sql/notifier.ts';
import { listHostSources, sqlNotifierStore } from '../../src/core/notifier/resident.ts';
import { readLease } from '../../src/core/notifier/store.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOST = '00000000-0000-4000-8000-00000000a001';
const OTHER_HOST = '00000000-0000-4000-8000-00000000a002';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';

/** The claim with the holder's expiry checked and replaced, so arms compare by shape. */
function shape(claim: NotifierLeaseClaim): unknown {
  if (claim.owner || claim.holder === null) return claim;
  const { expires_at, ...rest } = claim.holder;
  return { owner: false, holder: { ...rest, expires_at_is_iso: new Date(expires_at).toISOString() === expires_at } };
}

describe('engine parity: commit notifier lease and host sources', () => {
  parityTest('claimNotifierLease: first claim wins, renewals keep the fence, a live lease refuses another owner, expiry hands it over', { methods: ['claimNotifierLease'] }, async (engine) => {
    const claim = (ownerId: string, leaseMs: number, kind = 'serve', pid = 101, hostId = HOST) =>
      engine.claimNotifierLease({ hostId, ownerId, kind, pid, leaseMs });
    const first = await claim(OWNER_A, 60_000);
    const renewed = await claim(OWNER_A, 60_000, 'serve', 102);
    const contested = await claim(OWNER_B, 60_000, 'jobs-worker', 201);
    const elsewhere = await claim(OWNER_B, 60_000, 'jobs-worker', 201, OTHER_HOST);
    // A renewal with a 1 ms lease expires it; the other owner then takes over.
    const shortened = await claim(OWNER_A, 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    const takeover = await claim(OWNER_B, 60_000, 'jobs-worker', 202);
    const stale = await claim(OWNER_A, 60_000);
    const live = !stale.owner && stale.holder !== null && Date.parse(stale.holder.expires_at) > Date.now();
    const observed = { first, renewed, contested: shape(contested), elsewhere, shortened, takeover, stale: shape(stale), live };
    expect(observed).toEqual({
      first: { owner: true, fence: 1 },
      renewed: { owner: true, fence: 1 },
      contested: { owner: false, holder: { owner_id: OWNER_A, fence: 1, resident_kind: 'serve', pid: 102, live: true, expires_at_is_iso: true } },
      elsewhere: { owner: true, fence: 1 },
      shortened: { owner: true, fence: 1 },
      takeover: { owner: true, fence: 2 },
      stale: { owner: false, holder: { owner_id: OWNER_B, fence: 2, resident_kind: 'jobs-worker', pid: 202, live: true, expires_at_is_iso: true } },
      live: true,
    });
    return observed;
  });

  parityTest('the notifier store reads the lease, checks the fence and releases only its own lease', { methods: ['claimNotifierLease', 'readNotifierLease', 'holdsNotifierLease', 'releaseNotifierLease'] }, async (engine) => {
    const store = sqlNotifierStore(engine);
    const lease = async (hostId = HOST) => {
      const row = await readLease(engine, hostId);
      if (row === null) return null;
      const { expires_at, ...rest } = row;
      return { ...rest, expires_at_is_iso: new Date(expires_at).toISOString() === expires_at };
    };
    const none = await lease();
    const claimed = await engine.claimNotifierLease({ hostId: HOST, ownerId: OWNER_A, kind: 'serve', pid: 101, leaseMs: 60_000 });
    const held = await lease();
    const holds = {
      owner: await store.holdsLease(HOST, OWNER_A, 1),
      otherFence: await store.holdsLease(HOST, OWNER_A, 2),
      otherOwner: await store.holdsLease(HOST, OWNER_B, 1),
      otherHost: await store.holdsLease(OTHER_HOST, OWNER_A, 1),
    };
    // Another owner's release leaves the lease alone; the owner's own release expires it at once.
    await store.releaseLease(HOST, OWNER_B);
    const afterOtherRelease = { holds: await store.holdsLease(HOST, OWNER_A, 1), live: (await lease())?.live };
    await store.releaseLease(HOST, OWNER_A);
    const released = { holds: await store.holdsLease(HOST, OWNER_A, 1), lease: await lease() };
    const takeover = await engine.claimNotifierLease({ hostId: HOST, ownerId: OWNER_B, kind: 'jobs-worker', pid: 201, leaseMs: 60_000 });
    await store.releaseLease(OTHER_HOST, OWNER_A);
    const observed = { none, claimed, held, holds, afterOtherRelease, released, takeover, holdsAfterTakeover: await store.holdsLease(HOST, OWNER_B, 2), otherHost: await lease(OTHER_HOST) };
    expect(observed).toEqual({
      none: null,
      claimed: { owner: true, fence: 1 },
      held: { owner_id: OWNER_A, fence: 1, resident_kind: 'serve', pid: 101, live: true, expires_at_is_iso: true },
      holds: { owner: true, otherFence: false, otherOwner: false, otherHost: false },
      afterOtherRelease: { holds: true, live: true },
      released: { holds: false, lease: { owner_id: OWNER_A, fence: 1, resident_kind: 'serve', pid: 101, live: false, expires_at_is_iso: true } },
      takeover: { owner: true, fence: 2 },
      holdsAfterTakeover: true,
      otherHost: null,
    });
    return observed;
  });

  parityTest('listNotifierHostSourceRows lists sources that are not archived, in id order, with no managed binding', { methods: ['listNotifierHostSourceRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'beta', { syncEnabled: false }, '/srv/brain/beta');
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'nopath');
    await createSource(engine, backend, 'gone', {}, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    const rows = (await engine.listNotifierHostSourceRows()).filter(r => r.id !== 'default');
    const none = { last_commit: null, bound: false, owner: null, root: null, syncer: null };
    expect(rows).toEqual([
      { id: 'alpha', local_path: '/srv/brain/alpha', ...none, config: {} },
      { id: 'beta', local_path: '/srv/brain/beta', ...none, config: { syncEnabled: false } },
      { id: 'nopath', local_path: null, ...none, config: {} },
    ]);
    return rows;
  });

  parityTest('listHostSources watches a bound classic checkout and skips the rest with a reason', { methods: ['listNotifierHostSourceRows'] }, async (engine, backend) => {
    // git answers the real path of the checkout's .git, and macOS tmpdir() sits behind the /var -> /private/var symlink.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'notifier-parity-')));
    try {
      const repo = join(root, 'repo');
      const plain = join(root, 'plain');
      mkdirSync(plain);
      execFileSync('git', ['init', '-q', repo]);
      await createSource(engine, backend, 'watched', { syncEnabled: false }, repo);
      await createSource(engine, backend, 'unbound', {}, repo);
      await createSource(engine, backend, 'notgit', {}, plain);
      await createSource(engine, backend, 'nopath');
      const { sources, skipped } = await listHostSources(engine, HOST, { GBRAIN_NOTIFIER_CLASSIC_SOURCES: 'watched,notgit,nopath' });
      const rel = (s: string | null | undefined) => (s ?? '').split(root).join('<root>');
      const observed = {
        sources: sources.map(s => ({ sourceId: s.sourceId, root: rel(s.root), gitDir: rel(s.gitDir), kind: s.kind, lastCommit: s.lastCommit, syncDisabled: s.syncDisabled ?? false })),
        skipped: skipped.filter(s => s.sourceId !== 'default').map(s => ({ sourceId: s.sourceId, reason: rel(s.reason) })),
      };
      expect(observed.sources).toEqual([{ sourceId: 'watched', root: '<root>/repo', gitDir: '<root>/repo/.git', kind: 'classic', lastCommit: null, syncDisabled: true }]);
      expect(observed.skipped.map(s => s.sourceId)).toEqual(['nopath', 'notgit', 'unbound']);
      expect(observed.skipped[1]!.reason).toBe('<root>/plain is not a git checkout on this host');
      return observed;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
