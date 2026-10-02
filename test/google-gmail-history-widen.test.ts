import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const RECENT = Array.from({ length: 3 }, (_, i) => ({ tid: `17bb00000000r${String(i).padStart(3, '0')}`, ms: NOW_MS - (i + 1) * DAY }));
const OLD = Array.from({ length: 30 }, (_, i) => ({ tid: `17bb00000000o${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));
const ALL = [...RECENT, ...OLD];

type GmailState = { gmail_history_id?: string; gmail_backfill_done?: boolean; gmail_backfill_cutoff_ms?: number | null };

const importReceipts = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'", [sourceId]))[0].n;
const latestKey = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ k: string }>(
  "SELECT intent->>'checkpointKey' AS k FROM persistence_requests WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1", [sourceId]))[0].k;
const stateAt = async (engine: BrainEngine, key: string) => {
  await disposePersistenceConsumer(engine);
  const [row] = await engine.executeRaw<{ completed_keys: { state?: GmailState }[] }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [key]);
  return row?.completed_keys[0]?.state;
};

// bp-ry3r.1: both live Gmail cursors finished a 4-day backfill on a binary that
// never recorded gmail_backfill_cutoff_ms. Widening g_history_days must still
// reach the older mail, and must not re-mint receipts for mail already imported.
test('widening g_history_days on a legacy completed managed gmail cursor backfills older mail without re-admitting unchanged threads', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const narrow = { ...googleConfig, g_services: 'gmail', g_history_days: 4 };
    const f = await source(engine, narrow);
    const fetched: string[] = [];
    const fetcher = (account: string) => async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '2000' });
      if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '2000', history: [] });
      if (u.pathname.endsWith('/users/me/messages')) {
        const q = u.searchParams.get('q') ?? '';
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
        const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
        const hits = ALL.filter((m) => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
        return json({ messages: hits.map((m) => ({ id: `18d0${m.tid.slice(-8)}`, threadId: m.tid })) });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        fetched.push(m[1]);
        const t = ALL.find((x) => x.tid === m[1])!;
        return json({ id: t.tid, messages: [{ id: `18d0${t.tid.slice(-8)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = (config: Record<string, unknown>) => {
      const cfg = parseGoogleSourceConfig(config, f.dir);
      return runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher(cfg.account), cfg.account));
    };

    // The narrow cursor completes, then is rewritten into the legacy live shape.
    expect((await run(narrow)).status).not.toBe('partial');
    expect(fetched.sort()).toEqual(RECENT.map((r) => r.tid).sort());
    expect(await importReceipts(engine, f.id)).toBe(3);
    const narrowKey = await latestKey(engine, f.id);
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,state}',
      (completed_keys->0->'state') - 'gmail_backfill_cutoff_ms') WHERE op='managed-connector' AND fingerprint=$1`, [narrowKey]);
    const legacy = await stateAt(engine, narrowKey);
    expect(legacy?.gmail_backfill_done).toBe(true);
    expect(legacy?.gmail_backfill_cutoff_ms).toBeUndefined();

    // Widen. g_history_days is cursor identity, so the source gets a fresh
    // cursor: the whole 90-day window is walked, the 30 archive threads land,
    // and the 3 already-imported threads are skipped before admission.
    const wide = { ...narrow, g_history_days: 90 };
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.id, JSON.stringify(wide)]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    fetched.length = 0;
    const widened = await run(wide);
    expect(widened.status).not.toBe('partial');
    expect(fetched.sort()).toEqual(ALL.map((t) => t.tid).sort());
    expect(await importReceipts(engine, f.id)).toBe(3 + OLD.length);
    const wideKey = await latestKey(engine, f.id);
    expect(wideKey).not.toBe(narrowKey);
    const done = await stateAt(engine, wideKey);
    expect(done?.gmail_backfill_done).toBe(true);
    expect(done?.gmail_backfill_cutoff_ms).toBeLessThanOrEqual(OLD[29].ms);
    // The legacy narrow cursor is left untouched for an exact-config restore.
    expect((await stateAt(engine, narrowKey))?.gmail_backfill_done).toBe(true);
  }
}), 120_000);
