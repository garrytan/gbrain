/**
 * BrainEngine parity — access members and groups: the member and group writes (engine-sql/access-members.ts) the
 * member commands run (access/members.ts: gbrain access member add|disable|enable|set|kind|labelled-only, gbrain access
 * group add|rm), the member reads (readAccessMembers, readAccessGroups, listPagesNamingReader, readLiveMember,
 * readAudiencePrincipals, listActiveAccessMembers, listAudienceAccessMembers, hasLabelledOnlyMember) and the serves keys.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member insert creates its missing groups and reports only those, sets config
 *    access.restrictions_present to '1' and refreshes the serves keys (serves_derived 'several' at two enabled
 *    members, 'one' after; serves_since set once, to the microsecond, and never cleared); a disable keeps an earlier
 *    disable time; one email belongs to one member, and a write that takes another member's email fails as the unique
 *    index does (23505 on access_members_email_key); the id and kind checks fail as 23514 and an unknown group member
 *    as 23503; a tombstone clears the email, drops the groups and leaves the active list; a group delete drops its
 *    members; a stdio server bound to a member reads as that member with its groups, and as nobody once it is disabled
 *    or removed. Every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    gives the same answers.
 *  - Regression: these writes ran through executeRaw, so on a Rust brain gbrain access member add stopped on the raw_sql
 *    refusal, and the member reads answered constants ([] and null): once members existed, a labelled-only member read
 *    as nobody and would see the unlabelled pages PGLite hides. readAccessCredentials answered [] while tokens existed.
 *  - Why existing coverage misses it: test/access-members.test.ts runs the commands on PGLite only, and the write-misc
 *    parity cases seed members with raw SQL, which stops on the Rust arm.
 *  - Seam: none. Timestamps are reduced to their shape. Token rows are written through the typed insertAccessToken.
 *  - Known losses on Rust (docs/designs/RUST_ENGINE.md row 32a-2 and the rows after it): the credential reads and the
 *    token binding, the labelled-only page policy, applyAttestSources and verifiedMember. The last describe pins each
 *    refusal, so a pin fails when Rust stops refusing and its row must leave the table.
 */
import { describe, expect, test } from 'bun:test';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AccessMemberInsert } from '../../src/core/engine-sql/access-members.ts';
import type { AccessTokenInsert } from '../../src/core/engine-sql/access-tokens.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import {
  addGroup, addMember, bindCredential, disableMember, enableMember, getMember, listGroups, listMembers, memberByEmail, previewRemoveGroup,
  removeGroup, removeGroupMembers, removeMember, setMemberEmail, setMemberKind, verifiedMember,
} from '../../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { ownerMemberId, setOwner } from '../../src/core/access/owner.ts';
import { applyAttestSources } from '../../src/core/access/attest-sources.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { servesStatus } from '../../src/commands/access-serves.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest, arms } = parityArms(testBackends());

const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const member = (id: string, extra: Partial<AccessMemberInsert> = {}): AccessMemberInsert =>
  ({ id, displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null, ...extra });

const tokenRow = (name: string): AccessTokenInsert =>
  ({ name, token_hash: `hash-${name}`, scopes: ['read'], permissions: {}, source_grant: null, source_id: null, federated_read: null, allowed_operations: null, takes_holders: null });

/** The message of a refusal, or 'ok'. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); return 'ok'; } catch (error) { return (error as Error).message; }
}

/** The SQLSTATE and constraint a refused write carries (PGLite `constraint`, postgres.js `constraint_name`), or 'ok'. */
async function sqlRefusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const e = error as Record<string, unknown>;
    return { code: e.code, constraint: e.constraint_name ?? e.constraint };
  }
}

/** A member as the commands report it, with its creation time reduced to whether it is set. */
const view = (m: Awaited<ReturnType<typeof getMember>>) => m && { ...m, created_at: m.created_at !== null };

/** Pages that are always loaded, so listCorePageRows lists what a caller's page policy shows. */
async function seedCorePages(engine: BrainEngine): Promise<void> {
  const page = (frontmatter: Record<string, unknown>) =>
    ({ type: 'note' as const, title: 'Core', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });
  await engine.putPage('core/open', page({}), { sourceId: 'default' });
  await engine.putPage('core/for-alice', page({ readable_by: ['alice-example'] }), { sourceId: 'default' });
  await engine.putPage('core/for-bob', page({ readable_by: ['bob-example'] }), { sourceId: 'default' });
}

const corePages = async (engine: BrainEngine) =>
  (await engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 })).map(r => r.slug).sort();

describe('engine parity: access members', () => {
  // The read-side leak, first: a labelled-only member is read as itself, labelled-only, and never as nobody.
  parityTest('a stdio server bound to a labelled-only member reads as that member, labelled-only, and as nobody once disabled',
    { methods: ['insertAccessMember', 'setAccessMemberLabelledOnly', 'readLiveMember', 'readAccessMembers', 'setAccessMemberDisabled'] }, async (engine) => {
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await addMember(engine, 'alice-example', { groups: ['team-a'] });
      await addMember(engine, 'bob-example');
      await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
      await engine.setConfig('mcp.stdio_member', ' alice-example\n');
      const caller = async () => {
        const access = await remoteCallerAccess(engine, undefined, [], 'stdio');
        return { identity: access.identity, labelledOnly: access.labelledOnly, owner: access.owner, restricted: access.restricted };
      };
      const bound = await caller();
      expect(bound).toEqual({ identity: ['group:team-a', 'member:alice-example'], labelledOnly: true, owner: false, restricted: true });
      await disableMember(engine, 'alice-example');
      const disabled = await caller();
      expect(disabled.identity).toEqual([]);
      return { bound, disabled };
    });

  // Rust arm: a known stop. The store's page policy does not serve a labelled-only caller, so the read refuses and
  // shows nothing (pinned below); it must never show core/open, which PGLite hides.
  parityTest('a labelled-only member reads only the pages that name it, never an unlabelled page',
    { methods: ['insertAccessMember', 'setAccessMemberLabelledOnly', 'listCorePageRows'] }, async (engine) => {
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
      await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
      await engine.setConfig('mcp.stdio_member', 'alice-example');
      await seedCorePages(engine);
      const pages = await withCallerAccess(await remoteCallerAccess(engine, undefined, [], 'stdio'), () => corePages(engine));
      expect(pages).toEqual(['core/for-alice']);
      return pages;
    });

  // Rust arm: a known stop until row 32a-2 serves the token binding (add-member --bind-token reads the token by name).
  parityTest('a token bound to a labelled-only member reads as that member, labelled-only',
    { methods: ['insertAccessToken', 'readAccessCredentials', 'insertAccessMember', 'readLiveMember'] }, async (engine) => {
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      const { id } = await engine.insertAccessToken(tokenRow('group-token'));
      await addMember(engine, 'alice-example', { bindToken: 'group-token' });
      await addMember(engine, 'bob-example');
      await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
      const access = await remoteCallerAccess(engine, { token: 't', clientId: 'c', scopes: [], principal: { kind: 'legacy_token', id } } as never, [], 'http');
      const answer = { identity: access.identity, labelledOnly: access.labelledOnly };
      expect(answer).toEqual({ identity: ['member:alice-example'], labelledOnly: true });
      return answer;
    });

  // Rust arm: a known stop until row 32a-2. Before, the Rust arm answered [] here while the token existed.
  parityTest('readAccessCredentials finds a live token by name, never an empty list while it exists', { methods: ['insertAccessToken', 'readAccessCredentials'] }, async (engine) => {
    const { id } = await engine.insertAccessToken(tokenRow('ci-token'));
    const rows = await engine.readAccessCredentials({ tokenName: 'ci-token' });
    expect(rows).toEqual([{ kind: 'token', id, name: 'ci-token' }]);
    return rows.map(r => ({ ...r, id: r.id === id }));
  });

  parityTest('member add, disable, enable, email, kind and labelled-only read back the same through every member read',
    { methods: ['insertAccessMember', 'setAccessMemberDisabled', 'setAccessMemberEmail', 'setAccessMemberKind', 'setAccessMemberLabelledOnly', 'readAccessMembers',
      'readAudiencePrincipals', 'listActiveAccessMembers', 'listAudienceAccessMembers', 'hasLabelledOnlyMember', 'readAccessGroups'] }, async (engine) => {
      const added = await addMember(engine, 'alice-example', { name: 'Alice', email: 'Alice@Example.com', groups: ['team-a', 'team-b'] });
      const second = await addMember(engine, 'bob-example', { groups: ['team-b'] });
      await addMember(engine, 'carol-example', { kind: 'audience', remote: false });
      const taken = await outcome(() => setMemberEmail(engine, 'bob-example', 'alice@example.com'));
      await setMemberEmail(engine, 'bob-example', 'bob@example.com');
      await setMemberKind(engine, 'bob-example', 'audience', { remote: false });
      const noLabel = await engine.hasLabelledOnlyMember();
      await setMemberLabelledOnly(engine, 'bob-example', true, { remote: false });
      await disableMember(engine, 'carol-example');
      await disableMember(engine, 'carol-example');
      const reads = {
        added: { groups_created: added.groups_created, second: second.groups_created }, taken, noLabel,
        members: (await listMembers(engine)).map(view),
        byEmail: view(await memberByEmail(engine, 'BOB@example.com')),
        active: await engine.listActiveAccessMembers(),
        audience: await engine.listAudienceAccessMembers(),
        labelled: await engine.hasLabelledOnlyMember(),
        principals: await engine.readAudiencePrincipals(['bob-example', 'carol-example', 'team-a'], ['team-a', 'alice-example', 'team-z']),
        groups: await listGroups(engine),
      };
      await enableMember(engine, 'carol-example');
      const enabled = { carol: (await getMember(engine, 'carol-example'))!.status, active: await engine.listActiveAccessMembers() };
      expect(reads.added).toEqual({ groups_created: ['team-a', 'team-b'], second: [] });
      expect(reads.taken).toBe('Member "alice-example" already declares that email.');
      expect(reads.active).toEqual(['alice-example', 'bob-example']);
      expect(reads.audience).toEqual(['bob-example']);
      expect(reads.principals).toEqual({ members: [{ id: 'bob-example', groups: ['team-b'] }], groups: ['team-a'] });
      expect(enabled.active).toEqual(['alice-example', 'bob-example', 'carol-example']);
      return { reads, enabled };
    });

  parityTest('the member writes refuse as the table constraints do', { methods: ['insertAccessMember', 'setAccessMemberEmail', 'setAccessMemberKind', 'addAccessGroupMembers'] }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com' }));
    const refusals = {
      pkey: await sqlRefusal(() => engine.insertAccessMember(member('alice-example'))),
      email: await sqlRefusal(() => engine.insertAccessMember(member('bob-example', { email: 'a@example.com' }))),
      id: await sqlRefusal(() => engine.insertAccessMember(member('Not An Id'))),
      kind: await sqlRefusal(() => engine.setAccessMemberKind('alice-example', 'robot' as never)),
      fkey: await sqlRefusal(() => engine.addAccessGroupMembers('team-a', ['nobody-example'])),
      emailWrite: await sqlRefusal(() => engine.insertAccessMember(member('bob-example')).then(() => engine.setAccessMemberEmail('bob-example', 'a@example.com'))),
    };
    expect(refusals).toEqual({
      pkey: { code: '23505', constraint: 'access_members_pkey' }, email: { code: '23505', constraint: 'access_members_email_key' },
      id: { code: '23514', constraint: 'access_members_id_check' }, kind: { code: '23514', constraint: 'access_members_kind_check' },
      fkey: { code: '23503', constraint: 'access_group_members_member_id_fkey' }, emailWrite: { code: '23505', constraint: 'access_members_email_key' },
    });
    // A refused write changes nothing: the group of the refused group write was not created either.
    const after = { members: (await engine.readAccessMembers({ includeRemoved: true })).map(r => [r.id, r.email]), groups: await engine.readAccessGroups(null) };
    expect(after).toEqual({ members: [['alice-example', 'a@example.com'], ['bob-example', null]], groups: [] });
    return { refusals, after };
  });

  parityTest('groups: add, list, preview the pages naming a group, drop members and delete', { methods: ['addAccessGroupMembers', 'readAccessGroups', 'listPagesNamingReader', 'removeAccessGroupMembers', 'deleteAccessGroup'] }, async (engine, backend) => {
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await createSource(engine, backend, 'team');
    const put = (slug: string, sourceId: string, readers: unknown) =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter: { readable_by: readers } }, { sourceId });
    await put('notes/b', 'team', ['group:team-a']);
    await put('notes/a', 'team', 'GROUP:Team-A ');
    await put('notes/c', 'default', ['group:team-a', 'alice-example']);
    await put('notes/gone', 'default', ['group:team-a']);
    await engine.softDeletePage('notes/gone', { sourceId: 'default' });
    await put('notes/other', 'default', ['group:team-b']);
    const created = await addGroup(engine, 'team-a', ['bob-example', 'alice-example']);
    const again = await addGroup(engine, 'team-a', ['alice-example']);
    const preview = await previewRemoveGroup(engine, 'team-a');
    const live = await engine.listPagesNamingReader('group:team-a', { live: true });
    const member = await engine.listPagesNamingReader('member:alice-example');
    const dropped = await removeGroupMembers(engine, 'team-a', ['bob-example']);
    await removeGroup(engine, 'team-a');
    const answers = { created, again: again.created, pages: preview.pages, live, member, dropped, after: await listGroups(engine), gone: await outcome(() => removeGroup(engine, 'team-a')) };
    expect(answers.created).toEqual({ group: { id: 'team-a', members: ['alice-example', 'bob-example'] }, created: true });
    expect(answers.pages).toEqual([{ slug: 'notes/c', source_id: 'default' }, { slug: 'notes/gone', source_id: 'default' }, { slug: 'notes/a', source_id: 'team' }, { slug: 'notes/b', source_id: 'team' }]);
    expect(answers.live.map(p => p.slug)).toEqual(['notes/c', 'notes/a', 'notes/b']);
    expect(answers.after).toEqual([]);
    return answers;
  });

  parityTest('a member insert marks the brain restricted; the serves keys follow the enabled members and serves_since is set once', { methods: ['insertAccessMember', 'setAccessMemberDisabled', 'getConfig'] }, async (engine) => {
    const keys = async () => {
      const status = await servesStatus(engine, { openPages: false });
      return { serves: status.serves, from: status.from, since: status.since === null ? null : SINCE.test(status.since),
        derived: await engine.getConfig('access.serves_derived'), restricted: await engine.getConfig('access.restrictions_present') };
    };
    const fresh = await keys();
    await addMember(engine, 'alice-example');
    const one = await keys();
    await addMember(engine, 'bob-example');
    const several = await keys();
    const since = await engine.getConfig('access.serves_since');
    await disableMember(engine, 'bob-example');
    const back = { ...await keys(), sinceKept: await engine.getConfig('access.serves_since') === since };
    expect({ fresh, one, several, back }).toEqual({
      fresh: { serves: 'one', from: 'members', since: null, derived: null, restricted: null },
      one: { serves: 'one', from: 'members', since: null, derived: null, restricted: '1' },
      several: { serves: 'several', from: 'members', since: true, derived: 'several', restricted: '1' },
      back: { serves: 'one', from: 'members', since: true, derived: 'one', restricted: '1', sinceKept: true },
    });
    return { fresh, one, several, back };
  });

  parityTest('an explicit access.serves several sets serves_since with no member', { methods: ['setConfig', 'getConfig', 'unsetConfig'] }, async (engine) => {
    await engine.setConfig('access.serves', ' Several ');
    const set = await engine.getConfig('access.serves_since');
    await engine.unsetConfig('access.serves');
    const answers = { since: set !== null && SINCE.test(set), kept: await engine.getConfig('access.serves_since') === set, derived: await engine.getConfig('access.serves_derived') };
    expect(answers).toEqual({ since: true, kept: true, derived: null });
    return answers;
  });

  parityTest('a tombstone removes the member: email cleared, groups dropped, out of the active list; ids match exactly', { methods: ['insertAccessMember', 'tombstoneAccessMember', 'readAccessMembers', 'readLiveMember', 'listActiveAccessMembers', 'setAccessMemberEmail'] }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com', groups: ['team-a'] }));
    await engine.insertAccessMember(member('bob-example'));
    await engine.tombstoneAccessMember('alice-example');
    const [row] = await engine.readAccessMembers({ id: 'alice-example' });
    const answers = {
      row: { email: row!.email, groups: row!.groups, removed: row!.tombstoned_at != null, disabled: row!.disabled_at != null },
      active: await engine.listActiveAccessMembers(),
      live: await engine.readAccessMembers({ includeRemoved: false }).then(rows => rows.map(r => r.id)),
      emailWrite: await engine.setAccessMemberEmail('alice-example', 'x@example.com'),
      liveById: await engine.readLiveMember('member', 'alice-example'),
      liveBob: await engine.readLiveMember('member', 'bob-example'),
      otherCase: await engine.readLiveMember('member', 'Bob-Example'),
      groups: await engine.readAccessGroups('team-a'),
      byEmail: await engine.readAccessMembers({ email: 'a@example.com' }),
    };
    expect(answers).toEqual({ row: { email: null, groups: [], removed: true, disabled: true }, active: ['bob-example'], live: ['bob-example'], emailWrite: false,
      liveById: null, liveBob: { id: 'bob-example', groups: [] }, otherCase: null, groups: [{ id: 'team-a', members: [] }], byEmail: [] });
    return answers;
  });

  parityTest('a Wakeshift forget for a member queues only once that member is removed', { methods: ['insertAccessMember', 'queueWakeForget', 'tombstoneAccessMember', 'countPendingWakeForgets'] }, async (engine) => {
    const user = (n: number) => n.toString(16).padStart(32, '0');
    await engine.insertAccessMember(member('alice-example'));
    await engine.setAccessMemberDisabled('alice-example', true);
    await engine.queueWakeForget(user(1), 'alice-example');
    const whileThere = await engine.countPendingWakeForgets();
    await engine.tombstoneAccessMember('alice-example');
    await engine.queueWakeForget(user(1), 'alice-example');
    await engine.queueWakeForget(user(2), 'nobody-example');
    const answers = { whileThere, after: await engine.countPendingWakeForgets() };
    expect(answers).toEqual({ whileThere: 0, after: 2 });
    return answers;
  });

  parityTest('setOwner refuses a labelled-only member before anything is written', { methods: ['insertAccessMember', 'setAccessMemberLabelledOnly', 'readAccessMembers'] }, async (engine) => {
    await addMember(engine, 'alice-example');
    await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
    const answers = { refusal: await outcome(() => setOwner(engine, 'alice-example')), owner: await ownerMemberId(engine) };
    expect(answers).toEqual({ refusal: 'Member "alice-example" is labelled-only, so it cannot be the brain owner; nothing was changed.', owner: null });
    return answers;
  });

  // Rust arm: a known stop until row 32a-2: the owner view lists the credentials bound to the owner (pinned below).
  parityTest('setOwner names an enabled member the owner and lists its credentials', { methods: ['insertAccessMember', 'readAccessCredentials', 'setConfig'] }, async (engine) => {
    await addMember(engine, 'alice-example');
    const view = await setOwner(engine, 'alice-example');
    expect(view).toEqual({ owner: 'alice-example', bound_credentials: [], reads_restricted: false });
    return view;
  });
});

describe('the Rust arm refuses the credential reads and bindings it does not serve yet, and writes nothing', () => {
  // A parity case counts a typed refusal as a pass, so these read the Rust arm's own engine and pin each refusal: a pin
  // fails when Rust stops refusing, and its row must then leave docs/designs/RUST_ENGINE.md.
  const RAW_SQL = "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";
  const missing = (member: string) => `This brain's engine does not support ${member} yet (it needs the access_control capability), so nothing ran.`;
  const refusal = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return { refused: false };
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    }
  };
  const stop = (message: string) => ({ code: 'engine_capability_missing', message });
  const rustArm = async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (rust) await resetArm(rust);
    return rust?.engine;
  };

  test('loss (32a-2): add-member --bind-token, setOwner and member rm stop on readAccessCredentials, with nothing written', async () => {
    const engine = await rustArm();
    if (!engine) return;
    await engine.insertAccessToken(tokenRow('group-token'));
    expect(await refusal(() => addMember(engine, 'alice-example', { bindToken: 'group-token' }))).toEqual(stop(missing('readAccessCredentials (tokens by name)')));
    expect(await engine.listActiveAccessMembers()).toEqual([]);
    await addMember(engine, 'alice-example');
    expect(await refusal(() => setOwner(engine, 'alice-example'))).toEqual(stop(missing('readAccessCredentials (credentials bound to a member)')));
    expect(await ownerMemberId(engine)).toBeNull();
    expect(await refusal(() => removeMember(engine, 'alice-example'))).toEqual(stop(missing('readAccessCredentials (credentials bound to a member)')));
    expect((await getMember(engine, 'alice-example'))!.status).toBe('enabled');
  });

  test('loss (32a-2): auth rescope --member stops on the raw_sql refusal, and the store refuses a member insert that binds a token', async () => {
    const engine = await rustArm();
    if (!engine) return;
    const { id } = await engine.insertAccessToken(tokenRow('ci-token'));
    await addMember(engine, 'alice-example');
    expect(await refusal(() => bindCredential(engine, { kind: 'token', id }, { member: 'alice-example' }))).toEqual(stop(RAW_SQL));
    expect(await refusal(() => engine.insertAccessMember(member('bob-example', { bindTokenId: id })))).toEqual(stop(missing('insertAccessMember (bindTokenId: the store keeps no token binding yet)')));
    expect(await engine.listActiveAccessMembers()).toEqual(['alice-example']);
  });

  test('loss (32a-2): the token and client parts of readLiveMember (once a member exists) and readMayActFor refuse', async () => {
    const engine = await rustArm();
    if (!engine) return;
    expect(await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-000000000001')).toBeNull();
    await addMember(engine, 'alice-example');
    expect(await refusal(() => engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-000000000001'))).toEqual(stop(missing('readLiveMember (the member binding of a token)')));
    expect(await refusal(() => engine.readLiveMember('oauth_client', 'client-example'))).toEqual(stop(missing('readLiveMember (the member binding of a client)')));
    expect(await refusal(() => engine.readMayActFor('legacy_token', '00000000-0000-4000-8000-000000000001'))).toEqual(stop(missing('readMayActFor (the may_act_for of a token)')));
    expect(await refusal(() => engine.readMayActFor('oauth_client', 'client-example'))).toEqual(stop(missing('readMayActFor (the may_act_for of a client)')));
  });

  test('loss: a labelled-only caller\'s page read refuses on the store page policy and shows no page', async () => {
    const engine = await rustArm();
    if (!engine) return;
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
    await engine.setConfig('mcp.stdio_member', 'alice-example');
    await seedCorePages(engine);
    const access = await remoteCallerAccess(engine, undefined, [], 'stdio');
    expect(access.labelledOnly).toBe(true);
    const read = await refusal(() => withCallerAccess(access, () => corePages(engine)));
    expect(read).toMatchObject({ code: 'engine_capability_missing' });
  });

  test('loss: applyAttestSources and verifiedMember stop on the raw_sql refusal', async () => {
    const engine = await rustArm();
    if (!engine) return;
    await addMember(engine, 'alice-example');
    expect(await refusal(() => applyAttestSources(engine, { kind: 'token', id: 'x' }, ['scope-a'], null))).toEqual(stop(RAW_SQL));
    expect(await refusal(() => verifiedMember(sqlQueryForEngine(engine), 'alice-example'))).toEqual(stop(RAW_SQL));
  });
});
