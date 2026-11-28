/**
 * More threads share one second than a managed sweep can fetch before its deadline. Each sweep is cut off after
 * 60 thread fetches. The backfill must still finish over several sweeps, instead of every sweep re-fetching the
 * same first threads with the floor stuck above that second.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount, settleConnectorWrites } from './helpers/connector-fixture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const CROWD_MS = NOW_MS - 50 * DAY;
/** 160 threads in one millisecond (a bulk reminder burst), plus 5 ordinary older threads below it. */
const THREADS = [
  ...Array.from({ length: 160 }, (_, i) => ({ tid: `17ff0000000c${String(i).padStart(4, '0')}`, ms: CROWD_MS })),
  ...Array.from({ length: 5 }, (_, i) => ({ tid: `17ff0000000d${String(i).padStart(4, '0')}`, ms: NOW_MS - (60 + i) * DAY })),
];
const PER_SWEEP = 60;
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
type GmailState = { gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null; gmail_backfill_floor_carry?: unknown };

function gmail(account: string, onThread: (n: number) => void) {
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
      fetched.add(m[1]!);
      onThread(fetched.size);
      const t = THREADS.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18f2f4a9b3d2${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Reminder <reminder@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Reminder ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
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

test('a crowded second larger than one sweep still finishes over several deadline-cut sweeps', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const union = new Set<string>();
    let done = false;
    for (let run = 0; run < 8 && !done; run++) {
      const controller = new AbortController();
      const sweep = gmail(cfg.account, n => { if (n >= PER_SWEEP) controller.abort(); });
      await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, sweep.fetcher).catch(() => undefined);
      await settleConnectorWrites(engine, f.id);
      for (const t of sweep.fetched) union.add(t);
      done = (await gmailState(engine, f.id))?.gmail_backfill_done === true;
    }
    expect(done).toBe(true);
    expect(union).toEqual(new Set(THREADS.map(t => t.tid)));
    expect((await gmailState(engine, f.id))?.gmail_backfill_floor_carry).toBeUndefined();
  }
}), 600_000);
