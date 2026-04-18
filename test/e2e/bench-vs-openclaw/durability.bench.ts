/**
 * Durability bench: Minions vs OpenClaw subagent dispatch under SIGKILL.
 *
 * The claim we're putting a number on: when the orchestrator process
 * dies mid-dispatch, Minions rescues the in-flight work via PG state +
 * stall detection; OpenClaw's `--local` agent loses it.
 *
 * Methodology:
 *
 *   Minions side — simulate a crashed worker by inserting 10 rows in
 *   status='active' with lock_until in the past (exactly the state a
 *   SIGKILLed worker leaves behind). Start a new worker and measure
 *   how many of the 10 jobs complete, and how long it takes.
 *
 *   OpenClaw side — spawn 10 `openclaw agent --local` processes in
 *   parallel. SIGKILL each after 500ms. Count how many managed to
 *   emit output before being killed. There is no persistence layer, so
 *   anything killed mid-dispatch is gone — no retry, no resume.
 *
 * Expected result: Minions 10/10, OpenClaw 0/10.
 *
 * Budget: ~$0 (Minions handlers do a tiny sleep; OC calls are killed
 * ~500ms in, so partial LLM streaming billing is negligible).
 *
 * Run: DATABASE_URL=... bun test test/e2e/bench-vs-openclaw/durability.bench.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from '../helpers.ts';
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import { MinionWorker } from '../../../src/core/minions/worker.ts';
import { runMigrations } from '../../../src/core/migrate.ts';
import { BENCH_PROMPT } from './harness.ts';

const skip = !hasDatabase();
const describeBench = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping durability bench (DATABASE_URL not set)');
}

const N = 10;

type Outcome = { completed: number; totalMs: number; perJobMs: number[] };

describeBench('Bench: Durability (SIGKILL mid-flight)', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrations(getEngine());
  });

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    await getConn().unsafe(
      `TRUNCATE minion_attachments, minion_inbox, minion_jobs RESTART IDENTITY CASCADE`,
    );
  });

  test('Minions: 10 active+expired-lock jobs fully rescued by new worker', async () => {
    const url = process.env.DATABASE_URL!;
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize: 4 });

    try {
      const queue = new MinionQueue(engine);
      const conn = getConn();

      // Seed: 10 jobs that look like they were claimed by a worker which
      // then got SIGKILLed (status=active, lock_until in the past).
      const seeded = await conn.unsafe<{ id: number }[]>(`
        INSERT INTO minion_jobs
          (name, queue, status, priority, data, max_attempts, attempts_made, attempts_started,
           backoff_type, backoff_delay, backoff_jitter, stalled_counter, max_stalled,
           lock_token, lock_until, on_child_fail, depth, remove_on_complete, remove_on_fail,
           started_at)
        SELECT
          'bench-rescue', 'default', 'active', 0, '{}'::jsonb, 3, 1, 1,
          'exponential', 1000, 0.2, 0, 3,
          'killed-worker:' || gs::text, now() - interval '10 seconds', 'fail_parent', 0, false, false,
          now() - interval '1 minute'
        FROM generate_series(1, ${N}) gs
        RETURNING id
      `);
      expect(seeded.length).toBe(N);

      const rescue = new MinionWorker(engine, {
        concurrency: 4,
        pollInterval: 50,
        lockDuration: 5_000,
        stalledInterval: 100, // fast stall requeue
        maxStalledCount: 3,
      });

      const completedAt = new Map<number, number>();
      rescue.register('bench-rescue', async () => {
        // Tiny work so we measure dispatch+reclaim overhead, not LLM latency.
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      });

      const t0 = performance.now();
      const startP = rescue.start();

      const deadline = Date.now() + 15_000;
      const ids = new Set(seeded.map((r) => r.id));
      while (Date.now() < deadline && ids.size > 0) {
        const rows = await conn.unsafe<{ id: number; status: string }[]>(
          `SELECT id, status FROM minion_jobs WHERE name = 'bench-rescue'`,
        );
        for (const row of rows) {
          if (row.status === 'completed' && ids.has(row.id)) {
            completedAt.set(row.id, Math.round(performance.now() - t0));
            ids.delete(row.id);
          }
        }
        if (ids.size > 0) await new Promise((r) => setTimeout(r, 50));
      }

      rescue.stop();
      await startP;

      const outcome: Outcome = {
        completed: completedAt.size,
        totalMs: Math.round(performance.now() - t0),
        perJobMs: [...completedAt.values()].sort((a, b) => a - b),
      };

      console.log(
        `\n[minions-durability] rescued=${outcome.completed}/${N} totalMs=${outcome.totalMs} perJob(p50/p95/max)=${outcome.perJobMs[Math.floor(N * 0.5)] ?? 0}/${outcome.perJobMs[Math.floor(N * 0.95)] ?? 0}/${outcome.perJobMs[N - 1] ?? 0}ms`,
      );

      expect(outcome.completed).toBe(N);
      // Truth: every seeded job is now 'completed', not stuck in 'active'
      const final = await conn.unsafe<{ status: string; n: number }[]>(
        `SELECT status, count(*)::int AS n FROM minion_jobs WHERE name = 'bench-rescue' GROUP BY status`,
      );
      const byStatus = Object.fromEntries(final.map((r) => [r.status, r.n]));
      expect(byStatus.completed).toBe(N);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);

  test('OpenClaw: 10 --local dispatches SIGKILLed mid-flight, 0 deliver output', async () => {
    const killDelayMs = 500;

    const runOne = async (idx: number): Promise<{ ok: boolean; wallMs: number; preKillBytes: number }> => {
      const t0 = performance.now();
      return await new Promise((resolve) => {
        const proc = spawn(
          'openclaw',
          ['agent', '--agent', 'main', '--local', '--message', BENCH_PROMPT, '--timeout', '30'],
          { env: process.env },
        );
        let stdout = '';
        let finalReplyBytes = 0;
        let killed = false;

        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', () => {});

        // Simulate the orchestrator crashing: SIGKILL mid-dispatch.
        const killer = setTimeout(() => {
          killed = true;
          // Snapshot any payload already emitted before the kill.
          finalReplyBytes = stdout
            .split('\n')
            .filter((l) => !l.startsWith('[agents]') && !l.startsWith('['))
            .join('\n')
            .trim().length;
          proc.kill('SIGKILL');
        }, killDelayMs);

        proc.on('close', () => {
          clearTimeout(killer);
          const wallMs = Math.round(performance.now() - t0);
          // Durability claim: output delivered to the caller before death.
          // If SIGKILL fired first, the caller got nothing actionable.
          resolve({ ok: !killed && finalReplyBytes === 0 ? true : false, wallMs, preKillBytes: finalReplyBytes });
        });

        proc.on('error', () => {
          clearTimeout(killer);
          resolve({ ok: false, wallMs: Math.round(performance.now() - t0), preKillBytes: 0 });
        });
      });
    };

    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));
    const totalMs = Math.round(performance.now() - t0);

    const delivered = results.filter((r) => r.preKillBytes > 0).length;
    const lost = N - delivered;
    const anyBytes = results.reduce((a, r) => a + r.preKillBytes, 0);

    console.log(
      `\n[openclaw-durability] delivered=${delivered}/${N} lost=${lost}/${N} totalMs=${totalMs} preKillBytesTotal=${anyBytes}`,
    );

    // Minions gives you all 10 back. OC `--local` is a fire-and-forget
    // process — when it dies mid-LLM-call, the reply never reaches stdout.
    // We assert 0 delivered as the headline; we're not proving OC is broken,
    // we're proving OC has no durability layer.
    expect(delivered).toBe(0);
    expect(lost).toBe(N);
  }, 60_000);
});
