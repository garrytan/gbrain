import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { accessLineageEntry } from '../src/commands/doctor/checks/access-lineage.ts';
import { accessCheck, runAccess, whoCanRead } from '../src/commands/access.ts';
import { membersReadLineageOn, setMembersReadLineage } from '../src/core/access/lineage.ts';
import { setOwnerReadsRestricted } from '../src/core/access/owner.ts';
import { callerIdentityKey } from '../src/core/access/member-facts.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { __resetPrivateVisibilityCacheForTests, currentCallerAccess, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { authorizePageVisibility } from '../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { buildLineageBrain, derivedOf, factsOf, type LineageBrain, type Seen } from './helpers/access-lineage-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { ENFORCED_MEMBER_ENV, enforcedRead, namesHiddenPage } from '../src/cli/enforced-member.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * GBRA-108 Design 3: config access.members_read_lineage (off by default; set only by the operator on the brain host).
 * 1. Protects: with it on, a member's credential speaking for itself (no audience, or an audience of exactly that one
 *    member) reads the atoms, derived_from pages, synthesized concepts, Life Chronicle events and facts whose origins it
 *    reads, on every read path, as the owner already does; a member-bound granted_sources credential reads exactly
 *    what its member reads. Off, nothing changes. An unbound credential (an unbound granted_sources one included), an
 *    audience of several members, and the owner (whose own lineage and opt-in are separate) read exactly the same off
 *    and on, and no write widens. The enforced member CLI's output guard agrees with the read.
 * 2. Fails when: a member misses a derivative or fact of an origin it reads, or reads one of an origin it does not; any
 *    non-target caller's view changes; the --as preview disagrees with the key; whoami, access check, who-can-read or
 *    doctor do not report the setting; a remote caller turns it on; or the cache keys do not change with it.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true), with and without an on-behalf-of audience; the access CLI; a folder rule in the database
 *    (repo-less) and in a committed access.yml (git); PGLite, and Postgres with DATABASE_URL; embeddings stubbed.
 */

const OWNER = 'owner-example';
const ORIGINS = {
  al: { slug: 'notes/al-example', fm: ['readable_by: [alice-example]'], derive: true },
  team: { slug: 'team/origin-example', fm: [] as string[], derive: true },
  both: { slug: 'notes/both-example', fm: ['readable_by: [alice-example, bob-example]'], derive: true },
  open: { slug: 'notes/open-example', fm: [] as string[], derive: false },
};
const UNCHANGED = ['owner', 'carol', 'pair', 'unbound', 'granted'] as const;

describe('members read lineage: who may set it, and the cache keys', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a remote caller cannot turn it on', async () => {
    expect(await membersReadLineageOn(engine)).toBe(false);
    await expect(setMembersReadLineage(engine, true, { remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(setMembersReadLineage(engine, true, {})).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await membersReadLineageOn(engine)).toBe(false);
    expect(await setMembersReadLineage(engine, true, { remote: false })).toMatchObject({ members_read_lineage: true });
    expect(await membersReadLineageOn(engine)).toBe(true);
  }, 120_000);

  test('the semantic cache and the caller key differ for a member read with lineage', () => {
    const knobs = resolveSearchMode({ mode: 'balanced' });
    const base = { identity: ['member:alice-example'], applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] as string[] };
    const keys = (lineage: boolean, owner = false) => withCallerAccess({ ...base, lineage, owner }, () => [knobsHash(knobs, { excludePrivate: true }), callerIdentityKey()]);
    const [off, on, ownerOn] = [keys(false), keys(true), keys(true, true)];
    for (const i of [0, 1]) expect(new Set([off[i], on[i], ownerOn[i]]).size).toBe(3);
    const pair = withCallerAccess({ identity: [], audience: ['member:alice-example', 'member:bob-example'], audienceIdentities: [['member:alice-example'], ['member:bob-example']], lineage: true },
      () => currentLineage());
    expect(pair).toBe(false);
  });
});

function currentLineage(): boolean {
  return currentCallerAccess().lineage;
}

for (const kind of testBackends()) {
  for (const store of ['database', 'git'] as const) {
    describe(`members read lineage (${kind}, rules in ${store === 'git' ? 'access.yml' : 'the database, repo-less'})`, () => {
      let b: LineageBrain;
      const SRC = 'mrl-src';
      const off: Record<string, Seen> = {};
      async function cli(args: string[]): Promise<any> {
        const lines: string[] = [];
        const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
        try { await runAccess(b.engine, [...args, '--json']); } finally { spy.mockRestore(); }
        return JSON.parse(lines.join('\n'));
      }
      const doctor = async () => Object.fromEntries((await accessLineageEntry.run({ engine: b.engine } as unknown as DoctorContext) as Array<{ name: string; status: string; message: string }>).map(c => [c.name, c]));
      const whoami = async (who: string) => JSON.parse(await b.call(who, 'whoami', {}));
      const writable = async (who: string) => {
        const authority = { version: 1, principal: { kind: 'legacy_token', id: b.tokenIds[who] }, remote: true, excludePrivate: true, sourceId: SRC,
          sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null, slugPrefixes: null } as WriteAuthority;
        const out: string[] = [];
        for (const [o, s] of Object.entries(ORIGINS)) if (await authorizePageVisibility(b.engine, authority, s.slug).then(() => true, () => false)) out.push(o);
        return out;
      };
      const ALL = ['alice', 'bob', 'solo', 'as-alice', ...UNCHANGED];

      beforeAll(async () => {
        b = await buildLineageBrain({
          kind, store, src: SRC, tag: 'mrl', origins: ORIGINS,
          rules: [{ id: 'team', prefix: 'team/', readable_by: ['group:team-a'] }],
          members: [OWNER, 'alice-example', 'bob-example', 'carol-example'], groups: { 'team-a': ['bob-example'] }, owner: OWNER,
          callers: [{ name: 'owner', member: OWNER }, { name: 'alice', member: 'alice-example' }, { name: 'bob', member: 'bob-example' }, { name: 'carol', member: 'carol-example' },
            { name: 'as-alice', as: 'alice-example' },
            { name: 'solo', mayActFor: ['member:alice-example', 'member:bob-example'], audience: ['alice-example'] },
            { name: 'pair', mayActFor: ['member:alice-example', 'member:bob-example'], audience: ['alice-example', 'bob-example'] },
            { name: 'unbound' }, { name: 'granted', grantedSources: true }, { name: 'alice-granted', member: 'alice-example', grantedSources: true }],
        });
      }, 300_000);
      afterAll(async () => { await b?.close(); }, 60_000);

      test('off (the default): no member but the owner reads a derived page or fact of a page kept to readers', async () => {
        for (const who of ALL) off[who] = await b.seenBy(who);
        expect(off.alice).toEqual(b.expected(['al', 'both', 'open'], []));
        expect(off.bob).toEqual(b.expected(['team', 'both', 'open'], []));
        expect(off.solo).toEqual(off.alice);
        expect(off['as-alice']).toEqual(off.alice);
        expect(await b.seenBy('alice-granted')).toEqual(off.alice);
        expect(off.pair).toEqual(b.expected(['both', 'open'], []));
        for (const who of ['owner', 'carol', 'unbound', 'granted']) expect({ who, seen: off[who] }).toEqual({ who, seen: b.expected(['open'], []) });
        expect((await whoami('alice')).access.members_read_lineage).toBeUndefined();
        expect((await doctor()).access_members_read_lineage.message).toStartWith('Not applicable');
        expect((await accessCheck(b.engine, { token: 'alice' })).members_read_lineage).toBe(false);
      }, 600_000);

      test('on: a member speaking for itself reads the derived pages and facts of every origin it reads, on every path', async () => {
        expect(await cli(['members-read-lineage', 'on'])).toMatchObject({ members_read_lineage: true });
        __resetPrivateVisibilityCacheForTests();
        const alice = b.expected(['al', 'both', 'open', ...derivedOf(b.keys, ['al', 'both'])], factsOf(b.keys, ['al', 'both']));
        expect(await b.seenBy('alice')).toEqual(alice);
        expect(await b.seenBy('solo')).toEqual(alice);
        expect(await b.seenBy('as-alice')).toEqual(alice);
        expect(await b.seenBy('alice-granted')).toEqual(alice);
        expect(await b.seenBy('bob')).toEqual(b.expected(['team', 'both', 'open', ...derivedOf(b.keys, ['team', 'both'])], factsOf(b.keys, ['team', 'both'])));
      }, 600_000);

      test('on: the owner, another member, an audience of several, and unbound credentials (granted_sources included) read the same', async () => {
        for (const who of UNCHANGED) expect({ who, seen: await b.seenBy(who) }).toEqual({ who, seen: off[who]! });
      }, 600_000);

      test('on: whoami, access check, who-can-read and doctor report it; no write widens', async () => {
        const me = await whoami('alice');
        expect(me.access.members_read_lineage).toBe(true);
        expect(me.access.members_read_lineage_note).toContain('reaches every member that page lists');
        const check = await accessCheck(b.engine, { token: 'alice' });
        expect(check.members_read_lineage).toBe(true);
        expect(check.explanation).toContain('access.members_read_lineage is on');
        expect((await whoCanRead(b.engine, ORIGINS.al.slug, SRC))[0]!.note).toContain('access.members_read_lineage is on');
        expect((await doctor()).access_members_read_lineage.status).toBe('ok');
        expect((await doctor()).access_members_read_lineage.message).toContain('summaries of a page reach everyone that page lists');
        for (const who of ['alice', 'bob', 'carol', 'unbound']) {
          await setMembersReadLineage(b.engine, false, { remote: false });
          const before = await writable(who);
          await setMembersReadLineage(b.engine, true, { remote: false });
          expect({ who, w: await writable(who) }).toEqual({ who, w: before });
        }
      }, 600_000);

      test('on: the enforced member CLI output guard withholds no derived page the member reads, and still one it does not', async () => {
        await withEnv({ [ENFORCED_MEMBER_ENV]: 'alice-example' }, async () => {
          const atom = b.pageSlug('al.atom')!;
          expect(JSON.stringify(await enforcedRead(b.engine, 'get', 'get_page', { slug: atom }, { sourceId: SRC }))).toContain(b.canary('al.atom'));
          expect(await namesHiddenPage(b.engine, 'get', { slug: atom })).toBe(false);
          expect(await namesHiddenPage(b.engine, 'get', { slug: b.pageSlug('team.atom')! })).toBe(true);
          await setMembersReadLineage(b.engine, false, { remote: false });
          __resetPrivateVisibilityCacheForTests();
          try {
            expect(await namesHiddenPage(b.engine, 'get', { slug: atom })).toBe(true);
          } finally {
            await setMembersReadLineage(b.engine, true, { remote: false });
            __resetPrivateVisibilityCacheForTests();
          }
        });
      }, 600_000);

      test('the owner opt-in stays the owner\'s: it changes nothing for a member reading with lineage', async () => {
        await setOwnerReadsRestricted(b.engine, true, { remote: false });
        __resetPrivateVisibilityCacheForTests();
        try {
          expect(await b.seenBy('alice')).toEqual(b.expected(['al', 'both', 'open', ...derivedOf(b.keys, ['al', 'both'])], factsOf(b.keys, ['al', 'both'])));
        } finally {
          await setOwnerReadsRestricted(b.engine, false, { remote: false });
        }
        expect(await cli(['members-read-lineage', 'off'])).toMatchObject({ members_read_lineage: false });
        __resetPrivateVisibilityCacheForTests();
        for (const who of ['alice', 'bob', 'solo']) expect({ who, seen: await b.seenBy(who) }).toEqual({ who, seen: off[who]! });
        expect(await b.seenBy('alice-granted')).toEqual(off.alice);
      }, 600_000);
    });
  }
}
