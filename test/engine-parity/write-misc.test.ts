/**
 * BrainEngine parity — the page-write reads and upkeep that belong to no other family (engine-sql/write-misc.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceState, readAdmissionSource, sharedSkillPackTablePresent,
 *    listSharedSkillPackRoots, getWorktreeBinding, isSourceClaimed, hasExtractedEvents, listActiveAccessMembers,
 *    listAccessTokens, isFolderRestricted, listAppliedPolicyRevisions, readMayActFor, readAudiencePrincipals, readJobPrincipal, readAccessMembers, readAccessCredentials,
 *    listAudienceAccessMembers, readLiveMember, hasLabelledOnlyMember, readFolderAccess, expireMemoryProposals,
 *    readOpCheckpointKeys, writeOpCheckpointKeys, appendOpCheckpointPaths, deleteOpCheckpoint, deleteOpCheckpointPaths,
 *    purgeStaleCheckpoints,
 *    readHealthMemoClock, listSynopsisSourceIds, readSynopsisTierSources, setSourceContextualMode,
 *    listAwaitingMemoryProposals and purgeMemoryProposals return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a source-state read that differs changes whether page admission, the mirror read-only guard and
 *    link policy accept a write; the rest decide the shared-skillpack screen, chronicle retirement, `access serves`,
 *    the folder rules a caller satisfies (a reader the rule does not name must stay refused) and proposal upkeep.
 *  - Why existing coverage misses it: the call sites ran these statements through `executeRaw`, which the parity cases
 *    cannot call (D18), so no case compared them across engines (docs/research/rust-put-write-path.md).
 *  - Seam: none. Generated values (incarnation uuids) are compared by shape, never by value. Folder rules,
 *    pending prefixes and policy revisions come from the restrictFolder and seedAccessPolicy fixtures (the policy writes
 *    themselves are compared in access-policy.test.ts). The Rust store keeps no skillpacks, chronicle state, access
 *    members, access tokens or memory proposals, so those cases compare the empty answer every arm gives on a fresh brain
 *    (rust/docs/store/write_misc.md, rust/docs/store/access_rules.md). Writer bindings are seeded through the claim's store
 *    (worktreeClaimStore), which every arm serves (rust/docs/store/persistence.md, "Worktree bindings"). The store keeps op checkpoints
 *    (rust/docs/store/persistence.md, "Op checkpoints"), so a resumable op stopped on it resumes; keys compare sorted,
 *    since the store lists them in path order and the SQL engines in no stated order.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, restrictFolder, seedAccessPolicy, sorted } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { appliedAccessSummary, folderAccessFor, folderAccessForAll, memberIdentityFor, stdioMemberIdentity } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktreeBinding } from '../../src/core/engine-sql/worktree-claim.ts';
import { clearHealthMemo, memoizedHealth } from '../../src/core/health-memo.ts';
import {
  appendCompleted, appendCompletedOnce, clearOpCheckpoint, loadOpCheckpoint, purgeStaleCheckpoints, recordCompleted, resumeFilter,
} from '../../src/core/op-checkpoint.ts';
import { readSynopsisTierConfig } from '../../src/core/synopsis-sweep.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import type { SourceStateRow, WorktreeBinding } from '../../src/core/engine-sql/write-misc.ts';
import { readSharedSkillsSourceView } from '../../src/core/shared-skills/source-opt-out.ts';
import { sharedSkillSourcePolicy } from '../../src/core/shared-skills/setup-source-policy.ts';

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

/**
 * A claimed writer binding for `sourceId`: its worktree owned by HOST_A at epoch 7, with HOST_A's paths, written
 * through the claim's store (worktreeClaimStore) so every arm seeds it the same way. `incarnation` binds the source at
 * another incarnation than its current one (a claim the source has since moved past).
 */
async function bindWorktree(engine: BrainEngine, sourceId: string, incarnation?: string): Promise<void> {
  await claimWorktreeBinding(engine, async store => {
    const source = await store.lockSource(sourceId);
    const id = randomUUID();
    await store.insertWorktree({ id, ownerHostId: HOST_A, ownerEpoch: 7, topologyGeneration: 3, state: 'draining', manifest: { prepared_at: '2026-01-02T03:04:05Z' } });
    await store.insertSourceBinding({ sourceId, incarnation: incarnation ?? source!.incarnation, worktreeId: id, relativePath: 'notes', topologyGeneration: 3 });
    await store.insertHostBinding({ worktreeId: id, hostId: HOST_A, localPath: '/var/tmp/work-root', coordinationPath: '/var/tmp/work-coord', gitDurability: 'enabled' });
  });
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

  parityTest('the shared-skills source view and policy read a live source through readSourceState; an archived or unknown source reads as missing',
    { methods: ['readSourceState'] }, async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/var/tmp/repo-root');
      await createSource(engine, backend, 'off', { shared_skills: false }, '/var/tmp/off-root');
      await createSource(engine, backend, 'feed', { kind: 'rss' });
      await createSource(engine, backend, 'gone', {}, '/var/tmp/gone-root');
      await archiveSource(engine, backend, 'gone');
      const code = (error: unknown) => (error as { code?: string }).code ?? String(error);
      const view = (id: string) => readSharedSkillsSourceView(engine, id).then(v => ({ mode: v.mode, configured: v.configured, reason_code: v.reason_code, parked: v.parked }), code);
      const policy = (id: string) => sharedSkillSourcePolicy(engine, id).then(p => p.mode, code);
      const result = {
        views: { repo: await view('repo'), off: await view('off'), feed: await view('feed'), gone: await view('gone'), missing: await view('missing') },
        policies: { repo: await policy('repo'), off: await policy('off'), gone: await policy('gone'), missing: await policy('missing') },
      };
      expect(result).toEqual({
        views: {
          repo: { mode: 'content', configured: null, reason_code: null, parked: null },
          off: { mode: 'preserve_files', configured: false, reason_code: 'source_shared_skills_disabled', parked: null },
          feed: { mode: 'preserve_files', configured: null, reason_code: 'source_skill_adoption_required', parked: null },
          gone: result.views.gone, missing: result.views.missing,
        },
        policies: { repo: 'content', off: 'preserve_files', gone: 'source_changed', missing: 'source_changed' },
      });
      expect(result.views.gone).toBe(result.views.missing);
      expect(typeof result.views.missing).toBe('string');
      return result;
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

  // The cycle's purge phase (handlers/purge.ts, cycle/bookkeeping-gc.ts) through op-checkpoint.ts's caller, which logs a
  // failed purge and answers 0: the case asserts it logged nothing. A checkpoint stamped before the TTL goes with its
  // paths; one stamped after it stays. The TTL is one second, as no arm can move its clock back seven days.
  parityTest('purgeStaleCheckpoints deletes a stale checkpoint with its paths and keeps a fresh one', { methods: ['purgeStaleCheckpoints', 'readOpCheckpointKeys', 'writeOpCheckpointKeys', 'appendOpCheckpointPaths'] }, async (engine) => {
    const stale = { op: 'embed', fingerprint: 'parity-stale' };
    const fresh = { op: 'embed', fingerprint: 'parity-fresh' };
    const { value, errors } = await quietErrors(async () => {
      expect(await recordCompleted(engine, stale, ['k'])).toBe(true);
      expect(await appendCompleted(engine, stale, ['a.md', 'b.md'])).toBe(true);
      const sevenDays = await purgeStaleCheckpoints(engine);
      await Bun.sleep(1600);
      expect(await appendCompleted(engine, fresh, ['c.md'])).toBe(true);
      const purged = await purgeStaleCheckpoints(engine, 1 / 86_400);
      const staleKeys = await engine.readOpCheckpointKeys(stale.op, stale.fingerprint);
      const freshKeys = await engine.readOpCheckpointKeys(fresh.op, fresh.fingerprint);
      return { sevenDays, purged, staleKeys, freshKeys };
    });
    expect({ ...value, errors }).toEqual({
      sevenDays: 0, purged: 1, staleKeys: { keys: [], corruptParent: false },
      freshKeys: { keys: ['c.md'], corruptParent: false }, errors: [],
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

  parityTest('readSynopsisTierConfig lists no synopsis source on a fresh brain', { methods: ['listSynopsisSourceIds', 'readSynopsisTierSources'] }, async (engine) => {
    const config = await readSynopsisTierConfig(engine);
    expect(config.synopsis_sources).toEqual([]);
    return { config, direct: await engine.listSynopsisSourceIds() };
  });

  // #9683: trusted page frontmatter picks the synopsis tier. Only a live markdown page on the host source counts (no
  // seeded source trusts frontmatter overrides); a page on another source, a soft-deleted page and another tier value
  // do not, and the skip flag (kill switch or synopsis global tier) skips the page check.
  parityTest('readSynopsisTierSources reports a trusted page frontmatter pick and readSynopsisTierConfig counts it as configured', { methods: ['readSynopsisTierSources'] }, async (engine, backend) => {
    const FM = { contextual_retrieval: 'per_chunk_synopsis' };
    const note = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `body of ${slug}`, timeline: '' });
    const before = await readSynopsisTierConfig(engine);
    expect(before.global_tier).not.toBe('per_chunk_synopsis');
    await createSource(engine, backend, 'work');
    await engine.putPage('notes/elsewhere', { ...note('notes/elsewhere'), frontmatter: FM }, { sourceId: 'work' });
    await engine.putPage('notes/titled', { ...note('notes/titled'), frontmatter: { contextual_retrieval: 'title' } });
    await engine.putPage('notes/gone', { ...note('notes/gone'), frontmatter: FM });
    await engine.softDeletePage('notes/gone');
    const untrusted = { config: (await readSynopsisTierConfig(engine)).configured, direct: await engine.readSynopsisTierSources(false) };
    await engine.putPage('notes/picked', { ...note('notes/picked'), frontmatter: FM });
    const view = {
      before: before.configured,
      untrusted,
      picked: await readSynopsisTierConfig(engine),
      direct: await engine.readSynopsisTierSources(false),
      skipped: await engine.readSynopsisTierSources(true),
    };
    expect(view).toEqual({
      before: false,
      untrusted: { config: false, direct: { sourceIds: [], frontmatterPicks: false } },
      picked: { global_tier: before.global_tier, kill_switch: false, synopsis_sources: [], configured: true },
      direct: { sourceIds: [], frontmatterPicks: true },
      skipped: { sourceIds: [], frontmatterPicks: false },
    });
    return view;
  });

  // The synopsis sources order by bytes on every engine: a hyphenated id sorts before its letters even on a Postgres
  // database with a linguistic collation (en_US ignores the hyphen).
  parityTest('readSynopsisTierSources orders the synopsis sources by bytes, whatever the database collation', { methods: ['readSynopsisTierSources', 'setSourceContextualMode'] }, async (engine, backend) => {
    for (const id of ['coop', 'cob', 'co-op']) {
      await createSource(engine, backend, id);
      expect(await engine.setSourceContextualMode(id, 'per_chunk_synopsis')).toBe(true);
    }
    const tier = await engine.readSynopsisTierSources(true);
    expect(tier).toEqual({ sourceIds: ['co-op', 'cob', 'coop'], frontmatterPicks: false });
    const config = await readSynopsisTierConfig(engine);
    expect(config.synopsis_sources).toEqual(['co-op', 'cob', 'coop']);
    return { tier, configured: config.configured };
  });

  parityTest('listSynopsisSourceIds lists live synopsis sources by id, not archived ones', { methods: ['listSynopsisSourceIds', 'setSourceContextualMode'] }, async (engine, backend) => {
    for (const id of ['work', 'alt', 'old']) {
      await createSource(engine, backend, id);
      expect(await engine.setSourceContextualMode(id, 'per_chunk_synopsis')).toBe(true);
    }
    await archiveSource(engine, backend, 'old');
    const ids = await engine.listSynopsisSourceIds();
    expect(ids).toEqual(['alt', 'work']);
    return { ids, configured: (await readSynopsisTierConfig(engine)).configured };
  });

  // `gbrain sources set-cr-mode` writes through setSourceContextualMode: an unknown source writes nothing and answers
  // false (the command exits 4); a set mode reads back through getSource, archived sources included; null clears it, and
  // only per_chunk_synopsis puts a source in the synopsis tier.
  parityTest('setSourceContextualMode sets and clears a source mode that getSource and the synopsis tier read back', { methods: ['setSourceContextualMode', 'getSource', 'listSynopsisSourceIds'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await createSource(engine, backend, 'alt');
    const mode = async (id: string) => (await engine.getSource(id))?.contextual_retrieval_mode ?? null;
    const view = {
      missing: await engine.setSourceContextualMode('no-such-source', 'title'),
      fresh: await mode('work'),
      set: await engine.setSourceContextualMode('work', 'per_chunk_synopsis'),
      setAlt: await engine.setSourceContextualMode('alt', 'title'),
      modes: [await mode('work'), await mode('alt')],
      tier: await engine.listSynopsisSourceIds(),
      archived: await (async () => { await archiveSource(engine, backend, 'work'); return [await mode('work'), await engine.listSynopsisSourceIds()]; })(),
      cleared: await engine.setSourceContextualMode('work', null),
      afterClear: await mode('work'),
      unknownRow: await engine.getSource('no-such-source'),
    };
    expect(view).toEqual({
      missing: false,
      fresh: null,
      set: true,
      setAlt: true,
      modes: ['per_chunk_synopsis', 'title'],
      tier: ['work'],
      archived: ['per_chunk_synopsis', []],
      cleared: true,
      afterClear: null,
      unknownRow: null,
    });
    return view;
  });

  // The restricted half (true under a folder rule or a pending prefix, on every arm) is import-path.test.ts's case.
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

  parityTest('isFolderRestricted is true under a folder rule only in the rule\'s source and below its prefix', { methods: ['isFolderRestricted'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await restrictFolder(engine, backend, 'work', 'private/', 'rule');
    const answers = {
      underRule: await engine.isFolderRestricted('work', 'private/diary'),
      prefixOnly: await engine.isFolderRestricted('work', 'private'),
      sibling: await engine.isFolderRestricted('work', 'privateer/log'),
      otherSource: await engine.isFolderRestricted('default', 'private/diary'),
    };
    expect(answers).toEqual({ underRule: true, prefixOnly: false, sibling: false, otherSource: false });
    return answers;
  });

  // The production rule write (`gbrain access rule add` runs proposeRevision) applies the rule on every arm, Rust
  // included (access-policy.test.ts compares the policy writes themselves), and the caller's folder access then names it.
  parityTest('the folder-rule write (proposeRevision) applies the rule, and readFolderAccess and isFolderRestricted see it',
    { methods: ['readFolderAccess', 'isFolderRestricted'] }, async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await proposeRevision(engine, 'work', [{ id: 'team', prefix: 'drafts/', readable_by: ['group:team-a'] }],
        { origin: 'cli', store: 'database' });
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

  parityTest('listAppliedPolicyRevisions gives each source with access state its newest applied revision, null when none is applied', { methods: ['listAppliedPolicyRevisions'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await createSource(engine, backend, 'quiet');
    await seedAccessPolicy(engine, backend, 'work', [{ revision: 1, applied: true }, { revision: 2, applied: true }, { revision: 3, applied: false }]);
    await seedAccessPolicy(engine, backend, 'quiet', [{ revision: 1, applied: false }]);
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
  // another. The Rust store keeps no tokens or clients (null above), so the token write stops on the raw_sql refusal.
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

  parityTest('readJobPrincipal finds no client and no token on a brain with none', { methods: ['readJobPrincipal'] }, async (engine) => {
    const client = await engine.readJobPrincipal({ kind: 'oauth_client', id: 'client-absent' });
    const token = await engine.readJobPrincipal({ kind: 'legacy_token', id: '00000000-0000-4000-8000-0000000000aa' });
    expect({ client, token }).toEqual({ client: null, token: null });
    return { client, token };
  });

  // Leak case: the member returns the revoked or deleted row as stored (the caller names which one denied the job), and
  // a token id named as a client, or a client id named as a token, finds nothing. The Rust store keeps no tokens or
  // clients (null above), so the token write stops on the raw_sql refusal.
  parityTest('readJobPrincipal reads only the row it names, revoked and deleted rows included', { methods: ['readJobPrincipal'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash, scopes, revoked_at) VALUES
         ('00000000-0000-4000-8000-0000000000b1', 'live', 'h1', ARRAY['admin'], NULL),
         ('00000000-0000-4000-8000-0000000000b2', 'revoked', 'h2', ARRAY['admin'], now())`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readJobPrincipal({ kind: 'legacy_token', id: '00000000-0000-4000-8000-0000000000b1' })).toBeNull();
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, surface, deleted_at) VALUES
         ('client-live', 'live', 'admin', 'default', 'full', NULL), ('client-gone', 'gone', 'read', NULL, NULL, now())`);
    const read = async (kind: 'oauth_client' | 'legacy_token', id: string) => await engine.readJobPrincipal({ kind, id });
    const live = await read('legacy_token', '00000000-0000-4000-8000-0000000000b1');
    const revoked = await read('legacy_token', '00000000-0000-4000-8000-0000000000b2');
    const clientLive = await read('oauth_client', 'client-live');
    const clientGone = await read('oauth_client', 'client-gone');
    const seen = {
      live: { name: live?.name, scopes: live?.scopes, revoked: live?.revoked_at != null },
      revoked: { name: revoked?.name, revoked: revoked?.revoked_at != null },
      clientLive: { ...clientLive, deleted_at: clientLive?.deleted_at != null } as Record<string, unknown>,
      clientGone: { scope: clientGone?.scope, source_id: clientGone?.source_id, deleted: clientGone?.deleted_at != null },
      tokenAsClient: await read('oauth_client', '00000000-0000-4000-8000-0000000000b1'),
      clientAsToken: await engine.readJobPrincipal({ kind: 'legacy_token', id: 'client-live' }).then(r => r, () => 'refused'),
    };
    expect(seen).toEqual({
      live: { name: 'live', scopes: ['admin'], revoked: false },
      revoked: { name: 'revoked', revoked: true },
      clientLive: { client_id: 'client-live', deleted_at: false, scope: 'admin', source_id: 'default', bound_slug_prefixes: null, surface: 'full', allowed_operations: null },
      clientGone: { scope: 'read', source_id: null, deleted: true },
      tokenAsClient: null,
      clientAsToken: 'refused',
    });
    return seen;
  });

  parityTest('readAudiencePrincipals reads nothing for an empty audience and finds no member or group on a brain with none', { methods: ['readAudiencePrincipals'] }, async (engine) => {
    const empty = await engine.readAudiencePrincipals([], []);
    const absent = await engine.readAudiencePrincipals(['alice-example'], ['team-a']);
    expect({ empty, absent }).toEqual({ empty: { members: [], groups: [] }, absent: { members: [], groups: [] } });
    return { empty, absent };
  });

  // Leak case: only enabled, untombstoned members answer, each with its own groups only, and only existing groups;
  // a member id never matches as a group or a group id as a member. The Rust store keeps no members or groups (empty
  // above), so the member write stops on the raw_sql refusal.
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
  // predicate. The Rust store keeps no members (empty above), so the member write stops on the raw_sql refusal.
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
  // credentials. The Rust store keeps no tokens or clients (empty above), so the token write stops on the raw_sql refusal.
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
  // removed one never do. The Rust store keeps no members (empty above), so the member write stops on the raw_sql refusal.
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
  // a deleted client name no one; the stdio config value is edge-trimmed. The Rust store keeps no members (empty above),
  // so the member write stops on the raw_sql refusal.
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

  // caller.ts:376: `access serves` and whoami report the newest applied revision of each source the caller can see.
  parityTest('appliedAccessSummary reports the newest applied policy revision of each visible source', { methods: ['listAppliedPolicyRevisions'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await createSource(engine, backend, 'quiet');
    await seedAccessPolicy(engine, backend, 'work', [{ revision: 1, applied: true }, { revision: 2, applied: true }, { revision: 3, applied: false }]);
    await seedAccessPolicy(engine, backend, 'quiet', [{ revision: 1, applied: false }]);
    const summary = await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => appliedAccessSummary(engine));
    expect(summary.policy_rev).toEqual({ work: 2 });
    expect(summary.member).toBe('alice-example');
    return { policyRev: summary.policy_rev, member: summary.member };
  });

  parityTest('readFolderAccess reads the folder rules naming any reader and every distinct pending prefix', { methods: ['readFolderAccess'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await restrictFolder(engine, backend, 'work', 'team/', 'rule', { ruleId: 'team', readers: ['group:team-a'] });
    await restrictFolder(engine, backend, 'work', 'alice/', 'rule', { ruleId: 'alice', readers: ['member:alice-example', 'member:bob-example'] });
    await restrictFolder(engine, backend, 'work', 'bob/', 'rule', { ruleId: 'bob', readers: ['member:bob-example'] });
    await restrictFolder(engine, backend, 'work', 'queued/', 'pending');
    await restrictFolder(engine, backend, 'default', 'later/', 'pending');
    const view = (rows: Awaited<ReturnType<BrainEngine['readFolderAccess']>>) => ({
      rules: sorted(rows.rules.map(r => `${r.source_id}:${r.rule_id}:${[...r.readable_by].join(',')}`)),
      coverage: rows.coverage.map(c => `${c.source_id}:${c.prefix}`),
    });
    const readers = view(await engine.readFolderAccess(['member:alice-example', 'group:team-a']));
    const none = view(await engine.readFolderAccess([]));
    const stranger = view(await engine.readFolderAccess(['member:carol-example']));
    expect(readers).toEqual({
      rules: ['work:alice:member:alice-example,member:bob-example', 'work:team:group:team-a'],
      coverage: ['default:later/', 'work:queued/'],
    });
    expect(none).toEqual({ rules: [], coverage: ['default:later/', 'work:queued/'] });
    expect(stranger).toEqual({ rules: [], coverage: ['default:later/', 'work:queued/'] });
    return { readers, none, stranger };
  });

  // caller.ts:170: an audience satisfies a rule only when every identity meets its readers.
  parityTest('folderAccessForAll satisfies a rule for a member reader, intersects an audience and lists pending coverage', { methods: ['readFolderAccess'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await restrictFolder(engine, backend, 'work', 'team/', 'rule', { ruleId: 'team', readers: ['group:team-a'] });
    await restrictFolder(engine, backend, 'work', 'alice/', 'rule', { ruleId: 'alice', readers: ['member:alice-example'] });
    await restrictFolder(engine, backend, 'work', 'queued/', 'pending');
    const alice = await folderAccessFor(engine, ['member:alice-example', 'group:team-a']);
    const audience = await folderAccessForAll(engine, [['member:alice-example', 'group:team-a'], ['member:bob-example', 'group:team-a']]);
    const withGuest = await folderAccessForAll(engine, [['member:alice-example', 'group:team-a'], []]);
    expect(alice).toEqual({ satisfiedRuleIds: ['work:alice', 'work:team'], folderCoverage: [{ source_id: 'work', prefix: 'queued/' }] });
    expect(audience.satisfiedRuleIds).toEqual(['work:team']);
    expect(withGuest.satisfiedRuleIds).toEqual([]);
    return { alice, audience, withGuest };
  });

  // Leak case: a caller the folder's readers do not name satisfies no rule, and the folder's pages stay hidden from it.
  parityTest('a private folder refuses a caller its rule does not name: no rule is satisfied and its pages stay hidden', { methods: ['readFolderAccess', 'putPage', 'findPagesByTitles'] }, async (engine, backend) => {
    await restrictFolder(engine, backend, 'default', 'private/', 'rule', { ruleId: 'diary', readers: ['member:alice-example'] });
    for (const slug of ['private/acme-diary', 'people/acme-open']) {
      await engine.putPage(slug, { type: 'person', title: 'Acme Example', compiled_truth: `body of ${slug}`, timeline: '' });
    }
    const outsider = await folderAccessFor(engine, ['member:carol-example']);
    expect(outsider).toEqual({ satisfiedRuleIds: [], folderCoverage: [] });
    const read = (excludePrivate: boolean) => withCallerAccess({ identity: ['member:carol-example'], hidePrivate: true, ...outsider }, async () =>
      (await engine.findPagesByTitles(['acme example'], ['default'], ['person'], { excludePrivate })).map(r => r.slug).sort());
    const served = await read(true);
    const unfiltered = await read(false);
    expect(served).toEqual(['people/acme-open']);
    expect(unfiltered).toEqual(['people/acme-open', 'private/acme-diary']);
    return { outsider, served, unfiltered };
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

  parityTest('getWorktreeBinding reads the claimed binding with this host\'s paths, and null host columns for another host', { methods: ['getWorktreeBinding', 'worktreeClaimStore'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { canonical: 'git' }, '/var/tmp/work-root');
    await createSource(engine, backend, 'loose');
    await bindWorktree(engine, 'work');
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

  parityTest('isSourceClaimed is true for a source claimed at its current incarnation, false for one claimed at another', { methods: ['isSourceClaimed', 'worktreeClaimStore'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { canonical: 'git' }, '/var/tmp/work-root');
    await createSource(engine, backend, 'stale', { canonical: 'git' });
    await createSource(engine, backend, 'loose');
    await bindWorktree(engine, 'work');
    await bindWorktree(engine, 'stale', randomUUID());
    const claimed = { work: await engine.isSourceClaimed('work'), loose: await engine.isSourceClaimed('loose') };
    const answers = { ...claimed, stale: await engine.isSourceClaimed('stale') };
    expect(answers).toEqual({ work: true, loose: false, stale: false });
    return answers;
  });

  // The unmanaged claim itself (persistence/ownership.ts claimWorktree) runs through worktreeClaimStore on every arm:
  // the first claim records the worktree, its host binding and the source binding; a repeat claim returns it; a source
  // inside the root joins the same worktree. Each arm claims its own scratch root, compared by shape.
  parityTest('claimWorktree binds a source, keeps the binding on a repeat claim, and joins a nested source to it', {
    methods: ['worktreeClaimStore', 'getWorktreeBinding', 'isSourceClaimed'],
  }, async (engine, backend) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-claim-parity-')));
    try {
      mkdirSync(join(root, 'inner'));
      await createSource(engine, backend, 'work', {}, root);
      await createSource(engine, backend, 'inner', {}, join(root, 'inner'));
      const first = await claimWorktree(engine, 'work', root, HOST_A);
      const again = await claimWorktree(engine, 'work', root, HOST_A);
      const inner = await claimWorktree(engine, 'inner', join(root, 'inner'), HOST_A);
      const view = (row: WorktreeBinding) => ({
        ...bindingView(row), local_path: row.local_path === root ? 'root' : row.local_path,
        coordination_path: typeof row.coordination_path === 'string' && row.coordination_path !== '' ? 'path' : row.coordination_path,
      });
      const answers = {
        first: view(first), sameWorktree: again.worktree_id === first.worktree_id && inner.worktree_id === first.worktree_id,
        inner: view(inner), claimed: [await engine.isSourceClaimed('work'), await engine.isSourceClaimed('inner')],
      };
      const bound = {
        source_incarnation: 'uuid', worktree_id: 'uuid', topology_generation: '1', owner_host_id: HOST_A, owner_epoch: '1',
        state: 'active' as const, prepared_at: null, canonical_git: false, local_path: 'root', coordination_path: 'path', git_durability: null,
      };
      expect(answers).toEqual({
        first: { ...bound, source_id: 'work', relative_path: '' }, sameWorktree: true,
        inner: { ...bound, source_id: 'inner', relative_path: 'inner' }, claimed: [true, true],
      });
      return answers;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
