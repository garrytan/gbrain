/**
 * The managed-mode engine stores (engine-sql/git-durability.ts, git-effects.ts, topology-store.ts, manual-links.ts) on
 * PGLite: each answers an empty brain the way its moved SQL always did, so a store wired to the wrong statement or
 * parameter order fails here before any managed write reaches it. The managed flows themselves are compared across
 * PGLite, Postgres and Rust in test/engine-parity/managed-on-rust.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const WORKTREE = 'a0000000-0000-4000-8000-0000000000a1';
const HOST = 'b0000000-0000-4000-8000-0000000000b1';
const INCARNATION = 'c0000000-0000-4000-8000-0000000000c1';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

describe('managed-mode engine stores on an empty brain', () => {
  test('git durability: nothing to catch up, no binding to set', async () => {
    const store = await engine.gitDurabilityStore();
    expect(await store.planCatchUp({ worktreeId: WORKTREE, sourceId: 'default', sourceIncarnation: INCARNATION, reason: 'durability_not_enabled' })).toEqual([]);
    expect(await store.setHostBindingDurability(WORKTREE, HOST, 'enabled')).toBeNull();
    expect(await engine.transaction(async tx => {
      await (await tx.gitDurabilityStore()).bound();
      return (await tx.gitDurabilityStore()).requeueCatchUp({ worktreeId: WORKTREE, sourceIncarnation: INCARNATION, reason: 'durability_not_enabled' }, ['1']);
    })).toEqual([]);
  });

  test('git effects: no request pending or recovering, no claim to coalesce', async () => {
    const store = await engine.gitEffectStore();
    expect(await store.publicationsPending(WORKTREE)).toBe(false);
    expect(await store.recoveringPublications(WORKTREE)).toEqual({ publishing: null });
    expect(await store.worktreeRecovering(WORKTREE)).toBe(false);
    await store.yieldToPublications([{ id: '1', token: INCARNATION }], 250);
    await store.recordPlainOutcome([{ id: '1', token: INCARNATION }], '{}');
    expect(await engine.claimCoalescedGitEffects({ hostId: HOST, worktreeId: WORKTREE, limit: 5, deadOwners: [], ownerJson: '{}' })).toEqual([]);
  });

  test('topology: the default source, no worktree, no binding and no lifecycle change', async () => {
    const store = await engine.topologyStore();
    expect((await store.readSource('default'))?.id).toBe('default');
    expect(await store.lockWorktrees([WORKTREE])).toEqual([]);
    expect(await store.activeRefresh([WORKTREE], null)).toBeNull();
    expect(await store.memberSources([WORKTREE])).toEqual([]);
    expect(await store.hostBinding(WORKTREE, HOST)).toBeNull();
    expect(await store.unsettledRequests(['default'], [WORKTREE])).toEqual([]);
    expect(await store.blockingEffect(['default'], [WORKTREE])).toBeNull();
    expect(await store.retirableState('default')).toEqual({ pages: 0, members: 0 });
    expect(await store.retireState('default', true)).toMatchObject({ archived: false, due: false });
    expect(await store.isExpiredArchive('default')).toBe(false);
    expect(await store.oauthClientOf('default')).toBeNull();
    expect(await store.worktreeExists(WORKTREE)).toBe(false);
    expect(await store.worktreeMembers(WORKTREE)).toEqual([]);
    expect(typeof await store.brainId()).toBe('string');
  });

  test('manual links: no fenced edge, statement or target on a missing page', async () => {
    const store = await engine.manualLinkStore();
    expect(await store.fencedEdges(-1, 'links_fence')).toEqual([]);
    expect(await store.manualStatements(-1)).toEqual([]);
    expect(await store.fencedTargets(-1, 'links_fence')).toEqual([]);
    const rel = { pageId: -1, sourceId: 'default', to: 'notes/none', managedSources: ['frontmatter'], linkType: null, linkSource: null };
    expect(await store.countRelationship(rel)).toBe(0);
    expect(await store.derivedEdges(rel)).toEqual([]);
    expect(await store.pageIds('default', ['notes/none'])).toEqual([]);
    expect(typeof await store.identityHasSource('link_transitions_identity_idx')).toBe('boolean');
  });
});
