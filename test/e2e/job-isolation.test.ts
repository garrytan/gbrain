/**
 * issue #5 — process isolation against REAL Postgres (DATABASE_URL-gated;
 * wired into .github/workflows/e2e.yml tier1 — e2e.yml runs only explicitly
 * NAMED files, so an unwired e2e file is silent coverage loss).
 *
 * Legs:
 *   1. Worker-level concurrency (codex-2 #6): a real MinionWorker with
 *      isolation on drains 6 jobs at concurrency 3 through real child
 *      processes against the real pooler/DB — the child-pool topology the
 *      per-process pool math describes.
 *   2. Real CLI entrypoint: `bun src/cli.ts jobs run-child` with the env
 *      contract against a genuinely claimed job — proves engine bootstrap,
 *      handler registry (quiet), token validation, and the outcome protocol
 *      end-to-end. Uses the real 'orphans' handler (cheap on a fresh DB).
 *   3. Stuck-child kill: a SIGTERM-ignoring child is group-SIGKILLed and the
 *      worker keeps claiming.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { decodeChildOutcomeFile, CHILD_ENV } from '../../src/core/minions/job-isolation.ts';
import { withEnv } from '../helpers/with-env.ts';

const FIXTURE = resolve(import.meta.dir, '..', 'fixtures', 'fake-run-child.mjs');
const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');

const describeDb = hasDatabase() ? describe : describe.skip;

let queue: MinionQueue;
let tmp: string;

beforeAll(async () => {
  if (!hasDatabase()) return;
  await setupDB();
  queue = new MinionQueue(getEngine());
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-e2e-isolation-'));
});

afterAll(async () => {
  if (!hasDatabase()) return;
  await teardownDB();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function rowStatus(id: number): Promise<string> {
  const rows = await getEngine().executeRaw<{ status: string }>(
    'SELECT status FROM minion_jobs WHERE id = $1',
    [id],
  );
  return rows[0]?.status ?? 'missing';
}

describeDb('process isolation on real Postgres', () => {
  test('concurrency 3: six isolated jobs drain through real children', async () => {
    await withEnv({ FAKE_RUN_CHILD_MODE: 'success' }, async () => {
      const jobs = [];
      for (let i = 0; i < 6; i++) jobs.push(await queue.add('isotest', { i }));

      const worker = new MinionWorker(getEngine(), {
        queue: 'default',
        concurrency: 3,
        pollInterval: 50,
        healthCheckInterval: 0,
        maxRssMb: 0,
        jobIsolation: 'process',
        childCliInvocation: { cmd: process.execPath, argsPrefix: [FIXTURE] },
      });
      worker.register('isotest', async () => {
        throw new Error('parent handler must not run when isolated');
      });

      const run = worker.start();
      const deadline = Date.now() + 30_000;
      try {
        while (Date.now() < deadline) {
          const statuses = await Promise.all(jobs.map((j) => rowStatus(j.id)));
          if (statuses.every((s) => s === 'completed')) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        worker.stop();
        await run;
      }
      const statuses = await Promise.all(jobs.map((j) => rowStatus(j.id)));
      expect(statuses).toEqual(['completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
    });
  }, 60_000);

  test('real CLI run-child: engine bootstrap + protocol end-to-end', async () => {
    const job = await queue.add('orphans', {});
    const claimed = await queue.claim('e2e-cli-tok', 60_000, 'default', ['orphans']);
    expect(claimed?.id).toBe(job.id);

    const resultPath = join(tmp, `cli-${job.id}.json`);
    const res = spawnSync(
      process.execPath,
      [CLI, 'jobs', 'run-child', '--job-id', String(job.id)],
      {
        env: {
          ...process.env,
          GBRAIN_DATABASE_URL: process.env.DATABASE_URL,
          GBRAIN_TEST_ALLOW_DATABASE_URL: '1',
          [CHILD_ENV.lockToken]: 'e2e-cli-tok',
          [CHILD_ENV.resultPath]: resultPath,
          [CHILD_ENV.parentPid]: String(process.pid),
        },
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (res.status !== 0) {
      throw new Error(
        `run-child exited ${res.status}: ${String(res.stderr)}\n${String(res.stdout)}`,
      );
    }
    expect(existsSync(resultPath)).toBe(true);
    const outcome = decodeChildOutcomeFile(resultPath);
    // The protocol completed; the real handler's own verdict (success or a
    // reported error on a bare DB) is out of scope for this leg.
    expect(outcome.outcome === 'success' || outcome.outcome === 'error').toBe(true);
  }, 90_000);

  // The stuck-child group-SIGKILL path is pinned with REAL processes in
  // test/child-job-runner.test.ts (SIGTERM-ignorer → SIGKILL at grace) and
  // the crash/burn semantics in test/worker-job-isolation.test.ts — this
  // lane deliberately doesn't duplicate them against the shared CI DB.
});
