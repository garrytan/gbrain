import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { accessLabelledOnlyEntry } from '../src/commands/doctor/checks/access-labelled-only.ts';
import { accessCheck, runAccess, whoCanRead } from '../src/commands/access.ts';
import { setMembersReadLineage } from '../src/core/access/lineage.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { callerIdentityKey } from '../src/core/access/member-facts.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { authorizePageVisibility } from '../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { ENFORCED_MEMBER_ENV, enforcedRead, memberPageView, type EnforcedAccess } from '../src/cli/enforced-member.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildLineageBrain, derivedOf, factsOf, HUB, type LineageBrain, type Seen } from './helpers/access-lineage-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * GBRA-108 design 1: the labelled-only grant (access_members.labelled_only, the labelled-only migration; off by default, set only by the operator
 * on the brain host with gbrain access member labelled-only <id> on|off).
 * 1. Protects: every credential bound to a labelled-only member reads only pages that name it (its id or one of its
 *    groups in readable_by, or a folder rule listing them), on every read path: MCP over HTTP tokens, the --as preview
 *    and the enforced member CLI's whole read surface. Unlabelled pages its source grant opens are hidden, and so is
 *    every derived page and fact with no readers or rule of its own (fail closed), except under
 *    access.members_read_lineage where every origin names the caller. An update to a page it cannot read and a create
 *    that would not name it are refused. With no grant set anywhere, nothing changes, and every other caller reads the
 *    same with the grant on.
 * 2. Fails when: a labelled-only caller reads an unlabelled page, a derived page or fact that names nobody (off), or a
 *    derivative with one unlabelled or unreadable origin (on); misses a labelled page; another caller's view changes;
 *    the owner can hold the grant; a remote caller sets it; check, who-can-read or doctor do not report it; or the
 *    semantic cache and caller key do not separate it.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true); the enforced member CLI's enforcedRead; the access CLI; folder rules in the database
 *    (repo-less) and in a committed access.yml (git); PGLite, and Postgres with DATABASE_URL; embeddings stubbed.
 */

const OWNER = 'owner-example';
const BOT = 'group-bot-example';
const ORIGINS = {
  lab: { slug: 'notes/lab-example', fm: ['readable_by: [group:team-a]'], derive: true },
  rule: { slug: 'team/rule-example', fm: [] as string[], derive: true },
  open: { slug: 'notes/open-example', fm: [] as string[], derive: true },
  other: { slug: 'notes/other-example', fm: ['readable_by: [alice-example]'], derive: true },
};
const MIXED = 'notes/mixed-derived';
const LHUB = 'team/hub-labelled';
const MIXED_CANARY = 'canarylomixedx';
const RELAB = 'notes/relabelled-example';
const RELAB_V1 = 'canarylorelabonex';
const RELAB_V2 = 'canarylorelabtwox';
const OTHERS = ['owner', 'bob', 'alice', 'unbound'] as const;

describe('labelled-only grant: the cache keys', () => {
  test('the semantic cache and the caller identity key separate a labelled-only caller from an ordinary one', () => {
    const knobs = resolveSearchMode({ mode: 'balanced' });
    const base = { identity: ['member:' + BOT, 'group:team-a'], applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] as string[] };
    const keys = (labelledOnly: boolean, lineage = false) => withCallerAccess({ ...base, labelledOnly, lineage }, () => [knobsHash(knobs, { excludePrivate: true }), callerIdentityKey()]);
    const [plain, labelled, plainLineage, labelledLineage] = [keys(false), keys(true), keys(false, true), keys(true, true)];
    for (const i of [0, 1]) expect(new Set([plain[i], labelled[i], plainLineage[i], labelledLineage[i]]).size).toBe(4);
    expect(withCallerAccess({ ...base }, () => [knobsHash(knobs, { excludePrivate: true }), callerIdentityKey()])).toEqual(plain);
  });
});

describe('labelled-only grant: who may set it', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    for (const id of [OWNER, BOT]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    await setOwner(engine, OWNER);
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a remote caller cannot set or clear it, and no operation reaches it', async () => {
    await expect(setMemberLabelledOnly(engine, BOT, true, { remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(setMemberLabelledOnly(engine, BOT, true, {})).rejects.toMatchObject({ code: 'permission_denied' });
    const [row] = await engine.executeRaw<{ labelled_only: boolean }>('SELECT labelled_only FROM access_members WHERE id = $1', [BOT]);
    expect(row!.labelled_only).toBe(false);
    const { OPERATION_MANIFEST } = await import('../src/cli/op-manifest.ts');
    expect(OPERATION_MANIFEST.filter(o => /labelled/.test(o.name))).toEqual([]);
    expect(await setMemberLabelledOnly(engine, BOT, true, { remote: false })).toMatchObject({ changed: true, member: { labelled_only: true } });
    expect(await setMemberLabelledOnly(engine, BOT, false, { remote: false })).toMatchObject({ changed: true, member: { labelled_only: false } });
  });

  test('never on the owner: setting it there, or naming a labelled-only member the owner, refuses with exit 3 and asks the user', async () => {
    const refused = await setMemberLabelledOnly(engine, OWNER, true, { remote: false }).catch(e => e);
    expect(refused).toMatchObject({ code: 'access_labelled_only_owner', fix: { ask_user: true, actor: 'user' } });
    expect(String(refused.message)).toContain('is the brain owner');
    expect(exitCodeForCode(refused.code)).toBe(3);
    const [row] = await engine.executeRaw<{ labelled_only: boolean }>('SELECT labelled_only FROM access_members WHERE id = $1', [OWNER]);
    expect(row!.labelled_only).toBe(false);
    await setMemberLabelledOnly(engine, BOT, true, { remote: false });
    const owner = await setOwner(engine, BOT).catch(e => e);
    expect(owner).toMatchObject({ code: 'access_labelled_only_owner', fix: { ask_user: true, argv: ['gbrain', 'access', 'member', 'labelled-only', BOT, 'off'] } });
    expect(await engine.getConfig('access.owner_member')).toBe(OWNER);
    await setMemberLabelledOnly(engine, BOT, false, { remote: false });
  });
});

for (const kind of testBackends()) {
  for (const store of ['database', 'git'] as const) {
    describe('labelled-only grant (' + kind + ', rules in ' + (store === 'git' ? 'access.yml' : 'the database, repo-less') + ')', () => {
      let b: LineageBrain;
      const SRC = 'lo-src';
      const before: Record<string, Seen> = {};
      const writeToken = { token: '', id: '' };
      async function cli(args: string[]): Promise<any> {
        const lines: string[] = [];
        const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
        try { await runAccess(b.engine, [...args, '--json']); } finally { spy.mockRestore(); }
        return JSON.parse(lines.join('\n'));
      }
      const grant = async (on: boolean) => { await cli(['member', 'labelled-only', BOT, on ? 'on' : 'off']); __resetPrivateVisibilityCacheForTests(); };
      const lineage = async (on: boolean) => { await setMembersReadLineage(b.engine, on, { remote: false }); __resetPrivateVisibilityCacheForTests(); };
      const doctor = async () => (await accessLabelledOnlyEntry.run({ engine: b.engine } as unknown as DoctorContext) as Array<{ name: string; status: string; message: string }>)[0]!;
      const authority = (): WriteAuthority => ({ version: 1, principal: { kind: 'legacy_token', id: writeToken.id }, remote: true, excludePrivate: true, sourceId: SRC,
        sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null, slugPrefixes: null } as WriteAuthority);
      async function put(slug: string, fm: string[]): Promise<{ isError: boolean; json: Record<string, any> }> {
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(b.engine), transaction: fn => b.engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
        const auth = await provider.verifyAccessToken(writeToken.token) as unknown as AuthInfo;
        const content = ['---', 'type: note', 'title: Bot page', ...fm, '---', '# Bot page', '', 'Written by the group bot.'].join('\n');
        const out = await dispatchToolCall(b.engine, 'put_page', { slug, content }, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
        const text = out.content.map(c => c.text).join('\n');
        let json: Record<string, any> = {};
        try { json = JSON.parse(text); } catch { /* prose */ }
        return { isError: out.isError === true, json };
      }
      const oldCanary = (key: string) => 'canaryold' + 'lo' + key.replace(/[^a-z]/g, '') + 'x';
      /** The enforced member CLI's whole read surface (enforced-member-classes READ_OPS), for one origin key: which ops show it. */
      async function enforcedSeen(key: 'lab' | 'open'): Promise<string[]> {
        const slug = ORIGINS[key].slug;
        const reads: Array<[string, Record<string, unknown>, (text: string) => boolean]> = [
          ['search', { query: 'harbor ledger planning notes', autocut: false, limit: 100 }, t => t.includes(b.canary(key))],
          ['query', { query: 'harbor ledger planning notes', expand: false, autocut: false, limit: 100 }, t => t.includes(b.canary(key))],
          ['search_exact', { phrase: b.canary(key) }, t => t.includes('"slug":"' + slug + '"')],
          ['list_pages', { limit: 100 }, t => t.includes('"' + slug + '"')],
          ['find_pages', { pattern: slug.split('/')[0] + '/*' }, t => t.includes('"slug":"' + slug + '"')],
          ['get_page', { slug }, t => t.includes(b.canary(key))],
          ['get_backlinks', { slug: LHUB }, t => t.includes('"' + slug + '"')],
          ['get_timeline', { slug }, t => t.includes('Timeline ' + b.canary(key))],
          ['get_links', { slug }, t => t.includes('"to_slug":"' + LHUB + '"')],
          ['get_tags', { slug }, t => t.includes('tag-' + key)],
          ['get_versions', { slug, include_body: true }, t => t.includes(oldCanary(key))],
          ['whoami', {}, t => t.includes(b.canary(key)) || t.includes(slug)],
          ['entity', { name: slug }, t => t.includes(b.canary(key))],
          ['whois', { query: key + ' origin', types: ['note'] }, t => t.includes('"slug":"' + slug + '"')],
          ['traverse_graph', { slug: LHUB, depth: 1, direction: 'in' }, t => t.includes('"from_slug":"' + slug + '"')],
        ];
        const seen: string[] = [];
        await withEnv({ [ENFORCED_MEMBER_ENV]: BOT }, async () => {
          for (const [op, params, shows] of reads) {
            const text = await enforcedRead(b.engine, op, op, params, { sourceId: SRC }).then(r => JSON.stringify(r), () => '');
            if (shows(text)) seen.push(op);
          }
        });
        return seen;
      }
      /** get_stats --by type through the enforced CLI: the page counts the member sees. */
      async function enforcedStats(): Promise<number> {
        return withEnv({ [ENFORCED_MEMBER_ENV]: BOT }, async () => ((await enforcedRead(b.engine, 'get_stats', 'get_stats', { by: 'type' }, { sourceId: SRC })) as { total_pages: number }).total_pages);
      }
      const ALL_READS = ['search', 'query', 'search_exact', 'list_pages', 'find_pages', 'get_page', 'get_backlinks', 'get_timeline', 'get_links', 'get_tags', 'get_versions', 'entity', 'whois', 'traverse_graph'];

      beforeAll(async () => {
        b = await buildLineageBrain({
          kind, store, src: SRC, tag: 'lo', origins: ORIGINS,
          rules: [{ id: 'team', prefix: 'team/', readable_by: ['group:team-a'] }],
          members: [OWNER, BOT, 'bob-example', 'alice-example'], groups: { 'team-a': [BOT, 'bob-example'] }, owner: OWNER,
          callers: [{ name: 'owner', member: OWNER }, { name: 'bot', member: BOT }, { name: 'bob', member: 'bob-example' }, { name: 'alice', member: 'alice-example' },
            { name: 'as-bot', as: BOT }, { name: 'unbound' }],
        });
        await importFromContent(b.engine, MIXED, ['---', 'type: note', 'title: mixed derived', 'derived_from: [' + ORIGINS.lab.slug + ', ' + ORIGINS.open.slug + ']', '---', '# mixed', '', 'Harbor ledger planning notes ' + MIXED_CANARY + ' here.'].join('\n'), { sourceId: SRC });
        for (const [fm, canary] of [[[] as string[], RELAB_V1], [['readable_by: [group:team-a]'], RELAB_V2]] as const) {
          await importFromContent(b.engine, RELAB, ['---', 'type: note', 'title: relabelled', ...fm, '---', '# relabelled', '', 'Harbor ledger planning notes ' + canary + ' here.'].join('\n'), { sourceId: SRC });
        }
        await importFromContent(b.engine, LHUB, ['---', 'type: project', 'title: labelled hub', '---', '# labelled hub', '', 'Anchor page.'].join('\n'), { sourceId: SRC });
        for (const key of ['lab', 'open'] as const) {
          await b.engine.addLink(ORIGINS[key].slug, LHUB, 'hub', 'mentions', 'fixture', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
          await b.engine.addTimelineEntry(ORIGINS[key].slug, { date: '2026-01-02', source: 'fixture', summary: 'Timeline ' + b.canary(key) }, { sourceId: SRC });
          await b.engine.addTag(ORIGINS[key].slug, 'tag-' + key, { sourceId: SRC });
        }
        await b.engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE source_id = $1', [SRC]);
        const minted = await mintLegacyToken(b.engine, { name: 'bot-writer', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
        await bindCredential(b.engine, { kind: 'token', id: minted.id }, { member: BOT });
        Object.assign(writeToken, { token: minted.token, id: minted.id });
      }, 300_000);
      afterAll(async () => { await b?.close(); }, 60_000);

      test('no grant anywhere (the default): every caller, the future labelled-only member included, reads as before', async () => {
        for (const who of [...OTHERS, 'bot', 'as-bot']) before[who] = await b.seenBy(who);
        const ordinary = b.expected(['lab', 'rule', 'open', ...derivedOf(b.keys, ['open'])], factsOf(b.keys, ['open']));
        expect(before.bot).toEqual(ordinary);
        expect(before.bob).toEqual(ordinary);
        expect(before['as-bot']).toEqual(ordinary);
        expect(await enforcedSeen('open')).toEqual(ALL_READS);
        expect((await doctor()).message).toStartWith('Not applicable');
        expect((await accessCheck(b.engine, { token: 'bot' })).labelled_only).toBe(false);
      }, 600_000);

      test('on, lineage off: only the labelled pages, on every path; no derived page or fact, whatever its origin', async () => {
        await grant(true);
        const labelled = { ...b.expected(['lab', 'rule'], []), backlinks: [] };
        expect(await b.seenBy('bot')).toEqual(labelled);
        expect(await b.seenBy('as-bot')).toEqual(labelled);
        expect(await b.call('bot', 'get_page', { slug: MIXED })).not.toContain(MIXED_CANARY);
        for (const who of OTHERS) expect({ who, seen: await b.seenBy(who) }).toEqual({ who, seen: before[who]! });
      }, 600_000);

      test('on: the enforced member CLI shows the labelled page on every read op and the unlabelled one on none; stats count only labelled pages', async () => {
        expect(await enforcedSeen('lab')).toEqual(ALL_READS);
        expect(await enforcedSeen('open')).toEqual([]);
        expect(await enforcedStats()).toBe(4);
      }, 600_000);

      test('on, lineage on: derived pages and facts of labelled origins only; never of an unlabelled, unreadable or mixed origin', async () => {
        await lineage(true);
        try {
          expect(await b.seenBy('bot')).toEqual({ ...b.expected(['lab', 'rule', ...derivedOf(b.keys, ['lab', 'rule'])], factsOf(b.keys, ['lab', 'rule'])), backlinks: [] });
          expect(await b.call('bot', 'get_page', { slug: MIXED })).not.toContain(MIXED_CANARY);
          expect(await b.call('bob', 'get_page', { slug: MIXED })).toContain(MIXED_CANARY);
          expect(await enforcedStats()).toBe(4 + derivedOf(b.keys, ['lab', 'rule']).length);
        } finally {
          await lineage(false);
        }
        expect(await b.seenBy('bot')).toEqual({ ...b.expected(['lab', 'rule'], []), backlinks: [] });
      }, 600_000);

      test('writes: an unreadable target is refused; a create must name the member', async () => {
        await expect(authorizePageVisibility(b.engine, authority(), ORIGINS.open.slug)).rejects.toMatchObject({ code: 'page_not_found' });
        await expect(authorizePageVisibility(b.engine, authority(), ORIGINS.lab.slug)).resolves.toBeUndefined();
        await expect(authorizePageVisibility(b.engine, authority(), ORIGINS.rule.slug)).resolves.toBeUndefined();
        // A checkout source on Postgres refuses direct writes until it is bound or allows database-only writes; the access checks run either way.
        if (store === 'git') await b.engine.setConfig('persistence.unbound_write', 'database_only');
        const unnamed = await put('notes/bot-new', []);
        expect(unnamed.json).toMatchObject({ code: 'access_labelled_only_unnamed' });
        expect(JSON.stringify(unnamed.json)).toContain('readable_by: [' + BOT + ']');
        expect((await b.engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', [SRC, 'notes/bot-new'])).length).toBe(0);
        expect((await put('notes/bot-new', ['readable_by: [group:team-a]'])).isError).toBe(false);
        expect((await put('team/bot-new', [])).isError).toBe(false);
        await grant(false);
        try {
          await expect(authorizePageVisibility(b.engine, authority(), ORIGINS.open.slug)).resolves.toBeUndefined();
          expect((await put('notes/bot-open', [])).isError).toBe(false);
        } finally {
          await grant(true);
        }
      }, 600_000);

      test('access check, who-can-read and doctor report it; the grant off restores every view', async () => {
        const check = await accessCheck(b.engine, { token: 'bot' });
        expect(check.labelled_only).toBe(true);
        expect(check.explanation).toContain('It is labelled-only');
        expect((await accessCheck(b.engine, { token: 'bob' })).labelled_only).toBe(false);
        const open = (await whoCanRead(b.engine, ORIGINS.open.slug, SRC))[0]!;
        expect(open.note).toContain('Labelled-only members (' + BOT + ')');
        const lab = (await whoCanRead(b.engine, ORIGINS.lab.slug, SRC))[0]!;
        expect(lab.members).toContain(BOT);
        expect((await whoCanRead(b.engine, ORIGINS.other.slug, SRC))[0]!.members).not.toContain(BOT);
        const d = await doctor();
        expect(d.status).toBe('ok');
        expect(d.message).toContain(BOT);
        expect((await cli(['member', 'list'])).members.find((m: { id: string }) => m.id === BOT)).toMatchObject({ labelled_only: true });
        await grant(false);
        expect(await b.seenBy('bot')).toEqual(before.bot);
        expect((await doctor()).message).toStartWith('Not applicable');
      }, 600_000);

      test('an older version that named nobody stays hidden after the page is relabelled; ordinary readers still see it', async () => {
        const versions = (who: string) => b.call(who, 'get_versions', { slug: RELAB, include_body: true });
        expect(await versions('bob')).toContain(RELAB_V1);
        await grant(true);
        try {
          expect(await b.call('bot', 'get_page', { slug: RELAB })).toContain(RELAB_V2);
          const own = await versions('bot');
          expect(own).not.toContain(RELAB_V1);
          expect(await versions('bob')).toContain(RELAB_V1);
        } finally {
          await grant(false);
        }
        expect(await versions('bot')).toContain(RELAB_V1);
      }, 600_000);

      test('enforced member writes: an unlabelled target is hidden, and a new slug is writable only under a rule naming the member', async () => {
        const view = async (slug: string) => {
          const base = await remoteCallerAccess(b.engine, undefined, [], 'stdio', null, BOT);
          const ea: EnforcedAccess = { member: BOT, hiddenSources: new Set(),
            access: { ...base, identity: [...base.identity ?? []], satisfiedRuleIds: [...base.satisfiedRuleIds ?? []], hidePrivate: true, owner: false, privateReadableSources: [], applyRemoteReadPolicy: false } };
          return memberPageView(b.engine, ea, SRC, slug);
        };
        const all = async () => [await view(ORIGINS.open.slug), await view(ORIGINS.lab.slug), await view('notes/enforced-new'), await view('team/enforced-new')];
        expect(await all()).toEqual(['readable', 'readable', 'missing', 'missing']);
        await grant(true);
        try {
          expect(await all()).toEqual(['hidden', 'readable', 'hidden', 'missing']);
        } finally {
          await grant(false);
        }
        expect(await all()).toEqual(['readable', 'readable', 'missing', 'missing']);
      }, 600_000);
    });
  }
}
