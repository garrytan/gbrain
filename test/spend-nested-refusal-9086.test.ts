/**
 * #9086: a job group's hold when a nested guard refuses (src/core/ai/invocation-guard.ts,
 * src/core/minions/spend-authorization.ts).
 *
 * Protects: an inner guard that refuses after the outer job-group guard reserved
 * dispatches nothing, so the outer hold is released at $0 instead of kept as
 * unknown usage; a dispatched call that fails still keeps its maximum against the
 * group; `remaining_usd` subtracts live holds.
 * Fails when: the inherit catch settles the outer permit as unknown usage (holds
 * pile up and the group dies cost_cap_exceeded with nothing spent), a failed
 * dispatched call is released for free, or remaining_usd ignores live holds.
 * Seams: the real budget meter on PGLite always, and on Postgres through
 * test/e2e/spend-nested-refusal-9086-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { invokeAI, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { readGroupSpend, reserveGroup, settle } from '../src/core/minions/budget-meter.ts';
import { groupAmounts, jobGroupAmounts, jobSpendAuthorization, runWithJobSpend } from '../src/core/minions/spend-authorization.ts';
import type { MinionJob, MinionJobContext } from '../src/core/minions/types.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const MODEL = 'anthropic:claude-sonnet-5';
/** A priced chat call whose maximum is `maxCents` (claude-sonnet-5 input at $2/Mtok, reserved at 2x). */
const call = (maxCents: number) => ({ operation: 'test', kind: 'chat' as const, model: MODEL, maxInputTokens: maxCents * 2500, maxOutputTokens: 0 });
const record = (capUsd: number) => jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: capUsd, cap_source: 'derived', via: 'yes' },
  { command: 'book-mirror', of: 1, argv: ['gbrain', 'book-mirror', '--slug', 'alice-example'] });
const ctxFor = (job: MinionJob) => ({ id: job.id, name: job.name, data: job.data, attempts_made: 0 }) as unknown as MinionJobContext;

for (const backend of testBackends()) {
  describe(`${backend}: #9086 nested refusal`, () => {
    let engine: BrainEngine;
    let queue: MinionQueue;
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      }
      queue = new MinionQueue(engine);
    }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      for (const sql of ['DELETE FROM mcp_spend_reservations', 'DELETE FROM mcp_spend_log', 'DELETE FROM minion_jobs']) await engine.executeRaw(sql);
    });

    async function claimedJob(capUsd: number): Promise<MinionJob> {
      await queue.add('subagent', { prompt: 'x' }, {}, { allowProtectedSubmit: true, spendAuthorization: record(capUsd) });
      const job = await queue.claim('tok', 60_000, 'default', ['subagent']);
      if (!job) throw new Error('nothing claimed');
      return job;
    }
    const holds = () => engine.executeRaw<{ status: string; estimated_cents: number; actual_cents: number | null; usage_unknown_reason: string | null }>(
      'SELECT status, estimated_cents::float8 AS estimated_cents, actual_cents::float8 AS actual_cents, usage_unknown_reason FROM mcp_spend_reservations ORDER BY created_at');

    test('an inner refusal releases the outer group hold', async () => {
      const job = await claimedJob(1);
      const budgetKey = `group:${job.spend_authorization!.group_id}`;
      let dispatched = 0;
      const errors: string[] = [];
      await runWithJobSpend(engine, job, ctxFor(job), async () => {
        for (let i = 0; i < 5; i++) {
          try {
            await withAIInvocationGuard(async () => { throw new Error('inner guard refused'); },
              () => invokeAI(call(40), async () => { dispatched++; return 'ok'; }, () => ({ inputTokens: 1, outputTokens: 0 })), { inherit: true });
          } catch (e) { errors.push((e as Error).message); }
        }
      });
      expect(dispatched).toBe(0);
      expect(errors).toEqual(Array(5).fill('inner guard refused'));
      const rows = await holds();
      expect(rows).toHaveLength(5);
      expect(rows.map(r => [r.status, Number(r.actual_cents), r.usage_unknown_reason])).toEqual(Array(5).fill(['settled', 0, null]));
      expect(await readGroupSpend(engine, budgetKey)).toEqual({ committedCents: 0, overdueCents: 0, liveCents: 0 });
      expect(await jobGroupAmounts(engine, job.spend_authorization!)).toMatchObject({ spent_usd: 0, reserved_usd: 0, remaining_usd: 1 });

      const result = await runWithJobSpend(engine, job, ctxFor(job), () =>
        invokeAI(call(40), async () => { dispatched++; return 'ok'; }, () => ({ inputTokens: 10 * 5000, outputTokens: 0 })));
      expect(result).toBe('ok');
      expect(dispatched).toBe(1);
      expect((await readGroupSpend(engine, budgetKey)).committedCents).toBe(10);
    });

    test('a dispatched inner call that fails still books against the outer hold', async () => {
      const job = await claimedJob(1);
      const budgetKey = `group:${job.spend_authorization!.group_id}`;
      let dispatched = 0;
      await expect(runWithJobSpend(engine, job, ctxFor(job), () =>
        withAIInvocationGuard(async () => ({ settle: async () => {} }),
          () => invokeAI(call(40), async () => { dispatched++; throw new Error('provider failed after send'); }, () => null), { inherit: true }),
      )).rejects.toThrow('provider failed after send');
      expect(dispatched).toBe(1);
      const rows = await holds();
      expect(rows.map(r => [r.status, Number(r.estimated_cents), r.actual_cents, r.usage_unknown_reason])).toEqual([['pending', 40, null, 'provider_usage_unknown']]);
      expect(await readGroupSpend(engine, budgetKey)).toEqual({ committedCents: 0, overdueCents: 0, liveCents: 40 });
    });

    test('remaining_usd subtracts live holds', async () => {
      const job = await claimedJob(1);
      const budgetKey = `group:${job.spend_authorization!.group_id}`;
      const spent = await reserveGroup(engine, { budgetKey, capCents: 100, estimatedCents: 20, model: MODEL, provider: 'anthropic', jobId: job.id });
      await settle(engine, spent.reservationId, 20, 'test');
      await reserveGroup(engine, { budgetKey, capCents: 100, estimatedCents: 30, model: MODEL, provider: 'anthropic', jobId: job.id });
      expect(await jobGroupAmounts(engine, job.spend_authorization!)).toMatchObject({ spent_usd: 0.2, overdue_usd: 0, reserved_usd: 0.3, remaining_usd: 0.5 });
      expect(groupAmounts(job.spend_authorization!, { committedCents: 20, overdueCents: 10, liveCents: 30 }))
        .toMatchObject({ spent_usd: 0.2, overdue_usd: 0.1, reserved_usd: 0.4, remaining_usd: 0.4 });
      expect(groupAmounts(job.spend_authorization!, { committedCents: 80, overdueCents: 0, liveCents: 50 }).remaining_usd).toBe(0);
    });
  });
}
