/**
 * BrainEngine parity: the queue reads the doctor checks and the dream breaker make (engine-sql/jobs-checks.ts): stalled
 * embed-backfill sources, how the brain-wide maintenance job and its dream children died, the last failed maintenance
 * job, facts-absorb jobs still dead, the legacy job authority population, the queued spend census, build-skew
 * stacktrace lines, the dead dream submission count, and the dead facts-absorb retry reads.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read returns the same rows on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts): which status, name, key and progress shape a read selects, the
 *    order of what it returns, how its window, limit and prefix arguments cut it, and what it counts.
 *  - Regression: an engine that drifts on the `progress ? 'stall'` test (an object key or an array element), the last-N-deaths rule (the phase keyed by a released idempotency key, the all-must-be-timeout-deaths
 *    rule, the exact-count rule), the `since` cut of the last failed job and its whole-set count, the supersede rule of
 *    a still-dead facts-absorb job (same slug and source, a larger id, completed), the claim gate's population, the
 *    spend basis of a queued row (a recorded kind, a legacy prefix of the right name, or unrecorded) and its byte order,
 *    the build-skew LIKE prefix (`_` is a wildcard, as in the original doctor read), the breaker's three counting branches with their resets and window, or the retry's
 *    key prefix and key set. Each of these decides what an operator is told or whether a paid job loop is stopped.
 *  - Why existing coverage misses it: test/doctor*.test.ts and test/dream-breaker*.test.ts run these checks on PGLite
 *    only, and a Rust engine has no raw SQL, so nothing compared the engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Row states come from the queue's own writes
 *    (claim, fail, cancel, progress, tokens); a window is exercised by a zero-hour or far-future argument, never by
 *    waiting out a clock. Cases that need a row the queue refuses to create (SQL NULL authority, an old finish time, a
 *    NULL error text) are covered by rust/crates/gbrain-store/tests/jobs_checks.rs and the check unit tests instead.
 *    Ids are compared relative to the case's first job, and timestamps are compared as the instant they name.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { LEGACY_SPEND_KEY_PREFIXES } from '../../src/core/minions/spend-authorization.ts';
import { FENCE_REPAIR_ENABLED_KEY, FENCE_REPAIR_LLM_KEY } from '../../src/core/fence-repair/config.ts';
import { LAST_GLOBAL_MAINTENANCE_KEY, readFenceAutoRepair } from '../../src/core/fence-repair/hold-fix.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OTHER_AUTHORITY = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' } } as unknown as SubmissionAuthority;
const FUTURE_AUTHORITY = { version: 99, kind: 'from_the_future' } as unknown as SubmissionAuthority;
const FAR = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function values(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

function policy(): AdmitJobPolicy {
  return {
    decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  };
}

function admit(engine: BrainEngine, spec: Partial<AdmitJobSpec> & { insert: JobInsertValues }) {
  return engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy());
}

/** A new job. Submissions are 2 ms apart so created_at never ties. */
/** The two live statuses `JobInsertValues` does not name; the insert stores them as given on both engines. */
const PAUSED = 'paused' as 'waiting';
const WAITING_CHILDREN = 'waiting-children' as 'waiting';

/** The jobs a case made on each engine, in order, for naming a finish time by the job that finished then. */
const made = new WeakMap<BrainEngine, number[]>();

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, { insert: values(name, extra) });
  expect(out.coalesced).toBe(false);
  await Bun.sleep(2);
  const id = Number(out.row.id);
  made.set(engine, [...(made.get(engine) ?? []), id]);
  return id;
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** A new job, claimed by `token` (callers keep no other waiting job of this name, so the claim takes this row). */
async function active(engine: BrainEngine, name: string, token: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const id = await add(engine, name, extra);
  const row = await engine.claimNextJob(claimSpec(token, { names: [name], queue: extra.queue ?? 'default' }));
  expect(Number(row?.id)).toBe(id);
  return id;
}

interface EndedOpts { extra?: Partial<JobInsertValues>; error?: string; tokens?: number; progress?: unknown }

/** A new job that ended as `how`, after a claim, optional progress and optional token spend. */
async function ended(engine: BrainEngine, name: string, how: 'completed' | 'failed' | 'dead' | 'cancelled', o: EndedOpts = {}): Promise<number> {
  const token = `end:${name}`;
  const id = await active(engine, name, token, o.extra ?? {});
  if (o.progress !== undefined) expect(await engine.updateJobProgress(id, token, o.progress)).toBe(true);
  if (o.tokens) expect(await engine.addJobTokens(id, token, { input: o.tokens, output: 0, cache_read: 0 })).toBe(true);
  if (how === 'completed') await engine.completeJob(id, token);
  else if (how === 'cancelled') await engine.cancelJobs([id]);
  else await engine.failJob(id, token, o.error ?? `${how} on purpose`, how);
  return id;
}

const rels = (base: number, ids: readonly number[]) => ids.map(id => id - base);
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

/**
 * The instant a `timestamptz::text` reading (`2026-01-02 03:04:05.123456+00`) names, as the jobs of the case that
 * finished then (ids relative to the case's first job). Clocks differ between engines, so a finish time is compared
 * as the job it belongs to; a reading that names no job comes back as its own text.
 */
async function finishers(engine: BrainEngine): Promise<(text: string | null) => Array<number | string> | null> {
  const ids = made.get(engine) ?? [];
  const byTime = new Map<string, number[]>();
  for (const id of ids) {
    const at = iso((await engine.getJob(id))?.finished_at);
    if (at) byTime.set(at, [...(byTime.get(at) ?? []), id - ids[0]!]);
  }
  return text => {
    if (text === null) return null;
    const at = new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
    return byTime.get(at) ?? [`unknown ${text}`];
  };
}

async function finishedAt(engine: BrainEngine, id: number): Promise<string | null> {
  return iso((await engine.getJob(id))?.finished_at);
}

describe('jobs checks parity', () => {
  parityTest('listStalledEmbedBackfillSources names each source of a failed or dead embed-backfill that carries a stall record, in byte order',
    { methods: ['admitJob', 'claimNextJob', 'updateJobProgress', 'failJob', 'completeJob', 'listStalledEmbedBackfillSources'] }, async (engine) => {
      const src = (sourceId: string | null) => ({ data: sourceId === null ? {} : { sourceId } });
      await ended(engine, 'embed-backfill', 'failed', { extra: src('src-b'), progress: { stall: { failures: 3 } } });
      await ended(engine, 'embed-backfill', 'dead', { extra: src('src-a'), progress: ['other', 'stall'] });
      await ended(engine, 'embed-backfill', 'dead', { extra: src('src-a'), progress: { stall: 1 } });
      await ended(engine, 'embed-backfill', 'dead', { extra: src('Src-z'), progress: { stall: 'yes' } });
      await ended(engine, 'embed-backfill', 'failed', { extra: src(null), progress: { stall: true } });
      // Near misses: another key, a nested key, no progress, a finished or live job, another job name.
      await ended(engine, 'embed-backfill', 'failed', { extra: src('src-c'), progress: { stalled: 1 } });
      await ended(engine, 'embed-backfill', 'failed', { extra: src('src-n'), progress: { inner: { stall: 1 } } });
      await ended(engine, 'embed-backfill', 'failed', { extra: src('src-p') });
      await ended(engine, 'embed-backfill', 'completed', { extra: src('src-d'), progress: { stall: 1 } });
      await ended(engine, 'embed', 'failed', { extra: src('src-e'), progress: { stall: 1 } });
      await add(engine, 'embed-backfill', src('src-w'));
      return await engine.listStalledEmbedBackfillSources();
    });

  parityTest('readGlobalMaintenanceDeaths reads the last N maintenance jobs and the dream phases whose last N children all died at their timeout',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'getJob', 'readGlobalMaintenanceDeaths'] }, async (engine) => {
      const keyed = (idempotency_key: string | null, released?: string) => ({ idempotency_key, data: released ? { __released_idempotency_key: released } : {} });
      const gm = 'autopilot-global-maintenance';
      const g = [
        await ended(engine, gm, 'completed'),
        await ended(engine, gm, 'dead', { error: 'timeout exceeded' }),
        await ended(engine, gm, 'failed', { error: 'boom' }),
        await ended(engine, gm, 'dead', { error: 'job timeout exceeded after 3600s' }),
        await ended(engine, gm, 'cancelled'),
        await ended(engine, gm, 'dead', { error: 'timeout exceeded' }),
      ];
      await ended(engine, 'minion-other', 'dead', { error: 'timeout exceeded' });
      // Patterns children, oldest first: completed, then three timeout deaths (the newest holds only a released key).
      const p = [
        await ended(engine, 'subagent', 'completed', { extra: keyed('dream:patterns:source:a:1') }),
        await ended(engine, 'subagent', 'dead', { extra: keyed('dream:patterns:source:a:2'), error: 'subagent timeout exceeded after 60s' }),
        await ended(engine, 'subagent', 'dead', { extra: keyed('dream:patterns:source:b:3'), error: 'timeout exceeded' }),
        await ended(engine, 'subagent', 'dead', { extra: keyed(null, 'dream:patterns:source:b:4'), error: 'timeout exceeded' }),
      ];
      // Synthesize children, oldest first: a timeout death, a failure, a death whose text differs in case, a timeout death.
      const s = [
        await ended(engine, 'subagent', 'dead', { extra: keyed('dream:synth-v2:one'), error: 'timeout exceeded' }),
        await ended(engine, 'subagent', 'failed', { extra: keyed('dream:synthetic:two'), error: 'boom' }),
        await ended(engine, 'subagent', 'dead', { extra: keyed('dream:synth-v2:@file:x:three'), error: 'Timeout Exceeded' }),
        await ended(engine, 'subagent', 'dead', { extra: keyed('dream:synth-v2:four'), error: 'timeout exceeded' }),
      ];
      // Not a dream child: another family, a near-miss prefix, a live job, a job whose key is neither set nor released.
      await ended(engine, 'subagent', 'dead', { extra: keyed('dream:phase:x:1'), error: 'timeout exceeded' });
      await ended(engine, 'subagent', 'dead', { extra: keyed('xdream:patterns:1'), error: 'timeout exceeded' });
      await ended(engine, 'subagent', 'dead', { extra: keyed('dream:pattern:1'), error: 'timeout exceeded' });
      await ended(engine, 'subagent', 'dead', { extra: keyed(null), error: 'timeout exceeded' });
      await add(engine, 'subagent', keyed('dream:patterns:source:live:1'));
      const base = g[0]!;
      const who = await finishers(engine);
      const out: Record<string, unknown> = {};
      for (const deaths of [1, 2, 3, 4, 5]) {
        const read = await engine.readGlobalMaintenanceDeaths({ deaths });
        out[`deaths ${deaths}`] = {
          recent: read.recent.map(r => ({ ...r, id: r.id - base })),
          children: read.child_timeouts.map(c => ({ phase: c.phase, deaths: c.deaths, last_at: who(c.last_at) })),
        };
      }
      return { out, g: g.map(id => id - base), p: p.map(id => id - base), s: s.map(id => id - base) };
    });

  parityTest('readLastFailedGlobalMaintenanceJob returns the newest job that ended without completing after a cut, counting every such job',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'getJob', 'readLastFailedGlobalMaintenanceJob'] }, async (engine) => {
      const gm = 'autopilot-global-maintenance';
      const a = await ended(engine, gm, 'completed');
      await Bun.sleep(6);
      const b = await ended(engine, gm, 'failed', { error: 'first failure' });
      await Bun.sleep(6);
      const c = await ended(engine, gm, 'dead', { error: 'second failure' });
      await Bun.sleep(6);
      const d = await ended(engine, gm, 'cancelled');
      await Bun.sleep(6);
      await ended(engine, gm, 'completed');
      await ended(engine, 'minion-other', 'dead');
      await add(engine, gm);
      const at = async (id: number) => new Date((await finishedAt(engine, id))!).getTime();
      const who = await finishers(engine);
      const view = (r: Awaited<ReturnType<BrainEngine['readLastFailedGlobalMaintenanceJob']>>) =>
        r && { id: r.id - a, status: r.status, error_text: r.error_text, total: r.total, since: who(r.since) };
      const between = (x: number, y: number) => new Date(Math.floor((x + y) / 2)).toISOString();
      return {
        all: view(await engine.readLastFailedGlobalMaintenanceJob(null)),
        afterFirst: view(await engine.readLastFailedGlobalMaintenanceJob(between(await at(b), await at(c)))),
        afterSecond: view(await engine.readLastFailedGlobalMaintenanceJob(between(await at(c), await at(d)))),
        afterLast: view(await engine.readLastFailedGlobalMaintenanceJob(FAR)),
        sincePast: view(await engine.readLastFailedGlobalMaintenanceJob(PAST)),
        ids: [b, c, d].map(id => id - a),
      };
    });

  // fence-repair/hold-fix.ts readFenceAutoRepair: a refused read once counted as the defaults (repair on, model tier on).
  parityTest('readFenceAutoRepair reads the fence switches, the maintenance stamp and the last completed maintenance job',
    { methods: ['setConfig', 'admitJob', 'claimNextJob', 'completeJob', 'failJob', 'getConfigValues', 'readLastFinishedJobAt'] }, async (engine) => {
      const gm = 'autopilot-global-maintenance';
      const none = await readFenceAutoRepair(engine, new Date());
      await engine.setConfig(FENCE_REPAIR_ENABLED_KEY, 'off');
      await engine.setConfig(FENCE_REPAIR_LLM_KEY, ' false ');
      await engine.setConfig(LAST_GLOBAL_MAINTENANCE_KEY, PAST);
      await ended(engine, gm, 'failed'); // a job that did not complete is no evidence
      const stamped = await readFenceAutoRepair(engine, new Date());
      await ended(engine, gm, 'completed');
      await engine.setConfig(FENCE_REPAIR_ENABLED_KEY, 'true');
      const ran = await readFenceAutoRepair(engine, new Date(Date.now() + 1_000));
      expect(none).toEqual({ enabled: true, llm: true, last_maintenance_at: null, active: false });
      expect(stamped).toEqual({ enabled: false, llm: false, last_maintenance_at: PAST, active: false });
      expect({ enabled: ran.enabled, llm: ran.llm, active: ran.active }).toEqual({ enabled: true, llm: false, active: true });
      // The completed job's finish, read to the second in UTC, is newer than the stamp.
      expect(ran.last_maintenance_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
      expect(Math.abs(Date.parse(ran.last_maintenance_at!) - Date.now())).toBeLessThan(60_000);
      return { none, stamped, ran: { enabled: ran.enabled, llm: ran.llm, active: ran.active } };
    });

  parityTest('listFactsAbsorbJobsStillDead lists dead or failed facts-absorb jobs no later job for the same page completed, newest first, with the full count',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'listFactsAbsorbJobsStillDead'] }, async (engine) => {
      const job = (slug: string | null, sourceId?: string) => ({ data: { ...(slug === null ? {} : { slug }), ...(sourceId ? { sourceId } : {}) } });
      const fa = 'facts-absorb';
      const first = await ended(engine, fa, 'dead', { extra: job('s1') });
      await ended(engine, fa, 'completed', { extra: job('s1') }); // same page, later: supersedes
      await ended(engine, fa, 'failed', { extra: job('s2', 'src-x') });
      await ended(engine, fa, 'completed', { extra: job('s2', 'src-y') }); // another source: does not
      await ended(engine, fa, 'completed', { extra: job('s3', 'src-x') });
      await ended(engine, fa, 'dead', { extra: job('s3', 'src-x') }); // the completion is older: stays
      await ended(engine, fa, 'dead', { extra: job(null) });
      await ended(engine, fa, 'completed', { extra: job(null) }); // a missing slug is never the same page
      await ended(engine, fa, 'failed', { extra: job('s5') }); // sourceId absent here, 'default' below
      await ended(engine, fa, 'completed', { extra: job('s5', 'default') });
      await ended(engine, fa, 'dead', { extra: job('s6') });
      await ended(engine, fa, 'failed', { extra: job('s6') }); // a later failure is not a completion
      await ended(engine, fa, 'dead', { extra: job('s7') });
      await ended(engine, 'minion-other', 'completed', { extra: job('s7') }); // another job name does not supersede
      await ended(engine, fa, 'completed', { extra: job('s8') });
      await add(engine, fa, job('s9'));
      const rows = (r: Awaited<ReturnType<BrainEngine['listFactsAbsorbJobsStillDead']>>) =>
        ({ total: r.total, jobs: r.jobs.map(j => ({ ...j, id: j.id - first })) });
      return {
        limited: rows(await engine.listFactsAbsorbJobsStillDead({ hours: 24, limit: 3 })),
        all: rows(await engine.listFactsAbsorbJobsStillDead({ hours: 24, limit: 100 })),
        noWindow: rows(await engine.listFactsAbsorbJobsStillDead({ hours: 0, limit: 100 })),
      };
    });

  /** A live job of each queued status, by authority, for the legacy job authority read. */
  async function liveJobs(engine: BrainEngine): Promise<number> {
    const base = await add(engine, 'live-app'); // application authority: not in the population
    await add(engine, 'live-other', { submission_authority: OTHER_AUTHORITY });
    await add(engine, 'live-future', { submission_authority: FUTURE_AUTHORITY });
    await active(engine, 'live-active', 'la:a', { submission_authority: OTHER_AUTHORITY });
    await add(engine, 'live-delayed', { status: 'delayed', delay_until: FAR, submission_authority: OTHER_AUTHORITY });
    await add(engine, 'live-paused', { status: PAUSED, submission_authority: OTHER_AUTHORITY });
    await add(engine, 'live-parent', { status: WAITING_CHILDREN, submission_authority: OTHER_AUTHORITY });
    await ended(engine, 'done-other', 'completed', { extra: { submission_authority: OTHER_AUTHORITY, idempotency_key: 'done:1' } });
    await ended(engine, 'dead-other', 'dead', { extra: { submission_authority: FUTURE_AUTHORITY, idempotency_key: 'done:2' } });
    return base;
  }

  parityTest('readLegacyJobAuthority returns the live jobs whose authority is not the application authority, the first ten active ids and the keyed terminal rows',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'readLegacyJobAuthority'] }, async (engine) => {
      const base = await liveJobs(engine);
      const view = (r: Awaited<ReturnType<BrainEngine['readLegacyJobAuthority']>>) => ({
        live: r.live.map(j => ({ ...j, id: j.id - base })), active: rels(base, r.active_ids), terminalKeyed: r.terminal_keyed,
      });
      const few = view(await engine.readLegacyJobAuthority());
      // Twelve more active jobs: only the first ten active ids are read.
      for (let i = 0; i < 12; i++) await active(engine, `busy-${i}`, `busy:${i}`);
      return { few, many: view(await engine.readLegacyJobAuthority()) };
    });

  parityTest('readQueuedSpendRows counts queued jobs by name and spend basis (a recorded kind, a legacy prefix of the right name, or unrecorded) and lists the long-waiting spend-authorized rows',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'readQueuedSpendRows'] }, async (engine) => {
      const spend = (kind?: string) => JSON.stringify(kind ? { version: 1, kind, group_id: 'g', cap_usd: 3 } : { version: 1, group_id: 'g' });
      const key = (idempotency_key: string | null, extra: Partial<JobInsertValues> = {}) => ({ idempotency_key, ...extra });
      const first = await ended(engine, 'enrich', 'completed', { extra: key('enrich:done', { spend_authorization: spend('operator') }) });
      await add(engine, 'subagent', key('book-mirror:1'));
      await add(engine, 'subagent', key('book-mirror:2'));
      await add(engine, 'subagent', key('book-mirror2:3')); // the prefix needs its colon
      await add(engine, 'subagent', key('xbook-mirror:4')); // and its start
      await add(engine, 'subagent', key(null));
      await add(engine, 'subagent', key('enrich:q')); // another name's prefix
      await add(engine, 'enrich', key('enrich:a'));
      await add(engine, 'enrich', key('cli:enrich:b'));
      await add(engine, 'enrich', key('book-mirror:z'));
      await add(engine, 'a%', key('a%b'));
      await add(engine, 'a%', key('axb'));
      await add(engine, 'subagent', key('with-spend:1', { spend_authorization: spend('operator') }));
      await add(engine, 'subagent', key('book-mirror:5', { spend_authorization: spend('legacy_default') }));
      await add(engine, 'enrich', key('enrich:6', { spend_authorization: spend() })); // a record with no kind
      await add(engine, 'enrich', { status: 'delayed', delay_until: FAR, spend_authorization: spend('operator') });
      await add(engine, 'enrich', { status: PAUSED });
      const view = (r: Awaited<ReturnType<BrainEngine['readQueuedSpendRows']>>) => ({ by_basis: r.by_basis, waiting: rels(first, r.waiting_ids) });
      return {
        real: view(await engine.readQueuedSpendRows({ legacyPrefixes: LEGACY_SPEND_KEY_PREFIXES, waitMs: 0 })),
        longWait: view(await engine.readQueuedSpendRows({ legacyPrefixes: LEGACY_SPEND_KEY_PREFIXES, waitMs: 3_600_000 })),
        wildcard: view(await engine.readQueuedSpendRows({ legacyPrefixes: { 'a%': ['a%'], subagent: ['with-'] }, waitMs: 3_600_000 })),
        none: view(await engine.readQueuedSpendRows({ legacyPrefixes: {}, waitMs: 3_600_000 })),
      };
    });

  parityTest('listBuildSkewStacktraceLines returns the stacktrace lines LIKE the prefix of the newest jobs in the window, newest job first and each job in order',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'promoteDelayedJobs', 'listBuildSkewStacktraceLines'] }, async (engine) => {
      const line = (v: string) => `job_build_skew: job child v${v} ran under worker pid 41 v1.0.0`;
      // A job whose stacktrace holds three lines (two failures that retry, then a death), one matching line each way.
      async function failing(name: string, errors: readonly string[]): Promise<number> {
        const id = await active(engine, name, `skew:${name}`);
        for (const [i, error] of errors.entries()) {
          const last = i === errors.length - 1;
          await engine.failJob(id, `skew:${name}`, error, last ? 'dead' : 'delayed', 0);
          if (!last) {
            await engine.promoteDelayedJobs();
            expect(Number((await engine.claimNextJob(claimSpec(`skew:${name}`, { names: [name] })))?.id)).toBe(id);
          }
        }
        return id;
      }
      const first = await failing('skew-a', [line('1.0.1'), 'something else', line('1.0.2')]);
      await failing('skew-b', ['job_build_skew: job child v2.0.0 refused to run under worker pid 7 v2.0.1']);
      await failing('skew-c', ['jobXbuildXskew: not the prefix', 'not job_build_skew: either']); // `_` is a LIKE wildcard: the first line matches
      await failing('skew-d', [line('3.0.0')]);
      await add(engine, 'skew-live'); // a job with an empty stacktrace
      const view = (rows: Array<{ id: number; line: string }>) => rows.map(r => ({ id: r.id - first, line: r.line }));
      const prefix = 'job_build_skew:';
      return {
        all: view(await engine.listBuildSkewStacktraceLines({ prefix, windowHours: 24, scanJobs: 500 })),
        newestTwo: view(await engine.listBuildSkewStacktraceLines({ prefix, windowHours: 24, scanJobs: 2 })),
        newestFive: view(await engine.listBuildSkewStacktraceLines({ prefix, windowHours: 24, scanJobs: 5 })),
        noWindow: view(await engine.listBuildSkewStacktraceLines({ prefix, windowHours: 0, scanJobs: 500 })),
        other: view(await engine.listBuildSkewStacktraceLines({ prefix: 'something', windowHours: 24, scanJobs: 500 })),
        wildcard: view(await engine.listBuildSkewStacktraceLines({ prefix: 'job%', windowHours: 24, scanJobs: 500 })),
      };
    });

  const BREAKER = {
    keyPrefixes: ['dream:synth-v2:', 'dream:patterns:'] as const,
    patternsSourcePrefix: 'dream:patterns:source:',
    synthFilePrefix: 'dream:synth-v2:@file:',
    windowHours: 24,
  };

  parityTest('countDeadDreamSubmissionRows counts dead dream submissions per base key through its three branches, with resets and the window applied',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'cancelJobs', 'addJobTokens', 'getJob', 'countDeadDreamSubmissionRows'] }, async (engine) => {
      const sub = (key: string | null, queue: string, sourceId?: string, released?: string) => ({
        idempotency_key: key, queue, data: { ...(sourceId ? { source_id: sourceId } : {}), ...(released ? { __released_idempotency_key: released } : {}) },
      });
      const dead = (extra: Partial<JobInsertValues>) => ended(engine, 'subagent', 'dead', { extra });
      await dead(sub('dream:synth-v2:abc:c1of3', 'default'));
      await dead(sub('dream:synth-v2:abc:c2of3', 'q2')); // two queues under one base key
      await dead(sub('dream:synth-v2:dup:c1of2', 'q1'));
      await dead(sub('dream:synth-v2:dup:c2of2', 'q1')); // one queue twice counts once
      // Patterns deaths count under the per-source key, whatever the run's content key; a paid cancellation counts, a free one does not.
      await dead(sub('dream:patterns:a:c1of2', 'q1', 'srcA'));
      await ended(engine, 'subagent', 'cancelled', { extra: sub('dream:patterns:b', 'q2', 'srcA'), tokens: 5 });
      await ended(engine, 'subagent', 'cancelled', { extra: sub('dream:patterns:c', 'q3', 'srcA') });
      await ended(engine, 'subagent', 'cancelled', { extra: sub('dream:synth-v2:cancelled', 'q3'), tokens: 5 }); // cancelled synth: no branch counts it
      // A transcript's deaths: one row per content key, and one per transcript once two content keys died.
      await dead(sub('dream:synth-v2:s1:filename:t1:h1', 'q1', 'srcB'));
      await dead(sub('dream:synth-v2:s1:filename:t1:h2', 'q2', 'srcB'));
      await dead(sub('dream:synth-v2:s2:filename:t2:h1:c1of2', 'q1', 'srcB'));
      await dead(sub('dream:synth-v2:s2:filename:t2:h1:c2of2', 'q2', 'srcB')); // one content key: the transcript row stays out
      await dead(sub('dream:synth-v2:s3:filename:a:b:c', 'q1', 'srcB')); // an extra colon: no transcript branch
      await dead(sub('dream:synth-v2:s4:filename::h', 'q1')); // an empty name still matches
      await dead(sub('dream:synth-v2:s4:filename::g', 'q2'));
      await dead(sub(null, 'q1', 'srcC', 'dream:synth-v2:rel:c1of2')); // a released key counts under its original
      await dead(sub('dream:synth-v2:@file:srcD:t9', 'q1', 'srcD')); // a transcript key itself: its row needs two content keys
      // Out of every family, and live jobs.
      await dead(sub('other:key', 'q1'));
      await dead(sub('dream:phase:x:1', 'q1'));
      await dead(sub(null, 'q1'));
      await ended(engine, 'subagent', 'failed', { extra: sub('dream:synth-v2:failed', 'q1') });
      await ended(engine, 'minion-other', 'dead', { extra: sub('dream:synth-v2:abc', 'q9') });
      await add(engine, 'subagent', sub('dream:synth-v2:live', 'q1'));
      const who = await finishers(engine);
      const view = (rows: Array<{ base_key: string; dead_submissions: number; last_dead_at: string }>) =>
        rows.map(r => ({ base_key: r.base_key, dead_submissions: r.dead_submissions, last_dead_at: who(r.last_dead_at) }));
      const count = (resets: Record<string, string>, windowHours = 24) =>
        engine.countDeadDreamSubmissionRows({ ...BREAKER, resets, windowHours });
      return {
        plain: view(await count({})),
        resetAbc: view(await count({ 'dream:synth-v2:abc': FAR, 'dream:synth-v2:@file:srcB:t1': FAR, 'dream:patterns:source:srcA': PAST, 'not:a:key': 'garbage' })),
        resetUnparsedKeyPresent: await (async () => { try { await count({ 'dream:synth-v2:abc': 'garbage' }); return 'ok'; } catch { return 'threw'; } })(),
        noWindow: view(await count({}, 0)),
      };
    });

  parityTest('listFactsAbsorbJobsByKeyPrefix and listDeadFactsAbsorbJobsByKeys read the dead-write retry jobs by key prefix and key set, by id',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'listFactsAbsorbJobsByKeyPrefix', 'listDeadFactsAbsorbJobsByKeys'] }, async (engine) => {
      const fa = 'facts-absorb';
      const job = (idempotency_key: string | null, slug: string, sourceId?: string) => ({ idempotency_key, data: { slug, ...(sourceId ? { sourceId } : {}) } });
      const prefix = 'facts-absorb:write:';
      const k1 = await ended(engine, fa, 'dead', { extra: job(`${prefix}k1`, 'p1', 'src-a'), error: 'extraction failed: model unavailable' });
      await ended(engine, fa, 'failed', { extra: job(`${prefix}k2`, 'p2') });
      await ended(engine, fa, 'completed', { extra: job(`${prefix}k3`, 'p3', 'src-b') });
      await ended(engine, fa, 'dead', { extra: job('facts-absorb:other:k4', 'p4') });
      await ended(engine, fa, 'dead', { extra: job('facts-absorb:writer:k5', 'p5') }); // `write:` needs its colon
      await ended(engine, fa, 'dead', { extra: job(null, 'p6') });
      await ended(engine, 'minion-other', 'dead', { extra: job(`${prefix}k7`, 'p7') });
      await ended(engine, fa, 'dead', { extra: job(`${prefix}k8`, 'p8') });
      await add(engine, fa, job(`${prefix}k9`, 'p9'));
      const view = (rows: Awaited<ReturnType<BrainEngine['listDeadFactsAbsorbJobsByKeys']>>) =>
        rows.map(r => ({ ...r, id: r.id - k1, finished_at: r.finished_at instanceof Date ? 'date' : r.finished_at }));
      const byPrefix = (keys: string[]) => engine.listFactsAbsorbJobsByKeyPrefix({ prefix, keys });
      const tracked = [`${prefix}k2`, `${prefix}k3`, `${prefix}k9`, `${prefix}missing`, 'facts-absorb:other:k4'];
      return {
        deadOnly: view(await byPrefix([])),
        tracked: view(await byPrefix(tracked)),
        deadByKeys: view(await engine.listDeadFactsAbsorbJobsByKeys([`${prefix}k1`, `${prefix}k2`, `${prefix}k3`, 'facts-absorb:other:k4', 'facts-absorb:writer:k5', `${prefix}k7`])),
        none: view(await engine.listDeadFactsAbsorbJobsByKeys([])),
      };
    });
});
