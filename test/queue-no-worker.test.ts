/**
 * Lane E5 (agent-first operator wave): queue honesty.
 *
 * - CLI `jobs submit` on PGLite without --follow refuses with `no_worker` and
 *   the exact --follow command; --queue-only queues deliberately.
 * - `gbrain jobs work` on PGLite drains the queue in the foreground and exits.
 * - MCP submit_job accepts and emits a `no_worker` notice.
 * - get_job_stats / deriveWedgeSignal distinguish no_worker from wedged.
 * - doctor queue_health counts waiting rows on PGLite with a drain fix.
 * - put_page reports embedding_state "disabled" on a keyless brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue, deriveWedgeSignal } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { runWaitingJobsFix, noWorkerNotice, queueWorkerAlive } from '../src/core/minions/no-worker.ts';
import { runJobsSubmit } from '../src/commands/jobs/submit.ts';
import { drainPgliteQueue } from '../src/commands/jobs/work.ts';
import { computeQueueHealthCheck } from '../src/commands/doctor/checks/queue-jobs.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  home = mkdtempSync(join(tmpdir(), 'gbrain-no-worker-'));
});

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const op = (name: string) => operations.find(o => o.name === name)!;
async function waitingRows(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'waiting'");
  return Number(row?.n ?? 0);
}
function ctx(notices: Notice[], overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: { engine: 'pglite' as const }, dryRun: false, remote: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} }, emitNotice: n => notices.push(n), ...overrides,
  };
}

describe('deriveWedgeSignal liveness', () => {
  test('no live worker → no_worker, never wedged', () => {
    expect(deriveWedgeSignal({ active_healthy: 0, waiting: 3, minutes_since_completion: 60 }, { workerAlive: false }))
      .toMatchObject({ no_worker: true, wedged: false });
  });
  test('a live worker claiming nothing stays wedged', () => {
    expect(deriveWedgeSignal({ active_healthy: 0, waiting: 3, minutes_since_completion: 60 }, { workerAlive: true }))
      .toMatchObject({ no_worker: false, wedged: true });
  });
  test('unknown liveness keeps the pre-E5 derivation; empty queue is neither', () => {
    expect(deriveWedgeSignal({ active_healthy: 0, waiting: 3, minutes_since_completion: null })).toMatchObject({ no_worker: false, wedged: true });
    expect(deriveWedgeSignal({ active_healthy: 0, waiting: 0, minutes_since_completion: null }, { workerAlive: false })).toMatchObject({ no_worker: false, wedged: false });
  });
  test('a parent-owned dream-inline queue is never no_worker', () => {
    expect(deriveWedgeSignal({ queue: 'dream-inline-abc', active_healthy: 0, waiting: 3, minutes_since_completion: null }, { workerAlive: false }).no_worker).toBe(false);
  });
});

describe('no_worker fix', () => {
  test('PGLite drains in the foreground and needs the brain exclusively; Postgres starts the supervisor', () => {
    expect(runWaitingJobsFix('pglite', 'default')).toMatchObject({ argv: ['gbrain', 'jobs', 'work'], requires_exclusive: true, actor: 'agent' });
    expect(runWaitingJobsFix('pglite', 'bulk')).toMatchObject({ argv: ['gbrain', 'jobs', 'work', '--queue', 'bulk'] });
    expect(runWaitingJobsFix('postgres', 'default')).toMatchObject({ argv: ['gbrain', 'jobs', 'supervisor', 'start'], requires_exclusive: false });
    expect(noWorkerNotice('pglite', 'default', 2)).toMatchObject({ code: 'no_worker', kind: 'degraded' });
  });
  test('liveness reads the worker registry by queue', () => {
    expect(queueWorkerAlive('default', () => [{ queue: 'default' }])).toBe(true);
    expect(queueWorkerAlive('default', () => [{ queue: 'other' }])).toBe(false);
    expect(queueWorkerAlive('default', () => { throw new Error('unreadable'); })).toBeUndefined();
  });
});

describe('CLI jobs submit on PGLite', () => {
  test('without --follow refuses with no_worker and the exact --follow command; nothing is queued', () => inHome(async () => {
    _resetCliExitVerdictForTests();
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runJobsSubmit({ args: ['submit', 'sync', '--params', '{}'], engine, queue: new MinionQueue(engine) } as never);
      const text = stderr.mock.calls.map(c => String(c[0])).join('');
      expect(text).toContain('Error [no_worker]');
      expect(text).toContain("Fix: gbrain jobs submit sync --params '{}' --follow");
      expect(currentExitCode()).toBe(1);
      const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs');
      expect(Number(row?.n ?? 0)).toBe(0);
    } finally {
      stderr.mockRestore();
      _resetCliExitVerdictForTests();
    }
  }));

  test('--queue-only queues deliberately', () => inHome(async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runJobsSubmit({ args: ['submit', 'sync', '--params', '{}', '--queue-only'], engine, queue: new MinionQueue(engine) } as never);
      expect(await waitingRows()).toBe(1);
    } finally {
      log.mockRestore();
    }
  }));
});

describe('jobs work on PGLite', () => {
  test('drains the waiting jobs it can run, then exits', () => inHome(async () => {
    const queue = new MinionQueue(engine);
    await queue.ensureSchema();
    await queue.add('noop-example', {}, {});
    await queue.add('noop-example', {}, {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = await drainPgliteQueue(engine, queue, 'default', async (worker: MinionWorker) => {
        worker.register('noop-example', async () => ({ ok: true }));
      });
      expect(out.delayed).toBe(0);
    } finally {
      log.mockRestore();
    }
    const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'completed'");
    expect(Number(row?.n ?? 0)).toBe(2);
    expect(await waitingRows()).toBe(0);
  }), 60_000);
});

describe('MCP no_worker surfaces', () => {
  test('submit_job accepts and emits a no_worker notice', () => inHome(async () => {
    const notices: Notice[] = [];
    const result = await op('submit_job').handler(ctx(notices), { name: 'noop-example', data: {} }) as { id: number };
    expect(result.id).toBeGreaterThan(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'no_worker', kind: 'degraded', fix: { argv: ['gbrain', 'jobs', 'work'] } });
  }));

  test('get_job_stats reports no_worker, not wedged, with waiting work and no worker', () => inHome(async () => {
    await new MinionQueue(engine).add('noop-example', {}, {});
    const notices: Notice[] = [];
    const stats = await op('get_job_stats').handler(ctx(notices), {}) as { wedged: boolean; no_worker: boolean };
    expect(stats.no_worker).toBe(true);
    expect(stats.wedged).toBe(false);
    expect(notices.map(n => n.code)).toEqual(['no_worker']);
  }));
});

describe('doctor queue_health on PGLite', () => {
  test('counts waiting rows and names the foreground drain', async () => {
    await new MinionQueue(engine).add('noop-example', {}, {});
    const check = await computeQueueHealthCheck(engine, { readWorkers: () => [] });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no_worker');
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'jobs', 'work'], requires_exclusive: true,
      verify: { argv: ['gbrain', 'doctor', '--only', 'queue_health', '--json'] } });
    expect((check.details as { depth: number }).depth).toBe(1);
  });
  test('a live drain on the queue, or an empty queue, is ok', async () => {
    expect((await computeQueueHealthCheck(engine, { readWorkers: () => [] })).status).toBe('ok');
    await new MinionQueue(engine).add('noop-example', {}, {});
    expect((await computeQueueHealthCheck(engine, { readWorkers: () => [{ queue: 'default' }] })).status).toBe('ok');
  });
});

describe('put_page embedding_state', () => {
  test('a keyless brain reports embedding_state "disabled"', () => inHome(async () => {
    await engine.setConfig('embedding_disabled', 'true');
    const result = await op('put_page').handler(ctx([]), {
      slug: 'notes/keyless-example', content: '---\ntitle: Keyless\n---\n\nA keyless brain keeps keyword search only.',
    }) as { embedding_state?: string; persistence?: { embedding_state?: string } };
    expect(result.embedding_state ?? result.persistence?.embedding_state).toBe('disabled');
  }), 60_000);
});
