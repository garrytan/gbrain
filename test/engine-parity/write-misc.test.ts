/**
 * BrainEngine parity — the page-write reads and upkeep that belong to no other family (engine-sql/write-misc.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceState, readAdmissionSource, sharedSkillPackTablePresent,
 *    listSharedSkillPackRoots, getWorktreeBinding, hasExtractedEvents, listActiveAccessMembers, notifierCoverageRecorded, isFolderRestricted,
 *    readOpCheckpointKeys, writeOpCheckpointKeys, appendOpCheckpointPaths, deleteOpCheckpoint, deleteOpCheckpointPaths,
 *    readHealthMemoClock, listSynopsisSourceIds,
 *    expireMemoryProposals,
 *    listAwaitingMemoryProposals and purgeMemoryProposals return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a source-state read that differs changes whether page admission, the mirror read-only guard and
 *    link policy accept a write; the rest decide the shared-skillpack screen, chronicle retirement, `access serves`
 *    and proposal upkeep.
 *  - Why existing coverage misses it: the call sites ran these statements through `executeRaw`, which the parity cases
 *    cannot call (D18), so no case compared them across engines (docs/research/rust-put-write-path.md).
 *  - Seam: none. Generated values (incarnation uuids) are compared by shape, never by value. The
 *    Rust store keeps no skillpacks, chronicle state, access members, notifier state, source synopsis modes, folder rules, writer bindings or memory proposals, so those cases
 *    compare the empty answer every arm gives on a fresh brain (rust/docs/store/write_misc.md). It keeps op checkpoints
 *    (rust/docs/store/persistence.md, "Op checkpoints"), so a resumable op stopped on it resumes; keys compare sorted,
 *    since the store lists them in path order and the SQL engines in no stated order.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, restrictFolder } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { clearHealthMemo, memoizedHealth } from '../../src/core/health-memo.ts';
import {
  appendCompleted, appendCompletedOnce, clearOpCheckpoint, loadOpCheckpoint, recordCompleted, resumeFilter,
} from '../../src/core/op-checkpoint.ts';
import { readSynopsisTierConfig } from '../../src/core/synopsis-sweep.ts';
import type { SourceStateRow, WorktreeBinding } from '../../src/core/engine-sql/write-misc.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runs `fn` with console.error captured: op-checkpoint.ts logs a failed write and answers false instead of throwing. */
async function quietErrors<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), errors };
  } finally {
    console.error = original;
  }
}

/** A source state with its generated incarnation replaced by its shape. */
function stateView(row: SourceStateRow | null) {
  if (!row) return row;
  expect(row.incarnation).toMatch(UUID);
  return { ...row, incarnation: 'uuid' };
}

async function note(engine: BrainEngine, slug: string, sourceId = 'default', type = 'note'): Promise<number> {
  const page = await engine.putPage(slug, { type: type as 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId });
  return Number(page.id);
}

const HOST_A = '00000000-0000-4000-8000-00000000000a';
const HOST_B = '00000000-0000-4000-8000-00000000000b';

/** A claimed writer binding for `sourceId`: its worktree owned by HOST_A at epoch 7, with HOST_A's paths. */
async function bindWorktree(engine: BrainEngine, sourceId: string): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id = $1', [sourceId]);
  const [worktree] = await engine.executeRaw<{ id: string }>(
    `INSERT INTO persistence_worktrees (owner_host_id, owner_epoch, topology_generation, state, manifest)
     VALUES ($1::uuid, 7, 3, 'draining', '{"prepared_at":"2026-01-02T03:04:05Z"}'::jsonb) RETURNING id`, [HOST_A]);
  await engine.executeRaw(
    'INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id, relative_path, topology_generation) VALUES ($1, $2::uuid, $3::uuid, $4, 3)',
    [sourceId, source!.incarnation, worktree!.id, 'notes']);
  await engine.executeRaw(
    "INSERT INTO persistence_host_bindings (worktree_id, host_id, local_path, coordination_path, git_durability) VALUES ($1::uuid, $2::uuid, $3, $4, 'enabled')",
    [worktree!.id, HOST_A, '/var/tmp/work-root', '/var/tmp/work-coord']);
}

/** A binding with its generated ids replaced by their shape (the harness never restarts generators between cases). */
function bindingView(row: WorktreeBinding | null) {
  if (!row) return row;
  expect(row.source_incarnation).toMatch(UUID);
  expect(row.worktree_id).toMatch(UUID);
  return { ...row, source_incarnation: 'uuid', worktree_id: 'uuid' };
}

describe('engine parity: write misc', () => {
  parityTest('readSourceState reads incarnation, archived, local path and config; null for an unknown id', { methods: ['readSourceState'] }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', { mirror_read_only: 'true', slug_root_mode: 'subdir', n: 2 }, '/var/tmp/alpha-root');
    await createSource(engine, backend, 'beta');
    await archiveSource(engine, backend, 'beta');
    const alpha = await engine.readSourceState('alpha');
    const locked = await engine.readSourceState('alpha', { lock: 'share' });
    expect(locked).toEqual(alpha);
    const beta = await engine.readSourceState('beta');
    const missing = await engine.readSourceState('no-such-source');
    expect(missing).toBeNull();
    return { alpha: stateView(alpha), beta: stateView(beta), missing };
  });

  parityTest('readAdmissionSource reads config kind and role as text; no guest row joins an ordinary source', { methods: ['readAdmissionSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', { kind: 'notes', role: 7 }, '/var/tmp/alpha-root');
    const alpha = await engine.readAdmissionSource('alpha');
    const plain = await engine.readAdmissionSource('default');
    const missing = await engine.readAdmissionSource('no-such-source');
    expect(alpha?.kind).toBe('notes');
    expect(alpha?.role).toBe('7');
    expect(missing).toBeNull();
    const view = (row: typeof alpha) => row && (expect(row.incarnation).toMatch(UUID), { ...row, incarnation: 'uuid' });
    return { alpha: view(alpha), plain: view(plain), missing };
  });

  parityTest('sharedSkillPackTablePresent answers for a current schema', { methods: ['sharedSkillPackTablePresent'] }, async (engine) => {
    const present = await engine.sharedSkillPackTablePresent();
    expect(present).toBe(true);
    return { present };
  });

  parityTest('listSharedSkillPackRoots lists no pack on a fresh brain', { methods: ['listSharedSkillPackRoots'] }, async (engine) => {
    const roots = await engine.listSharedSkillPackRoots('00000000-0000-4000-8000-000000000001');
    expect(roots).toEqual([]);
    return { roots };
  });

  parityTest('hasExtractedEvents is false for a page with no chronicle extraction', { methods: ['hasExtractedEvents'] }, async (engine) => {
    const pageId = await note(engine, 'notes/a');
    const events = await engine.hasExtractedEvents('default', pageId);
    expect(events).toBe(false);
    return { events };
  });

  parityTest('listActiveAccessMembers lists no member on a fresh brain', { methods: ['listActiveAccessMembers'] }, async (engine) => {
    const members = await engine.listActiveAccessMembers();
    expect(members).toEqual([]);
    return { members };
  });

  parityTest('notifierCoverageRecorded answers false on a fresh brain', { methods: ['notifierCoverageRecorded'] }, async (engine) => {
    const covered = await engine.notifierCoverageRecorded();
    expect(covered).toBe(false);
    return { covered };
  });

  // A notifier row is raw SQL here (the resident writes it); on Rust the seed refuses, because no Rust brain keeps
  // notifier state, and the member answers false, as the fresh-brain case.
  parityTest('notifierCoverageRecorded answers true once a source has an observed head', { methods: ['notifierCoverageRecorded'] }, async (engine) => {
    let seeded: unknown = null;
    try {
      await engine.executeRaw("INSERT INTO sync_notifier_sources (source_id, state) VALUES ('default', 'idle')");
    } catch (error) { seeded = error; }
    if (seeded) {
      expect(isCapabilityRefusal(seeded, 'raw_sql')).toBe(true);
      expect(await engine.notifierCoverageRecorded()).toBe(false);
      throw seeded;
    }
    const unobserved = await engine.notifierCoverageRecorded();
    await engine.executeRaw("UPDATE sync_notifier_sources SET observed_head = 'abc', observed_at = now() WHERE source_id = 'default'");
    const observed = await engine.notifierCoverageRecorded();
    expect({ unobserved, observed }).toEqual({ unobserved: false, observed: true });
    return { unobserved, observed };
  });

  // loadOpCheckpoint catches a failed read, logs it and answers [], so its answer alone cannot tell a refused read from an
  // empty checkpoint: the case also asserts the load logged nothing.
  parityTest('loadOpCheckpoint loads an empty checkpoint without a failed read', { methods: ['readOpCheckpointKeys'] }, async (engine) => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let keys: string[];
    try {
      keys = await loadOpCheckpoint(engine, { op: 'embed', fingerprint: 'parity-f1' });
    } finally {
      console.error = original;
    }
    expect({ keys, errors }).toEqual({ keys: [], errors: [] });
    return { keys, direct: await engine.readOpCheckpointKeys('embed', 'parity-f1') };
  });

  // Seeded through op-checkpoint.ts's own writers (recordCompleted for the parent array, appendCompleted for the child
  // rows), which every arm serves: durableWrite logs and answers false on a failed write, so the case asserts both.
  parityTest('readOpCheckpointKeys unions the child rows and the legacy array, deduplicated', { methods: ['readOpCheckpointKeys', 'writeOpCheckpointKeys', 'appendOpCheckpointPaths'] }, async (engine) => {
    const key = { op: 'embed', fingerprint: 'parity-f2' };
    const { value: wrote, errors } = await quietErrors(async () => ({
      parent: await recordCompleted(engine, key, ['c', 'b']),
      children: await appendCompleted(engine, key, ['a', 'b']),
    }));
    expect({ wrote, errors }).toEqual({ wrote: { parent: true, children: true }, errors: [] });
    const read = await engine.readOpCheckpointKeys('embed', 'parity-f2');
    const other = await engine.readOpCheckpointKeys('embed', 'parity-other');
    expect({ keys: [...read.keys].sort(), corruptParent: read.corruptParent, other }).toEqual({
      keys: ['a', 'b', 'c'], corruptParent: false, other: { keys: [], corruptParent: false },
    });
    return { keys: [...read.keys].sort(), other };
  });

  // A resumable op stopped midway: each processed key is banked as it lands, the run throws, and a fresh run loads the
  // checkpoint and processes only the keys still pending. A clean exit clears it, so the next run starts from the top.
  // recordCompleted replaces the parent's keys; the children stay through a replace and go with the clear.
  parityTest('a stopped op resumes with only its pending keys, and a clear starts it over', { methods: ['readOpCheckpointKeys', 'writeOpCheckpointKeys', 'appendOpCheckpointPaths', 'deleteOpCheckpoint', 'deleteOpCheckpointPaths'] }, async (engine) => {
    const key = { op: 'sync', fingerprint: 'parity-resume' };
    const all = ['p/1.md', 'p/2.md', 'p/3.md', 'p/4.md', 'p/5.md'];
    const { value, errors } = await quietErrors(async () => {
      const firstRun: string[] = [];
      let stopped: string | null = null;
      try {
        for (const path of resumeFilter(all, await loadOpCheckpoint(engine, key))) {
          if (path === 'p/4.md') throw new Error('killed');
          firstRun.push(path);
          expect(await appendCompleted(engine, key, [path])).toBe(true);
        }
      } catch (error) { stopped = (error as Error).message; }
      const banked = [...await loadOpCheckpoint(engine, key)].sort();
      const secondRun = resumeFilter(all, await loadOpCheckpoint(engine, key));
      expect(await recordCompleted(engine, key, ['legacy'])).toBe(true);
      const afterReplace = [...await loadOpCheckpoint(engine, key)].sort();
      expect(await appendCompletedOnce(engine, key, secondRun)).toBe(true);
      const finished = resumeFilter(all, await loadOpCheckpoint(engine, key));
      await clearOpCheckpoint(engine, key);
      const afterClear = await engine.readOpCheckpointKeys(key.op, key.fingerprint);
      const thirdRun = resumeFilter(all, await loadOpCheckpoint(engine, key));
      return { firstRun, stopped, banked, secondRun, afterReplace, finished, afterClear, thirdRun };
    });
    expect({ ...value, errors }).toEqual({
      firstRun: ['p/1.md', 'p/2.md', 'p/3.md'], stopped: 'killed', banked: ['p/1.md', 'p/2.md', 'p/3.md'],
      secondRun: ['p/4.md', 'p/5.md'], afterReplace: ['legacy', 'p/1.md', 'p/2.md', 'p/3.md'], finished: [],
      afterClear: { keys: [], corruptParent: false }, thirdRun: all, errors: [],
    });
    return value;
  });

  // clearOpCheckpoint's second sweep deletes the paths and keeps the parent's keys; other checkpoints stay.
  parityTest('deleteOpCheckpointPaths keeps the parent keys and other checkpoints', { methods: ['deleteOpCheckpointPaths', 'deleteOpCheckpoint'] }, async (engine) => {
    const mine = { op: 'extract', fingerprint: 'parity-mine' };
    const theirs = { op: 'extract', fingerprint: 'parity-theirs' };
    await engine.writeOpCheckpointKeys(mine.op, mine.fingerprint, ['k']);
    await engine.appendOpCheckpointPaths(mine.op, mine.fingerprint, ['x', 'y']);
    await engine.appendOpCheckpointPaths(theirs.op, theirs.fingerprint, ['z']);
    await engine.deleteOpCheckpointPaths(mine.op, mine.fingerprint);
    const kept = await engine.readOpCheckpointKeys(mine.op, mine.fingerprint);
    await engine.deleteOpCheckpoint(mine.op, mine.fingerprint);
    await engine.deleteOpCheckpoint('extract', 'parity-missing');
    const gone = await engine.readOpCheckpointKeys(mine.op, mine.fingerprint);
    const other = await engine.readOpCheckpointKeys(theirs.op, theirs.fingerprint);
    const result = { kept, gone, other };
    expect(result).toEqual({
      kept: { keys: ['k'], corruptParent: false }, gone: { keys: [], corruptParent: false }, other: { keys: ['z'], corruptParent: false },
    });
    return result;
  });

  // memoizedHealth computes uncached when its clock read fails, so a refused read shows as a second compute.
  parityTest('memoizedHealth reuses an answer until a page is written', { methods: ['readHealthMemoClock'] }, async (engine) => {
    clearHealthMemo(engine);
    let computes = 0;
    const compute = async () => ({ n: ++computes });
    const first = await memoizedHealth(engine, {}, compute);
    const again = await memoizedHealth(engine, {}, compute);
    const clockBefore = await engine.readHealthMemoClock();
    const clockStill = await engine.readHealthMemoClock();
    await note(engine, 'notes/health-memo');
    const clockAfter = await engine.readHealthMemoClock();
    const afterWrite = await memoizedHealth(engine, {}, compute);
    clearHealthMemo(engine);
    const view = {
      answers: [first.n, again.n, afterWrite.n],
      reusedComputedAt: again.computed_at === first.computed_at,
      clockSteady: clockStill === clockBefore,
      clockMoved: clockAfter !== clockBefore,
    };
    expect(view).toEqual({ answers: [1, 1, 2], reusedComputedAt: true, clockSteady: true, clockMoved: true });
    return view;
  });

  parityTest('readSynopsisTierConfig lists no synopsis source on a fresh brain', { methods: ['listSynopsisSourceIds'] }, async (engine) => {
    const config = await readSynopsisTierConfig(engine);
    expect(config.synopsis_sources).toEqual([]);
    return { config, direct: await engine.listSynopsisSourceIds() };
  });

  // A source's own contextual-retrieval mode is written by `sources` admin raw SQL; on Rust the seed refuses, because no
  // Rust brain keeps one, and the member answers none, as the fresh-brain case.
  parityTest('listSynopsisSourceIds lists live synopsis sources by id, not archived ones', { methods: ['listSynopsisSourceIds'] }, async (engine, backend) => {
    for (const id of ['work', 'alt', 'old']) await createSource(engine, backend, id);
    await archiveSource(engine, backend, 'old');
    let seeded: unknown = null;
    try {
      await engine.executeRaw(`UPDATE sources SET contextual_retrieval_mode = 'per_chunk_synopsis' WHERE id IN ('work', 'alt', 'old')`);
    } catch (error) { seeded = error; }
    if (seeded) {
      expect(isCapabilityRefusal(seeded, 'raw_sql')).toBe(true);
      expect(await engine.listSynopsisSourceIds()).toEqual([]);
      throw seeded;
    }
    const ids = await engine.listSynopsisSourceIds();
    expect(ids).toEqual(['alt', 'work']);
    return { ids, configured: (await readSynopsisTierConfig(engine)).configured };
  });

  // The restricted half (true under a folder rule or a pending prefix) is import-path.test.ts's case: the SQL arms answer
  // true there; on Rust its folder-rule fixture is raw SQL and stops on the typed refusal, because no Rust brain can hold
  // a folder rule.
  parityTest('isFolderRestricted answers false for every folder of a brain with no folder rules or pending covers', { methods: ['isFolderRestricted'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const answers = {
      plain: await engine.isFolderRestricted('work', 'people/alice-example'),
      nested: await engine.isFolderRestricted('work', 'private/diary/2026'),
      otherSource: await engine.isFolderRestricted('default', 'private/diary'),
      unknownSource: await engine.isFolderRestricted('no-such-source', 'notes/a'),
    };
    expect(answers).toEqual({ plain: false, nested: false, otherSource: false, unknownSource: false });
    return answers;
  });

  // isFolderRestricted is constant false on Rust only because no Rust brain can hold access state: the access-rule write
  // (the restrictFolder fixture's raw SQL) must stop on the typed raw_sql refusal there and leave the folder open.
  parityTest('restrictFolder, the access-rule write, refuses on Rust and restricts the folder on the SQL engines', { methods: ['isFolderRestricted'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const write = await restrictFolder(engine, backend, 'work', 'private/', 'rule').then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.isFolderRestricted('work', 'private/diary')).toBe(false);
      throw write;
    }
    expect(write).toBeNull();
    const underRule = await engine.isFolderRestricted('work', 'private/diary');
    expect(underRule).toBe(true);
    return { underRule };
  });

  parityTest('getWorktreeBinding is null for a source with no writer binding, on any host', { methods: ['getWorktreeBinding'] }, async (engine, backend) => {
    await createSource(engine, backend, 'loose', { canonical: 'git' }, '/var/tmp/loose-root');
    const answers = {
      host: await engine.getWorktreeBinding('loose', HOST_A),
      noHost: await engine.getWorktreeBinding('loose', null),
      unknownSource: await engine.getWorktreeBinding('no-such-source', HOST_A),
    };
    expect(answers).toEqual({ host: null, noHost: null, unknownSource: null });
    return answers;
  });

  // getWorktreeBinding is constant null on Rust only because no Rust brain can hold a binding: the claim's rows (raw SQL
  // here, claimWorktree's statements in production) must stop on the typed raw_sql refusal there and leave it unbound.
  parityTest('getWorktreeBinding reads the claimed binding with this host\'s paths, and null host columns for another host', { methods: ['getWorktreeBinding'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { canonical: 'git' }, '/var/tmp/work-root');
    await createSource(engine, backend, 'loose');
    const seeded = await bindWorktree(engine, 'work').then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(seeded, 'raw_sql')).toBe(true);
      expect(await engine.getWorktreeBinding('work', HOST_A)).toBeNull();
      throw seeded;
    }
    expect(seeded).toBeNull();
    const answers = {
      owner: bindingView(await engine.getWorktreeBinding('work', HOST_A)),
      otherHost: bindingView(await engine.getWorktreeBinding('work', HOST_B)),
      noHost: bindingView(await engine.getWorktreeBinding('work', null)),
      unbound: await engine.getWorktreeBinding('loose', HOST_A),
    };
    const bound = {
      source_id: 'work', source_incarnation: 'uuid', worktree_id: 'uuid', relative_path: 'notes', topology_generation: '3',
      owner_host_id: HOST_A, owner_epoch: '7', state: 'draining' as const, prepared_at: '2026-01-02T03:04:05Z', canonical_git: true,
    };
    const noHostRow = { local_path: null, coordination_path: null, git_durability: null };
    expect(answers).toEqual({
      owner: { ...bound, local_path: '/var/tmp/work-root', coordination_path: '/var/tmp/work-coord', git_durability: 'enabled' },
      otherHost: { ...bound, ...noHostRow },
      noHost: { ...bound, ...noHostRow },
      unbound: null,
    });
    return answers;
  });

  parityTest('attachSourcePath sets the path, applies a passed name and federated flag, and keeps everything else', { methods: ['attachSourcePath', 'readSourceState', 'getSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { kind: 'notes', federated: true });
    await createSource(engine, backend, 'plain', { kind: 'notes' });
    await engine.attachSourcePath('work', '/brains/work', { name: 'Work notes', federated: false });
    await engine.attachSourcePath('plain', '/brains/plain', { name: null, federated: null });
    await engine.attachSourcePath('no-such-source', '/brains/none', { name: 'x', federated: true });
    const view = async (id: string) => {
      const detail = await engine.getSource(id);
      const state = await engine.readSourceState(id);
      return detail && state ? { name: detail.name, local_path: state.local_path, config: state.config, archived: state.archived } : null;
    };
    const answers = { work: await view('work'), plain: await view('plain'), missing: await view('no-such-source') };
    expect(answers).toEqual({
      work: { name: 'Work notes', local_path: '/brains/work', config: { kind: 'notes', federated: false }, archived: false },
      plain: { name: 'plain', local_path: '/brains/plain', config: { kind: 'notes' }, archived: false },
      missing: null,
    });
    return answers;
  });

  parityTest('expireMemoryProposals expires nothing on a fresh brain', { methods: ['expireMemoryProposals'] }, async (engine) => {
    const expired = await engine.expireMemoryProposals('expired after 7 days');
    expect(expired).toBe(0);
    return { expired };
  });

  parityTest('listAwaitingMemoryProposals lists nothing on a fresh brain', { methods: ['listAwaitingMemoryProposals'] }, async (engine) => {
    const awaiting = await engine.listAwaitingMemoryProposals(10);
    expect(awaiting).toEqual([]);
    return { awaiting };
  });

  parityTest('purgeMemoryProposals purges nothing on a fresh brain', { methods: ['purgeMemoryProposals'] }, async (engine) => {
    const purged = await engine.purgeMemoryProposals(30);
    expect(purged).toBe(0);
    return { purged };
  });
});
