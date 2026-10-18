/**
 * C-9 (#6948 sweep, #6761): a put_page's facts-absorb job that dies after its 5 attempts (provider outage, bad
 * config) was never re-dispatched. The page-write effect had already completed as 'queued' in the same transaction
 * that submitted the job, so nothing submitted it again and that revision's facts never landed.
 *
 * Real path on PGLite: committed page write, facts-backstop effect dispatch, the facts-absorb job run by the PGLite
 * drain (the same claim/fail semantics as the worker) against a stub provider that fails 5 times, then recovers.
 * The next maintenance pass (the facts_drain cycle phase) must re-submit the dead job once and the facts must land.
 * A job that died on a deterministic write refusal stays dead and is reported as not retryable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect } from '../../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../../src/core/persistence/effect-facts.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { __resetFactsDrainNoticesForTests, runFactsDrain } from '../../src/core/facts/drain.ts';
import { _resetLlmHaltCooldownsForTests } from '../../src/core/minions/llm-halt-cooldown.ts';
import { runPhaseFactsDrain } from '../../src/core/cycle/facts-drain.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { RESUBMIT_SPACING_MS, classifyDeadFactsAbsorb, readDeadFactsAbsorbRetry, retryDeadFactsAbsorb, updateDeadFactsAbsorbKeys } from '../../src/core/facts/dead-absorb-retry.ts';
import { factsExtractionEntry } from '../../src/commands/doctor/checks/knowledge-health.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { testBackends, requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const KEYS = { ANTHROPIC_API_KEY: 'sk-test-c9', OPENAI_API_KEY: 'sk-test-c9' };
const MODEL = 'anthropic:claude-sonnet-4-6';
const PAGE = 'notes/c9-example';
const config = { engine: 'pglite' as const, embedding_disabled: true };
const content = `---\ntype: note\ntitle: Field notes\n---\n\n${'Acme Example shipped the beta in 2026, per this project record. '.repeat(4)}`;
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('embedding_disabled', 'true');
  __resetFactsDrainNoticesForTests();
  _resetLlmHaltCooldownsForTests();
  __setChatTransportForTests(null);
  configureGateway({ embedding_disabled: true, env: KEYS } as never);
});

function factsReply(): ChatResult {
  const text = JSON.stringify({ facts: [{ fact: 'Acme Example shipped the beta in 2026', kind: 'fact', entity: 'companies/acme-example', confidence: 0.9, notability: 'high' }] });
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: MODEL, providerId: 'anthropic',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
}

/** Committed put_page, its facts-backstop effect dispatched: the job the effect completed as 'queued'. */
async function putPageJob(): Promise<number> {
  await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, PAGE);
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: PAGE, pageId: null, requestId: randomUUID(), callerIntent: { content }, intent: { content } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  const published = await publishMutation(engine, row, await preparePageMutation(engine, row, config));
  expect(published.outcome?.facts_backstop).toEqual({ queued: true });
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
  const effect = (await claimPersistenceEffect(engine, localHostId()))!;
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  const [effectRow] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effect.id]);
  expect(effectRow.state).toBe('committed');
  const [job] = await engine.executeRaw<{ id: number; idempotency_key: string }>("SELECT id, idempotency_key FROM minion_jobs WHERE name='facts-absorb'");
  expect(job.idempotency_key).toMatch(/^facts-absorb:write:/);
  return Number(job.id);
}

const job = async (id: number) => (await engine.executeRaw<{ status: string; attempts_made: number; error_text: string | null }>(
  'SELECT status, attempts_made, error_text FROM minion_jobs WHERE id=$1', [id]))[0]!;
const factCount = async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%shipped the beta%' AND expired_at IS NULL"))[0]?.n ?? 0);

/** Drain until the job is dead, making every delayed retry due at once (the worker's backoff, compressed). */
async function drainUntilDead(id: number): Promise<void> {
  for (let i = 0; i < 10 && (await job(id)).status !== 'dead'; i++) {
    await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE id=$1 AND status='delayed'", [id]);
    await runFactsDrain(engine, { owner: 'cycle', log: () => {}, yieldMs: 0 });
  }
  expect((await job(id)).status).toBe('dead');
}

const isolated = (fn: () => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-c9-'));
  return withEnv({ GBRAIN_HOME: home, ...KEYS }, fn).finally(() => rmSync(home, { recursive: true, force: true }));
};

describe('C-9: a dead put_page facts-absorb job is re-submitted once its cause clears', () => {
  test('provider fails 5 times, the job dies; after recovery the next maintenance pass re-submits it and the facts land', () => isolated(async () => {
    const id = await putPageJob();
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443'); });
    await drainUntilDead(id);
    expect(calls).toBe(5);
    expect(await factCount()).toBe(0);

    __setChatTransportForTests(async () => factsReply());
    const pass = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(pass.details).toMatchObject({ dead_retry: { resubmitted: 1 } });
    expect(await factCount()).toBe(1);
    expect((await job(id)).status).toBe('completed');
  }), 120_000);
  test('the cause has not cleared: nothing is re-submitted while extraction is not servable, then the job runs once it is', () => isolated(async () => {
    const id = await putPageJob();
    __setChatTransportForTests(async () => { throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443'); });
    await drainUntilDead(id);
    // The provider key is gone (the outage was a revoked key): nothing is re-submitted.
    await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
      configureGateway({ embedding_disabled: true, env: {} } as never);
      __setChatTransportForTests(null);
      const waiting = await retryDeadFactsAbsorb(engine);
      expect(waiting).toMatchObject({ resubmitted: 0, pending: 1, waiting_on: 'extraction_unavailable' });
    });
    expect((await job(id)).status).toBe('dead');
    configureGateway({ embedding_disabled: true, env: KEYS } as never);
    expect(await retryDeadFactsAbsorb(engine)).toMatchObject({ resubmitted: 1, pending: 0 });
    expect((await job(id)).status).toBe('waiting');
  }), 120_000);

  test('bounded: at most one re-submit an hour and max_resubmits per key; then exhausted until reset; clear stops it for good', () => isolated(async () => {
    const id = await putPageJob();
    __setChatTransportForTests(async () => { throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443'); });
    await drainUntilDead(id);
    await engine.setConfig('facts.absorb_retry.max_resubmits', '2');
    let now = Date.now();
    for (let round = 1; round <= 2; round++) {
      expect(await retryDeadFactsAbsorb(engine, { now })).toMatchObject({ resubmitted: 1 });
      await drainUntilDead(id);
      expect(await retryDeadFactsAbsorb(engine, { now: now + 1_000 })).toMatchObject({ resubmitted: 0, ...(round < 2 ? { waiting_on: 'spacing' } : {}) });
      now += RESUBMIT_SPACING_MS + 1;
    }
    const exhausted = await retryDeadFactsAbsorb(engine, { now });
    expect(exhausted).toMatchObject({ resubmitted: 0, pending: 0 });
    expect(exhausted.exhausted).toEqual([expect.objectContaining({ job_id: id, resubmits: 2 })]);
    const key = exhausted.exhausted[0]!.key;

    // Doctor names the count and the one command.
    const [check] = await factsExtractionEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('1 exhausted after 2 re-submit(s)');
    expect(check!.message).toContain(`gbrain facts retry-dead --reset '${key}'`);
    expect(check!.details).toMatchObject({ facts_absorb_retry: { pending: 0, exhausted: [expect.objectContaining({ key })] } });

    expect(await updateDeadFactsAbsorbKeys(engine, 'reset', [key], now)).toEqual([key]);
    expect(await retryDeadFactsAbsorb(engine, { now })).toMatchObject({ resubmitted: 1 });
    await drainUntilDead(id);
    expect(await updateDeadFactsAbsorbKeys(engine, 'clear', 'all', now)).toEqual([key]);
    expect(await retryDeadFactsAbsorb(engine, { now: now + 10 * RESUBMIT_SPACING_MS })).toMatchObject({ resubmitted: 0, pending: 0, cleared: 1 });
    expect((await job(id)).status).toBe('dead');
  }), 120_000);

  test('a deterministic failure stays dead and is reported not retryable; naming its key in a reset re-enables it', () => isolated(async () => {
    const queue = new MinionQueue(engine);
    await engine.putPage('notes/c9-refused', { type: 'note', title: 'Refused', compiled_truth: 'Acme Example shipped the beta in 2026.', timeline: '', frontmatter: {} } as never);
    const key = `facts-absorb:write:${randomUUID()}`;
    const added = await queue.add('facts-absorb', { slug: 'notes/c9-refused', sourceId: 'default', source: 'mcp:put_page' }, { queue: 'default', idempotency_key: key, max_attempts: 5 });
    await engine.executeRaw("UPDATE minion_jobs SET status='dead', finished_at=now(), error_text=$2 WHERE id=$1",
      [added.id, '[facts-extract] malformed_output (model=anthropic:claude-sonnet-4-6)']);
    const pass = await retryDeadFactsAbsorb(engine);
    expect(pass).toMatchObject({ resubmitted: 0, pending: 0 });
    expect(pass.not_retryable).toEqual([{ job_id: added.id, slug: 'notes/c9-refused' }]);
    expect((await job(added.id)).status).toBe('dead');
    expect((await readDeadFactsAbsorbRetry(engine)).not_retryable).toHaveLength(1);
    expect(await updateDeadFactsAbsorbKeys(engine, 'reset', [key])).toEqual([key]);
    expect(await retryDeadFactsAbsorb(engine)).toMatchObject({ resubmitted: 1 });
  }), 120_000);
});

describe('C-9: dead facts-absorb failure classes', () => {
  test('provider and config failures are retryable; write refusals and content-deterministic extraction failures are not', () => {
    expect(classifyDeadFactsAbsorb('[facts-extract] provider_error (model=anthropic:claude-sonnet-4-6) (cause=Error)')).toBe('provider');
    expect(classifyDeadFactsAbsorb('[facts-extract] provider_error (model=openai:gpt-6.1-sol) (cause=APIError auth)')).toBe('config');
    expect(classifyDeadFactsAbsorb('[facts-extract] chat_unavailable (model=openai:gpt-6.1-sol)')).toBe('config');
    expect(classifyDeadFactsAbsorb('503 Service Unavailable')).toBe('provider');
    expect(classifyDeadFactsAbsorb('Job timed out after 600000ms')).toBe('provider');
    for (const deterministic of ['[facts-extract] malformed_output (model=x)', '[facts-extract] refusal (model=x)', '[facts-extract] truncated_output (model=x)',
      'facts_absorb_write_refused (permission_denied): refused. Not retried.', 'TypeError: cannot read properties of undefined', null]) {
      expect(classifyDeadFactsAbsorb(deterministic)).toBe('not_retryable');
    }
  });
});

// Postgres: the job worker runs facts-absorb jobs and the facts_drain phase does not drain, but the phase still
// re-submits a dead page-write job there, and the set and its SQL behave the same.
for (const backend of testBackends().filter(b => b === 'postgres')) {
  describe(`C-9 on ${backend}: the maintenance pass re-submits a dead page-write job for the worker`, () => {
    test('a dead provider_error job is re-queued by the facts_drain phase; a write refusal stays dead', () => isolated(async () => {
      const { engine: pg, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      try {
        const db: BrainEngine = pg;
        await db.setConfig('facts.extraction_model', MODEL);
        const queue = new MinionQueue(db);
        const add = async (slug: string, errorText: string) => {
          const j = await queue.add('facts-absorb', { slug, sourceId: 'default', source: 'mcp:put_page' }, { queue: 'default', idempotency_key: `facts-absorb:write:${randomUUID()}`, max_attempts: 5 });
          await db.executeRaw("UPDATE minion_jobs SET status='dead', finished_at=now(), attempts_started=5, attempts_made=5, error_text=$2 WHERE id=$1", [j.id, errorText]);
          return j.id;
        };
        const outage = await add('notes/c9-pg-outage', '[facts-extract] provider_error (model=anthropic:claude-sonnet-4-6) (cause=Error)');
        const refused = await add('notes/c9-pg-refused', 'facts_absorb_write_refused (permission_denied): refused. Not retried.');
        const pass = await runPhaseFactsDrain(db, { dryRun: false });
        expect(pass.details).toMatchObject({ reason: 'not_applicable', dead_retry: { resubmitted: 1, not_retryable: 1 } });
        const status = async (id: number) => (await db.executeRaw<{ status: string; attempts_made: number }>('SELECT status, attempts_made FROM minion_jobs WHERE id=$1', [id]))[0]!;
        expect(await status(outage)).toEqual({ status: 'waiting', attempts_made: 0 });
        expect((await status(refused)).status).toBe('dead');
        await db.executeRaw("UPDATE minion_jobs SET status='completed', finished_at=now() WHERE id=$1", [outage]);
        expect(await readDeadFactsAbsorbRetry(db)).toMatchObject({ pending: 0, exhausted: [], not_retryable: [{ job_id: refused }] });
      } finally { await close(); }
    }), 120_000);
  });
}
