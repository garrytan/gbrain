/**
 * connectors-sync checkpoints (PGLite): the watermark and per-conversation
 * sync state are keyed by (provider, source), a capped `--limit` run makes
 * progress across runs, and one permanently failing conversation is
 * quarantined instead of freezing the watermark forever.
 *
 * Real ConnectorClient against the scriptable fixture backend, real ingest,
 * isolated GBRAIN_HOME. No network, no provider spend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runConnectorSync } from '../../src/core/connectors/sync.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { readConnectorState, watermarkKey } from '../../src/core/connectors/config-keys.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import { CLAUDE_BASE_URL } from '../../src/core/connectors/providers/claude.ts';
import { connectorsHealthCheck } from '../../src/commands/doctor/checks/connectors.ts';
import { runConnectorStatus } from '../../src/commands/connectors/status.ts';
import { connectorsOperations } from '../../src/core/ops/connectors.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import {
  type FixtureConversation,
  type FixtureState,
  chatgptHandler,
  claudeHandler,
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
  test('cancelling a due retry mid-fetch preserves its eligibility and earlier batch progress', async () => {
    const state = newFixtureState([conv('old-a', T0 - 30 * 86_400), conv('old-b', T0 - 30 * 86_400)]);
    const key = 'connectors.chatgpt.source.default.failed';
    const failure = { attempts: 3, updatedAt: new Date((T0 - 30 * 86_400) * 1000).toISOString() };
    await engine.setConfig(key, JSON.stringify({ 'old-a': failure, 'old-b': failure }));
    await engine.setConfig(watermarkKey('chatgpt', 'default'), new Date(T0 * 1000).toISOString());
    const controller = new AbortController();
    const srv = startFixture(chatgptHandler(state));
    try {
      const cancelled = await runConnectorSync(engine, { provider: 'chatgpt', signal: controller.signal, deps: {
        fetchImpl: (url, init) => {
          if (url.includes('/conversation/old-b')) {
            controller.abort();
            throw new DOMException('Aborted', 'AbortError');
          }
          return fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init);
        },
        now: () => NOW_MS, sleep: () => Promise.resolve(),
      } });
      expect(cancelled.status).toBe('partial');
      expect(cancelled.fetchErrors).toBe(0);
      expect(cancelled.fetched).toBe(1);
      expect(JSON.parse((await engine.getConfig(key))!)).toEqual({ 'old-b': failure });
      expect(await conversationPages('default')).toBe(1);
      expect((await run(state)).fetched).toBe(1);
      expect(JSON.parse((await engine.getConfig(key))!)).toEqual({});
    } finally { srv.stop(); }
  });

  test('failed targeted attempts back off; auth failure and cancellation never erase the omission', async () => {
    const state = newFixtureState([conv('old-failure', T0 - 30 * 86_400)]);
    const key = 'connectors.chatgpt.source.default.failed';
    const failure = { 'old-failure': { attempts: 3, updatedAt: new Date((T0 - 30 * 86_400) * 1000).toISOString() } };
    await engine.setConfig(key, JSON.stringify(failure));
    await engine.setConfig(watermarkKey('chatgpt', 'default'), new Date(T0 * 1000).toISOString());
    state.script.push({ pathIncludes: '/backend-api/conversation/old-failure', status: 401, body: { error: 'expired' } });
    expect((await run(state)).status).toBe('auth_required');
    expect(await engine.getConfig(key)).toBe(JSON.stringify(failure));
    state.script = [{ pathIncludes: '/backend-api/conversation/old-failure', status: 404, body: { error: 'gone' } }];
    expect((await run(state)).fetchErrors).toBe(1);
    const retained = (await engine.getConfig(key))!;
    expect(JSON.parse(retained)['old-failure'].attempts).toBe(4);
    expect((await run(state)).fetchErrors).toBe(0);
    expect(await engine.getConfig(key)).toBe(retained);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(state, { signal: controller.signal });
    expect(cancelled.status).toBe('partial');
    expect(await engine.getConfig(key)).toBe(retained);
    state.script = [];
    expect((await run(state, { full: true })).fetched).toBe(1);
    expect(JSON.parse((await engine.getConfig(key))!)).toEqual({});
  });

  test('retained omissions are visible in CLI/op status and doctor, scoped to the scheduled source', async () => {
    const key = 'connectors.chatgpt.source.default.failed';
    const failure = { 'old-failure': { attempts: 3, updatedAt: new Date(T0 * 1000).toISOString() } };
    await engine.setConfig(key, JSON.stringify(failure));
    const op = connectorsOperations.find(op => op.name === 'connectors_status')!;
    const ctx: OperationContext = { engine, remote: false, sourceId: 'default', dryRun: false,
      config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } };
    const status = await op.handler(ctx, { provider: 'chatgpt' }) as { providers: Array<{ unresolved: unknown }> };
    expect(status.providers[0].unresolved).toEqual(failure);
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runConnectorStatus(engine, ['chatgpt', '--json']);
      expect(JSON.parse(output.mock.calls[0][0]).providers[0].unresolved).toEqual(failure);
    } finally { output.mockRestore(); }
    const health = await connectorsHealthCheck(engine);
    expect(health.status).toBe('warn');
    expect(health.message).toContain('archive incomplete');
    await engine.setConfig('connectors.source_id', 'work');
    expect((await connectorsHealthCheck(engine)).status).toBe('ok');
    expect(await engine.getConfig(key)).toBe(JSON.stringify(failure));
  });

  test('targeted retries respect preview, fetch caps and source isolation', async () => {
    const state = newFixtureState([conv('old-a', T0 - 30 * 86_400), conv('old-b', T0 - 30 * 86_400)]);
    const failed = Object.fromEntries(state.conversations.map(c => [c.id, { attempts: 3, updatedAt: new Date(c.updateTime * 1000).toISOString() }]));
    const key = 'connectors.chatgpt.source.default.failed';
    await engine.setConfig(watermarkKey('chatgpt', 'default'), new Date(T0 * 1000).toISOString());
    await engine.setConfig(key, JSON.stringify(failed));
    const preview = await run(state, { dryRun: true });
    expect(preview.status).toBe('dry_run');
    expect(preview.hint).toContain('2 conversation(s)');
    expect(state.hits.detail ?? 0).toBe(0);
    expect(await engine.getConfig(key)).toBe(JSON.stringify(failed));
    expect(await readConnectorState(engine, 'chatgpt', 'default', 'last_sync_at')).toBeNull();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('work', 'work') ON CONFLICT DO NOTHING`);
    await engine.setConfig(watermarkKey('chatgpt', 'work'), new Date(T0 * 1000).toISOString());
    const other = await run(state, { sourceId: 'work' });
    expect(other.fetched).toBe(0);
    expect(await engine.getConfig(key)).toBe(JSON.stringify(failed));
    const capped = await run(state, { limit: 1 });
    expect(capped.status).toBe('partial');
    expect(capped.fetched).toBe(1);
    expect(Object.keys(JSON.parse((await engine.getConfig(key))!))).toEqual(['old-b']);
    const next = await run(state, { limit: 1 });
    expect(next.fetched).toBe(1);
    expect(next.status).toBe('success');
    expect(await conversationPages('default')).toBe(2);
  });

  test('a Claude retry below the list floor retains its second-organization routing across fresh clients', async () => {
    saveCredential({ provider: 'claude', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
    const state = newFixtureState([conv('old-org-b', T0 - 30 * 86_400), conv('new-org-b', T0)]);
    state.claudeOrg = 'org-b';
    state.script.push({ pathIncludes: '/chat_conversations/old-org-b?', status: 404, body: { error: 'gone' } });
    const handler = claudeHandler(state);
    const paths: string[] = [];
    let hideOldFromList = false;
    const srv = startFixture(req => {
      const url = new URL(req.url);
      paths.push(url.pathname + url.search);
      if (url.pathname === '/api/organizations') return Response.json([{ uuid: 'org-a' }, { uuid: 'org-b' }]);
      if (url.pathname.startsWith('/api/organizations/org-a/')) return Response.json([]);
      // Force the old conversation off the first page after the watermark advances.
      if (url.pathname.endsWith('/chat_conversations') && url.searchParams.get('limit') === '100') {
        const rows = state.conversations.filter(c => c.updateTime >= T0).map(c => ({ uuid: c.id, updated_at: new Date(c.updateTime * 1000).toISOString() }));
        if (hideOldFromList) return Response.json(url.searchParams.get('offset') === '0' ? rows : []);
      }
      return handler(req);
    });
    const sync = (now: number) => runConnectorSync(engine, { provider: 'claude', deps: {
      fetchImpl: (url, init) => fetch(url.replace(CLAUDE_BASE_URL, srv.baseUrl), init),
      now: () => now, sleep: () => Promise.resolve(),
    } });
    try {
      for (let k = 0; k < 3; k++) await sync(NOW_MS);
      const failure = JSON.parse((await engine.getConfig('connectors.claude.source.default.failed'))!);
      expect(failure['old-org-b'].orgId).toBe('org-b');
      state.script = [];
      hideOldFromList = true;
      const recovered = await sync(NOW_MS + 86_400_000);
      expect(recovered.listed).toBe(1);
      expect(recovered.fetched).toBe(1);
      expect(recovered.status).toBe('success');
      expect(paths.filter(p => p.includes('/org-a/chat_conversations/old-org-b'))).toEqual([]);
      expect(JSON.parse((await engine.getConfig('connectors.claude.source.default.failed'))!)).toEqual({});
    } finally { srv.stop(); }
  });

  test('old quarantined failures survive watermark pruning and recover without a full listing', async () => {
    const state = newFixtureState([conv('old-failure', T0 - 30 * 86_400), conv('new-ok', T0)]);
    state.script.push({ pathIncludes: '/backend-api/conversation/old-failure', status: 404, body: { error: 'gone' } });
    for (let k = 0; k < 3; k++) await run(state);
    const key = 'connectors.chatgpt.source.default.failed';
    const failed = JSON.parse((await engine.getConfig(key))!);
    expect(failed['old-failure']?.attempts).toBe(3);
    expect(await readConnectorState(engine, 'chatgpt', 'default', 'watermark_iso')).toBe(new Date(T0 * 1000).toISOString());
    state.script = [];
    const cooling = await run(state);
    expect(cooling.status).toBe('partial');
    expect(cooling.quarantined).toEqual(['old-failure']);
    expect(cooling.fetched).toBe(0);
    const srv = startFixture(chatgptHandler(state));
    try {
      const recovered = await runConnectorSync(engine, {
        provider: 'chatgpt', deps: {
          fetchImpl: (url, init) => fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init),
          now: () => NOW_MS + 86_400_000, sleep: () => Promise.resolve(),
        },
      });
      expect(recovered.listed).toBe(1);
      expect(recovered.fetched).toBe(1);
      expect(recovered.status).toBe('success');
      expect(recovered.quarantined).toEqual([]);
      expect(await conversationPages('default')).toBe(2);
      expect(JSON.parse((await engine.getConfig(key))!)).toEqual({});
      expect(state.hits['detail:new-ok']).toBe(1);
    } finally { srv.stop(); }
  });

  test('a retained legacy failure is retried even when the incremental list is empty', async () => {
    const state = newFixtureState([conv('old-failure', T0 - 30 * 86_400)]);
    await engine.setConfig(watermarkKey('chatgpt', 'default'), new Date(T0 * 1000).toISOString());
    await engine.setConfig('connectors.chatgpt.source.default.failed', JSON.stringify({
      'old-failure': { attempts: 3, updatedAt: new Date((T0 - 30 * 86_400) * 1000).toISOString() },
    }));
    const recovered = await run(state);
    expect(recovered.listed).toBe(0);
    expect(recovered.fetched).toBe(1);
    expect(await conversationPages('default')).toBe(1);
  });

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
    expect(results[3].status).toBe('partial');
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
