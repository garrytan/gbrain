/**
 * connectors-sync checkpoints (PGLite): the watermark and per-conversation
 * sync state are keyed by (provider, source), a capped `--limit` run makes
 * progress across runs, and one permanently failing conversation is
 * quarantined instead of freezing the watermark forever.
 *
 * #6387: a failed conversation stays in the `failed` ledger until it imports,
 * even after the watermark passes it, and is retried by id on a backoff
 * (inside a per-run budget that `--limit` cannot starve), so recovering at
 * the provider is enough to archive it. #6388: a long message keeps its tail.
 * Both describe the installed-state recovery: an archive written before the
 * fix recovers with one (consent-gated) `connectors sync --full`.
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
import { connectorSourceKey, readConnectorState, watermarkKey } from '../../src/core/connectors/config-keys.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import { CLAUDE_BASE_URL } from '../../src/core/connectors/providers/claude.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
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

interface RunExtras {
  nowMs?: number;
  runIngest?: typeof runTranscriptsIngest;
  onFetch?: (url: string) => void;
}

async function run(state: FixtureState, opts: Record<string, unknown> = {}, extras: RunExtras = {}) {
  const srv = startFixture(chatgptHandler(state));
  try {
    return await runConnectorSync(engine, {
      provider: 'chatgpt',
      sourceId: 'default',
      deps: {
        fetchImpl: (url, init) => {
          extras.onFetch?.(url);
          return fetch(url.replace(CHATGPT_BASE_URL, srv.baseUrl), init);
        },
        now: () => extras.nowMs ?? NOW_MS,
        sleep: () => Promise.resolve(),
        ...(extras.runIngest ? { runIngest: extras.runIngest } : {}),
      },
      ...(opts as object),
    });
  } finally {
    srv.stop();
  }
}

const HOUR = 3_600_000;
const DAY_S = 86_400;

async function failedLedger(provider: 'chatgpt' | 'claude' = 'chatgpt'): Promise<Record<string, { attempts: number; updatedAt: string; nextRetryAt?: string; orgId?: string }>> {
  return JSON.parse((await engine.getConfig(connectorSourceKey(provider, 'default', 'failed'))) || '{}');
}

async function hasText(marker: string, provider = 'chatgpt'): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug LIKE $1 AND deleted_at IS NULL AND compiled_truth LIKE $2`,
    [`conversations/${provider}/%`, `%${marker}%`]);
  return rows[0].n > 0;
}

/** Fail `ids` until quarantine (QUARANTINE_ATTEMPTS runs at NOW_MS); the watermark then passes them. */
async function quarantine(state: FixtureState, ids: string[], opts: Record<string, unknown> = {}) {
  for (const id of ids) state.script.push({ pathIncludes: `/backend-api/conversation/${id}`, status: 404, body: { error: 'flaky' } });
  const results = [];
  for (let k = 0; k < 3; k++) results.push(await run(state, opts));
  return results;
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
    // #6387: a quarantined conversation is unresolved, not "nothing new".
    expect(results[3].status).toBe('partial');
    expect(results[3].unresolved).toBe(1);
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

describe('#6387 failed conversations are retained until they import', () => {
  test('an old conversation quarantined during backfill imports once the provider recovers, after the watermark passed it', async () => {
    const state = newFixtureState([conv('old-failure', T0 - 30 * DAY_S), conv('new-ok', T0)]);
    const first = await quarantine(state, ['old-failure']);
    expect(first[2].quarantined).toEqual(['old-failure']);
    expect(first[2].watermarkAdvancedTo).toBe(new Date(T0 * 1000).toISOString());
    expect(first[2].status).toBe('partial');
    expect(Object.keys(await failedLedger())).toEqual(['old-failure']);

    state.script = [];
    const recovered = await run(state, {}, { nowMs: NOW_MS + 2 * HOUR });
    expect(recovered.fetched).toBe(1);
    expect(recovered.status).toBe('success');
    expect(recovered.unresolved).toBe(0);
    expect(await conversationPages('default')).toBe(2);
    expect(await failedLedger()).toEqual({});
    expect(state.hits['detail:new-ok']).toBe(1);
  });

  test('an empty listing still retries a due failure, and reports partial while it is not due yet', async () => {
    const state = newFixtureState([conv('old-1', T0 - 30 * DAY_S), conv('new-1', T0)]);
    await quarantine(state, ['old-1'], { windowDays: 0 });
    state.script = [];

    const notDue = await run(state, { windowDays: 0 }, { nowMs: NOW_MS + 60_000 });
    expect(notDue.listed).toBe(0);
    expect(notDue.fetched).toBe(0);
    expect(notDue.status).toBe('partial');
    expect(notDue.unresolved).toBe(1);
    expect(state.hits['detail:old-1']).toBeUndefined();

    const due = await run(state, { windowDays: 0 }, { nowMs: NOW_MS + 2 * HOUR });
    expect(due.listed).toBe(0);
    expect(due.fetched).toBe(1);
    expect(due.status).toBe('success');
    expect(await conversationPages('default')).toBe(2);
  });

  test('at most 10 retries run per sync, oldest-due first, so the rest get their turn next', async () => {
    const olds = Array.from({ length: 12 }, (_, i) => conv(`old-${i}`, T0 - (30 + i) * DAY_S));
    const state = newFixtureState([...olds, conv('new-1', T0)]);
    await quarantine(state, olds.map(c => c.id));
    // The client retries a 404 within one fetch, so count distinct conversations.
    const detailIds = (urls: string[]) => [...new Set(urls.flatMap(u => u.match(/\/backend-api\/conversation\/([^/?]+)$/)?.[1] ?? []))];

    const fetchedA: string[] = [];
    const a = await run(state, {}, { nowMs: NOW_MS + 2 * HOUR, onFetch: u => fetchedA.push(u) });
    expect(detailIds(fetchedA)).toHaveLength(10);
    expect(a.unresolved).toBe(12);
    expect(a.status).toBe('partial');

    const fetchedB: string[] = [];
    await run(state, {}, { nowMs: NOW_MS + 2 * HOUR + 60_000, onFetch: u => fetchedB.push(u) });
    expect(detailIds(fetchedB)).toHaveLength(2);
    expect(new Set([...detailIds(fetchedA), ...detailIds(fetchedB)])).toEqual(new Set(olds.map(c => c.id)));
  });

  test('--limit keeps capacity for due retries while new conversations keep arriving', async () => {
    const state = newFixtureState([conv('old-1', T0 - 30 * DAY_S), conv('new-0', T0)]);
    await quarantine(state, ['old-1']);
    state.script = [];
    for (let i = 1; i <= 5; i++) state.conversations.push(conv(`fresh-${i}`, T0 + i * 10));

    const r = await run(state, { limit: 3 }, { nowMs: NOW_MS + 2 * HOUR });
    expect(state.hits['detail:old-1']).toBe(1);
    expect(r.fetched).toBe(3);
    expect(await failedLedger()).toEqual({});
    expect(r.status).toBe('partial');
  });

  test('an abort mid-fetch is not counted against the conversation', async () => {
    const state = newFixtureState([conv('c-1', T0 + 10), conv('c-2', T0 + 20)]);
    const ac = new AbortController();
    const r = await run(state, { signal: ac.signal }, {
      onFetch: (url) => { if (url.includes('/backend-api/conversation/c-1')) ac.abort(); },
    });
    expect(r.watermarkAdvancedTo).toBeUndefined();
    expect(await failedLedger()).toEqual({});
    const next = await run(state);
    expect(next.status).toBe('success');
    expect(await conversationPages('default')).toBe(2);
  });

  test('an ingest that throws keeps the unresolved record', async () => {
    const state = newFixtureState([conv('old-1', T0 - 30 * DAY_S), conv('new-1', T0)]);
    await quarantine(state, ['old-1']);
    state.script = [];
    const broken: typeof runTranscriptsIngest = async () => { throw new Error('database went away'); };
    await expect(run(state, {}, { nowMs: NOW_MS + 2 * HOUR, runIngest: broken })).rejects.toThrow(/database went away/);
    expect(Object.keys(await failedLedger())).toEqual(['old-1']);
    const r = await run(state, {}, { nowMs: NOW_MS + 2 * HOUR });
    expect(r.status).toBe('success');
  });

  test('--full drops a failure whose conversation the provider no longer lists', async () => {
    const state = newFixtureState([conv('old-1', T0 - 30 * DAY_S), conv('new-1', T0)]);
    await quarantine(state, ['old-1']);
    state.conversations = state.conversations.filter(c => c.id !== 'old-1');
    const r = await run(state, { full: true }, { nowMs: NOW_MS + 60_000 });
    expect(r.gone).toEqual(['old-1']);
    expect(r.unresolved).toBe(0);
    expect(await failedLedger()).toEqual({});
  });

  test('upgrade state: a failure pruned before the fix is recovered by connectors sync --full', async () => {
    // Pre-fix brains: the watermark passed the conversation, the prune emptied the
    // ledger, and the conversation was never imported. Nothing records it.
    const state = newFixtureState([conv('new-ok', T0)]);
    await run(state);
    state.conversations.push(conv('lost-old', T0 - 30 * DAY_S));
    await engine.setConfig(connectorSourceKey('chatgpt', 'default', 'failed'), '{}');

    const ordinary = await run(state);
    expect(ordinary.fetched).toBe(0);
    expect(await conversationPages('default')).toBe(1);

    const full = await run(state, { full: true });
    expect(full.status).toBe('success');
    expect(state.hits['detail:lost-old']).toBe(1);
    expect(await conversationPages('default')).toBe(2);
  });
});

describe('#6388 long messages through the connector', () => {
  const longText = `${'x'.repeat(5000)}END-OF-MESSAGE-MARKER`;
  const longConv = (text: string): FixtureConversation => ({
    id: 'long-1', title: 'Long', createTime: T0 - 100, updateTime: T0,
    turns: [{ role: 'user', text }, { role: 'assistant', text: 'ok' }],
  });

  test('a 5,000-character message is archived with its tail, and an unchanged rerun fetches nothing', async () => {
    const state = newFixtureState([longConv(longText)]);
    const r = await run(state);
    expect(r.status).toBe('success');
    expect(await hasText('END-OF-MESSAGE-MARKER')).toBe(true);
    const again = await run(state);
    expect(again.fetched).toBe(0);
  });

  test('upgrade state: a page archived truncated before the fix recovers with connectors sync --full', async () => {
    // The pre-fix renderer kept the first 4,000 characters and the sync ledger
    // recorded the conversation as synced at this updatedAt.
    const state = newFixtureState([longConv(longText.slice(0, 4000))]);
    await run(state);
    state.conversations = [longConv(longText)];

    const ordinary = await run(state);
    expect(ordinary.fetched).toBe(0);
    expect(await hasText('END-OF-MESSAGE-MARKER')).toBe(false);

    const full = await run(state, { full: true });
    expect(full.fetched).toBe(1);
    expect(await hasText('END-OF-MESSAGE-MARKER')).toBe(true);
    expect(await conversationPages('default')).toBe(1);
  });
});

describe('#6387 Claude retries use the organization that listed the conversation', () => {
  interface OrgConv { org: string; id: string; updateTime: number; fail?: boolean }

  function twoOrgHandler(convs: OrgConv[], hits: string[]) {
    return (req: Request): Response => {
      const url = new URL(req.url);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/organizations') return json([{ uuid: 'org-a' }, { uuid: 'org-b' }]);
      const list = url.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations$/);
      if (list) {
        if (Number(url.searchParams.get('offset') ?? '0') > 0) return json([]);
        return json(convs.filter(c => c.org === list[1]).sort((a, b) => b.updateTime - a.updateTime).map(c => ({
          uuid: c.id, name: c.id, created_at: new Date((c.updateTime - 100) * 1000).toISOString(), updated_at: new Date(c.updateTime * 1000).toISOString(),
        })));
      }
      const detail = url.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)$/);
      if (detail) {
        hits.push(`${detail[1]}/${detail[2]}`);
        const c = convs.find(x => x.org === detail[1] && x.id === detail[2]);
        if (!c || c.fail) return json({ error: 'not found' }, 404);
        return json({
          uuid: c.id, name: c.id, created_at: new Date((c.updateTime - 100) * 1000).toISOString(), updated_at: new Date(c.updateTime * 1000).toISOString(),
          chat_messages: [
            { uuid: `${c.id}-m1`, sender: 'human', created_at: new Date((c.updateTime - 90) * 1000).toISOString(), text: `question ${c.id}` },
            { uuid: `${c.id}-m2`, sender: 'assistant', created_at: new Date((c.updateTime - 80) * 1000).toISOString(), text: `answer ${c.id}` },
          ],
        });
      }
      return json({ error: 'unhandled' }, 404);
    };
  }

  async function runClaude(convs: OrgConv[], hits: string[], opts: Record<string, unknown> = {}, nowMs = NOW_MS) {
    const srv = startFixture(twoOrgHandler(convs, hits));
    try {
      return await runConnectorSync(engine, {
        provider: 'claude', sourceId: 'default',
        deps: { fetchImpl: (url, init) => fetch(url.replace(CLAUDE_BASE_URL, srv.baseUrl), init), now: () => nowMs, sleep: () => Promise.resolve() },
        ...(opts as object),
      });
    } finally {
      srv.stop();
    }
  }

  beforeEach(() => {
    saveCredential({ provider: 'claude', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
  });

  test('a retained failure from the second organization is retried there', async () => {
    const convs: OrgConv[] = [{ org: 'org-a', id: 'new-a', updateTime: T0 }, { org: 'org-b', id: 'old-b', updateTime: T0 - 30 * DAY_S, fail: true }];
    const hits: string[] = [];
    for (let k = 0; k < 3; k++) await runClaude(convs, hits);
    expect((await failedLedger('claude'))['old-b']?.orgId).toBe('org-b');

    convs[1].fail = false;
    hits.length = 0;
    const r = await runClaude(convs, hits, {}, NOW_MS + 2 * HOUR);
    expect(hits).toEqual(['org-b/old-b']);
    expect(r.status).toBe('success');
    expect(await failedLedger('claude')).toEqual({});
  });

  test('a legacy failure with no recorded organization is held for --full, which recovers it', async () => {
    const convs: OrgConv[] = [{ org: 'org-a', id: 'new-a', updateTime: T0 }, { org: 'org-b', id: 'old-b', updateTime: T0 - 30 * DAY_S }];
    const hits: string[] = [];
    await runClaude(convs.slice(0, 1), hits);
    // A pre-fix ledger entry: no orgId, no retry schedule.
    await engine.setConfig(connectorSourceKey('claude', 'default', 'failed'),
      JSON.stringify({ 'old-b': { attempts: 3, updatedAt: new Date((T0 - 30 * DAY_S) * 1000).toISOString() } }));

    hits.length = 0;
    const held = await runClaude(convs, hits);
    expect(hits).toEqual([]);
    expect(held.held).toEqual(['old-b']);
    expect(held.status).toBe('partial');
    expect(held.hint).toContain('gbrain connectors sync claude --full');

    const full = await runClaude(convs, hits, { full: true });
    expect(hits).toContain('org-b/old-b');
    expect(full.held).toEqual([]);
    expect(await failedLedger('claude')).toEqual({});
  });
});
