/**
 * BrainEngine parity — the page-write reads and upkeep that belong to no other family (engine-sql/write-misc.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceState, readAdmissionSource, sharedSkillPackTablePresent,
 *    listSharedSkillPackRoots, getWorktreeBinding, isSourceClaimed, hasExtractedEvents, listActiveAccessMembers, listAccessTokens, notifierCoverageRecorded, isFolderRestricted,
 *    listAppliedPolicyRevisions, readLiveMember, readFolderAccess, readMayActFor, readAudiencePrincipals, readAccessMembers, expireMemoryProposals,
 *    listAwaitingMemoryProposals and purgeMemoryProposals return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a source-state read that differs changes whether page admission, the mirror read-only guard and
 *    link policy accept a write; the rest decide the shared-skillpack screen, chronicle retirement, `access serves`,
 *    the folder rules a caller satisfies (a reader the rule does not name must stay refused) and proposal upkeep.
 *  - Why existing coverage misses it: the call sites ran these statements through `executeRaw`, which the parity cases
 *    cannot call (D18), so no case compared them across engines (docs/research/rust-put-write-path.md).
 *  - Seam: none. Generated values (incarnation uuids) are compared by shape, never by value. Folder rules,
 *    pending prefixes and policy revisions come from the restrictFolder and seedAccessPolicy fixtures (the policy writes
 *    themselves are compared in access-policy.test.ts). The Rust store keeps no skillpacks, chronicle state, access members, access tokens, notifier state, writer
 *    bindings or memory proposals, so those cases compare the empty answer every arm gives on a fresh brain
 *    (rust/docs/store/write_misc.md, rust/docs/store/access_rules.md).
 */
import { describe, expect } from 'bun:test';
import type { FolderAccessRows } from '../../src/core/engine-sql/access-control.ts';
import { archiveSource, createSource, parityArms, restrictFolder, seedAccessPolicy, sorted } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { appliedAccessSummary, folderAccessFor, folderAccessForAll, memberIdentityFor, stdioMemberIdentity } from '../../src/core/access/caller.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
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

  // readFolderAccess answers no rules and no coverage on Rust (folder access opens) only because no Rust brain can hold a
  // folder rule: the production rule write (`gbrain access rule add` runs proposeRevision) must stop on a typed refusal
  // there, never record nothing and report success, and the caller's folder access must stay empty afterwards.
  parityTest('the folder-rule write (proposeRevision) applies the rule on every arm',
    { methods: ['readFolderAccess', 'isFolderRestricted'] }, async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const write = await proposeRevision(engine, 'work', [{ id: 'team', prefix: 'drafts/', readable_by: ['group:team-a'] }],
        { origin: 'cli', store: 'database' }).then(() => null, (e: unknown) => e);
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

  parityTest('listAppliedPolicyRevisions gives each source with access state its newest applied revision, null when none is applied', { methods: ['listAppliedPolicyRevisions'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await createSource(engine, backend, 'quiet');
    await seedAccessPolicy(engine, backend, 'work', [{ revision: 1, applied: true }, { revision: 2, applied: true }, { revision: 3, applied: false }]);
    await seedAccessPolicy(engine, backend, 'quiet', [{ revision: 1, applied: false }]);
    const revisions = await engine.listAppliedPolicyRevisions();
    expect(revisions).toEqual([{ source_id: 'quiet', rev: null }, { source_id: 'work', rev: 2 }]);
    return { revisions };
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
      live: await engine.readAccessMembers({ includeRemoved: false }),
      all: await engine.readAccessMembers({ includeRemoved: true }),
    };
    expect(answers).toEqual({ byId: [], live: [], all: [] });
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
    return { live, all, byId };
  });

  parityTest('readLiveMember finds no member through any binding on a brain with no access members', { methods: ['readLiveMember'] }, async (engine) => {
    const answers = {
      member: await engine.readLiveMember('member', 'alice-example'),
      stdioConfig: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
      legacyToken: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000aa'),
      oauthClient: await engine.readLiveMember('oauth_client', 'client-example'),
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

  // readLiveMember is constant null on Rust only because no Rust brain can hold an access member: the member write (raw
  // SQL here, the access member commands' statements in production) must stop on the typed raw_sql refusal there.
  parityTest('readLiveMember finds a live member with its groups through each binding, and none once it is disabled', { methods: ['readLiveMember'] }, async (engine, backend) => {
    const write = await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example'), ('bob-example')").then(() => null, (e: unknown) => e);
    if (backend === 'rust') {
      expect(isCapabilityRefusal(write, 'raw_sql')).toBe(true);
      expect(await engine.readLiveMember('member', 'alice-example')).toBeNull();
      throw write;
    }
    expect(write).toBeNull();
    await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-b'), ('team-a')");
    await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-b', 'alice-example'), ('team-a', 'alice-example')");
    await engine.setConfig('mcp.stdio_member', ' bob-example\t');
    const [token] = await engine.executeRaw<{ id: string }>(
      "INSERT INTO access_tokens (name, token_hash, member_id) VALUES ('t', 'hash-example', 'alice-example') RETURNING id::text AS id");
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_name, member_id) VALUES ('client-example', 'c', 'bob-example')");
    const alice = { id: 'alice-example', groups: ['team-a', 'team-b'] };
    const bob = { id: 'bob-example', groups: [] };
    const live = {
      member: await engine.readLiveMember('member', 'alice-example'),
      stdioConfig: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
      legacyToken: await engine.readLiveMember('legacy_token', token!.id),
      oauthClient: await engine.readLiveMember('oauth_client', 'client-example'),
      unknown: await engine.readLiveMember('member', 'carol-example'),
    };
    expect(live).toEqual({ member: alice, stdioConfig: bob, legacyToken: alice, oauthClient: bob, unknown: null });
    await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id = 'alice-example'");
    await engine.executeRaw("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'client-example'");
    const after = {
      member: await engine.readLiveMember('member', 'alice-example'),
      legacyToken: await engine.readLiveMember('legacy_token', token!.id),
      oauthClient: await engine.readLiveMember('oauth_client', 'client-example'),
      stdioConfig: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
    };
    expect(after).toEqual({ member: null, legacyToken: null, oauthClient: null, stdioConfig: bob });
    return { live, after };
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
