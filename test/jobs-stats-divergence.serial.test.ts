/**
 * `jobs stats` divergence + waiting-TTL surfaces — WIRING test (five-issue
 * fix wave, commit 5). The data source (getStats drained fields + waiting_now)
 * is pinned in test/minions-admission.test.ts; this covers the stats-case
 * composition:
 *   1. ⚠ DIVERGENT QUEUE fires when intake > ratio × completed AND waiting
 *      depth exceeds the floor — computed against COMPLETED drain, so a
 *      TTL-cancellation storm cannot masquerade as healthy throughput.
 *   2. The scream carries the quota opt-in hint (default protection layer —
 *      the quota itself ships config-only per user decision D2C).
 *   3. ⚠ Waiting-TTL line reports 24h sweep cancellations by name.
 *   4. --json emits a parseable document with divergent + ttl_cancelled_24h.
 *   5. Healthy queues (drain keeping up) render neither scream.
 *
 * Serial: mutates GBRAIN_QUEUE_DIVERGENCE_* env via withEnv and captures
 * console.log around runJobs.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runJobs } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs`, []);
});

async function seedJobs(opts: { waiting: number; completed: number; ttlCancelled?: number }): Promise<void> {
  for (let i = 0; i < opts.waiting; i++) {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data) VALUES ('subagent', 'default', 'waiting', '{}'::jsonb)`,
      [],
    );
  }
  for (let i = 0; i < opts.completed; i++) {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data, started_at, finished_at)
       VALUES ('subagent', 'default', 'completed', '{}'::jsonb, now() - interval '10 minutes', now() - interval '5 minutes')`,
      [],
    );
  }
  for (let i = 0; i < (opts.ttlCancelled ?? 0); i++) {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data, error_text, finished_at)
       VALUES ('subagent', 'default', 'cancelled', '{}'::jsonb,
               'waiting_ttl_expired: waited > 48h in queue', now() - interval '1 hour')`,
      [],
    );
  }
}

async function captureStats(args: string[]): Promise<string> {
  const origLog = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try {
    await withEnv(
      { GBRAIN_QUEUE_DIVERGENCE_RATIO: '2', GBRAIN_QUEUE_DIVERGENCE_MIN_WAITING: '5' },
      async () => { await runJobs(engine, args); },
    );
  } finally {
    console.log = origLog;
  }
  return out;
}

describe('jobs stats — DIVERGENT QUEUE + waiting-TTL screams', () => {
  test('divergent intake vs completed drain screams with the quota opt-in hint', async () => {
    await seedJobs({ waiting: 20, completed: 2, ttlCancelled: 6 });
    const out = await captureStats(['stats']);
    expect(out).toContain("DIVERGENT QUEUE type 'subagent'");
    expect(out).toContain('gbrain config set minions.quota_max_waiting.subagent');
    // TTL sweep visibility rides the divergence report + its own line.
    expect(out).toContain('Waiting-TTL cancelled 6 job(s) in the last 24h');
    expect(out).toContain('minions.ttl_waiting_hours');
  });

  test('TTL cancellations do NOT count as drain (the shredder cannot look healthy)', async () => {
    // GUARD-DISTINGUISHING seed (adversarial-review finding: the old
    // 20/0/15 seed screamed under BOTH metrics, so the test couldn't detect
    // a naive-drain regression). Here: intake = 20 waiting + 30 cancelled =
    // 50 created-in-window; a NAIVE drain metric (completed+cancelled = 30)
    // gives 50 <= 2×30 → silent; the completed-based metric (0 completed)
    // gives 50 > 2×1 → screams. Only the correct metric fires.
    await seedJobs({ waiting: 20, completed: 0, ttlCancelled: 30 });
    const out = await captureStats(['stats']);
    expect(out).toContain('DIVERGENT QUEUE');
    expect(out).toContain('backlog never drains at current rate');
  });

  test('healthy queue (drain keeps up) renders no screams', async () => {
    await seedJobs({ waiting: 2, completed: 40 });
    const out = await captureStats(['stats']);
    expect(out).not.toContain('DIVERGENT QUEUE');
    expect(out).not.toContain('Waiting-TTL cancelled');
  });

  test('--json emits parseable divergent + ttl_cancelled_24h + per-type drain fields', async () => {
    await seedJobs({ waiting: 20, completed: 2, ttlCancelled: 3 });
    const out = await captureStats(['stats', '--json']);
    const doc = JSON.parse(out);
    expect(Array.isArray(doc.divergent)).toBe(true);
    expect(doc.divergent[0].name).toBe('subagent');
    expect(doc.divergent[0].waiting_now).toBe(20);
    expect(doc.ttl_cancelled_24h).toEqual([{ name: 'subagent', count: 3 }]);
    const sub = doc.by_type.find((t: { name: string }) => t.name === 'subagent');
    expect(sub.drained_completed).toBe(2);
    expect(sub.drained_cancelled).toBe(3);
  });
});
