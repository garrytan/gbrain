import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
// 30 archive threads, 40..69 days old: one bounded listing, two batches.
const OLD = Array.from({ length: 30 }, (_, i) => ({ tid: `17aa00000000a${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));
const CURRENT = { tid: '17aa00000000b001', ms: NOW_MS - 3_600_000 };

type GmailState = { gmail_history_id?: string; gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null };

test('managed gmail is recent-first: current mail lands and freshness is banked before an aborted backfill', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '1000';
    let flagged: string[] = [];
    let onThread: ((tid: string) => void) | undefined;
    const fetched: string[] = [];
    const all = () => [...OLD, ...(flagged.length ? [CURRENT] : [])];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) {
        const q = u.searchParams.get('q') ?? '';
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
        const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
        const hits = all().filter((m) => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
        return json({ messages: hits.map((m, i) => ({ id: `18c2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: m.tid })) });
      }
      if (u.pathname.endsWith('/users/me/history')) {
        const records = u.searchParams.get('startHistoryId') === historyId ? [] : [{ messages: flagged.map((threadId) => ({ threadId })) }];
        return json({ historyId, history: records });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        fetched.push(m[1]);
        onThread?.(m[1]);
        const t = all().find((x) => x.tid === m[1])!;
        return json({ id: t.tid, messages: [{ id: `18c2f4a9b3d3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = (signal?: AbortSignal) => runGoogleSync(engine, f.id, cfg, { ...options, ...(signal ? { signal } : {}) }, fetcher);
    const abortOn = (pred: (tid: string) => boolean) => {
      const c = new AbortController();
      onThread = (tid) => { if (pred(tid)) c.abort(); };
      return c.signal;
    };
    const state = async () => {
      await disposePersistenceConsumer(engine);
      const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: GmailState }[] }[];
      return row?.completed_keys[0]?.state;
    };
    const freshness = async () => (await engine.executeRaw<{ last_sync_at: string | null; newest_content_at: string | null }>(
      'SELECT last_sync_at, newest_content_at FROM sources WHERE id=$1', [f.id]))[0];

    // Run 1: a new install's budget expires during the second backfill batch.
    // The recent window is banked, but nothing may call it fresh yet.
    await run(abortOn(() => fetched.length >= 27)).catch(() => undefined);
    const s1 = await state();
    expect(s1?.gmail_history_id).toBe('1000');
    expect(s1?.gmail_backfill_done).toBe(false);
    expect(s1?.gmail_backfill_floor_ms).toBe(OLD[24].ms);
    expect((await freshness()).last_sync_at).toBeNull();

    // Run 2: new mail arrives while the archive is still draining, and the
    // budget expires on the first archive fetch. Current mail comes FIRST and
    // freshness is banked before the backfill can starve it.
    historyId = '1010';
    flagged = [CURRENT.tid];
    fetched.length = 0;
    await run(abortOn((tid) => tid !== CURRENT.tid)).catch(() => undefined);
    expect(fetched[0]).toBe(CURRENT.tid);
    const s2 = await state();
    expect(s2?.gmail_history_id).toBe('1010');
    expect(s2?.gmail_backfill_done).toBe(false);
    expect(s2?.gmail_backfill_floor_ms).toBe(OLD[24].ms); // backfill cursor untouched by the delta
    const fresh = await freshness();
    expect(fresh.last_sync_at).not.toBeNull();
    expect(new Date(fresh.newest_content_at!).getTime()).toBe(CURRENT.ms);

    // Run 3: the archive finishes from its own floor; nothing is lost.
    onThread = undefined;
    fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fetched.sort()).toEqual(OLD.slice(25).map((o) => o.tid).sort());
    expect((await state())?.gmail_backfill_done).toBe(true);
  }
}), 120_000);
