/**
 * GST-2957: a stored link context is an excerpt of the from page's body, so a reference in or next to a facts fence
 * carries fence row text, private rows and held rows (a world cell whose fact is stored narrower) included. Every
 * reader that hands a context to a remote caller whose fact reads are world-only (worldOnlyFacts) must leave that text
 * out: get_backlinks, get_links, traverse_graph (walk and hops), entity and context_pack's cards. context_pack's core
 * block must leave held rows out for the same caller. The owner's remote callers and the local CLI keep what they read
 * before. Each read runs through MCP dispatch as the caller, on PGLite, and on Postgres when DATABASE_URL is set.
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { LINK_CONTEXT_PAGE_BOUND } from '../src/core/eligibility/fence-overlay.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const page = (type: string, title: string, rows: ReturnType<typeof row>[], fm = '') =>
  '---\ntype: ' + type + '\ntitle: ' + title + '\n' + fm + '---\n# ' + title + '\n\nProfile.\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n';

const TARGET = 'people/target-example';
const THIRD = 'people/third-example';
const ACME = 'companies/acme-example';
const LIA = 'people/lia-example';
const PLAIN = 'notes/plain-example';
const KIM = 'people/kim-example';
const MEET = 'meetings/standup-example';
const CORE = 'notes/core-example';
/** Fence rows on LIA: a private row and a held row, each naming another page. */
const PRIV = 'pelicanprivcanary';
const HELD = 'wombatheldcanary';
/** Fence rows on a core page with no links: they reach a reader only through the core block. */
const CORE_PRIV = 'heronprivcorecanary';
const CORE_HELD = 'badgerheldcorecanary';
/** A private row on a meeting page naming an attendee: the attendance edge is stored from the attendee, its context cut from the meeting. */
const MEET_PRIV = 'lynxmeetprivcanary';
/** A context a writer gave add_link on a page with a fence. */
const MANUAL = 'quailmanualnote';
/** A context outside any fence, which every caller keeps. */
const PROSE = 'otterplainprose';
const HOPS = [{ link_type: 'works_at', toward: 'object' }];
/** A private row on a page whose fence a body-only edit later dropped without extracting its links again. */
const STALE = 'people/stale-example';
const STALE_PRIV = 'ospreystaleprivcanary';
/** A takes row inside the first 240 characters of a page, stored as a manual context the way preserve_notes stored it. */
const NOTE_PRIV = 'grebenoteprivcanary';
const NOTE_CONTEXT = ('Partner note.\n\n' + renderTakesFence([{ rowNum: 1, claim: 'Deal is risky ' + NOTE_PRIV, kind: 'take', holder: 'brain', weight: 0.5, active: true }] as never)).slice(0, 240);
/** A page with more backlinks, each from its own page, than one read of origin bodies carries. */
const HUB = 'notes/hub-example';
const SPOKES = LINK_CONTEXT_PAGE_BOUND + 5;
const SPOKE_PROSE = 'spokeprosecontext';
/** A typed chain whose first edge keeps an excerpt the anchor page no longer holds (its fence was dropped since extraction). */
const CH_ANCHOR = 'people/chainanchor-example';
const CH_CO = 'companies/chainco-example';
const CH_FOUNDER = 'people/chainfounder-example';
const CHAIN_PRIV = 'kitestalechaincanary';
const CHAIN_Q = 'Who founded the companies that Chainanchor Example invested in?';
const CHAIN_HOPS = [{ link_type: 'invested_in', toward: 'object' }];
const LINK_MATCH_SQL = 'AS u(i, fs, fslug, ts, tslug, lt, ctx)';
const ORIGIN_BODY_SQL = 'SELECT id, source_id, slug, compiled_truth, timeline FROM pages';

for (const kind of testBackends()) {
  describe('GST-2957 stored link context and the core block for world-only callers (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      let out;
      if (who === 'local') out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: 'default' });
      else {
        const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
        out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
      }
      const text = out.content.map(c => c.text).join('\n');
      expect(out.isError, who + ' ' + op + ': ' + text.slice(0, 300)).toBeFalsy();
      return text;
    }
    const put = (slug: string, content: string) => call('local', 'put_page', { slug, content, request_id: randomUUID() });
    const holdRow = (canary: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'],
      () => tx.executeRaw("UPDATE facts SET visibility = 'private' WHERE fact LIKE '%' || $1 || '%'", [canary]), TEST_WRITE_ATTRIBUTION));

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      for (const [slug, title] of [[TARGET, 'Target Example'], [THIRD, 'Third Example']]) await put(slug, page('person', title, [row(1, title + ' likes tea')]));
      await put(ACME, page('company', 'Acme Example', [row(1, 'Acme makes widgets')]));
      await put(LIA, page('person', 'Lia Example', [
        row(1, 'Lia owes [[' + TARGET + ']] money ' + PRIV, 'private'),
        row(2, 'Lia works at [[' + ACME + ']] as an engineer'),
        row(3, 'Lia dated [[' + THIRD + ']] ' + HELD),
      ]));
      await put(KIM, '---\ntype: person\ntitle: Kim Example\n---\n# Kim Example\n\nProfile.\n');
      await put(MEET, '---\ntype: meeting\ntitle: Standup Example\ndate: 2026-01-01\n---\n# Standup Example\n\n## Facts\n\n'
        + renderFactsTable([row(1, 'The standup ran long'), row(2, 'Budget raised ' + MEET_PRIV, 'private')] as never) + '\n\n## Attendees\n\n- [[' + KIM + ']]\n');
      await call('local', 'add_link', { from: LIA, to: THIRD, link_type: 'related_to', context: 'Met through a ' + MANUAL, request_id: randomUUID() });
      await put(PLAIN, '---\ntype: note\ntitle: Plain\n---\n# Plain\n\nThe ' + PROSE + ' memo mentions [[' + TARGET + ']] in passing.\n');
      await put(STALE, page('person', 'Stale Example', [row(1, 'Stale owes [[' + TARGET + ']] rent ' + STALE_PRIV, 'private')]));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        "UPDATE pages SET compiled_truth = '# Stale Example\n\nProfile rewritten.\n' WHERE slug = $1", [STALE]), TEST_WRITE_ATTRIBUTION));
      await call('local', 'add_link', { from: THIRD, to: ACME, link_type: 'related_to', context: NOTE_CONTEXT, request_id: randomUUID() });
      await put(CH_ANCHOR, '---\ntype: person\ntitle: Chainanchor Example\n---\n# Chainanchor Example\n\nA seed investor.\n');
      await put(CH_CO, '---\ntype: company\ntitle: Chainco Example\n---\n# Chainco Example\n\nA payments company founded by Chainfounder.\n');
      await put(CH_FOUNDER, '---\ntype: person\ntitle: Chainfounder Example\n---\n# Chainfounder Example\n\nBuilds payment rails.\n');
      await engine.addLink(CH_ANCHOR, CH_CO, 'Chainanchor invested in [[' + CH_CO + ']] ' + CHAIN_PRIV + ' at the seed round', 'invested_in', 'markdown');
      await engine.addLink(CH_CO, CH_FOUNDER, 'founded by Chainfounder', 'founded', 'markdown');
      await engine.setConfig('search.relational_planner', 'true');
      await put(HUB, '---\ntype: note\ntitle: Hub\n---\n# Hub\n');
      const spokes = Array.from({ length: SPOKES }, (_, n) => ({ slug: 'notes/spoke-' + String(n).padStart(3, '0'), text: 'Spoke ' + n + ' cites the hub ' + SPOKE_PROSE + '.' }));
      for (const s of spokes) await engine.putPage(s.slug, { title: s.slug, type: 'note' as never, compiled_truth: s.text, timeline: '', frontmatter: {}, source_path: s.slug + '.md' });
      await engine.addLinksBatch(spokes.map(s => ({ from_slug: s.slug, to_slug: HUB, link_type: 'mentions', context: s.text,
        link_source: 'markdown', from_source_id: 'default', to_source_id: 'default' })) as never);
      await put(CORE, page('note', 'Core Example', [row(1, 'Core detail ' + CORE_PRIV, 'private'), row(2, 'Core detail ' + CORE_HELD), row(3, 'Core detail public')], 'always_load: true\n'));
      // Held: a world cell whose stored fact is narrower, the state an unaccepted widening leaves (GST-2891).
      await holdRow(HELD);
      await holdRow(CORE_HELD);
      await engine.setConfig('memory.core.enabled', 'true');
      for (const id of ['owner-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member?: string) => {
        const m = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
        tokens[name] = m.token;
        if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member }); else await readsUnscopedOnPurpose(engine, m.id);
      };
      await mint('owner', 'owner-example'); await mint('bob', 'bob-example'); await mint('unbound');
      await setOwner(engine, 'owner-example');
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); }, 60_000);

    const linkReads: Array<[string, string, Record<string, unknown>]> = [
      ['get_backlinks', 'get_backlinks', { slug: TARGET }],
      ['get_backlinks third', 'get_backlinks', { slug: THIRD }],
      ['get_backlinks acme', 'get_backlinks', { slug: ACME }],
      ['get_links', 'get_links', { slug: LIA }],
      ['traverse_graph', 'traverse_graph', { slug: LIA, depth: 1 }],
      ['traverse_graph in', 'traverse_graph', { slug: TARGET, depth: 1, direction: 'in' }],
      ['traverse_graph hops', 'traverse_graph', { slug: LIA, hops: HOPS }],
      ['entity', 'entity', { name: LIA }],
      ['entity target', 'entity', { name: TARGET }],
      ['context_pack', 'context_pack', { entities: LIA }],
      ['get_links attendee', 'get_links', { slug: KIM }],
      ['get_backlinks meeting', 'get_backlinks', { slug: MEET }],
      ['traverse_graph attendee', 'traverse_graph', { slug: KIM, depth: 1 }],
      ['entity attendee', 'entity', { name: KIM }],
      ['entity meeting', 'entity', { name: MEET }],
      ['traverse_graph stale hop', 'traverse_graph', { slug: CH_ANCHOR, hops: CHAIN_HOPS }],
      ['search relational chain', 'search', { query: CHAIN_Q }],
    ];

    test('the fixture stores the private and held rows inside link contexts', async () => {
      const contexts = (await engine.executeRaw<{ context: string }>('SELECT context FROM links')).map(r => r.context).join('\n');
      expect(contexts).toContain(PRIV);
      expect(contexts).toContain(HELD);
      for (const canary of [STALE_PRIV, NOTE_PRIV]) expect(contexts).toContain(canary);
      // The extractor stores a body link with no origin page: each reader's leak case is such a row, read against its from page.
      const noOrigin = (await engine.executeRaw<{ context: string }>("SELECT context FROM links WHERE origin_page_id IS NULL AND link_source = 'markdown'")).map(r => r.context).join('\n');
      for (const canary of [PRIV, HELD, STALE_PRIV, CHAIN_PRIV]) expect(noOrigin).toContain(canary);
      expect(NOTE_CONTEXT).toContain('<!--- gbrain:takes:begin -->');
      const stale = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug = $1', [STALE]);
      expect(stale[0]!.compiled_truth).not.toContain('gbrain:facts');
      const attendance = await engine.executeRaw<{ context: string }>(
        'SELECT l.context FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages o ON o.id = l.origin_page_id WHERE f.slug = $1 AND o.slug = $2', [KIM, MEET]);
      expect(attendance.map(r => r.context).join('\n')).toContain(MEET_PRIV);
      const hop = JSON.parse(await call('local', 'traverse_graph', { slug: LIA, hops: HOPS }));
      expect(hop.answers.map((a: { slug: string }) => a.slug)).toEqual([ACME]);
    }, 60_000);

    test('a world-only remote caller reads no private or held row text through a stored link context', async () => {
      const leaks: string[] = [];
      for (const who of ['bob', 'unbound']) for (const [label, op, params] of linkReads) {
        const text = await call(who, op, params);
        for (const canary of [PRIV, HELD, MEET_PRIV, STALE_PRIV, NOTE_PRIV, CHAIN_PRIV]) if (text.includes(canary)) leaks.push(who + ' ' + label + ' ' + canary);
      }
      expect(leaks).toEqual([]);
    }, 120_000);

    test("context_pack's core block leaves held rows out for a world-only remote caller", async () => {
      for (const who of ['bob', 'unbound']) {
        const text = await call(who, 'context_pack', { entities: TARGET });
        expect(text).toContain('Core detail public');
        expect(text).not.toContain(CORE_PRIV);
        expect(text).not.toContain(CORE_HELD);
      }
    }, 60_000);

    test('a context outside any fence, or one a writer gave add_link, still reaches a world-only remote caller', async () => {
      for (const who of ['bob', 'unbound']) {
        expect(await call(who, 'get_links', { slug: LIA })).toContain(MANUAL);
        expect(await call(who, 'traverse_graph', { slug: LIA, depth: 1 })).toContain(MANUAL);
        expect(await call(who, 'get_backlinks', { slug: TARGET })).toContain(PROSE);
        expect(await call(who, 'entity', { name: TARGET })).toContain(PROSE);
      }
    }, 60_000);

    test("the owner's remote caller and the local CLI still read the private and held rows' context", async () => {
      for (const who of ['owner', 'local']) {
        expect(await call(who, 'get_backlinks', { slug: TARGET })).toContain(PRIV);
        expect(await call(who, 'get_backlinks', { slug: THIRD })).toContain(HELD);
        const links = await call(who, 'get_links', { slug: LIA });
        for (const canary of [PRIV, HELD]) expect(links).toContain(canary);
        expect(await call(who, 'entity', { name: LIA })).toContain(PRIV);
        expect(await call(who, 'get_links', { slug: KIM })).toContain(MEET_PRIV);
        expect(await call(who, 'get_backlinks', { slug: TARGET })).toContain(STALE_PRIV);
        expect(await call(who, 'get_links', { slug: THIRD })).toContain(NOTE_PRIV);
        expect(await call(who, 'traverse_graph', { slug: CH_ANCHOR, hops: CHAIN_HOPS })).toContain(CHAIN_PRIV);
        expect(await call(who, 'search', { query: CHAIN_Q })).toContain(CHAIN_PRIV);
        const pack = await call(who, 'context_pack', { entities: LIA });
        for (const canary of [PRIV, HELD, CORE_HELD]) expect(pack).toContain(canary);
      }
      for (const who of ['bob', 'unbound']) {
        expect(await call(who, 'traverse_graph', { slug: CH_ANCHOR, hops: CHAIN_HOPS })).toContain(CH_CO);
        expect(await call(who, 'search', { query: CHAIN_Q })).toContain('founded by Chainfounder');
      }
      const walk = await call('owner', 'traverse_graph', { slug: LIA, depth: 1 });
      for (const canary of [PRIV, HELD]) expect(walk).toContain(canary);
    }, 120_000);

    test('origin bodies are read once for at most LINK_CONTEXT_PAGE_BOUND pages; owner and local reads run no extra query and return contexts as stored', async () => {
      const sql: string[] = [];
      const executeRaw = engine.executeRaw;
      engine.executeRaw = function (this: BrainEngine, q: string, p?: unknown[]) { sql.push(q); return executeRaw.call(this, q, p as never); } as typeof engine.executeRaw;
      const read = async (who: string, slug: string) => {
        sql.length = 0;
        const rows = JSON.parse(await call(who, 'get_backlinks', { slug })) as Array<{ from_slug: string; context: string }>;
        return { rows, match: sql.filter(q => q.includes(LINK_MATCH_SQL)).length, bodies: sql.filter(q => q.includes(ORIGIN_BODY_SQL)).length };
      };
      try {
        const stored = await executeRaw.call(engine,
          'SELECT f.slug AS from_slug, l.context FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE t.slug = $1', [TARGET]) as Array<{ from_slug: string; context: string }>;
        const pairs = (rows: Array<{ from_slug: string; context: string }>) => rows.map(r => r.from_slug + ' ' + r.context).sort();
        for (const who of ['owner', 'local']) {
          const hub = await read(who, HUB);
          expect({ match: hub.match, bodies: hub.bodies }).toEqual({ match: 0, bodies: 0 });
          expect(hub.rows.filter(r => r.context.includes(SPOKE_PROSE)).length).toBe(SPOKES);
          const target = await read(who, TARGET);
          expect({ match: target.match, bodies: target.bodies }).toEqual({ match: 0, bodies: 0 });
          expect(pairs(target.rows)).toEqual(pairs(stored));
        }
        for (const who of ['bob', 'unbound']) {
          const hub = await read(who, HUB);
          expect(hub.rows.length).toBe(SPOKES);
          expect({ match: hub.match, bodies: hub.bodies }).toEqual({ match: 1, bodies: 1 });
          expect(hub.rows.filter(r => r.context.includes(SPOKE_PROSE)).length).toBe(LINK_CONTEXT_PAGE_BOUND);
        }
        for (const [op, params] of [['traverse_graph', { slug: CH_ANCHOR, hops: CHAIN_HOPS }], ['search', { query: CHAIN_Q }]] as const) {
          for (const who of ['owner', 'local', 'bob', 'unbound']) {
            sql.length = 0;
            await call(who, op, params);
            const world = who === 'bob' || who === 'unbound';
            expect({ who, op, match: sql.filter(q => q.includes(LINK_MATCH_SQL)).length, bodies: sql.filter(q => q.includes(ORIGIN_BODY_SQL)).length })
              .toEqual({ who, op, match: world ? 1 : 0, bodies: world ? 1 : 0 });
          }
        }
      } finally {
        engine.executeRaw = executeRaw;
      }
    }, 300_000);
  });
}
