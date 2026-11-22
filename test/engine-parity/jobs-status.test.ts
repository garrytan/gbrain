/**
 * BrainEngine parity — minion job counts and last-run reads for the status surfaces (engine-sql/jobs-status.ts):
 * `gbrain status` and its snapshot (last autopilot runs, job counts by status, waiting depth per queue, last completion),
 * `gbrain jobs stats` (waiting-TTL cancellations, the scope state behind a coalesced job, recent completions, recent
 * failures), the facts drain backlog and its cost estimate, and the source health and sync status per-source counts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every status read returns the same rows on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts): which statuses and names a count includes, the order of each
 *    list (ties included), NULL versus empty (no source, no filter, an empty status list), which jobs a time window keeps,
 *    how a LIKE pattern's `_` matches any one character, how a job's scope falls back from `sourceId` to `source_id`, and
 *    which pages the drain estimate counts.
 *  - Regression: an engine that counts the wrong statuses, ignores a name or queue filter, treats an empty status list as
 *    no filter, orders ties differently, mixes sources, reads a window the wrong way round, matches a LIKE pattern
 *    literally, counts a lease that has expired as live, or averages a different set of pages shows a different row here.
 *  - Why existing coverage misses it: these reads ran as raw SQL at their call sites (status.ts, jobs/stats.ts,
 *    facts/drain.ts, source-health.ts, sync-status-report.ts), which the Rust engine refuses, and their unit tests run
 *    on PGLite only.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). A lease that has run out comes from a negative
 *    duration. A time window can only be told apart by letting time pass, so the window cases wait 0.8 s once and read a
 *    0.5 s window (the store's own clock is moved in rust/crates/gbrain-store/tests/jobs_status.rs, where whole
 *    minutes and hours can be crossed). Ids are compared relative to the case's first job and clock readings only as
 *    present, ordered, or equal to the job's own row. Submissions are 2 ms apart so created_at never ties.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import type { PageInput } from '../../src/core/types.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const FAR = '2099-01-01T00:00:00.000Z';
/** Long enough that every job a case made is inside it. */
const DAY = 86_400;
/** The wait before a window case reads a 0.5 s window: the jobs made before it are 0.8 s old, the ones after it are new. */
const PAUSE_MS = 800;
const WINDOW = 0.5;

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

function policy(authority: SubmissionAuthority = APPLICATION_AUTHORITY): AdmitJobPolicy {
  return {
    decide: async (_tx, row) => coalesceDecision(row, authority),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  };
}

function admit(engine: BrainEngine, spec: Partial<AdmitJobSpec> & { insert: JobInsertValues }) {
  return engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy());
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, { insert: values(name, extra) });
  expect(out.coalesced).toBe(false);
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** A new job named `name`, claimed (the claim takes the oldest waiting job of that name and queue, which is this one). */
async function active(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}, claim: Partial<ClaimJobSpec> = {}): Promise<number> {
  const id = await add(engine, name, extra);
  const token = `st:${id}`;
  const row = await engine.claimNextJob(claimSpec(token, { names: [name], queue: extra.queue ?? 'default', ...claim }));
  expect(Number(row?.id)).toBe(id);
  return id;
}

/** A new job that ended as `how`. */
async function finished(
  engine: BrainEngine, name: string, how: 'completed' | 'failed' | 'dead', extra: Partial<JobInsertValues> = {}, result?: Record<string, unknown>,
): Promise<number> {
  const id = await active(engine, name, extra);
  if (how === 'completed') await engine.completeJob(id, `st:${id}`, result);
  else await engine.failJob(id, `st:${id}`, `${how} on purpose`, how);
  await Bun.sleep(2);
  return id;
}

const time = (v: unknown) => (v == null ? null : new Date(v as string | Date).getTime());

describe('engine parity: minion status reads', () => {
  parityTest('readLastAutopilotCycles reads the newest completed autopilot-cycle and the newest completed autopilot-* job',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'readLastAutopilotCycles'] }, async (engine) => {
      const none = await engine.readLastAutopilotCycles();
      // Not completed, or not named autopilot-*: ignored however new they are.
      await finished(engine, 'autopilot-cycle', 'completed', {}, { report: { totals: { pages: 1 } } });
      await finished(engine, 'autopilot-cycle', 'failed');
      await finished(engine, 'autopilot-extract', 'completed', {}, { report: { totals: { pages: 2 } } });
      await finished(engine, 'autopilot-cycle', 'dead');
      await finished(engine, 'autopilot', 'completed', {}, { report: { totals: { pages: 3 } } });
      await finished(engine, 'my-autopilot-cycle', 'completed', {}, { report: { totals: { pages: 4 } } });
      const targetedNewer = await engine.readLastAutopilotCycles();
      await finished(engine, 'autopilot-cycle', 'completed', {}, { report: { totals: { pages: 5 } } });
      const fullNewer = await engine.readLastAutopilotCycles();
      // A name that only begins like the full cycle's is a targeted run, never the full one.
      await finished(engine, 'autopilot-cycle-2', 'completed', {}, { report: { totals: { pages: 6 } } });
      const prefixNewer = await engine.readLastAutopilotCycles();
      // A waiting run changes nothing.
      await add(engine, 'autopilot-cycle');
      const withWaiting = await engine.readLastAutopilotCycles();
      const view = (row: Awaited<ReturnType<BrainEngine['readLastAutopilotCycles']>>['full']) =>
        row ? { name: row.name, status: row.status, result: row.result, finished: row.finished_at instanceof Date, started: row.started_at instanceof Date,
          ran: time(row.finished_at)! >= time(row.started_at)! } : null;
      expect(none).toEqual({ full: null, targeted: null });
      expect(time(targetedNewer.targeted?.finished_at)).toBeGreaterThan(time(targetedNewer.full?.finished_at)!);
      return {
        none,
        targetedNewer: { full: view(targetedNewer.full), targeted: view(targetedNewer.targeted) },
        fullNewer: { full: view(fullNewer.full), targeted: view(fullNewer.targeted) },
        prefixNewer: { full: view(prefixNewer.full), targeted: view(prefixNewer.targeted) },
        withWaiting: { full: view(withWaiting.full), targeted: view(withWaiting.targeted) },
      };
    });

  parityTest('countJobsByStatus counts every job by status in status order, and only the jobs a name, queue and status filter match',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'countJobsByStatus'] }, async (engine) => {
      expect(await engine.countJobsByStatus()).toEqual([]);
      // A claim takes the oldest waiting job of its name, so the jobs that run or end come before the waiting ones.
      await active(engine, 'facts-absorb');
      await finished(engine, 'facts-absorb', 'completed');
      await finished(engine, 'facts-absorb', 'failed');
      const dead = await finished(engine, 'sync', 'dead');
      await add(engine, 'facts-absorb');
      await add(engine, 'facts-absorb');
      await add(engine, 'facts-absorb', { queue: 'other' });
      await add(engine, 'facts-absorb', { status: 'delayed', delay_until: FAR });
      await add(engine, 'sync');
      await engine.cancelJobs([await add(engine, 'sync')]);
      const parent = await add(engine, 'sync');
      await add(engine, 'kid', { parent_job_id: parent });
      expect(dead).toBeGreaterThan(0);
      return {
        all: await engine.countJobsByStatus(),
        noFilterObject: await engine.countJobsByStatus({}),
        drain: await engine.countJobsByStatus({ name: 'facts-absorb', queue: 'default', statuses: ['waiting', 'delayed', 'active'] }),
        drainOtherQueue: await engine.countJobsByStatus({ name: 'facts-absorb', queue: 'other', statuses: ['waiting', 'delayed', 'active'] }),
        byName: await engine.countJobsByStatus({ name: 'sync' }),
        byQueue: await engine.countJobsByStatus({ queue: 'other' }),
        byStatuses: await engine.countJobsByStatus({ statuses: ['dead', 'cancelled', 'waiting-children', 'paused'] }),
        emptyStatuses: await engine.countJobsByStatus({ statuses: [] }),
        noSuchName: await engine.countJobsByStatus({ name: 'nothing' }),
      };
    });

  parityTest('readWaitingQueueDepths lists the queues with waiting work, deepest first, with the oldest waiting age rounded to seconds',
    { methods: ['admitJob', 'claimNextJob', 'readWaitingQueueDepths'] }, async (engine) => {
      expect(await engine.readWaitingQueueDepths()).toEqual([]);
      // Only queue alpha has work that is 0.8 s old: a half second rounds up to a whole one, so a truncating store reads 0.
      await add(engine, 'work', { queue: 'alpha' });
      await Bun.sleep(PAUSE_MS);
      await add(engine, 'work', { queue: 'alpha' });
      await add(engine, 'work', { queue: 'alpha' });
      for (const queue of ['beta', 'beta', 'beta', 'gamma', 'epsilon', 'epsilon']) await add(engine, 'work', { queue });
      // Not waiting: a queue with only active, delayed or paused work is absent.
      await active(engine, 'run', { queue: 'delta' });
      await add(engine, 'later', { queue: 'zeta', status: 'delayed', delay_until: FAR });
      const rows = await engine.readWaitingQueueDepths();
      return rows.map(r => ({ queue: r.queue, depth: r.depth, age: r.oldest_waiting_age_seconds }));
    });

  parityTest('readLastFinishedJobAt reads the latest finished_at of a completed job of one name, in UTC ISO seconds',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'getJob', 'readLastFinishedJobAt'] }, async (engine) => {
      const name = 'autopilot-global-maintenance';
      const empty = await engine.readLastFinishedJobAt(name);
      await finished(engine, name, 'failed');
      await finished(engine, 'other-job', 'completed');
      const noneCompleted = await engine.readLastFinishedJobAt(name);
      await finished(engine, name, 'completed');
      const last = await finished(engine, name, 'completed');
      const at = await engine.readLastFinishedJobAt(name);
      const finishedAt = (await engine.getJob(last))?.finished_at;
      const seconds = finishedAt == null ? null : new Date(finishedAt as string | Date).toISOString().slice(0, 19) + 'Z';
      return { empty, noneCompleted, shape: typeof at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(at), latest: at === seconds };
    });

  parityTest('readLastCompletedJobAt reads the freshest updated_at of a completed job, and nothing else moves it',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'getJob', 'readLastCompletedJobAt'] }, async (engine) => {
      const empty = await engine.readLastCompletedJobAt();
      await add(engine, 'work');
      await finished(engine, 'a', 'failed');
      const failedOnly = await engine.readLastCompletedJobAt();
      const first = await finished(engine, 'b', 'completed');
      const afterFirst = await engine.readLastCompletedJobAt();
      const second = await finished(engine, 'c', 'completed');
      const afterSecond = await engine.readLastCompletedJobAt();
      await finished(engine, 'd', 'dead');
      await add(engine, 'e');
      const afterOthers = await engine.readLastCompletedJobAt();
      const updated = async (id: number) => time((await engine.getJob(id))?.updated_at);
      return {
        empty, failedOnly,
        afterFirst: time(afterFirst) === await updated(first),
        afterSecond: time(afterSecond) === await updated(second),
        advanced: time(afterSecond)! > time(afterFirst)!,
        afterOthers: time(afterOthers) === await updated(second),
      };
    });

  parityTest('countTtlCancelledByName counts cancelled jobs whose error text matches the LIKE pattern, by name, within the window',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'cancelJobs', 'countTtlCancelledByName'] }, async (engine) => {
      const cancel = async (name: string, reason: string | null) => engine.cancelJobs([await add(engine, name)], { reason });
      const like = 'waiting_ttl_expired%';
      expect(await engine.countTtlCancelledByName(like, DAY)).toEqual([]);
      await cancel('beta', 'waiting_ttl_expired: 72h');
      await cancel('alpha', 'waiting_ttl_expired: 24h');
      await cancel('alpha', 'waiting_ttl_expired');
      await cancel('gamma', 'waiting_ttl_expired: 1h');
      // `_` matches any one character; the match is case sensitive and anchored at the start.
      await cancel('wild', 'waitingXttlXexpired by a sweep');
      await cancel('upper', 'WAITING_TTL_EXPIRED');
      await cancel('later', 'cancelled: waiting_ttl_expired');
      await cancel('plain', 'cancelled by an operator');
      await cancel('silent', null);
      // Completed or still waiting jobs carry no reason.
      await finished(engine, 'beta', 'completed');
      await add(engine, 'beta');
      const all = await engine.countTtlCancelledByName(like, DAY);
      await Bun.sleep(PAUSE_MS);
      await cancel('recent', 'waiting_ttl_expired: 6h');
      return {
        all,
        recent: await engine.countTtlCancelledByName(like, WINDOW),
        wholeDay: await engine.countTtlCancelledByName(like, DAY),
        nothingInZero: await engine.countTtlCancelledByName(like, 0),
        exact: await engine.countTtlCancelledByName('cancelled by%', DAY),
        literalUnderscore: await engine.countTtlCancelledByName('waiting\\_ttl\\_expired%', DAY),
      };
    });

  parityTest('readWaitingScopeState counts waiting jobs in a returned job\'s source scope and reports the job only while it holds a live lease',
    { methods: ['admitJob', 'claimNextJob', 'readWaitingScopeState'] }, async (engine) => {
      const target = await active(engine, 'sync', { data: { sourceId: 's1' } });
      await add(engine, 'sync', { data: { sourceId: 's1' } });
      await add(engine, 'sync', { data: { source_id: 's1' } });
      await add(engine, 'sync', { data: { sourceId: 's2' } });
      // `sourceId` wins over `source_id`; another queue or name is another scope.
      await add(engine, 'sync', { data: { sourceId: 's9', source_id: 's1' } });
      await add(engine, 'sync', { data: { sourceId: 's1' }, queue: 'other' });
      await add(engine, 'sync-other', { data: { sourceId: 's1' } });
      await add(engine, 'sync', { data: { sourceId: 's1' }, status: 'delayed', delay_until: FAR });
      const live = await engine.readWaitingScopeState({ name: 'sync', queue: 'default', jobId: target });
      const wrongName = await engine.readWaitingScopeState({ name: 'sync-other', queue: 'default', jobId: target });
      const wrongQueue = await engine.readWaitingScopeState({ name: 'sync', queue: 'other', jobId: target });
      const missing = await engine.readWaitingScopeState({ name: 'sync', queue: 'default', jobId: target + 100_000 });
      // A waiting target has no live lease; its scope is the jobs with no source at all.
      const bare = await add(engine, 'embed');
      await add(engine, 'embed');
      await add(engine, 'embed', { data: { sourceId: 's1' } });
      const waitingTarget = await engine.readWaitingScopeState({ name: 'embed', queue: 'default', jobId: bare });
      // An active target whose lease ran out (a negative duration) is not live.
      const expired = await active(engine, 'sync-expired', { data: { sourceId: 's7' } }, { lockDurationMs: -60_000 });
      await add(engine, 'sync-expired', { data: { sourceId: 's7' } });
      const expiredState = await engine.readWaitingScopeState({ name: 'sync-expired', queue: 'default', jobId: expired });
      return {
        live: { ...live, live_id: live.live_id === null ? null : live.live_id - target },
        wrongName, wrongQueue, missing, waitingTarget,
        expired: expiredState,
      };
    });

  parityTest('countRecentCompletedJobs counts completed jobs of one name inside the window',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'countRecentCompletedJobs'] }, async (engine) => {
      expect(await engine.countRecentCompletedJobs('subagent', DAY)).toBe(0);
      await finished(engine, 'subagent', 'completed');
      await finished(engine, 'subagent', 'completed');
      await finished(engine, 'other', 'completed');
      await finished(engine, 'subagent', 'failed');
      await Bun.sleep(PAUSE_MS);
      await finished(engine, 'subagent', 'completed');
      await add(engine, 'subagent');
      return {
        day: await engine.countRecentCompletedJobs('subagent', DAY),
        recent: await engine.countRecentCompletedJobs('subagent', WINDOW),
        other: await engine.countRecentCompletedJobs('other', DAY),
        nothing: await engine.countRecentCompletedJobs('nothing', DAY),
        zero: await engine.countRecentCompletedJobs('subagent', 0),
      };
    });

  parityTest('listRecentFailedJobErrors lists dead and failed jobs inside the window with their error text, by id',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'listRecentFailedJobErrors'] }, async (engine) => {
      expect(await engine.listRecentFailedJobErrors(DAY)).toEqual([]);
      const first = await finished(engine, 'work', 'dead');
      await finished(engine, 'work', 'completed');
      const failed = await finished(engine, 'work', 'failed');
      // A delayed retry, a cancelled and a waiting job are not failures.
      const retry = await active(engine, 'retry');
      await engine.failJob(retry, `st:${retry}`, 'will retry', 'delayed', 60_000);
      await engine.cancelJobs([await add(engine, 'cancelled')], { reason: 'cancelled on purpose' });
      await add(engine, 'waiting');
      await Bun.sleep(PAUSE_MS);
      const late = await finished(engine, 'work', 'dead');
      const rel = (rows: Awaited<ReturnType<BrainEngine['listRecentFailedJobErrors']>>) => rows.map(r => ({ id: r.id - first, error: r.last_error }));
      expect(failed).toBeGreaterThan(first);
      return { day: rel(await engine.listRecentFailedJobErrors(DAY)), recent: rel(await engine.listRecentFailedJobErrors(WINDOW)), zero: await engine.listRecentFailedJobErrors(0), late: late - first };
    });

  parityTest('readQueuedPageChars averages the capped text length of the pages waiting or delayed drain jobs point at',
    { methods: ['admitJob', 'claimNextJob', 'putPage', 'softDeletePage', 'readQueuedPageChars'] }, async (engine) => {
      const page = (title: string, size: number): PageInput => ({ type: 'note', title, compiled_truth: 'a'.repeat(size), timeline: '' });
      const spec = { name: 'facts-absorb', queue: 'default', maxChars: 500 };
      const none = await engine.readQueuedPageChars(spec);
      await engine.putPage('notes/a', page('A', 100));
      await engine.putPage('notes/b', page('B', 300));
      await engine.putPage('notes/c', page('C', 1000));
      await engine.putPage('notes/d', page('D', 900));
      await engine.putPage('notes/z', page('Z', 4000));
      const noPages = await engine.readQueuedPageChars(spec);
      // The running job comes first: a claim takes the oldest waiting job of its name.
      await active(engine, 'facts-absorb', { data: { slug: 'notes/z' } });
      await add(engine, 'facts-absorb', { data: { slug: 'notes/a' } });
      await add(engine, 'facts-absorb', { data: { slug: 'notes/b' }, status: 'delayed', delay_until: FAR });
      await add(engine, 'facts-absorb', { data: { slug: 'notes/c' } });
      const three = await engine.readQueuedPageChars(spec);
      // One page per job, even when two jobs point at the same page; the default source is named or implied.
      await add(engine, 'facts-absorb', { data: { slug: 'notes/a', sourceId: 'default' } });
      const four = await engine.readQueuedPageChars(spec);
      // Not counted: another status, name or queue, no slug, no such page, a page of another source.
      await add(engine, 'facts-absorb', { data: { slug: 'notes/z' }, queue: 'other' });
      await add(engine, 'other-job', { data: { slug: 'notes/z' } });
      await add(engine, 'facts-absorb', { data: {} });
      await add(engine, 'facts-absorb', { data: { slug: 'notes/missing' } });
      await add(engine, 'facts-absorb', { data: { slug: 'notes/a', sourceId: 'elsewhere' } });
      const ignored = await engine.readQueuedPageChars(spec);
      // The cap is a parameter; a page deleted since is still counted (the statement never looked at deleted_at).
      const bigCap = await engine.readQueuedPageChars({ ...spec, maxChars: 5000 });
      const tinyCap = await engine.readQueuedPageChars({ ...spec, maxChars: 50 });
      await add(engine, 'facts-absorb', { data: { slug: 'notes/d' } });
      await engine.softDeletePage('notes/d');
      const withDeleted = await engine.readQueuedPageChars(spec);
      return { none, noPages, three, four, ignored, bigCap, tinyCap, withDeleted };
    });

  parityTest('readSourceJobCounts counts sync and embed-backfill jobs per source: failures in the window, live depth, backfill running and queued',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'readSourceJobCounts'] }, async (engine) => {
      expect(await engine.readSourceJobCounts(DAY)).toEqual([]);
      const s1 = { data: { sourceId: 's1' } };
      // A claim takes the oldest waiting job of its name, so the jobs that run or end come before the waiting ones.
      await active(engine, 'sync', s1);
      await finished(engine, 'sync', 'failed', s1);
      await finished(engine, 'sync', 'dead', s1);
      await finished(engine, 'sync', 'completed', s1);
      await active(engine, 'embed-backfill', s1);
      await finished(engine, 'embed-backfill', 'completed', s1);
      await finished(engine, 'embed-backfill', 'failed', s1);
      // A source with only a completed job still has a row of zeros.
      await finished(engine, 'sync', 'completed', { data: { sourceId: 's2' } });
      await add(engine, 'sync', s1);
      await add(engine, 'embed-backfill', s1);
      await add(engine, 'embed-backfill', { ...s1, status: 'delayed', delay_until: FAR });
      const parent = await add(engine, 'embed-backfill', s1);
      await add(engine, 'kid', { parent_job_id: parent });
      // A source id that is empty counts; a missing one, a snake_case one, and other job names do not.
      await add(engine, 'sync', { data: { sourceId: '' } });
      await add(engine, 'sync', { data: {} });
      await add(engine, 'embed-backfill', { data: { source_id: 's4' } });
      await add(engine, 'subagent', { data: { sourceId: 's3' } });
      const day = await engine.readSourceJobCounts(DAY);
      await Bun.sleep(PAUSE_MS);
      await finished(engine, 'sync', 'failed', { ...s1, queue: 'late' });
      return { day, recent: await engine.readSourceJobCounts(WINDOW), afterRecent: await engine.readSourceJobCounts(DAY) };
    });

  parityTest('readEmbedBackfillBySource reports queued, active and last completed embed-backfill per requested source',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'getJob', 'readEmbedBackfillBySource'] }, async (engine) => {
      const job = (sourceId: string) => ({ data: { sourceId } });
      // A claim takes the oldest waiting job of its name, so the jobs that run or end come before the waiting ones.
      // The job that ran first finishes last: the newest completion is not the newest row.
      const lastDone = await active(engine, 'embed-backfill', job('s1'));
      await finished(engine, 'embed-backfill', 'completed', job('s1'));
      await engine.completeJob(lastDone, `st:${lastDone}`);
      await Bun.sleep(2);
      await active(engine, 'embed-backfill', job('s1'));
      await finished(engine, 'embed-backfill', 'failed', job('s1'));
      await finished(engine, 'embed-backfill', 'failed', job('s2'));
      await add(engine, 'embed-backfill', job('s1'));
      await add(engine, 'embed-backfill', { ...job('s1'), status: 'delayed', delay_until: FAR });
      const parent = await add(engine, 'embed-backfill', job('s1'));
      await add(engine, 'kid', { parent_job_id: parent });
      // Not requested, not an embed-backfill job, or not named by sourceId.
      await add(engine, 'embed-backfill', job('s3'));
      await add(engine, 'sync', job('s1'));
      await add(engine, 'embed-backfill', { data: { source_id: 's1' } });
      const rows = await engine.readEmbedBackfillBySource(['s1', 's2', 'unknown']);
      const lastCompleted = time((await engine.getJob(lastDone))?.finished_at);
      const view = (list: typeof rows) => list.map(r => ({ source_id: r.source_id, queued: r.queued, active: r.active, last: r.last_completed_at === null ? null : time(r.last_completed_at) === lastCompleted }));
      return {
        some: view(rows),
        one: view(await engine.readEmbedBackfillBySource(['s2'])),
        none: await engine.readEmbedBackfillBySource([]),
        unknown: await engine.readEmbedBackfillBySource(['unknown']),
      };
    });
});
