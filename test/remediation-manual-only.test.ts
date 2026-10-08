/**
 * Manual-only remediation steps are never submitted by an automatic run (#6248).
 *
 * Protects: `runRemediation` (behind `gbrain onboard --auto`, `doctor
 * --remediate` and MCP `run_onboard`) skips every manual-only step
 * (`unify-types`, `extract-takes-from-pages`, decided by job name) and returns
 * it as `manual_only_skipped` with the user's own command, keeps its cost out
 * of the --max-usd estimate, and reports a job of that kind an earlier run
 * already queued instead of claiming the skip prevented it. The onboard
 * renderer labels by the same predicate, and autopilot's targeted dispatch
 * filters it too.
 * Fails when: the runner submits a manual-only step (initially or after the
 * per-step recheck), trusts `protected` instead of the job name, refuses free
 * steps because of a manual-only step's cost, or the fix/queued report drifts.
 * Seams: none; real remediation with inline jobs on PGLite (the queued-job
 * report also on Postgres, via test/postgres-unit-arms.txt). The onboard and MCP cases run
 * a background worker with stub handlers so a regression completes instead of
 * waiting out the step timeout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRemediation } from '../src/core/remediation/index.ts';
import { makeRemediationStep } from '../src/core/remediation-step.ts';
import { toOnboardRecommendation } from '../src/core/onboard/render.ts';
import { autopilotTargetedSteps } from '../src/commands/autopilot-remediation-policy.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runOnboard } from '../src/commands/onboard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

function step(id: string, job: string, opts: { params?: Record<string, unknown>; usd?: number; protected?: boolean } = {}) {
  return makeRemediationStep({
    id, job, params: opts.params ?? {}, severity: 'medium', est_seconds: 5, est_usd_cost: opts.usd ?? 0,
    rationale: 'synthetic onboard-check extra', ...(opts.protected === undefined ? {} : { protected: opts.protected }),
  });
}

const PACK = () => step('onboard.pack_upgrade_example', 'unify-types', { params: { target_pack: 'example-pack', apply: true }, protected: true });
const TAKES = () => step('onboard.takes_bootstrap', 'extract-takes-from-pages', { usd: 5, protected: true });

async function jobNames(): Promise<string[]> {
  const rows = await engine.executeRaw<{ name: string }>('SELECT name FROM minion_jobs ORDER BY id');
  return rows.map((r) => r.name);
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await fn(); } finally { process.stderr.write = write; }
}

describe('runRemediation never submits a manual-only step', () => {
  test('auto steps run across the per-step recheck; manual-only steps are skipped and reported', async () => {
    const result = await quiet(() => runRemediation(engine, {
      targetScore: 0, inlineJobs: true, maxJobs: 6,
      extraRemediations: [step('onboard.extract_ner', 'extract-ner'), PACK(), TAKES(), step('onboard.extract_timeline', 'extract-timeline-from-meetings')],
    }));
    expect(result.submitted.map((s) => s.id).sort()).toEqual(['onboard.extract_ner', 'onboard.extract_timeline']);
    expect((await jobNames()).sort()).toEqual(['extract-ner', 'extract-timeline-from-meetings']);
    expect(result.manual_only_skipped?.map((m) => m.id)).toEqual(['onboard.pack_upgrade_example', 'onboard.takes_bootstrap']);
  });

  test('a manual-only job without protected:true is still skipped (decided by job name)', async () => {
    const unflagged = step('onboard.pack_upgrade_unflagged', 'unify-types', { params: { target_pack: 'example-pack', apply: true }, protected: false });
    const result = await quiet(() => runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [unflagged] }));
    expect(result.submitted).toEqual([]);
    expect(await jobNames()).toEqual([]);
    expect(result.manual_only_skipped?.map((m) => m.id)).toEqual(['onboard.pack_upgrade_unflagged']);
    expect(toOnboardRecommendation(unflagged).apply_policy).toBe('manual_only');
  });

  test('a $1 cap still runs the free steps beside a $5 manual-only step', async () => {
    let refused = false;
    const result = await quiet(() => runRemediation(engine,
      { targetScore: 0, inlineJobs: true, maxUsd: 1, extraRemediations: [step('onboard.extract_ner', 'extract-ner'), TAKES()] },
      { onBudgetRefused: () => { refused = true; } }));
    expect(refused).toBe(false);
    expect(result.budget_exhausted).toBeUndefined();
    expect(result.submitted.map((s) => [s.id, s.status])).toEqual([['onboard.extract_ner', 'completed']]);
    expect(await jobNames()).toEqual(['extract-ner']);
    expect(result.manual_only_skipped?.map((m) => m.id)).toEqual(['onboard.takes_bootstrap']);
  });

  test('each skipped step carries the user\'s own command, paid consent when it costs money', async () => {
    const result = await quiet(() => runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [PACK(), TAKES()] }));
    const [pack, takes] = result.manual_only_skipped!;
    expect(pack).toMatchObject({
      code: 'manual_only_skipped', id: 'onboard.pack_upgrade_example', job: 'unify-types', params: { target_pack: 'example-pack', apply: true },
      fix: {
        argv: ['gbrain', 'jobs', 'submit', 'unify-types', '--params', '{"target_pack":"example-pack","apply":true}', '--follow'],
        consent: [], actor: 'user', next: 'tell_user_to_run', verify: { argv: ['gbrain', 'doctor', '--only', 'brain_score', '--json'] },
      },
    });
    expect(takes).toMatchObject({
      code: 'manual_only_skipped', job: 'extract-takes-from-pages', est_usd_cost: 5,
      fix: { argv: ['gbrain', 'jobs', 'submit', 'extract-takes-from-pages', '--follow'], consent: ['paid'], actor: 'user', next: 'tell_user_to_run' },
    });
    expect(takes!.fix.command).toBe('gbrain jobs submit extract-takes-from-pages --follow');
    expect(pack!.queued_jobs).toBeUndefined();
    expect(await jobNames()).toEqual([]);
  });

  test('a unify-types job an earlier run queued is reported as still queued, not as prevented', async () => {
    const queued = await new MinionQueue(engine).add('unify-types', { target_pack: 'example-pack', apply: true },
      { queue: 'default', idempotency_key: 'earlier-run' }, { allowProtectedSubmit: true });
    const result = await quiet(() => runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [PACK()] }));
    const [pack] = result.manual_only_skipped!;
    expect(pack!.queued_jobs).toEqual([{ id: queued.id, status: 'waiting' }]);
    expect(pack!.why).toContain(`#${queued.id} waiting`);
    expect(pack!.why).toContain('gbrain jobs cancel <id>');
    const rows = await engine.executeRaw<{ id: number; status: string }>('SELECT id, status FROM minion_jobs');
    expect(rows.map((r) => [Number(r.id), r.status])).toEqual([[queued.id, 'waiting']]);
  });

  test("doctor --remediate's runner options (repairs planned, inline jobs) skip it too", async () => {
    const result = await quiet(() => runRemediation(engine, {
      targetScore: 0, inlineJobs: true, repairs: { include: false, remote: false, registry: [] },
      extraRemediations: [step('onboard.extract_ner', 'extract-ner'), PACK()],
    }));
    expect(result.submitted.map((s) => s.id)).toEqual(['onboard.extract_ner']);
    expect(await jobNames()).toEqual(['extract-ner']);
    expect(result.manual_only_skipped?.map((m) => m.id)).toEqual(['onboard.pack_upgrade_example']);
  });

  test('a dry run lists manual-only steps as skipped, never as would-run', async () => {
    const result = await runRemediation(engine, { targetScore: 0, dryRun: true, extraRemediations: [step('onboard.extract_ner', 'extract-ner'), TAKES()] });
    expect(result.submitted.map((s) => [s.id, s.status])).toEqual([['onboard.extract_ner', 'dry_run']]);
    expect(result.manual_only_skipped?.map((m) => m.id)).toEqual(['onboard.takes_bootstrap']);
  });
});

/**
 * A fresh brain's onboard checks emit both manual-only steps: the takes
 * bootstrap (opted in here) and the pack upgrade off the unset schema pack.
 * Stub handlers let a regression that submits them complete instead of
 * waiting out their step timeout.
 */
async function withStubWorker<T>(fn: () => Promise<T>): Promise<T> {
  await engine.setConfig('takes.bootstrap_enabled', 'true');
  const worker = new MinionWorker(engine, { queue: 'default', pollInterval: 50, healthCheckInterval: 0 });
  worker.register('extract-takes-from-pages', async () => ({ stub: true }));
  worker.register('unify-types', async () => ({ stub: true }));
  const running = worker.start();
  try { return await quiet(fn); } finally {
    worker.stop();
    await running;
  }
}

async function onboardStdout(args: string[]): Promise<string> {
  let out = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try { await withStubWorker(() => runOnboard(engine, args)); } finally { process.stdout.write = write; }
  return out;
}

describe('gbrain onboard --auto', () => {
  test('--json: the document lists the skipped pack upgrade and takes bootstrap and nothing else lands on stdout', async () => {
    const doc = JSON.parse(await onboardStdout(['--auto', '--max-usd', '10', '--target-score', '0', '--json'])) as {
      submitted: unknown[]; manual_only_skipped?: Array<{ job: string; fix: { next: string; command: string } }>;
    };
    expect(doc.submitted).toEqual([]);
    expect(doc.manual_only_skipped?.map((m) => [m.job, m.fix.next]).sort()).toEqual([
      ['extract-takes-from-pages', 'tell_user_to_run'], ['unify-types', 'tell_user_to_run']]);
    expect(await jobNames()).toEqual([]);
  });

  test('human output names each skipped step with its command', async () => {
    const out = await onboardStdout(['--auto', '--max-usd', '10', '--target-score', '0']);
    expect(out).toContain('Not run: 2 manual-only step(s).');
    expect(out).toContain('  - extract-takes-from-pages (~$5.00): gbrain jobs submit extract-takes-from-pages --follow');
    expect(out).toMatch(/  - unify-types: gbrain jobs submit unify-types --params '\{"target_pack":"[^"]+","apply":true\}' --follow/);
    expect(await jobNames()).toEqual([]);
  });
});

describe('MCP run_onboard with run_protected_onboard scope', () => {
  test('never submits the takes bootstrap the onboard checks emit', async () => {
    const run_onboard = operations.find((o) => o.name === 'run_onboard')!;
    const ctx = { engine, config: {} as never, logger: console as never, dryRun: false, remote: true,
      auth: { scopes: ['admin', 'run_protected_onboard'] } as never } as unknown as OperationContext;
    const result = await withStubWorker(() => run_onboard.handler(ctx, { mode: 'auto', max_usd: 10, target_score: 0 })) as {
      manual_only_skipped?: Array<{ job: string }>; skipped_missing_scope: unknown[];
    };
    expect(result.skipped_missing_scope).toEqual([]);
    expect(result.manual_only_skipped?.map((m) => m.job)).toContain('extract-takes-from-pages');
    expect(await jobNames()).not.toContain('extract-takes-from-pages');
  });
});

describe('autopilot targeted dispatch', () => {
  test('filters manual-only steps out of the targeted submit list', () => {
    const auto = step('extract.stale', 'extract');
    expect(autopilotTargetedSteps([auto, PACK(), TAKES()])).toEqual([auto]);
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`${backend}: queued manual-only jobs`, () => {
    let db: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine: db, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });

    test('a dry run names the waiting unify-types row and leaves it queued', async () => {
      const queued = await new MinionQueue(db).add('unify-types', { target_pack: 'example-pack', apply: true },
        { queue: 'default', idempotency_key: `earlier-run-${backend}` }, { allowProtectedSubmit: true });
      const result = await runRemediation(db, { targetScore: 0, dryRun: true, extraRemediations: [PACK()] });
      expect(result.submitted).toEqual([]);
      expect(result.manual_only_skipped?.[0]?.queued_jobs).toEqual([{ id: queued.id, status: 'waiting' }]);
      const rows = await db.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [queued.id]);
      expect(rows.map((r) => r.status)).toEqual(['waiting']);
    });
  });
}
