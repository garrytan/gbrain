/**
 * Inline-drain idle-poll keepalive (src/core/cycle/inline-drain.ts :239) and
 * its swallow-on-throw catch arms.
 *
 * The idle branch fires when nothing is claimable but pending > 0 (e.g. a
 * 'delayed' child backing off). It MUST renew via yieldDuringPhase there:
 * with every child delayed no per-child keepalive is armed, and an unrenewed
 * lease reads as orphaned to spawn recovery — which would cancel a LIVE
 * queue. Both yieldDuringPhase call sites (idle poll :239 and post-claim
 * :250) swallow a throwing keepalive: renewal is best-effort and must never
 * fail the drain.
 *
 * Harness mirrors test/cycle-synthesize-inline-concurrency.test.ts: drive
 * runSubagentsInline directly with a controllable handler against a real
 * MinionQueue on PGLite. A child seeded with `delay` (status 'delayed',
 * future delay_until) forces the idle branch until promoteDelayed picks it
 * up (~the delay), keeping each test a few seconds (idle poll starts at 1s).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';
import type { MinionHandler } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let queueSeq = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Targeted DELETE preserves the `config.version` key MinionQueue's
  // ensureSchema requires (full resetPgliteState wipes it).
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function seedDelayedChild(queueName: string, delayMs: number): Promise<number> {
  const job = await queue.add(
    'subagent',
    { prompt: 'delayed child' },
    { queue: queueName, delay: delayMs },
    { allowProtectedSubmit: true },
  );
  return job.id;
}

async function status(id: number): Promise<string> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM minion_jobs WHERE id = $1`,
    [id],
  );
  return rows[0]!.status;
}

describe('inline-drain idle-poll keepalive', () => {
  test('idle branch (pending > 0, nothing claimable) fires yieldDuringPhase each poll', async () => {
    const queueName = `dream-inline-keepalive-${++queueSeq}`;
    // 2.5s delay: polls at ~0s and ~1s are guaranteed idle (claim sees only a
    // future-delayed row); the ~3s poll promotes + claims it.
    const childId = await seedDelayedChild(queueName, 2_500);

    let handlerStarted = false;
    let yieldsBeforeHandler = 0;
    const yieldDuringPhase = async () => {
      if (!handlerStarted) yieldsBeforeHandler++;
    };
    const handler: MinionHandler = async () => {
      handlerStarted = true;
      return { ok: true };
    };

    await runSubagentsInline(engine, queue, queueName, yieldDuringPhase, handler);

    // The post-claim site (:250) contributes exactly ONE pre-handler yield,
    // so >= 2 proves the idle-poll site (:239) fired at least once.
    expect(yieldsBeforeHandler).toBeGreaterThanOrEqual(2);
    expect(await status(childId)).toBe('completed');
  }, 30_000);

  test('a THROWING yieldDuringPhase is swallowed at both call sites; the drain still completes', async () => {
    const queueName = `dream-inline-keepalive-${++queueSeq}`;
    const childId = await seedDelayedChild(queueName, 1_500);

    let throws = 0;
    const yieldDuringPhase = async () => {
      throws++;
      throw new Error('keepalive exploded');
    };
    const handler: MinionHandler = async () => ({ ok: true });

    // Must resolve: both the idle-poll and post-claim call sites swallow.
    await runSubagentsInline(engine, queue, queueName, yieldDuringPhase, handler);

    // At least one idle-poll throw (the ~0s poll, while the child was still
    // delayed) plus the post-claim throw — both arms were exercised.
    expect(throws).toBeGreaterThanOrEqual(2);
    expect(await status(childId)).toBe('completed');
  }, 30_000);
});
