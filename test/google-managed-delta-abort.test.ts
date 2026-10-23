import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount, connectorPendingSet, withPausedOwnerBudget } from './helpers/connector-fixture.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
// 30 threads: committed changed pages are banked individually before an abort.
const TIDS = Array.from({ length: 30 }, (_, i) => `17aa00000000c${String(i).padStart(3, '0')}`);

test('managed gmail delta: an aborted drain banks per batch; resume drops no thread and repeats at most the unbanked one', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '1000';
    let flagged: string[] = [];
    let onThread: ((threadId: string) => void) | undefined;
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
        onThread?.(m[1]);
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

    // History flags 30 threads; abort during fetch #8 leaves the first seven banked.
    historyId = '1010';
    flagged = TIDS;
    const controller = new AbortController();
    let fetches = 0;
    const threadFetches = new Map<string, number>();
    onThread = (threadId) => {
      fetches++;
      threadFetches.set(threadId, (threadFetches.get(threadId) ?? 0) + 1);
      if (fetches >= 8) controller.abort();
    };
    const aborted = await run(controller.signal).then((r) => r.status, (e: Error) => e.name);
    expect(['partial', 'AbortError']).toContain(aborted);
    const banked = await state();
    expect(banked?.gmail_history_id).toBe('1010');
    expect(banked?.gmail_pending_thread_ids).toEqual(TIDS.slice(7));
    expect(await imports()).toHaveLength(7);

    // Resume in bounded serial slices; only the thread whose fetch was aborted is replayed.
    onThread = (threadId) => {
      fetches++;
      threadFetches.set(threadId, (threadFetches.get(threadId) ?? 0) + 1);
    };
    for (const pending of [TIDS.slice(17), TIDS.slice(27), []]) {
      await run();
      expect((await state())?.gmail_pending_thread_ids).toEqual(pending);
    }
    expect(fetches).toBe(31);
    expect(threadFetches.get(TIDS[7]!)).toBe(2);
    expect(TIDS.filter((id) => id !== TIDS[7] && threadFetches.get(id) !== 1)).toEqual([]);
    const all = await imports();
    expect(new Set(all).size).toBe(30);
    expect(all).toHaveLength(30);
    const resumed = await state();
    expect(resumed?.gmail_history_id).toBe('1010');
    expect(resumed?.gmail_pending_thread_ids).toEqual([]);
  }
}), 120_000);

test('managed Gmail delta yields to historical backfill and defers due grace refetches without dropping holds', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '1000';
    let flagged: string[] = [];
    let threadFetches = 0;
    let failBackfill = true;
    let historyWindowListCalls = 0;
    const historyWindowThreadIds = ['historical-a', 'historical-b', 'historical-c'];
    let historyWindowFetches = 0;
    let checkpointAdvancedBeforeSecondHistoryThread = false;
    const graceThreadIds = new Set(TIDS.slice(10, 15));
    let graceFetches = 0;
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) {
        const query = u.searchParams.get('q') ?? '';
        if (failBackfill) return json({ error: { message: 'fixture backfill seed stop' } }, 503);
        if (query.includes('after:') && query.includes('before:')) {
          historyWindowListCalls++;
          return json({ messages: historyWindowListCalls === 1 ? historyWindowThreadIds.map((threadId, i) => ({ id: `history-msg-${i}`, threadId })) : [] });
        }
        return json({ messages: [] });
      }
      if (u.pathname.endsWith('/users/me/history')) {
        const records = u.searchParams.get('startHistoryId') === '1000' ? [{ messages: flagged.map(threadId => ({ threadId })) }] : [];
        return json({ historyId, history: records });
      }
      const threadId = u.pathname.includes('/users/me/threads/') ? u.pathname.split('/').at(-1) : undefined;
      if (threadId) {
        threadFetches++;
        if (graceThreadIds.has(threadId)) graceFetches++;
        const historyIndex = historyWindowThreadIds.indexOf(threadId);
        if (historyIndex >= 0) {
          historyWindowFetches++;
          if (historyIndex === 1) {
            const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { gmail_backfill_floor_ms?: number | null } }[] }[];
            checkpointAdvancedBeforeSecondHistoryThread = typeof row?.completed_keys[0]?.state?.gmail_backfill_floor_ms === 'number';
          }
        }
        const i = TIDS.indexOf(threadId);
        const itemIndex = i >= 0 ? i : 40 + historyIndex;
        return json({ id: threadId, messages: [{ id: `18c2f4a9b3d2${String(itemIndex).padStart(4, '0')}`, threadId, labelIds: [],
          internalDate: String(NOW_MS - (40 + itemIndex) * 86_400_000), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: `Slice fixture ${itemIndex}` }], body: { data: b64url(`Slice fixture body ${itemIndex}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = () => runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id, noEmbed: true, noExtract: true, noLoopsExtract: true }, withGoogleAccount(fetcher, cfg.account));
    const state = async () => {
      await disposePersistenceConsumer(engine);
      const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { gmail_history_id?: string; gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null; gmail_pending_thread_ids?: string[]; loop_grace_holds?: Record<string, unknown> } }[] }[];
      return row?.completed_keys[0]?.state;
    };

    await run().catch(() => undefined); // Gmail history is anchored, but the initial window listing fails.
    const seeded = await state();
    expect(seeded?.gmail_history_id).toBe('1000');
    expect(seeded?.gmail_backfill_done).toBe(false);
    const graceHolds = Object.fromEntries([...graceThreadIds].map(threadId => [threadId,
      { due_ms: NOW_MS - 1, slug: null, rev: null, spec: null }]));
    const graceSeedRows = await engine.executeRaw<{ fingerprint: string }>(`UPDATE op_checkpoints SET completed_keys=jsonb_set(
      completed_keys,'{0,state,loop_grace_holds}',$2::jsonb,true)
      WHERE op='managed-connector' AND fingerprint IN (
        SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)
      RETURNING fingerprint`, [f.id, graceHolds]);
    expect(graceSeedRows).toHaveLength(1);
    const graceSeeded = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { loop_grace_holds?: Record<string, unknown> } }[] }[];
    expect(Object.keys(graceSeeded[0]?.completed_keys[0]?.state?.loop_grace_holds ?? {})).toEqual([...graceThreadIds]);

    failBackfill = false;
    historyId = '1010';
    flagged = TIDS;
    threadFetches = 0;
    graceFetches = 0;
    historyWindowListCalls = 0;
    const result = await run();
    expect(threadFetches).toBe(13);
    expect(graceFetches).toBe(0);
    expect(historyWindowListCalls).toBeGreaterThan(0);
    expect(historyWindowFetches).toBe(3);
    expect(checkpointAdvancedBeforeSecondHistoryThread).toBe(true);
    expect(['first_sync', 'synced', 'partial']).toContain(result.status);
    const saved = await state();
    expect(saved?.gmail_history_id).toBe('1010');
    expect(saved?.gmail_backfill_done).toBe(true);
    expect(saved?.gmail_pending_thread_ids).toEqual(TIDS.slice(10));
    expect(Object.keys(saved?.loop_grace_holds ?? {})).toEqual([...graceThreadIds]);

    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,
      '{0,state,gmail_pending_thread_ids}','[]'::jsonb,true) WHERE op='managed-connector' AND fingerprint IN
      (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)`, [f.id]);
    threadFetches = 0;
    graceFetches = 0;
    await run();
    expect(threadFetches).toBe(graceThreadIds.size);
    expect(graceFetches).toBe(graceThreadIds.size);
    expect(Object.keys((await state())?.loop_grace_holds ?? {})).toEqual([]);
  }
}), 120_000);

test('managed Gmail delta checkpoints each committed changed thread before a pending import forces continuation', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let phase: 'anchor' | 'drain' = 'anchor';
    const threadFetches = new Map<string, number>();
    let retainedRequestId: string | undefined;
    let markWriterBlocked!: () => void;
    const writerBlocked = new Promise<void>(resolve => { markWriterBlocked = resolve; });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        const start = u.searchParams.get('startHistoryId');
        const threads = phase === 'drain' && start === '1000' ? TIDS.slice(0, 4) : [];
        return json({ historyId: phase === 'anchor' ? '1000' : '1010', history: threads.length ? [{ messages: threads.map(threadId => ({ threadId })) }] : [] });
      }
      const match = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (match) {
        const id = match[1]!;
        threadFetches.set(id, (threadFetches.get(id) ?? 0) + 1);
        const i = TIDS.indexOf(id);
        return json({ id, messages: [{ id: `18c2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: id, labelIds: [],
          internalDate: String(NOW_MS - (40 + i) * 86_400_000), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: `Checkpoint fixture ${i}` }], body: { data: b64url(`Checkpoint fixture body ${i}.`) } } }] });
      }
      throw new Error(`Unexpected fixture route: ${u.pathname}`);
    }, cfg.account);
    const run = (drain = false) => runGoogleSync(engine, f.id, cfg,
      { ...options, sourceId: f.id, drain, noEmbed: true, noExtract: true, noLoopsExtract: true }, fetcher);

    await run();
    phase = 'drain';
    let preparedImports = 0;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:prepared' || detail.sourceId !== f.id || !detail.requestId) return;
      const [row] = await engine.executeRaw<{ kind: string }>(
        "SELECT intent->>'kind' AS kind FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (row?.kind !== 'connector_v2_import' || ++preparedImports !== 3) return;
      retainedRequestId = detail.requestId;
      markWriterBlocked();
      return writerGate;
    });

    let runPromise: Promise<Awaited<ReturnType<typeof runGoogleSync>>> | undefined;
    try {
      runPromise = withPausedOwnerBudget(() => withEnv({ GBRAIN_SINGLE_WRITE_GROUP: '0' }, async () => {
        resetWriteSwitches();
        return run(true);
      }).finally(() => resetWriteSwitches()));
      const reached = await Promise.race([writerBlocked.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
      expect(reached).toBe(true);
      if (!reached) throw new Error('third Gmail import did not reach the publication gate');
      let pending = [] as Awaited<ReturnType<typeof connectorPendingSet>>;
      for (let i = 0; i < 600; i++) {
        pending = await connectorPendingSet(engine, f.id);
        if (pending.some(entry => entry.requestId === retainedRequestId)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pending.some(entry => entry.requestId === retainedRequestId)).toBe(true);
      const [checkpoint] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { gmail_pending_thread_ids?: string[] } }[] }[];
      expect(checkpoint.completed_keys[0]?.state?.gmail_pending_thread_ids).toEqual(TIDS.slice(2, 4));
      expect(threadFetches.get(TIDS[0]!)).toBe(1);
      expect(threadFetches.get(TIDS[1]!)).toBe(1);

      releaseWriter();
      const result = await runPromise;
      expect(result.reason).not.toBe('writer_pending');
      expect(await connectorPendingSet(engine, f.id)).toEqual([]);
      expect(threadFetches.get(TIDS[0]!)).toBe(1);
      expect(threadFetches.get(TIDS[1]!)).toBe(1);
      expect(threadFetches.get(TIDS[2]!)).toBe(2);
      expect(threadFetches.get(TIDS[3]!)).toBe(1);
      const imports = await engine.executeRaw<{ slug: string; n: number }>(
        "SELECT slug,count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' AND state='committed' GROUP BY slug ORDER BY slug", [f.id]);
      expect(imports).toHaveLength(4);
      expect(imports.every(row => row.n === 1)).toBe(true);
    } finally {
      releaseWriter();
      installFaultHook(undefined);
      await runPromise?.catch(() => {});
    }
  }
}), 120_000);

/**
 * Contract: `drain: true` keeps one managed Gmail invocation alive while its
 * recorded receipt is pending. No further history or `messages.list` calls are
 * made until that receipt commits; then the same invocation traverses a
 * non-empty two-page historical list and completes the backfill.
 * The held publication has a durable recovery record and live claim.
 * Seam: public `runGoogleSync` with a fixture engine and fake Google transport.
 */
test('managed Gmail drain re-evaluates eligible candidates from a normal deferred continuation', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const spamThreadId = TIDS[0]!;
    const humanThreadId = TIDS[1]!;
    let phase: 'anchor' | 'drain' = 'anchor';
    let drainHistoryCalls = 0;
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        if (phase === 'anchor') return json({ historyId: '1000', history: [] });
        drainHistoryCalls++;
        const start = u.searchParams.get('startHistoryId');
        const threads = drainHistoryCalls === 1 ? [spamThreadId]
          : start === '1000' ? [spamThreadId, humanThreadId] : [humanThreadId];
        return json({ historyId: '1020', history: [{ messages: threads.map(threadId => ({ threadId })) }] });
      }
      const match = u.pathname.match(new RegExp('/users/me/threads/([^/]+)$'));
      if (match) {
        const spam = match[1] === spamThreadId;
        return json({ id: match[1], messages: [{ id: `18c2f4a9b3d2${spam ? '0090' : '0091'}`, threadId: match[1],
          labelIds: spam ? ['SPAM'] : [], internalDate: String(NOW_MS - 2 * 86_400_000), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: spam ? 'Drain tail spam' : 'Drain tail human' }], body: { data: b64url('A short fixture message.') } } },
        ...(!spam ? [{ id: '18c2f4a9b3d20092', threadId: match[1], labelIds: ['SENT'], internalDate: String(NOW_MS - 2 * 86_400_000 + 1_000), payload: { mimeType: 'text/plain', headers: [
          { name: 'From', value: cfg.account }, { name: 'To', value: 'peer@example.invalid' },
          { name: 'Subject', value: 'Re: Drain tail human' }], body: { data: b64url('I will follow up on this.') } } }] : []),
        ] });
      }
      throw new Error(`Unexpected fixture route: ${u.pathname}`);
    }, cfg.account);

    await runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id }, fetcher);
    phase = 'drain';

    let releaseWriter!: () => void;
    let markWriterBlocked!: () => void;
    const writerBlocked = new Promise<void>(resolve => { markWriterBlocked = resolve; });
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    let retainedRequestId: string | undefined;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:prepared' || detail.sourceId !== f.id || !detail.requestId || retainedRequestId) return;
      const [row] = await engine.executeRaw<{ kind: string }>(
        "SELECT intent->>'kind' AS kind FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (row?.kind !== 'connector_v2_import') return;
      retainedRequestId = detail.requestId;
      markWriterBlocked();
      return writerGate;
    });

    let runPromise: Promise<Awaited<ReturnType<typeof runGoogleSync>>> | undefined;
    try {
      runPromise = withPausedOwnerBudget(() => withEnv({ GBRAIN_SINGLE_WRITE_GROUP: '0' }, async () => {
        resetWriteSwitches();
        return runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id, drain: true }, fetcher);
      }).finally(() => resetWriteSwitches()));
      const reached = await Promise.race([writerBlocked.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000))]);
      expect(reached).toBe(true);
      const [pending] = await Promise.race([
        (async () => {
          for (let i = 0; i < 600; i++) {
            const rows = await connectorPendingSet(engine, f.id);
            if (rows.length) return rows;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          return [];
        })(),
        new Promise<Awaited<ReturnType<typeof connectorPendingSet>>>(resolve => setTimeout(() => resolve([]), 7_000)),
      ]);
      expect(pending).toBeDefined();
      expect(pending?.itemRef).toContain('drain-tail-spam');

      releaseWriter();
      const result = await runPromise;
      expect(result.reason).not.toBe('writer_pending');
      expect(drainHistoryCalls).toBeGreaterThan(1);
      expect(result.added).toBe(2);
      expect(result.loops_enqueue).toBeDefined();
      expect(result.loops_enqueue?.skipped_reason).toBe('chat_unavailable');
      const imports = await engine.executeRaw<{ slug: string; noop: boolean }>(
        "SELECT slug,outcome->>'noop'='true' AS noop FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY sequence", [f.id]);
      expect(imports.filter(row => !row.noop)).toHaveLength(2);
      expect(imports.some(row => row.slug.includes('drain-tail-human'))).toBe(true);
    } finally {
      releaseWriter();
      installFaultHook(undefined);
      await runPromise?.catch(() => {});
    }
  }
}), 120_000);


test('opt-in managed Gmail catch-up walks historical mail before the delta lane', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const order: string[] = [];
    let listedHistorical = false;
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      order.push(u.pathname);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) {
        if (!listedHistorical) {
          listedHistorical = true;
          return json({ messages: [{ id: '18c2f4a9b3d2c001', threadId: TIDS[1]! }] });
        }
        return json({ messages: [] });
      }
      if (u.pathname.endsWith('/users/me/history')) {
        const history = u.searchParams.get('startHistoryId') === '1000' ? [{ messages: [{ threadId: TIDS[0]! }] }] : [];
        return json({ historyId: '1010', history });
      }
      const match = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (match) {
        const index = TIDS.indexOf(match[1]!);
        return json({ id: match[1], messages: [{ id: `18c2f4a9b3d2${String(index).padStart(4, '0')}`, threadId: match[1], labelIds: [],
          internalDate: String(NOW_MS - (40 + index) * 86_400_000), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: `Catch-up fixture ${index}` }], body: { data: b64url(`Catch-up fixture body ${index}.`) } } }] });
      }
      throw new Error(`Unexpected fixture route: ${u.pathname}`);
    }, cfg.account);

    await withEnv({ GBRAIN_GMAIL_BACKFILL_FIRST: '1' }, () =>
      runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id, drain: true }, fetcher));
    const messageListIndex = order.findIndex(path => path.endsWith('/users/me/messages'));
    const historyIndex = order.findIndex(path => path.endsWith('/users/me/history'));
    expect(messageListIndex).toBeGreaterThanOrEqual(0);
    expect(historyIndex).toBeGreaterThan(messageListIndex);
    const [checkpoint] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { gmail_backfill_done?: boolean; gmail_history_id?: string } }[] }[];
    expect(checkpoint.completed_keys[0]?.state?.gmail_backfill_done).toBe(true);
    expect(checkpoint.completed_keys[0]?.state?.gmail_history_id).toBe('1010');
    const imports = await engine.executeRaw<{ slug: string; noop: boolean }>(
      "SELECT slug,outcome->>'noop'='true' AS noop FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY sequence", [f.id]);
    expect(imports.filter(row => !row.noop)).toHaveLength(2);
    expect(imports.some(row => row.slug.includes('catch-up-fixture-0'))).toBe(true);
    expect(imports.some(row => row.slug.includes('catch-up-fixture-1'))).toBe(true);
  }
}), 120_000);


test('managed Gmail backfill checkpoints each landed unchanged thread floor immediately', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const threadIds = [TIDS[5]!, TIDS[6]!];
    let listCalls = 0;
    let threadFetches = 0;
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
      if (u.pathname.endsWith('/users/me/messages')) {
        const query = u.searchParams.get('q') ?? '';
        if (query.includes('after:') && query.includes('before:')) {
          listCalls++;
          return json({ messages: listCalls === 1 ? threadIds.map((threadId, i) => ({ id: `history-msg-${i}`, threadId })) : [] });
        }
        return json({ messages: [] });
      }
      const match = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (match) {
        threadFetches++;
        const i = TIDS.indexOf(match[1]!);
        return json({ id: match[1], messages: [{ id: `18c2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: match[1]!, labelIds: [],
          internalDate: String(NOW_MS - (40 + i) * 86_400_000), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: `Unchanged backfill ${i}` }], body: { data: b64url(`Unchanged backfill body ${i}.`) } } }] });
      }
      throw new Error(`Unexpected fixture route: ${u.pathname}`);
    }, cfg.account);
    const run = () => withEnv({ GBRAIN_GMAIL_BACKFILL_FIRST: '1' }, () =>
      runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id, noEmbed: true, noExtract: true, noLoopsExtract: true }, fetcher));

    await run(); // Creates both pages and completes the initial historical walk.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(
      jsonb_set(completed_keys,'{0,state,gmail_backfill_done}','false'::jsonb,true),
      '{0,state,gmail_backfill_floor_ms}',to_jsonb($2::bigint),true)
      WHERE op='managed-connector' AND fingerprint IN
      (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)`, [f.id, NOW_MS + 60_000]);
    const [lastBefore] = await engine.executeRaw<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence),0)::int AS sequence FROM persistence_requests WHERE source_id=$1', [f.id]);
    listCalls = 0;
    threadFetches = 0;

    const replay = await run(); // Both pages are unchanged, but each landed thread advances the historical floor.
    expect(replay.added).toBe(0);
    expect(replay.modified).toBe(0);
    await disposePersistenceConsumer(engine);
    expect(threadFetches).toBe(2);
    const checkpoints = await engine.executeRaw<{ state: string; floor: string | null }>(
      `SELECT state,intent->'checkpointAfter'->0->'state'->>'gmail_backfill_floor_ms' AS floor
       FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint'
         AND sequence>$2 ORDER BY sequence`, [f.id, lastBefore!.sequence]);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.every(row => row.state === 'committed')).toBe(true);
    const floorWrites = checkpoints.filter(row => row.floor !== null);
    expect(floorWrites).toHaveLength(2);
    expect(floorWrites.map(row => Number(row.floor))).toEqual([
      NOW_MS - (40 + 5) * 86_400_000,
      NOW_MS - (40 + 6) * 86_400_000,
    ]);
  }
}), 120_000);


test('managed Gmail historical resume includes threads tied at a persisted exact-second floor', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const threadIds = [TIDS[5]!, TIDS[6]!];
    const sameMs = NOW_MS - 40 * 86_400_000;
    let listedThreadIds = [threadIds[0]!];
    const threadFetches = new Map<string, number>();
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
      if (u.pathname.endsWith('/users/me/messages')) {
        const query = u.searchParams.get('q') ?? '';
        if (query.includes('after:') && query.includes('before:')) {
          const afterMs = Number(query.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
          const beforeMs = Number(query.match(/before:(\d+)/)?.[1] ?? 0) * 1000;
          return json({ messages: sameMs > afterMs && sameMs < beforeMs
            ? listedThreadIds.map((threadId, i) => ({ id: `same-second-msg-${i}`, threadId })) : [] });
        }
        return json({ messages: [] });
      }
      const match = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (match) {
        const threadId = match[1]!;
        const i = TIDS.indexOf(threadId);
        threadFetches.set(threadId, (threadFetches.get(threadId) ?? 0) + 1);
        return json({ id: threadId, messages: [{ id: `18c2f4a9b3d2${String(i).padStart(4, '0')}`, threadId, labelIds: [],
          internalDate: String(sameMs), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: `Same-second boundary ${i}` }], body: { data: b64url(`Same-second body ${i}.`) } } }] });
      }
      throw new Error(`Unexpected fixture route: ${u.pathname}`);
    }, cfg.account);
    const run = () => withEnv({ GBRAIN_GMAIL_BACKFILL_FIRST: '1' }, () =>
      runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id, noEmbed: true, noExtract: true, noLoopsExtract: true }, fetcher));

    await run(); // Lands the first thread and commits its exact-second floor.
    await disposePersistenceConsumer(engine);
    const [firstFloor] = await engine.executeRaw<{ state: unknown }>(
      `SELECT intent->'checkpointAfter'->0->'state' AS state FROM persistence_requests
       WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint'
         AND intent->'checkpointAfter'->0->'state'->>'gmail_backfill_floor_ms'=$2
       ORDER BY sequence LIMIT 1`, [f.id, String(sameMs)]);
    expect(firstFloor?.state).toBeDefined();
    listedThreadIds = threadIds;
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,state}',$2::jsonb,true)
      WHERE op='managed-connector' AND fingerprint IN
      (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)`, [f.id, firstFloor!.state]);

    // Restore the exact checkpoint saved after thread A, before thread B at the same millisecond was landed.
    await run();
    expect(threadFetches.get(threadIds[1]!)).toBe(1);
    const imports = await engine.executeRaw<{ slug: string; state: string }>(
      "SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY sequence", [f.id]);
    expect(imports).toHaveLength(2);
    expect(imports.every(row => row.state === 'committed')).toBe(true);
    expect(imports.some(row => row.slug.includes('same-second-boundary-5'))).toBe(true);
    expect(imports.some(row => row.slug.includes('same-second-boundary-6'))).toBe(true);
  }
}), 120_000);


test('managed Gmail drain waits for receipts then continues into historical backfill', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const threadId = TIDS[0]!;
    const calls: string[] = [];
    const messageListTokens: (string | null)[] = [];
    let backfillListStarted = false;
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/history')) {
        backfillListStarted = false;
        const history = u.searchParams.get('startHistoryId') === '1000' ? [{ messages: [{ threadId }] }] : [];
        return json({ historyId: '1010', history });
      }
      if (u.pathname.endsWith('/users/me/messages')) {
        const token = u.searchParams.get('pageToken');
        messageListTokens.push(token);
        if (token === 'historical-page-2') return json({ messages: [{ id: '18c2f4a9b3d2c002', threadId: TIDS[2]! }] });
        if (backfillListStarted) return json({ messages: [] });
        backfillListStarted = true;
        return json({ messages: [{ id: '18c2f4a9b3d2c001', threadId: TIDS[1]! }], nextPageToken: 'historical-page-2' });
      }
      const match = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (match) {
        const index = TIDS.indexOf(match[1]!);
        return json({ id: match[1], messages: [{ id: `18c2f4a9b3d2${String(index).padStart(4, '0')}`, threadId: match[1], labelIds: [],
          internalDate: String(NOW_MS - (40 + index) * 86_400_000), payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'Peer Example <peer@example.invalid>' }, { name: 'To', value: cfg.account },
            { name: 'Subject', value: `Continuation fixture ${index}` }], body: { data: b64url(`Continuation fixture body ${index}.`) } } }] });
      }
      throw new Error(`Unexpected fixture route: ${u.pathname}`);
    }, cfg.account);

    let releaseWriter!: () => void;
    let markWriterBlocked!: () => void;
    const writerBlocked = new Promise<void>(resolve => { markWriterBlocked = resolve; });
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    let retainedRequestId: string | undefined;
    installFaultHook((point, detail) => {
      if (point === 'publication:prepared' && detail.sourceId === f.id && detail.requestId && !retainedRequestId) {
        retainedRequestId = detail.requestId;
        markWriterBlocked();
        return writerGate;
      }
    });

    let runPromise: Promise<Awaited<ReturnType<typeof runGoogleSync>>> | undefined;
    // The Postgres group-publish fast path bypasses publication:prepared.
    try {
      runPromise = withPausedOwnerBudget(() => withEnv({ GBRAIN_SINGLE_WRITE_GROUP: '0' }, async () => {
        resetWriteSwitches();
        return runGoogleSync(engine, f.id, cfg, { ...options, sourceId: f.id, drain: true }, fetcher);
      }).finally(() => resetWriteSwitches()));
      await writerBlocked;
      const requestId = retainedRequestId;
      expect(requestId).toBeDefined();
      if (!requestId) throw new Error('publication gate did not capture its receipt');
      const [retained] = await engine.executeRaw<{ intent_kind: string; state: string; recovery_present: boolean; claim_live: boolean }>(
        "SELECT intent->>'kind' AS intent_kind,state,recovery IS NOT NULL AS recovery_present,claim_expires_at > now() AS claim_live FROM persistence_requests WHERE request_id=$1::uuid",
        [requestId]);
      expect(retained).toMatchObject({ intent_kind: 'connector_v2_import', state: 'running', recovery_present: true, claim_live: true });
      let pending = [] as Awaited<ReturnType<typeof connectorPendingSet>>;
      for (let i = 0; i < 300; i++) {
        pending = await connectorPendingSet(engine, f.id);
        if (pending.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pending.length).toBeGreaterThan(0);
      const historyCallsBefore = calls.filter(path => path.endsWith('/users/me/history')).length;
      const messageListCallsBefore = messageListTokens.length;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(calls.filter(path => path.endsWith('/users/me/history'))).toHaveLength(historyCallsBefore);
      expect(messageListTokens).toHaveLength(messageListCallsBefore);

      releaseWriter();
      const result = await runPromise;
      expect(result.reason).not.toBe('writer_pending');
      expect(['first_sync', 'synced']).toContain(result.status);
      expect(result.added).toBe(3);
      expect(result.pagesAffected).toHaveLength(2);
      expect(calls.filter(path => path.endsWith('/users/me/history')).length).toBeGreaterThan(historyCallsBefore);
      expect(calls.some(path => path.endsWith('/users/me/messages'))).toBe(true);
      expect(messageListTokens.slice(messageListCallsBefore)).toEqual([null, 'historical-page-2', null]);
      expect(calls.some(path => path.includes('/calendar/'))).toBe(false);
      expect(await connectorPendingSet(engine, f.id)).toEqual([]);
      const [checkpoint] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { gmail_backfill_done?: boolean; gmail_history_id?: string } }[] }[];
      expect(checkpoint.completed_keys[0]?.state?.gmail_backfill_done).toBe(true);
      expect(checkpoint.completed_keys[0]?.state?.gmail_history_id).toBe('1010');
      const imports = await engine.executeRaw<{ slug: string; noop: boolean }>(
        "SELECT slug,outcome->>'noop'='true' AS noop FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY sequence", [f.id]);
      expect(imports.filter(row => !row.noop)).toHaveLength(3);
      expect(new Set(imports.map(row => row.slug)).size).toBe(3);
      expect(imports.every(row => row.slug.includes('continuation-fixture'))).toBe(true);
      expect(imports).toHaveLength(3);
    } finally {
      releaseWriter();
      installFaultHook(undefined);
      await runPromise?.catch(() => {});
    }
  }
}), 120_000);
