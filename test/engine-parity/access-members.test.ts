/**
 * BrainEngine parity — the access member and group writes (engine-sql/access-members.ts) the member commands
 * (access/members.ts: gbrain access member add|disable|enable|set|kind|rm, gbrain access group add|rm) run, and the
 * active-member read (listActiveAccessMembers).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member insert creates its missing groups and reports only those, and in the same transaction sets
 *    config access.restrictions_present to '1' (trigger access_members_mark_restricted) and refreshes the serves keys
 *    (trigger access_members_refresh_serves: serves_derived 'several' at two enabled members, 'one' after, and
 *    serves_since set once); a disable keeps an earlier disable time; an email belongs to one member, and a write
 *    that takes another member's email fails as the unique index does (code 23505, constraint_name
 *    access_members_email_key), which refuseEmailRace reads; email and kind writes skip a removed member; a tombstone
 *    clears the email and the member leaves the active list; a group member needs an existing member (23503); a
 *    group delete drops its group members. Every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts) gives the same answers.
 *  - Regression: these writes ran through executeRaw, so on a Rust brain gbrain access member add ended in
 *    engine_capability_missing, and listActiveAccessMembers answered [] there whatever was written: a member-filtered
 *    read never learned that a brain had members. Each case puts the row a dropped clause would let through where
 *    the result shows it (a second member for the count, a removed member for the email and kind writes, a taken
 *    email, an unknown member id).
 *  - Why existing coverage misses it: test/access-members.test.ts runs the commands on PGLite only, and no parity
 *    case wrote a member. The end-to-end cases run the commands (addMember, disable, enable, set --email, kind) and
 *    read back through getMember, listMembers and readAudiencePrincipals on every arm.
 *    The credential binding members (gbrain access member add --bind-token, gbrain auth rescope --member) lock and
 *    write access_tokens and oauth_clients rows; the Rust store keeps no credentials, so there they stop on
 *    engine_capability_missing (test/rust-engine-store.test.ts pins that nothing is written first).
 *  - Seam: none. Timestamps are reduced to their shape; the credential fixture rows are harness-only SQL behind the
 *    backend switch, as test/engine-parity/access-grants.test.ts seeds them.
 */
import { describe, expect } from 'bun:test';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AccessMemberInsert, CredentialBindingRow } from '../../src/core/engine-sql/access-members.ts';
import { addMember, disableMember, enableMember, getMember, listMembers, setMemberEmail, setMemberKind, type MemberRecord } from '../../src/core/access/members.ts';

const { parityTest } = parityArms(testBackends());

const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function member(id: string, extra: Partial<AccessMemberInsert> = {}): AccessMemberInsert {
  return { id, displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null, ...extra };
}

/** The Postgres error fields the member commands read, or 'ok'. */
async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return 'ok'; }
  catch (error) {
    const e = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    return { code: String(e.code), constraint: e.constraint_name ?? e.constraint };
  }
}

const serves = async (engine: BrainEngine) => ({
  derived: await engine.getConfig('access.serves_derived'),
  since: (await engine.getConfig('access.serves_since'))?.replace(SINCE, '<since>') ?? null,
});

describe('access member writes', () => {
  parityTest('a member insert sets the restriction flag and reports only the groups it created', {
    methods: ['insertAccessMember', 'getConfig', 'listActiveAccessMembers', 'readAccessMemberIdByEmail'],
  }, async (engine) => {
    const flagBefore = await engine.getConfig('access.restrictions_present');
    const first = await engine.insertAccessMember(member('alice-example', { displayName: 'Alice', email: 'a@example.com', groups: ['team-a', 'team-b'] }));
    const flagAfter = await engine.getConfig('access.restrictions_present');
    const second = await engine.insertAccessMember(member('bob-example', { kind: 'audience', groups: ['team-b', 'team-c'] }));
    const out = {
      flagBefore, flagAfter, first, second,
      active: await engine.listActiveAccessMembers(),
      byEmail: await engine.readAccessMemberIdByEmail('a@example.com'),
      noEmail: await engine.readAccessMemberIdByEmail('n@example.com'),
    };
    expect(out).toEqual({
      flagBefore: null, flagAfter: '1', first: { groupsCreated: ['team-a', 'team-b'] }, second: { groupsCreated: ['team-c'] },
      active: ['alice-example', 'bob-example'], byEmail: 'alice-example', noEmail: null,
    });
    return out;
  });

  parityTest('a refused insert writes nothing: a duplicate id, a taken email, an ill-formed id and kind', {
    methods: ['insertAccessMember', 'listActiveAccessMembers', 'getConfig'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com' }));
    const out = {
      duplicate: await refusal(() => engine.insertAccessMember(member('alice-example'))),
      email: await refusal(() => engine.insertAccessMember(member('carol-example', { email: 'a@example.com', groups: ['team-x'] }))),
      badId: await refusal(() => engine.insertAccessMember(member('Carol'))),
      badKind: await refusal(() => engine.insertAccessMember(member('carol-example', { kind: 'robot' as never }))),
      badGroup: await refusal(() => engine.insertAccessMember(member('carol-example', { groups: ['Team X'] }))),
      active: await engine.listActiveAccessMembers(),
      derived: await engine.getConfig('access.serves_derived'),
    };
    expect(out).toEqual({
      duplicate: { code: '23505', constraint: 'access_members_pkey' },
      email: { code: '23505', constraint: 'access_members_email_key' },
      badId: { code: '23514', constraint: 'access_members_id_check' },
      badKind: { code: '23514', constraint: 'access_members_kind_check' },
      badGroup: { code: '23514', constraint: 'access_groups_id_check' },
      active: ['alice-example'], derived: null,
    });
    return out;
  });

  parityTest('two enabled members serve several; a disable serves one and keeps serves_since and the first disable', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'listActiveAccessMembers', 'getConfig'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example'));
    const one = await serves(engine);
    await engine.insertAccessMember(member('bob-example'));
    const several = await serves(engine);
    const since = await engine.getConfig('access.serves_since');
    await engine.setAccessMemberDisabled('bob-example', true);
    await engine.setAccessMemberDisabled('bob-example', true);
    const disabled = { ...(await serves(engine)), sinceKept: (await engine.getConfig('access.serves_since')) === since, active: await engine.listActiveAccessMembers() };
    await engine.setAccessMemberDisabled('bob-example', false);
    await engine.setAccessMemberDisabled('nobody', true);
    const enabled = { ...(await serves(engine)), active: await engine.listActiveAccessMembers() };
    const out = { one, several, disabled, enabled };
    expect(out).toEqual({
      one: { derived: null, since: null },
      several: { derived: 'several', since: '<since>' },
      disabled: { derived: 'one', since: '<since>', sinceKept: true, active: ['alice-example'] },
      enabled: { derived: 'several', since: '<since>', active: ['alice-example', 'bob-example'] },
    });
    return out;
  });

  parityTest('an email belongs to one member, and email and kind writes skip a removed member', {
    methods: ['insertAccessMember', 'setAccessMemberEmail', 'setAccessMemberKind', 'tombstoneAccessMember', 'readAccessMemberIdByEmail'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com' }));
    await engine.insertAccessMember(member('bob-example'));
    const out = {
      taken: await refusal(() => engine.setAccessMemberEmail('bob-example', 'a@example.com')),
      set: await engine.setAccessMemberEmail('bob-example', 'b@example.com'),
      cleared: await engine.setAccessMemberEmail('alice-example', null),
      aliceEmail: await engine.readAccessMemberIdByEmail('a@example.com'),
      bobEmail: await engine.readAccessMemberIdByEmail('b@example.com'),
      unknown: await engine.setAccessMemberEmail('nobody', 'n@example.com'),
      badKind: await refusal(() => engine.setAccessMemberKind('bob-example', 'robot' as never)),
      removedEmail: false as boolean,
    };
    await engine.setAccessMemberKind('bob-example', 'audience');
    await engine.tombstoneAccessMember('bob-example');
    out.removedEmail = await engine.setAccessMemberEmail('bob-example', 'c@example.com');
    expect(out).toEqual({
      taken: { code: '23505', constraint: 'access_members_email_key' }, set: true, cleared: true, aliceEmail: null,
      bobEmail: 'bob-example', unknown: false, badKind: { code: '23514', constraint: 'access_members_kind_check' }, removedEmail: false,
    });
    return out;
  });

  parityTest('a tombstone clears the email, leaves the active list and frees the email', {
    methods: ['insertAccessMember', 'tombstoneAccessMember', 'listActiveAccessMembers', 'readAccessMemberIdByEmail', 'getConfig'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com', groups: ['team-a'] }));
    await engine.insertAccessMember(member('bob-example', { groups: ['team-a'] }));
    await engine.tombstoneAccessMember('alice-example');
    await engine.tombstoneAccessMember('nobody');
    const out = {
      active: await engine.listActiveAccessMembers(),
      email: await engine.readAccessMemberIdByEmail('a@example.com'),
      ...(await serves(engine)),
      again: await refusal(() => engine.insertAccessMember(member('alice-example'))),
      reuse: await refusal(() => engine.insertAccessMember(member('carol-example', { email: 'a@example.com' }))),
    };
    expect(out).toEqual({
      active: ['bob-example'], email: null, derived: 'one', since: '<since>',
      again: { code: '23505', constraint: 'access_members_pkey' }, reuse: 'ok',
    });
    return out;
  });

  parityTest('group writes: create once, an unknown member refused, remove and delete', {
    methods: ['insertAccessMember', 'addAccessGroupMembers', 'removeAccessGroupMembers', 'deleteAccessGroup'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example'));
    await engine.insertAccessMember(member('bob-example'));
    const out = {
      created: await engine.addAccessGroupMembers('team-a', ['alice-example', 'bob-example']),
      again: await engine.addAccessGroupMembers('team-a', ['alice-example']),
      unknown: await refusal(() => engine.addAccessGroupMembers('team-a', ['nobody'])),
      badGroup: await refusal(() => engine.addAccessGroupMembers('Team A', [])),
      removed: await refusal(() => engine.removeAccessGroupMembers('team-a', ['alice-example', 'nobody'])),
      deleted: await refusal(() => engine.deleteAccessGroup('team-a')),
      recreated: await engine.addAccessGroupMembers('team-a', []),
      // A member insert naming a group that exists creates nothing.
      insert: await engine.insertAccessMember(member('carol-example', { groups: ['team-a'] })),
    };
    expect(out).toEqual({
      created: true, again: false, unknown: { code: '23503', constraint: 'access_group_members_member_id_fkey' },
      badGroup: { code: '23514', constraint: 'access_groups_id_check' }, removed: 'ok', deleted: 'ok', recreated: true,
      insert: { groupsCreated: [] },
    });
    return out;
  });

  parityTest('a credential binding locks the row, writes member and attest columns, and stamps reads_unscoped', {
    methods: ['insertAccessMember', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped', 'transaction'],
  }, async (engine, backend: ParityBackend) => {
    await engine.insertAccessMember(member('alice-example'));
    let token = 'c0000000-0000-4000-8000-0000000000e9';
    if (backend !== 'rust') {
      token = (await engine.executeRaw<{ id: string }>(
        `INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('token-a', 'hash-a', ARRAY['read']::text[]) RETURNING id::text AS id`))[0]!.id;
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
        client_id_issued_at, source_id) VALUES ('client-a', NULL, 'client-a', '{}', '{authorization_code}', 'read', 'none', 0, 'default')`);
    }
    const tokenTarget = { kind: 'token' as const, id: token };
    const clientTarget = { kind: 'client' as const, id: 'client-a' };
    const strip = (row: CredentialBindingRow | undefined) => row && { ...row, reads_unscoped: row.reads_unscoped == null ? null : 'set' };
    const out = await engine.transaction(async (tx) => {
      const before = await tx.readCredentialBindingForUpdate(tokenTarget, { readsUnscoped: true });
      await tx.writeCredentialBinding(tokenTarget, { member: 'alice-example', mayActFor: ['alice-example'], attestActor: 'alice-example', attestOps: ['query'], attestSources: ['default'], attestRead: 'scope' });
      await tx.writeCredentialReadsUnscoped(tokenTarget, true);
      await tx.writeCredentialBinding(clientTarget, { member: 'alice-example', mayActFor: null, attestActor: null, attestOps: null, attestSources: null, attestRead: null });
      return {
        before: strip(before),
        token: strip(await tx.readCredentialBindingForUpdate(tokenTarget, { readsUnscoped: true })),
        tokenNarrow: await tx.readCredentialBindingForUpdate(tokenTarget, { readsUnscoped: false }),
        client: await tx.readCredentialBindingForUpdate(clientTarget, { readsUnscoped: false }),
        missing: await tx.readCredentialBindingForUpdate({ kind: 'client', id: 'client-none' }, { readsUnscoped: false }),
      };
    });
    const bound = { member_id: 'alice-example', may_act_for: ['alice-example'], attest_actor: 'alice-example', attest_ops: ['query'], attest_sources: ['default'], attest_read: 'scope' };
    const none = { member_id: null, may_act_for: null, attest_actor: null, attest_ops: null, attest_sources: null, attest_read: null };
    expect(out as unknown).toEqual({
      before: { ...none, reads_unscoped: null },
      token: { ...bound, reads_unscoped: 'set' },
      tokenNarrow: bound,
      client: { ...none, member_id: 'alice-example', grant_types: ['authorization_code'], confidential: false },
      missing: undefined,
    });
    return out;
  });
});

/** A member record with its creation time reduced to its shape. */
const shape = (m: MemberRecord | null) => m && { ...m, created_at: SINCE_ISO.test(m.created_at ?? '') ? '<created>' : m.created_at };
const SINCE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The operation error fields a member command refusal carries, or 'ok'. */
async function opRefusal(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return 'ok'; }
  catch (error) {
    const e = error as { code?: unknown; reason?: unknown; details?: { reason?: unknown } };
    return { code: e.code, reason: e.reason ?? e.details?.reason ?? null };
  }
}

describe('access member commands, end to end', () => {
  parityTest('gbrain access member add, disable, enable, set --email and kind read back through getMember and listMembers', {
    methods: ['insertAccessMember', 'readAccessMembers', 'readAccessMemberIdByEmail', 'setAccessMemberDisabled', 'setAccessMemberEmail', 'setAccessMemberKind'],
  }, async (engine) => {
    const added = await addMember(engine, 'alice-example', { name: 'Alice', email: 'a@example.com', groups: ['team-a'] });
    const out = {
      added: { ...added, member: shape(added.member) },
      takenEmail: await opRefusal(() => addMember(engine, 'bob-example', { email: 'a@example.com' })),
      again: await opRefusal(() => addMember(engine, 'alice-example')),
      bob: shape((await addMember(engine, 'bob-example', { groups: ['team-a', 'team-b'] })).member),
      disabled: shape(await disableMember(engine, 'bob-example')),
      enabled: shape(await enableMember(engine, 'bob-example')),
      email: await setMemberEmail(engine, 'alice-example', null).then(r => ({ changed: r.changed, email: r.member.email })),
      kind: await setMemberKind(engine, 'bob-example', 'audience', { remote: false }).then(r => ({ changed: r.changed, kind: r.member.kind })),
      unknown: await getMember(engine, 'zz-none'),
      list: (await listMembers(engine)).map(m => [m.id, m.status, m.kind, m.email, m.groups]),
    };
    expect(out).toEqual({
      added: {
        member: { id: 'alice-example', display_name: 'Alice', email: 'a@example.com', status: 'enabled', kind: 'person', labelled_only: false, groups: ['team-a'], created_at: '<created>' },
        groups_created: ['team-a'], bound: null,
      },
      takenEmail: { code: 'access_member_invalid', reason: 'email_taken' },
      again: { code: 'access_member_invalid', reason: 'exists' },
      bob: { id: 'bob-example', display_name: null, email: null, status: 'enabled', kind: 'person', labelled_only: false, groups: ['team-a', 'team-b'], created_at: '<created>' },
      disabled: { id: 'bob-example', display_name: null, email: null, status: 'disabled', kind: 'person', labelled_only: false, groups: ['team-a', 'team-b'], created_at: '<created>' },
      enabled: { id: 'bob-example', display_name: null, email: null, status: 'enabled', kind: 'person', labelled_only: false, groups: ['team-a', 'team-b'], created_at: '<created>' },
      email: { changed: true, email: null },
      kind: { changed: true, kind: 'audience' },
      unknown: null,
      list: [['alice-example', 'enabled', 'person', null, ['team-a']], ['bob-example', 'enabled', 'audience', null, ['team-a', 'team-b']]],
    });
    return out;
  });

  parityTest('readAudiencePrincipals names only the enabled members and the existing groups asked for', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember', 'readAudiencePrincipals'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { groups: ['team-b', 'team-a'] }));
    await engine.insertAccessMember(member('bob-example'));
    await engine.insertAccessMember(member('carol-example', { groups: ['team-c'] }));
    await engine.setAccessMemberDisabled('bob-example', true);
    await engine.tombstoneAccessMember('carol-example');
    const read = await engine.readAudiencePrincipals(['alice-example', 'bob-example', 'carol-example', 'zz-none'], ['team-a', 'team-c', 'zz-none']);
    const out = {
      members: [...read.members].sort((a, b) => (a.id < b.id ? -1 : 1)),
      groups: [...read.groups].sort(),
      empty: await engine.readAudiencePrincipals([], []),
    };
    expect(out).toEqual({
      members: [{ id: 'alice-example', groups: ['team-a', 'team-b'] }],
      groups: ['team-a', 'team-c'],
      empty: { members: [], groups: [] },
    });
    return out;
  });
});
