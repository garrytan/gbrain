import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { LocalConfigurationError } from '../../src/core/minions/configuration-error.ts';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';
import { withEnv } from '../helpers/with-env.ts';
import { checkChildReadiness } from '../../src/core/minions/child-readiness.ts';
import { killProcessGroup } from '../../src/core/minions/job-isolation.ts';

const describeDb = hasDatabase() ? describe : describe.skip;
let queue: MinionQueue;

beforeAll(async () => {
  if (!hasDatabase()) return;
  await setupDB();
  queue = new MinionQueue(getEngine());
});

afterAll(async () => {
  if (hasDatabase()) await teardownDB();
});

describeDb('Postgres worker configuration release', () => {
  test('owned release preserves both counters and stale or terminal releases no-op', async () => {
    for (const terminal of [null, 'cancelled', 'completed'] as const) {
      const job = await queue.add('fixture-release', {});
      const token = `fixture-token-${job.id}`;
      await queue.claim(token, 30_000, 'default', ['fixture-release']);
      await getEngine().executeRaw('UPDATE minion_jobs SET stalled_counter = 2 WHERE id = $1', [job.id]);
      if (terminal) await getEngine().executeRaw('UPDATE minion_jobs SET status = $1 WHERE id = $2', [terminal, job.id]);
      const before = await queue.getJob(job.id);
      expect(await queue.releaseConfigurationJob(job.id, 'stale-token', new AbortController().signal)).toBe('no_op');
      expect(await queue.releaseConfigurationJob(job.id, token, new AbortController().signal)).toBe(terminal ? 'no_op' : 'released');
      const after = await queue.getJob(job.id);
      expect(after?.attempts_made).toBe(before?.attempts_made);
      expect(after?.stalled_counter).toBe(2);
      expect(after?.status).toBe(terminal ?? 'delayed');
      if (!terminal) {
        expect(after?.lock_token).toBeNull();
        expect(after?.lock_until).toBeNull();
        expect(after?.delay_until!.getTime()).toBeGreaterThan(Date.now());
      }
      expect(await queue.releaseConfigurationJob(job.id, token, new AbortController().signal)).toBe('no_op');
    }
  });

  test('runtime typed fault stops admission and preserves the real claimed row', async () => {
    const first = await queue.add('fixture-fault', {}, { max_attempts: 1 });
    const second = await queue.add('fixture-fault', {});
    const worker = new MinionWorker(getEngine(), { pollInterval: 5, healthCheckInterval: 0 });
    worker.register('fixture-fault', async () => {
      throw new LocalConfigurationError('postgres_cancellation_unavailable', 'Fixture driver fault');
    });
    await worker.start();
    expect(worker.configurationError?.reasonCode).toBe('postgres_cancellation_unavailable');
    expect((await queue.getJob(first.id))?.status).toBe('delayed');
    expect((await queue.getJob(first.id))?.attempts_made).toBe(0);
    expect((await queue.getJob(first.id))?.stalled_counter).toBe(0);
    expect((await queue.getJob(second.id))?.status).toBe('waiting');
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
  });

  test.skipIf(process.platform !== 'linux')('real child readiness and typed handler fault compose through CLI exit and confirmed release', async () => {
    const home = mkdtempSync(join(tmpdir(), 'worker-configuration-journey-'));
    const queueName = `configuration-journey-${process.pid}`;
    const tracePath = join(home, 'child-events.jsonl');
    const launcher = join(home, 'selected-child');
    const fixture = resolve(import.meta.dir, 'fixtures/worker-configuration-child.ts');
    const first = await queue.add('orphans', {}, { queue: queueName, max_attempts: 1 });
    const second = await queue.add('orphans', {}, { queue: queueName });
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL }));
      const quoted = [process.execPath, '--no-env-file', fixture].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
      writeFileSync(launcher, `#!/bin/sh\nexec ${quoted} "$@"\n`);
      chmodSync(launcher, 0o700);
      const result = await runCli(['jobs', 'work', '--queue', queueName, '--concurrency', '1', '--job-isolation', 'process', '--health-interval', '0', '--max-rss', '0'], {
        home,
        timeoutMs: 45_000,
        env: {
          GBRAIN_JOB_CHILD_CLI: launcher,
          GBRAIN_TEST_CHILD_TRACE: tracePath,
          GBRAIN_TEST_CHILD_QUEUE: queueName,
          GBRAIN_TEST_CHILD_MODE: undefined,
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
        },
      });
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, diagnostic).toBe(16);
      expect(result.stderr).toContain('configuration blocked (postgres_cancellation_unavailable)');
      expect(result.stderr).toContain('Configuration shutdown settled 1 claim(s); 0 release(s) unconfirmed.');
      const events = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(event => event.kind)).toEqual(['readiness', 'handler']);
      expect(events[0].code).toBe(0);
      expect(events[0].jobs).toEqual([
        { id: first.id, status: 'waiting', attempts_started: 0 },
        { id: second.id, status: 'waiting', attempts_started: 0 },
      ]);
      expect(events[1].id).toBe(first.id);
      expect(events[1].pid).not.toBe(events[1].parentPid);
      expect(events[1].parentPid).toBeGreaterThan(1);
      expect(() => process.kill(events[1].pid, 0)).toThrow();
      const released = await queue.getJob(first.id);
      expect(released?.status).toBe('delayed');
      expect(released?.attempts_made).toBe(0);
      expect(released?.stalled_counter).toBe(0);
      expect(released?.lock_token).toBeNull();
      expect(released?.lock_until).toBeNull();
      expect(released?.delay_until!.getTime()).toBeGreaterThan(Date.now());
      expect((await queue.getJob(second.id))?.status).toBe('waiting');
      expect((await queue.getJob(second.id))?.attempts_started).toBe(0);
      expect(await queue.releaseConfigurationJob(first.id, events[1].lockToken, new AbortController().signal)).toBe('no_op');
    } finally {
      await queue.removeJob(first.id);
      await queue.removeJob(second.id);
      rmSync(home, { recursive: true, force: true });
    }
  }, 50_000);

  test.skipIf(process.platform !== 'linux')('completion-recording failure never releases an isolated handler with a live descendant', async () => {
    const home = mkdtempSync(join(tmpdir(), 'worker-configuration-recording-'));
    const queueName = `configuration-recording-${process.pid}`;
    const tracePath = join(home, 'child-events.jsonl');
    const fixture = resolve(import.meta.dir, 'fixtures/worker-configuration-child.ts');
    const invocation = { cmd: process.execPath, argsPrefix: ['--no-env-file', fixture] };
    const job = await queue.add('orphans', {}, { queue: queueName, max_attempts: 1 });
    const worker = new MinionWorker(getEngine(), {
      queue: queueName, concurrency: 1, pollInterval: 5, healthCheckInterval: 0,
      jobIsolation: 'process', childCliInvocation: invocation, childTiniPath: '',
    });
    let childGroup: number | undefined;
    let descendant: number | undefined;
    let completionCalls = 0;
    let liveAtRecordingFailure = false;
    worker.register('orphans', async () => { throw new Error('The parent must not run the isolated fixture handler'); });
    (worker as unknown as { queue: MinionQueue }).queue.completeJob = async () => {
      completionCalls++;
      const event = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(event => event.kind === 'handler');
      childGroup = event.pid;
      descendant = event.descendantPid;
      process.kill(descendant!, 0);
      liveAtRecordingFailure = true;
      throw new LocalConfigurationError('postgres_cancellation_unavailable', 'Fixture completion recording fault');
    };
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL }));
      await withEnv({
        HOME: home, GBRAIN_HOME: home,
        GBRAIN_TEST_CHILD_TRACE: tracePath,
        GBRAIN_TEST_CHILD_QUEUE: queueName,
        GBRAIN_TEST_CHILD_MODE: 'success-with-live-descendant',
        ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined,
      }, async () => {
        await checkChildReadiness({ invocation, tiniPath: '' });
        await worker.start();
      });
      expect(completionCalls).toBe(1);
      expect(liveAtRecordingFailure).toBe(true);
      expect(() => process.kill(descendant!, 0)).not.toThrow();
      expect(worker.configurationError?.reasonCode).toBe('postgres_cancellation_unavailable');
      expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['unconfirmed']);
      const unchanged = await queue.getJob(job.id);
      expect(unchanged?.status).toBe('active');
      expect(unchanged?.attempts_made).toBe(0);
      expect(unchanged?.stalled_counter).toBe(0);
      expect(unchanged?.lock_token).not.toBeNull();
    } finally {
      worker.stop();
      if (!childGroup) {
        try {
          const event = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(event => event.kind === 'handler');
          childGroup = event?.pid;
          descendant = event?.descendantPid;
        } catch {}
      }
      if (childGroup) killProcessGroup(childGroup, 'SIGKILL');
      if (descendant) {
        let running = true;
        for (let attempt = 0; attempt < 40 && running; attempt++) {
          try {
            const stat = readFileSync(`/proc/${descendant}/stat`, 'utf8');
            running = !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            running = false;
          }
          if (running) await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(running).toBe(false);
      }
      await queue.removeJob(job.id);
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);
});
