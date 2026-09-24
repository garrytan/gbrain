/**
 * Background extract_atoms drain policy (src/core/cycle/extract-atoms-auto-drain.ts):
 *
 *  - N1: a drain continuation is a drain job like any other, so it obeys
 *    `autopilot.auto_drain.max_usd_per_day` and never takes the slot another
 *    due source needs for its first drain of the day. A blocked continuation
 *    says why, with the numbers.
 *  - N2: autopilot's initial dispatch treats live transcripts as due work
 *    (the page backlog never counts them), without duplicate dispatch.
 *  - N3: a drain reads the transcript corpus from disk once, not per batch.
 *  - P3-1: initial dispatch and continuation fail closed identically
 *    (disabled, zero budget, unknown daily count).
 *  - P3-2: cap-lock contention never loses work — the initial dispatch
 *    retries next tick; the continuation becomes a durable delayed job that
 *    rechecks the same budget gate when it starts.
 *
 * Hermetic PGLite: generic fixtures, a temp corpus dir, stubbed chat.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  queueDrainContinuation,
  runExtractAtomsDrainForSource,
  type ExtractAtomsDrainResult,
} from '../src/core/cycle/extract-atoms-drain.ts';
import * as discovery from '../src/core/cycle/transcript-discovery.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Loaded lazily so the N1/N3 cases still run (and fail on behaviour) against
// a tree that predates the policy module.
const dispatchAutoDrains: typeof import('../src/core/cycle/extract-atoms-auto-drain.ts').dispatchAutoDrains =
  async (...args) => (await import('../src/core/cycle/extract-atoms-auto-drain.ts')).dispatchAutoDrains(...args);
const recheckDeferredContinuation: typeof import('../src/core/cycle/extract-atoms-drain.ts').recheckDeferredContinuation =
  async (...args) => (await import('../src/core/cycle/extract-atoms-drain.ts')).recheckDeferredContinuation(...args);
/** Dispatched jobs, whatever the return shape (an array before P3-1). */
const list = (r: unknown) => (Array.isArray(r) ? r : (r as { dispatched: unknown[] }).dispatched);
const blockedOf = (r: unknown) => (Array.isArray(r) ? undefined : (r as { blocked: string | null }).blocked);
const CAP_LOCK = 'extract-atoms-drain-daily-cap';

/** Make the daily drain-count query fail, as a DB error would. */
async function withCountFailure<T>(fn: () => Promise<T>): Promise<T> {
  const orig = engine.executeRaw.bind(engine);
  const spy = spyOn(engine, 'executeRaw').mockImplementation(((sql: string, params?: unknown[]) =>
    /count\(\*\)::int AS cnt FROM minion_jobs WHERE name = 'extract-atoms-drain'/.test(sql)
      ? Promise.reject(new Error('count unavailable'))
      : orig(sql, params)) as typeof engine.executeRaw);
  try { return await fn(); } finally { spy.mockRestore(); }
}

beforeEach(async () => {
  // Targeted cleanup: resetPgliteState would also clear the schema-version
  // config row MinionQueue checks.
  for (const sql of [
    'DELETE FROM minion_jobs', 'DELETE FROM pages', 'DELETE FROM extract_atoms_page_state',
    'DELETE FROM extract_atoms_transcript_state', "DELETE FROM sources WHERE id <> 'default'",
    "UPDATE sources SET local_path = NULL WHERE id = 'default'",
    "DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'dream.%' OR key = 'cycle.extract_atoms.page_discovery_budget'",
  ]) await engine.executeRaw(sql);
  root = mkdtempSync(join(tmpdir(), 'gbrain-auto-drain-'));
});

const windowCut = (over: Partial<ExtractAtomsDrainResult> = {}): ExtractAtomsDrainResult => ({
  phase: 'extract_atoms', status: 'ok', extracted: 2, skipped: 0, remaining: 3, transcripts_remaining: 0,
  batches: 1, items_completed: 2, items_deferred: 1, stopped: 'window', failure_count: 0, failures: [],
  omitted_failure_count: 0, last_error: null, ...over,
});

async function parentDrain(data: Record<string, unknown> = { sourceId: 'default', window: 120 }) {
  return queue.add('extract-atoms-drain', data, { queue: 'default', max_attempts: 3 }, { allowProtectedSubmit: true });
}

async function drainJobCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name='extract-atoms-drain'");
  return Number(row.n);
}

/** A second source with a page backlog above threshold 1 (two eligible pages). */
async function seedDueSource(id: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES ($1, $1, $2)', [id, root]);
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
  for (const n of [1, 2]) {
    await engine.putPage(`meetings/${id}-${n}`, {
      title: `${id} ${n}`, type: 'meeting', timeline: '',
      compiled_truth: `Synthetic evidence ${id} ${n} with enough source detail for extraction. `.repeat(20),
    }, { sourceId: id });
  }
}

/** A transcript corpus with `n` files, wired through the DB-plane dream.* config. */
async function seedCorpus(n: number): Promise<string> {
  const dir = mkdtempSync(join(root, 'sessions-'));
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `2026-01-0${i + 1}-session.txt`), `Synthetic session ${i} about a generic topic. `.repeat(80));
  }
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  return dir;
}

describe('N1: continuations obey the daily spend cap and fairness', () => {
  test('a $0.30/day ceiling allows exactly one drain job, so a continuation is refused with the numbers', async () => {
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
    const parent = await parentDrain();
    const result = await queueDrainContinuation(engine, parent, windowCut());
    expect(result).toEqual({ queued: false, reason: 'daily_cap', max_usd_per_day: 0.3, max_jobs_today: 1, jobs_today: 1 });
    expect(await drainJobCount()).toBe(1);
  });

  test('a continuation never takes the slot another due source needs today', async () => {
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.6'); // 2 jobs/day
    await seedDueSource('source-b');
    const parent = await parentDrain();
    const result = await queueDrainContinuation(engine, parent, windowCut());
    expect(result).toMatchObject({ queued: false, reason: 'reserved_for_other_sources', max_jobs_today: 2, jobs_today: 1,
      reserved_for_other_sources: ['source-b'] });
    expect(await drainJobCount()).toBe(1);
  });

  test('within budget and with no other due source the continuation queues', async () => {
    const parent = await parentDrain(); // default $2.00/day → 6 jobs
    expect(await queueDrainContinuation(engine, parent, windowCut())).toMatchObject({ queued: true, depth: 1 });
    expect(await drainJobCount()).toBe(2);
  });

  test('a retried parent reports its existing continuation even after the cap fills', async () => {
    const parent = await parentDrain();
    const first = await queueDrainContinuation(engine, parent, windowCut());
    expect(first).toMatchObject({ queued: true });
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
    expect(await queueDrainContinuation(engine, parent, windowCut())).toEqual(first);
    expect(await drainJobCount()).toBe(2);
  });

  test('auto-drain disabled means no autonomous continuation', async () => {
    await engine.setConfig('autopilot.auto_drain.enabled', 'false');
    const parent = await parentDrain();
    expect(await queueDrainContinuation(engine, parent, windowCut())).toMatchObject({ queued: false, reason: 'auto_drain_disabled' });
  });
});

describe('N2: autopilot dispatch sees transcript-only backlog', () => {
  test('live transcripts with an empty page backlog dispatch one drain, once per day', async () => {
    await seedCorpus(2);
    const first = list(await dispatchAutoDrains(engine, queue, {}));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ sourceId: 'default', backlog: { pages: 0, transcripts: 2 } });
    // Same day: the day key (and the in-flight job) block a duplicate.
    expect(list(await dispatchAutoDrains(engine, queue, {}))).toEqual([]);
    expect(await drainJobCount()).toBe(1);
  });

  test('no live transcripts and a page backlog under threshold dispatch nothing', async () => {
    await seedCorpus(0);
    expect(list(await dispatchAutoDrains(engine, queue, {}))).toEqual([]);
  });

  test('the daily cap bounds autopilot dispatch too', async () => {
    await seedCorpus(1);
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
    await parentDrain({ sourceId: 'other', window: 120 }); // today's only slot is used
    const r = await dispatchAutoDrains(engine, queue, {});
    expect(list(r)).toEqual([]);
    expect(blockedOf(r)).toBe('daily_cap');
  });
});

describe('P3-1: initial dispatch and continuation fail closed identically', () => {
  const cases: Array<{ name: string; cfg: Record<string, string>; countFails: boolean; reason: string }> = [
    { name: 'auto-drain disabled', cfg: { 'autopilot.auto_drain.enabled': 'false' }, countFails: false, reason: 'auto_drain_disabled' },
    { name: 'a $0 ceiling', cfg: { 'autopilot.auto_drain.max_usd_per_day': '0' }, countFails: false, reason: 'zero_budget' },
    { name: 'a ceiling below one run ($0.20)', cfg: { 'autopilot.auto_drain.max_usd_per_day': '0.2' }, countFails: false, reason: 'zero_budget' },
    { name: 'an unavailable daily count', cfg: {}, countFails: true, reason: 'budget_unknown' },
    { name: 'a $0 ceiling with an unavailable daily count', cfg: { 'autopilot.auto_drain.max_usd_per_day': '0' }, countFails: true, reason: 'zero_budget' },
  ];
  for (const c of cases) {
    test(`${c.name}: no initial dispatch, and the continuation is refused for the same reason`, async () => {
      await seedCorpus(1); // default is due (a live transcript)
      for (const [k, v] of Object.entries(c.cfg)) await engine.setConfig(k, v);
      const guard = <T>(fn: () => Promise<T>) => (c.countFails ? withCountFailure(fn) : fn());
      const initial = await guard(() => dispatchAutoDrains(engine, queue, {}));
      expect(list(initial)).toEqual([]);
      expect(blockedOf(initial)).toBe(c.reason);
      expect(await drainJobCount()).toBe(0);
      const parent = await parentDrain({ sourceId: 'other-source', window: 120 });
      expect(await guard(() => queueDrainContinuation(engine, parent, windowCut()))).toMatchObject({ queued: false, reason: c.reason });
      expect(await drainJobCount()).toBe(1);
    });
  }
});

describe('P3-2: cap-lock contention never loses work', () => {
  test('initial dispatch under a busy lock leaves nothing behind; the next tick dispatches', async () => {
    await seedCorpus(1);
    const held = await tryAcquireDbLock(engine, CAP_LOCK, 1);
    expect(held).not.toBeNull();
    try {
      const busy = await dispatchAutoDrains(engine, queue, {});
      expect(list(busy)).toEqual([]);
      expect(blockedOf(busy)).toBe('cap_lock_busy');
      expect(await drainJobCount()).toBe(0);
    } finally { await held!.release(); }
    expect(list(await dispatchAutoDrains(engine, queue, {}))).toHaveLength(1);
  }, 20_000);

  test('a continuation under a busy lock is queued durably once and rechecks its budget at start', async () => {
    const parent = await parentDrain();
    const held = await tryAcquireDbLock(engine, CAP_LOCK, 1);
    let jobId = 0;
    let data: Record<string, unknown> = {};
    try {
      const deferred = await queueDrainContinuation(engine, parent, windowCut());
      expect(deferred).toMatchObject({ queued: true, depth: 1, budget_check: 'deferred' });
      jobId = (deferred as { job_id: number }).job_id;
      // A retried parent reuses it: no duplicate continuation.
      expect(await queueDrainContinuation(engine, parent, windowCut())).toEqual(deferred);
      const [row] = await engine.executeRaw<{ status: string; data: Record<string, unknown>; max_attempts: number }>(
        'SELECT status, data, max_attempts FROM minion_jobs WHERE id = $1', [jobId]);
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      expect(row.status).toBe('delayed');
      expect(row.max_attempts).toBeGreaterThanOrEqual(5);
      expect(data).toMatchObject({ budget_recheck: true, continuation_of: parent.id, continuation_depth: 1 });
      // Still contended when it starts: throw, so the queue retries with backoff.
      await expect(recheckDeferredContinuation(engine, { id: jobId, data })).rejects.toThrow(/cap lock busy/);
    } finally { await held?.release(); }
    // Next attempt, lock free and budget available: it proceeds.
    expect(await recheckDeferredContinuation(engine, { id: jobId, data })).toEqual({ proceed: true });
    expect(await drainJobCount()).toBe(2);
  }, 20_000);

  test('a deferred continuation that starts over the cap is skipped by the real handler, with the numbers', async () => {
    const parent = await parentDrain();
    const held = await tryAcquireDbLock(engine, CAP_LOCK, 1);
    let deferred;
    try { deferred = await queueDrainContinuation(engine, parent, windowCut()); } finally { await held?.release(); }
    const jobId = (deferred as { job_id: number }).job_id;
    const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id = $1', [jobId]);
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3'); // the parent used the only slot
    const worker = new MinionWorker(engine);
    await registerBuiltinHandlers(worker, engine);
    const handler = worker.getHandler('extract-atoms-drain')!;
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const result = await handler({ id: jobId, data, signal: new AbortController().signal } as never);
    expect(result).toMatchObject({ status: 'skipped', reason: 'daily_cap', max_jobs_today: 1, jobs_today: 1, continuation_of: parent.id });
  }, 20_000);
});

describe('N3: one corpus read per drain', () => {
  test('a multi-batch drain reads the transcript corpus once while rechecking liveness', async () => {
    const corpus = await seedCorpus(2);
    await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1'); // one page per batch
    for (const n of [1, 2, 3]) {
      await engine.putPage(`meetings/corpus-read-${n}`, {
        title: `Corpus read ${n}`, type: 'meeting', timeline: '',
        compiled_truth: `Synthetic evidence ${n} with enough source detail for extraction. `.repeat(20),
      });
    }
    const chat = async (o: ChatOpts): Promise<ChatResult> => {
      const label = /^Source: (\S+)/.exec(String((o.messages[0] as { content: unknown }).content))?.[1] ?? 'x';
      const text = JSON.stringify([{ title: `Lesson ${label.split('/').pop()}`, atom_type: 'insight', body: 'A generic lesson.' }]);
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    };
    const spy = spyOn(discovery, 'discoverTranscripts');
    try {
      const result = await runExtractAtomsDrainForSource(engine, {
        sourceId: undefined, windowSeconds: 3600, brainDir: root, _phase: { _chat: chat },
      });
      console.log(`[N3 measurement] batches=${result.batches} corpus_reads=${spy.mock.calls.length} corpus=${corpus}`);
      expect(result).toMatchObject({ stopped: 'drained', remaining: 0, transcripts_remaining: 0, items_completed: 5 });
      expect(result.batches).toBeGreaterThanOrEqual(3);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
