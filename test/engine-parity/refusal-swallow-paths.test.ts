/**
 * BrainEngine parity — the commands and worker paths that used to turn a refused raw-SQL read into a quiet default
 * (the refusal-swallow sites 3, 4, 5, 8, 12 and 13): remediation's report of the manual-only jobs an earlier run queued,
 * `submit_job`'s no-worker notice, the minion worker's terminal hook, the autopilot's source failure cooldown and its
 * idle check.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each path answers the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts): remediation lists every unfinished job of a manual-only name, whatever its
 *    status, by id, with no page limit (1,001 come back whole); `submit_job` emits `no_worker` with the waiting count; a
 *    worker that completes a job runs the terminal hook once with the job's final status; a source whose last cycle
 *    succeeded after its failure is not in cooldown and one with no success is; the idle check counts queued jobs.
 *  - Regression: the raw reads were refused on a Rust brain and dropped (`.catch(() => [])`, a bare catch), so the
 *    notice never came, the hook never ran, the cooldown guard and the idle check answered without looking, and
 *    remediation reported nothing queued; a typed read capped at one page would also have lost job 1,001.
 *  - Why existing coverage misses it: test/remediation-manual-only.test.ts, test/queue-no-worker.test.ts,
 *    test/minions/terminal-hook.test.ts and test/autopilot-failure-cooldown.test.ts run PGLite only, where the raw reads
 *    never fail, and nothing compares the engines on one command.
 *  - Seam: none. Real engines and the real commands; the only SQL is inside the members under test. GBRAIN_HOME is a temp
 *    directory (no worker registry, so `submit_job` sees no worker). Hook output is read from a temp file.
 *    Sites proven unreachable on Rust (1, 2, 6, 9) and the refusal cases stay unit tests in test/refusal-swallow-*.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { terminalHookNotifier } from '../../src/core/minions/terminal-hook.ts';
import { runRemediation } from '../../src/core/remediation/index.ts';
import { makeRemediationStep } from '../../src/core/remediation-step.ts';
import { computeAutopilotIdle } from '../../src/commands/autopilot.ts';
import { isSourceInCooldown } from '../../src/commands/autopilot-fanout.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const PACK_DATA = { target_pack: 'example-pack', apply: true };
const packStep = () => makeRemediationStep({ id: 'onboard.pack_upgrade_example', job: 'unify-types', params: PACK_DATA,
  severity: 'medium', est_seconds: 5, est_usd_cost: 0, rationale: 'synthetic onboard-check extra', protected: true });

/** `unify-types` jobs are protected; the submission says so, as `gbrain jobs submit` does. */
const addManual = (queue: MinionQueue, opts: Record<string, unknown> = {}) =>
  queue.add('unify-types', PACK_DATA, { queue: 'default', ...opts }, { allowProtectedSubmit: true });

async function remediate(engine: BrainEngine) {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [packStep()] });
  } finally { process.stderr.write = write; }
}

describe('engine parity: refusal-swallow paths', () => {
  parityTest('remediation names every unfinished manual-only job an earlier run queued, whatever its status, by id',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'pauseJob', 'cancelJobs', 'listUnfinishedJobsByName'] }, async (engine) => {
      const queue = new MinionQueue(engine);
      const done = await addManual(queue);
      const claimed = await queue.claim('parity:done', 60_000, 'default', ['unify-types']);
      await engine.completeJob(done.id, claimed!.lock_token!);
      const cancelled = await addManual(queue);
      await engine.cancelJobs([cancelled.id]);
      const running = await addManual(queue);
      await queue.claim('parity:running', 60_000, 'default', ['unify-types']);
      const delayed = await addManual(queue, { delay: 3_600_000 });
      const paused = await addManual(queue);
      await engine.pauseJob(paused.id);
      const waiting = await addManual(queue);
      await queue.add('extract-ner', {}, { queue: 'default' });
      const result = await remediate(engine);
      const first = done.id;
      const queued = result.manual_only_skipped?.[0]?.queued_jobs ?? [];
      expect(queued.map((q) => q.id)).toEqual([running.id, delayed.id, paused.id, waiting.id]);
      return {
        skipped: result.manual_only_skipped?.map((m) => m.id), submitted: result.submitted.length,
        queued: queued.map((q) => ({ id: q.id - first, status: q.status })), cancelledOut: !queued.some((q) => q.id === cancelled.id),
      };
    });

  parityTest('remediation reports all 1,001 queued manual-only jobs, not a page of 1,000',
    { methods: ['admitJob', 'listUnfinishedJobsByName'], timeout: 180_000 }, async (engine) => {
      const queue = new MinionQueue(engine);
      const first = (await addManual(queue, { idempotency_key: 'parity-many-0' })).id;
      for (let i = 1; i < 1001; i++) await addManual(queue, { idempotency_key: `parity-many-${i}` });
      const queued = (await remediate(engine)).manual_only_skipped?.[0]?.queued_jobs ?? [];
      return { count: queued.length, ordered: queued.every((q, i) => i === 0 || queued[i - 1]!.id < q.id), first: queued[0]!.id - first, last: queued[1000]!.id - first };
    });

  parityTest('submit_job says no worker is running, with the waiting count',
    { methods: ['admitJob', 'countJobsByStatus'] }, async (engine) => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-no-worker-'));
      try {
        const notices: Notice[] = [];
        const ctx = { engine, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext;
        const submit = () => withEnv({ GBRAIN_HOME: home }, () => operationsByName.submit_job!.handler(ctx, { name: 'lint', data: {} }));
        await submit();
        await submit();
        return notices.filter((n) => n.code === 'no_worker').map((n) => /^(\d+) job\(s\) are waiting/.exec(n.why ?? '')?.[1] ?? null);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

  parityTest('the terminal hook runs once for a job the worker completed, with its final status',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'getJob'], timeout: 60_000 }, async (engine) => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-parity-hook-'));
      try {
        const script = join(dir, 'hook.sh');
        writeFileSync(script, '#!/bin/sh\nprintf "%s|%s\\n" "$GBRAIN_JOB_NAME" "$GBRAIN_JOB_STATUS" >> "$1/runs.txt"\n', { mode: 0o755 });
        const queue = new MinionQueue(engine);
        const job = await queue.add('hook-ok', { n: 1 });
        const notifier = terminalHookNotifier(engine, { argv: ['/bin/sh', script, dir], timeout_ms: 5_000 });
        const worker = new MinionWorker(engine, { pollInterval: 50, healthCheckInterval: 0, onJobSettled: notifier.onJobSettled });
        worker.register('hook-ok', async () => ({ fine: true }));
        const running = worker.start();
        for (let i = 0; i < 200 && (await queue.getJob(job.id))?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
        worker.stop();
        await running;
        await notifier.drain();
        return readFileSync(join(dir, 'runs.txt'), 'utf8').trim().split('\n');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  parityTest('the source failure cooldown: a success after the last failure ends it, a source with none stays in it',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'getSource', 'listRecentSourceCycleFailures'] }, async (engine, backend) => {
      const queue = new MinionQueue(engine);
      await createSource(engine, backend, 'cool-ok', { last_source_cycle_at: new Date(Date.now() + 3_600_000).toISOString() });
      await createSource(engine, backend, 'cool-bad', {});
      for (const source of ['cool-ok', 'cool-bad']) {
        const job = await queue.add('autopilot-cycle', { source_id: source }, { queue: 'default' });
        const claimed = await queue.claim(`parity:${source}`, 60_000, 'default', ['autopilot-cycle']);
        expect(claimed?.id).toBe(job.id);
        await engine.failJob(job.id, claimed!.lock_token!, 'boom', 'dead');
      }
      return {
        recovered: await isSourceInCooldown(engine, 'cool-ok'),
        cooling: await isSourceInCooldown(engine, 'cool-bad'),
        unknown: await isSourceInCooldown(engine, 'no-such-source'),
      };
    });

  parityTest('the autopilot idle check counts queued jobs: idle on an empty queue, busy with a waiting one',
    { methods: ['admitJob', 'countJobsByStatus', 'readCycleLocks'] }, async (engine) => {
      const empty = await computeAutopilotIdle(engine, 'postgres');
      await new MinionQueue(engine).add('lint', {}, { queue: 'default' });
      return { empty, busy: await computeAutopilotIdle(engine, 'postgres') };
    });
});
