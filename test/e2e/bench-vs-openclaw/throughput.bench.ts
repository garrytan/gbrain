/**
 * Throughput bench: per-dispatch wall-clock, Minions vs OpenClaw --local.
 *
 * Both sides run the SAME LLM call (claude-haiku-4-5, tiny prompt).
 * The delta tells you how much overhead each system adds on top of the
 * identical LLM work.
 *
 * Methodology (serial to keep LLM token costs bounded and make p50/p95
 * meaningful per-dispatch):
 *
 *   OpenClaw — N serial calls to `openclaw agent --local`. Each call is
 *   a full process spawn that boots the agent runtime, auth, plugins,
 *   then calls the LLM.
 *
 *   Minions — one worker, one queue. Submit N jobs serially (await each
 *   completion before the next submit) so p50/p95 measures the per-job
 *   dispatch cost honestly.
 *
 * Budget: N=20 × 2 systems × ~$0.002/call ≈ $0.08 actual LLM spend.
 *
 * Run: DATABASE_URL=... bun test test/e2e/bench-vs-openclaw/throughput.bench.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from '../helpers.ts';
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import { MinionWorker } from '../../../src/core/minions/worker.ts';
import { runMigrations } from '../../../src/core/migrate.ts';
import {
  BENCH_MODEL,
  BENCH_PROMPT,
  openclawDispatch,
  statsFromResults,
  formatStats,
  type CallResult,
} from './harness.ts';

const skip = !hasDatabase() || !process.env.ANTHROPIC_API_KEY;
const describeBench = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping throughput bench (need DATABASE_URL + ANTHROPIC_API_KEY)');
}

const N = 20;

describeBench('Bench: Throughput (per-dispatch wall clock)', () => {
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

  test(`Minions: ${N} serial dispatches through queue → worker → LLM`, async () => {
    const url = process.env.DATABASE_URL!;
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize: 4 });

    try {
      const queue = new MinionQueue(engine);
      const worker = new MinionWorker(engine, {
        concurrency: 1,
        pollInterval: 25,
        lockDuration: 60_000,
        stalledInterval: 60_000,
      });

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      worker.register('bench-throughput', async () => {
        const resp = await client.messages.create({
          model: BENCH_MODEL,
          max_tokens: 64,
          messages: [{ role: 'user', content: BENCH_PROMPT }],
        });
        const reply = resp.content
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('')
          .trim();
        if (!reply) throw new Error('empty reply');
        return { reply };
      });

      const startP = worker.start();
      const results: CallResult[] = [];

      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const job = await queue.add('bench-throughput', { i });

        // Poll for completion
        const deadline = Date.now() + 60_000;
        let finalStatus = '';
        let reply = '';
        while (Date.now() < deadline) {
          const j = await queue.getJob(job.id);
          if (j && (j.status === 'completed' || j.status === 'failed' || j.status === 'dead')) {
            finalStatus = j.status;
            reply = typeof j.result === 'object' && j.result && 'reply' in j.result
              ? String((j.result as any).reply)
              : '';
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }

        const wallMs = Math.round(performance.now() - t0);
        results.push(
          finalStatus === 'completed'
            ? { ok: true, wallMs, reply }
            : { ok: false, wallMs, error: finalStatus || 'timeout' },
        );
      }

      worker.stop();
      await startP;

      const s = statsFromResults(results);
      console.log(`\n${formatStats('[minions-throughput]', s)}`);
      expect(s.successes).toBeGreaterThanOrEqual(Math.floor(N * 0.9));
    } finally {
      await engine.disconnect();
    }
  }, 5 * 60_000);

  test(`OpenClaw: ${N} serial --local dispatches`, async () => {
    const results: CallResult[] = [];
    for (let i = 0; i < N; i++) {
      results.push(await openclawDispatch());
    }
    const s = statsFromResults(results);
    console.log(`\n${formatStats('[openclaw-throughput]', s)}`);
    expect(s.successes).toBeGreaterThanOrEqual(Math.floor(N * 0.9));
  }, 10 * 60_000);
});
