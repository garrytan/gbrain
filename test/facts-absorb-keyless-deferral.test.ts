/**
 * Keyless facts-absorb jobs wait instead of completing empty (Foundations 2,
 * Lane D, taste choice T8), and a job stopped by its signal is never
 * completed. Protects: a keyless backlog survives until a key exists; the
 * worker defers with no attempt counted and no stacktrace growth; the
 * process-isolation codec carries the deferral; the keyless extract_facts op
 * envelope is unchanged (covered by facts-backstop-outcome.serial.test.ts).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { JobDeferredError } from '../src/core/minions/errors.ts';
import type { MinionHandler, MinionJobContext } from '../src/core/minions/types.ts';
import { encodeHandlerError, reconstructHandlerError } from '../src/core/minions/job-isolation.ts';
import { FACTS_ABSORB_KEYLESS_RETRY_MS, makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_VERSION)); });

const BODY = `Acme Example shipped the beta in 2026. ${'A substantive project record with names, dates and decisions. '.repeat(5)}`;
function ctx(job: { id: number; data: Record<string, unknown> }, signal = new AbortController().signal): MinionJobContext {
  return { id: job.id, name: 'facts-absorb', data: job.data, attempts_made: 0, idempotency_key: null, signal, deadlineAtMs: null, shutdownSignal: signal,
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as MinionJobContext;
}
async function queued(slug: string) {
  await engine.putPage(slug, { type: 'note', title: 'Note', compiled_truth: BODY, timeline: '', frontmatter: {} } as never);
  return new MinionQueue(engine).add('facts-absorb', { slug, sourceId: 'default', source: 'mcp:put_page', notabilityFilter: 'all', visibility: 'private' });
}

test('a keyless worker defers the facts-absorb job instead of completing it empty', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-keyless-'));
  try {
    await withEnv({ GBRAIN_HOME: home, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GBRAIN_MODEL: undefined }, async () => {
      configureGateway({ env: {} } as never);
      const job = await queued('notes/keyless-example');
      const err = await makeFactsAbsorbHandler(engine)(ctx(job)).then(() => null, e => e);
      expect(err).toBeInstanceOf(JobDeferredError);
      expect(err).toMatchObject({ reason: 'no_key', retryInMs: FACTS_ABSORB_KEYLESS_RETRY_MS });
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an aborted run is never completed', async () => {
  configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-test' } } as never);
  await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
  __setChatTransportForTests(async () => { throw new Error('should not be called'); });
  const job = await queued('notes/aborted-example');
  const abort = new AbortController();
  abort.abort(new Error('shutdown'));
  await expect(makeFactsAbsorbHandler(engine)(ctx(job, abort.signal))).rejects.toThrow('shutdown');
  __setChatTransportForTests(null);
});

test('the worker returns a deferred job to delayed with no attempt counted and no stacktrace entry', async () => {
  const queue = new MinionQueue(engine);
  const job = await queue.add('defer-example', {}, { max_attempts: 2 });
  const worker = new MinionWorker(engine, { pollInterval: 50 });
  let calls = 0;
  const handler: MinionHandler = async () => { calls++; throw new JobDeferredError('no_key', 'waiting for a key', 60_000); };
  worker.register('defer-example', handler);
  const running = worker.start();
  for (let i = 0; i < 100; i++) {
    if ((await queue.getJob(job.id))?.status === 'delayed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  worker.stop();
  await running;
  const row = (await queue.getJob(job.id))!;
  expect(calls).toBe(1);
  expect(row.status).toBe('delayed');
  expect(row.attempts_made).toBe(0);
  expect(row.error_text).toBe('deferred (no_key): waiting for a key');
  expect(row.stacktrace ?? []).toEqual([]);
  expect(row.delay_until!.getTime()).toBeGreaterThan(Date.now() + 30_000);
});

test('process isolation carries the deferral across the child boundary', () => {
  const encoded = encodeHandlerError(new JobDeferredError('budget_exhausted', 'cap reached', 1234));
  expect(encoded).toMatchObject({ outcome: 'error', errorKind: 'deferred', deferral: { reason: 'budget_exhausted', retryInMs: 1234 } });
  const rebuilt = reconstructHandlerError(encoded as never);
  expect(rebuilt).toBeInstanceOf(JobDeferredError);
  expect(rebuilt).toMatchObject({ reason: 'budget_exhausted', retryInMs: 1234, message: 'cap reached' });
});
