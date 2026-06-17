/**
 * Memory bench: resident memory cost of keeping 10 subagents in flight.
 *
 * Minions side: one worker process with concurrency=10 runs 10 sleepy
 * handlers in parallel. RSS is measured on the test/worker process via
 * `process.memoryUsage().rss`.
 *
 * OpenClaw side: 10 parallel `openclaw agent --local` spawns. Each is
 * its own process with its own runtime, auth, plugins. Total RSS =
 * sum of all 10 via `ps -o rss=`.
 *
 * Handlers are intentionally cheap (sleep, no LLM) so we measure the
 * *harness* memory cost, not LLM client state.
 *
 * Budget: $0 (no LLM calls).
 *
 * Run: DATABASE_URL=... bun test test/e2e/bench-vs-openclaw/memory.bench.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawn, execFileSync } from 'node:child_process';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from '../helpers.ts';
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import { MinionWorker } from '../../../src/core/minions/worker.ts';
import { runMigrations } from '../../../src/core/migrate.ts';
import { BENCH_PROMPT } from './harness.ts';

const skip = !hasDatabase();
const describeBench = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping memory bench (DATABASE_URL not set)');
}

const IN_FLIGHT = 10;

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

/** Sum RSS of pids via ps. Returns MB. Missing pids count as 0. */
function pidsRssMB(pids: number[]): number {
  if (pids.length === 0) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], {
      encoding: 'utf-8',
    });
    const kbSum = out
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => !Number.isNaN(n))
      .reduce((a, b) => a + b, 0);
    return Math.round(kbSum / 1024);
  } catch {
    return 0;
  }
}

describeBench('Bench: Memory (RSS with 10 subagents in flight)', () => {
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

  test(`Minions: worker + ${IN_FLIGHT} in-flight handlers, single-process RSS`, async () => {
    const url = process.env.DATABASE_URL!;
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize: 16 });

    try {
      const queue = new MinionQueue(engine);
      const worker = new MinionWorker(engine, {
        concurrency: IN_FLIGHT,
        pollInterval: 25,
        lockDuration: 60_000,
        stalledInterval: 60_000,
      });

      let active = 0;
      let peakActive = 0;
      const rssSamples: number[] = [];
      const release: Array<() => void> = [];

      worker.register('bench-mem', async () => {
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
        active--;
        return { ok: true };
      });

      const baselineRssMB = rssMB();
      const startP = worker.start();

      // Submit 10 jobs, let them all get claimed and sit
      const ids: number[] = [];
      for (let i = 0; i < IN_FLIGHT; i++) {
        const job = await queue.add('bench-mem', { i });
        ids.push(job.id);
      }

      // Wait for all 10 to be claimed
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && peakActive < IN_FLIGHT) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(peakActive).toBe(IN_FLIGHT);

      // Sample RSS 5× while all 10 are in flight
      for (let i = 0; i < 5; i++) {
        rssSamples.push(rssMB());
        await new Promise((r) => setTimeout(r, 200));
      }
      const peakInFlightRssMB = Math.max(...rssSamples);
      const deltaRssMB = peakInFlightRssMB - baselineRssMB;

      // Release all handlers
      for (const r of release) r();

      // Wait for completion
      const doneDeadline = Date.now() + 5000;
      while (Date.now() < doneDeadline) {
        const rows = await getConn().unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'completed' AND id = ANY($1)`,
          [ids],
        );
        if (rows[0].n === IN_FLIGHT) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      worker.stop();
      await startP;

      console.log(
        `\n[minions-memory] baselineRssMB=${baselineRssMB} peakInFlightRssMB=${peakInFlightRssMB} deltaMB=${deltaRssMB} inFlight=${IN_FLIGHT} processes=1`,
      );
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test(`OpenClaw: ${IN_FLIGHT} parallel --local spawns, summed RSS via ps`, async () => {
    // Spawn 10 OC processes in parallel. Track pids. Sample summed RSS
    // a few times while they're all alive, then kill them.
    const children: ReturnType<typeof spawn>[] = [];
    const pids: number[] = [];

    for (let i = 0; i < IN_FLIGHT; i++) {
      const proc = spawn(
        'openclaw',
        ['agent', '--agent', 'main', '--local', '--message', BENCH_PROMPT, '--timeout', '120'],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(proc);
      if (typeof proc.pid === 'number') pids.push(proc.pid);
    }

    // Wait for all 10 to actually be running (RSS > 0 in ps)
    const settleDeadline = Date.now() + 15_000;
    let aliveCount = 0;
    while (Date.now() < settleDeadline) {
      const alive = pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      aliveCount = alive.length;
      if (aliveCount === IN_FLIGHT) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Sample summed RSS while all are (hopefully) mid-dispatch
    const rssSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      rssSamples.push(pidsRssMB(pids));
      await new Promise((r) => setTimeout(r, 400));
    }

    const peakSumRssMB = Math.max(...rssSamples);
    const meanSumRssMB = Math.round(rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length);

    // Cleanup: kill all survivors
    for (const proc of children) {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
    await Promise.all(
      children.map(
        (proc) =>
          new Promise<void>((resolve) => {
            if (proc.exitCode !== null) return resolve();
            proc.on('close', () => resolve());
            setTimeout(() => resolve(), 3000);
          }),
      ),
    );

    console.log(
      `\n[openclaw-memory] aliveAtSample=${aliveCount}/${IN_FLIGHT} peakSumRssMB=${peakSumRssMB} meanSumRssMB=${meanSumRssMB} rssSamples=[${rssSamples.join(',')}] processes=${IN_FLIGHT}`,
    );

    // Headline: memory scales with number of processes. At least 5 should
    // have been alive long enough to sample; if OC failed to spawn we'd
    // see 0 RSS everywhere.
    expect(aliveCount).toBeGreaterThanOrEqual(5);
    expect(peakSumRssMB).toBeGreaterThan(0);
  }, 60_000);
});
