/**
 * Resolver SDK tests — interface contract + registry + 2 reference builtins.
 *
 * No network. url_reachable is tested via global fetch mock; x_handle_to_tweet
 * via mocked fetch + env. Real-network E2E (if any) lives in test/e2e/.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  ResolverRegistry,
  ResolverError,
  getDefaultRegistry,
  _resetDefaultRegistry,
} from '../src/core/resolvers/index.ts';
import type {
  Resolver,
  ResolverContext,
  ResolverRequest,
  ResolverResult,
} from '../src/core/resolvers/index.ts';
import { urlReachableResolver, checkDnsRebinding } from '../src/core/resolvers/builtin/url-reachable.ts';
import { xHandleToTweetResolver, computeBackoffMs } from '../src/core/resolvers/builtin/x-api/handle-to-tweet.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    requestId: 'test',
    remote: false,
    ...overrides,
  };
}

// Tiny fake resolver for contract tests
const echoResolver: Resolver<{ v: string }, { v: string }> = {
  id: 'echo',
  cost: 'free',
  backend: 'local',
  description: 'Echo',
  async available() { return true; },
  async resolve(req: ResolverRequest<{ v: string }>): Promise<ResolverResult<{ v: string }>> {
    return {
      value: { v: req.input.v },
      confidence: 1,
      source: 'local',
      fetchedAt: new Date(),
    };
  },
};

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('ResolverRegistry', () => {
  let reg: ResolverRegistry;

  beforeEach(() => {
    reg = new ResolverRegistry();
  });

  test('starts empty', () => {
    expect(reg.size()).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  test('register + get + has', () => {
    reg.register(echoResolver);
    expect(reg.size()).toBe(1);
    expect(reg.has('echo')).toBe(true);
    expect(reg.get('echo').id).toBe('echo');
  });

  test('register rejects duplicate id', () => {
    reg.register(echoResolver);
    expect(() => reg.register(echoResolver)).toThrow(ResolverError);
    try {
      reg.register(echoResolver);
    } catch (e) {
      expect((e as ResolverError).code).toBe('already_registered');
    }
  });

  test('register rejects empty id', () => {
    expect(() => reg.register({ ...echoResolver, id: '' })).toThrow(ResolverError);
  });

  test('get throws not_found for unknown id', () => {
    try {
      reg.get('nope');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolverError);
      expect((e as ResolverError).code).toBe('not_found');
    }
  });

  test('list returns summaries sorted by id', () => {
    reg.register(echoResolver);
    reg.register({ ...echoResolver, id: 'alpha' });
    const list = reg.list();
    expect(list.map(r => r.id)).toEqual(['alpha', 'echo']);
    expect(list[0].cost).toBe('free');
    expect(list[0].backend).toBe('local');
  });

  test('list filters by cost', () => {
    reg.register(echoResolver); // free
    reg.register({ ...echoResolver, id: 'paid-one', cost: 'paid' });
    expect(reg.list({ cost: 'paid' }).map(r => r.id)).toEqual(['paid-one']);
    expect(reg.list({ cost: 'free' }).map(r => r.id)).toEqual(['echo']);
  });

  test('list filters by backend', () => {
    reg.register(echoResolver);
    reg.register({ ...echoResolver, id: 'x-one', backend: 'x-api-v2' });
    expect(reg.list({ backend: 'x-api-v2' }).map(r => r.id)).toEqual(['x-one']);
  });

  test('resolve returns result', async () => {
    reg.register(echoResolver);
    const r = await reg.resolve('echo', { v: 'hi' }, makeCtx());
    expect(r.value).toEqual({ v: 'hi' });
    expect(r.confidence).toBe(1);
  });

  test('resolve throws not_found for unknown id', async () => {
    try {
      await reg.resolve('nope', {}, makeCtx());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('not_found');
    }
  });

  test('resolve throws unavailable when available() returns false', async () => {
    reg.register({
      ...echoResolver,
      id: 'blocked',
      async available() { return false; },
    });
    try {
      await reg.resolve('blocked', {}, makeCtx());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('unavailable');
    }
  });

  test('clear empties registry', () => {
    reg.register(echoResolver);
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});

describe('getDefaultRegistry', () => {
  beforeEach(() => _resetDefaultRegistry());
  afterEach(() => _resetDefaultRegistry());

  test('returns a singleton', () => {
    const a = getDefaultRegistry();
    const b = getDefaultRegistry();
    expect(a).toBe(b);
  });

  test('_resetDefaultRegistry gives a fresh instance', () => {
    const a = getDefaultRegistry();
    a.register(echoResolver);
    _resetDefaultRegistry();
    const b = getDefaultRegistry();
    expect(b).not.toBe(a);
    expect(b.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// url_reachable builtin
// ---------------------------------------------------------------------------

describe('url_reachable resolver', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('available() is true', async () => {
    expect(await urlReachableResolver.available(makeCtx())).toBe(true);
  });

  test('schema: id + cost + backend match contract', () => {
    expect(urlReachableResolver.id).toBe('url_reachable');
    expect(urlReachableResolver.cost).toBe('free');
    expect(urlReachableResolver.backend).toBe('head-check');
  });

  test('blocks localhost via SSRF guard', async () => {
    const r = await urlReachableResolver.resolve({
      input: { url: 'http://127.0.0.1:1' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
    expect(r.value.reason).toMatch(/internal|private/i);
  });

  test('blocks RFC1918 addresses', async () => {
    const r = await urlReachableResolver.resolve({
      input: { url: 'http://10.0.0.1/' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
  });

  test('blocks AWS metadata endpoint', async () => {
    const r = await urlReachableResolver.resolve({
      input: { url: 'http://169.254.169.254/latest/meta-data/' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
  });

  test('blocks non-http(s) schemes', async () => {
    const r = await urlReachableResolver.resolve({
      input: { url: 'file:///etc/passwd' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
  });

  test('throws schema error for empty url', async () => {
    try {
      await urlReachableResolver.resolve({ input: { url: '' }, context: makeCtx() });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('schema');
    }
  });

  test('200 response → reachable=true', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const r = await urlReachableResolver.resolve({
      input: { url: 'https://example.com/ok' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(true);
    expect(r.value.status).toBe(200);
  });

  test('404 response → reachable=false with status + reason', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    const r = await urlReachableResolver.resolve({
      input: { url: 'https://example.com/dead' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
    expect(r.value.status).toBe(404);
    expect(r.value.reason).toMatch(/HTTP 404/);
  });

  test('HEAD 405 falls back to GET', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      callCount++;
      if (init?.method === 'HEAD') return new Response('', { status: 405 });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const r = await urlReachableResolver.resolve({
      input: { url: 'https://example.com/post-only' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(true);
    expect(callCount).toBe(2);
  });

  test('follows redirect to external URL', async () => {
    const responses = [
      new Response('', { status: 301, headers: { location: 'https://example.org/final' } }),
      new Response('', { status: 200 }),
    ];
    let i = 0;
    globalThis.fetch = (async () => responses[i++]) as typeof fetch;
    const r = await urlReachableResolver.resolve({
      input: { url: 'https://example.com/redirect' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(true);
    expect(r.value.finalUrl).toBe('https://example.org/final');
  });

  test('blocks redirect to internal URL (per-hop SSRF revalidation)', async () => {
    globalThis.fetch = (async () => new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    })) as typeof fetch;
    const r = await urlReachableResolver.resolve({
      input: { url: 'https://example.com/redirects-to-local' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
    expect(r.value.reason).toMatch(/redirect to blocked/i);
  });

  test('fetch network failure → reachable=false, confidence=1', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r = await urlReachableResolver.resolve({
      input: { url: 'https://nonexistent.example/' },
      context: makeCtx(),
    });
    expect(r.value.reachable).toBe(false);
    expect(r.value.reason).toMatch(/fetch error/);
    expect(r.confidence).toBe(1);
  });

  test('checkDnsRebinding: skips IP literals', async () => {
    expect(await checkDnsRebinding('http://8.8.8.8/')).toBeNull();
    expect(await checkDnsRebinding('http://127.0.0.1/')).toBeNull();
    expect(await checkDnsRebinding('http://[::1]/')).toBeNull();
  });

  test('checkDnsRebinding: returns null for unparseable URL', async () => {
    expect(await checkDnsRebinding('not a url')).toBeNull();
  });

  test('checkDnsRebinding: returns null on DNS failure (surface via fetch)', async () => {
    // Nonexistent TLD; DNS lookup fails, we let the fetch surface the error.
    const r = await checkDnsRebinding('http://definitely-not-a-real-tld.invalidtld123/');
    expect(r).toBeNull();
  });

  test('AbortSignal fires mid-flight → ResolverError(aborted)', async () => {
    const ac = new AbortController();
    globalThis.fetch = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    ac.abort();
    try {
      await urlReachableResolver.resolve({
        input: { url: 'https://example.com/' },
        context: makeCtx({ signal: ac.signal }),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolverError);
      expect((e as ResolverError).code).toBe('aborted');
    }
  });
});

// ---------------------------------------------------------------------------
// x_handle_to_tweet builtin
// ---------------------------------------------------------------------------

describe('x_handle_to_tweet resolver', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.X_API_BEARER_TOKEN;

  beforeEach(() => {
    delete process.env.X_API_BEARER_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken) process.env.X_API_BEARER_TOKEN = originalToken;
    else delete process.env.X_API_BEARER_TOKEN;
  });

  // ---- computeBackoffMs ----

  test('computeBackoffMs: honors Retry-After seconds', () => {
    const r = new Response('', { status: 429, headers: { 'retry-after': '10' } });
    expect(computeBackoffMs(r)).toBe(10_000);
  });

  test('computeBackoffMs: honors Retry-After HTTP-date', () => {
    const now = 1_700_000_000_000; // 2023-11-14T22:13:20Z
    const future = new Date(now + 7_000).toUTCString();
    const r = new Response('', { status: 429, headers: { 'retry-after': future } });
    const ms = computeBackoffMs(r, now);
    expect(ms).toBeGreaterThanOrEqual(6_000);
    expect(ms).toBeLessThanOrEqual(8_000);
  });

  test('computeBackoffMs: honors x-rate-limit-reset epoch seconds', () => {
    const now = 1_700_000_000_000;
    const resetSec = Math.floor(now / 1000) + 15;
    const r = new Response('', { status: 429, headers: { 'x-rate-limit-reset': String(resetSec) } });
    expect(computeBackoffMs(r, now)).toBeGreaterThanOrEqual(14_000);
    expect(computeBackoffMs(r, now)).toBeLessThanOrEqual(16_000);
  });

  test('computeBackoffMs: takes MAX when both headers present', () => {
    const now = 1_700_000_000_000;
    const resetSec = Math.floor(now / 1000) + 30;
    const r = new Response('', {
      status: 429,
      headers: { 'retry-after': '5', 'x-rate-limit-reset': String(resetSec) },
    });
    const ms = computeBackoffMs(r, now);
    expect(ms).toBeGreaterThanOrEqual(29_000);
  });

  test('computeBackoffMs: clamps to floor 2s when no headers', () => {
    const r = new Response('', { status: 429 });
    expect(computeBackoffMs(r)).toBeGreaterThanOrEqual(2_000);
  });

  test('computeBackoffMs: clamps to ceiling 60s', () => {
    const now = 1_700_000_000_000;
    const resetSec = Math.floor(now / 1000) + 600; // 10 min
    const r = new Response('', { status: 429, headers: { 'x-rate-limit-reset': String(resetSec) } });
    expect(computeBackoffMs(r, now)).toBeLessThanOrEqual(60_000);
  });

  test('available() false when token missing', async () => {
    expect(await xHandleToTweetResolver.available(makeCtx())).toBe(false);
  });

  test('available() true when token in env', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake-token';
    expect(await xHandleToTweetResolver.available(makeCtx())).toBe(true);
  });

  test('available() true when token in ctx.config', async () => {
    const ctx = makeCtx({ config: { x_api_bearer_token: 'fake-token' } });
    expect(await xHandleToTweetResolver.available(ctx)).toBe(true);
  });

  test('rejects invalid handle (schema)', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'bad handle with spaces' },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('schema');
    }
  });

  test('rejects handle longer than 15 chars', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'a'.repeat(16) },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('schema');
    }
  });

  test('throws unavailable when no token at resolve time', async () => {
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'garrytan' },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('unavailable');
    }
  });

  test('zero candidates → confidence 0', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const r = await xHandleToTweetResolver.resolve({
      input: { handle: 'garrytan', keywords: 'nothing matches' },
      context: makeCtx(),
    });
    expect(r.confidence).toBe(0);
    expect(r.value.candidates).toEqual([]);
    expect(r.value.url).toBeUndefined();
  });

  test('single strong match → confidence >= 0.8 (auto-repair bucket)', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: '123', text: 'talking about building gbrain today', created_at: '2026-04-18T00:00:00Z' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const r = await xHandleToTweetResolver.resolve({
      input: { handle: 'garrytan', keywords: 'building gbrain' },
      context: makeCtx(),
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.value.url).toBe('https://x.com/garrytan/status/123');
    expect(r.value.tweet_id).toBe('123');
  });

  test('single weak-match → confidence in 0.5-0.8 review range', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: '1', text: 'something unrelated entirely', created_at: '2026-04-18T00:00:00Z' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const r = await xHandleToTweetResolver.resolve({
      input: { handle: 'garrytan', keywords: 'gbrain knowledge runtime specific terms' },
      context: makeCtx(),
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThan(0.8);
  });

  test('many ambiguous candidates → confidence < 0.5 (skip bucket)', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      text: 'short noise text ' + i,
      created_at: '2026-04-18T00:00:00Z',
    }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const r = await xHandleToTweetResolver.resolve({
      input: { handle: 'garrytan', keywords: 'completely different signal words unlikely to match' },
      context: makeCtx(),
    });
    expect(r.confidence).toBeLessThan(0.5);
    expect(r.value.candidates.length).toBe(10);
    expect(r.value.url).toBeUndefined(); // gated by >= 0.5
  });

  test('401 → ResolverError(auth)', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'garrytan' },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('auth');
    }
  });

  test('403 → ResolverError(auth)', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'garrytan' },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('auth');
    }
  });

  test('500 → ResolverError(upstream) with body snippet', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    globalThis.fetch = (async () => new Response('internal err', { status: 500 })) as typeof fetch;
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'garrytan' },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('upstream');
      expect((e as ResolverError).message).toMatch(/HTTP 500/);
    }
  });

  test('429 retries then surfaces rate_limited', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('rate', { status: 429, headers: { 'retry-after': '0' } });
    }) as typeof fetch;
    try {
      await xHandleToTweetResolver.resolve({
        input: { handle: 'garrytan' },
        context: makeCtx(),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolverError).code).toBe('rate_limited');
      expect(calls).toBeGreaterThanOrEqual(3); // initial + 2 retries
    }
  });

  test('strips X operators from keyword input (injection defense)', async () => {
    process.env.X_API_BEARER_TOKEN = 'fake';
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await xHandleToTweetResolver.resolve({
      input: { handle: 'garrytan', keywords: 'from:evil_user lang:ja to:someone normal words' },
      context: makeCtx(),
    });
    // Decoded query should still have handle but not extra operators.
    // URLSearchParams encodes spaces as '+', so use token-level assertions.
    const params = new URL(capturedUrl).searchParams;
    const query = params.get('query') ?? '';
    expect(query).toContain('from:garrytan');
    expect(query).not.toContain('from:evil_user');
    expect(query).not.toContain('lang:ja');
    expect(query).not.toContain('to:someone');
    expect(query).toContain('normal');
    expect(query).toContain('words');
  });
});
