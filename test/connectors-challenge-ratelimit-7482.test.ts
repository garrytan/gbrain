/**
 * #7482: a bot challenge on any status, and sustained rate limiting, stop the connector sync instead of retrying.
 *
 * 1. Protects: cf-mitigated: challenge (any status), a challenge page on a 5xx, and a redirect to a challenge all
 *    classify as forbidden; a 429 that outlasts its retries, or asks for a Retry-After over the cap, ends the run as
 *    rate_limited at once; CONSECUTIVE_FETCH_FAILURE_LIMIT failed fetches in a row stop the run as partial with
 *    stopReason consecutive_fetch_failures when each failure is provider-wide (5xx or no response), and no later
 *    conversation is requested; 404s and other item errors never trip it.
 * 2. Fails when: any of those shapes falls back to the generic retry path, or the sync keeps fetching after them.
 * 3. A Cloudflare 5xx error page (it names "cloudflare" but is no challenge) stays a retryable server_error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { classifyResponse } from '../src/core/connectors/classify.ts';
import { ConnectorClient, ConnectorRateLimitedError, MAX_RETRY_AFTER_MS, type ConnectorFetch } from '../src/core/connectors/client.ts';
import { CONSECUTIVE_FETCH_FAILURE_LIMIT, runConnectorSync } from '../src/core/connectors/sync.ts';
import { saveCredential } from '../src/core/connectors/credentials.ts';
import { watermarkKey } from '../src/core/connectors/config-keys.ts';
import { CHATGPT_BASE_URL } from '../src/core/connectors/providers/chatgpt.ts';
import { chatgptHandler, newFixtureState, startFixture, type FixtureConversation, type FixtureState } from './fixtures/connectors/fixture-server.ts';

function res(status: number, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return { status, headers: { get: (n: string) => h.get(n) } };
}

const CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl</body></html>';

describe('#7482 classifyResponse: a challenge on any status is forbidden', () => {
  for (const status of [200, 401, 403, 429, 503]) {
    test(`HTTP ${status} + cf-mitigated: challenge → forbidden_fingerprint`, () => {
      expect(classifyResponse(res(status, { 'cf-mitigated': 'challenge', 'content-type': 'application/json' }), '{}').kind).toBe('forbidden_fingerprint');
    });
  }
  test('503 serving a challenge page → forbidden_fingerprint', () => {
    expect(classifyResponse(res(503, { 'content-type': 'text/html' }), CHALLENGE_HTML).kind).toBe('forbidden_fingerprint');
  });
  test('302 to a Cloudflare challenge path → forbidden_fingerprint', () => {
    expect(classifyResponse(res(302, { location: '/cdn-cgi/challenge-platform/h/b/orchestrate' }), '').kind).toBe('forbidden_fingerprint');
  });
  test('a Cloudflare 502 error page (no challenge) stays a retryable server_error', () => {
    const body = '<!DOCTYPE html><html><title>502 Bad gateway | example.com | Cloudflare</title></html>';
    expect(classifyResponse(res(502, { 'content-type': 'text/html' }), body).kind).toBe('server_error');
  });
  test('a 302 to a login page with a code_challenge is not mistaken for a bot challenge', () => {
    expect(classifyResponse(res(302, { location: '/auth/login?code_challenge=abc' }), '').kind).toBe('server_error');
  });
});

describe('#7482 ConnectorClient rate limiting is bounded', () => {
  const json429 = (retryAfter?: string) => new Response('{"error":"slow down"}', { status: 429, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) } });

  test('a Retry-After over the cap stops at once: no wait, no retry', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new ConnectorClient({
      baseUrl: 'https://chatgpt.com', headers: async () => ({}), minDelayMs: 0,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: async () => { calls++; return json429(String(MAX_RETRY_AFTER_MS / 1000 + 1)); },
    });
    const e = await client.fetchJSON('/x').then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(ConnectorRateLimitedError);
    expect((e as ConnectorRateLimitedError).code).toBe('rate_limited');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('sustained 429s: the existing 4 retries, then ConnectorRateLimitedError', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new ConnectorClient({
      baseUrl: 'https://chatgpt.com', headers: async () => ({}), minDelayMs: 0,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: async () => { calls++; return json429('2'); },
    });
    await expect(client.fetchJSON('/x')).rejects.toBeInstanceOf(ConnectorRateLimitedError);
    expect(calls).toBe(5);
    expect(sleeps).toEqual([2000, 2000, 2000, 2000]);
  });
});

let engine: PGLiteEngine;
let home: string;
const T0 = 1_786_000_000;
const NOW_MS = (T0 + 100_000) * 1000;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'gbrain-connector-7482-'));
});

function conversations(n: number): FixtureConversation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c-${i}`, title: `Topic ${i}`, createTime: T0 + i - 100, updateTime: T0 + i,
    turns: [{ role: 'user' as const, text: `q${i}` }, { role: 'assistant' as const, text: `a${i}` }],
  }));
}

/** Detail requests per conversation id, read from the fixture's hit counters. */
function detailHits(state: FixtureState): number {
  return state.hits.detail ?? 0;
}

async function sync(state: FixtureState) {
  const srv = startFixture(chatgptHandler(state));
  const fetchImpl: ConnectorFetch = (url, init) => fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init);
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_CONNECTOR_CHATGPT_COOKIE: undefined, GBRAIN_CONNECTOR_CHATGPT_TOKEN: undefined }, async () => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
      return runConnectorSync(engine, { provider: 'chatgpt', sourceId: 'default', deps: { fetchImpl, now: () => NOW_MS, sleep: () => Promise.resolve() } });
    });
  } finally {
    srv.stop();
  }
}

describe('#7482 runConnectorSync stops instead of retrying', () => {
  test('a 503 challenge midway through the fetch phase → forbidden; no later conversation is requested', async () => {
    const state = newFixtureState(conversations(8));
    state.script.push({ pathIncludes: '/backend-api/conversation/', status: 503, body: CHALLENGE_HTML, contentType: 'text/html', onCall: 3 });
    const r = await sync(state);
    expect(r.status).toBe('forbidden');
    expect(r.fetched).toBe(2);
    expect(detailHits(state)).toBe(2);
    expect(state.hits['forced:/backend-api/conversation/:503']).toBe(3);
  });

  test('sustained 429s on conversation detail → rate_limited after the first conversation\'s retries', async () => {
    const state = newFixtureState(conversations(8));
    state.script.push({ pathIncludes: '/backend-api/conversation/', status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '1' } });
    const r = await sync(state);
    expect(r.status).toBe('rate_limited');
    expect(r.hint).toMatch(/rate limit/i);
    expect(state.hits['forced:/backend-api/conversation/:429']).toBe(5);
    expect(r.fetchErrors).toBe(0);
    expect(await engine.getConfig(watermarkKey('chatgpt', 'default'))).toBeNull();
  });

  test('a 429 while listing → rate_limited, and no conversation detail is fetched', async () => {
    const state = newFixtureState(conversations(8));
    state.script.push({ pathIncludes: 'limit=28', status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '1' } });
    const r = await sync(state);
    expect(r.status).toBe('rate_limited');
    expect(state.hits['forced:limit=28:429']).toBe(5);
    expect(state.hits['forced:/backend-api/conversation/:429'] ?? 0).toBe(0);
    expect(detailHits(state)).toBe(0);
  });

  test(`${CONSECUTIVE_FETCH_FAILURE_LIMIT} failed fetches in a row stop the run (partial, consecutive_fetch_failures)`, async () => {
    const state = newFixtureState(conversations(12));
    state.script.push({ pathIncludes: '/backend-api/conversation/', status: 500, body: { error: 'boom' } });
    const r = await sync(state);
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('consecutive_fetch_failures');
    expect(r.fetchErrors).toBe(CONSECUTIVE_FETCH_FAILURE_LIMIT);
    expect(state.hits['forced:/backend-api/conversation/:500']).toBe(CONSECUTIVE_FETCH_FAILURE_LIMIT * 5);
    expect(r.hint).toContain('in a row');
    expect(await engine.getConfig(watermarkKey('chatgpt', 'default'))).toBeNull();
  });

  test('item errors (404s) do not trip the breaker: the provider is answering', async () => {
    const state = newFixtureState(conversations(12));
    state.script.push({ pathIncludes: '/backend-api/conversation/', status: 404, body: { error: 'gone' } });
    const r = await sync(state);
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBeUndefined();
    expect(r.fetchErrors).toBe(12);
  });
});
