/**
 * #7689 (part 2): `connectors sync --dry-run` is a preview, yet it stamped
 * `last_sync_at` when the listing came back empty and `auth_error_at` when the
 * probe or listing hit an auth error, and a dry run whose listing stopped part
 * way (a 5xx on page 2) still reported `dry_run`, so a caller could not tell a
 * complete preview from a truncated one.
 *
 * Protects: a dry run writes no connector config state on any of those paths;
 * a dry run whose listing did not finish returns `partial` with
 * `listComplete: false` and the count it would fetch; a complete one returns
 * `dry_run` with `listComplete: true`. Part 1 (stop at the first 429) is a
 * policy question and is not covered here.
 * Seams: the real ConnectorClient against the Bun.serve fixture backend; PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runConnectorSync } from '../src/core/connectors/sync.ts';
import { saveCredential } from '../src/core/connectors/credentials.ts';
import { CHATGPT_BASE_URL } from '../src/core/connectors/providers/chatgpt.ts';
import type { ConnectorFetch } from '../src/core/connectors/client.ts';
import { type FixtureConversation, type FixtureState, chatgptHandler, newFixtureState, startFixture } from './fixtures/connectors/fixture-server.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gb-connectors-7689-'));
  return () => rmSync(home, { recursive: true, force: true });
});

const T0 = 1_786_000_000;
const NOW_MS = (T0 + 100_000) * 1000;

function conv(id: string, updateTime: number): FixtureConversation {
  return { id, title: `Synthetic ${id}`, createTime: updateTime - 100, updateTime, turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] };
}

async function dryRun(state: FixtureState) {
  const srv = startFixture(chatgptHandler(state));
  try {
    return await withEnv({ GBRAIN_HOME: home }, async () => {
      saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
      const rewrite: ConnectorFetch = (url, init) => fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init);
      return runConnectorSync(engine, {
        provider: 'chatgpt',
        sourceId: 'default',
        dryRun: true,
        deps: { fetchImpl: rewrite, now: () => NOW_MS, sleep: () => Promise.resolve() },
      });
    });
  } finally {
    srv.stop();
  }
}

async function connectorConfig(): Promise<Array<{ key: string; value: string }>> {
  return engine.executeRaw<{ key: string; value: string }>("SELECT key, value FROM config WHERE key LIKE 'connectors.%' ORDER BY key");
}

describe('#7689: connectors sync --dry-run is a pure preview', () => {
  test('an empty listing writes no last_sync_at', async () => {
    const r = await dryRun(newFixtureState([]));
    expect(r.status).toBe('nothing_new');
    expect(await connectorConfig()).toEqual([]);
  });

  test('an auth error on the probe writes no auth_error_at', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10)]);
    state.script.push({ pathIncludes: 'conversations?offset=0&limit=1&', status: 401, body: { detail: 'unauthorized' } });
    const r = await dryRun(state);
    expect(r.status).toBe('auth_required');
    expect(await connectorConfig()).toEqual([]);
  });

  test('an auth error on the listing writes no auth_error_at', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10)]);
    state.script.push({ pathIncludes: 'conversations?offset=0&limit=28&', status: 401, body: { detail: 'unauthorized' } });
    const r = await dryRun(state);
    expect(r.status).toBe('auth_required');
    expect(await connectorConfig()).toEqual([]);
  });

  test('a listing that fails part way reports partial with listComplete false', async () => {
    const convs = Array.from({ length: 40 }, (_, i) => conv(`c-${i}`, T0 + i));
    const state = newFixtureState(convs);
    state.script.push({ pathIncludes: 'conversations?offset=28', status: 500, body: { detail: 'server error' } });
    const r = await dryRun(state);
    expect(r).toMatchObject({ status: 'partial', listed: 28, listComplete: false, wouldFetch: 28 });
    expect(state.hits.detail ?? 0).toBe(0);
    expect(await connectorConfig()).toEqual([]);
  });

  test('a complete listing reports dry_run with listComplete true', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20)]);
    const r = await dryRun(state);
    expect(r).toMatchObject({ status: 'dry_run', listed: 2, listComplete: true, wouldFetch: 2 });
    expect(await connectorConfig()).toEqual([]);
  });
});
