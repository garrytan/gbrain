/**
 * BrainEngine parity: the topology store (engine.topologyStore(), engine-sql/topology-store.ts), the reads a source
 * lifecycle change makes before its first write. The Rust engine serves them from its store records
 * (rust-engine/store-members/topology-store.ts); PGLite and Postgres run the SQL the callers ran.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after a writer claim of a checkout holding one page, every read answers the same on every engine: the
 *    source, this host's worktree and paths, the bound sources, the owner rows (epoch and generation as text), the
 *    canonical stamp (the md5 of `page id:knowledge revision:incarnation`), no unsettled request, no blocking effect
 *    and no active refresh. Unknown sources and worktrees read as null or empty.
 *  - Regression: the Rust engine had no topologyStore member, so every source lifecycle change refused at its first
 *    read as `member=executeRaw`.
 *  - Why existing coverage misses it: topology-named-stop.test.ts runs the clone to its first write and never reaches
 *    the reclone's canonical stamp or the additional-root reads.
 *    The lifecycle read (`lifecycleSource`, source-lifecycle.ts's first read of every lifecycle change) answers a
 *    registered source's id, incarnation, archived flag, local path, config, name and last commit, an archived source
 *    as archived, and an unknown one as null.
 *  - Seam: none. The real writer claim and typed members; ids that differ per engine are compared, not returned.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const UNKNOWN = 'd0000000-0000-4000-8000-0000000000f9';

describe('engine parity: the topology store', () => {
  parityTest('the lifecycle read answers a registered, an archived and an unknown source the same on every engine', {
    methods: ['topologyStore', 'readLedgerSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { remote_url: 'https://example.invalid/example.git' }, '/srv/example/work');
    await createSource(engine, backend, 'old');
    await archiveSource(engine, backend, 'old');
    const store = await engine.topologyStore();
    const work = await store.lifecycleSource('work');
    const incarnation = (await engine.readLedgerSource('work'))!.incarnation;
    const read = {
      work: work && { ...work, incarnation: work.incarnation === incarnation },
      old: await store.lifecycleSource('old').then(row => row && { id: row.id, archived: row.archived, local_path: row.local_path, name: row.name }),
      missing: await store.lifecycleSource('missing'),
    };
    expect(read).toEqual({
      work: { id: 'work', incarnation: true, archived: false, local_path: '/srv/example/work', config: { remote_url: 'https://example.invalid/example.git' }, name: 'work', last_commit: null },
      old: { id: 'old', archived: true, local_path: null, name: 'old' },
      missing: null,
    });
    return read;
  });

  parityTest('the topology reads answer a claimed checkout the same on every engine', {
    methods: ['topologyStore', 'getWorktreeBinding', 'readLedgerSource', 'putPage'],
    timeout: 60_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-topology-store-parity-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'checkout');
        await Bun.write(join(root, 'example.md'), 'generic example');
        await createSource(engine, backend, 'work', { remote_url: 'https://example.invalid/example.git' }, root);
        try {
          const page = await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Generic example.', timeline: '' }, { sourceId: 'work' });
          await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
          const host = localHostId();
          const binding = (await engine.getWorktreeBinding('work', host))!;
          const worktree = binding.worktree_id;
          const incarnation = (await engine.readLedgerSource('work'))!.incarnation;
          const store = await engine.topologyStore();
          const source = await store.source('work');
          const locked = await store.lockedSource('work');
          const hostRows = await store.hostWorktrees(host);
          const owners = await store.lockOwners([worktree, UNKNOWN]);
          const stamp = await store.canonicalStamp(worktree);
          const expectedStamp = createHash('md5').update(`${page.id}:${page.knowledge_revision}:${incarnation}`).digest('hex');
          const read = {
            source: source && { incarnation: source.incarnation === incarnation, remote: source.config.remote_url, last_commit: source.last_commit, local_path: source.local_path === root },
            locked: locked && { incarnation: locked.incarnation === incarnation, last_commit: locked.last_commit },
            missing: { source: await store.source('missing'), locked: await store.lockedSource('missing') },
            hostWorktrees: hostRows.map(row => ({ worktree: row.worktree_id === worktree, owner: row.owner_host_id === host, owner_epoch: String(row.owner_epoch),
              state: row.state, topology_generation: String(row.topology_generation), local_path: row.local_path === root,
              coordination_path: row.coordination_path === binding.coordination_path })),
            hostLocalPaths: (await store.hostLocalPaths(host)).map(row => row.local_path === root),
            members: { bound: await store.members([worktree]), unknown: await store.members([UNKNOWN]), first: await store.firstMember(worktree),
              any: await store.anyMember(worktree), none: await store.anyMember(UNKNOWN) },
            hostBinding: { bound: (await store.hostBinding(worktree, host))?.local_path === root, unknown: await store.hostBinding(UNKNOWN, host) },
            owner: { one: await store.lockOwner(worktree).then(row => row && { owner: row.owner_host_id === host, epoch: String(row.owner_epoch), state: row.state }),
              unknown: await store.lockOwner(UNKNOWN) },
            owners: owners.map(row => ({ worktree: row.id === worktree, owner: row.owner_host_id === host, state: row.state, epoch: String(row.owner_epoch), generation: String(row.topology_generation) })),
            stamp: { matches: stamp === expectedStamp, empty: await store.canonicalStamp(UNKNOWN) },
            unsettled: (await store.unsettledRequests(['work'], [worktree])).length,
            blocking: await store.blockingEffect(['work'], [worktree]),
            refresh: await store.activeRefresh([worktree], null),
          };
          expect({ source: read.source, members: read.members, stamp: read.stamp.matches, hostWorktrees: read.hostWorktrees.length, owners: read.owners.length }).toEqual({
            source: { incarnation: true, remote: 'https://example.invalid/example.git', last_commit: null, local_path: true },
            members: { bound: ['work'], unknown: [], first: 'work', any: 'work', none: null }, stamp: true, hostWorktrees: 1, owners: 1 });
          return read;
        } finally {
          await disposePersistenceConsumer(engine);
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
