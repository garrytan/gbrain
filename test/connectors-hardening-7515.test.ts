/**
 * #7515: chat-connector hardening for unattended use with a browser session cookie.
 *
 * 1. Protects:
 *    (a) a 403 (JSON body or www-authenticate) ends the run as auth_required and never refreshes and retries;
 *    (b) ChatGPT's token refresh goes through the shared client: redirect 'manual', a 30x to another origin is never
 *        followed (the cookie never leaves the provider's origin), refresh 403/429/401 surface as
 *        forbidden/rate_limited/auth_required, and `connectors auth` does not probe after a failed refresh;
 *    (c) auto_sync=false holds for an already-queued connector-sync job and for `connectors sync --all`; only an
 *        explicit `connectors sync <provider>` overrides it;
 *    (d) a run is bounded: a hard request ceiling (per run, per Claude organization, a Claude organization cap),
 *        over-long list pages truncated locally, refresh requests paced and counted, and --max-requests/--deadline.
 * 2. Fails when: any of those paths falls back to refresh-and-retry, raw fetch, an unchecked queue/--all, or an
 *    unbounded walk.
 * 3. Everything runs against the real ConnectorClient and providers with fixture servers or injected fetch on PGLite;
 *    no real credential and no network. The dummy cookie is never printed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import * as connectorClient from '../src/core/connectors/client.ts';
import { ConnectorAuthError, ConnectorClient, type ConnectorFetch } from '../src/core/connectors/client.ts';
import { runConnectorSync, type ConnectorSyncOpts } from '../src/core/connectors/sync.ts';
import { loadCredential, saveCredential } from '../src/core/connectors/credentials.ts';
import { watermarkKey } from '../src/core/connectors/config-keys.ts';
import { CHATGPT_BASE_URL, chatgptProvider } from '../src/core/connectors/providers/chatgpt.ts';
import * as claudeModule from '../src/core/connectors/providers/claude.ts';
import { CLAUDE_BASE_URL, claudeProvider } from '../src/core/connectors/providers/claude.ts';
import type { ConversationStub } from '../src/core/connectors/types.ts';
import { makeConnectorSyncHandler } from '../src/core/minions/handlers/connector-sync.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { runConnectorSyncCmd } from '../src/commands/connectors/sync.ts';
import { runConnectorAuth } from '../src/commands/connectors/auth.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { chatgptHandler, claudeHandler, newFixtureState, startFixture, type FixtureConversation, type FixtureState } from './fixtures/connectors/fixture-server.ts';

const COOKIE = 'sessionKey=dummy-7515';
const T0 = 1_786_000_000;
const NOW_MS = (T0 + 100_000) * 1000;
const realFetch = globalThis.fetch;

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  _resetCliExitVerdictForTests();
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-connector-7515-'));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

function conversations(n: number): FixtureConversation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c-${i}`, title: `Topic ${i}`, createTime: T0 + i - 100, updateTime: T0 + i,
    turns: [{ role: 'user' as const, text: `q${i}` }, { role: 'assistant' as const, text: `a${i}` }],
  }));
}

interface Logged { origin: string; path: string; redirect?: string; at: number }

/** Rewrite each provider origin to its fixture; log every request; refuse anything unrouted (no network). */
function routeTo(map: Record<string, string>, log: Logged[] = [], clock?: { t: number; perRequest?: number }): ConnectorFetch {
  return (url, init) => {
    for (const [from, to] of Object.entries(map)) {
      if (!url.startsWith(from)) continue;
      const u = new URL(url);
      log.push({ origin: from, path: u.pathname + u.search, redirect: init?.redirect, at: clock?.t ?? 0 });
      if (clock?.perRequest) clock.t += clock.perRequest;
      return realFetch(to + url.slice(from.length), init);
    }
    return Promise.reject(new Error('test fetch refused an unrouted URL'));
  };
}

const ENV = {
  GBRAIN_CONNECTOR_CHATGPT_COOKIE: undefined, GBRAIN_CONNECTOR_CHATGPT_TOKEN: undefined,
  GBRAIN_CONNECTOR_CLAUDE_COOKIE: undefined, GBRAIN_CONNECTOR_CLAUDE_TOKEN: undefined,
};

function saveCookie(provider: 'chatgpt' | 'claude'): void {
  saveCredential({ provider, strategy: 'browser-session', cookie: COOKIE, savedAt: new Date(0).toISOString() });
}

async function syncChatgpt(state: FixtureState, opts: Partial<ConnectorSyncOpts> = {}, log: Logged[] = [], clock?: { t: number; perRequest?: number }) {
  const srv = startFixture(chatgptHandler(state));
  try {
    return await withEnv({ GBRAIN_HOME: home, ...ENV }, async () => {
      saveCookie('chatgpt');
      return runConnectorSync(engine, {
        provider: 'chatgpt', sourceId: 'default', ...opts,
        deps: {
          fetchImpl: routeTo({ [CHATGPT_BASE_URL]: srv.baseUrl }, log, clock),
          now: clock ? () => clock.t : () => NOW_MS,
          sleep: clock ? async (ms) => { clock.t += ms; } : () => Promise.resolve(),
        },
      });
    });
  } finally {
    srv.stop();
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ── (a) a 403 never refreshes ───────────────────────────────────────────────
describe('#7515 (a) a 403 ends the run without refresh-and-retry', () => {
  for (const [label, response] of [
    ['JSON body', () => json({ error: 'token_expired' }, 403)],
    ['www-authenticate', () => new Response('nope', { status: 403, headers: { 'www-authenticate': 'Bearer' } })],
  ] as const) {
    test(`client: 403 + ${label} → ConnectorAuthError, refresh never called, one request`, async () => {
      let refreshes = 0;
      let calls = 0;
      const client = new ConnectorClient({
        baseUrl: CHATGPT_BASE_URL, headers: async () => ({}), minDelayMs: 0, sleep: async () => {},
        refresh: async () => { refreshes++; return true; },
        fetchImpl: async () => { calls++; return response(); },
      });
      await expect(client.fetchJSON('/backend-api/conversations')).rejects.toBeInstanceOf(ConnectorAuthError);
      expect(refreshes).toBe(0);
      expect(calls).toBe(1);
    });
  }

  test('sync: a 403 JSON on the probe → auth_required, no /api/auth/session request', async () => {
    const state = newFixtureState(conversations(3));
    state.script.push({ pathIncludes: '/backend-api/conversations', status: 403, body: { error: 'token_expired' } });
    const log: Logged[] = [];
    const r = await syncChatgpt(state, {}, log);
    expect(r.status).toBe('auth_required');
    expect(log.filter((l) => l.path.startsWith('/api/auth/session'))).toEqual([]);
    expect(log.length).toBe(1);
  });
});

// ── (b) ChatGPT refresh goes through the shared client ─────────────────────
describe('#7515 (b) ChatGPT token refresh uses the shared client protections', () => {
  test('a refresh 302 to another origin is not followed; the cookie never leaves the origin', async () => {
    const offOrigin = { hits: 0, sawCookie: false };
    const collector = startFixture((req) => {
      offOrigin.hits++;
      if (req.headers.get('cookie')) offOrigin.sawCookie = true;
      return json({ accessToken: 'collected' });
    });
    try {
      const state = newFixtureState(conversations(3));
      state.script.push({ pathIncludes: '/backend-api/conversations', status: 401, body: { error: 'expired' }, onCall: 1 });
      state.script.push({ pathIncludes: '/api/auth/session', status: 302, body: '', headers: { location: `${collector.baseUrl}/collect` } });
      const log: Logged[] = [];
      const r = await syncChatgpt(state, {}, log);
      expect(offOrigin.sawCookie).toBe(false);
      expect(offOrigin.hits).toBe(0);
      const session = log.filter((l) => l.path.startsWith('/api/auth/session'));
      expect(session.length).toBe(1);
      expect(session[0].redirect).toBe('manual');
      expect(r.status).toBe('auth_required');
      expect(log.length).toBe(2);
      expect(JSON.stringify(r)).not.toContain('dummy-7515');
    } finally {
      collector.stop();
    }
  });

  for (const [status, expected, extra] of [
    [403, 'forbidden', { body: 'blocked', contentType: 'text/plain' }],
    [429, 'rate_limited', { body: { error: 'slow down' }, headers: { 'retry-after': '3600' } }],
    [401, 'auth_required', { body: { error: 'expired' } }],
  ] as const) {
    test(`refresh answering ${status} → ${expected}, and no request after it`, async () => {
      const state = newFixtureState(conversations(3));
      state.script.push({ pathIncludes: '/backend-api/conversations', status: 401, body: { error: 'expired' }, onCall: 1 });
      state.script.push({ pathIncludes: '/api/auth/session', status, ...extra });
      const log: Logged[] = [];
      const r = await syncChatgpt(state, {}, log);
      expect(r.status).toBe(expected);
      expect(log.map((l) => l.path.split('?')[0])).toEqual(['/backend-api/conversations', '/api/auth/session']);
    });
  }

  test('connectors auth stops after a failed refresh: no probe, nothing saved, exit 1', async () => {
    const state = newFixtureState(conversations(1));
    state.script.push({ pathIncludes: '/api/auth/session', status: 403, body: 'blocked', contentType: 'text/plain' });
    const srv = startFixture(chatgptHandler(state));
    const log: Logged[] = [];
    globalThis.fetch = routeTo({ [CHATGPT_BASE_URL]: srv.baseUrl }, log) as unknown as typeof fetch;
    const errors: string[] = [];
    const prevError = console.error;
    const prevLog = console.log;
    console.error = (...p: unknown[]) => { errors.push(p.join(' ')); };
    console.log = () => {};
    try {
      await withEnv({ GBRAIN_HOME: home, ...ENV }, async () => {
        await runConnectorAuth(engine, ['chatgpt', '--cookie', COOKIE]);
        expect(loadCredential('chatgpt')).toBeNull();
      });
    } finally {
      console.error = prevError;
      console.log = prevLog;
      globalThis.fetch = realFetch;
      srv.stop();
    }
    expect(log.map((l) => l.path.split('?')[0])).toEqual(['/api/auth/session']);
    expect(currentExitCode()).toBe(1);
    expect(errors.join(' ')).not.toContain('dummy-7515');
  });
});

// ── (c) auto_sync=false is enforced where jobs run ─────────────────────────
function fakeJob(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 1, name: 'connector-sync', data, attempts_made: 0,
    signal: new AbortController().signal, shutdownSignal: new AbortController().signal, deadlineAtMs: null,
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
    isActive: async () => true, readInbox: async () => [],
  } as unknown as MinionJobContext;
}

describe('#7515 (c) auto_sync=false holds for queued jobs and --all', () => {
  test('a queued connector-sync job with auto_sync off does nothing; an explicit one runs', async () => {
    const state = newFixtureState(conversations(2));
    const srv = startFixture(chatgptHandler(state));
    const log: Logged[] = [];
    try {
      await withEnv({ GBRAIN_HOME: home, ...ENV }, async () => {
        saveCookie('chatgpt');
        const handler = makeConnectorSyncHandler(engine, {
          fetchImpl: routeTo({ [CHATGPT_BASE_URL]: srv.baseUrl }, log), now: () => NOW_MS, sleep: () => Promise.resolve(),
        });
        const unset = (await handler(fakeJob({ provider: 'chatgpt', sourceId: 'default' }))) as { status: string };
        expect(unset.status).toBe('skipped');
        await engine.setConfig('connectors.chatgpt.auto_sync', 'false');
        const off = (await handler(fakeJob({ provider: 'chatgpt', sourceId: 'default' }))) as { status: string };
        expect(off.status).toBe('skipped');
        expect(log).toEqual([]);
        const explicit = (await handler(fakeJob({ provider: 'chatgpt', sourceId: 'default', explicit: true }))) as { status: string };
        expect(explicit.status).not.toBe('skipped');
        expect(log.length).toBeGreaterThan(0);
      });
    } finally {
      srv.stop();
    }
  });

  async function cli(args: string[]): Promise<{ chatgpt: number; claude: number }> {
    const gpt = startFixture(chatgptHandler(newFixtureState(conversations(1))));
    const cl = startFixture(claudeHandler(newFixtureState(conversations(1))));
    const log: Logged[] = [];
    globalThis.fetch = routeTo({ [CHATGPT_BASE_URL]: gpt.baseUrl, [CLAUDE_BASE_URL]: cl.baseUrl }, log) as unknown as typeof fetch;
    const prevError = console.error;
    const prevLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await withEnv({ GBRAIN_HOME: home, ...ENV }, async () => {
        saveCookie('chatgpt');
        saveCookie('claude');
        await engine.setConfig('connectors.claude.auto_sync', 'true');
        await runConnectorSyncCmd(engine, args);
      });
    } finally {
      console.error = prevError;
      console.log = prevLog;
      globalThis.fetch = realFetch;
      gpt.stop();
      cl.stop();
    }
    return { chatgpt: log.filter((l) => l.origin === CHATGPT_BASE_URL).length, claude: log.filter((l) => l.origin === CLAUDE_BASE_URL).length };
  }

  test('connectors sync --all skips a provider whose auto_sync is off', async () => {
    const hits = await cli(['--all', '--dry-run']);
    expect(hits.chatgpt).toBe(0);
    expect(hits.claude).toBeGreaterThan(0);
  }, 30_000);

  test('an explicit connectors sync <provider> still syncs with auto_sync off', async () => {
    const hits = await cli(['chatgpt', '--dry-run']);
    expect(hits.chatgpt).toBeGreaterThan(0);
    expect(hits.claude).toBe(0);
  }, 30_000);
});

// ── (d) an overall bound ────────────────────────────────────────────────────
describe('#7515 (d) a run is bounded', () => {
  const okClient = (opts: Record<string, unknown>, onCall?: () => void) => new ConnectorClient({
    baseUrl: CHATGPT_BASE_URL, headers: async () => ({}), minDelayMs: 0, sleep: async () => {},
    fetchImpl: async () => { onCall?.(); return json({ items: [] }); },
    ...opts,
  } as never);

  test('client: --max-requests stops before the next request with a run-limit error', async () => {
    let calls = 0;
    const client = okClient({ maxRequests: 3 }, () => { calls++; });
    for (let i = 0; i < 3; i++) await client.fetchJSON('/x');
    const e = await client.fetchJSON('/x').then(() => null, (err: unknown) => err) as { name?: string; reason?: string } | null;
    expect(e?.name).toBe('ConnectorRunLimitError');
    expect(e?.reason).toBe('max_requests');
    expect(calls).toBe(3);
  });

  test('client: the hard ceiling holds by default and caps a larger --max-requests', async () => {
    const ceiling = (connectorClient as Record<string, unknown>).MAX_CONNECTOR_REQUESTS_PER_RUN as number;
    expect(ceiling).toBe(10_000);
    for (const opts of [{}, { maxRequests: ceiling * 10 }]) {
      let calls = 0;
      const client = okClient(opts, () => { calls++; });
      for (let i = 0; i < ceiling; i++) await client.fetchJSON('/x');
      await expect(client.fetchJSON('/x')).rejects.toMatchObject({ name: 'ConnectorRunLimitError', reason: 'max_requests' });
      expect(calls).toBe(ceiling);
    }
  });

  test('client: a deadline stops before the next request and before a Retry-After wait that would pass it', async () => {
    const clock = { t: NOW_MS };
    let calls = 0;
    const client = okClient({ now: () => clock.t, deadlineAt: NOW_MS + 2_500 }, () => { calls++; clock.t += 1_000; });
    for (let i = 0; i < 3; i++) await client.fetchJSON('/x');
    await expect(client.fetchJSON('/x')).rejects.toMatchObject({ name: 'ConnectorRunLimitError', reason: 'deadline' });
    expect(calls).toBe(3);

    const sleeps: number[] = [];
    const limited = new ConnectorClient({
      baseUrl: CHATGPT_BASE_URL, headers: async () => ({}), minDelayMs: 0, now: () => NOW_MS, deadlineAt: NOW_MS + 10_000,
      sleep: async (ms: number) => { sleeps.push(ms); }, fetchImpl: async () => json({ error: 'slow down' }, 429, { 'retry-after': '60' }),
    } as never);
    await expect(limited.fetchJSON('/x')).rejects.toMatchObject({ name: 'ConnectorRunLimitError', reason: 'deadline' });
    expect(sleeps).toEqual([]);
  });

  test('sync --full stops at --max-requests: partial with stopReason max_requests, no watermark, no strikes', async () => {
    const state = newFixtureState(conversations(12));
    const log: Logged[] = [];
    const r = await syncChatgpt(state, { full: true, maxRequests: 6 } as Partial<ConnectorSyncOpts>, log);
    expect(r.status).toBe('partial');
    expect(r.stopReason as string).toBe('max_requests');
    expect(log.length).toBe(6);
    expect(r.hint).toMatch(/request/i);
    expect(r.quarantined).toEqual([]);
    expect(await engine.getConfig(watermarkKey('chatgpt', 'default'))).toBeNull();
  });

  test('sync stops at --deadline: partial with stopReason deadline; no request starts after it', async () => {
    const state = newFixtureState(conversations(12));
    const log: Logged[] = [];
    const clock = { t: NOW_MS, perRequest: 1_000 };
    const deadlineAt = NOW_MS + 8_000;
    const r = await syncChatgpt(state, { full: true, deadlineAt } as Partial<ConnectorSyncOpts>, log, clock);
    expect(r.status).toBe('partial');
    expect(r.stopReason as string).toBe('deadline');
    expect(log.length).toBeGreaterThan(0);
    expect(log.length).toBeLessThan(15);
    expect(log.every((l) => l.at < deadlineAt)).toBe(true);
  });

  test('a refresh request is paced like any other request', async () => {
    const state = newFixtureState(conversations(1));
    state.script.push({ pathIncludes: '/backend-api/conversations', status: 401, body: { error: 'expired' }, onCall: 1 });
    const log: Logged[] = [];
    const clock = { t: NOW_MS };
    await syncChatgpt(state, {}, log, clock);
    const [first, session] = log;
    expect(session.path).toBe('/api/auth/session');
    expect(session.at - first.at).toBeGreaterThanOrEqual(700);
  });

  async function collect(gen: AsyncGenerator<ConversationStub>): Promise<ConversationStub[]> {
    const out: ConversationStub[] = [];
    for await (const s of gen) out.push(s);
    return out;
  }

  function fakeClient(baseUrl: string, handler: (url: URL) => Response, seen: string[]): ConnectorClient {
    return new ConnectorClient({
      baseUrl, headers: async () => ({}), minDelayMs: 0, sleep: () => Promise.resolve(),
      fetchImpl: async (input: string) => { const u = new URL(input); seen.push(u.pathname + u.search); return handler(u); },
    });
  }

  const offsetOf = (p: string) => new URL(`http://x${p}`).searchParams.get('offset');

  test('chatgpt: an over-long list page is truncated to the page limit and the walk continues from there', async () => {
    const all = Array.from({ length: 100 }, (_, i) => ({ id: `g-${i}`, title: `t${i}`, update_time: T0 - i }));
    const seen: string[] = [];
    const client = fakeClient(CHATGPT_BASE_URL, (u) => {
      if (u.searchParams.get('is_archived')) return json({ items: [], total: 0 });
      return json({ items: all.slice(Number(u.searchParams.get('offset'))), total: all.length });
    }, seen);
    const stubs = await collect(chatgptProvider.listConversations(client));
    expect(stubs.map((s) => s.id)).toEqual(all.map((a) => a.id));
    expect(seen.filter((p) => !p.includes('is_archived')).map(offsetOf)).toEqual(['0', '28', '56', '84']);
  });

  test('chatgpt: an over-long page that ignores offset is drift, never a silently truncated list', async () => {
    const all = Array.from({ length: 100 }, (_, i) => ({ id: `g-${i}`, title: `t${i}`, update_time: T0 - i }));
    const client = fakeClient(CHATGPT_BASE_URL, () => json({ items: all, total: all.length }), []);
    await expect(collect(chatgptProvider.listConversations(client))).rejects.toThrow(/truncated|offset/i);
  });

  test('claude: an over-long page is truncated; an endpoint that ignores offset after it is drift', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ uuid: `u-${i}`, name: `n${i}`, updated_at: new Date((T0 - i) * 1000).toISOString() }));
    const seen: string[] = [];
    const honoring = fakeClient(CLAUDE_BASE_URL, (u) => {
      if (u.pathname === '/api/organizations') return json([{ uuid: 'org-a' }]);
      return json(rows.slice(Number(u.searchParams.get('offset') ?? '0')));
    }, seen);
    const stubs = await collect(claudeProvider.listConversations(honoring));
    expect(stubs.length).toBe(150);
    expect(seen.filter((p) => p.includes('chat_conversations')).map(offsetOf)).toEqual(['0', '100', '150']);

    const ignoring = fakeClient(CLAUDE_BASE_URL, (u) => (u.pathname === '/api/organizations' ? json([{ uuid: 'org-a' }]) : json(rows)), []);
    await expect(collect(claudeProvider.listConversations(ignoring))).rejects.toThrow(/truncated|offset/i);
  });

  test('claude: only the first CLAUDE_MAX_ORGS organizations are listed, and the listing is not treated as complete', async () => {
    const maxOrgs = (claudeModule as Record<string, unknown>).CLAUDE_MAX_ORGS as number;
    expect(maxOrgs).toBe(10);
    const orgs = Array.from({ length: maxOrgs + 5 }, (_, i) => ({ uuid: `org-${i}` }));
    const seen: string[] = [];
    const client = fakeClient(CLAUDE_BASE_URL, (u) => {
      if (u.pathname === '/api/organizations') return json(orgs);
      const org = u.pathname.split('/')[3];
      return json(Number(u.searchParams.get('offset') ?? '0') === 0 ? [{ uuid: `${org}-c`, name: 'x', updated_at: new Date(T0 * 1000).toISOString() }] : []);
    }, seen);
    await expect(collect(claudeProvider.listConversations(client))).rejects.toThrow(/organization/i);
    const listedOrgs = new Set(seen.filter((p) => p.includes('chat_conversations')).map((p) => p.split('/')[3]));
    expect(listedOrgs.size).toBe(maxOrgs);
  });

  test('claude: requests to one organization stop at CLAUDE_MAX_REQUESTS_PER_ORG', async () => {
    const perOrg = (claudeModule as Record<string, unknown>).CLAUDE_MAX_REQUESTS_PER_ORG as number;
    expect(perOrg).toBe(5_000);
    const seen: string[] = [];
    const client = fakeClient(CLAUDE_BASE_URL, (u) => json({ uuid: u.pathname.split('/').pop(), chat_messages: [] }), seen);
    for (let i = 0; i < perOrg; i++) await claudeProvider.fetchConversation(client, `c-${i}`, { orgId: 'org-a' });
    await expect(claudeProvider.fetchConversation(client, 'c-over', { orgId: 'org-a' })).rejects.toMatchObject({ name: 'ConnectorRunLimitError', reason: 'max_requests' });
    expect(seen.length).toBe(perOrg);
  });

  test('CLI: --max-requests and --deadline are validated (invalid_params) and accepted when valid', async () => {
    for (const args of [
      ['chatgpt', '--max-requests', '0'],
      ['chatgpt', '--max-requests', 'many'],
      ['chatgpt', '--max-requests', '10001'],
      ['chatgpt', '--max-requests'],
      ['chatgpt', '--deadline', 'soon'],
      ['chatgpt', '--deadline', '0'],
      ['chatgpt', '--deadline'],
    ]) {
      const e = await runConnectorSyncCmd({ getConfig: async () => null } as never, args).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as OperationError).message).toContain(args[1]);
    }
    const prevError = console.error;
    console.error = () => {};
    try {
      await withEnv({ GBRAIN_HOME: home, ...ENV }, async () => {
        await expect(runConnectorSyncCmd({ getConfig: async () => null } as never, ['chatgpt', '--max-requests', '50', '--deadline', '30m'])).resolves.toBeUndefined();
      });
    } finally {
      console.error = prevError;
    }
  });
});
