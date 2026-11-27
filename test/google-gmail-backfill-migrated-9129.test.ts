/**
 * #9129: the Gmail backfill moved its floor down to the oldest thread of each batch it processed, assuming a listing
 * comes back in `internalDate` order. It does not: mail migrated in from another account keeps its old date but lists
 * among the mail of the day it was imported. One such thread in a batch dropped the floor past every message between
 * them, which was never listed again, and the backfill still finished as done. The floor now moves only past mail a
 * complete listing has shown and the walk has settled. Fake Gmail: 60 threads 40..99 days old plus one migrated thread
 * 300 days old that lists third, as Gmail lists by message id.
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
const RECENT = Array.from({ length: 60 }, (_, i) => ({ tid: `17cc00000000a${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));
const MIGRATED = { tid: '17cc00000000b001', ms: NOW_MS - 300 * DAY };
/** Gmail's listing order: by message id, so the migrated thread lists among the mail of its import day. */
const LISTED = [...RECENT.slice(0, 2), MIGRATED, ...RECENT.slice(2)];
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
type GmailState = { gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null };

function gmail(account: string, pageSize: number, onThread?: (n: number) => void) {
  const fetched = new Set<string>();
  const fetcher = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = LISTED.map((m, i) => ({ ...m, id: `18e2f4a9b3d2${String(i).padStart(4, '0')}` })).filter(m => m.ms / 1000 >= after && m.ms / 1000 < before);
      const offset = Number(u.searchParams.get('pageToken') ?? 0);
      const page = hits.slice(offset, offset + pageSize);
      return json({ messages: page.map(m => ({ id: m.id, threadId: m.tid })), ...(offset + pageSize < hits.length ? { nextPageToken: String(offset + pageSize) } : {}) });
    }
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      fetched.add(m[1]);
      onThread?.(fetched.size);
      const t = LISTED.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18e2f4a9b3d3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
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

test('#9129: a listing cut short at its page bound never moves the floor past mail it did not list', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const sweep = gmail(cfg.account, 2);
    await runGoogleSync(engine, f.id, cfg, options, sweep.fetcher);
    expect([...sweep.fetched].sort()).toEqual(LISTED.map(m => m.tid).sort());
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(true);
  }
}), 240_000);

test('#9129: a walk cut off after a batch holding migrated mail never leaves unsettled mail above its floor, and the next run finishes it', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const controller = new AbortController();
    const first = gmail(cfg.account, 100, n => { if (n >= 52) controller.abort(); });
    await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, first.fetcher)
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') throw e; });
    const cut = await gmailState(engine, f.id);
    expect(cut?.gmail_backfill_done).toBe(false);
    const floor = cut?.gmail_backfill_floor_ms ?? Infinity;
    // The migrated thread in the first batch must not pin the second batch's floor proof.
    expect(floor).toBeLessThanOrEqual(RECENT[48]!.ms);
    expect(LISTED.filter(m => m.ms >= floor && !first.fetched.has(m.tid))).toEqual([]);
    const second = gmail(cfg.account, 100);
    await runGoogleSync(engine, f.id, cfg, options, second.fetcher);
    expect(new Set([...first.fetched, ...second.fetched])).toEqual(new Set(LISTED.map(m => m.tid)));
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(true);
  }
}), 240_000);
