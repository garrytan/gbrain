/**
 * BrainEngine parity — the access member reads: listActiveAccessMembers, readAccessMembers, listAudienceAccessMembers,
 * readAudiencePrincipals and readLiveMember (engine-sql/access-control.ts), and the page read a member-scoped caller
 * makes with the identity they give.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) a brain with members answers the same: the active list holds the members neither
 *    disabled nor removed; readAccessMembers finds a member by id (any status), by exact email, or lists the live
 *    members (removed ones only when asked), each with its own groups; the audience list holds only the enabled
 *    audience members; readAudiencePrincipals names enabled members and existing groups only; readLiveMember names an
 *    enabled member by id or by the config key, and none for a disabled, a removed or an unknown one. A caller bound to an
 *    enabled member reads the page only that member's readers name; a world-only caller, a disabled member and a
 *    removed member do not.
 *  - Regression: the Rust engine answered every one of these reads from no members (an empty list, a null member), so
 *    a Rust brain with members listed none, resolved every caller to the world-only identity, and a member-scoped
 *    caller lost the pages made for them.
 *  - Why existing coverage misses it: write-misc.test.ts reads a brain with no members on the Rust arm (its member
 *    writes stop on the raw SQL refusal), and core-page-member-reads.test.ts hands the identity to the read, so the
 *    member read never runs.
 *  - Seam: the members are seeded by `createMember` (harness.ts): harness-only SQL on the SQL arms, the store's member
 *    records on the Rust arm. Everything the cases read is a typed method.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createMember, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { memberIdentityFor, stdioMemberIdentity } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

async function seedMembers(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createMember(engine, backend, { id: 'alice-example', email: 'alice@example.com', groups: ['team-a', 'team-b'] });
  await createMember(engine, backend, { id: 'bob-example', kind: 'audience', groups: ['team-a'] });
  await createMember(engine, backend, { id: 'carl-example', kind: 'audience', state: 'disabled' });
  await createMember(engine, backend, { id: 'dave-example', email: 'dave@example.com', groups: ['team-c'], state: 'disabled' });
  await createMember(engine, backend, { id: 'rex-example', state: 'removed' });
}

/** A member row without its times: whether each is set, not when. */
const shape = (rows: Awaited<ReturnType<BrainEngine['readAccessMembers']>>) => rows.map(r => ({
  id: r.id, email: r.email, kind: r.kind, disabled: r.disabled_at != null, removed: r.tombstoned_at != null, created: r.created_at != null, groups: r.groups,
}));

describe('engine parity: access member reads', () => {
  parityTest('the member lists and the audience read name only enabled members, and each read matches on every engine', {
    methods: ['listActiveAccessMembers', 'readAccessMembers', 'listAudienceAccessMembers', 'readAudiencePrincipals'],
  }, async (engine, backend) => {
    const none = {
      active: await engine.listActiveAccessMembers(),
      audience: await engine.listAudienceAccessMembers(),
      members: await engine.readAccessMembers({ includeRemoved: true }),
      principals: await engine.readAudiencePrincipals(['alice-example'], ['team-a']),
    };
    expect(none).toEqual({ active: [], audience: [], members: [], principals: { members: [], groups: [] } });
    await seedMembers(engine, backend);
    const out = {
      active: await engine.listActiveAccessMembers(),
      audience: await engine.listAudienceAccessMembers(),
      live: shape(await engine.readAccessMembers({ includeRemoved: false })),
      all: shape(await engine.readAccessMembers({ includeRemoved: true })),
      byId: shape(await engine.readAccessMembers({ id: 'alice-example' })),
      byDisabledId: shape(await engine.readAccessMembers({ id: 'dave-example' })),
      byRemovedId: shape(await engine.readAccessMembers({ id: 'rex-example' })),
      byGroupId: shape(await engine.readAccessMembers({ id: 'team-a' })),
      byOtherCase: shape(await engine.readAccessMembers({ id: 'Alice-Example' })),
      byEmail: shape(await engine.readAccessMembers({ email: 'alice@example.com' })).map(r => r.id),
      byDisabledEmail: shape(await engine.readAccessMembers({ email: 'dave@example.com' })).map(r => r.id),
      byOtherCaseEmail: shape(await engine.readAccessMembers({ email: 'Alice@example.com' })),
      byUnknownEmail: await engine.readAccessMembers({ email: 'nobody@example.com' }),
    };
    expect(out.active).toEqual(['alice-example', 'bob-example']);
    expect(out.audience).toEqual(['bob-example']);
    expect(out.live.map(r => [r.id, r.disabled, r.groups])).toEqual([
      ['alice-example', false, ['team-a', 'team-b']], ['bob-example', false, ['team-a']], ['carl-example', true, []], ['dave-example', true, ['team-c']],
    ]);
    expect(out.all.map(r => [r.id, r.removed])).toEqual([['alice-example', false], ['bob-example', false], ['carl-example', false], ['dave-example', false], ['rex-example', true]]);
    expect(out.byId).toEqual([{ id: 'alice-example', email: 'alice@example.com', kind: 'person', disabled: false, removed: false, created: true, groups: ['team-a', 'team-b'] }]);
    expect(out.byDisabledId.map(r => [r.id, r.disabled])).toEqual([['dave-example', true]]);
    expect(out.byRemovedId.map(r => [r.id, r.removed, r.email, r.groups])).toEqual([['rex-example', true, null, []]]);
    expect([out.byGroupId, out.byOtherCase, out.byOtherCaseEmail, out.byUnknownEmail]).toEqual([[], [], [], []]);
    expect([out.byEmail, out.byDisabledEmail]).toEqual([['alice-example'], ['dave-example']]);
    // An audience names an enabled member and an existing group only; a member id is not a group and a group id is not a member.
    const principals = await engine.readAudiencePrincipals(
      ['alice-example', 'bob-example', 'carl-example', 'dave-example', 'rex-example', 'nobody-example', 'team-a'],
      ['team-a', 'team-c', 'alice-example', 'team-z', 'team-a'],
    );
    const audience = { members: [...principals.members].sort((a, b) => a.id.localeCompare(b.id)), groups: [...principals.groups].sort() };
    expect(audience).toEqual({ members: [{ id: 'alice-example', groups: ['team-a', 'team-b'] }, { id: 'bob-example', groups: ['team-a'] }], groups: ['team-a', 'team-c'] });
    const empty = { members: await engine.readAudiencePrincipals([], ['team-a']), groups: await engine.readAudiencePrincipals(['alice-example'], []) };
    expect(empty).toEqual({ members: { members: [], groups: ['team-a'] }, groups: { members: [{ id: 'alice-example', groups: ['team-a', 'team-b'] }], groups: [] } });
    return { out, audience, empty };
  });

  parityTest('readLiveMember names an enabled member by id or by the config key, and no disabled, removed or unknown one', {
    methods: ['readLiveMember', 'setConfig'],
  }, async (engine, backend) => {
    await seedMembers(engine, backend);
    const byId = {
      alice: await engine.readLiveMember('member', 'alice-example'),
      bob: await engine.readLiveMember('member', 'bob-example'),
      disabled: await engine.readLiveMember('member', 'dave-example'),
      removed: await engine.readLiveMember('member', 'rex-example'),
      unknown: await engine.readLiveMember('member', 'nobody-example'),
      group: await engine.readLiveMember('member', 'team-a'),
      otherCase: await engine.readLiveMember('member', 'Alice-Example'),
    };
    expect(byId).toEqual({
      alice: { id: 'alice-example', groups: ['team-a', 'team-b'] }, bob: { id: 'bob-example', groups: ['team-a'] },
      disabled: null, removed: null, unknown: null, group: null, otherCase: null,
    });
    const byConfig: Record<string, unknown> = { unset: await engine.readLiveMember('stdio_config', 'mcp.stdio_member') };
    for (const [name, value] of [['alice', ' alice-example '], ['disabled', 'dave-example'], ['removed', 'rex-example'], ['unknown', 'nobody-example']] as const) {
      await engine.setConfig('mcp.stdio_member', value);
      byConfig[name] = await engine.readLiveMember('stdio_config', 'mcp.stdio_member');
    }
    expect(byConfig).toEqual({ unset: null, alice: { id: 'alice-example', groups: ['team-a', 'team-b'] }, disabled: null, removed: null, unknown: null });
    // No token or OAuth client is bound to a member here, so neither names one.
    const credential = { token: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-0000000000a1'), client: await engine.readLiveMember('oauth_client', 'client-alice') };
    expect(credential).toEqual({ token: null, client: null });
    return { byId, byConfig, credential };
  });

  // The private row: a page only a member's readers name. The identity a caller gets comes from the member read, so a
  // member-scoped caller reads it and a world-only caller, a disabled member and a removed member do not.
  parityTest('a member-scoped caller reads the page only their member names, and a world-only, a disabled or a removed caller does not', {
    methods: ['putPage', 'listCorePageRows', 'readLiveMember', 'setConfig'],
  }, async (engine, backend) => {
    await seedMembers(engine, backend);
    const page = (frontmatter: Record<string, unknown>) => ({ type: 'note' as const, title: 'Core', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });
    await engine.putPage('core/open', page({}));
    await engine.putPage('core/for-alice', page({ readable_by: ['alice-example'] }));
    await engine.putPage('core/for-team-a', page({ readable_by: ['group:team-a'] }));
    const read = async (identity: string[]) =>
      (await withCallerAccess({ identity, hidePrivate: true }, () => engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 }))).map(r => r.slug).sort();
    const asMember = async (id: string) => {
      const viaId = await memberIdentityFor(engine, { principal: { kind: 'local_stdio', id: 'stdio' }, stdioMember: id });
      await engine.setConfig('mcp.stdio_member', id);
      const viaConfig = await stdioMemberIdentity(engine);
      expect(viaConfig).toEqual(viaId);
      return viaId;
    };
    const identities = {
      world: [] as string[], alice: await asMember('alice-example'), bob: await asMember('bob-example'),
      disabled: await asMember('dave-example'), removed: await asMember('rex-example'), unknown: await asMember('nobody-example'),
    };
    expect(identities).toEqual({
      world: [], alice: ['group:team-a', 'group:team-b', 'member:alice-example'], bob: ['group:team-a', 'member:bob-example'], disabled: [], removed: [], unknown: [],
    });
    const out: Record<string, string[]> = {};
    for (const [name, identity] of Object.entries(identities)) out[name] = await read(identity);
    expect(out).toEqual({
      world: ['core/open'],
      alice: ['core/for-alice', 'core/for-team-a', 'core/open'],
      bob: ['core/for-team-a', 'core/open'],
      disabled: ['core/open'], removed: ['core/open'], unknown: ['core/open'],
    });
    return { identities, out };
  });
});
