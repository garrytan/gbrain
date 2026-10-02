import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
// 30 threads: banked after the first landing, then after a full 25-thread batch.
const TIDS = Array.from({ length: 30 }, (_, i) => `17aa00000000c${String(i).padStart(3, '0')}`);

test('managed gmail delta: an aborted drain banks per batch; resume drops no thread and repeats at most the unbanked one', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '1000';
    let flagged: string[] = [];
    let onThread: (() => void) | undefined;
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] }); // empty backfill window
      if (u.pathname.endsWith('/users/me/history')) {
        // Real Gmail: listing from the latest historyId returns no records.
        const records = u.searchParams.get('startHistoryId') === historyId ? [] : [{ messages: flagged.map((threadId) => ({ threadId })) }];
        return json({ historyId, history: records });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        onThread?.();
        const i = TIDS.indexOf(m[1]);
        return json({ id: m[1], messages: [{ id: `18c2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: m[1], labelIds: [], internalDate: String(NOW_MS - (40 + i) * 86_400_000),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: `Delta topic ${i}` }], body: { data: b64url(`Delta body ${i}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = (signal?: AbortSignal) => runGoogleSync(engine, f.id, cfg, { ...options, ...(signal ? { signal } : {}) }, withGoogleAccount(fetcher, cfg.account));
    const imports = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY slug", [f.id])).map((r) => r.slug);
    const state = async () => {
      await disposePersistenceConsumer(engine);
      const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { gmail_history_id?: string; gmail_pending_thread_ids?: string[] } }[] }[];
      return row?.completed_keys[0]?.state;
    };

    await run(); // anchors the history cursor at 1000, empty backfill
    expect((await state())?.gmail_history_id).toBe('1000');

    // History flags 30 threads; the wall-clock budget expires during the 28th
    // fetch: 26 threads are banked (1 + 25), #27 landed after the last checkpoint.
    historyId = '1010';
    flagged = TIDS;
    const controller = new AbortController();
    let fetches = 0;
    onThread = () => { if (++fetches >= 28) controller.abort(); };
    const aborted = await run(controller.signal).then((r) => r.status, (e: Error) => e.name);
    expect(['partial', 'AbortError']).toContain(aborted);
    const banked = await state();
    expect(banked?.gmail_history_id).toBe('1010');
    expect(banked?.gmail_pending_thread_ids).toEqual(TIDS.slice(26));
    expect(await imports()).toHaveLength(27);

    // Resume: only the four parked threads are fetched; every thread lands and
    // the one landed-but-unbanked thread is re-landed unchanged, which admits
    // no second receipt (bp-ry3r.1), so each thread holds exactly one.
    onThread = () => { fetches++; };
    fetches = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fetches).toBe(4);
    const all = await imports();
    expect(new Set(all).size).toBe(30);
    expect(all).toHaveLength(30);
    const resumed = await state();
    expect(resumed?.gmail_history_id).toBe('1010');
    expect(resumed?.gmail_pending_thread_ids).toEqual([]);
  }
}), 120_000);
