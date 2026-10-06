/**
 * #5062 (fix wave 9, S1) — `jobs supervisor` / `jobs work` stop must drain:
 * real CLI processes against a throwaway Postgres.
 *
 * Pre-fix, a SIGTERM reached the generic CLI cleanup handler first: it
 * DELETEd the supervisor's queue lock and exited 143 before the supervisor
 * emitted `stopped`; the worker died the same way, leaving its in-flight
 * shell job `active` and the job's children orphaned to PID 1, while
 * `jobs supervisor stop` reported `drained`.
 *
 * The barrier job is a shell job whose leader and grandchild both ignore
 * SIGTERM, so every drain takes the shell handler's full SIGTERM→SIGKILL
 * grace window (~5s): long enough to probe the lock and start a second
 * supervisor mid-drain.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeDatabase = hasDatabase() ? describe : describe.skip;
const REPO = resolve(import.meta.dir, '../..');
const CLI = join(REPO, 'src/cli.ts');

type Proc = ReturnType<typeof Bun.spawn>;

function makeHome(tag: string): string {
  const home = mkdtempSync(join(tmpdir(), `sup-5062-${tag}-`));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres', database_url: process.env.DATABASE_URL,
  }));
  return home;
}

function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', ...extra,
  };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_ALLOW_SHELL_JOBS', 'GBRAIN_AUDIT_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  return env;
}

function spawnCli(home: string, args: string[], extra: Record<string, string> = {}): { proc: Proc; out: () => Promise<string> } {
  const proc = Bun.spawn({
    cmd: [process.execPath, '--no-env-file', CLI, ...args],
    env: childEnv(home, extra),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const stdout = new Response(proc.stdout as ReadableStream).text();
  const stderr = new Response(proc.stderr as ReadableStream).text();
  return { proc, out: async () => `${await stdout}\n${await stderr}` };
}

async function until(pred: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid(path: string): number {
  return Number(readFileSync(path, 'utf8').trim());
}

/** Barrier shell job: records each start, then leader + grandchild ignore SIGTERM. */
function barrierCmd(dir: string): string {
  return [
    `echo start >> ${dir}/starts`,
    `sh -c 'trap "" TERM; echo $$ > ${dir}/grandchild.pid; exec sleep 300' &`,
    `echo $$ > ${dir}/leader.pid`,
    `trap "" TERM`,
    `sleep 301`,
  ].join('\n');
}

function events(output: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.event === 'string') rows.push(row);
    } catch { /* not an event line */ }
  }
  return rows;
}

describeDatabase('#5062 supervisor and worker stop drains real work', () => {
  let queue: MinionQueue;
  beforeAll(async () => {
    await setupDB();
    queue = new MinionQueue(getEngine());
  });
  afterAll(async () => { await teardownDB(); });

  const lockRow = async (queueName: string) => {
    const rows = await getEngine().executeRaw<{ holder_pid: number; holder_host: string }>(
      'SELECT holder_pid, holder_host FROM gbrain_cycle_locks WHERE id = $1', [`gbrain-supervisor:${queueName}`]);
    return rows[0] ?? null;
  };

  async function startSupervisorWithBarrier(tag: string) {
    const home = makeHome(tag);
    const queueName = `w9-${tag}-${process.pid}`;
    const pidFile = join(home, 'sup.pid');
    const sup = spawnCli(home, ['jobs', 'supervisor', 'start', '--queue', queueName, '--allow-shell-jobs', '--json',
      '--health-interval', '0', '--max-rss', '0', '--pid-file', pidFile]);
    await until(async () => (await lockRow(queueName)) !== null, 30_000, 'supervisor lock');
    const job = await queue.add('shell', { cmd: barrierCmd(home), cwd: home }, { queue: queueName }, { allowProtectedSubmit: true });
    await until(() => existsSync(join(home, 'grandchild.pid')) && existsSync(join(home, 'leader.pid')), 30_000, 'barrier job start');
    const tree = [readPid(join(home, 'leader.pid')), readPid(join(home, 'grandchild.pid'))];
    expect(tree.every(alive)).toBe(true);
    return { home, queueName, pidFile, sup, job, tree };
  }

  async function expectSettled(s: Awaited<ReturnType<typeof startSupervisorWithBarrier>>, output: string) {
    const ev = events(output);
    const names = ev.map(e => e.event);
    expect(names.filter(n => n === 'shutting_down').length, output).toBe(1);
    expect(names.filter(n => n === 'stopped').length, output).toBe(1);
    expect(names.indexOf('stopped')).toBeGreaterThan(names.indexOf('shutting_down'));
    expect(names.indexOf('shutting_down')).toBeGreaterThan(names.indexOf('worker_spawned'));
    const stopped = ev.find(e => e.event === 'stopped')!;
    expect(stopped.drained).toBe(true);
    expect(stopped.lock_released).toBe(true);
    expect(await lockRow(s.queueName)).toBeNull();
    const row = await queue.getJob(s.job.id);
    expect(row?.status).toBe('waiting');
    expect(row?.attempts_made).toBe(0);
    expect(row?.lock_token).toBeNull();
    expect(s.tree.filter(alive)).toEqual([]);
    expect(readFileSync(join(s.home, 'starts'), 'utf8').trim().split('\n')).toEqual(['start']);
    await queue.removeJob(s.job.id);
    rmSync(s.home, { recursive: true, force: true });
  }

  test('SIGTERM twice: one ordered drain, lock held through it, second supervisor refused, nothing orphaned', async () => {
    const s = await startSupervisorWithBarrier('term');
    const supPid = s.sup.proc.pid;
    s.sup.proc.kill('SIGTERM');
    await Bun.sleep(300);
    s.sup.proc.kill('SIGTERM');

    await Bun.sleep(700);
    const during = await lockRow(s.queueName);
    expect(during?.holder_pid).toBe(supPid);
    expect(during?.holder_host).toBe(hostname());
    expect(alive(supPid)).toBe(true);

    const second = spawnCli(s.home, ['jobs', 'supervisor', 'start', '--queue', s.queueName, '--json',
      '--health-interval', '0', '--max-rss', '0', '--pid-file', join(s.home, 'second.pid')],
      { GBRAIN_SUPERVISOR_LOCK_WAIT_SECONDS: '0' });
    expect(await second.proc.exited, await second.out()).toBe(2);
    expect(alive(supPid)).toBe(true);

    expect(await s.sup.proc.exited).toBe(0);
    await expectSettled(s, await s.sup.out());
  }, 120_000);

  test('SIGINT drains the same way', async () => {
    const s = await startSupervisorWithBarrier('int');
    s.sup.proc.kill('SIGINT');
    expect(await s.sup.proc.exited).toBe(0);
    await expectSettled(s, await s.sup.out());
  }, 120_000);

  test('`jobs supervisor stop` reports drained only after a verified drain', async () => {
    const s = await startSupervisorWithBarrier('stop');
    const stop = spawnCli(s.home, ['jobs', 'supervisor', 'stop', '--json', '--pid-file', s.pidFile]);
    const code = await stop.proc.exited;
    const out = await stop.out();
    expect(code, out).toBe(0);
    const payload = JSON.parse(out.split('\n').find(l => l.startsWith('{"stopped"'))!);
    expect(payload.reason).toBe('drained');
    expect(payload.checks).toEqual({
      process_exited: true, stopped_event: true, worker_drained: true, workers_exited: true, lock_released: true,
    });
    expect(await s.sup.proc.exited).toBe(0);
    await expectSettled(s, await s.sup.out());
  }, 120_000);

  test('bare `jobs work`: SIGTERM hands the job back and reaps its process group', async () => {
    const home = makeHome('work');
    const queueName = `w9-work-${process.pid}`;
    const job = await queue.add('shell', { cmd: barrierCmd(home), cwd: home }, { queue: queueName }, { allowProtectedSubmit: true });
    const worker = spawnCli(home, ['jobs', 'work', '--queue', queueName, '--allow-shell-jobs', '--health-interval', '0', '--max-rss', '0']);
    try {
      await until(() => existsSync(join(home, 'grandchild.pid')) && existsSync(join(home, 'leader.pid')), 30_000, 'barrier job start');
      const tree = [readPid(join(home, 'leader.pid')), readPid(join(home, 'grandchild.pid'))];
      worker.proc.kill('SIGTERM');
      expect(await worker.proc.exited, await worker.out()).toBe(0);
      expect(tree.filter(alive)).toEqual([]);
      const row = await queue.getJob(job.id);
      expect(row?.status).toBe('waiting');
      expect(row?.attempts_made).toBe(0);
    } finally {
      worker.proc.kill('SIGKILL');
      await queue.removeJob(job.id);
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  describe('`jobs supervisor stop` fails closed', () => {
    const FAKE = (home: string) => {
      const path = join(home, 'fake-supervisor.ts');
      writeFileSync(path, `
import { writeFileSync } from 'node:fs';
import { writeSupervisorEvent } from ${JSON.stringify(join(REPO, 'src/core/minions/handlers/supervisor-audit.ts'))};
const [mode, pidFile, queue] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
const emit = (event: string, extra: Record<string, unknown> = {}) =>
  writeSupervisorEvent({ event, ts: new Date().toISOString(), ...extra } as never, process.pid);
emit('started', { queue });
process.on('SIGTERM', () => {
  emit('shutting_down', { reason: 'SIGTERM' });
  if (mode === 'forced') emit('stopped', { drained: false, worker_forced: true });
  if (mode === 'lock') emit('stopped', { drained: true });
  process.exit(0);
});
console.log('ready');
setInterval(() => {}, 1000);
`);
      return path;
    };

    async function runFake(mode: string, prepare?: (pid: number, queueName: string) => Promise<void>) {
      const home = makeHome(`fake-${mode}`);
      const queueName = `w9-fake-${mode}-${process.pid}`;
      const pidFile = join(home, 'sup.pid');
      const fake = Bun.spawn({
        cmd: [process.execPath, '--no-env-file', FAKE(home), mode, pidFile, queueName],
        env: childEnv(home), stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
      });
      const reader = (fake.stdout as ReadableStream).getReader();
      await reader.read();
      await prepare?.(fake.pid, queueName);
      const stop = spawnCli(home, ['jobs', 'supervisor', 'stop', '--json', '--pid-file', pidFile]);
      const code = await stop.proc.exited;
      const out = await stop.out();
      fake.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true });
      return { code, payload: JSON.parse(out.split('\n').find(l => l.startsWith('{"stopped"'))!) as Record<string, unknown> };
    }

    test('no `stopped` row after `shutting_down` (the pre-fix exit-143 shape)', async () => {
      const { code, payload } = await runFake('vanish');
      expect(code).toBe(1);
      expect(payload.reason).toBe('no_stopped_event');
      expect(payload.drained).toBe(false);
    }, 60_000);

    test('a forced worker stop is never reported as drained', async () => {
      const { code, payload } = await runFake('forced');
      expect(code).toBe(1);
      expect(payload.reason).toBe('forced');
    }, 60_000);

    test('a queue lock row still held by the exited supervisor', async () => {
      let lockId = '';
      try {
        const { code, payload } = await runFake('lock', async (pid, queueName) => {
          lockId = `gbrain-supervisor:${queueName}`;
          await getEngine().executeRaw(
            `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
             VALUES ($1, $2, $3, now(), now() + interval '5 minutes', now())`,
            [lockId, pid, hostname()]);
        });
        expect(code).toBe(1);
        expect(payload.reason).toBe('lock_still_held');
      } finally {
        // The fake lock row would otherwise outlive this file and fail the next E2E file that counts gbrain_cycle_locks.
        if (lockId) await getEngine().executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [lockId]);
      }
    }, 60_000);
  });
});
