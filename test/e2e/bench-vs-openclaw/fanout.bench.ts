/**
 * Fan-out bench: parent dispatches 10 children, wait for all to complete.
 *
 * This is the Minions headline. A queue + worker with concurrency=10
 * runs 10 children in parallel, sharing one warm worker process.
 * The honest OpenClaw equivalent a user has today (without Minions) is
 * N parallel `openclaw agent --local` spawns — each boots its own
 * runtime, auth, plugins.
 *
 * Caveat: this does NOT test OpenClaw's gateway multi-agent fan-out
 * (that requires a custom WS client + LLM-backed parent agent, out of
 * scope). We're measuring what users script in practice today.
 *
 * Methodology: 3 runs × 10 children per run. Report per-run total wall
 * time + mean across runs.
 *
 * Budget: 3 × 10 × 2 systems × ~$0.002 ≈ $0.12 LLM spend.
 *
 * Run: DATABASE_URL=... bun test test/e2e/bench-vs-openclaw/fanout.bench.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from '../helpers.ts';
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import { MinionWorker } from '../../../src/core/minions/worker.ts';
import { runMigrations } from '../../../src/core/migrate.ts';
import { BENCH_MODEL, BENCH_PROMPT, openclawDispatch } from './harness.ts';

const skip = !hasDatabase() || !process.env.ANTHROPIC_API_KEY;
const describeBench = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping fan-out bench (need DATABASE_URL + ANTHROPIC_API_KEY)');
}

const RUNS = 3;
const CHILDREN = 10;

type RunResult = { ok: number; fail: number; wallMs: number };

function summarize(label: string, runs: RunResult[]) {
  const okTotals = runs.map((r) => r.ok);
  const wallTotals = runs.map((r) => r.wallMs).sort((a, b) => a - b);
  const mean = Math.round(wallTotals.reduce((a, b) => a + b, 0) / wallTotals.length);
  return `${label.padEnd(24)} runs=${runs.length} children/run=${CHILDREN} ok=[${okTotals.join(',')}] wallMs=[${wallTotals.join(',')}] meanWallMs=${mean}`;
}

describeBench('Bench: Fan-out (parent → 10 children in parallel)', () => {
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

  test(`Minions: ${RUNS} runs × fan-out to ${CHILDREN} children (concurrency=${CHILDREN})`, async () => {
    const url = process.env.DATABASE_URL!;
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize: 16 });

    try {
      const queue = new MinionQueue(engine);
      const worker = new MinionWorker(engine, {
        concurrency: CHILDREN,
        pollInterval: 25,
        lockDuration: 60_000,
        stalledInterval: 60_000,
      });

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      worker.register('bench-child', async () => {
        const resp = await client.messages.create({
          model: BENCH_MODEL,
          max_tokens: 64,
          messages: [{ role: 'user', content: BENCH_PROMPT }],
        });
        return {
          reply: resp.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('')
            .trim(),
        };
      });

      const startP = worker.start();
      const runs: RunResult[] = [];

      for (let run = 0; run < RUNS; run++) {
        // Reset between runs so jobs don't interleave across runs
        await getConn().unsafe(
          `TRUNCATE minion_attachments, minion_inbox, minion_jobs RESTART IDENTITY CASCADE`,
        );

        const t0 = performance.now();
        const ids: number[] = [];
        // Parent-less children so there's no cap; the parent is just
        // the test process initiating the fan-out.
        for (let i = 0; i < CHILDREN; i++) {
          const job = await queue.add('bench-child', { i, run });
          ids.push(job.id);
        }

        // Wait for all to terminate
        let ok = 0;
        let fail = 0;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const rows = await getConn().unsafe<{ id: number; status: string }[]>(
            `SELECT id, status FROM minion_jobs WHERE id = ANY($1)`,
            [ids],
          );
          ok = rows.filter((r) => r.status === 'completed').length;
          fail = rows.filter((r) => r.status === 'failed' || r.status === 'dead').length;
          if (ok + fail === CHILDREN) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        const wallMs = Math.round(performance.now() - t0);
        runs.push({ ok, fail, wallMs });
        console.log(
          `  [minions-fanout] run=${run + 1} ok=${ok}/${CHILDREN} wallMs=${wallMs}`,
        );
      }

      worker.stop();
      await startP;

      console.log(`\n${summarize('[minions-fanout]', runs)}`);
      for (const r of runs) expect(r.ok).toBeGreaterThanOrEqual(Math.floor(CHILDREN * 0.9));
    } finally {
      await engine.disconnect();
    }
  }, 10 * 60_000);

  test(`OpenClaw: ${RUNS} runs × ${CHILDREN} parallel --local spawns`, async () => {
    const runs: RunResult[] = [];
    const errorSamples: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const t0 = performance.now();
      const results = await Promise.all(
        Array.from({ length: CHILDREN }, () => openclawDispatch()),
      );
      const wallMs = Math.round(performance.now() - t0);
      const ok = results.filter((r) => r.ok).length;
      const fail = CHILDREN - ok;
      for (const r of results) {
        if (!r.ok && r.error && errorSamples.length < 3) {
          errorSamples.push(r.error.slice(0, 200));
        }
      }
      runs.push({ ok, fail, wallMs });
      console.log(
        `  [openclaw-fanout] run=${run + 1} ok=${ok}/${CHILDREN} wallMs=${wallMs}`,
      );
    }
    if (errorSamples.length > 0) {
      console.log(`  [openclaw-fanout] error samples:`);
      for (const e of errorSamples) console.log(`    - ${e}`);
    }
    console.log(`\n${summarize('[openclaw-fanout]', runs)}`);
    // Observational: report numbers, don't gate. OC parallel spawns are
    // known-flaky under load (LLM rate limits, process startup stampede).
    // The failure rate IS the finding.
    expect(runs.length).toBe(RUNS);
  }, 20 * 60_000);
});
