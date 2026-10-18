/**
 * Worker enforcement of queued spend authorizations (in-process worker,
 * PGLite, provider attempts through the invocation guard).
 *
 * Protects: a group's jobs share one approved total (live holds of a sibling
 * delay a job instead of killing it); a job that finds the group spent dies
 * with the exhaustion code, the group amounts and the resume command; an
 * unpriced model runs under a derived cap and stops under a user cap; an
 * enrich job whose in-process budget runs out dies instead of completing,
 * and a rerun with a higher cap inserts a fresh group.
 *
 * Serial: mock.module replaces the enrich core for the enrich-handler case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

mock.module('../src/commands/enrich.ts', () => ({
  runEnrichCore: async () => ({
    candidates_considered: 3, pages_enriched: 1, pages_skipped_insufficient: 0, pages_skipped_lock: 0,
    pages_skipped_disappeared: 0, pages_failed: 0, budget_exhausted: true, budget_exhausted_reason: 'cost', spent_usd: 0.75,
  }),
}));

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import { makeEnrichHandler } from '../src/core/minions/handlers/enrich.ts';
import { readGroupSpend } from '../src/core/minions/budget-meter.ts';
import {
  __setGroupPressureRetryMsForTests, jobSpendAuthorization, type SpendAuthorization,
} from '../src/core/minions/spend-authorization.ts';
import type { Authorization } from '../src/core/consent.ts';
import type { MinionJob } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  __setGroupPressureRetryMsForTests(100);
});

afterAll(async () => {
  __setGroupPressureRetryMsForTests(null);
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.setConfig('pricing.overrides', '');
  for (const t of ['mcp_spend_reservations', 'mcp_spend_log', 'minion_lease_pressure_log', 'minion_jobs']) await engine.executeRaw(`DELETE FROM ${t}`);
});

const auth = (cap: number, source: Authorization['cap_source']): Authorization => ({ consented_effects: ['paid'], cap_usd: cap, cap_source: source, via: 'yes' });
const group = (cap: number, source: Authorization['cap_source'] = 'derived', of = 2) =>
  jobSpendAuthorization(auth(cap, source), { command: 'book-mirror', of, argv: ['gbrain', 'book-mirror', '--slug', 'a-book'] });

/** One provider attempt: maximum `maxCents`, actual `actualCents` (claude-sonnet-5 input at $2/Mtok). */
const attempt = (maxCents: number, actualCents: number, model = 'anthropic:claude-sonnet-5', gate?: Promise<void>) => invokeAI(
  { operation: 'test', kind: 'chat', model, maxInputTokens: maxCents * 2500, maxOutputTokens: 0 },
  async () => { await gate; return 'ok'; }, () => ({ inputTokens: actualCents * 5000, outputTokens: 0 }));

async function settled(ids: number[], timeoutMs = 20_000): Promise<MinionJob[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const jobs = await Promise.all(ids.map(id => queue.getJob(id)));
    if (jobs.every(j => j && ['completed', 'failed', 'dead', 'cancelled'].includes(j.status))) return jobs as MinionJob[];
    if (Date.now() > deadline) throw new Error(`jobs did not settle: ${jobs.map(j => `${j?.id}:${j?.status}`).join(', ')}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

async function runJobs(name: string, handler: (job: { data: Record<string, unknown> }) => Promise<unknown>, specs: Array<{ data: Record<string, unknown>; spend: SpendAuthorization }>, concurrency = 1) {
  const ids: number[] = [];
  for (const s of specs) ids.push((await queue.add(name, s.data, { max_attempts: 3 }, { allowProtectedSubmit: true, spendAuthorization: s.spend })).id);
  const worker = new MinionWorker(engine, { pollInterval: 30, concurrency, healthCheckInterval: 0 });
  worker.register(name, handler as never);
  const running = worker.start();
  try { return await settled(ids); } finally { worker.stop(); await running; }
}

describe('one approved total per group', () => {
  test('two children reserving $8 each under a $10 cap, $1 actual each, both finish', async () => {
    const spend = group(10);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let pressured = 0;
    const jobs = await runJobs('subagent', async (job) => {
      if (job.data.first) { await attempt(800, 100, undefined, gate); return { ok: 1 }; }
      try { await attempt(800, 100); }
      catch (e) { pressured++; release(); throw e; }
      return { ok: 2 };
    }, [{ data: { first: true }, spend }, { data: { first: false }, spend }], 2);
    expect(jobs.map(j => j.status)).toEqual(['completed', 'completed']);
    expect(pressured).toBe(1);
    expect(jobs[1]!.attempts_made).toBe(0);
    expect((await readGroupSpend(engine, `group:${spend.group_id}`)).committedCents).toBe(200);
  });

  test('a child that finds the group spent dies with the exhaustion code, the amounts and the resume command', async () => {
    const spend = group(10, 'user');
    const [first, second] = await runJobs('subagent', async (job) => {
      await attempt(800, job.data.first ? 1000 : 1);
      return { ok: true };
    }, [{ data: { first: true }, spend }, { data: { first: false }, spend }]);
    expect(first!.status).toBe('completed');
    expect(second!.status).toBe('dead');
    expect(second!.error_text).toStartWith('cost_cap_exceeded:');
    const refusal = (second!.result as { spend_refusal: Record<string, any> }).spend_refusal;
    expect(refusal).toMatchObject({ code: 'cost_cap_exceeded', group: { group_id: spend.group_id, cap_usd: 10, spent_usd: 10, remaining_usd: 0 } });
    expect(refusal.fix.argv).toEqual(['gbrain', 'book-mirror', '--slug', 'a-book', '--max-usd', '20.00', '--yes']);
    expect(refusal.fix.next).toBe('ask_user');
  });

  test('a derived cap exhaustion carries derived_cap_exhausted', async () => {
    const spend = group(1, 'derived', 1);
    const [job] = await runJobs('subagent', async () => { await attempt(80, 100); await attempt(80, 1); }, [{ data: {}, spend }]);
    expect(job!.status).toBe('dead');
    expect(job!.error_text).toStartWith('derived_cap_exhausted:');
  });
});

describe('unpriced models', () => {
  test('run with a warning under a derived cap', async () => {
    const err: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation(((c: string) => { err.push(String(c)); return true; }) as never);
    try {
      const [job] = await runJobs('subagent', async () => { await attempt(10, 10, 'example:unpriced-model'); return { ok: true }; }, [{ data: {}, spend: group(5, 'derived', 1) }]);
      expect(job!.status).toBe('completed');
    } finally { spy.mockRestore(); }
    expect(err.join('')).toContain('BUDGET_TRACKER_NO_PRICING');
  });

  test('stop with no_pricing under a user cap, before any provider call', async () => {
    let called = false;
    const [job] = await runJobs('subagent', async () => {
      await invokeAI({ operation: 'test', kind: 'chat', model: 'example:unpriced-model', maxInputTokens: 10, maxOutputTokens: 0 },
        async () => { called = true; return 'ok'; }, () => null);
    }, [{ data: {}, spend: group(5, 'user', 1) }]);
    expect(called).toBe(false);
    expect(job!.status).toBe('dead');
    expect(job!.error_text).toStartWith('no_pricing:');
  });
});

describe('operator pricing under a user cap', () => {
  test('a registered zero-price local route runs and settles at zero', async () => {
    await engine.setConfig('pricing.overrides', '{"litellm:quality":{"input":0,"output":0}}');
    let called = false;
    const spend = group(0.05, 'user', 1);
    const [job] = await runJobs('subagent', async () => {
      await invokeAI({ operation: 'test', kind: 'chat', model: 'litellm:quality', maxInputTokens: 1000, maxOutputTokens: 100 },
        async () => { called = true; return 'ok'; }, () => ({ inputTokens: 900, outputTokens: 50 }));
    }, [{ data: {}, spend }]);
    expect(called).toBe(true);
    expect(job!.status).toBe('completed');
    const costs = await readGroupSpend(engine, `group:${spend.group_id}`);
    expect(costs.committedCents).toBe(0);
    expect(costs.liveCents).toBe(0);
  });

  test('a nonzero override is metered and stops the next call when the group is spent', async () => {
    await engine.setConfig('pricing.overrides', '{"litellm:quality":{"input":100,"output":100}}');
    let called = 0;
    const spend = group(0.05, 'user', 1);
    const [job] = await runJobs('subagent', async () => {
      for (let i = 0; i < 2; i++) await invokeAI({ operation: 'test', kind: 'chat', model: 'litellm:quality', maxInputTokens: 1000, maxOutputTokens: 100 },
        async () => { called++; return 'ok'; }, () => ({ inputTokens: 1000, outputTokens: 50 }));
    }, [{ data: {}, spend }]);
    expect(called).toBe(1);
    expect(job!.status).toBe('dead');
    expect(job!.error_text).toStartWith('cost_cap_exceeded:');
    expect((await readGroupSpend(engine, `group:${spend.group_id}`)).committedCents).toBe(10.5);
  });

});

describe('enrich under a spend authorization', () => {
  test('an exhausted enrich job dies instead of completing, and a rerun with a higher cap inserts a fresh group', async () => {
    const spend = jobSpendAuthorization(auth(0.75, 'derived'), { command: 'enrich', of: 1, argv: ['gbrain', 'enrich', '--background', '--source', 'default'] });
    const key = 'cli:enrich:feedbeef';
    const added = await queue.add('enrich', { sourceId: 'default' }, { idempotency_key: key }, { spendAuthorization: spend });
    const worker = new MinionWorker(engine, { pollInterval: 30, healthCheckInterval: 0 });
    worker.register('enrich', makeEnrichHandler(engine));
    const running = worker.start();
    let job: MinionJob;
    try { [job] = await settled([added.id]) as [MinionJob]; } finally { worker.stop(); await running; }
    expect(job.status).toBe('dead');
    expect(job.error_text).toStartWith('derived_cap_exhausted:');
    const higher = jobSpendAuthorization(auth(3, 'user'), { command: 'enrich', of: 1 });
    const rerun = await queue.add('enrich', { sourceId: 'default' }, { idempotency_key: key }, { spendAuthorization: higher });
    expect(rerun.id).not.toBe(added.id);
    expect(rerun.spend_authorization?.group_id).toBe(higher.group_id);
  });
});
