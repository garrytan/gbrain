/**
 * BrainEngine parity — the page-write reads and upkeep that belong to no other family (engine-sql/write-misc.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceState, readAdmissionSource, sharedSkillPackTablePresent,
 *    listSharedSkillPackRoots, getWorktreeBinding, isSourceClaimed, hasExtractedEvents, listActiveAccessMembers, isFolderRestricted,
 *    listAppliedPolicyRevisions, readMayActFor, readAudiencePrincipals, readAccessMembers, readAccessCredentials,
 *    listAudienceAccessMembers, readLiveMember, readAccessGroups, expireMemoryProposals,
 *    listAwaitingMemoryProposals and purgeMemoryProposals return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a source-state read that differs changes whether page admission, the mirror read-only guard and
 *    link policy accept a write; the rest decide the shared-skillpack screen, chronicle retirement, `access serves`
 *    and proposal upkeep.
 *  - Why existing coverage misses it: the call sites ran these statements through `executeRaw`, which the parity cases
 *    cannot call (D18), so no case compared them across engines (docs/research/rust-put-write-path.md).
 *  - Seam: none. Generated values (incarnation uuids) are compared by shape, never by value. The
 *    Rust store keeps no skillpacks, chronicle state, access members, folder rules, writer bindings or memory proposals, so those cases
 *    compare the empty answer every arm gives on a fresh brain (rust/docs/store/write_misc.md).
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, restrictFolder } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SourceStateRow, WorktreeBinding } from '../../src/core/engine-sql/write-misc.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  parityTest('readAccessGroups lists no group, and finds none by id, on a brain with none', { methods: ['readAccessGroups'] }, async (engine) => {
    const answers = { all: await engine.readAccessGroups(null), byId: await engine.readAccessGroups('team-a') };
    expect(answers).toEqual({ all: [], byId: [] });
    return answers;
  });

  // Leak case: a group carries only its own members, in id order; a group with no members carries none; an id matches
  // exactly one group, never a member id, another case or an injected predicate. The Rust store keeps no groups (empty
  // above), so the group write stops on the raw_sql refusal.
  parityTest('readAccessGroups lists every group with only its own members, and finds one group by its exact id', { methods: ['readAccessGroups'] }, async (engine, backend) => {
    const write = await engine.executeRaw(
      `INSERT INTO access_members (id, kind) VALUES ('alice-example', 'person'), ('bob-example', 'person'), ('carol-example', 'person')`).then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readAccessGroups(null)).toEqual([]);
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw(`INSERT INTO access_groups (id) VALUES ('team-b'), ('team-a'), ('team-empty')`);
    await engine.executeRaw(`INSERT INTO access_group_members (group_id, member_id) VALUES
      ('team-a', 'carol-example'), ('team-a', 'alice-example'), ('team-b', 'bob-example')`);
    const answers = {
      all: await engine.readAccessGroups(null),
      byId: await engine.readAccessGroups('team-a'),
      empty: await engine.readAccessGroups('team-empty'),
      member: await engine.readAccessGroups('alice-example'),
      otherCase: await engine.readAccessGroups('Team-A'),
      injected: await engine.readAccessGroups("x' OR '1'='1"),
      unknown: await engine.readAccessGroups('team-z'),
    };
    expect(answers).toEqual({
      all: [{ id: 'team-a', members: ['alice-example', 'carol-example'] }, { id: 'team-b', members: ['bob-example'] }, { id: 'team-empty', members: [] }],
      byId: [{ id: 'team-a', members: ['alice-example', 'carol-example'] }], empty: [{ id: 'team-empty', members: [] }],
      member: [], otherCase: [], injected: [], unknown: [],
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
