import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig } from '../src/core/github-source.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { beginConnectorSync, connectorWaitBudget, CONNECTOR_WAIT_BUDGET_MS } from '../src/core/persistence/connector-sync.ts';
import { installFaultHook, type FaultDetail, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, sourceCheckpoint, withGoogleAccount, settleConnectorWrites, withPausedOwnerBudget } from './helpers/connector-fixture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * #9681: a managed Gmail backfill that outlives the connector wait budget, with page writes committing at a steady
 * latency, persists its floor as batches become durable, and never past a batch whose writes failed or are pending.
 * Fake Gmail; publication latency injected through the persistence fault hook; the budget shrunk through its test seam.
 */
const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const BUDGET_MS = 1_500;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type GmailState = { gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null };
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };

/** 100 archive threads, 40..139 days old: one listing, four 25-thread batches. */
const OLD = Array.from({ length: 100 }, (_, i) => ({ tid: `17bb00000000a${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));

function gmail(account: string, opts: { fetchMs?: number; onThread?: (tid: string, n: number) => void | Promise<void> } = {}) {
  const fetched: string[] = [];
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = OLD.filter(m => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map((m, i) => ({ id: `18d2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: m.tid })) });
    }
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      fetched.push(m[1]);
      await opts.onThread?.(m[1], fetched.length);
      if (opts.fetchMs) await sleep(opts.fetchMs);
      const t = OLD.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18d2f4a9b3d3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
    }
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  };
  return { fetcher: withGoogleAccount(fetcher, account), fetched };
}

async function gmailState(engine: BrainEngine, id: string): Promise<GmailState | undefined> {
  const [row] = await sourceCheckpoint(engine, id) as { completed_keys: { state?: GmailState }[] }[];
  return row?.completed_keys[0]?.state;
}

/** The slug of the write a fault point names (by row id or request id). */
async function slugOf(engine: BrainEngine, detail: FaultDetail): Promise<string> {
  const [row] = detail.writeId
    ? await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1::uuid', [detail.writeId])
    : await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [detail.requestId]);
  return row?.slug ?? '';
}

/** Runs with every publication passing through `hook` and the connector wait budget at `budgetMs`. */
async function withOwner<T>(budgetMs: number, hook: (point: FaultPoint, detail: FaultDetail) => Promise<void> | void, run: () => Promise<T>): Promise<T> {
  connectorWaitBudget.ms = budgetMs;
  installFaultHook(hook);
  try { return await run(); } finally { installFaultHook(undefined); connectorWaitBudget.ms = CONNECTOR_WAIT_BUDGET_MS; }
}

/**
 * A slow owner: the first publication stalls past the whole budget, every later one takes `latencyMs` to prepare.
 * `fail` names a thread whose page write is refused.
 */
function slowOwner(engine: BrainEngine, latencyMs: number, fail?: string) {
  let stalled = false;
  return async (point: FaultPoint, detail: FaultDetail) => {
    if (point !== 'consumer:preparing') return;
    // The refusal lands after the walk banked the batch that holds it, so the staged save already lists the write.
    if (fail && (await slugOf(engine, detail)).includes(fail)) { await sleep(300); throw new OperationError('storage_error', 'Fixture refusal of one page write.', 'None.'); }
    if (!stalled) { stalled = true; await sleep(BUDGET_MS + 700); return; }
    await sleep(latencyMs);
  };
}

/** A first run banks batch one and is cut off: the floor sits below batch one and the backfill is open. */
async function seedFrozenFloor(engine: BrainEngine) {
  const f = await boundSource(engine, config);
  const cfg = parseGoogleSourceConfig(config, f.dir);
  const controller = new AbortController();
  const seed = gmail(cfg.account, { onThread: (_tid, n) => { if (n >= 27) controller.abort(); } });
  await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, seed.fetcher).catch(() => undefined);
  await settleConnectorWrites(engine, f.id);
  const seeded = await gmailState(engine, f.id);
  expect(seeded?.gmail_backfill_done).toBe(false);
  expect(seeded?.gmail_backfill_floor_ms).toBe(OLD[24].ms);
  return { f, cfg };
}

/** Waits until every page write of `threads` has committed. */
async function committed(engine: BrainEngine, id: string, threads: typeof OLD) {
  for (let i = 0; i < 600; i++) {
    const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' AND state='committed'`, [id]);
    if (threads.every(t => rows.some(row => row.slug.includes(t.tid)))) return;
    await sleep(100);
  }
  throw new Error('page writes did not commit');
}

async function pageStates(engine: BrainEngine, id: string) {
  await disposePersistenceConsumer(engine);
  return engine.executeRaw<{ slug: string; state: string }>(`SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'`, [id]);
}

test('#9681: a managed backfill that outlives the wait budget persists its floor as batches commit', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, cfg } = await seedFrozenFloor(engine);
    const sweep = gmail(cfg.account, { fetchMs: 120 });
    await withOwner(BUDGET_MS, slowOwner(engine, 20), () => runGoogleSync(engine, f.id, cfg, options, sweep.fetcher));
    expect(sweep.fetched.length).toBe(75);
    // Every page published, including those admitted before this run moved its own cursor.
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    expect((await gmailState(engine, f.id))?.gmail_backfill_floor_ms ?? 0).toBeLessThanOrEqual(OLD[49].ms);
  }
}), 240_000);

test('#9681: a page write that fails mid-walk pins the floor above its batch; earlier durable batches still land', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, cfg } = await seedFrozenFloor(engine);
    const sweep = gmail(cfg.account, { fetchMs: 120 });
    await withOwner(BUDGET_MS, slowOwner(engine, 20, OLD[74].tid), () => runGoogleSync(engine, f.id, cfg, options, sweep.fetcher)).catch(() => undefined);
    const states = await pageStates(engine, f.id);
    expect(states.filter(row => row.slug.includes(OLD[74].tid)).map(row => row.state)).toEqual(['failed']);
    // No cursor save covering the failed write was even submitted (the publication's own receipt check is the backstop).
    expect(await engine.executeRaw(`SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint' AND state<>'committed'`, [f.id])).toEqual([]);
    const floor = (await gmailState(engine, f.id))?.gmail_backfill_floor_ms ?? 0;
    expect(floor).toBeGreaterThan(OLD[74].ms);
    expect(floor).toBeLessThanOrEqual(OLD[49].ms);
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(false);
  }
}), 240_000);

test('#9681: a walk killed mid-batch keeps only durable batches behind the floor and the next run finishes', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, cfg } = await seedFrozenFloor(engine);
    const controller = new AbortController();
    // Batch three ends only after batch two's page writes are durable, so its cursor save is banked before the kill.
    const sweep = gmail(cfg.account, { fetchMs: 120, onThread: async tid => {
      if (tid === OLD[74].tid) await committed(engine, f.id, OLD.slice(25, 50));
      if (tid === OLD[85].tid) controller.abort();
    } });
    await withOwner(BUDGET_MS, slowOwner(engine, 20), () => runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, sweep.fetcher)).catch(() => undefined);
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    const floor = (await gmailState(engine, f.id))?.gmail_backfill_floor_ms ?? 0;
    expect([OLD[49].ms, OLD[74].ms]).toContain(floor);
    // The rest of the window, the killed batch included, is walked by the next run.
    const next = gmail(cfg.account);
    expect((await runGoogleSync(engine, f.id, cfg, options, next.fetcher)).status).not.toBe('partial');
    expect(next.fetched).toEqual(OLD.filter(o => o.ms < floor).map(o => o.tid));
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(true);
  }
}), 240_000);

test('#9681: a fresh cursor save superseded before its writes commit still stamps freshness when the newer save publishes', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const sync = (await beginConnectorSync(engine, f.id, 'github', parseGitHubSourceConfig(githubConfig, f.dir), options))!;
    await engine.executeRaw('UPDATE sources SET last_sync_at=NULL WHERE id=$1', [f.id]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    await withPausedOwnerBudget(() => sync.importMarkdown('notes/fresh.md', '---\ntitle: Fresh fixture\n---\nCurrent item.\n'));
    await withPausedOwnerBudget(() => sync.saveState({ cursor: 'current-complete' }, true, '2026-01-02T00:00:00.000Z'));
    const [page] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND slug='notes/fresh'", [f.id]);
    expect(page.state).not.toBe('committed');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    expect((await waitForWrite(engine, page, { engine: engine.kind })).state).toBe('committed');
    await sync.saveState({ cursor: 'backfill-batch' });
    await settleConnectorWrites(engine, f.id);
    const [source] = await engine.executeRaw<{ last_sync_at: unknown; newest_content_at: unknown }>('SELECT last_sync_at,newest_content_at FROM sources WHERE id=$1', [f.id]);
    expect(source.last_sync_at).not.toBeNull();
    expect(new Date(source.newest_content_at as string).toISOString()).toBe('2026-01-02T00:00:00.000Z');
  }
}), 120_000);

test('#9681: a page write carried from an earlier run that fails later keeps the next run\'s cursor behind it', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    const before = await sourceCheckpoint(engine, f.id);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    const first = (await beginConnectorSync(engine, f.id, 'github', cfg, options))!;
    await withPausedOwnerBudget(() => first.importMarkdown('notes/carried.md', '---\ntitle: Carried fixture\n---\nWritten by the earlier run.\n'));
    await first.finish();
    const [page] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND slug='notes/carried'", [f.id]);
    expect(page.state).not.toBe('committed');
    // The next run never revisits the carried item and saves a cursor while its write is still pending.
    const second = (await beginConnectorSync(engine, f.id, 'github', cfg, options))!;
    await withPausedOwnerBudget(() => second.saveState({ cursor: 'past-the-carried-write' }));
    await disposePersistenceConsumer(engine);
    installFaultHook(async (point, detail) => {
      if (point === 'consumer:preparing' && (await slugOf(engine, detail)) === 'notes/carried') throw new OperationError('storage_error', 'Fixture refusal of the carried page write.', 'None.');
    });
    try {
      await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
      expect((await waitForWrite(engine, page, { engine: engine.kind })).state).toBe('failed');
      await second.finish();
      for (const row of await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1', [f.id])) await waitForWrite(engine, row, { engine: engine.kind });
    } finally { installFaultHook(undefined); }
    expect(await sourceCheckpoint(engine, f.id)).toEqual(before);
    expect(await engine.executeRaw(`SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint' AND state='committed'`, [f.id])).toEqual([]);
  }
}), 120_000);

test('#9681: a brain stuck with a frozen floor and a retained publication recovers on its next syncs', async () => withEnv(env, async () => {
  for (const engine of engines) {
    // The reporter's shape: an earlier run banked batch one, then was cut off while one of its page publications was
    // still in progress (its recovery record set), so the floor is frozen and the backfill is open.
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const controller = new AbortController();
    const first = gmail(cfg.account, { onThread: (_tid, n) => { if (n >= 27) controller.abort(); } });
    connectorWaitBudget.ms = CONNECTOR_WAIT_BUDGET_MS;
    installFaultHook(async (point, detail) => {
      if (point === 'publication:prepared' && (await slugOf(engine, detail)).includes(OLD[25].tid)) await sleep(7_000);
    });
    await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, first.fetcher).catch(() => undefined);
    installFaultHook(undefined);
    const retained = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id]);
    expect(retained.map(row => row.slug.includes(OLD[25].tid))).toEqual([true]);
    expect(await gmailState(engine, f.id)).toMatchObject({ gmail_backfill_done: false, gmail_backfill_floor_ms: OLD[24].ms });

    // The next syncs run against the same slow owner, with no manual step between them. A run's last cursor save may
    // still be publishing when it ends; it commits on its own, so every run moves the floor until the backfill is done.
    let floor = OLD[24].ms;
    for (let runs = 0; runs < 6 && !(await gmailState(engine, f.id))?.gmail_backfill_done; runs++) {
      const sweep = gmail(cfg.account, { fetchMs: 60 });
      const result = await withOwner(BUDGET_MS, slowOwner(engine, 100), () => runGoogleSync(engine, f.id, cfg, options, sweep.fetcher));
      expect(result.status === 'synced' || result.reason === 'writer_pending').toBe(true);
      await settleConnectorWrites(engine, f.id);
      const state = await gmailState(engine, f.id);
      if (!state?.gmail_backfill_done) { expect(state?.gmail_backfill_floor_ms ?? 0).toBeLessThan(floor); floor = state!.gmail_backfill_floor_ms!; }
    }
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(true);
    await settleConnectorWrites(engine, f.id);
  }
}), 300_000);
