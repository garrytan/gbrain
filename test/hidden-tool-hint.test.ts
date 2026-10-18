/**
 * F6 hidden-tool hint (src/mcp/hidden-tool-hint.ts): on the owner's stdio
 * pipe a real tool outside the session's surface names itself; the fix is
 * one `request_tools {surface:'full'}` call (`next: run`) where request_tools
 * is callable and session widening is on, else the CLI equivalent relayed to
 * the user with the persistent routes (`tell_user_to_run`). Read-only access
 * never offers a widen; HTTP stays opaque.
 *
 * D2 reuses the same route (`hiddenToolRoute`) on every transport for
 * content a hidden tool serves: the hidden-takes scenario runs through the
 * installed configurations below, and every `next` a notice emits must be
 * callable on that connection (and, where it is an MCP call, succeed).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { allowedOpNames, createStdioSurfaceState, filterOpsForSurface, isReadOnlyOperation, stdioToolListing, type McpSurface } from '../src/mcp/surface.ts';
import { hiddenToolHint, hiddenToolRoute } from '../src/mcp/hidden-tool-hint.ts';
import { dispatchRenderContext, dispatchToolCall, toolConnection, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { renderAction } from '../src/core/agent-output.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { NoticeLedger } from '../src/core/notice-ledger.ts';
import { withEnv } from './helpers/with-env.ts';
import { resolveGrantProfile } from '../src/core/grants/profiles.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const starter = allowedOpNames(operations, 'starter');
const verbs = allowedOpNames(operations, 'verbs');
const readOnly = new Set(operations.filter(o => starter.has(o.name) && isReadOnlyOperation(o)).map(o => o.name));
const stdio = (allowedOps: ReadonlySet<string>, surface: 'verbs' | 'starter') => ({ transport: 'stdio' as const, remote: true, surface, allowedOps });
const rendered = (opts: ReturnType<typeof stdio>, canWiden: boolean) => {
  const hint = hiddenToolHint(op('get_health'), opts, canWiden)!;
  return { hint, fix: renderAction(hint.fix, dispatchRenderContext({ ...opts, sourceId: 'default' })) };
};

describe('hidden-tool hint', () => {
  test('a widenable starter session: the fix is the request_tools call, next run, CLI equivalent kept as argv', () => {
    const { hint, fix } = rendered(stdio(starter, 'starter'), true);
    expect(fix.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
    expect(fix.next).toBe('run');
    expect(fix.consent).toEqual([]);
    expect(fix.argv?.slice(0, 3)).toEqual(['gbrain', 'doctor', '--json']);
    expect(hint.fix.why).toContain('GBRAIN_SURFACE=full');
    expect(hint.fix.why).toContain('An inherited GBRAIN_SURFACE overrides a pinned --surface');
    expect(hint.fix.why).toContain('claude mcp add gbrain -e GBRAIN_SURFACE=full');
  });

  test('verbs (request_tools absent) or widening off: the persistent route, relayed to the user', () => {
    for (const [opts, canWiden] of [[stdio(verbs, 'verbs'), false], [stdio(starter, 'starter'), false]] as const) {
      const { hint, fix } = rendered(opts, canWiden);
      expect(fix.mcp).toBeUndefined();
      expect(fix.next).toBe('tell_user_to_run');
      expect(fix.user_message).toContain('GBRAIN_SURFACE=full');
      expect(hint.suggestion).toContain('cannot widen it');
    }
  });

  test('read-only access names the CLI equivalent and never offers a widen', () => {
    const opts = { transport: 'stdio' as const, remote: true, surface: 'full' as const, allowedOps: readOnly };
    const hint = hiddenToolHint(op('put_page'), opts, true)!;
    expect(hint.fix.mcp).toBeUndefined();
    expect(hint.fix.why).toContain('this connection stays read-only');
  });

  test('read-only access at starter never offers a widen for a write tool (the widened session still could not call it)', () => {
    const roStarter = new Set([...starter].filter(name => isReadOnlyOperation(op(name))));
    const hint = hiddenToolHint(op('put_pages'), { transport: 'stdio', remote: true, surface: 'starter', allowedOps: roStarter, readOnly: true }, true)!;
    expect(hint.fix.mcp).toBeUndefined();
    expect(hint.fix.why).toContain('this connection stays read-only');
  });

  test('GBRAIN_MCP_FORCE_SURFACE=starter: no widen past the clamp', async () => {
    await withEnv({ GBRAIN_MCP_FORCE_SURFACE: 'starter' }, () => {
      const { hint, fix } = rendered(stdio(starter, 'starter'), true);
      expect(fix.mcp).toBeUndefined();
      expect(hint.suggestion).toContain('cannot widen it');
    });
  });

  test('HTTP, the local CLI and visible tools get no hint', () => {
    expect(hiddenToolHint(op('get_health'), { transport: 'http', remote: true, surface: 'starter', allowedOps: starter }, true)).toBeNull();
    expect(hiddenToolHint(op('get_health'), { transport: 'stdio', remote: false, surface: 'starter', allowedOps: starter }, true)).toBeNull();
    expect(hiddenToolHint(op('search'), stdio(starter, 'starter'), true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D2: the hidden-takes scenario through installed configurations. A page with
// world takes is read with get_page (which never shows the takes table); the
// result's `hidden_tool_content` notice must offer a next step this
// connection can take, and every MCP call it names must dispatch and work.
// ---------------------------------------------------------------------------

describe('D2 hidden-takes scenario, installed configurations', () => {
  const SLUG = 'companies/acme-example';
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const page = await engine.putPage(SLUG, { title: 'Acme', type: 'company', compiled_truth: 'Acme sells widgets.\n' });
    await engine.addTakesBatch([
      { page_id: page.id, row_num: 1, claim: 'Renewal ARR forecast 1.2M', kind: 'take', holder: 'world', weight: 0.8 },
      { page_id: page.id, row_num: 2, claim: 'Private hunch about churn', kind: 'hunch', holder: 'brain', weight: 0.3 },
    ]);
  }, 60_000);
  afterAll(async () => { await engine?.disconnect(); }, 15_000);

  type Notices = Array<{ code: string; why: string; fix?: { mcp?: { tool: string; arguments: Record<string, unknown> }; next: string; argv?: string[]; then?: unknown } }>;
  const noticesOf = (r: { _meta?: Record<string, unknown>; content: Array<{ text: string }>; isError?: boolean }): Notices =>
    r.isError ? JSON.parse(r.content[0].text).notices ?? [] : (r._meta?.gbrain_notices as Notices | undefined) ?? [];
  const hiddenNotice = (r: Parameters<typeof noticesOf>[0]) => noticesOf(r).find(n => n.code === 'hidden_tool_content');

  /** A stdio server as `gbrain serve` builds it: one session surface, a listing over the advertised surface, a reveal hook. */
  function stdioConnection(opts: { surface: McpSurface; advertised?: McpSurface | null; readOnly?: boolean; widenAllowed?: boolean }) {
    const reveals: string[][] = [];
    const listChanged = { count: 0 };
    const session = createStdioSurfaceState(operations, { surface: opts.surface, source: 'flag', readOnly: opts.readOnly ?? false });
    session.widenAllowed = opts.widenAllowed ?? true;
    const listing = stdioToolListing(async () => opts.advertised ?? null, session, { sendToolListChanged: async () => { listChanged.count++; } });
    const dispatchOpts = (): DispatchOpts => ({
      remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'],
      ...(session.allowedOps ? { allowedOps: session.allowedOps } : {}), surface: session.surface, surfaceCeiling: session.surface,
      stdioSurface: session, revealTools: names => { reveals.push(names); listing.reveal(names); }, isListed: listing.isListed,
      noticeLedger: new NoticeLedger(),
    });
    return { session, listing, reveals, listChanged, dispatchOpts };
  }

  /** Every MCP call a notice names must pass dispatch's callability gate (never unknown_tool) and succeed. */
  async function assertNextCallable(n: Notices[number] | undefined, opts: () => DispatchOpts): Promise<string | null> {
    if (!n?.fix?.mcp) return null;
    expect(dispatchRenderContext(opts()).isCallable(n.fix.mcp.tool)).toBe(true);
    const r = await dispatchToolCall(engine, n.fix.mcp.tool, n.fix.mcp.arguments, opts());
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    return n.fix.mcp.tool;
  }

  async function takesVisibleBy(opts: () => DispatchOpts): Promise<string[]> {
    const r = await dispatchToolCall(engine, 'takes_list', { page_slug: SLUG }, opts());
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    return (JSON.parse(r.content[0].text) as Array<{ claim: string }>).map(t => t.claim);
  }

  test('callable starter (stdio --surface starter): next is request_tools {surface:"full"}; after it takes_list works', async () => {
    const c = stdioConnection({ surface: 'starter' });
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))!;
    expect(n.why).toContain('leaves out 1 take');
    expect(n.why).not.toContain('Private hunch');
    expect(n.fix!.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
    expect(n.fix!.next).toBe('run');
    expect(await assertNextCallable(n, c.dispatchOpts)).toBe('request_tools');
    expect(await takesVisibleBy(c.dispatchOpts)).toEqual(['Renewal ARR forecast 1.2M']);
  });

  test('callable full, advertised starter: next is the takes_list call itself, stdio lists it (tools/list_changed)', async () => {
    const c = stdioConnection({ surface: 'full', advertised: 'starter' });
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))!;
    expect(n.fix!.mcp).toEqual({ tool: 'takes_list', arguments: { page_slug: SLUG } });
    expect(n.fix!.next).toBe('run');
    expect(c.reveals).toEqual([['takes_list']]);
    expect(c.listChanged.count).toBe(1);
    expect(await assertNextCallable(n, c.dispatchOpts)).toBe('takes_list');
    expect(hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))).toBeUndefined();
  });

  test('a client that ignores tools/list_changed still calls the named tool by name', async () => {
    const c = stdioConnection({ surface: 'full', advertised: 'starter' });
    c.listing.reveal = () => {};
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))!;
    expect(c.listChanged.count).toBe(0);
    expect(await assertNextCallable(n, c.dispatchOpts)).toBe('takes_list');
    const widen = stdioConnection({ surface: 'starter' });
    const w = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, widen.dispatchOpts()))!;
    expect(await assertNextCallable(w, widen.dispatchOpts)).toBe('request_tools');
    expect(await takesVisibleBy(widen.dispatchOpts)).toEqual(['Renewal ARR forecast 1.2M']);
  });

  test('full (callable and advertised): takes_list is listed, so no notice', async () => {
    const c = stdioConnection({ surface: 'full' });
    expect(hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))).toBeUndefined();
  });

  test('verbs: get_page and request_tools are outside it, so nothing is read and no tool is named', async () => {
    const c = stdioConnection({ surface: 'verbs' });
    expect(c.session.allowedOps!.has('get_page')).toBe(false);
    expect(dispatchRenderContext(c.dispatchOpts()).isCallable('request_tools')).toBe(false);
    const r = await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts());
    expect(r.isError).toBe(true);
    expect(hiddenNotice(r)).toBeUndefined();
    expect(hiddenToolRoute(op('takes_list'), toolConnection(c.dispatchOpts()))).toEqual({ kind: 'host', blocker: 'surface' });
  });

  test('verbs read: search on verbs never names a tool verbs cannot call', async () => {
    const c = stdioConnection({ surface: 'verbs' });
    for (const tool of ['search', 'query', 'get_page']) {
      const r = await dispatchToolCall(engine, tool, tool === 'get_page' ? { slug: SLUG } : { query: 'Acme widgets' }, c.dispatchOpts());
      for (const n of noticesOf(r)) if (n.fix?.mcp) expect(dispatchRenderContext(c.dispatchOpts()).isCallable(n.fix.mcp.tool)).toBe(true);
    }
  });

  test('read-only stdio grant (--access read-only): request_tools is not callable there, so the CLI equivalent, never a widen', async () => {
    const c = stdioConnection({ surface: 'starter', readOnly: true });
    expect(dispatchRenderContext(c.dispatchOpts()).isCallable('request_tools')).toBe(false);
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))!;
    expect(n.fix!.mcp).toBeUndefined();
    expect(n.fix!.next).toBe('tell_user_to_run');
    expect(n.fix!.argv!.slice(0, 4)).toEqual(['gbrain', 'takes-list', '--page-slug', SLUG]);
    const full = stdioConnection({ surface: 'full', readOnly: true });
    expect(hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, full.dispatchOpts()))).toBeUndefined();
    expect(await takesVisibleBy(full.dispatchOpts)).toEqual(['Renewal ARR forecast 1.2M']);
  });

  test('session widening off: the CLI equivalent, never request_tools', async () => {
    const c = stdioConnection({ surface: 'starter', widenAllowed: false });
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, c.dispatchOpts()))!;
    expect(n.fix!.mcp).toBeUndefined();
    expect(n.fix!.next).toBe('tell_user_to_run');
  });

  /** An OAuth client as serve-http resolves it: effective surface, allow-set from surface ∩ snapshot. */
  function httpOpts(auth: Partial<AuthInfo>, ceiling: McpSurface = 'full'): () => DispatchOpts {
    const ledger = new NoticeLedger();
    const snapshot = auth.allowedOperations ?? null;
    const surface = (auth.surface && ['verbs', 'starter', 'full'].includes(auth.surface) ? auth.surface : ceiling) as McpSurface;
    const callable = filterOpsForSurface(operations.filter(o => !o.localOnly), surface).filter(o => !snapshot || snapshot.includes(o.name));
    const full: AuthInfo = { token: 't', clientId: 'gbrain_cl_hidden_example', clientName: 'hidden-example', scopes: ['read'], expiresAt: 1,
      principal: { kind: 'oauth_client', id: 'gbrain_cl_hidden_example' }, sourceId: 'default', allowedSources: ['default'], grantRevision: 3,
      effectiveSurface: surface, ...auth } as AuthInfo;
    return () => ({ remote: true, transport: 'http', sourceId: 'default', takesHoldersAllowList: ['world'], auth: full, surface, surfaceCeiling: ceiling,
      allowedOps: new Set(callable.map(o => o.name)), noticeLedger: ledger, config: { engine: 'pglite' } as any });
  }
  const readerSnapshot = () => resolveGrantProfile({ profile: 'memory-reader', sourceId: 'default' }).allowedOperations!;

  test('pinned HTTP client (operator pinned starter): the owner\'s repair, relayed; no MCP call', async () => {
    const opts = httpOpts({ surface: 'starter', surfaceSetBy: 'operator', allowedOperations: readerSnapshot() });
    expect(toolConnection(opts()).canWiden).toBe(false);
    const r = await dispatchToolCall(engine, 'get_page', { slug: SLUG }, opts());
    const n = hiddenNotice(r)!;
    expect(n.fix!.mcp).toBeUndefined();
    expect(n.fix!.next).toBe('tell_user_to_run');
    expect(n.fix!.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'gbrain_cl_hidden_example', '--surface', 'full', '--dry-run']);
    const grant = noticesOf(r).find(x => x.code === 'grant_blocked_operations')!;
    expect(grant.why).toContain('which the brain owner pinned');
    expect(grant.fix!.next).toBe('tell_user_to_run');
    for (const x of noticesOf(r)) expect(x.fix?.mcp).toBeUndefined();
  });

  test('unpinned HTTP client on starter: next is request_tools {surface:"full"}, callable on that connection', async () => {
    const opts = httpOpts({ surface: 'starter', surfaceSetBy: 'self', allowedOperations: readerSnapshot() });
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, opts()))!;
    expect(n.fix!.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
    expect(dispatchRenderContext(opts()).isCallable('request_tools')).toBe(true);
    const r = await dispatchToolCall(engine, 'request_tools', { surface: 'full', dry_run: true }, opts());
    expect(r.isError, r.content[0].text).toBeFalsy();
  });

  test('HTTP server ceiling starter: no widen past the ceiling, no MCP call', async () => {
    const opts = httpOpts({ surface: null as any, allowedOperations: null }, 'starter');
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, opts()))!;
    expect(n.fix?.mcp).toBeUndefined();
  });

  test('a snapshot that excludes takes_list: never request_tools (the widened surface still could not call it)', async () => {
    const opts = httpOpts({ surface: 'starter', surfaceSetBy: 'self', allowedOperations: readerSnapshot().filter(n => n !== 'takes_list') });
    expect(hiddenToolRoute(op('takes_list'), toolConnection(opts()))).toEqual({ kind: 'host', blocker: 'grant' });
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, opts()))!;
    expect(n.fix?.mcp).toBeUndefined();
    expect(n.fix!.next).toBe('tell_user_to_run');
  });

  test('HTTP callable but advertised starter (P8 arm): the takes_list call, no reveal on HTTP', async () => {
    const base = httpOpts({ surface: null as any, allowedOperations: null });
    const opts = () => ({ ...base(), isListed: async () => false });
    const n = hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, opts()))!;
    expect(await assertNextCallable(n, opts)).toBe('takes_list');
  });

  test('a holder allow-list without world: nothing visible is hidden, so no notice', async () => {
    const c = stdioConnection({ surface: 'starter' });
    const opts = () => ({ ...c.dispatchOpts(), takesHoldersAllowList: ['nobody-example'] });
    expect(hiddenNotice(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, opts()))).toBeUndefined();
  });

  test('search and query name the result\'s take-bearing page', async () => {
    const c = stdioConnection({ surface: 'starter' });
    for (const tool of ['search', 'query']) {
      const r = await dispatchToolCall(engine, tool, { query: 'Acme widgets' }, c.dispatchOpts());
      const rows = JSON.parse(r.content[0].text);
      if (!Array.isArray(rows) || !rows.some((row: { slug?: string }) => row.slug === SLUG)) continue;
      const n = hiddenNotice(r)!;
      expect(n.why).toContain(SLUG);
      expect(n.fix!.mcp!.tool).toBe('request_tools');
    }
  });
});
