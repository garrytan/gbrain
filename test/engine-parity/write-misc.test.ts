/**
 * BrainEngine parity — the page-write reads and upkeep that belong to no other family (engine-sql/write-misc.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceState, readAdmissionSource, sharedSkillPackTablePresent,
 *    listSharedSkillPackRoots, getWorktreeBinding, isSourceClaimed, hasExtractedEvents, listActiveAccessMembers, notifierCoverageRecorded,
 *    listAccessTokens, isFolderRestricted, listAppliedPolicyRevisions, readMayActFor, readAudiencePrincipals, readAccessMembers, readAccessCredentials,
 *    listAudienceAccessMembers, readLiveMember, hasLabelledOnlyMember, readFolderAccess, expireMemoryProposals,
 *    readOpCheckpointKeys, writeOpCheckpointKeys, appendOpCheckpointPaths, deleteOpCheckpoint, deleteOpCheckpointPaths,
 *    readHealthMemoClock, listSynopsisSourceIds,
 *    listAwaitingMemoryProposals and purgeMemoryProposals return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a source-state read that differs changes whether page admission, the mirror read-only guard and
 *    link policy accept a write; the rest decide the shared-skillpack screen, chronicle retirement, `access serves`
 *    and proposal upkeep.
 *  - Why existing coverage misses it: the call sites ran these statements through `executeRaw`, which the parity cases
 *    cannot call (D18), so no case compared them across engines (docs/research/rust-put-write-path.md).
 *  - Seam: none. Generated values (incarnation uuids) are compared by shape, never by value. The
 *    Rust store keeps no skillpacks, chronicle state, notifier state, source synopsis modes, folder rules, writer bindings or memory proposals, so those cases
 *    compare the empty answer every arm gives on a fresh brain (rust/docs/store/write_misc.md). It keeps op checkpoints
 *    (rust/docs/store/persistence.md, "Op checkpoints"), so a resumable op stopped on it resumes; keys compare sorted,
 *    since the store lists them in path order and the SQL engines in no stated order.
 */
import { describe, expect } from 'bun:test';
import type { FolderAccessRows } from '../../src/core/engine-sql/access-control.ts';
import { archiveSource, createSource, parityArms, restrictFolder } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { clearHealthMemo, memoizedHealth } from '../../src/core/health-memo.ts';
import {
  appendCompleted, appendCompletedOnce, clearOpCheckpoint, loadOpCheckpoint, recordCompleted, resumeFilter,
} from '../../src/core/op-checkpoint.ts';
import { readSynopsisTierConfig } from '../../src/core/synopsis-sweep.ts';
import { folderAccessFor, folderAccessForAll, memberIdentityFor, stdioMemberIdentity } from '../../src/core/access/caller.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
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

  // A write's publication resolves its writer's member through this read (access/caller.ts memberIdentityFor). A fresh
  // brain has no member, no stdio binding and no credential, so every lookup reads as nobody on every arm.
  parityTest('readLiveMember resolves no member on a fresh brain, by id, stdio binding, token or OAuth client', { methods: ['readLiveMember'] }, async (engine) => {
    const answers = {
      member: await engine.readLiveMember('member', 'alice-example'),
      stdio: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
      token: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-000000000001'),
      oauth: await engine.readLiveMember('oauth_client', 'client-example'),
    };
    expect(answers).toEqual({ member: null, stdio: null, token: null, oauth: null });
    return answers;
  });

  // A remote page write asks this before it resolves its writer (access/labelled-only.ts anyLabelledOnlyMember, from
  // persistence/page-visibility.ts). A fresh brain has no member, so none carries the grant on any arm.
  parityTest('hasLabelledOnlyMember answers no on a fresh brain', { methods: ['hasLabelledOnlyMember'] }, async (engine) => {
    const any = await engine.hasLabelledOnlyMember();
    expect(any).toBe(false);
    return { any };
  });

  // `gbrain auth list` reads listAccessTokens: the census found the Rust engine refused it (its SQL ran through
  // sqlQueryForEngine).
  parityTest('listAccessTokens lists no token on a fresh brain', { methods: ['listAccessTokens'] }, async (engine) => {
    const tokens = await engine.listAccessTokens();
    expect(tokens).toEqual([]);
    return { tokens };
  });

  // listAccessTokens is constant empty on Rust only because no Rust brain can hold a token: the token mint (raw SQL on
  // access_tokens, token-mint.ts) must stop on the typed raw_sql refusal there and leave the list empty.
  parityTest('a minted token refuses on Rust and lists newest first on the SQL engines', { methods: ['listAccessTokens'] }, async (engine, backend) => {
    const mint = await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, scopes, created_at, revoked_at) VALUES
         ('old-client', 'hash-old', ARRAY['read'], '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
         ('new-client', 'hash-new', NULL, '2026-03-01T00:00:00Z', NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(mint, 'raw_sql')).toBe(true);
      expect(await engine.listAccessTokens()).toEqual([]);
      throw mint;
    }
    expect(mint).toBeNull();
    const rows = await engine.listAccessTokens();
    const tokens = rows.map(r => ({ name: r.name, scopes: r.scopes, revoked: r.revoked_at !== null, id: UUID.test(String(r.id)) }));
    expect(tokens.map(t => t.name)).toEqual(['new-client', 'old-client']);
    return { tokens };
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

  // readFolderAccess answers no rules and no coverage on Rust (folder access opens) only because no Rust brain can hold a
  // folder rule: the production rule write (`gbrain access rule add` runs proposeRevision) must stop on a typed refusal
  // there, never record nothing and report success, and the caller's folder access must stay empty afterwards.
  parityTest('the folder-rule write (proposeRevision) refuses typed on Rust and applies the rule on the SQL engines',
    { methods: ['readFolderAccess', 'isFolderRestricted'] }, async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const write = await proposeRevision(engine, 'work', [{ id: 'team', prefix: 'drafts/', readable_by: ['group:team-a'] }],
        { origin: 'cli', store: 'database' }).then(() => null, (e: unknown) => e);
      if (backend === 'rust') {
        expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
        expect(await engine.readFolderAccess(['group:team-a'])).toEqual({ rules: [], coverage: [] });
        expect(await engine.isFolderRestricted('work', 'drafts/plan')).toBe(false);
        throw write;
      }
      expect(write).toBeNull();
      const rules = (await engine.readFolderAccess(['group:team-a'])).rules.map(r => ({ source_id: r.source_id, rule_id: r.rule_id }));
      expect(rules).toEqual([{ source_id: 'work', rule_id: 'team' }]);
      const restricted = await engine.isFolderRestricted('work', 'drafts/plan');
      expect(restricted).toBe(true);
      return { rules, restricted };
    });

  parityTest('listAppliedPolicyRevisions lists no source on a brain with no folder access state', { methods: ['listAppliedPolicyRevisions'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const revisions = await engine.listAppliedPolicyRevisions();
    expect(revisions).toEqual([]);
    return { revisions };
  });

  // listAppliedPolicyRevisions is constant empty on Rust only because no Rust brain can hold access state: the policy
  // state write (raw SQL here, the access commands' statements in production) must stop on the typed raw_sql refusal.
  parityTest('listAppliedPolicyRevisions gives each source with access state its newest applied revision, null when none is applied', { methods: ['listAppliedPolicyRevisions'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await createSource(engine, backend, 'quiet');
    const write = await restrictFolder(engine, backend, 'work', 'private/', 'rule').then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.listAppliedPolicyRevisions()).toEqual([]);
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw('INSERT INTO access_policy_state (source_id) VALUES ($1)', ['quiet']);
    const revision = (source: string, rev: number, applied: boolean) => engine.executeRaw(
      `INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, applied_at)
       VALUES ($1, $2, '[]'::jsonb, 'd', 'narrowing', 'parity', ${applied ? 'now()' : 'NULL'})`, [source, rev]);
    await revision('work', 1, true);
    await revision('work', 2, true);
    await revision('work', 3, false);
    await revision('quiet', 1, false);
    const revisions = await engine.listAppliedPolicyRevisions();
    expect(revisions).toEqual([{ source_id: 'quiet', rev: null }, { source_id: 'work', rev: 2 }]);
    return { revisions };
  });

  parityTest('readMayActFor reads a stdio server\'s may_act_for as stored and answers null for an unset key', { methods: ['readMayActFor'] }, async (engine) => {
    const unset = await engine.readMayActFor('stdio_config', 'mcp.stdio_may_act_for');
    await engine.setConfig('mcp.stdio_may_act_for', ' member:alice-example,guest ');
    const stored = await engine.readMayActFor('stdio_config', 'mcp.stdio_may_act_for');
    const other = await engine.readMayActFor('stdio_config', 'mcp.stdio_member');
    expect({ unset, stored, other }).toEqual({ unset: null, stored: ' member:alice-example,guest ', other: null });
    return { unset, stored, other };
  });

  parityTest('readMayActFor permits nothing for a token or a client with no live row', { methods: ['readMayActFor'] }, async (engine) => {
    const token = await engine.readMayActFor('legacy_token', '00000000-0000-4000-8000-0000000000aa');
    const client = await engine.readMayActFor('oauth_client', 'client-absent');
    expect({ token, client }).toEqual({ token: null, client: null });
    return { token, client };
  });

  // Leak case: a revoked token or a deleted client must permit nothing, and one credential's list never answers for
  // another. The raw-SQL token seed stops on the Rust arm; access-members.test.ts binds typed tokens and clients on every arm.
  parityTest('readMayActFor reads only the live row it names: a revoked token, a deleted client and another credential permit nothing', { methods: ['readMayActFor'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash, may_act_for, revoked_at) VALUES
         ('00000000-0000-4000-8000-0000000000a1', 'live', 'h1', ARRAY['member:alice-example'], NULL),
         ('00000000-0000-4000-8000-0000000000a2', 'revoked', 'h2', ARRAY['member:bob-example'], now()),
         ('00000000-0000-4000-8000-0000000000a3', 'bare', 'h3', NULL, NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readMayActFor('legacy_token', '00000000-0000-4000-8000-0000000000a1')).toBeNull();
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, may_act_for, deleted_at) VALUES
         ('client-live', 'live', ARRAY['group:team-a'], NULL), ('client-gone', 'gone', ARRAY['member:bob-example'], now())`);
    const read = async (via: 'legacy_token' | 'oauth_client', key: string) => await engine.readMayActFor(via, key);
    const lists = {
      live: await read('legacy_token', '00000000-0000-4000-8000-0000000000a1'),
      revoked: await read('legacy_token', '00000000-0000-4000-8000-0000000000a2'),
      bare: await read('legacy_token', '00000000-0000-4000-8000-0000000000a3'),
      tokenAsClient: await read('oauth_client', '00000000-0000-4000-8000-0000000000a1'),
      clientLive: await read('oauth_client', 'client-live'),
      clientGone: await read('oauth_client', 'client-gone'),
      clientAsToken: await read('legacy_token', 'client-live'),
    };
    expect(lists).toEqual({ live: ['member:alice-example'], revoked: null, bare: null, tokenAsClient: null, clientLive: ['group:team-a'], clientGone: null, clientAsToken: null });
    return lists;
  });

  parityTest('readAudiencePrincipals reads nothing for an empty audience and finds no member or group on a brain with none', { methods: ['readAudiencePrincipals'] }, async (engine) => {
    const empty = await engine.readAudiencePrincipals([], []);
    const absent = await engine.readAudiencePrincipals(['alice-example'], ['team-a']);
    expect({ empty, absent }).toEqual({ empty: { members: [], groups: [] }, absent: { members: [], groups: [] } });
    return { empty, absent };
  });

  // Leak case: only enabled, untombstoned members answer, each with its own groups only, and only existing groups;
  // a member id never matches as a group or a group id as a member. The raw-SQL seed stops on the Rust arm;
  // access-members.test.ts writes members through the typed members on every arm.
  parityTest('readAudiencePrincipals answers only enabled members with their own groups and only existing groups', { methods: ['readAudiencePrincipals'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_members (id, disabled_at, tombstoned_at) VALUES
         ('alice-example', NULL, NULL), ('bob-example', now(), NULL), ('carol-example', NULL, now()), ('dave-example', NULL, NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readAudiencePrincipals(['alice-example'], ['team-a'])).toEqual({ members: [], groups: [] });
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(`INSERT INTO access_groups (id) VALUES ('team-a'), ('team-b'), ('team-c')`);
    await engine.executeRaw(`INSERT INTO access_group_members (group_id, member_id) VALUES
      ('team-b', 'alice-example'), ('team-a', 'alice-example'), ('team-c', 'dave-example'), ('team-a', 'bob-example')`);
    const rows = await engine.readAudiencePrincipals(['alice-example', 'bob-example', 'carol-example', 'nobody-example', 'team-a'], ['team-a', 'alice-example', 'team-z']);
    const view = { members: [...rows.members].sort((a, b) => a.id.localeCompare(b.id)), groups: [...rows.groups].sort() };
    expect(view).toEqual({ members: [{ id: 'alice-example', groups: ['team-a', 'team-b'] }], groups: ['team-a'] });
    const lone = await engine.readAudiencePrincipals(['dave-example'], []);
    expect(lone).toEqual({ members: [{ id: 'dave-example', groups: ['team-c'] }], groups: [] });
    return { view, lone };
  });

  parityTest('readAccessMembers finds no member by id and lists none on a brain with none', { methods: ['readAccessMembers'] }, async (engine) => {
    const answers = {
      byId: await engine.readAccessMembers({ id: 'alice-example' }),
      byEmail: await engine.readAccessMembers({ email: 'alice@example.com' }),
      live: await engine.readAccessMembers({ includeRemoved: false }),
      all: await engine.readAccessMembers({ includeRemoved: true }),
    };
    expect(answers).toEqual({ byId: [], byEmail: [], live: [], all: [] });
    return answers;
  });

  // Leak case: a removed (tombstoned) member is filtered out of the list in the statement unless asked for; each row
  // carries only its own groups; an id matches exactly one member, never a group id, another case or an injected
  // predicate. The raw-SQL seed stops on the Rust arm; access-members.test.ts writes members through typed members.
  parityTest('readAccessMembers lists live members with their own groups, removed ones only when asked, and matches ids exactly', { methods: ['readAccessMembers'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_members (id, display_name, email, kind, labelled_only, disabled_at, tombstoned_at) VALUES
         ('alice-example', 'Alice', 'alice@example.com', 'audience', true, NULL, NULL), ('bob-example', NULL, NULL, 'person', false, now(), NULL),
         ('carol-example', NULL, NULL, 'person', false, NULL, now()), ('dave-example', NULL, NULL, 'person', false, NULL, NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readAccessMembers({ includeRemoved: true })).toEqual([]);
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(`INSERT INTO access_groups (id) VALUES ('team-a'), ('team-b'), ('team-c')`);
    await engine.executeRaw(`INSERT INTO access_group_members (group_id, member_id) VALUES
      ('team-b', 'alice-example'), ('team-a', 'alice-example'), ('team-c', 'carol-example'), ('team-a', 'bob-example')`);
    const view = (rows: Awaited<ReturnType<BrainEngine['readAccessMembers']>>) => rows.map(r => ({
      id: r.id, display_name: r.display_name, email: r.email, kind: r.kind, labelled_only: r.labelled_only,
      disabled: r.disabled_at != null, removed: r.tombstoned_at != null, created: r.created_at != null, groups: r.groups,
    }));
    const live = view(await engine.readAccessMembers({ includeRemoved: false }));
    const all = view(await engine.readAccessMembers({ includeRemoved: true }));
    expect(live.map(r => [r.id, r.groups])).toEqual([['alice-example', ['team-a', 'team-b']], ['bob-example', ['team-a']], ['dave-example', []]]);
    expect(all.map(r => [r.id, r.groups])).toEqual([['alice-example', ['team-a', 'team-b']], ['bob-example', ['team-a']], ['carol-example', ['team-c']], ['dave-example', []]]);
    expect(live[0]).toEqual({ id: 'alice-example', display_name: 'Alice', email: 'alice@example.com', kind: 'audience', labelled_only: true, disabled: false, removed: false, created: true, groups: ['team-a', 'team-b'] });
    expect(live[1]!.disabled).toBe(true);
    const byId = {
      removed: view(await engine.readAccessMembers({ id: 'carol-example' })).map(r => [r.id, r.removed, r.groups]),
      group: await engine.readAccessMembers({ id: 'team-a' }),
      otherCase: await engine.readAccessMembers({ id: 'Alice-Example' }),
      injected: await engine.readAccessMembers({ id: "x' OR '1'='1" }),
      unknown: await engine.readAccessMembers({ id: 'nobody-example' }),
    };
    expect(byId).toEqual({ removed: [['carol-example', true, ['team-c']]], group: [], otherCase: [], injected: [], unknown: [] });
    // An email matches only the member that declares exactly it; never the whole list, another case or another member.
    const byEmail = {
      declared: (await engine.readAccessMembers({ email: 'alice@example.com' })).map(r => [r.id, r.groups]),
      otherCase: await engine.readAccessMembers({ email: 'Alice@example.com' }),
      undeclared: await engine.readAccessMembers({ email: 'bob@example.com' }),
    };
    expect(byEmail).toEqual({ declared: [['alice-example', ['team-a', 'team-b']]], otherCase: [], undeclared: [] });
    return { live, all, byId, byEmail };
  });

  parityTest('readAccessCredentials finds no token by name and no credential bound to a member on a brain with none', { methods: ['readAccessCredentials'] }, async (engine) => {
    const answers = {
      byName: await engine.readAccessCredentials({ tokenName: 'laptop' }),
      byMember: await engine.readAccessCredentials({ memberId: 'alice-example' }),
    };
    expect(answers).toEqual({ byName: [], byMember: [] });
    return answers;
  });

  // Leak case: a revoked token and a deleted client never answer; a token name matches only tokens with exactly that
  // name (never a client's name, another case or an injected predicate); a member binding answers only that member's
  // credentials. The raw-SQL token seed stops on the Rust arm; access-members.test.ts binds typed tokens and clients on every arm.
  parityTest('readAccessCredentials answers only live credentials with the exact token name or member binding', { methods: ['readAccessCredentials'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash, member_id, created_at, revoked_at) VALUES
         ('00000000-0000-4000-8000-0000000000b1', 'laptop', 'h1', 'alice-example', '2026-01-01T00:00:00Z', NULL),
         ('00000000-0000-4000-8000-0000000000b2', 'laptop', 'h2', 'alice-example', '2026-01-02T00:00:00Z', now()),
         ('00000000-0000-4000-8000-0000000000b3', 'alpha', 'h3', 'alice-example', '2026-01-03T00:00:00Z', NULL),
         ('00000000-0000-4000-8000-0000000000b4', 'shared', 'h4', 'bob-example', '2026-01-05T00:00:00Z', NULL),
         ('00000000-0000-4000-8000-0000000000b5', 'shared', 'h5', NULL, '2026-01-04T00:00:00Z', NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readAccessCredentials({ memberId: 'alice-example' })).toEqual([]);
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, member_id, deleted_at) VALUES
         ('client-alice', 'alice-app', 'alice-example', NULL), ('client-gone', 'gone-app', 'alice-example', now()), ('client-bob', 'bob-app', 'bob-example', NULL)`);
    const ids = (rows: Awaited<ReturnType<BrainEngine['readAccessCredentials']>>) => rows.map(r => [r.kind, r.id, r.name]);
    const byName = {
      laptop: ids(await engine.readAccessCredentials({ tokenName: 'laptop' })),
      shared: ids(await engine.readAccessCredentials({ tokenName: 'shared' })),
      otherCase: await engine.readAccessCredentials({ tokenName: 'Laptop' }),
      clientName: await engine.readAccessCredentials({ tokenName: 'alice-app' }),
      injected: await engine.readAccessCredentials({ tokenName: "x' OR '1'='1" }),
    };
    expect(byName).toEqual({
      laptop: [['token', '00000000-0000-4000-8000-0000000000b1', 'laptop']],
      shared: [['token', '00000000-0000-4000-8000-0000000000b5', 'shared'], ['token', '00000000-0000-4000-8000-0000000000b4', 'shared']],
      otherCase: [], clientName: [], injected: [],
    });
    const byMember = {
      alice: ids(await engine.readAccessCredentials({ memberId: 'alice-example' })),
      bob: ids(await engine.readAccessCredentials({ memberId: 'bob-example' })),
      otherCase: await engine.readAccessCredentials({ memberId: 'Alice-Example' }),
      injected: await engine.readAccessCredentials({ memberId: "x' OR '1'='1" }),
      unknown: await engine.readAccessCredentials({ memberId: 'nobody-example' }),
    };
    expect(byMember).toEqual({
      alice: [['token', '00000000-0000-4000-8000-0000000000b3', 'alpha'], ['token', '00000000-0000-4000-8000-0000000000b1', 'laptop'], ['client', 'client-alice', 'alice-app']],
      bob: [['token', '00000000-0000-4000-8000-0000000000b4', 'shared'], ['client', 'client-bob', 'bob-app']],
      otherCase: [], injected: [], unknown: [],
    });
    return { byName, byMember };
  });

  parityTest('listAudienceAccessMembers lists no member on a brain with none', { methods: ['listAudienceAccessMembers'] }, async (engine) => {
    const ids = await engine.listAudienceAccessMembers();
    expect(ids).toEqual([]);
    return ids;
  });

  // Leak case: only enabled, untombstoned members of kind audience answer; a person, a disabled audience member and a
  // removed one never do. The raw-SQL seed stops on the Rust arm; access-members.test.ts writes members through typed members.
  parityTest('listAudienceAccessMembers lists only enabled, untombstoned audience members, by id', { methods: ['listAudienceAccessMembers'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_members (id, kind, disabled_at, tombstoned_at) VALUES
         ('zed-example', 'audience', NULL, NULL), ('bob-example', 'audience', now(), NULL), ('carol-example', 'audience', NULL, now()),
         ('dave-example', 'person', NULL, NULL), ('alice-example', 'audience', NULL, NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.listAudienceAccessMembers()).toEqual([]);
      throw write;
    }
    expect(write).toBeNull();
    const ids = await engine.listAudienceAccessMembers();
    expect(ids).toEqual(['alice-example', 'zed-example']);
    return ids;
  });

  parityTest('readLiveMember finds no live member by id, stdio config, token or client on a brain with none', { methods: ['readLiveMember'] }, async (engine) => {
    const answers = {
      member: await engine.readLiveMember('member', 'alice-example'),
      stdioConfig: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
      legacyToken: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000c1'),
      oauthClient: await engine.readLiveMember('oauth_client', 'client-alice'),
    };
    expect(answers).toEqual({ member: null, stdioConfig: null, legacyToken: null, oauthClient: null });
    return answers;
  });

  // The MCP write tools resolve the writer's member through memberIdentityFor (access/caller.ts liveIdentity); on a
  // brain with no members every binding reads as unbound, and a Rust brain answers it without raw SQL.
  parityTest('memberIdentityFor and stdioMemberIdentity read every binding as unbound on a brain with no access members', { methods: ['readLiveMember'] }, async (engine) => {
    const identities = {
      legacyToken: await memberIdentityFor(engine, { principal: { kind: 'legacy_token', id: '00000000-0000-4000-8000-0000000000aa' } }),
      oauthClient: await memberIdentityFor(engine, { principal: { kind: 'oauth_client', id: 'client-example' } }),
      stdioConfig: await memberIdentityFor(engine, { principal: { kind: 'local_stdio', id: 'stdio' } }),
      stdioRegistered: await stdioMemberIdentity(engine, 'alice-example'),
    };
    expect(identities).toEqual({ legacyToken: [], oauthClient: [], stdioConfig: [], stdioRegistered: [] });
    return identities;
  });

  // Leak case: a disabled or removed (tombstoned) member never answers, by any route; a live member carries only its own
  // groups; an id matches exactly one member, never a group id, another case or an injected predicate; a revoked token and
  // a deleted client name no one; the stdio config value is edge-trimmed. The raw-SQL seed stops on the Rust arm;
  // access-members.test.ts writes members through typed members.
  parityTest('readLiveMember answers only an enabled, untombstoned member with its own groups, through live bindings', { methods: ['readLiveMember'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_members (id, kind, disabled_at, tombstoned_at) VALUES
         ('alice-example', 'person', NULL, NULL), ('bob-example', 'person', now(), NULL),
         ('carol-example', 'person', NULL, now()), ('dave-example', 'person', NULL, NULL)`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readLiveMember('member', 'alice-example')).toBeNull();
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(`INSERT INTO access_groups (id) VALUES ('team-a'), ('team-b'), ('team-c'), ('team-d')`);
    await engine.executeRaw(`INSERT INTO access_group_members (group_id, member_id) VALUES
      ('team-b', 'alice-example'), ('team-a', 'alice-example'), ('team-c', 'bob-example'), ('team-d', 'carol-example'), ('team-c', 'dave-example')`);
    await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash, member_id, created_at, revoked_at) VALUES
         ('00000000-0000-4000-8000-0000000000c1', 'laptop', 'h1', 'alice-example', '2026-01-01T00:00:00Z', NULL),
         ('00000000-0000-4000-8000-0000000000c2', 'old', 'h2', 'alice-example', '2026-01-02T00:00:00Z', now()),
         ('00000000-0000-4000-8000-0000000000c3', 'bobs', 'h3', 'bob-example', '2026-01-03T00:00:00Z', NULL)`);
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, member_id, deleted_at) VALUES
         ('client-alice', 'alice-app', 'alice-example', NULL), ('client-gone', 'gone-app', 'alice-example', now()), ('client-carol', 'carol-app', 'carol-example', NULL)`);
    const byId = {
      alice: await engine.readLiveMember('member', 'alice-example'),
      dave: await engine.readLiveMember('member', 'dave-example'),
      disabled: await engine.readLiveMember('member', 'bob-example'),
      removed: await engine.readLiveMember('member', 'carol-example'),
      group: await engine.readLiveMember('member', 'team-a'),
      otherCase: await engine.readLiveMember('member', 'Alice-Example'),
      injected: await engine.readLiveMember('member', "x' OR '1'='1"),
      unknown: await engine.readLiveMember('member', 'nobody-example'),
    };
    expect(byId).toEqual({
      alice: { id: 'alice-example', groups: ['team-a', 'team-b'] }, dave: { id: 'dave-example', groups: ['team-c'] },
      disabled: null, removed: null, group: null, otherCase: null, injected: null, unknown: null,
    });
    const byBinding = {
      token: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000c1'),
      revokedToken: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000c2'),
      disabledMembersToken: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000c3'),
      tokenByName: await engine.readLiveMember('legacy_token', 'laptop'),
      injectedToken: await engine.readLiveMember('legacy_token', "x' OR '1'='1"),
      client: await engine.readLiveMember('oauth_client', 'client-alice'),
      deletedClient: await engine.readLiveMember('oauth_client', 'client-gone'),
      removedMembersClient: await engine.readLiveMember('oauth_client', 'client-carol'),
      clientByName: await engine.readLiveMember('oauth_client', 'alice-app'),
    };
    expect(byBinding).toEqual({
      token: { id: 'alice-example', groups: ['team-a', 'team-b'] }, revokedToken: null, disabledMembersToken: null, tokenByName: null,
      injectedToken: null, client: { id: 'alice-example', groups: ['team-a', 'team-b'] }, deletedClient: null, removedMembersClient: null,
      clientByName: null,
    });
    const unset = await engine.readLiveMember('stdio_config', 'mcp.stdio_member');
    await engine.executeRaw(`INSERT INTO config (key, value) VALUES ('mcp.stdio_member', ' alice-example '), ('other.key', 'dave-example')`);
    const byConfig = {
      unset,
      trimmed: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
      otherKey: await engine.readLiveMember('stdio_config', 'other.key'),
      unknownKey: await engine.readLiveMember('stdio_config', 'no.such.key'),
    };
    expect(byConfig).toEqual({ unset: null, trimmed: { id: 'alice-example', groups: ['team-a', 'team-b'] }, otherKey: { id: 'dave-example', groups: ['team-c'] }, unknownKey: null });
    return { byId, byBinding, byConfig };
  });

  parityTest('readFolderAccess finds no rule and no coverage on a brain with no folder access state', { methods: ['readFolderAccess'] }, async (engine) => {
    const answers = {
      noReaders: await engine.readFolderAccess([]),
      readers: await engine.readFolderAccess(['member:alice-example', 'group:team-a']),
    };
    expect(answers).toEqual({ noReaders: { rules: [], coverage: [] }, readers: { rules: [], coverage: [] } });
    return answers;
  });

  // On Rust, folderAccessFor used to read a refused statement and fall back to fail closed (`!unreadable` covering
  // everything); with no folder state anywhere the answer is nothing satisfied and nothing covered, as on PGLite.
  parityTest('folderAccessFor and folderAccessForAll satisfy no rule and cover no prefix on a brain with no folder access state', { methods: ['readFolderAccess'] }, async (engine) => {
    const answers = {
      one: await folderAccessFor(engine, ['member:alice-example']),
      guest: await folderAccessFor(engine, []),
      audience: await folderAccessForAll(engine, [['member:alice-example'], ['member:bob-example', 'group:team-a']]),
    };
    const none = { satisfiedRuleIds: [], folderCoverage: [] };
    expect(answers).toEqual({ one: none, guest: none, audience: none });
    return answers;
  });

  parityTest('readFolderAccess reads the rules the readers meet and every pending prefix, and folderAccessForAll keeps the rules every identity meets', { methods: ['readFolderAccess'] }, async (engine, backend) => {
    const seeded = await engine.executeRaw("INSERT INTO access_policy_state (source_id) VALUES ('default') ON CONFLICT (source_id) DO NOTHING").then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(seeded, 'raw_sql')).toBe(true);
      expect(await engine.readFolderAccess(['member:alice-example'])).toEqual({ rules: [], coverage: [] });
      throw seeded;
    }
    expect(seeded).toBeNull();
    await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES
      ('default', 'team', 'team/', ARRAY['member:alice-example', 'group:team-a'], 1), ('default', 'bob', 'bob/', ARRAY['member:bob-example'], 1)`);
    await engine.executeRaw("INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ('default', 'drafts/', 'pending'), ('default', 'drafts/', 'invalid')");
    const byRule = (r: FolderAccessRows): FolderAccessRows => ({ ...r, rules: [...r.rules].sort((a, b) => a.rule_id.localeCompare(b.rule_id)) });
    const answers = {
      alice: byRule(await engine.readFolderAccess(['member:alice-example'])),
      both: byRule(await engine.readFolderAccess(['member:alice-example', 'member:bob-example'])),
      noReaders: await engine.readFolderAccess([]),
      audience: await folderAccessForAll(engine, [['member:alice-example'], ['member:bob-example', 'group:team-a']]),
      bob: await folderAccessFor(engine, ['member:bob-example']),
    };
    const team = { source_id: 'default', rule_id: 'team', readable_by: ['member:alice-example', 'group:team-a'] };
    const bob = { source_id: 'default', rule_id: 'bob', readable_by: ['member:bob-example'] };
    const coverage = [{ source_id: 'default', prefix: 'drafts/' }];
    expect(answers).toEqual({
      alice: { rules: [team], coverage },
      both: { rules: [bob, team], coverage },
      noReaders: { rules: [], coverage },
      audience: { satisfiedRuleIds: ['default:team'], folderCoverage: coverage },
      bob: { satisfiedRuleIds: ['default:bob'], folderCoverage: coverage },
    });
    return answers;
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

  parityTest('isSourceClaimed is false for an unbound source and for an unknown source', { methods: ['isSourceClaimed'] }, async (engine, backend) => {
    await createSource(engine, backend, 'loose', { canonical: 'git' }, '/var/tmp/loose-root');
    const answers = { loose: await engine.isSourceClaimed('loose'), unknown: await engine.isSourceClaimed('no-such-source') };
    expect(answers).toEqual({ loose: false, unknown: false });
    return answers;
  });

  // As getWorktreeBinding: false is constant on Rust only because no Rust brain can hold a binding, so the claim's rows
  // must stop on the typed raw_sql refusal there and leave the source unclaimed.
  parityTest('isSourceClaimed is true for a source claimed at its current incarnation, false once the incarnation moves', { methods: ['isSourceClaimed'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { canonical: 'git' }, '/var/tmp/work-root');
    await createSource(engine, backend, 'loose');
    const seeded = await bindWorktree(engine, 'work').then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(seeded, 'raw_sql')).toBe(true);
      expect(await engine.isSourceClaimed('work')).toBe(false);
      throw seeded;
    }
    expect(seeded).toBeNull();
    const claimed = { work: await engine.isSourceClaimed('work'), loose: await engine.isSourceClaimed('loose') };
    await engine.executeRaw('UPDATE sources SET incarnation = gen_random_uuid() WHERE id = $1', ['work']);
    const answers = { ...claimed, afterIncarnation: await engine.isSourceClaimed('work') };
    expect(answers).toEqual({ work: true, loose: false, afterIncarnation: false });
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
