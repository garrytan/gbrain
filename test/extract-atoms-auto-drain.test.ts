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
    const first = await dispatchAutoDrains(engine, queue, {});
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ sourceId: 'default', backlog: { pages: 0, transcripts: 2 } });
    // Same day: the day key (and the in-flight job) block a duplicate.
    expect(await dispatchAutoDrains(engine, queue, {})).toEqual([]);
    expect(await drainJobCount()).toBe(1);
  });

  test('no live transcripts and a page backlog under threshold dispatch nothing', async () => {
    await seedCorpus(0);
    expect(await dispatchAutoDrains(engine, queue, {})).toEqual([]);
  });

  test('the daily cap bounds autopilot dispatch too', async () => {
    await seedCorpus(1);
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
    await parentDrain({ sourceId: 'other', window: 120 }); // today's only slot is used
    expect(await dispatchAutoDrains(engine, queue, {})).toEqual([]);
  });
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
