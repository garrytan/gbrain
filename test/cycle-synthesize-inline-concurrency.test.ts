/**
 * #4194 — bounded concurrency for the dream inline drain.
 *
 * Drives runSubagentsInline directly with a controllable fake handler against
 * a real MinionQueue on PGLite, pinning:
 *   - overlap up to the configured N (the wall-clock win exists)
 *   - N=1 stays strictly serial (pre-#4194 behavior preserved)
 *   - one failing child never blocks siblings
 *   - UnrecoverableError dead-letters immediately (CDX-3; the drain used to
 *     retry these to exhaustion)
 *   - RateLeaseUnavailableError requeues WITHOUT burning an attempt
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runSubagentsInline, percentile } from '../src/core/cycle/inline-drain.ts';
import { UnrecoverableError, type MinionHandler } from '../src/core/minions/types.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/handlers/subagent.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let schemaVersion: string;
let queueSeq = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seedChildren(queueName: string, count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const job = await queue.add(
      'subagent',
      { prompt: `child ${i}` },
      { queue: queueName },
      { allowProtectedSubmit: true },
    );
    ids.push(job.id);
  }
  return ids;
}

async function statuses(ids: number[]): Promise<Record<string, number>> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM minion_jobs WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runSubagentsInline concurrency (#4194)', () => {
  test('N=3 overlaps children (maxInFlight >= 2) and completes all', async () => {
    const queueName = `dream-inline-test-${++queueSeq}`;
    const ids = await seedChildren(queueName, 3);
    let inFlight = 0;
    let maxInFlight = 0;
    const handler: MinionHandler = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(200);
      inFlight--;
      return { ok: true };
    };
    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000, 3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(await statuses(ids)).toEqual({ completed: 3 });
  }, 30_000);

  test('N=1 (default) stays strictly serial', async () => {
    const queueName = `dream-inline-test-${++queueSeq}`;
    const ids = await seedChildren(queueName, 3);
    let inFlight = 0;
    let maxInFlight = 0;
    const handler: MinionHandler = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(50);
      inFlight--;
      return { ok: true };
    };
    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000);
    expect(maxInFlight).toBe(1);
    expect(await statuses(ids)).toEqual({ completed: 3 });
  }, 30_000);

  test('one failing child does not block siblings (they complete)', async () => {
    const queueName = `dream-inline-test-${++queueSeq}`;
    const ids = await seedChildren(queueName, 3);
    const failId = ids[1];
    const handler: MinionHandler = async (ctx) => {
      await sleep(30);
      if (ctx.id === failId) throw new Error('child exploded');
      return { ok: true };
    };
    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000, 3);
    const byStatus = await statuses(ids);
    expect(byStatus.completed).toBe(2);
    // The failing child retries (delayed → promoted) until attempts exhaust,
    // then dead-letters — a child failure is a job outcome, not a drain crash.
    expect(byStatus.dead).toBe(1);
  }, 30_000);

  test('UnrecoverableError dead-letters after ONE invocation (CDX-3)', async () => {
    const queueName = `dream-inline-test-${++queueSeq}`;
    const ids = await seedChildren(queueName, 1);
    let invocations = 0;
    const handler: MinionHandler = async () => {
      invocations++;
      throw new UnrecoverableError('all 3 put_page write(s) failed');
    };
    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000, 2);
    expect(invocations).toBe(1);
    const rows = await engine.executeRaw<{ status: string; error_text: string | null }>(
      `SELECT status, error_text FROM minion_jobs WHERE id = $1`,
      [ids[0]],
    );
    expect(rows[0]!.status).toBe('dead');
    expect(rows[0]!.error_text).toContain('put_page');
  }, 30_000);

  test('RateLeaseUnavailableError requeues without burning an attempt', async () => {
    const queueName = `dream-inline-test-${++queueSeq}`;
    const ids = await seedChildren(queueName, 1);
    let invocations = 0;
    const handler: MinionHandler = async () => {
      invocations++;
      if (invocations === 1) throw new RateLeaseUnavailableError('anthropic:messages', 32, 32);
      return { ok: true };
    };
    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000, 2);
    expect(invocations).toBe(2);
    const rows = await engine.executeRaw<{ status: string; attempts_made: number }>(
      `SELECT status, attempts_made::int AS attempts_made FROM minion_jobs WHERE id = $1`,
      [ids[0]],
    );
    expect(rows[0]!.status).toBe('completed');
    // The lease bounce did NOT consume an attempt; only the successful run
    // claimed one.
    expect(rows[0]!.attempts_made).toBeLessThanOrEqual(1);
  }, 30_000);
});

describe('percentile helper (#4194 telemetry)', () => {
  test('empty sample → null, never NaN', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });
  test('single sample → that value for any p', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
  test('nearest-rank on a spread', () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(vals, 50)).toBe(50);
    expect(percentile(vals, 95)).toBe(100);
    expect(percentile([...vals].reverse(), 50)).toBe(50); // unsorted input ok
  });
});

describe('loadSynthConfig knob validation (#4194/#4216)', () => {
  const { loadSynthConfig } = require('../src/core/cycle/synthesize.ts');

  test('inline_concurrency clamps to [1,8], floors, and shrugs off garbage', async () => {
    await engine.setConfig('dream.synthesize.inline_concurrency', '0');
    expect((await loadSynthConfig(engine)).inlineConcurrency).toBe(1);
    await engine.setConfig('dream.synthesize.inline_concurrency', '50');
    expect((await loadSynthConfig(engine)).inlineConcurrency).toBe(8);
    await engine.setConfig('dream.synthesize.inline_concurrency', '3.9');
    expect((await loadSynthConfig(engine)).inlineConcurrency).toBe(3);
    await engine.setConfig('dream.synthesize.inline_concurrency', 'garbage');
    expect((await loadSynthConfig(engine)).inlineConcurrency).toBe(1);
    await engine.unsetConfig('dream.synthesize.inline_concurrency');
    expect((await loadSynthConfig(engine)).inlineConcurrency).toBe(1); // default
  });

  test("mode: unknown value warns + falls back to 'oneshot'; casing/whitespace tolerated", async () => {
    expect((await loadSynthConfig(engine)).mode).toBe('oneshot'); // D1=A default
    await engine.setConfig('dream.synthesize.mode', 'agentic');
    expect((await loadSynthConfig(engine)).mode).toBe('agentic');
    await engine.setConfig('dream.synthesize.mode', '  ONESHOT ');
    expect((await loadSynthConfig(engine)).mode).toBe('oneshot');
    await engine.setConfig('dream.synthesize.mode', 'turbo');
    expect((await loadSynthConfig(engine)).mode).toBe('oneshot'); // warn + default
    await engine.unsetConfig('dream.synthesize.mode');
  });

  test("link_manifest: default ON; only explicit false/0/off disables (case/space-insensitive)", async () => {
    expect((await loadSynthConfig(engine)).linkManifest).toBe(true);
    for (const off of ['false', ' OFF ', '0']) {
      await engine.setConfig('dream.synthesize.link_manifest', off);
      expect((await loadSynthConfig(engine)).linkManifest).toBe(false);
    }
    await engine.setConfig('dream.synthesize.link_manifest', 'true');
    expect((await loadSynthConfig(engine)).linkManifest).toBe(true);
    await engine.unsetConfig('dream.synthesize.link_manifest');
  });
});

describe('pool abort on a loop-level failure (OV-6)', () => {
  test('a non-retryable queue failure rejects the pool without hanging siblings', async () => {
    const queueName = `dream-inline-test-${++queueSeq}`;
    await seedChildren(queueName, 6);
    let claims = 0;
    const realClaim = queue.claim.bind(queue);
    const brokenQueue = new Proxy(queue, {
      get(target, prop, receiver) {
        if (prop === 'claim') {
          return async (...args: Parameters<typeof realClaim>) => {
            claims++;
            if (claims === 2) throw new Error('catastrophic non-retryable queue failure');
            return realClaim(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const handler: MinionHandler = async () => {
      await sleep(20);
      return { ok: true };
    };
    // One loop dies on the poisoned claim; poolAbort stops siblings after
    // their current child; the pool rejects with the loop-level cause
    // instead of hanging on the remaining unclaimed children.
    await expect(
      runSubagentsInline(engine, brokenQueue, queueName, undefined, handler, 30_000, 3),
    ).rejects.toThrow('catastrophic non-retryable queue failure');
  }, 30_000);
});
