/**
 * W9F item 6 (Decision 7): which handler errors during a worker shutdown burn
 * an attempt, for an in-process worker.
 *
 * Protects: during `requestShutdown()` a handler error is presumed
 * shutdown-induced (cooperative handlers throw plain errors when they bail:
 * subagent, shell), so the claim goes back to `waiting` with no attempt burned
 * and the handler's own text kept after the `worker_shutdown` marker; an
 * `UnrecoverableError` is deterministic and dead-letters on attempt 1 with its
 * original text. The watchdog and configuration-block rows pin today's
 * behavior so a later change to them is deliberate.
 * Fails when: an UnrecoverableError thrown during shutdown is requeued as
 * `worker_shutdown` (the pre-fix behavior: a second, possibly paid, run of a
 * deterministic failure with its real error lost), or a shutdown hand-back
 * overwrites the handler's error text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { UnrecoverableError, type MinionJobContext } from '../src/core/minions/types.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';

type Trigger = 'requestShutdown' | 'watchdog' | 'configuration';
const ERRORS: Record<string, (ctx: MinionJobContext) => unknown> = {
  reason: ctx => ctx.shutdownSignal.reason ?? ctx.signal.reason,
  abortErrorWithCause: ctx => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', cause: ctx.shutdownSignal.reason }),
  wrappedAbort: ctx => new Error('subagent aborted during tool dispatch', { cause: ctx.shutdownSignal.reason }),
  unrecoverable: () => new UnrecoverableError('invalid params: slug is required'),
  plain: () => new Error('handler failed: upstream returned 500'),
};

async function runCase(engine: BrainEngine, trigger: Trigger, kind: keyof typeof ERRORS) {
  const queue = new MinionQueue(engine);
  const worker = new MinionWorker(engine, { pollInterval: 10, lockDuration: 60_000, healthCheckInterval: 0, stalledInterval: 600_000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const name = `matrix-${trigger}-${kind}`;
  worker.register(name, async (ctx) => { await gate; throw ERRORS[kind]!(ctx); });
  const job = await queue.add(name, {}, { max_attempts: 3 }, { allowProtectedSubmit: true });
  const running = worker.start();
  for (let i = 0; i < 400 && (await queue.getJob(job.id))?.status !== 'active'; i++) await Bun.sleep(10);
  if (trigger === 'requestShutdown') worker.requestShutdown();
  else if (trigger === 'watchdog') (worker as unknown as { gracefulShutdown(reason: string): void }).gracefulShutdown('watchdog');
  else worker.blockForConfiguration(new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture cancellation unavailable'));
  release();
  let row = await queue.getJob(job.id);
  for (let i = 0; i < 500 && row?.status === 'active'; i++) { await Bun.sleep(10); row = await queue.getJob(job.id); }
  worker.stop();
  await running;
  row = await queue.getJob(job.id);
  return { status: row?.status, attempts: row?.attempts_made, error: row?.error_text };
}

for (const backend of testBackends()) describe(`worker shutdown error matrix (W9F item 6, in-process, ${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined));
  }, 120_000);
  afterAll(async () => { await close(); });

  test('requestShutdown: only UnrecoverableError burns an attempt; every hand-back keeps the handler text', async () => {
    const reasonText = 'shutdown';
    expect(await runCase(engine, 'requestShutdown', 'reason')).toEqual({ status: 'waiting', attempts: 0, error: `worker_shutdown: ${reasonText}` });
    expect(await runCase(engine, 'requestShutdown', 'abortErrorWithCause')).toEqual({ status: 'waiting', attempts: 0, error: 'worker_shutdown: The operation was aborted' });
    expect(await runCase(engine, 'requestShutdown', 'wrappedAbort')).toEqual({ status: 'waiting', attempts: 0, error: 'worker_shutdown: subagent aborted during tool dispatch' });
    expect(await runCase(engine, 'requestShutdown', 'plain')).toEqual({ status: 'waiting', attempts: 0, error: 'worker_shutdown: handler failed: upstream returned 500' });
    expect(await runCase(engine, 'requestShutdown', 'unrecoverable')).toEqual({ status: 'dead', attempts: 1, error: 'invalid params: slug is required' });
  }, 60_000);

  test('watchdog: the per-job abort fires, so the job takes the abort path (attempt burned; UnrecoverableError dead)', async () => {
    for (const kind of ['reason', 'abortErrorWithCause', 'wrappedAbort', 'plain'] as const) {
      expect(await runCase(engine, 'watchdog', kind)).toEqual({ status: 'delayed', attempts: 1, error: 'aborted: watchdog' });
    }
    expect(await runCase(engine, 'watchdog', 'unrecoverable')).toEqual({ status: 'dead', attempts: 1, error: 'aborted: watchdog' });
  }, 60_000);

  test('configuration block: every error releases through the configuration path with no attempt burned', async () => {
    for (const kind of Object.keys(ERRORS)) {
      const row = await runCase(engine, 'configuration', kind);
      expect(row.attempts).toBe(0);
      expect(row.status).not.toBe('dead');
    }
  }, 60_000);
});
