/**
 * #1685 GAP D — extract-atoms-drain Minion handler: registration + protected
 * gate. Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  formatDrainProviderFailure,
  MAX_DRAIN_CONTINUATIONS,
  queueDrainContinuation,
  type ExtractAtomsDrainResult,
} from '../src/core/cycle/extract-atoms-drain.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('extract-atoms-drain handler', () => {
  test('registerBuiltinHandlers registers the handler', async () => {
    const worker = new MinionWorker(engine);
    await registerBuiltinHandlers(worker, engine);
    expect(worker.registeredNames).toContain('extract-atoms-drain');
  });

  test('queue.add rejects an untrusted submission (PROTECTED, CODEX #1)', async () => {
    await expect(queue.add('extract-atoms-drain', { sourceId: 'default' })).rejects.toThrow(
      /protected job name/i,
    );
  });

  test('queue.add accepts a trusted submission (allowProtectedSubmit)', async () => {
    const job = await queue.add(
      'extract-atoms-drain',
      { sourceId: 'default', window: 120 },
      { queue: 'default' },
      { allowProtectedSubmit: true },
    );
    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe('extract-atoms-drain');
  });

  // #3813: the provider_failure throw is the job's error_text once it
  // dead-letters. It carried only batches/remaining, so a missing provider key
  // was invisible from every supported surface even though the drain result
  // has carried a sanitized representative `last_error`.
  test('provider_failure error text carries the drain\'s last_error', () => {
    const result = {
      status: 'provider_failure',
      batches: 1,
      remaining: 151,
      last_error: 'concepts/alice-example: Anthropic chat requires ANTHROPIC_API_KEY.',
    } as ExtractAtomsDrainResult;
    const msg = formatDrainProviderFailure(result);
    expect(msg).toContain('batches=1');
    expect(msg).toContain('remaining=151');
    expect(msg).toContain('ANTHROPIC_API_KEY');
    // A clean-run shape (no representative error) keeps the original message.
    expect(formatDrainProviderFailure({ ...result, last_error: null })).not.toContain('last error');
  });
});

describe('extract-atoms-drain background continuation', () => {
  const cut = (over: Partial<ExtractAtomsDrainResult> = {}): ExtractAtomsDrainResult => ({
    phase: 'extract_atoms', status: 'ok', extracted: 2, skipped: 0, remaining: 3, transcripts_remaining: 0,
    batches: 1, items_completed: 2, items_deferred: 1, stopped: 'window', failure_count: 0, failures: [],
    omitted_failure_count: 0, last_error: null, ...over,
  });
  async function parent(data: Record<string, unknown> = { sourceId: 'default', window: 120 }) {
    return queue.add('extract-atoms-drain', data, { queue: 'default', max_attempts: 3, timeout_ms: 600_000 },
      { allowProtectedSubmit: true });
  }

  test('a window cut with progress chains exactly one continuation carrying the parent budget', async () => {
    const job = await parent();
    const first = await queueDrainContinuation(engine, { id: job.id, data: job.data }, cut());
    expect(first).toMatchObject({ queued: true, depth: 1 });
    const again = await queueDrainContinuation(engine, { id: job.id, data: job.data }, cut());
    expect(again).toEqual(first); // a retried parent handler cannot fork the chain
    const rows = await engine.executeRaw<{ data: Record<string, unknown>; timeout_ms: number; max_attempts: number }>(
      "SELECT data, timeout_ms, max_attempts FROM minion_jobs WHERE name='extract-atoms-drain' AND id <> $1", [job.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ timeout_ms: 600_000, max_attempts: 3 });
    expect(rows[0].data).toMatchObject({ sourceId: 'default', window: 120, continuation_of: job.id, continuation_depth: 1 });
  });

  test('deferred transcripts alone still count as work left', async () => {
    const job = await parent();
    expect(await queueDrainContinuation(engine, job, cut({ remaining: 0, transcripts_remaining: 2, items_deferred: 2 })))
      .toMatchObject({ queued: true });
  });

  test('no continuation when drained, stalled, failing, or at the chain limit — and the reason says why', async () => {
    const job = await parent();
    expect(await queueDrainContinuation(engine, job, cut({ remaining: 0, items_deferred: 0, stopped: 'drained' })))
      .toEqual({ queued: false, reason: 'drained' });
    expect(await queueDrainContinuation(engine, job, cut({ items_completed: 0 })))
      .toEqual({ queued: false, reason: 'no_forward_progress' });
    expect(await queueDrainContinuation(engine, job, cut({ stopped: 'no_progress', items_deferred: 0 })))
      .toEqual({ queued: false, reason: 'not_window_cut' });
    expect(await queueDrainContinuation(engine, job, cut({ status: 'provider_failure', stopped: 'provider_failure' })))
      .toEqual({ queued: false, reason: 'not_window_cut' });
    const deep = await parent({ sourceId: 'default', continuation_depth: MAX_DRAIN_CONTINUATIONS });
    expect(await queueDrainContinuation(engine, deep, cut())).toEqual({ queued: false, reason: 'continuation_limit' });
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data ? 'continuation_of'")).toEqual([]);
  });
});
