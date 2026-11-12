import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { accessLineageEntry } from '../src/commands/doctor/checks/access-lineage.ts';
import { runAccess, whoCanRead } from '../src/commands/access.ts';
import { addMember, getMember, setMemberKind } from '../src/core/access/members.ts';
import { setOwnerReadsRestricted } from '../src/core/access/owner.ts';
import { callerIdentityKey } from '../src/core/access/member-facts.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { authorizePageVisibility } from '../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { buildLineageBrain, derivedOf, factsOf, type LineageBrain, type Seen } from './helpers/access-lineage-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * GBRA-108 Design 2: audience members (access_members.kind = 'audience': a group chat, a shared assistant).
 * 1. Protects: the brain owner reads an audience member's own member page (memory/members/<id>), its older versions,
 *    its derived pages and its facts as if that page named the owner, with the owner opt-in off or on. Only that page:
 *    a page that merely lists the audience stays under the usual rules (the owner opt-in opens it), and a person
 *    member's member page stays closed to the owner. Only the operator on the brain host sets a kind; reads of every
 *    other caller, and every write, are identical whatever the kind.
 * 2. Fails when: the owner misses the audience member page or a derivative, fact or version of it; the owner reads it
 *    while the member is a person; the owner reads a person member's page, with or without the opt-in; any other
 *    caller's view changes with the kind; the publication gate lets the owner write the audience page; a remote caller
 *    sets a kind; the --as owner preview disagrees; or the cache keys do not change with the audience list.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true); the access CLI; a folder rule in the database (repo-less) and in a committed access.yml
 *    (git); PGLite, and Postgres with DATABASE_URL; embeddings stubbed.
 */

const OWNER = 'owner-example';
const GC = 'groupchat-example';
const ORIGINS = {
  gc: { slug: 'memory/members/' + GC, fm: ['readable_by: [' + GC + ']'], derive: true },
  gcnote: { slug: 'notes/gc-note', fm: ['readable_by: [' + GC + ']'], derive: false },
  dm: { slug: 'memory/members/alice-example', fm: ['readable_by: [alice-example]'], derive: true },
  open: { slug: 'notes/open-example', fm: [] as string[], derive: false },
};
const OTHERS = ['alice', 'gc', 'unbound', 'granted'] as const;

describe('audience member kind: who may set it', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a remote caller cannot set or add an audience kind; ids and kinds are validated', async () => {
    await addMember(engine, GC);
    expect((await getMember(engine, GC))?.kind).toBe('person');
    await expect(setMemberKind(engine, GC, 'audience', { remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(setMemberKind(engine, GC, 'audience', {})).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(addMember(engine, 'chat-two-example', { kind: 'audience', remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await getMember(engine, 'chat-two-example')).toBeNull();
    await expect(setMemberKind(engine, GC, 'robot', { remote: false })).rejects.toThrow();
    await expect(setMemberKind(engine, 'Not An Id', 'audience', { remote: false })).rejects.toThrow();
    expect((await getMember(engine, GC))?.kind).toBe('person');
    expect((await setMemberKind(engine, GC, 'audience', { remote: false })).changed).toBe(true);
    expect((await addMember(engine, 'chat-two-example', { kind: 'audience', remote: false })).member.kind).toBe('audience');
  }, 120_000);

  test('the semantic cache and the caller key change with the owner\'s audience members', () => {
    const knobs = resolveSearchMode({ mode: 'balanced' });
    const base = { identity: ['member:' + OWNER], owner: true, lineage: true, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] as string[] };
    const keys = (audienceKindMembers: string[]) => withCallerAccess({ ...base, audienceKindMembers }, () => [knobsHash(knobs, { excludePrivate: true }), callerIdentityKey()]);
    const none = keys([]);
    const one = keys([GC]);
    const two = keys([GC, 'chat-two-example']);
    for (const i of [0, 1]) expect(new Set([none[i], one[i], two[i]]).size).toBe(3);
  });
});

for (const kind of testBackends()) {
  for (const store of ['database', 'git'] as const) {
    describe(`audience members (${kind}, rules in ${store === 'git' ? 'access.yml' : 'the database, repo-less'})`, () => {
      let b: LineageBrain;
      const SRC = 'aud-src';
      async function cli(args: string[]): Promise<any> {
        const lines: string[] = [];
        const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
        try { await runAccess(b.engine, [...args, '--json']); } finally { spy.mockRestore(); }
        return JSON.parse(lines.join('\n'));
      }
      const withOptIn = async <T>(fn: () => Promise<T>): Promise<T> => {
        await setOwnerReadsRestricted(b.engine, true, { remote: false });
        __resetPrivateVisibilityCacheForTests();
        try { return await fn(); } finally { await setOwnerReadsRestricted(b.engine, false, { remote: false }); __resetPrivateVisibilityCacheForTests(); }
      };
      const doctor = async () => Object.fromEntries((await accessLineageEntry.run({ engine: b.engine } as unknown as DoctorContext) as Array<{ name: string; status: string; message: string }>).map(c => [c.name, c]));
      const writable = async () => {
        const authority = { version: 1, principal: { kind: 'legacy_token', id: b.tokenIds.owner }, remote: true, excludePrivate: true, sourceId: SRC,
          sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null, slugPrefixes: null } as WriteAuthority;
        const out: string[] = [];
        for (const [o, s] of Object.entries(ORIGINS)) if (await authorizePageVisibility(b.engine, authority, s.slug).then(() => true, () => false)) out.push(o);
        return out;
      };
      const person: Record<string, Seen> = {};

      beforeAll(async () => {
        b = await buildLineageBrain({
          kind, store, src: SRC, tag: 'aud', origins: ORIGINS,
          rules: [{ id: 'vault', prefix: 'vault/', readable_by: ['member:alice-example'] }],
          members: [OWNER, 'alice-example', GC], owner: OWNER,
          callers: [{ name: 'owner', member: OWNER }, { name: 'as-owner', as: OWNER }, { name: 'alice', member: 'alice-example' }, { name: 'gc', member: GC },
            { name: 'unbound' }, { name: 'granted', grantedSources: true }],
        });
      }, 300_000);
      afterAll(async () => { await b?.close(); }, 60_000);

      test('while the member is a person, the owner reads no member page but its own, opt-in off or on', async () => {
        expect(await b.seenBy('owner')).toEqual(b.expected(['open'], []));
        expect(await withOptIn(() => b.seenBy('owner'))).toEqual(b.expected(['gcnote', 'open'], []));
        expect(await b.seenBy('as-owner')).toEqual(await b.seenBy('owner'));
        for (const who of OTHERS) person[who] = await b.seenBy(who);
        // The audience reads its own pages, and the facts recorded on its own member page (v0.60.682.0 behaviour).
        expect(person.gc.get_page).toEqual(['gc', 'gcnote', 'open']);
        expect(person.gc['recall since']).toEqual(['gc.fact']);
        expect(person.alice).toEqual(b.expected(['dm', 'open'], ['dm.fact']));
        expect(person.unbound).toEqual(b.expected(['open'], []));
        expect(person.granted).toEqual(person.unbound);
        expect((await whoCanRead(b.engine, ORIGINS.gc.slug, SRC))[0]?.members).toEqual([GC]);
        expect((await doctor()).access_audience_members.message).toStartWith('Not applicable');
      }, 600_000);

      test('as an audience, the owner reads its member page, versions, derived pages and facts with the opt-in off', async () => {
        const set = await cli(['access', 'member', 'kind', GC, 'audience'].slice(1));
        expect(set).toMatchObject({ changed: true, member: { id: GC, kind: 'audience' } });
        __resetPrivateVisibilityCacheForTests();
        const audience = b.expected(['gc', ...derivedOf(b.keys, ['gc']), 'open'], factsOf(b.keys, ['gc']));
        expect(await b.seenBy('owner')).toEqual(audience);
        expect(await b.seenBy('as-owner')).toEqual(audience);
        const listed = await cli(['member', 'list']);
        expect(listed.members.find((m: { id: string }) => m.id === GC)?.kind).toBe('audience');
        const who = (await whoCanRead(b.engine, ORIGINS.gc.slug, SRC))[0]!;
        expect(who.members).toEqual([GC, OWNER]);
        expect(who.note).toContain('member page of an audience member');
        const checks = await doctor();
        expect(checks.access_audience_members.message).toContain(GC);
      }, 600_000);

      test('with the opt-in on, the owner also reads pages that list the audience, and never a person member\'s page', async () => {
        expect(await withOptIn(() => b.seenBy('owner'))).toEqual(b.expected(['gc', ...derivedOf(b.keys, ['gc']), 'gcnote', 'open'], factsOf(b.keys, ['gc'])));
        expect(await withOptIn(() => b.seenBy('as-owner'))).toEqual(await withOptIn(() => b.seenBy('owner')));
      }, 600_000);

      test('every other caller reads exactly the same whatever the kind, and no write widens', async () => {
        for (const who of OTHERS) expect({ who, seen: await b.seenBy(who) }).toEqual({ who, seen: person[who]! });
        expect(await writable()).toEqual(['open']);
        await setMemberKind(b.engine, GC, 'person', { remote: false });
        expect(await writable()).toEqual(['open']);
        __resetPrivateVisibilityCacheForTests();
        expect(await b.seenBy('owner')).toEqual(b.expected(['open'], []));
      }, 600_000);
    });
  }
}
