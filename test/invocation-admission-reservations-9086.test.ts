/** #9086: only proven pre-dispatch refusals may release inherited holds. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { invokeAI, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runWithJobSpend, groupAmounts } from '../src/core/minions/spend-authorization.ts';
import { loopsExtractSpendAuthorization } from '../src/core/google/loops-spend.ts';
import { readGroupSpend } from '../src/core/minions/budget-meter.ts';
import { withDelegatedSpend } from '../src/core/minions/delegated-spend.ts';
import { currentDelegationGrant, submissionSnapshot } from '../src/core/minions/delegated-policy.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';

for (const backend of testBackends()) describe(`admission reservations (${backend})`, () => {
let engine: BrainEngine;
let close: () => Promise<void>;
beforeAll(async () => {
  if (backend === 'pglite') {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    close = () => engine.disconnect();
  } else {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  }
}, 120_000);
afterAll(async () => { await close(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM mcp_spend_reservations');
  await engine.executeRaw('DELETE FROM mcp_spend_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw("DELETE FROM oauth_clients WHERE client_id = 'synthetic-owner'");
});
const call = { operation: 'synthetic.extract', kind: 'chat' as const, model: 'anthropic:claude-sonnet-5', maxInputTokens: 100_000, maxOutputTokens: 0 };
const usage = { inputTokens: 10_000, outputTokens: 0 };
async function fixture() {
  const record = loopsExtractSpendAuthorization({ capUsd: 2, source: 'default' }, Date.now())!;
  const queue = new MinionQueue(engine);
  await queue.add('loops_extract', { synthetic: true }, {}, { spendAuthorization: record });
  const job = (await queue.claim('synthetic-worker', 60_000, 'default', ['loops_extract']))!;
  const ctx = { id: job.id, name: job.name, data: job.data, attempts_made: 0 } as unknown as MinionJobContext;
  return { record, job, ctx, key: `group:${record.group_id}` };
}

test('repeated inner admission refusal releases the real outer group hold and a later sibling runs', async () => {
  const { record, job, ctx, key } = await fixture();
  const refusal = new Error('synthetic inner budget refused');
  let dispatched = 0;
  for (let i = 0; i < 4; i++) {
    await expect(runWithJobSpend(engine, job, ctx, () =>
      withAIInvocationGuard(async () => { throw refusal; }, () =>
        invokeAI(call, async () => { dispatched++; return 'never'; }, () => usage), { inherit: true }))).rejects.toBe(refusal);
  }
  expect(dispatched).toBe(0);
  expect(await readGroupSpend(engine, key)).toEqual({ committedCents: 0, overdueCents: 0, liveCents: 0 });
  const rows = await engine.executeRaw<{ status: string; actual_cents: string; usage_unknown_reason: string | null }>(
    'SELECT status, actual_cents, usage_unknown_reason FROM mcp_spend_reservations WHERE budget_key = $1', [key]);
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.status).toBe('settled');
    expect(Number(row.actual_cents)).toBe(0);
    expect(row.usage_unknown_reason).toBeNull();
  }
  expect(await runWithJobSpend(engine, job, ctx, () => invokeAI(call, async () => { dispatched++; return 'ok'; }, () => usage))).toBe('ok');
  expect(dispatched).toBe(1);
  const amounts = groupAmounts(record, await readGroupSpend(engine, key));
  expect(amounts.spent_usd).toBeGreaterThan(0);
  expect(amounts.reserved_usd).toBe(0);
});

test('transport failure after dispatch keeps the hold, including after expiry', async () => {
  const { job, ctx, key } = await fixture();
  const uncertain = new Error('synthetic transport timeout');
  await expect(runWithJobSpend(engine, job, ctx, () => invokeAI(call, async () => { throw uncertain; }, () => usage))).rejects.toBe(uncertain);
  expect((await readGroupSpend(engine, key)).liveCents).toBeGreaterThan(0);
  await engine.executeRaw("UPDATE mcp_spend_reservations SET status = 'expired' WHERE budget_key = $1", [key]);
  expect((await readGroupSpend(engine, key)).overdueCents).toBeGreaterThan(0);
  const [row] = await engine.executeRaw<{ actual_cents: unknown; usage_unknown_reason: string }>(
    'SELECT actual_cents, usage_unknown_reason FROM mcp_spend_reservations WHERE budget_key = $1', [key]);
  expect(row.actual_cents).toBeNull();
  expect(row.usage_unknown_reason).toBe('provider_usage_unknown');
});

test('a third guard refusal releases both delegated daily and job group holds', async () => {
  const { job, ctx, key } = await fixture();
  await engine.executeRaw(`INSERT INTO oauth_clients
    (client_id, client_name, client_secret_hash, scope, grant_types, redirect_uris, token_endpoint_auth_method,
     source_id, bound_source_id, federated_read, bound_tools, delegated_namespace, delegated_slug_prefixes, budget_usd_per_day)
    VALUES ('synthetic-owner','synthetic-owner','','agent',ARRAY['client_credentials'],ARRAY[]::text[],'client_secret_post',
      'default','default',ARRAY['default'],ARRAY['get_page'],'prefixes',ARRAY['wiki/agents/*'],2)`);
  const snapshot = submissionSnapshot(await currentDelegationGrant(engine, 'synthetic-owner'), {});
  const refused = new Error('synthetic final admission refused');
  await expect(withDelegatedSpend(engine, snapshot, job.id, () => runWithJobSpend(engine, job, ctx, () =>
    withAIInvocationGuard(async () => { throw refused; }, () =>
      invokeAI(call, async () => { throw new Error('must not dispatch'); }, () => usage), { inherit: true })))).rejects.toBe(refused);
  expect(await readGroupSpend(engine, key)).toEqual({ committedCents: 0, overdueCents: 0, liveCents: 0 });
  const rows = await engine.executeRaw<{ status: string; actual_cents: string }>('SELECT status, actual_cents FROM mcp_spend_reservations');
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.status).toBe('settled');
    expect(Number(row.actual_cents)).toBe(0);
  }
  expect(await withDelegatedSpend(engine, snapshot, job.id, () => runWithJobSpend(engine, job, ctx, () =>
    invokeAI(call, async () => 'healthy sibling', () => usage)))).toBe('healthy sibling');
});

test('group remaining subtracts live and overdue reservations without double counting', async () => {
  const { record } = await fixture();
  expect(groupAmounts(record, { committedCents: 0, overdueCents: 82, liveCents: 82 })).toMatchObject({
    spent_usd: 0, reserved_usd: 1.64, overdue_usd: 0.82, remaining_usd: 0.36,
  });
  expect(groupAmounts(record, { committedCents: 40, overdueCents: 82, liveCents: 82 }).remaining_usd).toBe(0);
});
});
