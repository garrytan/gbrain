/**
 * BrainEngine parity — the callers of the typed backup and readiness reads, not the members alone:
 * computeBackupCoverage (backup/coverage.ts brainMaturity + countLivePages, through readBrainMaturity and
 * countBrainLivePages) and the readiness worker and sync probes (readiness.ts workerProbe + syncProbe, through
 * countWaitingJobs and countRepoBoundSources). Three arms, each checked against its own named expectation:
 * PGLite always, Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts (GBRAIN_TEST_RUST_ARM=1).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain whose two pages live only in the database, backup coverage counts both pages. PGLite and
 *    Rust report them at risk (no_remote, pages_at_risk 2) with a maturity of 2 items; Postgres reports the database
 *    as info (pages_at_risk 0, no maturity), because its placement may already be backed up. The worker probe reads
 *    ok (no jobs waiting) and the sync probe reads ok with the one source bound to a local checkout, on every arm.
 *  - Regression: a caller that reads through raw SQL a Rust brain refuses tells the user a Rust brain has no pages at
 *    risk (pages_at_risk 0, no maturity) and that its worker and sync are unknown (probe_failed). That was the
 *    behavior before the typed members (dce5ed58a8); this file fails there on the Rust arm.
 *  - Why existing coverage misses it: test/engine-parity/*.test.ts pin the members, and test/backup-*.test.ts and
 *    test/readiness*.test.ts drive the callers on PGLite or Postgres only; nothing drove the callers on a Rust brain.
 *  - Contract (worker fix): with one job waiting and no worker, PGLite's fix runs `gbrain jobs work`; Postgres and Rust
 *    start the supervisor, whose why text says "this Postgres brain" on Postgres and "this brain" on Rust.
 *  - Regression (worker fix): before the Rust wording, a Rust brain read "this Postgres brain"; that case fails there.
 *  - Seam: none. Real engines and real callers; GBRAIN_HOME points at an empty directory so no bootstrap receipt,
 *    harness skill dir or job worker registry leaks in, and backup git probes are off.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { computeBackupCoverage } from '../../src/core/backup/coverage.ts';
import { createReadinessCache, probedReadiness } from '../../src/core/readiness.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Note', compiled_truth: 'A note.', timeline: '' };

/** Run `fn` with GBRAIN_HOME on an empty directory of its own. */
async function inEmptyHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'parity-callers-home-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** What each arm must report for a brain whose two pages live only in the database. */
interface CoverageSeen { degraded: boolean; pages_at_risk: number; db_content: string | null; maturity_items: number | null; maturity_since: boolean }
const COVERAGE: Record<ParityBackend, CoverageSeen> = {
  pglite: { degraded: false, pages_at_risk: 2, db_content: 'no_remote', maturity_items: 2, maturity_since: true },
  rust: { degraded: false, pages_at_risk: 2, db_content: 'no_remote', maturity_items: 2, maturity_since: true },
  postgres: { degraded: false, pages_at_risk: 0, db_content: 'info', maturity_items: null, maturity_since: false },
};

/** What each arm's worker and sync probes must report with no jobs and one source bound to a local checkout. */
interface ProbeSeen { capability: string; state: string; reason: string; why?: string }
const PROBES: Record<ParityBackend, ProbeSeen[]> = {
  pglite: [{ capability: 'worker', state: 'ok', reason: 'no_pending_jobs' }, { capability: 'sync', state: 'ok', reason: 'git_sources', why: '1 source(s) are bound to local repositories that `gbrain sync` reads.' }],
  rust: [{ capability: 'worker', state: 'ok', reason: 'no_pending_jobs' }, { capability: 'sync', state: 'ok', reason: 'git_sources', why: '1 source(s) are bound to local repositories that `gbrain sync` reads.' }],
  postgres: [{ capability: 'worker', state: 'ok', reason: 'no_pending_jobs' }, { capability: 'sync', state: 'ok', reason: 'git_sources', why: '1 source(s) are bound to local repositories that `gbrain sync` reads.' }],
};

/** One waiting job, as the queue inserts it. */
function waitingJob(name: string): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null,
  };
}

/**
 * What each arm's worker probe must report with one job waiting and no worker. PGLite runs the job in this process;
 * Postgres and Rust start the supervisor. The why text names "this Postgres brain" on Postgres only (byte-identical to
 * before) and "this brain" on Rust.
 */
interface WorkerFixSeen { state: string | null; reason: string | null; why: string | null; fix_argv: string[] | null; fix_why: string | null }
const SUPERVISOR = ['gbrain', 'jobs', 'supervisor', 'start'];
const WORKER_FIX: Record<ParityBackend, WorkerFixSeen> = {
  pglite: { state: 'missing', reason: 'no_worker',
    why: '1 job(s) are waiting and no worker is running (PGLite has no background worker; jobs run with --follow or while a worker holds the brain).',
    fix_argv: ['gbrain', 'jobs', 'work'], fix_why: 'Runs the waiting jobs in this process; stop it once the queue drains.' },
  postgres: { state: 'missing', reason: 'no_worker', why: '1 job(s) are waiting and no worker is running.',
    fix_argv: SUPERVISOR, fix_why: 'Starts the job supervisor, which keeps a worker running for this Postgres brain.' },
  rust: { state: 'missing', reason: 'no_worker', why: '1 job(s) are waiting and no worker is running.',
    fix_argv: SUPERVISOR, fix_why: 'Starts the job supervisor, which keeps a worker running for this brain.' },
};

describe('engine parity: backup coverage and readiness probes, driven through their callers', () => {
  parityTest('computeBackupCoverage counts the pages a database-only brain holds, with the arm\'s placement verdict',
    { methods: ['countBrainLivePages', 'readBrainMaturity'] },
    async (engine: BrainEngine, backend) => {
      await engine.putPage('notes/one', NOTE);
      await engine.putPage('notes/two', NOTE);
      const status = await inEmptyHome(() => computeBackupCoverage(engine, { localGitProbes: false }));
      const db = status.assets.find(a => a.kind === 'db_content');
      const observed: CoverageSeen = {
        degraded: status.degraded === true, pages_at_risk: status.totals.pages_at_risk, db_content: db?.state ?? null,
        maturity_items: status.maturity?.items ?? null, maturity_since: typeof status.maturity?.since === 'string',
      };
      expect({ arm: backend, observed }).toEqual({ arm: backend, observed: COVERAGE[backend] });
      // Postgres differs by design (see COVERAGE) and never asks for the maturity; the arms agree on what both reads hold.
      const maturity = await engine.readBrainMaturity();
      return { pages_counted: await engine.countBrainLivePages(), maturity_pages: Number(maturity?.pages), maturity_facts: Number(maturity?.facts) };
    });

  parityTest('the readiness worker and sync probes read the queue and the bound sources, not probe_failed',
    { methods: ['countWaitingJobs', 'countRepoBoundSources'] },
    async (engine: BrainEngine, backend) => {
      const repo = mkdtempSync(join(tmpdir(), 'parity-callers-repo-'));
      try {
        execFileSync('git', ['init', '-q', repo]);
        await createSource(engine, backend, 'bound', {}, repo);
        await createSource(engine, backend, 'unbound', {});
        const entries = await inEmptyHome(() => probedReadiness(engine, { cache: createReadinessCache() }));
        const observed: ProbeSeen[] = entries.filter(e => e.capability === 'worker' || e.capability === 'sync')
          .map(e => ({ capability: e.capability, state: e.state, reason: e.reason, ...(e.capability === 'sync' ? { why: e.why } : {}) }));
        expect({ arm: backend, observed }).toEqual({ arm: backend, observed: PROBES[backend] });
        return observed;
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });

  parityTest('the readiness worker fix names the job supervisor, in the arm\'s own words, when a job waits and no worker runs',
    { methods: ['admitJob', 'countWaitingJobs'] },
    async (engine: BrainEngine, backend) => {
      await engine.admitJob({ maxSpawnDepth: 5, insert: waitingJob('work') }, {
        decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
        parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
      });
      const entries = await inEmptyHome(() => probedReadiness(engine, { cache: createReadinessCache() }));
      const worker = entries.find(e => e.capability === 'worker');
      const observed: WorkerFixSeen = { state: worker?.state ?? null, reason: worker?.reason ?? null, why: worker?.why ?? null,
        fix_argv: worker?.fix?.argv ?? null, fix_why: worker?.fix?.why ?? null };
      expect({ arm: backend, observed }).toEqual({ arm: backend, observed: WORKER_FIX[backend] });
      // The words differ by design (see WORKER_FIX); the arms agree on the state and the waiting count.
      return { state: observed.state, reason: observed.reason, waiting: await engine.countWaitingJobs(false) };
    });
});
