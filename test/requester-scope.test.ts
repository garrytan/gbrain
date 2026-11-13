/**
 * GST-363 (PR 2): a brain that serves several people refuses remote reads from a connection bound to nobody.
 *
 * 1. Protects: on a brain with two or more enabled members (or config access.serves = several), every remote read op
 *    from a credential or stdio server bound to no member is refused with requester_scope_required before its handler
 *    runs; a connection that existed when the brain started serving several people reads for 14 days with an in-band
 *    notice (_meta.access.requester_scope) first; member-bound, audience-naming and attested calls, and credentials
 *    the operator marked --reads-unscoped, read as before; a one-person brain with several sources sees nothing new;
 *    hosted brains (access.requester_scope_enforce = false) get the notice and no refusal; agent jobs get the same
 *    gate; creating an unbound credential on such a brain is refused with credential_scope_required.
 * 2. Fails when: a read op answers an unbound key after the grace, a new read op is neither refused nor exempted, the
 *    grace notice or the refusal loses its fix or date, a bound key or an attested call is refused, the one-person
 *    brain gets a notice, the hosted switch still refuses a DCR client, or the trigger restarts the grace.
 * 3. Existing coverage: setup-serves-several.test.ts (labelling, brainServes), access-qm-actor.test.ts (attested
 *    calls), access-on-behalf-of.test.ts (audiences), member-read-access.test.ts (bound reads).
 * 4. Real seams: legacy tokens through the serve --http legacy transport over a real socket (startHttpTransport) and
 *    the OAuth verifier; dispatchToolCall remote=true over stdio; the v309 trigger on PGLite (repo-less and a repo
 *    brain) and Postgres when DATABASE_URL is set; `bun src/cli.ts auth` spawned against a temp GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { addMember, bindCredential, disableMember, enableMember } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { readAudienceAssertions } from '../src/core/access/audience.ts';
import { brainServes } from '../src/core/access/serves.ts';
import { assertCredentialScoped, OWN_JOB_OPS, printUnscopedReadsUpgradeNotice, REQUESTER_SCOPE_EXEMPT, requiresRequesterScope, readReadsUnscopedChanges } from '../src/core/access/requester-scope.ts';
import { unscopedSharedReadsEntry } from '../src/commands/doctor/checks/unscoped-shared-reads.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { takeBindingFlags } from '../src/commands/auth-binding.ts';
import { ownerLines } from '../src/commands/access.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { CODES } from '../src/core/error-registry.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAGES: Record<string, string> = { 'notes/harbor-alpha': 'canaryalpha', 'notes/harbor-beta': 'canarybeta' };
const pageText = (slug: string, canary: string) => `---\ntype: note\ntitle: ${slug}\n---\n# ${slug}\n\nHarbor ledger notes ${canary}.\n`;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/**
 * Every read operation's requester-scope class, reviewed by hand: a new read op fails this list until someone decides
 * whether an unbound connection on a several-people brain may call it (add it to REQUESTER_SCOPE_EXEMPT) or not.
 */
const REVIEWED_EXEMPT = ['get_brain_identity', 'get_health', 'get_status_snapshot', 'join_brain', 'leave_brain', 'request_tools', 'search_modes', 'sync_brain_skills', 'whoami'];

type Call = { isError: boolean; text: string; json: Record<string, any>; meta: Record<string, any> | undefined; structured: Record<string, any> | undefined };
function shape(out: ToolResult): Call {
  const text = out.content.map(c => c.text).join('\n');
  let json: Record<string, any> = {};
  try { json = JSON.parse(out.content[0]?.text ?? ''); } catch { /* prose */ }
  return { isError: out.isError === true, text, json, meta: out._meta as Record<string, any> | undefined, structured: out.structuredContent as Record<string, any> | undefined };
}

describe('requiresRequesterScope: every read op is classified (deny by default)', () => {
  test('every remote op declares mutating, and the exempt list is exactly the reviewed one', () => {
    expect(operations.filter(op => op.mutating === undefined).map(op => op.name)).toEqual([]);
    expect([...REQUESTER_SCOPE_EXEMPT].sort()).toEqual(REVIEWED_EXEMPT);
    expect([...OWN_JOB_OPS].sort()).toEqual(['get_job', 'wait_job']);
    for (const op of operations) {
      const expected = (op.mutating === false || (op.scope ?? 'read') === 'read') && !REVIEWED_EXEMPT.includes(op.name);
      expect({ op: op.name, gated: requiresRequesterScope(op, { scopes: ['read', 'write', 'admin'] }) }).toEqual({ op: op.name, gated: expected });
    }
    expect(requiresRequesterScope({ name: 'brand_new_read', mutating: undefined })).toBe(true);
    expect(requiresRequesterScope(operations.find(op => op.name === 'think'))).toBe(true);
    expect(requiresRequesterScope({ name: 'brand_new_read_scope_write', mutating: true, scope: 'read' })).toBe(true);
    expect(requiresRequesterScope({ name: 'brand_new_mutating_no_scope', mutating: true })).toBe(true);
    expect(requiresRequesterScope({ name: 'get_job', mutating: false }, { scopes: ['read'] })).toBe(false);
    expect(requiresRequesterScope({ name: 'get_job', mutating: false }, { scopes: ['admin'] })).toBe(true);
    expect(requiresRequesterScope({ name: 'get_job', mutating: false })).toBe(true);
  });
});

for (const kind of testBackends()) {
  describe(`refusing unscoped reads (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let server: Awaited<ReturnType<typeof startHttpTransport>>;
    const provider = (dcr = false) => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))), ...(dcr ? { allowClientCredentialsDcr: true } : {}) });
    const keys: Record<string, { id: string; token: string }> = {};
    const mint = async (name: string, member?: string) => {
      const m = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'] });
      if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member });
      keys[name] = { id: m.id, token: m.token };
    };
    const backdate = (name: string, daysAgo: number) => engine.executeRaw('UPDATE access_tokens SET created_at = $2::timestamptz WHERE id::text = $1', [keys[name]!.id, iso(Date.now() - daysAgo * DAY)]);
    const setSince = (daysAgo: number) => engine.setConfig('access.serves_since', iso(Date.now() - daysAgo * DAY));

    /** One tools/call over a real socket to the serve --http legacy transport. */
    async function http(name: string, tool: string, args: Record<string, unknown>): Promise<Call> {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${keys[name]!.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      });
      return shape((await res.json() as { result: ToolResult }).result);
    }
    const search = (name: string) => http(name, 'search', { query: 'harbor ledger notes', match: 'keyword', limit: 10 });
    const stdio = async (tool: string, args: Record<string, unknown>) => shape(await dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'] }));
    const oauthCall = async (bearer: string, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const auth = await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
      return shape(await dispatchToolCall(engine, tool, args, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], ...extra }));
    };
    function refused(out: Call, reason: string) {
      expect({ isError: out.isError, code: out.json.code, reason: out.json.reason }).toEqual({ isError: true, code: 'requester_scope_required', reason });
      expect(out.structured?.error).toMatchObject({ code: 'requester_scope_required', reason });
      expect(out.structured?.error.fix).toMatchObject({ next: expect.any(String), argv: expect.arrayContaining(['--member', '<MEMBER>']) });
      for (const canary of Object.values(PAGES)) expect(out.text).not.toContain(canary);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      __resetPrivateVisibilityCacheForTests();
      for (const [slug, canary] of Object.entries(PAGES)) await importFromContent(engine, slug, pageText(slug, canary), { sourceId: 'default', noEmbed: true });
      await addMember(engine, 'alice-example');
      await mint('old-unbound');
      await mint('alice-key', 'alice-example');
      server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
    }, 240_000);
    afterAll(async () => { await server?.stop?.(true); await close?.(); }, 60_000);

    test('one member: nothing changes, no notice, and the brain has no several-people date', async () => {
      const out = await search('old-unbound');
      expect(out.isError).toBe(false);
      expect(out.text).toContain('canaryalpha');
      expect(out.meta?.access?.requester_scope).toBeUndefined();
      expect(await engine.getConfig('access.serves_derived')).toBeNull();
      expect(await engine.getConfig('access.serves_since')).toBeNull();
    }, 60_000);

    test('the second member sets the flag and the date once; disabling and re-enabling keeps the date', async () => {
      await addMember(engine, 'bob-example');
      expect(await engine.getConfig('access.serves_derived')).toBe('several');
      const since = await engine.getConfig('access.serves_since');
      expect(since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect((await brainServes(engine))).toMatchObject({ serves: 'several', from: 'members', since });
      await disableMember(engine, 'bob-example');
      expect(await engine.getConfig('access.serves_derived')).toBe('one');
      await enableMember(engine, 'bob-example');
      expect(await engine.getConfig('access.serves_derived')).toBe('several');
      expect(await engine.getConfig('access.serves_since')).toBe(since);
      for (const pinned of ['one', ' One ']) {
        await engine.setConfig('access.serves', pinned);
        expect({ pinned, serves: (await brainServes(engine)).serves }).toEqual({ pinned, serves: 'one' });
        expect((await search('old-unbound')).meta?.access?.requester_scope).toBeUndefined();
      }
      await engine.unsetConfig('access.serves');
    }, 60_000);

    test('the derived key unset or set to one by hand on a brain that serves several people is derived again at once', async () => {
      expect(await engine.getConfig('access.serves_derived')).toBe('several');
      await engine.unsetConfig('access.serves_derived');
      expect(await engine.getConfig('access.serves_derived')).toBe('several');
      await engine.setConfig('access.serves_derived', 'one');
      expect(await engine.getConfig('access.serves_derived')).toBe('several');
      expect((await brainServes(engine)).serves).toBe('several');
    }, 60_000);

    test('over HTTP, an old unbound key inside the grace reads with a notice naming the fix and the date', async () => {
      await setSince(1);
      await backdate('old-unbound', 2);
      const out = await search('old-unbound');
      expect(out.isError).toBe(false);
      expect(out.text).toContain('canaryalpha');
      const notice = out.meta?.access?.requester_scope;
      expect(notice).toMatchObject({ state: 'grace', connection: 'token old-unbound' });
      expect(Date.parse(notice.refuses_at)).toBe(Date.parse(await engine.getConfig('access.serves_since') as string) + 14 * DAY);
      expect(notice.fix).toMatchObject({ argv: ['gbrain', 'auth', 'rescope', '--token', 'old-unbound', '--member', '<MEMBER>'], next: expect.any(String), verify: { argv: ['gbrain', 'access', 'check', '--token', 'old-unbound'] } });
      expect(notice.message).toContain('--reads-unscoped --yes');
    }, 60_000);

    /**
     * The request's config reads fail (a statement timeout under load): the whole-table snapshot and the policy read that
     * names the serves keys. With `reread` the gate's one re-read of the serves keys fails too.
     */
    async function withConfigReadsFailing<T>(reread: boolean, fn: () => Promise<T>): Promise<T> {
      const target = engine as unknown as Record<string, unknown>;
      const own = { executeRaw: Object.getOwnPropertyDescriptor(engine, 'executeRaw'), getAllConfig: Object.getOwnPropertyDescriptor(engine, 'getAllConfig') };
      const realRaw = engine.executeRaw.bind(engine);
      const timeout = () => Promise.reject(new Error('canceling statement due to statement timeout'));
      target.getAllConfig = timeout;
      target.executeRaw = (sql: string, params?: unknown[]) => {
        const keys = params?.[0];
        const servesRead = /FROM config WHERE key/.test(sql) && Array.isArray(keys) && keys.includes('access.serves');
        if (servesRead && (reread || keys.includes('search.remote_private_pages'))) return timeout();
        return realRaw(sql, params as never);
      };
      try { return await fn(); } finally {
        for (const [k, d] of Object.entries(own)) if (d) Object.defineProperty(engine, k, d); else delete target[k];
      }
    }

    test('an unreadable serves policy is read again: an unbound key in its grace still gets the notice', async () => {
      await engine.setConfig('access.serves', 'several');
      await setSince(1);
      await backdate('old-unbound', 2);
      try {
        const out = await withConfigReadsFailing(false, () => search('old-unbound'));
        expect(out.isError).toBe(false);
        expect(out.meta?.access?.requester_scope).toMatchObject({ state: 'grace', connection: 'token old-unbound' });
      } finally { await engine.unsetConfig('access.serves'); }
    }, 60_000);

    test('when the re-read fails too, the unbound read is refused as retryable and nothing is read', async () => {
      await engine.setConfig('access.serves', 'several');
      try {
        const out = await withConfigReadsFailing(true, () => search('old-unbound'));
        expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: 'requester_scope_unknown' });
        expect(out.structured?.error).toMatchObject({ code: 'requester_scope_unknown', fix: { next: 'wait' } });
        expect(out.json.message).not.toContain('serves several');
        for (const canary of Object.values(PAGES)) expect(out.text).not.toContain(canary);
        expect((await withConfigReadsFailing(true, () => search('alice-key'))).isError).toBe(false);
      } finally { await engine.unsetConfig('access.serves'); }
    }, 60_000);

    test('N2: on a brain pinned one, a double config-read failure is a wait-and-retry for an unbound read, saying the settings could not be read; bound callers read', async () => {
      await engine.setConfig('access.serves', 'one');
      try {
        const out = await withConfigReadsFailing(true, () => search('old-unbound'));
        expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: 'requester_scope_unknown' });
        const err = out.structured?.error;
        expect(err).toMatchObject({ code: 'requester_scope_unknown', detail: 'retry_after_ms=2000',
          fix: { next: 'wait', actor: 'provider', argv: ['gbrain', 'doctor', '--json'], consent: [], verify: { argv: ['gbrain', 'access', 'serves', '--json'] } } });
        expect({ retryable: out.json.retryable, class: out.json.class }).toEqual({ retryable: true, class: 'retryable' });
        expect(err.fix.why).toContain('retry_after_ms=2000');
        expect(CODES.requester_scope_unknown.why).toContain('config read');
        expect(out.json.message).toContain("settings could not be read");
        expect(out.json.message).toContain('not an access decision');
        expect(out.json.message).not.toMatch(/denied|bound to nobody|serves several/i);
        for (const canary of Object.values(PAGES)) expect(out.text).not.toContain(canary);
        const bound = await withConfigReadsFailing(true, () => search('alice-key'));
        expect(bound.isError).toBe(false);
        expect(bound.meta?.access?.requester_scope).toBeUndefined();
      } finally { await engine.unsetConfig('access.serves'); }
    }, 60_000);

    test('on a one-person brain, a failed first read and a good re-read run the call with no notice', async () => {
      await engine.setConfig('access.serves', 'one');
      try {
        const out = await withConfigReadsFailing(false, () => search('old-unbound'));
        expect(out.isError).toBe(false);
        expect(out.text).toContain('canaryalpha');
        expect(out.meta?.access?.requester_scope).toBeUndefined();
      } finally { await engine.unsetConfig('access.serves'); }
    }, 60_000);

    test('over HTTP, the same key after the grace is refused with the structured code, and the audit line records it', async () => {
      await setSince(15);
      await backdate('old-unbound', 16);
      const out = await search('old-unbound');
      refused(out, 'grace_ended');
      expect(out.json.message).toContain('token old-unbound');
      expect(out.json.message).toContain('two or more enabled members');
      const audit = readAudienceAssertions().filter(e => e.outcome === 'requester_scope_required' && e.op === 'search');
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toContain(keys['old-unbound']!.token);
    }, 60_000);

    test('a refused unbound connection gets no hot memory on the ops the gate lets through (exempt reads, writes); a bound one still does', async () => {
      await setSince(15);
      const fact = await dispatchToolCall(engine, 'remember', { fact: 'Harbor ledger notes canaryhotfact', provenance: 'fixture' }, { remote: false, sourceId: 'default' });
      expect(fact.isError).toBeFalsy();
      const hot = async (tool: string, args: Record<string, unknown>, stdioMember?: string) => {
        const out = await dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'],
          metaHook: getBrainHotMemoryMeta, sessionId: `hot-${tool}-${stdioMember ?? 'unbound'}`, ...(stdioMember ? { stdioMember } : {}) });
        return { isError: out.isError === true, all: JSON.stringify(out) };
      };
      expect((await stdio('search', { query: 'harbor ledger notes', match: 'keyword', limit: 10 })).json).toMatchObject({ code: 'requester_scope_required', reason: 'grace_ended' });
      for (const tool of ['whoami', 'get_brain_identity', 'search_modes']) {
        const out = await hot(tool, {});
        expect({ tool, isError: out.isError, leaked: out.all.includes('canaryhotfact') }).toEqual({ tool, isError: false, leaked: false });
      }
      const write = await hot('remember', { fact: 'Harbor ledger notes canaryhotwrite', provenance: 'fixture' });
      expect(write.all.includes('canaryhotfact')).toBe(false);
      const bound = await hot('whoami', {}, 'alice-example');
      expect({ isError: bound.isError, sees: bound.all.includes('canaryhotfact') }).toEqual({ isError: false, sees: true });
    }, 60_000);

    test('over HTTP, a member-bound key is unaffected', async () => {
      const out = await search('alice-key');
      expect(out.isError).toBe(false);
      expect(out.text).toContain('canarybeta');
      expect(out.meta?.access).toMatchObject({ member: 'alice-example' });
      expect(out.meta?.access?.requester_scope).toBeUndefined();
    }, 60_000);

    test('a key created after the brain started serving several people is refused at once; whoami still answers', async () => {
      await setSince(1);
      await mint('fresh-unbound');
      refused(await search('fresh-unbound'), 'created_after');
      await engine.executeRaw('UPDATE access_tokens SET created_at = $2::timestamptz WHERE id::text = $1', [keys['fresh-unbound']!.id, await engine.getConfig('access.serves_since')]);
      refused(await search('fresh-unbound'), 'created_after');
      const who = await http('fresh-unbound', 'whoami', {});
      expect(who.isError).toBe(false);
      expect(who.json.access.requester_scope).toEqual({ state: 'refused', reason: 'created_after', argv: ['gbrain', 'auth', 'rescope', '--token', 'fresh-unbound', '--member', '<MEMBER>'] });
      expect((await http('alice-key', 'whoami', {})).json.access.requester_scope).toEqual({ state: 'scoped' });
    }, 60_000);

    test('enumeration: every gated read op is refused for an unbound key before its handler runs', async () => {
      await setSince(15);
      const auth = await provider().verifyAccessToken(keys['fresh-unbound']!.token) as unknown as AuthInfo;
      const ran: string[] = [];
      const saved = new Map(operations.map(op => [op.name, op.handler]));
      for (const op of operations) op.handler = (async () => { ran.push(op.name); return {}; }) as typeof op.handler;
      const answered: string[] = [];
      try {
        for (const op of operations.filter(o => (o.mutating === false || o.scope === 'read') && !o.localOnly)) {
          const out = shape(await dispatchToolCall(engine, op.name, {}, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] }));
          if (op.cliOnly) {
            expect({ op: op.name, code: out.json.code }).toEqual({ op: op.name, code: 'trusted_local_only' });
          } else if (requiresRequesterScope(op, auth)) {
            expect({ op: op.name, code: out.structured?.error?.code }).toEqual({ op: op.name, code: 'requester_scope_required' });
          } else answered.push(op.name);
        }
      } finally {
        for (const op of operations) op.handler = saved.get(op.name)!;
      }
      expect(ran.filter(n => !answered.includes(n))).toEqual([]);
      expect(answered.sort()).toEqual([...REVIEWED_EXEMPT, ...OWN_JOB_OPS].sort());
      expect(ran).not.toContain('think');
    }, 120_000);

    test('the opt-out: --reads-unscoped lets one key read with no notice, and removing it refuses again', async () => {
      expect(() => takeBindingFlags(['--reads-unscoped'])).toThrow(/--yes/);
      expect(takeBindingFlags(['--reads-unscoped', '--yes']).patch).toEqual({ readsUnscoped: true });
      expect(takeBindingFlags(['--reads-unscoped', 'none']).patch).toEqual({ readsUnscoped: false });
      const set = await bindCredential(engine, { kind: 'token', id: keys['fresh-unbound']!.id }, { readsUnscoped: true });
      expect(set).toMatchObject({ reads_unscoped: true, changed: true });
      const out = await search('fresh-unbound');
      expect(out.isError).toBe(false);
      expect(out.meta?.access?.requester_scope).toBeUndefined();
      expect((await bindCredential(engine, { kind: 'token', id: keys['fresh-unbound']!.id }, { readsUnscoped: true })).changed).toBe(false);
      await bindCredential(engine, { kind: 'token', id: keys['fresh-unbound']!.id }, { readsUnscoped: false });
      refused(await search('fresh-unbound'), 'created_after');
    }, 60_000);

    test('stdio: unbound reads world pages with a notice in the grace (never a member-restricted page) and is refused after it; the fix is the per-harness --stdio-member binding or a per-person HTTP key, on either engine, never config set; a server started with --stdio-member reads plainly', async () => {
      const setupFix = ['gbrain', 'setup', '<HARNESS>', '--stdio-member', '<MEMBER>'];
      const route = (text: string) => {
        expect(text).toContain('gbrain setup claude-code|codex --stdio-member');
        expect(text).toContain('gbrain serve --http');
        expect(text).not.toContain('PGLite');
      };
      await importFromContent(engine, 'notes/alice-only', '---\ntype: note\ntitle: alice only\nreadable_by: [alice-example]\n---\n# alice only\n\nHarbor ledger notes canaryalice.\n', { sourceId: 'default', noEmbed: true });
      await setSince(1);
      const inGrace = await stdio('get_page', { slug: 'notes/harbor-alpha' });
      expect(inGrace.isError).toBe(false);
      expect(inGrace.text).toContain('canaryalpha');
      expect(inGrace.meta?.access?.requester_scope).toMatchObject({ state: 'grace', connection: 'this stdio server', fix: { argv: expect.arrayContaining(setupFix), next: 'tell_user_to_run' } });
      route(inGrace.meta?.access?.requester_scope.message);
      expect((await stdio('get_page', { slug: 'notes/alice-only' })).text).not.toContain('canaryalice');
      await setSince(15);
      const after = await stdio('get_page', { slug: 'notes/harbor-alpha' });
      expect(after.structured?.error).toMatchObject({ code: 'requester_scope_required', reason: 'grace_ended', fix: { argv: expect.arrayContaining(setupFix) } });
      expect(after.text).not.toContain('canaryalpha');
      route(after.text);
      for (const out of [inGrace, after]) expect(JSON.stringify([out.meta, out.structured, out.text])).not.toContain('config set mcp.stdio_member');
      const who = await stdio('whoami', {});
      route(who.json.access.note);
      expect(who.json.access.requester_scope.argv).toEqual(setupFix);
      expect(JSON.stringify(who.json)).not.toContain('config set mcp.stdio_member');
      const registered = shape(await dispatchToolCall(engine, 'get_page', { slug: 'notes/alice-only' }, { remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'], stdioMember: 'alice-example' }));
      expect(registered.isError).toBe(false);
      expect(registered.text).toContain('canaryalice');
      expect(registered.meta?.access?.requester_scope).toBeUndefined();
      await engine.setConfig('mcp.stdio_member', 'alice-example');
      const bound = await stdio('get_page', { slug: 'notes/harbor-alpha' });
      expect(bound.isError).toBe(false);
      expect(bound.meta?.access?.requester_scope).toBeUndefined();
      await engine.unsetConfig('mcp.stdio_member');
    }, 60_000);

    test('R94: on a brain pinned access.serves one, unbound reads (old, new, HTTP, stdio) answer with no notice after any grace; the owner-bound key reads the same private pages here as on a several-people brain', async () => {
      await importFromContent(engine, 'notes/owner-private', '---\ntype: note\ntitle: owner private\nvisibility: private\n---\n# owner private\n\nHarbor ledger notes canaryowner.\n', { sourceId: 'default', noEmbed: true });
      await engine.setConfig('access.owner_member', 'alice-example');
      __resetPrivateVisibilityCacheForTests();
      await setSince(30);
      await mint('pinned-fresh');
      const ownerRead = async () => (await http('alice-key', 'get_page', { slug: 'notes/owner-private' })).json;
      const several = await ownerRead();
      expect(several.compiled_truth).toContain('canaryowner');
      await engine.setConfig('access.serves', 'one');
      try {
        expect(await ownerRead()).toEqual(several);
        for (const name of ['old-unbound', 'pinned-fresh']) {
          const out = await search(name);
          expect({ name, isError: out.isError }).toEqual({ name, isError: false });
          expect(out.text).toContain('canaryalpha');
          expect(out.meta?.access?.requester_scope).toBeUndefined();
        }
        const viaStdio = await stdio('get_page', { slug: 'notes/harbor-alpha' });
        expect(viaStdio.isError).toBe(false);
        expect(viaStdio.meta?.access?.requester_scope).toBeUndefined();
        expect((await http('pinned-fresh', 'whoami', {})).json.access.requester_scope).toEqual({ state: 'not_required' });
        await expect(assertCredentialScoped(engine, null, 'token', 'pinned-new')).resolves.toBeUndefined();
      } finally {
        await engine.unsetConfig('access.serves');
        await engine.unsetConfig('access.owner_member');
        __resetPrivateVisibilityCacheForTests();
      }
    }, 60_000);

    test('a shared agent naming its audience reads; the same credential with no audience is refused', async () => {
      const c = await provider().registerClientManual('agent-' + kind, ['client_credentials'], 'read write', [], 'default');
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { mayActFor: ['member:alice-example', 'member:bob-example'] });
      const bearer = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret!)).access_token;
      const named = await oauthCall(bearer, 'get_page', { slug: 'notes/harbor-alpha' }, { onBehalfOf: { header: 'alice-example' } });
      expect(named.isError).toBe(false);
      expect(named.meta?.access?.requester_scope).toBeUndefined();
      const bare = await oauthCall(bearer, 'get_page', { slug: 'notes/harbor-alpha' });
      expect(bare.structured?.error).toMatchObject({ code: 'requester_scope_required', fix: { argv: ['gbrain', 'auth', 'rescope', '--client', c.clientId, '--member', '<MEMBER>'] } });
    }, 60_000);

    test('an attested call is exempt', async () => {
      const c = await provider().registerClientManual('qm-' + kind, ['client_credentials'], 'read write', [], 'default');
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: ['get_page', 'search'] });
      await linkMember(engine, 'alice-example', 'qm', 'U0ALICE');
      const bearer = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret!)).access_token;
      const out = await oauthCall(bearer, 'get_page', { slug: 'notes/harbor-alpha' }, { actor: { header: 'U0ALICE' } });
      expect(out.isError).toBe(false);
      expect(out.text).toContain('canaryalpha');
      expect(out.meta?.access).toMatchObject({ member: 'alice-example', actor: { system: 'qm' } });
      expect(out.meta?.access?.requester_scope).toBeUndefined();
    }, 60_000);

    test('hosted switch off: an unbound DCR client registered after the date reads with the notice, and is refused once the switch is on', async () => {
      const dcr = await provider(true).clientsStore.registerClient!({ client_name: 'dcr-' + kind, grant_types: ['client_credentials'], scope: 'read', redirect_uris: [], token_endpoint_auth_method: 'client_secret_post' } as never);
      const bearer = (await provider().exchangeClientCredentials(dcr.client_id, dcr.client_secret!)).access_token;
      await engine.setConfig('access.requester_scope_enforce', 'false');
      const off = await oauthCall(bearer, 'get_page', { slug: 'notes/harbor-alpha' });
      expect(off.isError).toBe(false);
      expect(off.text).toContain('canaryalpha');
      expect(off.meta?.access?.requester_scope).toMatchObject({ state: 'not_enforced', refuses_at: null, connection: `OAuth client ${dcr.client_id}` });
      await expect(assertCredentialScoped(engine, null, 'token', 'any-name')).resolves.toBeUndefined();
      await engine.unsetConfig('access.requester_scope_enforce');
      const on = await oauthCall(bearer, 'get_page', { slug: 'notes/harbor-alpha' });
      expect(on.structured?.error).toMatchObject({ code: 'requester_scope_required', reason: 'created_after' });
    }, 60_000);

    test('an agent job from an unbound credential is refused at its first tool call, structured; in the grace it runs', async () => {
      const c = await provider().registerClientManual('job-' + kind, ['client_credentials'], 'read write', [], 'default');
      const tools = buildBrainTools({ subagentId: 7, engine, config: { engine: 'pglite' } as never, sourceId: 'default',
        delegatedAuth: { clientId: c.clientId, scopes: ['read', 'agent'], sourceId: 'default', allowedSources: ['default'] } });
      const getPage = tools.find(t => t.name === 'brain_get_page')!;
      const ctx = { engine, jobId: 1, signal: new AbortController().signal } as never;
      const err = await getPage.execute({ slug: 'notes/harbor-alpha' }, ctx).then(() => null, e => e);
      expect(err).toMatchObject({ code: 'requester_scope_required', reason: 'created_after' });
      expect(err.fix).toMatchObject({ argv: ['gbrain', 'auth', 'rescope', '--client', c.clientId, '--member', '<MEMBER>'] });
      await engine.executeRaw('UPDATE oauth_clients SET client_id_issued_at = $2 WHERE client_id = $1', [c.clientId, Math.floor((Date.now() - 2 * DAY) / 1000)]);
      await setSince(1);
      const ran = await getPage.execute({ slug: 'notes/harbor-alpha' }, ctx);
      expect(JSON.stringify(ran)).toContain('canaryalpha');
    }, 60_000);

    test('creating an unbound credential on this brain is refused with credential_scope_required and the fix', async () => {
      const err = await assertCredentialScoped(engine, null, 'token', 'new-bot').then(() => null, e => e);
      expect(err).toMatchObject({ code: 'credential_scope_required' });
      expect(err.fix).toMatchObject({ argv: ['gbrain', 'auth', 'create', 'new-bot', '--member', '<MEMBER>'] });
      for (const patch of [{ member: 'alice-example' }, { mayActFor: ['member:alice-example'] }, { readsUnscoped: true }, { attestActor: 'qm' }]) {
        await expect(assertCredentialScoped(engine, patch, 'client', 'new-bot')).resolves.toBeUndefined();
      }
    }, 60_000);
  });
}

describe('the access owner hint names the per-harness binding', () => {
  const view = { owner: 'alice-example', bound_credentials: [], inactive: null } as unknown as Parameters<typeof ownerLines>[0];
  test('it names --stdio-member for one harness and the per-person HTTP key, never a bare config set', () => {
    const text = ownerLines(view).join('\n');
    expect(text).toContain('gbrain setup claude-code|codex --stdio-member alice-example');
    expect(text).toContain('gbrain serve --http');
    expect(text).toContain('--member alice-example');
    expect(text).not.toContain('config set mcp.stdio_member');
  });
});

describe('doctor unscoped_shared_reads and the post-upgrade list (pglite, repo-less)', () => {
  let engine: BrainEngine;
  const doctor = async () => (await unscopedSharedReadsEntry.run({ engine } as unknown as DoctorContext) as Array<Record<string, any>>)[0]!;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('not applicable for one person; fails per unbound credential with its grace end and command; opt-outs are info; hosted warns', async () => {
    const old = await mintLegacyToken(engine, { name: 'old-bot', scopes: ['read'], takesHolders: ['world'] });
    expect(await doctor()).toMatchObject({ name: 'unscoped_shared_reads', status: 'ok', readiness_state: 'not_applicable' });
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await engine.executeRaw('UPDATE access_tokens SET created_at = $2::timestamptz WHERE id::text = $1', [old.id, iso(Date.now() - 2 * DAY)]);
    await engine.setConfig('access.serves_since', iso(Date.now() - DAY));
    const fresh = await mintLegacyToken(engine, { name: 'fresh-bot', scopes: ['read'], takesHolders: ['world'] });
    const optOut = await mintLegacyToken(engine, { name: 'team-bot', scopes: ['read'], takesHolders: ['world'] });
    await bindCredential(engine, { kind: 'token', id: optOut.id }, { readsUnscoped: true });
    const bound = await mintLegacyToken(engine, { name: 'alice-bot', scopes: ['read'], takesHolders: ['world'] });
    await bindCredential(engine, { kind: 'token', id: bound.id }, { member: 'alice-example' });
    const c = await doctor();
    expect(c.status).toBe('fail');
    expect(c.details.connections).toEqual([
      { connection: 'token fresh-bot', state: 'refused', refuses_at: null, argv: ['gbrain', 'auth', 'rescope', '--token', 'fresh-bot', '--member', '<MEMBER>'] },
      { connection: 'token old-bot', state: 'grace', refuses_at: new Date(Date.parse(await engine.getConfig('access.serves_since') as string) + 14 * DAY).toISOString(), argv: ['gbrain', 'auth', 'rescope', '--token', 'old-bot', '--member', '<MEMBER>'] },
      { connection: 'token team-bot', state: 'reads_unscoped', refuses_at: null, argv: ['gbrain', 'auth', 'rescope', '--token', 'team-bot', '--member', '<MEMBER>'] },
    ]);
    expect(c.message).toContain('Reading unscoped on purpose (--reads-unscoped): token team-bot');
    expect(c.fix).toMatchObject({ argv: ['gbrain', 'auth', 'rescope', '--token', 'fresh-bot', '--member', '<MEMBER>'], ask_user: true });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { await printUnscopedReadsUpgradeNotice(engine); } finally { console.log = log; }
    expect(lines.join('\n')).toContain('token old-bot: grace until');
    expect(lines.join('\n')).toContain('Fix: gbrain auth rescope --token fresh-bot --member <MEMBER>');
    expect(lines.join('\n')).not.toContain('team-bot');
    await engine.setConfig('access.requester_scope_enforce', 'false');
    expect((await doctor()).status).toBe('warn');
    await engine.unsetConfig('access.requester_scope_enforce');
    for (const t of [old, fresh]) await bindCredential(engine, { kind: 'token', id: t.id }, { member: 'bob-example' });
    expect(await doctor()).toMatchObject({ status: 'ok' });
  }, 60_000);
});

describe('a one-person brain with several sources sees no refusal and no notice (pglite, repo-less)', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    for (const src of ['source-a', 'source-b', 'source-c']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [src]);
    for (const src of ['source-a', 'source-b', 'source-c']) await importFromContent(engine, `notes/${src}`, pageText(`notes/${src}`, `canary${src.replace('-', '')}`), { sourceId: src, noEmbed: true });
    await addMember(engine, 'alice-example');
    await engine.setConfig('access.owner_member', 'alice-example');
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('an unbound key created today and an unbound stdio server read every source with nothing new in _meta', async () => {
    const m = await mintLegacyToken(engine, { name: 'one-person-bot', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['source-a', 'source-b', 'source-c'] });
    const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) } as never).verifyAccessToken(m.token) as unknown as AuthInfo;
    for (const transport of ['http', 'stdio'] as const) {
      const out = shape(await dispatchToolCall(engine, 'search', { query: 'harbor ledger notes', match: 'keyword', limit: 10, source_ids: ['source-a', 'source-b', 'source-c'] },
        { remote: true, transport, ...(transport === 'http' ? { auth } : { localFederatedSourceIds: ['source-b', 'source-c'] }), sourceId: 'source-a', takesHoldersAllowList: ['world'] }));
      expect({ transport, isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ transport, isError: false, text: '' });
      for (const src of ['sourcea', 'sourceb', 'sourcec']) expect(out.text).toContain(`canary${src}`);
      expect(out.meta?.access).not.toHaveProperty('requester_scope');
    }
    await expect(assertCredentialScoped(engine, null, 'token', 'x')).resolves.toBeUndefined();
    expect(await engine.getConfig('access.serves_since')).toBeNull();
  }, 60_000);
});

describe('a repo brain behaves the same (pglite, source with a git checkout)', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-scope-repo-')); roots.push(repo);
    execFileSync('git', ['init', '-q', repo]);
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING', ['repo-src', repo]);
    await importFromContent(engine, 'notes/repo-page', pageText('notes/repo-page', 'canaryrepo'), { sourceId: 'repo-src', noEmbed: true });
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('unbound stdio in the grace gets the notice, after it the refusal', async () => {
    const call = async () => shape(await dispatchToolCall(engine, 'get_page', { slug: 'notes/repo-page' }, { remote: true, transport: 'stdio', sourceId: 'repo-src', takesHoldersAllowList: ['world'] }));
    expect((await call()).meta?.access?.requester_scope).toMatchObject({ state: 'grace' });
    await engine.setConfig('access.serves_since', iso(Date.now() - 15 * DAY));
    expect((await call()).structured?.error).toMatchObject({ code: 'requester_scope_required', reason: 'grace_ended' });
  }, 60_000);
});

describe('the CLI refuses an unbound credential and records the opt-out (pglite, spawned)', () => {
  test('auth create refuses credential_scope_required; --reads-unscoped needs --yes and lands in the audit trail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-scope-cli-')); roots.push(home);
    const env = { GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit') };
    const run = (args: string[]) => runCli(args, { env, timeoutMs: 120_000 });
    expect((await run(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    for (const id of ['alice-example', 'bob-example']) expect((await run(['access', 'member', 'add', id])).exitCode).toBe(0);
    const refused = await run(['auth', 'create', 'shared-bot']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('credential_scope_required');
    expect(refused.stdout + refused.stderr).not.toMatch(/gbrain_[A-Za-z0-9]{20,}/);
    const noYes = await run(['auth', 'create', 'shared-bot', '--reads-unscoped']);
    expect(noYes.exitCode).not.toBe(0);
    expect(noYes.stdout + noYes.stderr).toContain('--yes');
    const optOut = await run(['auth', 'create', 'shared-bot', '--reads-unscoped', '--yes']);
    expect(optOut.exitCode).toBe(0);
    expect(optOut.stdout).toContain('reads unscoped: yes');
    const bound = await run(['auth', 'create', 'alice-bot', '--member', 'alice-example']);
    expect(bound.exitCode).toBe(0);
    const marked = await run(['access', 'check', '--token', 'shared-bot', '--json']);
    expect(JSON.parse(marked.stdout)).toMatchObject({ verdict: 'unbound', reads_unscoped: true });
    expect(JSON.parse(marked.stdout).explanation).toContain('--reads-unscoped');
    expect(JSON.parse((await run(['access', 'check', '--token', 'alice-bot', '--json'])).stdout)).toMatchObject({ verdict: 'reads_as_member', reads_unscoped: false });
    await withEnv({ GBRAIN_AUDIT_DIR: join(home, 'audit') }, () => {
      expect(readReadsUnscopedChanges()).toEqual([expect.objectContaining({ credential: 'token shared-bot', reads_unscoped: true, by: 'gbrain auth' })]);
    });
  }, 180_000);

  test('the upgrade path never binds stdio: post-upgrade and apply-migrations on a brain with an owner and two members leave mcp.stdio_member unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-scope-upgrade-')); roots.push(home);
    const env = { GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit') };
    const run = (args: string[]) => runCli(args, { env, timeoutMs: 180_000 });
    expect((await run(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await run(['access', 'member', 'add', 'alice-example'])).exitCode).toBe(0);
    expect((await run(['auth', 'create', 'old-bot'])).exitCode).toBe(0);
    expect((await run(['access', 'member', 'add', 'bob-example'])).exitCode).toBe(0);
    const owner = await run(['access', 'owner', 'set', 'alice-example']);
    expect(owner.exitCode).toBe(0);
    expect(owner.stdout).toContain('--stdio-member alice-example');
    expect(owner.stdout).not.toContain('config set mcp.stdio_member');
    const stdioMember = async () => (await run(['config', 'get', 'mcp.stdio_member'])).stdout.trim();
    const before = await stdioMember();
    const post = await run(['post-upgrade']);
    expect(post.stdout + post.stderr).toContain('token old-bot');
    expect(post.stdout + post.stderr).not.toContain('config set mcp.stdio_member');
    await run(['apply-migrations', '--yes', '--non-interactive']);
    expect({ before, after: await stdioMember() }).toEqual({ before: '', after: '' });
  }, 600_000);
  test('auth --help names --reads-unscoped --yes on auth create and register-client, the flags the credential_scope_required refusal asks for', async () => {
    const help = await runCli(['auth', '--help'], { timeoutMs: 60_000 });
    const text = help.stdout + help.stderr;
    expect(text).toMatch(/gbrain auth create <name> [^\n]*\[--reads-unscoped --yes\]/);
    expect(text).toMatch(/gbrain auth register-client <name>[\s\S]*--reads-unscoped --yes/);
  }, 120_000);
});
