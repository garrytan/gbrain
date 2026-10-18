/**
 * D4 `grant_blocked_operations`: the in-band stale-grant notice on the
 * connection's own authenticated path. Real OAuth grants on PGLite (the
 * verifier's principal, revision and catalog provenance), dispatched the way
 * serve-http resolves a client (effective surface, allow-set = surface ∩
 * snapshot). Counts per blocker, never operation names; once per (principal,
 * session), and once per (principal, grant revision) for stateless calls;
 * nothing widens.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant, rescopeClientGrant, resolveGrantProfile } from '../src/core/grants/service.ts';
import { filterOpsForSurface, minSurface, type McpSurface } from '../src/mcp/surface.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { NoticeLedger } from '../src/core/notice-ledger.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { ERROR_CATALOGUE } from '../src/core/error-catalogue.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  await engine.putPage('notes/grant-example', { title: 'Grant example', type: 'note', compiled_truth: 'A page.\n' });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);

type Rendered = { code: string; why: string; fix?: { argv?: string[]; mcp?: unknown; next: string; then?: { argv?: string[] }; verify?: { argv?: string[] } } };
const noticesOf = (r: { _meta?: Record<string, unknown>; content: Array<{ text: string }>; isError?: boolean }): Rendered[] =>
  r.isError ? JSON.parse(r.content[0].text).notices ?? [] : (r._meta?.gbrain_notices as Rendered[] | undefined) ?? [];
const grantNotice = (r: Parameters<typeof noticesOf>[0]) => noticesOf(r).filter(n => n.code === 'grant_blocked_operations');

async function client(name: string, profile: 'memory-writer' | 'memory-reader', patch: Record<string, unknown> = {}) {
  const created = await provider.registerClientManual(name, ['client_credentials'], profile === 'memory-reader' ? 'read' : 'read write', [], 'default',
    undefined, undefined, undefined, resolveGrantProfile({ profile, sourceId: 'default' }));
  if (Object.keys(patch).length) await rescopeClientGrant(engine, created.clientId, patch, { actor: 'test' });
  return created;
}

/** One HTTP connection as serve-http builds it, sharing one notice ledger across calls (the ServeHttpContext ledger). */
async function connect(created: { clientId: string; clientSecret?: string }, ledger = new NoticeLedger(), ceiling: McpSurface = 'full') {
  const token = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
  const auth = await provider.verifyAccessToken(token.access_token) as unknown as AuthInfo;
  const surface = minSurface(ceiling, (auth.surface as McpSurface | undefined) ?? ceiling);
  auth.effectiveSurface = surface;
  const callable = filterOpsForSurface(operations.filter(o => !o.localOnly), surface)
    .filter(o => auth.allowedOperations == null || auth.allowedOperations.includes(o.name));
  return (sessionId?: string): DispatchOpts => ({
    remote: true, transport: 'http', sourceId: 'default', auth, surface, surfaceCeiling: ceiling, noticeLedger: ledger,
    allowedOps: new Set(callable.map(o => o.name)), config: { engine: 'pglite' } as any, ...(sessionId ? { sessionId } : {}),
  });
}

const read = (opts: DispatchOpts) => dispatchToolCall(engine, 'get_page', { slug: 'notes/grant-example' }, opts);
const dropFromCatalog = (clientId: string, name: string) => engine.executeRaw(
  `UPDATE oauth_grant_audit SET after_grant = jsonb_set(after_grant, '{catalogProvenance,operations}', (after_grant->'catalogProvenance'->'operations') - $2::text)
   WHERE client_id = $1 AND after_grant->'catalogProvenance' IS NOT NULL`, [clientId, name]);

describe('grant_blocked_operations', () => {
  test('registered as an info notice with a catalogue anchor', () => {
    expect(NOTICE_CODES.grant_blocked_operations.kind).toBe('info');
    expect(ERROR_CATALOGUE.grant_blocked_operations.docs).toBe('docs/guides/repair.md#grant-blocked-operations');
  });

  test('a fresh memory-writer gets no notice and can call put_pages', async () => {
    const opts = await connect(await client('fresh-writer-example', 'memory-writer'));
    expect(grantNotice(await read(opts()))).toEqual([]);
    const r = await dispatchToolCall(engine, 'put_pages', { pages: [] }, opts());
    expect(JSON.parse(r.content[0].text).code).not.toBe('unknown_tool');
  });

  test('an operator-pinned old client is reported, not widened: client pin named, preview then apply, nothing changes', async () => {
    const created = await client('pinned-old-example', 'memory-writer', { surface: 'starter', surfaceSetBy: 'operator' });
    const opts = await connect(created);
    const [n] = grantNotice(await read(opts()));
    expect(n.why).toContain('its stored starter tool surface, which the brain owner pinned');
    expect(n.why).not.toContain('operation snapshot');
    expect(n.fix!.next).toBe('tell_user_to_run');
    expect(n.fix!.mcp).toBeUndefined();
    expect(n.fix!.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', created.clientId, '--surface', 'full', '--dry-run']);
    expect(n.fix!.then!.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', created.clientId, '--surface', 'full']);
    expect(n.fix!.verify!.argv).toEqual(['gbrain', 'doctor', '--only', 'grant_new_ops_available', '--json']);
    const after = await readClientGrant(engine, created.clientId);
    expect(after.surface).toBe('starter');
    expect(after.surfaceSetBy).toBe('operator');
  });

  test('blocked by both snapshot and pin: both named, counts only, one command lifting both', async () => {
    const base = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }).allowedOperations!;
    const created = await client('both-example', 'memory-writer', { allowedOperations: base.filter(op => op !== 'put_pages'), surface: 'starter', surfaceSetBy: 'operator' });
    const r = await read((await connect(created))());
    const [n] = grantNotice(r);
    expect(n.why).toContain('its operation snapshot (1)');
    expect(n.why).toContain('its stored starter tool surface');
    expect(n.fix!.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', created.clientId, '--operations', '<OPERATIONS>', '--surface', 'full', '--dry-run']);
    expect(JSON.stringify(noticesOf(r))).not.toContain('put_pages');
  });

  test('a deliberately restricted client stays unable to call put_pages, and the refusal says why', async () => {
    const base = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }).allowedOperations!;
    const created = await client('restricted-example', 'memory-writer', { allowedOperations: base.filter(op => op !== 'put_pages') });
    const opts = await connect(created);
    const r = await dispatchToolCall(engine, 'put_pages', { pages: [] }, opts());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('unknown_tool');
    const [n] = grantNotice(r);
    expect(n.why).toContain('its operation snapshot (1)');
    expect(n.why).toContain('all existed when the snapshot was written');
    expect(JSON.stringify(n)).not.toContain('put_pages');
    expect((await readClientGrant(engine, created.clientId)).allowedOperations).not.toContain('put_pages');
  });

  test('a memory-reader stays unable to call put_pages; the refusal names the missing write scope, a plain read says nothing', async () => {
    const opts = await connect(await client('reader-example', 'memory-reader'));
    expect(grantNotice(await read(opts('reader-session-a')))).toEqual([]);
    const r = await dispatchToolCall(engine, 'put_pages', { pages: [] }, opts('reader-session-a'));
    expect(r.isError).toBe(true);
    const [n] = grantNotice(r);
    expect(n.why).toContain('This grant has no write scope');
    expect(n.fix).toBeUndefined();
  });

  test('legacy grant (no catalog provenance): "original intent unknown"; post-D4 grant: "predates"', async () => {
    const base = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }).allowedOperations!;
    const legacy = await client('legacy-wording-example', 'memory-writer', { allowedOperations: base.filter(op => op !== 'put_pages') });
    await engine.executeRaw("UPDATE oauth_grant_audit SET after_grant = after_grant - 'catalogProvenance' WHERE client_id = $1", [legacy.clientId]);
    const [l] = grantNotice(await read((await connect(legacy))()));
    expect(l.why).toContain("This grant's snapshot excludes 1 currently eligible operation; original intent unknown.");
    expect(l.why).not.toContain('predates');

    const recent = await client('predates-wording-example', 'memory-writer', { allowedOperations: base.filter(op => op !== 'put_pages') });
    await dropFromCatalog(recent.clientId, 'put_pages');
    const [p] = grantNotice(await read((await connect(recent))()));
    expect(p.why).toContain('This grant predates 1 currently eligible operation');
    expect(p.why).not.toContain('original intent unknown');
  });

  test('a writer grant against a catalog with a new admin-only operation reports nothing (count 0)', async () => {
    const created = await client('admin-op-example', 'memory-writer');
    const adminOp = operations.find(op => !op.localOnly && op.scope === 'admin')!.name;
    await dropFromCatalog(created.clientId, adminOp);
    const opts = await connect(created);
    expect(grantNotice(await read(opts()))).toEqual([]);
    const refused = await dispatchToolCall(engine, adminOp, {}, opts());
    expect(refused.isError).toBe(true);
    expect(grantNotice(refused)).toEqual([]);
  });

  test('three stateless HTTP calls by one principal: exactly one notice; a rescope (new revision) is diagnosed afresh', async () => {
    const created = await client('stateless-example', 'memory-writer', { surface: 'starter', surfaceSetBy: 'operator' });
    const ledger = new NoticeLedger();
    let total = 0;
    for (let i = 0; i < 3; i++) total += grantNotice(await read((await connect(created, ledger))())).length;
    expect(total).toBe(1);
    const base = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }).allowedOperations!;
    await rescopeClientGrant(engine, created.clientId, { allowedOperations: base.filter(op => op !== 'put_pages') }, { actor: 'test' });
    let after = 0;
    for (let i = 0; i < 3; i++) after += grantNotice(await read((await connect(created, ledger))())).length;
    expect(after).toBe(1);
  });

  test('sessioned calls: one notice per (principal, session)', async () => {
    const created = await client('sessioned-example', 'memory-writer', { surface: 'starter', surfaceSetBy: 'operator' });
    const opts = await connect(created);
    const counts = [];
    for (const session of ['s1', 's1', 's2', 's1', 's2']) counts.push(grantNotice(await read(opts(session))).length);
    expect(counts).toEqual([1, 0, 1, 0, 0]);
  });

  test('a server ceiling alone: named, and the fix is the read-only doctor check (no grant change lifts it)', async () => {
    const created = await client('ceiling-example', 'memory-writer');
    const r = await read((await connect(created, new NoticeLedger(), 'starter'))());
    const [n] = grantNotice(r);
    expect(n.why).toContain("the server's starter tool surface");
    expect(n.fix!.next).toBe('tell_user_to_run');
    expect(n.fix!.argv!.slice(0, 5)).toEqual(['gbrain', 'doctor', '--only', 'grant_new_ops_available', '--json']);
    expect(n.fix!.then).toBeUndefined();
  });

  test('stdio and the local CLI never get it (no verified principal)', async () => {
    const r = await dispatchToolCall(engine, 'get_page', { slug: 'notes/grant-example' }, { remote: true, transport: 'stdio', sourceId: 'default', noticeLedger: new NoticeLedger() });
    expect(grantNotice(r)).toEqual([]);
  });
});
