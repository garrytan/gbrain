/**
 * connectors-sync checkpoints (PGLite): the watermark and per-conversation
 * sync state are keyed by (provider, source), a capped `--limit` run makes
 * progress across runs, and one permanently failing conversation is
 * quarantined instead of freezing the watermark forever.
 *
 * Real ConnectorClient against the scriptable fixture backend, real ingest,
 * isolated GBRAIN_HOME. No network, no provider spend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runConnectorSync } from '../../src/core/connectors/sync.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { readConnectorState, watermarkKey } from '../../src/core/connectors/config-keys.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import {
  type FixtureConversation,
  type FixtureState,
  chatgptHandler,
  newFixtureState,
  startFixture,
} from '../fixtures/connectors/fixture-server.ts';

let engine: PGLiteEngine;
let tmp: string;
let prevHome: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
});
beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-connectors-ckpt-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = 1_786_000_000;
const NOW_MS = (T0 + 100_000) * 1000;

function conv(id: string, updateTime: number, marker = id): FixtureConversation {
  return { id, title: `Title ${id}`, createTime: updateTime - 100, updateTime,
    turns: [{ role: 'user', text: `question ${marker}` }, { role: 'assistant', text: `answer ${marker}` }] };
}

async function run(state: FixtureState, opts: Record<string, unknown> = {}) {
  const srv = startFixture(chatgptHandler(state));
  try {
    return await runConnectorSync(engine, {
      provider: 'chatgpt',
      sourceId: 'default',
      deps: {
        fetchImpl: (url, init) => fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init),
        now: () => NOW_MS,
        sleep: () => Promise.resolve(),
      },
      ...(opts as object),
    });
  } finally {
    srv.stop();
  }
}

async function conversationPages(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'conversations/chatgpt/%' AND deleted_at IS NULL`, [sourceId]);
  return rows[0].n;
}

describe('connector checkpoints', () => {
  test('the watermark is per source: a second source still receives the full history', async () => {
    const state = newFixtureState([conv('old-1', T0 - 30 * 86_400), conv('new-1', T0 + 10)]);
    const first = await run(state, { sourceId: 'default' });
    expect(first.listed).toBe(2);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('work', 'work') ON CONFLICT DO NOTHING`);

    const second = await run(state, { sourceId: 'work' });

    expect(second.listed).toBe(2);
    expect(await conversationPages('work')).toBe(2);
    expect(await readConnectorState(engine, 'chatgpt', 'work', 'watermark_iso')).toBe(new Date((T0 + 10) * 1000).toISOString());
    expect(await readConnectorState(engine, 'chatgpt', 'default', 'watermark_iso')).toBe(new Date((T0 + 10) * 1000).toISOString());
  });

  test('a legacy per-provider watermark still applies to the scheduled source only', async () => {
    const legacy = new Date((T0 + 5) * 1000).toISOString();
    await engine.setConfig('connectors.chatgpt.watermark_iso', legacy);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('work', 'work') ON CONFLICT DO NOTHING`);
    expect(await readConnectorState(engine, 'chatgpt', 'default', 'watermark_iso')).toBe(legacy);
    expect(await readConnectorState(engine, 'chatgpt', 'work', 'watermark_iso')).toBeNull();
  });

  test('repeated --limit runs make progress and finish with the watermark advanced', async () => {
    const state = newFixtureState([1, 2, 3, 4, 5].map(i => conv(`c-${i}`, T0 + i * 10)));
    const statuses: string[] = [];
    for (let k = 0; k < 3; k++) statuses.push((await run(state, { limit: 2 })).status);

    expect(await conversationPages('default')).toBe(5);
    for (let i = 1; i <= 5; i++) expect(state.hits[`detail:c-${i}`]).toBe(1);
    expect(statuses).toEqual(['partial', 'partial', 'success']);
    expect(await engine.getConfig(watermarkKey('chatgpt', 'default'))).toBe(new Date((T0 + 50) * 1000).toISOString());
  });

  test('an unchanged conversation is not re-fetched while the watermark is held back', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20)]);
    state.script.push({ pathIncludes: '/backend-api/conversation/c-1', status: 404, body: { error: 'gone' } });
    await run(state);
    await run(state);
    expect(state.hits['detail:c-2']).toBe(1);
  });

  test('a permanently failing conversation is quarantined and stops freezing the watermark', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20), conv('c-3', T0 + 30)]);
    state.script.push({ pathIncludes: '/backend-api/conversation/c-1', status: 404, body: { error: 'gone' } });
    const results = [];
    for (let k = 0; k < 4; k++) results.push(await run(state));

    expect(results.slice(0, 3).map(r => r.fetchErrors)).toEqual([1, 1, 1]);
    expect(results[2].watermarkAdvancedTo).toBe(new Date((T0 + 30) * 1000).toISOString());
    expect(results[2].quarantined).toEqual(['c-1']);
    expect(results[3].fetched).toBe(0);
    expect(results[3].status).toBe('nothing_new');
    expect(state.hits['detail:c-2']).toBe(1);
    expect(state.hits['detail:c-3']).toBe(1);

    // An edit to the quarantined conversation earns it a fresh attempt.
    state.script = [];
    state.conversations[0] = conv('c-1', T0 + 40, 'edited');
    const retried = await run(state);
    expect(retried.fetched).toBe(1);
    expect(await conversationPages('default')).toBe(3);
  });

  test('a renamed and continued conversation lands its new messages on the existing page', async () => {
    const state = newFixtureState([conv('c-9', T0 + 10)]);
    await run(state);
    state.conversations[0] = { ...conv('c-9', T0 + 500), title: 'Renamed',
      turns: [...conv('c-9', T0 + 500).turns, { role: 'user', text: 'NEWTURN-MARKER' }, { role: 'assistant', text: 'more' }] };
    const second = await run(state);
    expect(second.ingest?.imported).toBe(1);
    const rows = await engine.executeRaw<{ has_new: boolean }>(
      `SELECT compiled_truth LIKE '%NEWTURN-MARKER%' AS has_new FROM pages WHERE slug LIKE 'conversations/chatgpt/%' AND deleted_at IS NULL`);
    expect(rows).toEqual([{ has_new: true }]);
  });
});
