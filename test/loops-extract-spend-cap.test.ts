/**
 * Wave 14 P4.6b — the daily spend cap on open-loop extraction
 * (src/core/google/loops-spend.ts, both enqueue sites, the worker guard).
 *
 *  - `loops.extraction_max_usd_per_day` validates at config set, defaults to
 *    $2.00 and is `user`-sourced when stored;
 *  - every loops_extract job the sweep or the managed catch-up queues carries
 *    the day's group authorization (one deterministic group per UTC day);
 *  - a day already at its cap queues nothing (`daily_spend_cap`), a cap of 0
 *    queues nothing (`spend_cap_zero`);
 *  - under the worker guard, an attempt the day's group cannot admit is refused
 *    before the provider call (cost_cap_exceeded) and an attempt that fits is
 *    metered against the group.
 *
 * PGLite in memory; the chat transport is a stub that throws, so no model is
 * ever called and nothing is spent. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import { reserveGroup, settle } from '../src/core/minions/budget-meter.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { parseSpendAuthorization, runWithJobSpend, SpendGroupRefusedError } from '../src/core/minions/spend-authorization.ts';
import type { MinionJob, MinionJobContext } from '../src/core/minions/types.ts';
import { enqueueLoopsExtraction } from '../src/core/google/loops-enqueue.ts';
import { runLoopsCatchup } from '../src/core/google/loop-catchup.ts';
import { NO_EXCLUSION } from '../src/core/google/loops-exclusion.ts';
import {
  LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY,
  loopsExtractSpendAuthorization,
  loopsSpendBudgetKey,
  loopsSpendDay,
  loopsSpendGate,
  loopsSpendGroupId,
  readLoopsExtractDailyCap,
  validateLoopsSpendConfigValue,
} from '../src/core/google/loops-spend.ts';
import { parseGoogleSourceConfig } from '../src/core/google/source-config.ts';
import type { GoogleSyncDeps } from '../src/core/google/sweep-shared.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';

const SRC = 'gsrc';
const NOW = Date.parse('2026-08-25T12:00:00Z');
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setChatTransportForTests(async () => { throw new Error('the chat transport must never be called by these tests'); });
});
afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
  await engine.disconnect();
});
beforeEach(async () => {
  for (const sql of ['DELETE FROM mcp_spend_reservations', 'DELETE FROM mcp_spend_log', 'DELETE FROM minion_jobs', 'DELETE FROM op_checkpoints',
    "DELETE FROM pages WHERE source_id = 'gsrc'", "DELETE FROM config WHERE key LIKE 'loops.%'"]) await engine.executeRaw(sql);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [SRC]);
});

/** Charges `cents` of settled spend to the day's group (a priced claude-sonnet-5 attempt). */
async function chargeDay(cents: number, nowMs = Date.now()): Promise<void> {
  const hold = await reserveGroup(engine, { budgetKey: loopsSpendBudgetKey(loopsSpendDay(nowMs)), capCents: null, estimatedCents: cents,
    model: 'anthropic:claude-sonnet-5', provider: 'anthropic' });
  await settle(engine, hold.reservationId, cents, 'test');
}

const loopsJobs = () => engine.executeRaw<{ id: number; spend_authorization: unknown; idempotency_key: string }>(
  `SELECT id, spend_authorization, idempotency_key FROM minion_jobs WHERE name = 'loops_extract' ORDER BY id`);

describe('P4.6b config and record', () => {
  test('the key validates as a non-negative USD amount', () => {
    for (const ok of ['2', '0', '0.50', '12.5']) expect(validateLoopsSpendConfigValue(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, ok)).toBeNull();
    for (const bad of ['-1', 'abc', '$2', '']) expect(validateLoopsSpendConfigValue(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, bad)).toContain('Nothing was written');
    expect(validateLoopsSpendConfigValue('loops.extraction_enabled', 'false')).toBeNull();
  });

  test('the cap defaults to $2.00 and is user-sourced once stored', async () => {
    expect(await readLoopsExtractDailyCap(engine)).toEqual({ capUsd: 2, source: 'default' });
    await engine.setConfig(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, '0.75');
    expect(await readLoopsExtractDailyCap(engine)).toEqual({ capUsd: 0.75, source: 'user' });
    await engine.setConfig(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, 'garbage');
    expect(await readLoopsExtractDailyCap(engine)).toEqual({ capUsd: 2, source: 'default' });
  });

  test('one group per UTC day, the same from every process, and the record parses strictly', () => {
    expect(loopsSpendGroupId('2026-08-25')).toBe(loopsSpendGroupId('2026-08-25'));
    expect(loopsSpendGroupId('2026-08-25')).not.toBe(loopsSpendGroupId('2026-08-26'));
    expect(loopsSpendDay(Date.parse('2026-08-25T23:59:59Z'))).toBe('2026-08-25');
    expect(loopsSpendDay(Date.parse('2026-08-26T00:00:00Z'))).toBe('2026-08-26');
    const record = loopsExtractSpendAuthorization({ capUsd: 2, source: 'default' }, NOW)!;
    expect(parseSpendAuthorization(record)).toEqual(record);
    expect(record).toMatchObject({ kind: 'authorized', cap_usd: 2, cap_source: 'default', command: 'loops_extract', group_id: loopsSpendGroupId('2026-08-25') });
    expect(loopsExtractSpendAuthorization({ capUsd: 0, source: 'user' }, NOW)).toBeNull();
  });

  test('the gate admits under the cap, closes the day at the cap and refuses a cap of 0', async () => {
    const open = await loopsSpendGate(engine, NOW);
    expect(open).toMatchObject({ ok: true, day: '2026-08-25', spentUsd: 0, capUsd: 2 });
    await chargeDay(150, NOW);
    expect(await loopsSpendGate(engine, NOW)).toMatchObject({ ok: true, spentUsd: 1.5 });
    await chargeDay(50, NOW);
    const closed = await loopsSpendGate(engine, NOW);
    expect(closed).toMatchObject({ ok: false, reason: 'daily_spend_cap', spentUsd: 2, capUsd: 2 });
    expect((closed as { message: string }).message).toContain(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY);
    expect(await loopsSpendGate(engine, NOW + 86_400_000)).toMatchObject({ ok: true, day: '2026-08-26', spentUsd: 0 });
    await engine.setConfig(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, '0');
    expect(await loopsSpendGate(engine, NOW)).toMatchObject({ ok: false, reason: 'spend_cap_zero' });
  });
});

describe('P4.6b enqueue sites', () => {
  const deps = (): GoogleSyncDeps => ({
    engine, sourceId: SRC, opts: { sourceId: SRC, noEmbed: true, noExtract: true },
    cfg: parseGoogleSourceConfig({ kind: 'google', g_account: 'a@example.com', g_services: 'gmail', g_history_days: 90, g_dir: '/tmp/gsrc' }, '/tmp/gsrc'),
    entry: { id: 'google:a@example.com', provider: 'google', kind: 'oauth2', client_ref: 'byo', secret: {}, meta: { account: 'a@example.com' } } as unknown as GoogleSyncDeps['entry'],
    log: () => {}, tick: () => {}, exclusion: NO_EXCLUSION, managed: null, processedThreads: new Set(),
    extractCandidates: [
      { slug: 'emails/2026/08/2026-08-25-a-1111aaaa', threadId: '1111aaaa', newestMs: Date.now() - 3_600_000 },
      { slug: 'emails/2026/08/2026-08-25-b-2222bbbb', threadId: '2222bbbb', newestMs: Date.now() - 7_200_000 },
    ],
  } as unknown as GoogleSyncDeps);

  test('the sweep stamps the day group on every job it queues', async () => {
    const r = await enqueueLoopsExtraction(deps());
    expect(r).toMatchObject({ enqueued: 2, skipped_reason: null });
    const jobs = await loopsJobs();
    expect(jobs).toHaveLength(2);
    const today = loopsSpendGroupId(loopsSpendDay(Date.now()));
    for (const j of jobs) expect(parseSpendAuthorization(j.spend_authorization)).toMatchObject({ group_id: today, cap_usd: 2, command: 'loops_extract' });
  });

  test('a day at its cap queues nothing and the report says why', async () => {
    await chargeDay(200);
    const logs: string[] = [];
    const d = deps(); d.log = (l) => logs.push(l);
    expect(await enqueueLoopsExtraction(d)).toMatchObject({ enqueued: 0, skipped_reason: 'daily_spend_cap' });
    expect(await loopsJobs()).toHaveLength(0);
    expect(logs.join('\n')).toContain('$2.00 of its $2.00 default cap');
    await engine.setConfig(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, '0');
    expect(await enqueueLoopsExtraction(deps())).toMatchObject({ enqueued: 0, skipped_reason: 'spend_cap_zero' });
  });

  test('the managed catch-up stamps the same day group and skips at the cap', async () => {
    await engine.setConfig('loops.extraction_enabled', 'true');
    await engine.putPage('emails/2026/08/2026-08-25-c-3333cccc', { type: 'email', title: 'Plan', compiled_truth: 'Peer: Can you review the plan?',
      frontmatter: { thread_id: '3333cccc', date: new Date(Date.now() - 86_400_000).toISOString() } }, { sourceId: SRC });
    const state = {} as GoogleSourceState;
    const ctx = () => ({ engine, sourceId: SRC, state, log: () => {}, myAddresses: new Set(['a@example.com']), inFlight: new Set<string>(),
      fetchThread: async (threadId: string) => ({ threadId, account: 'a@example.com', messages: [{
        id: 'm1', threadId, from: 'Peer <peer@example.com>', fromAddress: 'peer@example.com', to: ['a@example.com'], cc: [], subject: 'Plan',
        dateIso: new Date(Date.now() - 86_400_000).toISOString(), internalDateMs: Date.now() - 86_400_000, labelIds: ['INBOX'], listUnsubscribe: false,
        calendarMethod: null, bodyText: 'Can you review the plan?' }] }) });
    const r = await runLoopsCatchup(ctx());
    expect(r).toMatchObject({ enqueued: 1, skipped_reason: null });
    const [job] = await loopsJobs();
    expect(job.idempotency_key.startsWith('loops-catchup:')).toBe(true);
    expect(parseSpendAuthorization(job.spend_authorization)).toMatchObject({ group_id: loopsSpendGroupId(loopsSpendDay(Date.now())), command: 'loops_extract' });
    await chargeDay(200);
    expect(await runLoopsCatchup({ ...ctx(), state: {} as GoogleSourceState })).toMatchObject({ enqueued: 0, skipped_reason: 'daily_spend_cap' });
  });
});

describe('P4.6b worker guard', () => {
  const attempt = (maxCents: number, actualCents: number) => invokeAI(
    { operation: 'loops_extract', kind: 'chat', model: 'anthropic:claude-sonnet-5', maxInputTokens: maxCents * 2500, maxOutputTokens: 0 },
    async () => 'ok', () => ({ inputTokens: actualCents * 5000, outputTokens: 0 }));
  const ctxFor = (job: MinionJob) => ({ id: job.id, name: job.name, data: job.data, attempts_made: 0 }) as unknown as MinionJobContext;

  test('an attempt the day group cannot admit is refused before the provider call; one that fits is metered', async () => {
    const queue = new MinionQueue(engine);
    const record = loopsExtractSpendAuthorization({ capUsd: 2, source: 'default' }, Date.now())!;
    await queue.add('loops_extract', { slug: 'emails/x', sourceId: SRC }, { idempotency_key: 'loops:gsrc:x:1' }, { spendAuthorization: record });
    const job = (await queue.claim('tok', 60_000, 'default', ['loops_extract']))!;
    expect(job.spend_authorization?.group_id).toBe(record.group_id);
    let providerCalls = 0;
    const metered = await runWithJobSpend(engine, job, ctxFor(job), async () => { providerCalls++; return attempt(40, 30); });
    expect(metered).toBe('ok');
    expect(await loopsSpendGate(engine)).toMatchObject({ ok: true, spentUsd: 0.3 });
    await chargeDay(170);
    const refused = await runWithJobSpend(engine, job, ctxFor(job), async () => { providerCalls++; return attempt(40, 30); }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(SpendGroupRefusedError);
    expect((refused as SpendGroupRefusedError).envelope.code).toBe('cost_cap_exceeded');
    expect((await loopsSpendGate(engine))).toMatchObject({ ok: false, reason: 'daily_spend_cap', spentUsd: 2 });
    expect(providerCalls).toBe(2);
  });
});
