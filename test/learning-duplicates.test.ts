/**
 * Nightly learning PR 3: the ranked duplicate-people list. learning_derive reads the dedupe preview (the function
 * `gbrain dedupe --preview` uses), ranks the person groups by the best owner-contact score among their members and
 * records the top five as duplicate_to_confirm items; learned renders each from the current preview.
 *
 * 1. Protects: a group with a person the owner met this week sorts above a group nobody met, which the preview lists
 *    first; without an owner page the preview's own order stands; at most five groups are open at once; a group
 *    confirmed or rejected through gbrain dedupe leaves the next note; a world-scope token never sees a group with a
 *    member page it cannot read, while the owner's token does; a second cycle records nothing twice.
 * 2. Fails when: derive ignores owner contact, keeps more than five groups open, records a group twice, or confirms or
 *    links anything; learned shows a decided group or a group a remote caller cannot fully read.
 * 3. Real seams: PGLite (and Postgres when DATABASE_URL is set) with no git repository, runCycle, gbrain dedupe's CLI
 *    module, tokens minted by the token service and verified as serve --http does, dispatched through MCP dispatch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runCycle } from '../src/core/cycle.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { runDedupe, scan } from '../src/commands/dedupe.ts';
import { formatLearned, type LearnedItem, type LearnedView } from '../src/core/learning/read.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

const SOURCES = ['default', 'source-b'];
const OWNER = 'alice-example';
/** The owner's own page once access.owner_member names a member (identity/owner.ts). */
const OWNER_PAGE = 'memory/members/alice-example';
const NAMES = ['bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'];

const person = (name: string, extra: string[] = []) =>
  ['---', 'type: person', `title: ${name[0]!.toUpperCase()}${name.slice(1)} Example`, `github: ${name}-example`, ...extra, '---', `# ${name} example`, '', 'A person.'].join('\n');

for (const backend of testBackends()) {
  describe(`learning duplicates (${backend}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const parse = (out: { isError?: boolean; content: Array<{ text: string }> }) => {
      const text = out.content.map(c => c.text).join('\n');
      if (out.isError) throw new Error(text);
      return JSON.parse(out.content[0]!.text);
    };
    const local = async (): Promise<LearnedView> => parse(await dispatchToolCall(engine, 'learned', { since: '2000-01-01', limit: 100 }, { remote: false }));
    const remote = async (who: string): Promise<LearnedView> => {
      __resetPrivateVisibilityCacheForTests();
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      return parse(await dispatchToolCall(engine, 'learned', { since: '2000-01-01', limit: 100 }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      }));
    };
    const derive = async () => (await runCycle(engine, { brainDir: null, phases: ['learning_derive'] })).phases.find(p => p.phase === 'learning_derive')!;
    const dupes = (v: LearnedView) => v.items.filter(i => i.kind === 'duplicate_to_confirm');
    const slugsOf = (i: LearnedItem) => [...new Set(i.evidence.map(e => e.slug))];
    const pair = async (name: string, extra: string[] = []) => {
      for (const s of SOURCES) await importFromContent(engine, `people/${name}-example`, person(name, s === 'source-b' ? extra : []), { sourceId: s, noEmbed: true });
    };
    const meet = async (name: string, days: number[]) => {
      for (const d of days) {
        const slug = `meetings/standup-${name}-${d}`;
        await importFromContent(engine, slug, `---\ntype: meeting\ntitle: Standup ${d}\n---\nMet ${name}.`, { noEmbed: true });
        await engine.executeRaw('UPDATE pages SET effective_date = now() - make_interval(days => $1) WHERE slug = $2', [d, slug]);
        await engine.addLink(slug, `people/${name}-example`, '', '');
      }
    };
    const cli = async (args: string[]) => {
      const spy = spyOn(console, 'log').mockImplementation(() => {});
      try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
    };
    const personGroups = async () => {
      const s = await scan(engine);
      return s.result.groups.filter(g => s.kindOf.get(g.id) === 'person');
    };

    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const s of SOURCES) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [s]);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
      const mint = async (name: string, member?: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: SOURCES });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('owner', OWNER);
      await mint('unbound');
      await setOwner(engine, OWNER);
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);
    afterEach(() => { resetGateway(); });

    beforeEach(async () => {
      for (const sql of ['DELETE FROM learning_items', "DELETE FROM config WHERE key LIKE 'cycle.enrich_thin.%' OR key IN ('enrich_thin.daily_spend', 'learning.keyless_thin_contacts')", 'DELETE FROM entity_identities', 'DELETE FROM entity_identity_reviews', 'DELETE FROM links', 'DELETE FROM pages',
        "DELETE FROM config WHERE key = 'learning.derive.watermark'"]) await engine.executeRaw(sql);
      __resetPrivateVisibilityCacheForTests();
    });

    test('a group with a person the owner met this week sorts above a group the preview lists first; without an owner page the preview order stands', async () => {
      await pair('bob');
      await pair('carol');
      const preview = await personGroups();
      expect(preview).toHaveLength(2);
      const [first, second] = preview.map(g => g.members[0]!.slug.replace(/^people\/|-example$/g, ''));
      await importFromContent(engine, OWNER_PAGE, '---\ntype: person\ntitle: Owner\n---\nThe owner.', { noEmbed: true });
      await meet(second!, [1, 2, 4]);

      const phase = await derive();
      expect(phase.status).toBe('ok');
      expect(phase.details.duplicates).toMatchObject({ recorded: 2, ranked_by: 'owner-contact' });
      const view = await local();
      expect(dupes(view).map(i => slugsOf(i))).toEqual([[`people/${second}-example`], [`people/${first}-example`]]);
      const item = dupes(view)[0]!;
      expect(item.family).toBe('question');
      const group = preview.find(g => g.members[0]!.slug === `people/${second}-example`)!;
      expect(item.commands).toEqual({ confirm: ['gbrain', 'dedupe', 'confirm', group.id], reject: ['gbrain', 'dedupe', 'reject', group.id] });
      expect(formatLearned(view)).toContain(`gbrain dedupe confirm ${group.id}`);
      expect(await engine.executeRaw('SELECT 1 FROM entity_identities')).toHaveLength(0);

      await engine.executeRaw('DELETE FROM learning_items');
      await engine.deletePage(OWNER_PAGE);
      const fallback = await derive();
      expect(fallback.details.duplicates).toMatchObject({ recorded: 2, ranked_by: 'preview' });
      expect(dupes(await local()).map(i => slugsOf(i))).toEqual([[`people/${first}-example`], [`people/${second}-example`]]);
    });

    test('at most five groups are open at once, and an answered group frees its slot for the next', async () => {
      for (const name of NAMES) await pair(name);
      expect(await personGroups()).toHaveLength(7);
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 5, groups: 7 });
      const open = dupes(await local());
      expect(open).toHaveLength(5);
      // Derive runs every few minutes on autopilot: with five still open it asks nothing new.
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 0, groups: 7 });
      await cli(['reject', open[0]!.commands!.reject[3]!]);
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 1 });
      expect(dupes(await local())).toHaveLength(5);
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 0 });
    });

    test('undo on a duplicate question hands back the dedupe command; once answered there, the item closes and frees its slot', async () => {
      for (const name of ['bob', 'carol']) await pair(name);
      await derive();
      const [item] = dupes(await local());
      const undo = parse(await dispatchToolCall(engine, 'learned_undo', { ids: item!.id }, { remote: false }));
      expect(undo.results).toEqual([{ id: item!.id, kind: 'duplicate_to_confirm', status: 'owner_command', reason: 'dedupe answers run on the brain host', command: item!.commands!.reject }]);
      const kept = parse(await dispatchToolCall(engine, 'learned_keep', { ids: item!.id }, { remote: false }));
      expect(kept.results).toEqual([{ id: item!.id, kind: 'duplicate_to_confirm', status: 'refused', reason: 'a question: answer it (learned-undo, or the commands the note shows)' }]);
      const state = async () => (await engine.executeRaw<{ state: string; decided_by: string | null }>('SELECT state, decided_by FROM learning_items WHERE id = $1', [item!.id]))[0];
      expect(await state()).toEqual({ state: 'pending', decided_by: null });
      await cli(['reject', item!.commands!.reject[3]!]);
      expect((await derive()).details.duplicates).toMatchObject({ closed: 1, recorded: 0 });
      expect(await state()).toEqual({ state: 'expired', decided_by: 'dedupe_preview' });
    });

    test('an open question stays in the default note after it was shown and past the seven days, until it is answered', async () => {
      for (const name of NAMES) await pair(name);
      await derive();
      const note = async (): Promise<LearnedView> => parse(await dispatchToolCall(engine, 'learned', { limit: 100 }, { remote: false }));
      const shown = dupes(await note());
      expect(shown).toHaveLength(5);
      expect(dupes(await note()).map(i => i.id)).toEqual(shown.map(i => i.id));
      await engine.executeRaw("UPDATE learning_items SET created_at = now() - interval '8 days'");
      const later = dupes(await note());
      expect(later.map(i => i.id)).toEqual(shown.map(i => i.id));
      await cli(['reject', later[0]!.commands!.reject[3]!]);
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 1 });
      expect(dupes(await note())).toHaveLength(5);
    });

    test('answered groups never push open ones out of a short note, and the best-ranked shows first', async () => {
      for (const name of NAMES) await pair(name);
      await derive();
      const first = dupes(await local());
      for (const item of first.slice(0, 2)) await cli(['reject', item.commands!.reject[3]!]);
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 2 });
      const view = parse(await dispatchToolCall(engine, 'learned', { since: '2000-01-01', limit: 5 }, { remote: false }));
      const shown = dupes(view);
      expect(shown).toHaveLength(5);
      expect(shown.map(i => Number(i.id))).toEqual([...shown.map(i => Number(i.id))].sort((a, b) => a - b));
      expect(shown.slice(0, 3).map(i => i.id)).toEqual(first.slice(2).map(i => i.id));
    });

    test('a group confirmed or rejected through gbrain dedupe leaves the next note', async () => {
      for (const name of ['bob', 'carol', 'dave']) await pair(name);
      await derive();
      const before = dupes(await local());
      expect(before).toHaveLength(3);
      const idOf = (name: string) => before.find(i => slugsOf(i)[0] === `people/${name}-example`)!.commands!.reject[3]!;
      await cli(['confirm', idOf('bob')]);
      await cli(['reject', idOf('carol')]);
      expect(dupes(await local()).map(i => slugsOf(i))).toEqual([['people/dave-example']]);
    });

    test('a world-scope token never sees a group with a member page it cannot read; the owner token does', async () => {
      await pair('bob');
      await pair('carol', ['readable_by: [alice-example]']);
      await derive();
      const all = dupes(await local()).map(i => slugsOf(i)[0]).sort();
      expect(all).toEqual(['people/bob-example', 'people/carol-example']);
      expect(dupes(await remote('owner')).map(i => slugsOf(i)[0]).sort()).toEqual(all);
      const world = dupes(await remote('unbound'));
      expect(world.map(i => slugsOf(i)[0])).toEqual(['people/bob-example']);
      expect(world[0]!.commands!.reject.slice(0, 3)).toEqual(['gbrain', 'dedupe', 'reject']);
    });

    /** Two thin people the owner met this week, one person nobody met, and the owner's own page. */
    const thinContacts = async (owner = true) => {
      if (owner) await importFromContent(engine, OWNER_PAGE, '---\ntype: person\ntitle: Owner\n---\nThe owner.', { noEmbed: true });
      for (const name of ['bob', 'carol', 'dave']) await importFromContent(engine, `people/${name}-example`, person(name), { noEmbed: true });
      await meet('bob', [1, 3]);
      await meet('carol', [2]);
    };
    const keylessLine = '2 close contacts have thin pages; a chat key would fill them.';

    test('keyless: two thin close contacts put one line in the note with the enable commands and cost; nothing is spent', async () => {
      resetGateway();
      await thinContacts();
      const phase = await derive();
      expect(phase.details.thin_contacts).toMatchObject({ count: 2 });
      const view = await local();
      expect(view.thin_contacts).toEqual({
        count: 2, text: keylessLine,
        commands: [['export', 'ANTHROPIC_API_KEY=<your key>'], ['gbrain', 'config', 'set', 'cycle.enrich_thin.enabled', 'true']],
        cost: { usd: 0.02, basis: 'per_page_estimate' },
      });
      expect(formatLearned(view)).toContain(keylessLine);
      expect(formatLearned(view)).toContain('gbrain config set cycle.enrich_thin.enabled true');
      expect(await engine.getConfig('enrich_thin.daily_spend')).toBeNull();
      await engine.setConfig('cycle.enrich_thin.max_daily_cost_usd', '0.5');
      await derive();
      expect((await local()).thin_contacts?.cost).toEqual({ usd: 0.5, basis: 'daily_cap' });
      expect(await engine.getConfig('enrich_thin.daily_spend')).toBeNull();
    });

    test('with a chat model configured the line is absent', async () => {
      await thinContacts();
      await derive();
      __setChatTransportForTests(async () => { throw new Error('no chat call expected'); });
      expect((await local()).thin_contacts).toBeNull();
      expect((await derive()).details.thin_contacts).toBeUndefined();
      resetGateway();
      expect((await local()).thin_contacts).toBeNull();
    });

    test('with no owner page the line is absent', async () => {
      resetGateway();
      await thinContacts(false);
      await derive();
      expect((await local()).thin_contacts).toBeNull();
    });

    test('a remote token without owner scope never sees the line; the owner token does', async () => {
      resetGateway();
      await thinContacts();
      await derive();
      expect((await remote('unbound')).thin_contacts).toBeNull();
      expect((await remote('owner')).thin_contacts).toMatchObject({ count: 2 });
    });

    test('a second cycle records the same groups once', async () => {
      await pair('bob');
      await pair('carol');
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 2 });
      expect((await derive()).details.duplicates).toMatchObject({ recorded: 0 });
      const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM learning_items WHERE kind = 'duplicate_to_confirm'");
      expect(row!.n).toBe(2);
    });
  });
}
