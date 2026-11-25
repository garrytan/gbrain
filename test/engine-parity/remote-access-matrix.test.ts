/**
 * BrainEngine parity: the remote read-access matrix, end to end through the MCP dispatcher (src/mcp/dispatch.ts
 * dispatchToolCall). Which pages and facts each caller sees through each read tool, per transport, on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through harness.ts) the same
 *    brain answers the same bytes to the same remote caller. An unbound read-grant token (http), and an unauthenticated
 *    stdio caller naming no member, see only the open page and the world fact. A credential bound to bob-example (http
 *    token; stdio server started with --stdio-member) also sees the page that names bob-example and the folder page whose
 *    rule names it. The brain owner (config access.owner_member, a bound credential) also sees `visibility: private`
 *    pages and private facts, but never another member's readable_by page, a read-by-nobody page (`readable_by: []`) or a
 *    folder page whose rule does not name it (member access stays mandatory for the owner). The trusted local caller
 *    (remote: false) sees everything. The tools: get_page, search (keyword), query, list_pages, find_pages, get_tags,
 *    get_links, get_backlinks, get_timeline and recall; a page a caller may not read is absent from every one of them
 *    (page_not_found on a single-page read, no row in a list, no edge to or from it).
 *  - Regression: a remote MCP caller on a Rust-engine brain used to be refused centrally
 *    (src/mcp/engine-access-refusal.ts) because the engine lacked the access_control capability. The Rust engine now serves
 *    all 95 access_control members (rust-engine/members/access.ts) and reports the capability, so the central refusal no
 *    longer fires and a remote call reaches the Rust store's own member and visibility reads directly. A hole there would
 *    answer a remote caller MORE than PGLite does (a fail-open), or refuse where PGLite answers.
 *  - Why existing coverage misses it: test/rust-remote-dispatch-refusal.test.ts pins the refusal, not the answers once it
 *    is gone; test/access-*.test.ts (owner reads, folder rules, read-by-nobody, member reads) run PGLite and Postgres only,
 *    never the Rust arm; the engine-parity access-* cases call engine members, not the tools a remote client reaches.
 *  - Seams: none for the reads (real engines, the real dispatcher, tokens minted by the token service and verified by the
 *    OAuth provider as serve --http does, owner set by setOwner and credentials bound by bindCredential). The members are
 *    seeded by addMember (typed). The folder rules go through the real policy path (proposeRevision), which applies on every
 *    arm, the Rust one included (asserted: `applied:applied`). Embeddings are off, so search and query run keyword-only.
 *  - The owner on the Rust arm: the store does not model the owner's lineage read yet, so every remote owner read refuses
 *    by name before any work (ownerLineageRefusal, src/mcp/engine-access-refusal.ts); the owner cases assert that every
 *    cell refused that way and leaked no page or fact, then stop on the pin in test/rust-stop-pins/remote-access.tsv.
 *  - Every page is sealed before the reads (seed drains the projection queue): an unsealed page is left out of keyword
 *    search, and whether the background resealer reached it depends on what ran before on the arm.
 *
 * Each cell is observed twice: `seen` (the fixture pages and facts whose canary or slug the answer names) is asserted
 * inline against the expected table, engine-independent; `payload` (the whole parsed answer, with only ids and timestamps
 * removed) is compared across arms by the harness. Nothing is normalized away that carries page content or which pages appear.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../../src/core/source-resolver.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';
import { flushAccessReadLog } from '../../src/core/access/read-log.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'owner-example';
const BOB = 'bob-example';
const CAROL = 'carol-example';

/** The fixture pages: key, slug and the frontmatter lines that make each readable by some callers and not others. */
const PAGES = {
  open: { slug: 'notes/open-example', fm: [] as string[] },
  priv: { slug: 'notes/private-example', fm: ['visibility: private'] },
  bob: { slug: 'notes/bob-example', fm: [`readable_by: [${BOB}]`] },
  nobody: { slug: 'notes/nobody-example', fm: ['readable_by: []'] },
  ownerOnly: { slug: 'notes/owner-only-example', fm: [`readable_by: [${OWNER}]`] },
  folderBob: { slug: 'partners/bob-example/plan', fm: [] as string[] },
  folderClosed: { slug: 'partners/closed/plan', fm: [] as string[] },
} as const;
type PageKey = keyof typeof PAGES;
const KEYS = Object.keys(PAGES) as PageKey[];
const HUB = 'notes/hub-example';
const canaryOf = (key: string) => `cnry${key.toLowerCase()}zz`;
const tagOf = (key: string) => `tag-${key.toLowerCase()}-zz`;
const WORLD_FACT = 'cnryworldfactzz';
const PRIVATE_FACT = 'cnryprivfactzz';
const QUERY = 'harbor ledger planning notes';

const pageText = (title: string, canary: string, fm: readonly string[]) =>
  ['---', 'type: note', `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary} for the roadmap.`].join('\n');

/** Who reads what, as a literal table (engine-independent). A page not in a caller's list is hidden from it on every tool. */
const CALLERS = ['unbound-http', 'bob-http', 'owner-http', 'unbound-stdio', 'bob-stdio', 'owner-stdio', 'local'] as const;
/**
 * The owner's remote reads are their own cases (the owner lineage read, GST-2490): on every arm, the Rust one included,
 * each caller must answer exactly as PGLite does.
 */
const GROUPS = {
  members: ['unbound-http', 'bob-http', 'unbound-stdio', 'bob-stdio', 'local'],
  owner: ['owner-http', 'owner-stdio'],
} as const satisfies Record<string, readonly (typeof CALLERS)[number][]>;
type Group = keyof typeof GROUPS;
type Caller = typeof CALLERS[number];
const VISIBLE: Record<Caller, PageKey[]> = {
  'unbound-http': ['open'],
  'bob-http': ['open', 'bob', 'folderBob'],
  'owner-http': ['open', 'priv', 'ownerOnly'],
  'unbound-stdio': ['open'],
  'bob-stdio': ['open', 'bob', 'folderBob'],
  'owner-stdio': ['open', 'priv', 'ownerOnly'],
  local: KEYS,
};
const FACTS: Record<Caller, string[]> = {
  'unbound-http': [WORLD_FACT], 'bob-http': [WORLD_FACT], 'owner-http': [WORLD_FACT, PRIVATE_FACT],
  'unbound-stdio': [WORLD_FACT], 'bob-stdio': [WORLD_FACT], 'owner-stdio': [WORLD_FACT, PRIVATE_FACT], local: [WORLD_FACT, PRIVATE_FACT],
};

interface Fixture { tokens: Record<'unbound' | 'bob' | 'owner', string>; folderRules: string }

/** Install the two folder rules through the real policy path. A refusal is returned, never thrown, so it shows in the answer. */
async function folderRules(engine: BrainEngine): Promise<string> {
  try {
    const r = await proposeRevision(engine, 'default', [
      { id: 'bob-folder', prefix: 'partners/bob-example/', readable_by: [`member:${BOB}`] },
      { id: 'closed-folder', prefix: 'partners/closed/', readable_by: [`member:${CAROL}`] },
    ], { origin: 'cli', store: 'database' });
    return `applied:${r.state}`;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === 'engine_capability_missing') return `refused:${e.code}:${e.message}`;
    throw error;
  }
}

async function seed(engine: BrainEngine, _backend: ParityBackend): Promise<Fixture> {
  __resetPrivateVisibilityCacheForTests();
  for (const id of [OWNER, BOB, CAROL]) await addMember(engine, id);
  const rules = await folderRules(engine);
  for (const key of KEYS) await importFromContent(engine, PAGES[key].slug, pageText(key, canaryOf(key), PAGES[key].fm), { sourceId: 'default', noEmbed: true } as never);
  await importFromContent(engine, HUB, pageText('hub', canaryOf('hub'), []), { sourceId: 'default', noEmbed: true } as never);
  for (const key of KEYS) {
    await engine.addTag(PAGES[key].slug, tagOf(key), { sourceId: 'default' });
    await engine.addTimelineEntry(PAGES[key].slug, { date: '2026-01-02', source: 'fixture', summary: `Timeline ${canaryOf(key)}`, detail: '' }, { sourceId: 'default' });
  }
  await engine.addLinksBatch([
    ...KEYS.flatMap(key => [
      { from_slug: HUB, to_slug: PAGES[key].slug, link_type: 'mentions', context: `hub names ${key}` },
      { from_slug: PAGES[key].slug, to_slug: HUB, link_type: 'mentions', context: `${key} names hub` },
      ...(key === 'open' ? [] : [{ from_slug: PAGES[key].slug, to_slug: PAGES.open.slug, link_type: 'mentions', context: `${key} names open` }]),
    ]),
  ]);
  // The facts: one private, one world, written by the trusted local caller as the other access suites do.
  for (const [canary, visibility] of [[PRIVATE_FACT, 'private'], [WORLD_FACT, 'world']] as const) {
    const out = await dispatchToolCall(engine, 'remember', { fact: `Harbor ledger planning notes ${canary}`, provenance: 'fixture', entity: PAGES.open.slug, visibility }, { remote: false, sourceId: 'default' });
    if (out.isError) throw new Error(`fixture remember (${visibility}): ${out.content.map(c => c.text).join(' ')}`);
  }
  const mint = async (name: string, member: string | null) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, member ? { member } : { readsUnscoped: true });
    return minted.token;
  };
  const tokens = { unbound: await mint('unbound', null), bob: await mint('bob', BOB), owner: await mint('owner', OWNER) };
  await setOwner(engine, OWNER);
  // Every page sealed before any read: an unsealed page is left out of keyword search on every engine, and whether the
  // background resealer reached a page depends on what ran before on the arm.
  await drainProjections(engine);
  return { tokens, folderRules: rules };
}

/** One tool call as `who`, over the caller's transport, as serve --http (an OAuth-verified token) or the stdio server does. */
async function call(engine: BrainEngine, fx: Fixture, who: Caller, tool: string, params: Record<string, unknown>) {
  const base = { sourceId: 'default' };
  if (who === 'local') return dispatchToolCall(engine, tool, { ...params }, { remote: false, transport: 'stdio', ...base });
  if (who.endsWith('-stdio')) {
    const member = who === 'bob-stdio' ? BOB : who === 'owner-stdio' ? OWNER : undefined;
    return dispatchToolCall(engine, tool, { ...params }, { remote: true, transport: 'stdio', ...base, ...(member ? { stdioMember: member } : {}) });
  }
  const token = fx.tokens[who.replace('-http', '') as keyof Fixture['tokens']];
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
  const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  const sourceId = auth.sourceId ?? 'default';
  const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
  return dispatchToolCall(engine, tool, { ...params }, {
    remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
  });
}

/**
 * Keys that hold a generated id, a write time or a flag derived from write times: the sequences and clocks differ per arm
 * and per run. `content_hash` covers a page body that has a fact's write time in its fact table (the text itself is kept
 * and compared); `stale` is set when a page's updated_at is older than its newest timeline entry's created_at.
 */
const VOLATILE = /(^|_)(id|ids)$|_at$|_revision$|^(revision|created|updated|fetched|content_hash|stale|effective_date|valid_from|valid_until|took_ms|elapsed_ms)$/;
/** Text a write-time clock or sequence put into a string (a fact's number, an ISO time, a revision uuid). */
const volatileText = (text: string) => text
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  .replace(/\bfact \d+\b/g, 'fact <n>')
  .replace(/^\| \d+ \|/gm, '| <n> |');
/** The parsed answer with only ids and write times removed. */
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return volatileText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.test(k)).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

/**
 * The answer's JSON and nothing else. A tool result is the JSON on its first line, then (once per session, so it depends on
 * what ran before on the arm) notice and degraded-search lines for the agent; those carry no page, fact or edge.
 */
function answerJson(text: string): unknown {
  for (const candidate of [text, text.split('\n')[0]!]) {
    try { return JSON.parse(candidate); } catch { /* try the first line */ }
  }
  return text;
}

interface Cell { error: string | null; pages: PageKey[]; facts: string[]; payload: unknown; body: unknown }

/** Run one read; `by` says what names a fixture page in the answer: its canary (content), its slug (a list or an edge) or its tag. */
async function observe(engine: BrainEngine, fx: Fixture, who: Caller, tool: string, params: Record<string, unknown>, by: 'canary' | 'slug' | 'tag' = 'canary'): Promise<Cell> {
  const out = await call(engine, fx, who, tool, params);
  const text = out.content.map(c => c.text).join('\n');
  const body = answerJson(text);
  const error = out.isError === true ? String((body as { code?: string })?.code ?? 'error') : null;
  // An error names the slug it was asked for, so only a successful answer is searched for names.
  const hay = error ? '' : text;
  const mark = (key: PageKey) => by === 'canary' ? canaryOf(key) : by === 'tag' ? tagOf(key) : PAGES[key].slug;
  return { error, pages: KEYS.filter(key => hay.includes(mark(key))), facts: [WORLD_FACT, PRIVATE_FACT].filter(f => hay.includes(f)), payload: error ? { error } : scrub(body), body };
}

/** `seen` and its expectation in one object, so a failure names the caller, the tool and the page. */
const verdict = (who: Caller, what: string, cell: Cell) => ({ who, what, error: cell.error, pages: cell.pages, facts: cell.facts });
const inKeyOrder = (keys: Iterable<PageKey>) => KEYS.filter(k => new Set(keys).has(k));

describe('engine parity: remote read-access matrix over MCP', () => {
  for (const group of Object.keys(GROUPS) as Group[]) {
  parityTest(`page reads (${group}): get_page, search, query, list_pages and find_pages show each caller only the pages it may read`, {
    methods: ['getPage', 'searchKeyword', 'listPages', 'readFolderAccess', 'readAccessMembers'],
  }, async (engine, backend) => {
    const fx = await seed(engine, backend);
    expect(fx.folderRules).toBe('applied:applied');
    const out: Record<string, unknown> = { folderRules: fx.folderRules };
    for (const who of GROUPS[group]) {
      const visible = VISIBLE[who];
      const mine: Record<string, unknown> = {};
      for (const key of KEYS) {
        const cell = await observe(engine, fx, who, 'get_page', { slug: PAGES[key].slug });
        // The open page carries the entity's facts; which of them a caller gets is compared across arms (the owner over
        // stdio gets only the world fact there on PGLite), but a caller never gets one outside its own fact table.
        const facts = cell.facts;
        expect(facts.every(f => FACTS[who].includes(f))).toBe(true);
        if (key === 'open') expect(facts).toContain(WORLD_FACT);
        expect(verdict(who, `get_page ${key}`, { ...cell, facts: [] })).toEqual({
          who, what: `get_page ${key}`, error: visible.includes(key) ? null : 'page_not_found', pages: visible.includes(key) ? [key] : [], facts: [],
        });
        mine[`get_page ${key}`] = cell.payload;
      }
      const lists: Array<[string, string, Record<string, unknown>, 'canary' | 'slug', (k: PageKey) => boolean]> = [
        ['search', 'search', { query: QUERY, match: 'keyword', fields: 'full', limit: 20 }, 'canary', () => true],
        ['query', 'query', { query: QUERY, expand: false, fields: 'full', limit: 20 }, 'canary', () => true],
        ['list_pages', 'list_pages', { limit: 100 }, 'slug', () => true],
        ['find_pages notes/*', 'find_pages', { pattern: 'notes/*' }, 'slug', k => PAGES[k].slug.startsWith('notes/')],
        ['find_pages partners/*', 'find_pages', { pattern: 'partners/*' }, 'slug', k => PAGES[k].slug.startsWith('partners/')],
      ];
      for (const [label, tool, params, by, inScope] of lists) {
        const cell = await observe(engine, fx, who, tool, params, by);
        const retrieval = tool === 'search' || tool === 'query';
        expect(verdict(who, label, cell)).toEqual({
          who, what: label, error: null, pages: inKeyOrder(visible.filter(inScope)), facts: retrieval ? FACTS[who] : [],
        });
        mine[label] = cell.payload;
      }
      out[who] = mine;
    }
    // The access read log writes on a timer: flush it, so a refused write lands in the case whose reads it logs.
    await flushAccessReadLog();
    return out;
  });

  parityTest(`edge and fact reads (${group}): get_tags, get_links, get_backlinks, get_timeline and recall show each caller only what it may read`, {
    methods: ['getTags', 'getLinks', 'getBacklinks', 'getTimeline', 'listFactsByEntity', 'listFactsSince'],
  }, async (engine, backend) => {
    const fx = await seed(engine, backend);
    expect(fx.folderRules).toBe('applied:applied');
    const out: Record<string, unknown> = { folderRules: fx.folderRules };
    for (const who of GROUPS[group]) {
      const visible = VISIBLE[who];
      const mine: Record<string, unknown> = {};
      for (const key of KEYS) {
        const seen = visible.includes(key);
        // A page the caller may not read answers an empty list (no error, no edge), never its tags, entries or edges.
        const want: Array<[string, 'tag' | 'slug' | 'canary', PageKey[]]> = [
          ['get_tags', 'tag', seen ? [key] : []],
          ['get_timeline', 'canary', seen ? [key] : []],
          // Every page names open and the hub; the hub names every page. So a page's edges out are itself and open.
          ['get_links', 'slug', seen ? inKeyOrder([key, 'open']) : []],
          // The hub (not a fixture page) names every page; open is also named by every readable page.
          ['get_backlinks', 'slug', seen ? inKeyOrder(key === 'open' ? [...visible] : [key]) : []],
        ];
        for (const [tool, by, pages] of want) {
          const cell = await observe(engine, fx, who, tool, { slug: PAGES[key].slug }, by);
          expect(verdict(who, `${tool} ${key}`, cell)).toEqual({ who, what: `${tool} ${key}`, error: null, pages, facts: [] });
          mine[`${tool} ${key}`] = cell.payload;
        }
      }
      // The hub is open and names every page: its edges out reach only the pages the caller reads.
      const hubLinks = await observe(engine, fx, who, 'get_links', { slug: HUB }, 'slug');
      expect(verdict(who, 'get_links hub', hubLinks)).toEqual({ who, what: 'get_links hub', error: null, pages: inKeyOrder(visible), facts: [] });
      mine['get_links hub'] = hubLinks.payload;
      for (const params of [{ entity: PAGES.open.slug }, { question: QUERY }, {}]) {
        const cell = await observe(engine, fx, who, 'recall', params);
        expect(verdict(who, `recall ${JSON.stringify(params)}`, cell)).toEqual({ who, what: `recall ${JSON.stringify(params)}`, error: null, pages: [], facts: FACTS[who] });
        mine[`recall ${JSON.stringify(params)}`] = cell.payload;
      }
      // The owner's recall-by-canary cells ride in this case, so the owner's reads stop on one pinned refusal per case.
      if (group === 'owner') {
        for (const key of KEYS) {
          const cell = await observe(engine, fx, who, 'recall', { query: canaryOf(key), limit: 100 });
          expect({ who, what: `recall query ${key}`, error: cell.error, pages: cell.pages }).toEqual({ who, what: `recall query ${key}`, error: null, pages: visible.includes(key) ? [key] : [] });
          expect(cell.facts.every(f => FACTS[who].includes(f))).toBe(true);
          mine[`recall query ${key}`] = cell.payload;
        }
      }
      out[who] = mine;
    }
    // The access read log writes on a timer: flush it, so a refused write lands in the case whose reads it logs.
    await flushAccessReadLog();
    return out;
  });

  if (group === 'members') {
  parityTest('recall query: the page arm returns only pages the caller may read, the same pages on every engine', {
    methods: ['searchKeyword'],
  }, async (engine, backend) => {
    const fx = await seed(engine, backend);
    expect(fx.folderRules).toBe('applied:applied');
    const out: Record<string, unknown> = { folderRules: fx.folderRules };
    for (const who of GROUPS[group]) {
      const visible = VISIBLE[who];
      const mine: Record<string, unknown> = {};
      // recall `query` also searches pages. One query per page canary, so each answer is that page or nothing: a broad query
      // is cut at a score tie that differs by engine, which says nothing about access.
      for (const key of KEYS) {
        const cell = await observe(engine, fx, who, 'recall', { query: canaryOf(key), limit: 100 });
        // Every page is sealed (seed drains the projection queue), so the canary finds its page exactly when the caller may read it.
        expect({ who, what: `recall query ${key}`, error: cell.error, pages: cell.pages }).toEqual({ who, what: `recall query ${key}`, error: null, pages: visible.includes(key) ? [key] : [] });
        expect(cell.facts.every(f => FACTS[who].includes(f))).toBe(true);
        mine[`recall query ${key}`] = cell.payload;
      }
      out[who] = mine;
    }
    // The access read log writes on a timer: flush it, so a refused write lands in the case whose reads it logs.
    await flushAccessReadLog();
    return out;
  });
  }
  }
});
