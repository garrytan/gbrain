/**
 * GST-3189: the sharing-contract matrix. For each way a personal brain can turn shared, it reads every piece of content
 * as every kind of caller before and after the change, through gbrain's own transports, and checks each cell against
 * the access contract (docs/guides/access-designations.md, docs/guides/conversation-archive.md): the owner's own callers
 * never lose a read, and nobody else ever gains one. Keyless and synthetic: a hashed stand-in for embeddings and no
 * provider key. Ported from the gbrain-evals sharing-contract matrix (v0.60.744.0); contract() is unchanged.
 *
 * The test files pin the cells known to break the contract (EXPECTED_BAD), so a new bad cell fails and so does a pinned
 * cell that starts holding.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { executeRawJsonb, sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { noGrantFederatedScope, localFederatedSourceIds } from '../../src/core/source-resolver.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { addMember, bindCredential, disableMember } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { brainServes } from '../../src/core/access/serves.ts';
import { classifyBrainAudience } from '../../src/core/facts/writeback-audience.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveRescopeSkipped, runTranscriptArchive, setArchiveEnabled } from '../../src/core/transcripts/archive.ts';
import { softDeleteSource, restoreSource } from '../../src/core/destructive-guard.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runAccess } from '../../src/commands/access.ts';
import { runConfig } from '../../src/commands/config.ts';
import { mountAdminAccess } from '../../src/commands/serve-http-access.ts';
import { createRequireAdmin } from '../../src/commands/serve-http-admin-api.ts';
import express from 'express';
import cookieParser from 'cookie-parser';
import { emptyHome, withEnv } from './with-env.ts';
import { archivedPages, conversation, staticReader } from './transcript-archive.ts';
const G = { PGLiteEngine, GBrainOAuthProvider, sqlQueryForEngine, mintLegacyToken, noGrantFederatedScope, localFederatedSourceIds, dispatchToolCall,
  startHttpTransport, RateLimiter, __resetPrivateVisibilityCacheForTests, addMember, bindCredential, disableMember, setOwner, brainServes,
  classifyBrainAudience, disposePersistenceConsumer, ARCHIVE_TIMEZONE_KEY, archiveRescopeSkipped, runTranscriptArchive, setArchiveEnabled,
  softDeleteSource, restoreSource, importFromContent, runAccess, runConfig, mountAdminAccess, createRequireAdmin, express, cookieParser,
  emptyHome, withEnv, archivedPages, conversation, staticReader };

const OWNER = 'alice-example';
const OTHER = 'bob-example';
const DIMS = 1536;
const GRANT = ['default', 'conversations', 'owner-notes', 'old-project'];

function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

/** One piece of content. Its mark appears only in the stored text, never in a query, so an echoed query is never a read. */
interface Item { id: string; label: string; kind: 'page' | 'fact'; source: string; slug: string; query: string; mark: string }
const page = (id: string, label: string, source: string, slug: string, query: string, mark: string): Item => ({ id, label, kind: 'page', source, slug, query, mark });
const ITEMS: Item[] = [
  page('world', 'public page (no designation)', 'default', 'notes/adworldqzx', 'adworldqzx harbor', 'markworldjtq'),
  page('private', 'private page (visibility: private)', 'default', 'notes/adprivateqzx', 'adprivateqzx harbor', 'markprivatejtq'),
  page('owner_listed', 'page kept to the owner (readable_by owner)', 'default', 'notes/adlistedqzx', 'adlistedqzx harbor', 'marklistedjtq'),
  page('owner_source', 'page in an owner-only source', 'owner-notes', 'notes/advaultqzx', 'advaultqzx harbor', 'markvaultjtq'),
  page('archive', 'conversation archive page written while personal', 'conversations', '', 'adarchiveqzx harbor', 'markarchivejtq'),
  page('archived_source', 'page in an archived source', 'old-project', 'notes/adoldqzx', 'adoldqzx harbor', 'markoldjtq'),
  page('archived_private', 'private page in an archived source', 'old-project', 'notes/adoldprivateqzx', 'adoldprivateqzx harbor', 'markoldprivatejtq'),
  { id: 'world_fact', label: 'public fact', kind: 'fact', source: 'default', slug: 'notes/adworldqzx', query: 'adfactworldqzx ledger', mark: 'factworldhmz' },
  { id: 'private_fact', label: 'private fact', kind: 'fact', source: 'default', slug: 'notes/adworldqzx', query: 'adfactprivateqzx ledger', mark: 'factprivatehmz' },
];

type CallerKind = 'local' | 'owner' | 'owner_unset' | 'member' | 'nonmember' | 'unauthenticated' | 'disabled';
interface Caller { id: string; label: string; kind: CallerKind }
const CALLERS: Caller[] = [
  { id: 'local', label: 'trusted local owner (CLI on the brain host)', kind: 'local' },
  { id: 'owner_http', label: "owner's remote MCP caller: token bound to the owner, over HTTP", kind: 'owner' },
  { id: 'owner_oauth', label: "owner's remote MCP caller: OAuth client bound to the owner", kind: 'owner' },
  { id: 'owner_stdio', label: "owner's MCP caller: stdio server bound to the owner", kind: 'owner' },
  { id: 'member_http', label: 'another member: token bound to bob-example, over HTTP', kind: 'member' },
  { id: 'nonmember_http', label: 'non-member token (bound to nobody), over HTTP', kind: 'nonmember' },
  { id: 'unauth_http', label: 'unauthenticated HTTP caller (no bearer token)', kind: 'unauthenticated' },
];

/** Each read names the item's source; the _unscoped twins name none, the way an agent usually calls. */
type ReadPath = 'get_page' | 'search' | 'query' | 'list_pages' | 'recall' | 'get_page_unscoped' | 'search_unscoped' | 'query_unscoped' | 'list_unscoped' | 'recall_unscoped';
const PAGE_PATHS: ReadPath[] = ['get_page', 'search', 'query', 'list_pages', 'get_page_unscoped', 'search_unscoped', 'query_unscoped', 'list_unscoped'];
const FACT_PATHS: ReadPath[] = ['recall', 'query', 'recall_unscoped', 'query_unscoped'];
const OP: Record<ReadPath, string> = { get_page: 'get_page', search: 'search', query: 'query', list_pages: 'list_pages', recall: 'recall', get_page_unscoped: 'get_page',
  search_unscoped: 'search', query_unscoped: 'query', list_unscoped: 'list_pages', recall_unscoped: 'recall' };

function argsFor(path: ReadPath, item: Item, slug: string): Record<string, unknown> {
  switch (path) {
    case 'get_page': return { slug, source_id: item.source };
    case 'search': return { query: item.query, match: 'keyword', fields: 'full', limit: 50, source_id: item.source };
    case 'query': return { query: item.query, expand: false, fields: 'full', limit: 50, source_id: item.source };
    case 'list_pages': return { limit: 500, source_id: item.source };
    case 'recall': return { query: item.query, limit: 50, source_id: item.source };
    case 'get_page_unscoped': return { slug };
    case 'search_unscoped': return { query: item.query, match: 'keyword', fields: 'full', limit: 50 };
    case 'query_unscoped': return { query: item.query, expand: false, fields: 'full', limit: 50 };
    case 'list_unscoped': return { limit: 500 };
    case 'recall_unscoped': return { query: item.query, limit: 50 };
  }
}

/**
 * What the contract allows, from access-designations.md's "Who reads what" table and conversation-archive.md:
 * Unscoped reads (no source_id) search the caller's default read set, so for them only 'never' and the before/after
 * comparison bind. 'must' = the caller must read it (the owner's callers, R94: never lose a read); 'never' = it must not;
 * 'may' = the contract allows either (an unbound token reading world content in its grace, personal-era archive pages
 * on a personal brain, where gbrain treats every caller as the owner; the owner's own member before any owner is set,
 * which reads what lists it but gets no owner relaxation; the archived source, hidden by the owner's own choice).
 */
type Expect = 'must' | 'never' | 'may';
function contract(caller: CallerKind, item: Item, shared: boolean, path: ReadPath): Expect {
  if (caller === 'unauthenticated' || caller === 'disabled') return 'never';
  const scoped = !path.endsWith('_unscoped');
  if (item.id === 'archived_source' || item.id === 'archived_private') return caller === 'local' || caller === 'owner' ? 'may' : 'never';
  if (caller === 'local' || caller === 'owner') return scoped ? 'must' : 'may';
  if (caller === 'owner_unset') return ['private', 'owner_source', 'private_fact'].includes(item.id) ? 'never' : 'may';
  if (item.id === 'world' || item.id === 'world_fact') return caller === 'member' && scoped ? 'must' : 'may';
  if (item.id === 'archive' && !shared && caller === 'nonmember') return 'may';
  return 'never';
}

export interface Cell { scenario: string; phase: 'before' | 'after'; caller: string; item: string; path: ReadPath; read: boolean | null; error?: string; expect: Expect; verdict: 'ok' | 'violation' | 'owner_lost' }

interface Brain {
  engine: any; close: () => Promise<void>; home: string; tokens: Record<string, string>; server: any; archiveSlug: string;
  oauth: () => Promise<string>;
}

export type EngineFactory = () => Promise<{ engine: BrainEngine; close: () => Promise<void> }>;
export const pgliteEngine: EngineFactory = async () => {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  return { engine, close: () => engine.disconnect() };
};

async function makeBrain(opts: { ownerSet: boolean; otherDisabled?: boolean }, open: EngineFactory): Promise<Brain> {
  const { engine, close } = await open();
  G.__resetPrivateVisibilityCacheForTests();
  const home = G.emptyHome();
  await engine.setConfig('maintenance.auto', 'false');
  await engine.setConfig(G.ARCHIVE_TIMEZONE_KEY, 'UTC');
  await G.setArchiveEnabled(engine, true);
  for (const [id, config] of [['owner-notes', { owner_only: true, federated: true }], ['old-project', { federated: true }]] as const) {
    await executeRawJsonb(engine, 'INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [id], [config]);
  }
  const body = (it: Item, fm: string) => '---\ntype: note\ntitle: ' + it.id + '\n' + fm + '---\n# ' + it.id + '\n\nPlanning notes ' + it.query + ' ' + it.mark + '.\n';
  for (const it of ITEMS.filter(i => i.kind === 'page' && i.id !== 'archive')) {
    const fm = it.id === 'private' || it.id === 'archived_private' ? 'visibility: private\n' : it.id === 'owner_listed' ? 'readable_by: [' + OWNER + ']\n' : '';
    await G.importFromContent(engine, it.slug, body(it, fm), { sourceId: it.source });
  }
  await G.addMember(engine, OWNER);
  if (opts.otherDisabled) { await G.addMember(engine, OTHER); await G.disableMember(engine, OTHER); }
  if (opts.ownerSet) await G.setOwner(engine, OWNER);
  const reader = G.staticReader('openclaw', [G.conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', 'Planning notes adarchiveqzx harbor private markarchivejtq']], { chatType: 'direct', verified: true })]);
  const run = await G.withEnv({ GBRAIN_HOME: home }, () => G.runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') }));
  if (run.privacy !== 'personal') throw new Error('setup: the archive did not run as personal');
  const archiveSlug = (await G.archivedPages(engine, 'conversations')).find((p: { body: string }) => p.body.includes('markarchivejtq'))!.slug;
  for (const it of ITEMS.filter(i => i.kind === 'fact')) {
    await engine.insertFact({ fact: 'Planning notes ' + it.query + ' ' + it.mark, kind: 'fact', source: 'test', visibility: it.id === 'private_fact' ? 'private' : 'world' }, { source_id: it.source });
    await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [it.slug, '%' + it.mark]);
  }
  const tokens: Record<string, string> = {};
  const brain: Brain = { engine, close, home, tokens, server: null, archiveSlug, oauth: async () => '' };
  await mint(brain, 'owner_http', OWNER);
  await mint(brain, 'nonmember_http', null);
  const provider = () => new G.GBrainOAuthProvider({ sql: G.sqlQueryForEngine(engine), transaction: (fn: any) => engine.transaction((tx: any) => fn(G.sqlQueryForEngine(tx))) });
  const client = await provider().registerClientManual('ad-owner-client', ['client_credentials'], 'read', [], 'default', GRANT);
  await G.bindCredential(engine, { kind: 'client', id: client.clientId }, { member: OWNER });
  brain.oauth = async () => (await provider().exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;
  brain.server = await G.startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
    ip: new G.RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 1000 }),
    token: new G.RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 1000 }),
  } });
  return brain;
}

async function mint(b: Brain, name: string, member: string | null): Promise<void> {
  const minted = await G.mintLegacyToken(b.engine, { name: 'tok-' + name, scopes: ['read'], takesHolders: ['world'], sourceGrant: GRANT });
  b.tokens[name] = minted.token;
  if (member) await G.bindCredential(b.engine, { kind: 'token', id: minted.id }, { member });
}

async function closeBrain(b: Brain): Promise<void> {
  b.server?.stop(true);
  await G.disposePersistenceConsumer(b.engine).catch(() => {});
  await b.close();
}

async function http(b: Brain, token: string | null, op: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch('http://127.0.0.1:' + b.server.port + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: args } }),
  });
  return res.status + ' ' + await res.text();
}

async function dispatchText(b: Brain, op: string, args: Record<string, unknown>, opts: Record<string, unknown>): Promise<string> {
  try {
    const out = await G.dispatchToolCall(b.engine, op, { ...args }, opts);
    return out.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  } catch (e) {
    return 'threw ' + (e instanceof Error ? e.message : String(e));
  }
}

async function readAs(b: Brain, caller: Caller, op: string, args: Record<string, unknown>): Promise<string> {
  switch (caller.id) {
    case 'local': return dispatchText(b, op, args, { remote: false });
    case 'owner_stdio': {
      const localFederated = await G.localFederatedSourceIds(b.engine, 'default', 'seed_default').catch(() => undefined);
      return dispatchText(b, op, args, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: OWNER, takesHoldersAllowList: ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    }
    case 'owner_oauth': {
      const provider = new G.GBrainOAuthProvider({ sql: G.sqlQueryForEngine(b.engine), transaction: (fn: any) => b.engine.transaction((tx: any) => fn(G.sqlQueryForEngine(tx))) });
      let auth: any;
      try { auth = await provider.verifyAccessToken(await b.oauth()); } catch (e) { return 'refused ' + (e as Error).message; }
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await G.noGrantFederatedScope(b.engine, auth.hasSourceGrant, sourceId);
      return dispatchText(b, op, args, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    }
    case 'unauth_http': return http(b, null, op, args);
    default: {
      const token = b.tokens[caller.id];
      if (!token) return 'absent';
      return http(b, token, op, args);
    }
  }
}

function present(caller: Caller, b: Brain): boolean {
  return !['member_http', 'nonmember_http', 'owner_http'].includes(caller.id) || !!b.tokens[caller.id];
}

/** The kind a caller has in this state: the owner's credentials count as the owner only while an owner is set, and a disabled member's token reads nothing. */
function kindNow(caller: Caller, state: { shared: boolean; ownerSet: boolean; otherEnabled: boolean }): CallerKind {
  if (caller.kind === 'owner' && !state.ownerSet) return 'owner_unset';
  if (caller.kind === 'member' && !state.otherEnabled) return 'disabled';
  return caller.kind;
}

async function matrix(b: Brain, scenario: string, phase: 'before' | 'after', state: { shared: boolean; ownerSet: boolean; otherEnabled: boolean }, only?: ReadonlySet<ReadPath>): Promise<Cell[]> {
  const shared = state.shared;
  G.__resetPrivateVisibilityCacheForTests();
  const cells: Cell[] = [];
  for (const caller of CALLERS) {
    if (!present(caller, b)) continue;
    const listing: Record<string, string> = {};
    const listKey = (path: ReadPath, item: Item) => path + ':' + (path === 'list_pages' ? item.source : '');
    for (const item of ITEMS) {
      const slug = item.id === 'archive' ? b.archiveSlug : item.slug;
      for (const path of (item.kind === 'page' ? PAGE_PATHS : FACT_PATHS).filter(p => !only || only.has(p))) {
        let text: string;
        const isList = path === 'list_pages' || path === 'list_unscoped';
        if (isList) text = listing[listKey(path, item)] ??= await readAs(b, caller, OP[path], argsFor(path, item, slug));
        else text = await readAs(b, caller, OP[path], argsFor(path, item, slug));
        const read = isList ? text.includes('"' + slug + '"') || text.includes('\\"' + slug + '\\"') : text.includes(item.mark);
        if (process.env.AD_DEBUG && caller.id === process.env.AD_DEBUG) console.log(phase, caller.id, item.id, path, read, process.env.AD_DEBUG_FULL ? text : text.slice(0, 400));
        const expect = contract(kindNow(caller, state), item, shared, path);
        const verdict = expect === 'never' && read ? 'violation' : expect === 'must' && !read ? 'owner_lost' : 'ok';
        cells.push({ scenario, phase, caller: caller.id, item: item.id, path, read, expect, verdict,
          ...(verdict !== 'ok' || !read ? { error: (text.match(/"code"\s*:\s*"([a-z_]+)"/)?.[1] ?? text.slice(0, 160)) } : {}) });
      }
    }
  }
  return cells;
}

/** A cell the owner's caller read before the change and does not read after it (R94). */
function ownerLosses(before: Cell[], after: Cell[]): Cell[] {
  const key = (c: Cell) => c.caller + '|' + c.item + '|' + c.path;
  const had = new Set(before.filter(c => c.read && (c.caller === 'local' || c.caller.startsWith('owner_'))).map(key));
  return after.filter(c => had.has(key(c)) && !c.read && !c.item.startsWith('archived_'));
}

export interface Scenario { name: string; ownerSet?: boolean; otherDisabled?: boolean; change: (b: Brain) => Promise<void>; shared: boolean; mintOther?: boolean; otherEnabledAfter?: boolean }

const inHome = <T>(b: Brain, fn: () => Promise<T>) => G.withEnv({ GBRAIN_HOME: b.home }, fn);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};
const access = (b: Brain, argv: string[]) => inHome(b, () => quiet(() => G.runAccess(b.engine, argv)));
const archiveRun = (b: Brain) => inHome(b, () => G.runTranscriptArchive(b.engine, { mode: 'run', readers: [G.staticReader('openclaw', [])], now: new Date('2026-10-05T00:00:00Z') }));
/** Add a member the way the owner's admin page does: POST /admin/api/access/members on gbrain's own admin routes. */
async function adminAddMember(b: Brain, id: string): Promise<void> {
  const app = G.express();
  app.use(G.cookieParser());
  G.mountAdminAccess(app, G.createRequireAdmin(new Map([['owner-session', Date.now() + 3_600_000]])), b.engine);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  try {
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/admin/api/access/members', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'gbrain_admin=owner-session' }, body: JSON.stringify({ action: 'add', id }) });
    if (res.status !== 200) throw new Error('admin member add answered ' + res.status + ' ' + await res.text());
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
}

/** owner_http and two more clients bound to `member` (null: nobody), each used over HTTP; the two are not matrix callers. */
async function clientsUsed(b: Brain, member: string | null): Promise<void> {
  await mint(b, 'client_muse', member);
  await mint(b, 'client_grok', member);
  for (const name of ['owner_http', 'client_muse', 'client_grok']) {
    for (const op of ['search', 'get_page', 'query']) await http(b, b.tokens[name]!, op, op === 'get_page' ? { slug: 'notes/adworldqzx' } : { query: 'harbor', limit: 3 });
  }
  delete b.tokens.client_muse; delete b.tokens.client_grok;
}

async function threeUnboundClients(b: Brain): Promise<void> {
  await clientsUsed(b, null);
  const audience = await G.classifyBrainAudience(b.engine);
  if (audience.audience !== 'shared') throw new Error('setup: three clients bound to nobody did not make the brain read as shared: ' + audience.reasons.join('; '));
}

async function threeOwnerBoundClients(b: Brain): Promise<void> {
  await clientsUsed(b, OWNER);
  const audience = await G.classifyBrainAudience(b.engine);
  if (audience.audience !== 'personal') throw new Error('setup: three of the owner\'s own clients made the brain read as shared: ' + audience.reasons.join('; '));
}

export const SCENARIOS: Scenario[] = [
  { name: 'personal, no change (control)', change: async () => {}, shared: false },
  { name: 'declared shared: gbrain config set brain.audience shared', shared: true, mintOther: true,
    change: async b => { await inHome(b, () => quiet(() => G.runConfig(b.engine, ['set', 'brain.audience', 'shared']))); await G.addMember(b.engine, OTHER); } },
  { name: 'member count: gbrain access member add bob-example', shared: true, mintOther: true, change: b => access(b, ['member', 'add', OTHER]) },
  { name: 'member count: gbrain access member enable bob-example', otherDisabled: true, shared: true, mintOther: true, change: b => access(b, ['member', 'enable', OTHER]) },
  { name: 'explicit sharing: gbrain access serves several --members alice-example,bob-example --yes', shared: true, mintOther: true,
    change: b => access(b, ['serves', 'several', '--members', OWNER + ',' + OTHER, '--yes']) },
  { name: 'explicit sharing, then the next archive run', shared: true, mintOther: true,
    change: async b => { await access(b, ['serves', 'several', '--members', OWNER + ',' + OTHER, '--yes']); await archiveRun(b); } },
  { name: "MCP-client count: three of the owner's own clients in 30 days, no command", shared: false, change: threeOwnerBoundClients },
  { name: 'MCP-client count: three clients bound to nobody in 30 days, no command', shared: true, change: threeUnboundClients },
  { name: 'MCP-client count: three clients bound to nobody, then the next archive run', shared: true, change: async b => { await threeUnboundClients(b); await archiveRun(b); } },
  { name: 'MCP-client count from three clients bound to nobody, then a second member joins over the admin path (addMember, no CLI)', shared: true, mintOther: true,
    change: async b => { await threeUnboundClients(b); await G.addMember(b.engine, OTHER); } },
  { name: 'MCP-client count from three clients bound to nobody, then a second member joins on the owner admin page (POST /admin/api/access/members)', shared: true, mintOther: true,
    change: async b => { await threeUnboundClients(b); await adminAddMember(b, OTHER); } },
  { name: 'shared with no owner, then gbrain access owner set alice-example', ownerSet: false, shared: true, mintOther: true,
    change: async b => { await access(b, ['member', 'add', OTHER]); await access(b, ['owner', 'set', OWNER]); } },
  { name: 'shared, then back to personal (member disable, brain.audience personal, archive run)', shared: false, otherEnabledAfter: false,
    change: async b => {
      await access(b, ['member', 'add', OTHER]); await mint(b, 'member_http', OTHER);
      await access(b, ['member', 'disable', OTHER]);
      await inHome(b, () => quiet(() => G.runConfig(b.engine, ['set', 'brain.audience', 'personal'])));
      await archiveRun(b);
    } },
  { name: 'conversation source archived while personal, shared by member add, then restored', shared: true, mintOther: true,
    change: async b => {
      await G.softDeleteSource(b.engine, 'conversations');
      await access(b, ['member', 'add', OTHER]);
      await G.restoreSource(b.engine, 'conversations');
    } },
];

/** The read paths the pull-request sample covers; the full matrix reads every path. Both bare-slug and unscoped-listing paths are where archived-source reads leaked (GST-3163). */
export const SAMPLE_PATHS: ReadonlySet<ReadPath> = new Set(['get_page_unscoped', 'list_unscoped', 'search', 'recall_unscoped']);

/**
 * Cells known to break the contract today, each group with its reason. Key: scenario|caller|item|path, all in the after
 * phase. The test compares the bad cells it finds to this list exactly.
 */
const ARCHIVE_PATHS: ReadPath[] = ['get_page', 'search', 'query', 'list_pages', 'get_page_unscoped', 'search_unscoped', 'query_unscoped', 'list_unscoped'];
export const EXPECTED_BAD: Array<{ scenario: string; callers: string[]; item: string; paths: ReadPath[]; reason: string }> = [
  { scenario: 'MCP-client count: three clients bound to nobody in 30 days, no command', callers: ['nonmember_http'], item: 'archive', paths: ARCHIVE_PATHS,
    reason: 'Documented wait: the brain reads as shared from client usage alone, and the personal-era archive pages are re-scoped on the next archive run; archive_rescope_pending is reported until then (conversation-archive.md).' },
  { scenario: 'MCP-client count from three clients bound to nobody, then a second member joins over the admin path (addMember, no CLI)', callers: ['member_http', 'nonmember_http'], item: 'archive', paths: ARCHIVE_PATHS,
    reason: 'The scenario calls the library addMember with no beforeWrite hook. Every caller in src passes one (gbrain access member add, gbrain access serves several, the admin member route), and member enable re-scopes first on both paths, so no user path reaches this state; archive_rescope_pending is reported.' },
];

export function expectedBadKeys(scenario: string, only?: ReadonlySet<ReadPath>): string[] {
  return EXPECTED_BAD.filter(e => e.scenario === scenario)
    .flatMap(e => e.callers.flatMap(c => e.paths.filter(p => !only || only.has(p)).map(p => 'after|' + c + '|' + e.item + '|' + p))).sort();
}

/** Cells a scenario reads: six callers before (no other member yet), seven after when the scenario gives the other member a token. */
export function expectedCellCount(s: Scenario, only?: ReadonlySet<ReadPath>): number {
  const perCaller = ITEMS.reduce((n, item) => n + (item.kind === 'page' ? PAGE_PATHS : FACT_PATHS).filter(p => !only || only.has(p)).length, 0);
  const memberAfter = s.mintOther === true || s.otherEnabledAfter === false;
  return perCaller * (CALLERS.length - 1) + perCaller * (memberAfter ? CALLERS.length : CALLERS.length - 1);
}

export function badKeys(cells: Cell[]): string[] {
  return cells.filter(c => c.verdict !== 'ok').map(c => c.phase + '|' + c.caller + '|' + c.item + '|' + c.path).sort();
}

export function installKeylessEmbeddings(): () => void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'keyless-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
  return () => { __setEmbedTransportForTests(null); resetGateway(); };
}

/**
 * The requester-scope gate gives an unbound token its grace only when it was created in an earlier whole second than
 * access.serves_since (GST-3199: a token minted in the same second the brain starts serving several people is refused
 * instead). That same-second refusal is a bug, not the contract, so every change starts in a later second than the
 * last token minted, read on the database's own clock.
 */
async function pastMintSecond(b: Brain): Promise<void> {
  const second = async (sql: string) => Number((await b.engine.executeRaw(sql))[0]?.s ?? 0);
  const minted = await second('SELECT floor(extract(epoch FROM max(created_at))) AS s FROM access_tokens');
  while (await second('SELECT floor(extract(epoch FROM clock_timestamp())) AS s') <= minted) await Bun.sleep(20);
}

/** Runs one scenario on a fresh brain and returns every cell plus what gbrain reported about the brain afterwards. */
export async function runScenario(s: Scenario, open: EngineFactory, only?: ReadonlySet<ReadPath>): Promise<{ cells: Cell[]; archiveRescope: unknown }> {
  const b = await makeBrain({ ownerSet: s.ownerSet ?? true, otherDisabled: s.otherDisabled }, open);
  try {
    await G.softDeleteSource(b.engine, 'old-project');
    const before = await matrix(b, s.name, 'before', { shared: false, ownerSet: s.ownerSet ?? true, otherEnabled: true }, only);
    await pastMintSecond(b);
    await s.change(b);
    if (s.mintOther && !b.tokens.member_http) await mint(b, 'member_http', OTHER);
    const after = await matrix(b, s.name, 'after', { shared: s.shared, ownerSet: true, otherEnabled: s.otherEnabledAfter ?? true }, only);
    for (const c of ownerLosses(before, after)) c.verdict = 'owner_lost';
    const archiveRescope = await inHome(b, () => G.archiveRescopeSkipped(b.engine)).catch((e: Error) => 'error ' + e.message);
    return { cells: [...before, ...after], archiveRescope };
  } finally {
    await closeBrain(b);
  }
}
