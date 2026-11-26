/**
 * #10473: one thread that fails to fetch held the whole 25-thread batch's floor, so a backfill whose sweeps each hit
 * one failing thread never moved `gmail_backfill_floor_ms`. The floor now moves past the batch's landed prefix (the
 * threads before the failure) once a complete listing shows nothing unsettled between it and the floor.
 * Fake Gmail: 60 threads 40..99 days old; the thread at index 30 answers HTTP 400 once.
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
const OLD = Array.from({ length: 60 }, (_, i) => ({ tid: `17dd00000000a${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));
const BAD = OLD[30]!.tid;
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
type GmailState = { gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null };

function gmail(account: string) {
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = OLD.filter(m => m.ms / 1000 >= after && m.ms / 1000 < before);
      return json({ messages: hits.map((m, i) => ({ id: `18f2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: m.tid })) });
    }
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      if (m[1] === BAD) return json({ error: { message: 'Fixture refusal of one thread.' } }, 400);
      const t = OLD.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18f2f4a9b3d3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
    }
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  };
  return withGoogleAccount(fetcher, account);
}

async function gmailState(engine: BrainEngine, id: string): Promise<GmailState | undefined> {
  await disposePersistenceConsumer(engine);
  const [row] = await sourceCheckpoint(engine, id) as { completed_keys: { state?: GmailState }[] }[];
  return row?.completed_keys[0]?.state;
}

test('#10473: a failed thread holds only its own place; the landed prefix of its batch moves the floor', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    await runGoogleSync(engine, f.id, cfg, options, gmail(cfg.account)).catch(() => undefined);
    const state = await gmailState(engine, f.id);
    expect(state?.gmail_backfill_done).toBe(false);
    // Batch one (0..24) moved the floor already; threads 25..29 landed before the failure at 30.
    expect(state?.gmail_backfill_floor_ms ?? Infinity).toBeLessThanOrEqual(OLD[29]!.ms);
    expect(state?.gmail_backfill_floor_ms ?? 0).toBeGreaterThan(OLD[30]!.ms);
  }
}), 240_000);
