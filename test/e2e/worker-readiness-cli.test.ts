import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runCli } from '../helpers/cli-spawn.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeDatabase = hasDatabase() ? describe : describe.skip;

describeDatabase('worker CLI admission against Postgres', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('an incompatible selected child blocks before any waiting job is claimed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'worker-readiness-cli-'));
    const queue = new MinionQueue(getEngine());
    const queueName = `readiness-${process.pid}`;
    const job = await queue.add('shell', { cmd: 'printf readiness-fixture', cwd: home }, { queue: queueName }, { allowProtectedSubmit: true });
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres',
        database_url: process.env.DATABASE_URL,
      }));
      const child = join(home, 'incompatible-child');
      writeFileSync(child, '#!/bin/sh\nprintf \'%s\\n\' \'{"protocolVersion":999,"version":"0.1.0.0","features":[],"status":"ready"}\'\n');
      chmodSync(child, 0o700);
      const result = await runCli(['jobs', 'work', '--queue', queueName, '--job-isolation', 'process', '--allow-shell-jobs', '--health-interval', '0', '--max-rss', '0'], {
        home,
        timeoutMs: 25_000,
        env: { GBRAIN_JOB_CHILD_CLI: child },
      });
      expect(result.exitCode).toBe(16);
      expect(result.stderr).toContain('child_protocol_incompatible');
      expect(result.stderr).toContain('Repair');
      const unchanged = await queue.getJob(job.id);
      expect(unchanged?.status).toBe('waiting');
      expect(unchanged?.attempts_made).toBe(0);
      expect(unchanged?.stalled_counter).toBe(0);
      expect(unchanged?.started_at).toBeNull();
    } finally {
      await queue.removeJob(job.id);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the selected current CLI passes readiness and completes a harmless isolated job', async () => {
    const home = mkdtempSync(join(tmpdir(), 'worker-ready-cli-'));
    const queue = new MinionQueue(getEngine());
    const queueName = `ready-${process.pid}`;
    const job = await queue.add('shell', { cmd: 'printf ready-fixture', cwd: home }, { queue: queueName }, { allowProtectedSubmit: true });
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'postgres', database_url: process.env.DATABASE_URL,
    }));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_JOB_CHILD_CLI', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
    const child = Bun.spawn({
      cmd: [process.execPath, '--no-env-file', resolve(import.meta.dir, '../../src/cli.ts'), 'jobs', 'work', '--queue', queueName, '--job-isolation', 'process', '--allow-shell-jobs', '--max-rss', '0', '--health-interval', '0'],
      env,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000);
    try {
      const until = Date.now() + 15_000;
      let current = await queue.getJob(job.id);
      while (Date.now() < until && current?.status !== 'completed' && child.exitCode === null) {
        await Bun.sleep(50);
        current = await queue.getJob(job.id);
      }
      child.kill('SIGTERM');
      await child.exited;
      const diagnostic = `${await stdout}\n${await stderr}`;
      expect(current?.status, diagnostic).toBe('completed');
      expect(current?.attempts_made).toBe(0);
      expect(current?.stalled_counter).toBe(0);
      expect(current?.result?.stdout_tail).toBe('ready-fixture');
      // #5062: SIGTERM now drains through the worker's signal owner and exits
      // 0; 143 was the generic cleanup handler killing it before the drain.
      expect(child.exitCode, diagnostic).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      clearTimeout(deadline);
      await queue.removeJob(job.id);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('a legacy supervised worker without a status channel is admitted and completes a job', async () => {
    const home = mkdtempSync(join(tmpdir(), 'worker-legacy-owner-'));
    const queue = new MinionQueue(getEngine());
    const queueName = `legacy-owner-${process.pid}`;
    const job = await queue.add('shell', { cmd: 'printf legacy-owner-fixture', cwd: home }, { queue: queueName }, { allowProtectedSubmit: true });
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'postgres', database_url: process.env.DATABASE_URL,
    }));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SUPERVISED: '1' };
    for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_JOB_CHILD_CLI', 'GBRAIN_WORKER_STATUS_PATH', 'GBRAIN_WORKER_STATUS_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
    const child = Bun.spawn({
      cmd: [process.execPath, '--no-env-file', resolve(import.meta.dir, '../../src/cli.ts'), 'jobs', 'work', '--queue', queueName, '--allow-shell-jobs', '--max-rss', '0', '--health-interval', '0'],
      env,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000);
    try {
      const until = Date.now() + 15_000;
      let current = await queue.getJob(job.id);
      while (Date.now() < until && current?.status !== 'completed' && child.exitCode === null) {
        await Bun.sleep(50);
        current = await queue.getJob(job.id);
      }
      child.kill('SIGTERM');
      await child.exited;
      const diagnostic = `${await stdout}\n${await stderr}`;
      expect(diagnostic).not.toContain('could not be published');
      expect(current?.status, diagnostic).toBe('completed');
      expect(current?.result?.stdout_tail).toBe('legacy-owner-fixture');
      // #5062: SIGTERM now drains through the worker's signal owner and exits
      // 0; 143 was the generic cleanup handler killing it before the drain.
      expect(child.exitCode, diagnostic).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      clearTimeout(deadline);
      await queue.removeJob(job.id);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
