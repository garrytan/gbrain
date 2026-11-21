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
 *    case wrote a member. The end-to-end cases run the commands (addMember, disable, enable, set --email, kind,
 *    labelled-only) and read back through getMember, listMembers and readAudiencePrincipals on every arm.
 *    The credential binding members (gbrain access member add --bind-token, gbrain auth rescope --member) lock and
 *    write access_tokens and oauth_clients rows; the Rust store keeps them on its token and client records, so every
 *    arm compares the binding, the refusals and the reads back (readAccessCredentials, readLiveMember, readMayActFor).
 *  - Seam: none. Timestamps are reduced to their shape; the credential rows are seeded through the typed
 *    insertAccessToken and insertOauthClient. A client binding with the attest-sources marks runs on every arm too
 *    (the last case), its sources written through the harness helpers.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AccessMemberInsert, CredentialBindingRow } from '../../src/core/engine-sql/access-members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import type { AccessTokenInsert } from '../../src/core/engine-sql/access-tokens.ts';
import { addMember, bindCredential, disableMember, enableMember, getMember, listMembers, memberByEmail, setMemberEmail, setMemberKind, type MemberRecord } from '../../src/core/access/members.ts';

const { parityTest } = parityArms(testBackends());

const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const TOKEN_GRANT = { source_grant: 'default', source_id: null, federated_read: null, allowed_operations: null, takes_holders: null };

function member(id: string, extra: Partial<AccessMemberInsert> = {}): AccessMemberInsert {
  return { id, displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null, ...extra };
}

/** A read-scoped token row for insertAccessToken, with no other grant column. */
function tokenRow(name: string): AccessTokenInsert {
  return { name, token_hash: `hash-${name}`, scopes: ['read'], permissions: {}, source_grant: null, source_id: null, federated_read: null, allowed_operations: null, takes_holders: null };
}

/** The message a command refusal carries, or 'ok'. */
async function opMessage(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return 'ok'; } catch (error) { return (error as Error).message; }
}

/** The Postgres error fields the member commands read, or 'ok'. */
async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return 'ok'; }
  catch (error) {
    const e = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    return { code: String(e.code), constraint: e.constraint_name ?? e.constraint };
  }
}

/** The id of the member that declares `email`, through lane 12's typed email read (readAccessMembers({ email })). */
const emailOwner = async (engine: BrainEngine, email: string): Promise<string | null> => (await engine.readAccessMembers({ email }))[0]?.id ?? null;

const serves = async (engine: BrainEngine) => ({
  derived: await engine.getConfig('access.serves_derived'),
  since: (await engine.getConfig('access.serves_since'))?.replace(SINCE, '<since>') ?? null,
});

describe('access member writes', () => {
  parityTest('a member insert sets the restriction flag and reports only the groups it created', {
    methods: ['insertAccessMember', 'getConfig', 'listActiveAccessMembers', 'readAccessMembers'],
  }, async (engine) => {
    const flagBefore = await engine.getConfig('access.restrictions_present');
    const first = await engine.insertAccessMember(member('alice-example', { displayName: 'Alice', email: 'a@example.com', groups: ['team-a', 'team-b'] }));
    const flagAfter = await engine.getConfig('access.restrictions_present');
    const second = await engine.insertAccessMember(member('bob-example', { kind: 'audience', groups: ['team-b', 'team-c'] }));
    const out = {
      flagBefore, flagAfter, first, second,
      active: await engine.listActiveAccessMembers(),
      byEmail: await emailOwner(engine, 'a@example.com'),
      noEmail: await emailOwner(engine, 'n@example.com'),
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
    methods: ['insertAccessMember', 'setAccessMemberEmail', 'setAccessMemberKind', 'tombstoneAccessMember', 'readAccessMembers'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com' }));
    await engine.insertAccessMember(member('bob-example'));
    const out = {
      taken: await refusal(() => engine.setAccessMemberEmail('bob-example', 'a@example.com')),
      set: await engine.setAccessMemberEmail('bob-example', 'b@example.com'),
      cleared: await engine.setAccessMemberEmail('alice-example', null),
      aliceEmail: await emailOwner(engine, 'a@example.com'),
      bobEmail: await emailOwner(engine, 'b@example.com'),
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
    methods: ['insertAccessMember', 'tombstoneAccessMember', 'listActiveAccessMembers', 'readAccessMembers', 'getConfig'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example', { email: 'a@example.com', groups: ['team-a'] }));
    await engine.insertAccessMember(member('bob-example', { groups: ['team-a'] }));
    await engine.tombstoneAccessMember('alice-example');
    await engine.tombstoneAccessMember('nobody');
    const out = {
      active: await engine.listActiveAccessMembers(),
      email: await emailOwner(engine, 'a@example.com'),
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
    methods: ['insertAccessMember', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped', 'transaction', 'insertAccessToken', 'insertOauthClient'],
  }, async (engine) => {
    await engine.insertAccessMember(member('alice-example'));
    const { id: token } = await engine.insertAccessToken(tokenRow('token-a'));
    await engine.insertOauthClient({
      client_id: 'client-a', client_secret_hash: null, client_name: 'client-a', redirect_uris: [], grant_types: ['authorization_code'], scope: 'read',
      token_endpoint_auth_method: 'none', client_id_issued_at: 0, source_id: 'default',
    });
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
        missingToken: await tx.readCredentialBindingForUpdate({ kind: 'token', id: '00000000-0000-4000-8000-00000000dead' }, { readsUnscoped: false }),
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
      missingToken: undefined,
    });
    return out;
  });

  // gbrain access member add --bind-token and gbrain auth rescope --member/--may-act-for/--attest-actor, end to end.
  // Leak case (access checks): the bind names only the one live token of that name; a client that is not a confidential
  // client-credentials client cannot attest; an unknown credential refuses with the same text on every arm; and the
  // binding then reads back through readAccessCredentials and readLiveMember for the bound member only.
  parityTest('a member add binds the named token, and a rescope binds, attests and refuses the same way on every engine', {
    methods: ['insertAccessMember', 'readAccessCredentials', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped',
      'readLiveMember', 'readMayActFor', 'insertAccessToken', 'insertOauthClient', 'transaction'],
  }, async (engine) => {
    const { id: laptop } = await engine.insertAccessToken(tokenRow('laptop'));
    const { id: phone } = await engine.insertAccessToken(tokenRow('phone'));
    await engine.insertOauthClient({ client_id: 'client-public', client_name: 'public-app', grant_types: ['authorization_code'] });
    await engine.insertOauthClient({ client_id: 'client-cc', client_name: 'cc-app', grant_types: ['client_credentials'], client_secret_hash: 'secret-hash' });
    const added = await addMember(engine, 'alice-example', { groups: ['team-a'], bindToken: 'laptop' });
    await addMember(engine, 'bob-example');
    const unknownToken = 'c0000000-0000-4000-8000-0000000000ee';
    const out = {
      bound: added.bound && { kind: added.bound.kind, laptop: added.bound.id === laptop, name: added.bound.name },
      noToken: await opMessage(() => addMember(engine, 'carol-example', { bindToken: 'tablet' })),
      carolAfter: await getMember(engine, 'carol-example'),
      rescope: await bindCredential(engine, { kind: 'token', id: phone }, { member: 'bob-example', mayActFor: ['group:team-a'], readsUnscoped: true }),
      rescopeAgain: await bindCredential(engine, { kind: 'token', id: phone }, { readsUnscoped: true }),
      unbind: await bindCredential(engine, { kind: 'token', id: laptop }, { member: null }),
      attestToken: await bindCredential(engine, { kind: 'token', id: laptop }, { attestActor: 'qm', attestOps: ['query'] }),
      attestPublic: await opMessage(() => bindCredential(engine, { kind: 'client', id: 'client-public' }, { attestActor: 'qm' })),
      attestCc: await bindCredential(engine, { kind: 'client', id: 'client-cc' }, { attestActor: 'qm', attestRead: 'person' }),
      clientMember: await bindCredential(engine, { kind: 'client', id: 'client-public' }, { member: 'alice-example', mayActFor: ['member:bob-example'] }),
      missingToken: await opMessage(() => bindCredential(engine, { kind: 'token', id: unknownToken }, { member: 'alice-example' })),
      missingClient: await opMessage(() => bindCredential(engine, { kind: 'client', id: 'client-none' }, { member: 'alice-example' })),
      disabledMember: await opMessage(async () => { await disableMember(engine, 'bob-example'); await bindCredential(engine, { kind: 'token', id: laptop }, { member: 'bob-example' }); }),
    };
    const names = (rows: Awaited<ReturnType<BrainEngine['readAccessCredentials']>>) => rows.map(r => [r.kind, r.name]);
    const reads = {
      alice: names(await engine.readAccessCredentials({ memberId: 'alice-example' })),
      bob: names(await engine.readAccessCredentials({ memberId: 'bob-example' })),
      laptopMember: await engine.readLiveMember('legacy_token', laptop),
      phoneMember: await engine.readLiveMember('legacy_token', phone),
      clientLiveMember: await engine.readLiveMember('oauth_client', 'client-public'),
      phoneMayActFor: await engine.readMayActFor('legacy_token', phone),
      clientMayActFor: await engine.readMayActFor('oauth_client', 'client-public'),
    };
    expect({ ...out, ...reads }).toEqual({
      bound: { kind: 'token', laptop: true, name: 'laptop' },
      noToken: 'No active token named "tablet".',
      carolAfter: null,
      rescope: { member: 'bob-example', may_act_for: ['group:team-a'], reads_unscoped: true, changed: true },
      rescopeAgain: { member: 'bob-example', may_act_for: ['group:team-a'], reads_unscoped: true, changed: false },
      unbind: { member: null, may_act_for: null, changed: true },
      attestToken: { member: null, may_act_for: null, attest_actor: 'qm', attest_ops: ['query'], attest_sources: null, attest_read: null, changed: true },
      attestPublic: 'OAuth client client-public is not a confidential client-credentials client, so it cannot attest people.',
      attestCc: { member: null, may_act_for: null, attest_actor: 'qm', attest_ops: null, attest_sources: null, attest_read: 'person', changed: true },
      clientMember: { member: 'alice-example', may_act_for: ['member:bob-example'], changed: true },
      missingToken: `No token "${unknownToken}" exists.`,
      missingClient: 'No OAuth client "client-none" exists.',
      disabledMember: 'Member "bob-example" is disabled.',
      alice: [['client', 'public-app']],
      bob: [['token', 'phone']],
      laptopMember: null,
      phoneMember: null,
      clientLiveMember: { id: 'alice-example', groups: ['team-a'] },
      phoneMayActFor: ['group:team-a'],
      clientMayActFor: ['member:bob-example'],
    });
    return { ...out, ...reads };
  });

  parityTest('bind a client to a member and list scope sources (--attest-sources): the checks, the marks and the binding commit together, and a refusal or a dry run changes nothing', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'insertOauthClient', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped',
      'readScopeSourceConfigs', 'readSourceAttestState', 'replaceSourceConfig', 'readLiveMember', 'deleteOAuthClient'],
  }, async (engine, backend: ParityBackend) => {
    await engine.insertAccessMember(member('alice-example', { groups: ['team-a'] }));
    await engine.insertAccessMember(member('bob-example'));
    await engine.setAccessMemberDisabled('bob-example', true);
    await createSource(engine, backend, 'scope-a');
    await createSource(engine, backend, 'scope-b', { note: 'kept' });
    await createSource(engine, backend, 'scope-shared', { federated: true });
    await createSource(engine, backend, 'scope-old');
    await archiveSource(engine, backend, 'scope-old');
    const trusted = { client_id: 'trusted', client_name: 'trusted', client_secret_hash: 'hash-trusted', grant_types: ['client_credentials'], scope: 'read write', source_id: 'default' };
    await engine.insertOauthClient(trusted);
    await engine.insertOauthClient({ client_id: 'person-client', client_name: 'person-client', grant_types: ['authorization_code'], scope: 'read' });
    const target = { kind: 'client' as const, id: 'trusted' };
    const binding = async (id: string) => {
      const row = await engine.transaction(tx => tx.readCredentialBindingForUpdate({ kind: 'client', id }, { readsUnscoped: true }));
      return row && { ...row, reads_unscoped: row.reads_unscoped == null ? null : 'set' };
    };
    const config = async (id: string) => (await engine.readScopeSourceConfigs([id]))[0]?.config;
    const failure = async (run: () => Promise<unknown>) => {
      try { await run(); return 'ok'; } catch (error) { const e = error as { code?: unknown; message?: unknown }; return { code: e.code, message: e.message }; }
    };
    const out: Record<string, unknown> = {};
    out.preview = await bindCredential(engine, target, { attestActor: 'qm', attestOps: ['memory_write'], attestSources: ['scope-b'] }, { dryRun: true });
    out.previewKept = { binding: await binding('trusted'), scopeB: await config('scope-b') };
    out.bound = await bindCredential(engine, target, { attestActor: 'qm', attestOps: ['memory_write'], attestSources: ['scope-b', 'scope-a', 'scope-a'], readsUnscoped: true });
    out.afterBind = { binding: await binding('trusted'), scopeA: await config('scope-a'), scopeB: await config('scope-b') };
    out.restated = await bindCredential(engine, target, { attestSources: ['scope-a', 'scope-b'] });
    out.refused = {
      unknown: await failure(() => bindCredential(engine, target, { attestSources: ['scope-none'] })),
      archived: await failure(() => bindCredential(engine, target, { attestSources: ['scope-old'] })),
      federated: await failure(() => bindCredential(engine, target, { attestSources: ['scope-shared'] })),
      default: await failure(() => bindCredential(engine, target, { attestSources: ['default'] })),
      noActor: await failure(() => bindCredential(engine, { kind: 'client', id: 'person-client' }, { attestSources: ['scope-a'] })),
      notConfidential: await failure(() => bindCredential(engine, { kind: 'client', id: 'person-client' }, { attestActor: 'qm' })),
      noClient: await failure(() => bindCredential(engine, { kind: 'client', id: 'nobody' }, { member: 'alice-example' })),
      disabledMember: await failure(() => bindCredential(engine, { kind: 'client', id: 'person-client' }, { member: 'bob-example' })),
    };
    out.afterRefusals = { trusted: await binding('trusted'), person: await binding('person-client'), scopeOld: await config('scope-old'), scopeShared: await config('scope-shared') };
    out.cleared = await bindCredential(engine, target, { attestActor: null, readsUnscoped: false });
    out.afterClear = await binding('trusted');
    out.memberBound = await bindCredential(engine, { kind: 'client', id: 'person-client' }, { member: 'alice-example', mayActFor: ['alice-example'] });
    out.identity = {
      live: await engine.readLiveMember('oauth_client', 'person-client'),
      unbound: await engine.readLiveMember('oauth_client', 'trusted'),
      unknown: await engine.readLiveMember('oauth_client', 'nobody'),
    };
    await engine.setAccessMemberDisabled('alice-example', true);
    const disabled = await engine.readLiveMember('oauth_client', 'person-client');
    await engine.setAccessMemberDisabled('alice-example', false);
    const reenabled = await engine.readLiveMember('oauth_client', 'person-client');
    await engine.deleteOAuthClient('person-client');
    out.identityAfter = { disabled, reenabled, deleted: await engine.readLiveMember('oauth_client', 'person-client') };
    out.sourceState = { present: await engine.readSourceAttestState('scope-a'), archived: (await engine.readSourceAttestState('scope-old'))?.archived, missing: await engine.readSourceAttestState('scope-none') };
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
    methods: ['insertAccessMember', 'readAccessMembers', 'setAccessMemberDisabled', 'setAccessMemberEmail', 'setAccessMemberKind'],
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

  parityTest('gbrain access member labelled-only sets and clears the grant, and refuses the owner, a removed member and a remote caller', {
    methods: ['insertAccessMember', 'readAccessMembers', 'setAccessMemberLabelledOnly', 'tombstoneAccessMember'],
  }, async (engine) => {
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    await addMember(engine, 'carol-example');
    await engine.tombstoneAccessMember('carol-example');
    await engine.setConfig('access.owner_member', 'bob-example');
    const flag = (r: { changed: boolean; member: MemberRecord }) => ({ changed: r.changed, labelled_only: r.member.labelled_only });
    const out = {
      remote: await opRefusal(() => setMemberLabelledOnly(engine, 'alice-example', true, { remote: true })),
      on: flag(await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false })),
      again: flag(await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false })),
      owner: await opRefusal(() => setMemberLabelledOnly(engine, 'bob-example', true, { remote: false })),
      removed: await opRefusal(() => setMemberLabelledOnly(engine, 'carol-example', true, { remote: false })),
      afterOn: (await listMembers(engine)).map(m => [m.id, m.labelled_only]),
      off: flag(await setMemberLabelledOnly(engine, 'alice-example', false, { remote: false })),
      afterOff: (await listMembers(engine)).map(m => [m.id, m.labelled_only]),
    };
    expect(out).toEqual({
      remote: { code: 'permission_denied', reason: null },
      on: { changed: true, labelled_only: true },
      again: { changed: false, labelled_only: true },
      owner: { code: 'access_labelled_only_owner', reason: null },
      removed: { code: 'access_member_id_retired', reason: null },
      afterOn: [['alice-example', true], ['bob-example', false]],
      off: { changed: true, labelled_only: false },
      afterOff: [['alice-example', false], ['bob-example', false]],
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

// The member and group reads lane 12 typed (readAccessMembers by email, listAudienceAccessMembers, readLiveMember,
// readAccessGroups) answer the members and groups the typed writes made, on every engine: on Rust they read the store.
describe('access member and group reads after the typed writes', () => {
  /** Five members across groups: an audience member with an email and two groups, a disabled one, a removed one. */
  async function seedMembers(engine: BrainEngine) {
    await engine.insertAccessMember(member('zed-example', { kind: 'audience', email: 'z@example.com', groups: ['team-b', 'team-a'] }));
    await engine.insertAccessMember(member('alice-example', { kind: 'audience', groups: ['team-a'] }));
    await engine.insertAccessMember(member('bob-example', { kind: 'audience', email: 'b@example.com', groups: ['team-a'] }));
    await engine.insertAccessMember(member('carol-example', { kind: 'audience', email: 'c@example.com', groups: ['team-c'] }));
    await engine.insertAccessMember(member('dave-example', { groups: ['team-c'] }));
    await engine.setAccessMemberDisabled('bob-example', true);
    await engine.tombstoneAccessMember('carol-example');
  }
  const ids = (rows: Awaited<ReturnType<BrainEngine['readAccessMembers']>>) => rows.map(r => [r.id, r.groups]);

  parityTest('readAccessMembers by email names the declaring member, disabled or not, and exactly that email', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember', 'readAccessMembers'],
  }, async (engine) => {
    await seedMembers(engine);
    const out = {
      declared: ids(await engine.readAccessMembers({ email: 'z@example.com' })),
      disabled: ids(await engine.readAccessMembers({ email: 'b@example.com' })),
      removed: ids(await engine.readAccessMembers({ email: 'c@example.com' })),
      otherCase: ids(await engine.readAccessMembers({ email: 'Z@example.com' })),
      undeclared: ids(await engine.readAccessMembers({ email: 'nobody@example.com' })),
    };
    expect(out).toEqual({ declared: [['zed-example', ['team-a', 'team-b']]], disabled: [['bob-example', ['team-a']]], removed: [], otherCase: [], undeclared: [] });
    return out;
  });

  // The email index refuses a second declaring member through every typed write, so the fixture drops it for the
  // case (raw SQL; a Rust brain refuses it). The Rust store's every-match read is pinned in gbrain-store
  // access_members.rs `read_access_members_by_email_lists_every_member_that_declares_it`.
  parityTest('two members that share an email both read back, so memberByEmail refuses email_ambiguous', {
    methods: ['executeRaw', 'insertAccessMember', 'readAccessMembers'], requires: 'raw_sql',
  }, async (engine) => {
    await engine.executeRaw('DROP INDEX IF EXISTS access_members_email_key');
    try {
      await engine.insertAccessMember(member('bob-example', { email: 'shared@example.com' }));
      await engine.insertAccessMember(member('alice-example', { email: 'shared@example.com' }));
      await engine.insertAccessMember(member('carol-example', { email: 'other@example.com' }));
      const out = {
        rows: ids(await engine.readAccessMembers({ email: 'shared@example.com' })),
        byEmail: await memberByEmail(engine, 'shared@example.com').then(m => m.id, (e: { code?: string; reason?: string }) => ({ code: e.code, reason: e.reason })),
      };
      expect(out).toEqual({ rows: [['alice-example', []], ['bob-example', []]], byEmail: { code: 'access_member_invalid', reason: 'email_ambiguous' } });
      return out;
    } finally {
      await engine.executeRaw('DELETE FROM access_members');
      await engine.executeRaw('CREATE UNIQUE INDEX IF NOT EXISTS access_members_email_key ON access_members (email)');
    }
  });

  parityTest('listAudienceAccessMembers names the enabled, unremoved audience members, by id', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember', 'listAudienceAccessMembers'],
  }, async (engine) => {
    await seedMembers(engine);
    const out = await engine.listAudienceAccessMembers();
    expect(out).toEqual(['alice-example', 'zed-example']);
    return out;
  });

  parityTest('readLiveMember finds a live member by id, by the trimmed stdio config value, or through a token not revoked or a client not deleted bound to it, and nothing else', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember', 'setConfig', 'readLiveMember', 'insertAccessToken', 'insertOauthClient', 'revokeAccessToken', 'writeCredentialBinding'],
  }, async (engine) => {
    await seedMembers(engine);
    await engine.setConfig('mcp.stdio_member', ' zed-example ');
    await engine.setConfig('other.key', 'bob-example');
    const tokenFor = async (name: string, memberId: string | null, revoked = false) => {
      const { id } = await engine.insertAccessToken({ name, token_hash: `hash-${name}`, scopes: ['read'], permissions: {}, ...TOKEN_GRANT });
      if (memberId) await engine.transaction(tx => tx.writeCredentialBinding({ kind: 'token', id }, { member: memberId, mayActFor: null, attestActor: null, attestOps: null, attestSources: null, attestRead: null }));
      if (revoked) await engine.revokeAccessToken(id);
      return id;
    };
    const tokens = {
      live: await tokenFor('t-live', 'zed-example'), unbound: await tokenFor('t-unbound', null), disabled: await tokenFor('t-disabled', 'bob-example'),
      removed: await tokenFor('t-removed', 'carol-example'), revoked: await tokenFor('t-revoked', 'zed-example', true),
    };
    await engine.insertOauthClient({ client_id: 'client-live', client_name: 'client-live', member_id: 'zed-example' });
    await engine.insertOauthClient({ client_id: 'client-disabled', client_name: 'client-disabled', member_id: 'bob-example' });
    await engine.insertOauthClient({ client_id: 'client-deleted', client_name: 'client-deleted', member_id: 'zed-example', deleted_at: new Date('2026-01-01T00:00:00Z') });
    const out = {
      zed: await engine.readLiveMember('member', 'zed-example'),
      disabled: await engine.readLiveMember('member', 'bob-example'),
      removed: await engine.readLiveMember('member', 'carol-example'),
      group: await engine.readLiveMember('member', 'team-a'),
      stdioTrimmed: await engine.readLiveMember('stdio_config', 'mcp.stdio_member'),
      stdioDisabled: await engine.readLiveMember('stdio_config', 'other.key'),
      stdioUnset: await engine.readLiveMember('stdio_config', 'no.such.key'),
      token: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000c1'),
      client: await engine.readLiveMember('oauth_client', 'client-alice'),
      tokenLive: await engine.readLiveMember('legacy_token', tokens.live),
      tokenUnbound: await engine.readLiveMember('legacy_token', tokens.unbound),
      tokenDisabled: await engine.readLiveMember('legacy_token', tokens.disabled),
      tokenRemoved: await engine.readLiveMember('legacy_token', tokens.removed),
      tokenRevoked: await engine.readLiveMember('legacy_token', tokens.revoked),
      clientLive: await engine.readLiveMember('oauth_client', 'client-live'),
      clientDisabled: await engine.readLiveMember('oauth_client', 'client-disabled'),
      clientDeleted: await engine.readLiveMember('oauth_client', 'client-deleted'),
    };
    expect(out).toEqual({
      zed: { id: 'zed-example', groups: ['team-a', 'team-b'] }, disabled: null, removed: null, group: null,
      stdioTrimmed: { id: 'zed-example', groups: ['team-a', 'team-b'] }, stdioDisabled: null, stdioUnset: null, token: null, client: null,
      tokenLive: { id: 'zed-example', groups: ['team-a', 'team-b'] }, tokenUnbound: null, tokenDisabled: null, tokenRemoved: null, tokenRevoked: null,
      clientLive: { id: 'zed-example', groups: ['team-a', 'team-b'] }, clientDisabled: null, clientDeleted: null,
    });
    return out;
  });

  parityTest('readAccessGroups lists each group with its members, or the one group with exactly that id', {
    methods: ['insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember', 'addAccessGroupMembers', 'readAccessGroups'],
  }, async (engine) => {
    await seedMembers(engine);
    await engine.addAccessGroupMembers('team-empty', []);
    const out = {
      all: await engine.readAccessGroups(null),
      one: await engine.readAccessGroups('team-a'),
      empty: await engine.readAccessGroups('team-empty'),
      member: await engine.readAccessGroups('zed-example'),
      otherCase: await engine.readAccessGroups('Team-A'),
    };
    expect(out).toEqual({
      all: [
        { id: 'team-a', members: ['alice-example', 'bob-example', 'zed-example'] }, { id: 'team-b', members: ['zed-example'] },
        { id: 'team-c', members: ['dave-example'] }, { id: 'team-empty', members: [] },
      ],
      one: [{ id: 'team-a', members: ['alice-example', 'bob-example', 'zed-example'] }],
      empty: [{ id: 'team-empty', members: [] }], member: [], otherCase: [],
    });
    return out;
  });
});
