/**
 * BrainEngine parity — access members and groups: the member and group writes (engine-sql/access-members.ts) the
 * member commands run (access/members.ts: gbrain access member add|disable|enable|set|kind|labelled-only, gbrain access
 * group add|rm), the member reads (readAccessMembers, readAccessGroups, listPagesNamingReader, readLiveMember,
 * readAudiencePrincipals, listActiveAccessMembers, listAudienceAccessMembers, hasLabelledOnlyMember), the serves keys,
 * and the credential binding (gbrain access member add --bind-token, gbrain auth rescope --member: bindCredential over
 * readCredentialBindingForUpdate, writeCredentialBinding and writeCredentialReadsUnscoped; readAccessCredentials,
 * readMayActFor).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member insert creates its missing groups and reports only those, sets config
 *    access.restrictions_present to '1' and refreshes the serves keys (serves_derived 'several' at two enabled
 *    members, 'one' after; serves_since set once, to the microsecond, and never cleared); a disable keeps an earlier
 *    disable time; one email belongs to one member, and a write that takes another member's email fails as the unique
 *    index does (23505 on access_members_email_key); the id and kind checks fail as 23514 and an unknown group member
 *    as 23503; a tombstone clears the email, drops the groups and leaves the active list; a group delete drops its
 *    members; a stdio server, a token or a client bound to a member reads as that member with its groups, and as nobody
 *    once it is disabled or removed or the credential is revoked or deleted; a binding writes the member, may_act_for
 *    and attest columns and stamps reads_unscoped once. Every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    gives the same answers.
 *  - Regression: these writes ran through executeRaw, so on a Rust brain gbrain access member add stopped on the raw_sql
 *    refusal, and the member reads answered constants ([] and null): once members existed, a labelled-only member read
 *    as nobody and would see the unlabelled pages PGLite hides. readAccessCredentials answered [] while tokens existed,
 *    and a token's or client's member and may_act_for read as none.
 *  - Why existing coverage misses it: test/access-members.test.ts runs the commands on PGLite only, and the write-misc
 *    parity cases seed members with raw SQL, which stops on the Rust arm.
 *  - Seam: none. Timestamps are reduced to their shape. Token rows are written through the typed insertAccessToken.
 *  - Known losses on Rust (docs/designs/RUST_ENGINE.md rows 32c to 32g): applyAttestSources, verifiedMember, the
 *    labelled-only page policy, the Wakeshift forget of member rm and the token list (listAccessTokens). The last describe pins each
 *    refusal, so a pin fails when Rust stops refusing and its row must leave the table.
 */
import { describe, expect, test } from 'bun:test';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AccessMemberInsert, CredentialBindingRow } from '../../src/core/engine-sql/access-members.ts';
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
import { openPages } from '../../src/core/access/open-pages.ts';
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

  // Before 32a-2 the Rust arm answered [] here while the token existed.
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

  parityTest('setOwner names an enabled member the owner and lists the credentials bound to it', { methods: ['insertAccessMember', 'insertAccessToken', 'readAccessCredentials', 'setConfig'] }, async (engine) => {
    await engine.insertAccessToken(tokenRow('owner-laptop'));
    await addMember(engine, 'alice-example', { bindToken: 'owner-laptop' });
    const view = await setOwner(engine, 'alice-example');
    const shown = { ...view, bound_credentials: view.bound_credentials.map(c => [c.kind, c.name]) };
    expect(shown).toEqual({ owner: 'alice-example', bound_credentials: [['token', 'owner-laptop']], reads_restricted: false });
    return shown;
  });

  // Rust arm: a known stop (row 32f): the Wakeshift forget is raw SQL that swallows its errors, so member rm refuses
  // before the tombstone. Pinned below.
  parityTest('member rm previews the bound credentials and the pages naming the member, then tombstones it', { methods: ['insertAccessMember', 'insertOauthClient', 'readAccessCredentials', 'listPagesNamingReader', 'tombstoneAccessMember'], requires: 'raw_sql' }, async (engine) => {
    await engine.insertAccessToken(tokenRow('alice-laptop'));
    await addMember(engine, 'alice-example', { bindToken: 'alice-laptop' });
    await engine.insertOauthClient({ client_id: 'client-alice', client_name: 'alice-app', member_id: 'alice-example' });
    await engine.putPage('notes/for-alice', { type: 'note', title: 'x', compiled_truth: 'x', timeline: '', frontmatter: { readable_by: ['alice-example'] } }, { sourceId: 'default' });
    const removed = await removeMember(engine, 'alice-example');
    const shown = { status: removed.member.status, credentials: removed.bound_credentials.map(c => [c.kind, c.name]), pages: removed.pages.map(p => p.slug),
      after: (await engine.readAccessCredentials({ memberId: 'alice-example' })).map(c => c.name), live: await engine.listActiveAccessMembers() };
    expect(shown).toEqual({ status: 'removed', credentials: [['token', 'alice-laptop'], ['client', 'alice-app']], pages: ['notes/for-alice'], after: ['alice-laptop', 'alice-app'], live: [] });
    return shown;
  });

  parityTest('a credential binding locks the row, writes the member and attest columns, and stamps reads_unscoped', {
    methods: ['insertAccessMember', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped', 'transaction', 'insertAccessToken', 'insertOauthClient'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example'));
    const { id: token } = await engine.insertAccessToken(tokenRow('token-a'));
    await engine.insertOauthClient({ client_id: 'client-a', client_name: 'client-a', grant_types: ['authorization_code'] });
    const tokenTarget = { kind: 'token' as const, id: token };
    const clientTarget = { kind: 'client' as const, id: 'client-a' };
    const strip = (row: CredentialBindingRow | undefined) => row && { ...row, reads_unscoped: row.reads_unscoped == null ? null : row.reads_unscoped instanceof Date };
    const out = await engine.transaction(async (tx) => {
      const before = await tx.readCredentialBindingForUpdate(tokenTarget, { readsUnscoped: true });
      await tx.writeCredentialBinding(tokenTarget, { member: 'alice-example', mayActFor: ['member:alice-example'], attestActor: 'qm', attestOps: ['query'], attestSources: ['default'], attestRead: 'scope' });
      await tx.writeCredentialReadsUnscoped(tokenTarget, true);
      await tx.writeCredentialBinding(clientTarget, { member: 'alice-example', mayActFor: null, attestActor: null, attestOps: null, attestSources: null, attestRead: null });
      return {
        before: strip(before),
        token: strip(await tx.readCredentialBindingForUpdate(tokenTarget, { readsUnscoped: true })),
        tokenNarrow: await tx.readCredentialBindingForUpdate(tokenTarget, { readsUnscoped: false }),
        client: await tx.readCredentialBindingForUpdate(clientTarget, { readsUnscoped: false }),
        missing: await tx.readCredentialBindingForUpdate({ kind: 'client', id: 'client-none' }, { readsUnscoped: false }),
        otherCase: await tx.readCredentialBindingForUpdate({ kind: 'token', id: token.toUpperCase() }, { readsUnscoped: false }),
      };
    });
    const bound = { member_id: 'alice-example', may_act_for: ['member:alice-example'], attest_actor: 'qm', attest_ops: ['query'], attest_sources: ['default'], attest_read: 'scope' };
    const none = { member_id: null, may_act_for: null, attest_actor: null, attest_ops: null, attest_sources: null, attest_read: null };
    expect(out as unknown).toEqual({
      before: { ...none, reads_unscoped: null }, token: { ...bound, reads_unscoped: true }, tokenNarrow: bound,
      client: { ...none, member_id: 'alice-example', grant_types: ['authorization_code'], confidential: false }, missing: undefined, otherCase: undefined,
    });
    return out;
  });

  // Leak case: the bind names only the one live token of that name; a client that is not a confidential
  // client-credentials client cannot attest; an unknown credential refuses with the same text on every arm; and the
  // binding reads back through readAccessCredentials, readLiveMember and readMayActFor for the bound member only.
  parityTest('a member add binds the named token, and a rescope binds, attests and refuses the same way on every engine', {
    methods: ['insertAccessMember', 'readAccessCredentials', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped',
      'readLiveMember', 'readMayActFor', 'insertAccessToken', 'insertOauthClient', 'transaction'],
  }, async (engine) => {
    const { id: laptop } = await engine.insertAccessToken(tokenRow('laptop'));
    const { id: phone } = await engine.insertAccessToken(tokenRow('phone'));
    await engine.insertAccessToken({ ...tokenRow('gone'), revoked_at: new Date('2026-01-01T00:00:00Z') });
    await engine.insertOauthClient({ client_id: 'client-public', client_name: 'public-app', grant_types: ['authorization_code'] });
    await engine.insertOauthClient({ client_id: 'client-cc', client_name: 'cc-app', grant_types: ['client_credentials'], client_secret_hash: 'secret-hash' });
    await engine.insertOauthClient({ client_id: 'client-gone', client_name: 'gone-app', member_id: 'alice-example', may_act_for: ['guest'], deleted_at: new Date('2026-01-01T00:00:00Z') });
    const added = await addMember(engine, 'alice-example', { groups: ['team-a'], bindToken: 'laptop' });
    await addMember(engine, 'bob-example');
    const unknownToken = 'c0000000-0000-4000-8000-0000000000ee';
    const out = {
      bound: added.bound && { kind: added.bound.kind, laptop: added.bound.id === laptop, name: added.bound.name },
      laptopBound: await engine.readLiveMember('legacy_token', laptop),
      noToken: await outcome(() => addMember(engine, 'carol-example', { bindToken: 'tablet' })),
      revokedToken: await outcome(() => addMember(engine, 'carol-example', { bindToken: 'gone' })),
      carolAfter: await getMember(engine, 'carol-example'),
      rescope: await bindCredential(engine, { kind: 'token', id: phone }, { member: 'bob-example', mayActFor: ['group:team-a'], readsUnscoped: true }),
      rescopeAgain: await bindCredential(engine, { kind: 'token', id: phone }, { readsUnscoped: true }),
      unbind: await bindCredential(engine, { kind: 'token', id: laptop }, { member: null }),
      attestToken: await bindCredential(engine, { kind: 'token', id: laptop }, { attestActor: 'qm', attestOps: ['query'] }),
      attestPublic: await outcome(() => bindCredential(engine, { kind: 'client', id: 'client-public' }, { attestActor: 'qm' })),
      attestCc: await bindCredential(engine, { kind: 'client', id: 'client-cc' }, { attestActor: 'qm', attestRead: 'person' }),
      clientMember: await bindCredential(engine, { kind: 'client', id: 'client-public' }, { member: 'alice-example', mayActFor: ['member:bob-example'] }),
      dryRun: await bindCredential(engine, { kind: 'token', id: phone }, { member: 'alice-example' }, { dryRun: true }),
      missingToken: await outcome(() => bindCredential(engine, { kind: 'token', id: unknownToken }, { member: 'alice-example' })),
      missingClient: await outcome(() => bindCredential(engine, { kind: 'client', id: 'client-none' }, { member: 'alice-example' })),
      disabledMember: await outcome(async () => { await disableMember(engine, 'bob-example'); await bindCredential(engine, { kind: 'token', id: laptop }, { member: 'bob-example' }); }),
    };
    const names = (rows: Awaited<ReturnType<BrainEngine['readAccessCredentials']>>) => rows.map(r => [r.kind, r.name]);
    const reads = {
      alice: names(await engine.readAccessCredentials({ memberId: 'alice-example' })),
      bob: names(await engine.readAccessCredentials({ memberId: 'bob-example' })),
      byName: names(await engine.readAccessCredentials({ tokenName: 'gone' })),
      laptopMember: await engine.readLiveMember('legacy_token', laptop),
      phoneMember: await engine.readLiveMember('legacy_token', phone),
      clientLiveMember: await engine.readLiveMember('oauth_client', 'client-public'),
      deletedClient: await engine.readLiveMember('oauth_client', 'client-gone'),
      tokenAsClient: await engine.readLiveMember('oauth_client', laptop),
      phoneMayActFor: await engine.readMayActFor('legacy_token', phone),
      clientMayActFor: await engine.readMayActFor('oauth_client', 'client-public'),
      deletedMayActFor: await engine.readMayActFor('oauth_client', 'client-gone'),
    };
    expect({ ...out, ...reads }).toEqual({
      bound: { kind: 'token', laptop: true, name: 'laptop' }, laptopBound: { id: 'alice-example', groups: ['team-a'] },
      noToken: 'No active token named "tablet".', revokedToken: 'No active token named "gone".', carolAfter: null,
      rescope: { member: 'bob-example', may_act_for: ['group:team-a'], reads_unscoped: true, changed: true },
      rescopeAgain: { member: 'bob-example', may_act_for: ['group:team-a'], reads_unscoped: true, changed: false },
      unbind: { member: null, may_act_for: null, changed: true },
      attestToken: { member: null, may_act_for: null, attest_actor: 'qm', attest_ops: ['query'], attest_sources: null, attest_read: null, changed: true },
      attestPublic: 'OAuth client client-public is not a confidential client-credentials client, so it cannot attest people.',
      attestCc: { member: null, may_act_for: null, attest_actor: 'qm', attest_ops: null, attest_sources: null, attest_read: 'person', changed: true },
      clientMember: { member: 'alice-example', may_act_for: ['member:bob-example'], changed: true },
      dryRun: { member: 'alice-example', may_act_for: ['group:team-a'], changed: true },
      missingToken: `No token "${unknownToken}" exists.`, missingClient: 'No OAuth client "client-none" exists.', disabledMember: 'Member "bob-example" is disabled.',
      alice: [['client', 'public-app']], bob: [['token', 'phone']], byName: [], laptopMember: null, phoneMember: null,
      clientLiveMember: { id: 'alice-example', groups: ['team-a'] }, deletedClient: null, tokenAsClient: null,
      phoneMayActFor: ['group:team-a'], clientMayActFor: ['member:bob-example'], deletedMayActFor: null,
    });
    return { ...out, ...reads, bound: out.bound };
  });
});

describe('the Rust arm refuses what it does not serve yet (rows 32c to 32g), and writes nothing', () => {
  // A parity case counts a typed refusal as a pass, so these read the Rust arm's own engine and pin each refusal: a pin
  // fails when Rust stops refusing, and its row must then leave docs/designs/RUST_ENGINE.md.
  const RAW_SQL = "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";
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

  test('loss (32f): member rm refuses before the tombstone, because the Wakeshift forget is raw SQL', async () => {
    const engine = await rustArm();
    if (!engine) return;
    await addMember(engine, 'alice-example');
    expect(await refusal(() => removeMember(engine, 'alice-example')))
      .toEqual(stop("This brain's engine does not support removeMember (the Wakeshift forget of the member) yet (it needs the raw_sql capability), so nothing ran."));
    expect((await getMember(engine, 'alice-example'))!.status).toBe('enabled');
  });

  test('loss (32g): gbrain auth list and the open-page count refuse once a token exists, never an empty list', async () => {
    const engine = await rustArm();
    if (!engine) return;
    expect(await engine.listAccessTokens()).toEqual([]);
    await engine.insertAccessToken(tokenRow('laptop'));
    await addMember(engine, 'alice-example', { bindToken: 'laptop' });
    await addMember(engine, 'bob-example');
    const missing = "This brain's engine does not support listAccessTokens (the token rows) yet (it needs the access_control capability), so nothing ran.";
    expect(await refusal(() => engine.listAccessTokens())).toEqual(stop(missing));
    expect(await refusal(() => openPages(engine))).toEqual(stop(missing));
  });

  test('loss: applyAttestSources and verifiedMember stop on the raw_sql refusal', async () => {
    const engine = await rustArm();
    if (!engine) return;
    await addMember(engine, 'alice-example');
    expect(await refusal(() => applyAttestSources(engine, { kind: 'token', id: 'x' }, ['scope-a'], null))).toEqual(stop(RAW_SQL));
    expect(await refusal(() => verifiedMember(sqlQueryForEngine(engine), 'alice-example'))).toEqual(stop(RAW_SQL));
  });
});
