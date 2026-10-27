/**
 * #7689: connector previews must not change durable state or certify a partial listing.
 * Real client/provider pagination against a local HTTP fixture and real PGLite config;
 * no provider credentials, detail imports, or external network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { saveCredential, credentialPath } from '../src/core/connectors/credentials.ts';
import { authErrorAtKey, connectorSourceKey, lastSyncAtKey, watermarkKey } from '../src/core/connectors/config-keys.ts';
import { runConnectorSync, type ConnectorSyncOpts } from '../src/core/connectors/sync.ts';
import { CHATGPT_BASE_URL } from '../src/core/connectors/providers/chatgpt.ts';
import { chatgptHandler, newFixtureState, startFixture, type FixtureConversation, type FixtureState } from './fixtures/connectors/fixture-server.ts';

let engine: PGLiteEngine;
let home: string;
const T0 = 1_786_000_000;
const NOW = (T0 + 100_000) * 1000;
const keys = [authErrorAtKey('chatgpt'), lastSyncAtKey('chatgpt', 'default'), watermarkKey('chatgpt', 'default'),
  connectorSourceKey('chatgpt', 'default', 'synced'), connectorSourceKey('chatgpt', 'default', 'failed')];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-preview-7689-'));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function conversations(n: number): FixtureConversation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c-${i}`, title: `Topic ${i}`, createTime: T0 + i - 100, updateTime: T0 + i,
    turns: [{ role: 'user', text: `question ${i}` }, { role: 'assistant', text: `answer ${i}` }],
  }));
}

async function preview(state: FixtureState, opts: Partial<ConnectorSyncOpts> = {}) {
  const srv = startFixture(chatgptHandler(state));
  const seen: string[] = [];
  try {
    return await withEnv({
      GBRAIN_HOME: home, GBRAIN_CONNECTOR_CHATGPT_COOKIE: undefined, GBRAIN_CONNECTOR_CHATGPT_TOKEN: undefined,
    }, async () => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
      const credentialBefore = readFileSync(credentialPath('chatgpt'), 'utf8');
      const before = await Promise.all(keys.map(key => engine.getConfig(key)));
      const result = await runConnectorSync(engine, {
        provider: 'chatgpt', dryRun: true, ...opts,
        deps: {
          now: () => NOW, sleep: async () => {},
          fetchImpl: (url, init) => { seen.push(url); return fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init); },
        },
      });
      expect(await Promise.all(keys.map(key => engine.getConfig(key)))).toEqual(before);
      expect(readFileSync(credentialPath('chatgpt'), 'utf8')).toBe(credentialBefore);
      expect(readdirSync(join(home, '.gbrain'))).toEqual(['connectors']);
      expect(seen.some(url => url.includes('/backend-api/conversation/'))).toBe(false);
      expect(result.fetched).toBe(0);
      expect(result.spoolPaths).toEqual([]);
      expect(result.embedKickoff).toBe('none');
      return { result, seen };
    });
  } finally { srv.stop(); }
}

test('empty preview is dry_run, not a last_sync_at write', async () => {
  const { result } = await preview(newFixtureState([]));
  expect(result).toMatchObject({ status: 'dry_run', listed: 0, listComplete: true, wouldFetch: 0 });
});

test('full preview preserves stale failure records while reporting the actual full-sync plan', async () => {
  await engine.setConfig(connectorSourceKey('chatgpt', 'default', 'failed'), JSON.stringify({
    gone: { updatedAt: new Date(T0 * 1000).toISOString(), attempts: 1, lastAttemptAt: new Date(NOW - 1000).toISOString() },
  }));
  const { result } = await preview(newFixtureState(conversations(3)), { full: true, limit: 2 });
  expect(result).toMatchObject({ status: 'dry_run', listed: 3, listComplete: true, wouldFetch: 2, gone: [] });
});

for (const seeded of [false, true]) {
  for (const phase of ['probe', 'list'] as const) {
    test(`${phase} auth refusal does not ${seeded ? 'overwrite' : 'create'} auth_error_at`, async () => {
      if (seeded) await engine.setConfig(authErrorAtKey('chatgpt'), 'historical-auth-error');
      const state = newFixtureState(conversations(1));
      state.script.push({ pathIncludes: '/backend-api/conversations', onCall: phase === 'probe' ? 1 : 2,
        status: 403, body: { error: 'token_expired' } });
      const { result } = await preview(state);
      expect(result.status).toBe('auth_required');
      expect(result.listComplete).toBe(false);
    });
  }
}

for (const failure of ['server', 'rate', 'shape', 'ceiling', 'cancel'] as const) {
  test(`page-two ${failure} keeps listed counts and marks the preview incomplete`, async () => {
    const state = newFixtureState(conversations(35));
    if (failure !== 'ceiling' && failure !== 'cancel') {
      state.script.push({ pathIncludes: 'offset=28', status: failure === 'server' ? 503 : failure === 'rate' ? 429 : 200,
        body: failure === 'shape' ? { unexpected: [] } : { error: 'stop' }, headers: { 'retry-after': '1' } });
    }
    const controller = new AbortController();
    const { result, seen } = await preview(state, {
      ...(failure === 'ceiling' ? { maxRequests: 2 } : {}),
      ...(failure === 'cancel' ? { signal: controller.signal, onProgress: () => controller.abort() } : {}),
    });
    expect(result.status).toBe(failure === 'rate' ? 'rate_limited' : 'partial');
    expect(result.listComplete).toBe(false);
    expect(result.listed).toBe(28);
    if (failure === 'rate') expect(seen.filter(url => url.includes('offset=28'))).toHaveLength(1);
    if (failure === 'ceiling') expect(result.stopReason).toBe('max_requests');
    if (failure === 'server' || failure === 'shape' || failure === 'ceiling') expect(result.wouldFetch).toBe(28);
  });
}

test('complete preview applies the unchanged ledger before the fetch cap', async () => {
  await engine.setConfig(connectorSourceKey('chatgpt', 'default', 'synced'), JSON.stringify({
    'c-2': new Date((T0 + 2) * 1000).toISOString(),
  }));
  const { result } = await preview(newFixtureState(conversations(3)), { limit: 1 });
  expect(result).toMatchObject({ status: 'dry_run', listComplete: true, wouldFetch: 1, skippedUnchanged: 1 });
});
