/**
 * GST-4026: Gmail's `after:<epoch>` bound is not documented as inclusive, and reports show a message dated exactly at
 * the bound (and up to a few seconds past it) listed or not depending on the second. The floor walk saves the start of a
 * thread's second as its floor, and the next listing's `before:` excludes that second, so a listing that drops the
 * bound's own second loses every unsettled message in it. Fake Gmail with an exclusive `after:` (whole seconds): two
 * threads share one second across a batch boundary, and the second of them hits a rate limit.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
/** 30 threads, newest first; threads 24 and 25 fall in one second, either side of the first 25-thread batch. */
const THREADS = Array.from({ length: 30 }, (_, i) => ({
  tid: `17dd00000000a${String(i).padStart(3, '0')}`,
  ms: i === 25 ? NOW_MS - 64 * DAY + 200 : NOW_MS - (40 + i) * DAY + (i === 24 ? 700 : 0),
}));
const SAME_SECOND = THREADS[25]!;
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
type GmailState = { gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null };

function gmail(account: string, rateLimit?: string) {
  const fetched = new Set<string>();
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? -1);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = THREADS.filter(m => Math.floor(m.ms / 1000) > after && Math.floor(m.ms / 1000) < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map(m => ({ id: `18f2f4a9b3d2${m.tid.slice(-4)}`, threadId: m.tid })) });
    }
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      if (m[1] === rateLimit) return json({ error: { message: 'rate limit' } }, 429, { 'retry-after': '0' });
      fetched.add(m[1]);
      const t = THREADS.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18f2f4a9b3d3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
    }
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  };
  return { fetcher: withGoogleAccount(fetcher, account), fetched };
}

async function gmailState(engine: BrainEngine, id: string): Promise<GmailState | undefined> {
  await disposePersistenceConsumer(engine);
  const [row] = await sourceCheckpoint(engine, id) as { completed_keys: { state?: GmailState }[] }[];
  return row?.completed_keys[0]?.state;
}

test('GST-4026: a floor saved inside a second still lists that second, so a same-second thread left unsettled is fetched next run', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const first = gmail(cfg.account, SAME_SECOND.tid);
    await runGoogleSync(engine, f.id, cfg, options, first.fetcher);
    expect(first.fetched.has(SAME_SECOND.tid)).toBe(false);
    const cut = await gmailState(engine, f.id);
    expect(cut?.gmail_backfill_done).toBe(false);
    const second = gmail(cfg.account);
    await runGoogleSync(engine, f.id, cfg, options, second.fetcher);
    expect(second.fetched.has(SAME_SECOND.tid)).toBe(true);
    expect(new Set([...first.fetched, ...second.fetched])).toEqual(new Set(THREADS.map(t => t.tid)));
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(true);
  }
}), 240_000);
