/**
 * BrainEngine parity: the Wakeshift report-back tables (engine-sql/jobs-wake.ts): recording, listing and ending watches,
 * the status and doctor counts, the cron registry and its runs, the terms acceptances, and what the drainer reads and
 * leases (the due watches joined to their job, write request or cron run; the watch and forget leases).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same rows and effects on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): which watch a second open subscription reuses,
 *    which rows a principal's list holds and in what order, which watches each way of ending touches, how the counts
 *    group, which runs a cron's last-run and the 7- and 30-day windows keep, and which watches the drainer finds due.
 *  - Regression: an engine that drifts on the open-subscription conflict (a second row, or no sequence value spent), the
 *    NULL-member match of a principal's list, the 50-row cap, the reasons that end a watch, the bytewise order of cron
 *    names, the cron run a watch waits for (the first one at or after the watch began, by time and then id), the
 *    job, write and cron settled rules, the 20-row due batch ordered by due time, or a lease a second claim or a late
 *    settle should lose, tells an agent a wake came when it did not, or never wakes it, or sends one twice.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` in commands/wakeshift.ts,
 *    ops/wakeshift.ts, doctor/checks/wakeshift.ts and wakeshift/*.ts, which the parity cases cannot call (D18), and the
 *    unit tests of those files run on PGLite only.
 *  - Seam: none. Real engines, typed members only (no executeRaw). A job and a write request come from the queue's and
 *    the journal's own members. A time window is exercised by an explicit run time (a cron run recorded 8, 20 or 40 days
 *    back) or by the rows' own clock, never by waiting; the windows a case cannot reach (a watch updated a day ago) are
 *    covered by rust/crates/gbrain-store/tests/jobs_wake.rs. Ids are compared relative to the case's first row, timestamps
 *    by the instant they name, and the lease token by its shape.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import type { WakeRow, WakeWatchInsert, WakeWatchRow } from '../../src/core/engine-sql/jobs-wake.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { CRON_FINISHED, JOB_FINISHED, WRITE_SETTLED } from '../../src/core/wakeshift/events.ts';
import { principalLive } from '../../src/core/wakeshift/drain.ts';
import { forgetWakePrincipal } from '../../src/core/wakeshift/forget.ts';
import { revokeLegacyTokenById } from '../../src/core/token-mint.ts';
import { hashToken } from '../../src/core/utils.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const DAY = 86_400_000;
const FAR = '2099-01-01T00:00:00.000Z';
const FAR_B = '2098-01-01T00:00:00.000Z';
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** A Wakeshift user id: 32 lowercase hex digits. */
const user = (n: number) => n.toString(16).padStart(32, '0');
const LEASE = /^\d{16}$/;

let subscription = 0;
/** A watch to record; every call names a new Wakeshift subscription unless `wsSubscriptionId` is given. */
const watch = (extra: Partial<WakeWatchInsert> = {}): WakeWatchInsert => ({
  event: JOB_FINISHED, target: '1', targetRef: null, principalKind: 'local_stdio', principalId: 'parity', memberId: null,
  wakeUser: user(1), wsSubscriptionId: `ws-${++subscription}`, expiresAt: FAR, ...extra,
});

const view = (r: WakeWatchRow, base: number) => ({
  id: r.id - base, event: r.event, target: r.target, state: r.state, attempts: r.attempts, last_error: r.last_error,
  createdIsDate: r.created_at instanceof Date, expires: iso(r.expires_at), wake_user: r.wake_user, ws: r.ws_subscription_id,
});

const mine = { principalKind: 'local_stdio', principalId: 'parity', memberId: null, scope: 'open_or_recent' } as const;

/** Claims and settles one watch to `state`, as the drainer does. */
async function settleTo(engine: BrainEngine, id: number, state: 'open' | 'delivered' | 'dead' | 'ended', fields: { attempts?: number; delayS?: number; error?: string | null; marker?: string } = {}): Promise<void> {
  const claimed = await engine.claimWakeWatch(id, 60);
  expect(claimed).not.toBeNull();
  expect(await engine.settleWakeWatch({ id, lease: claimed!.lease, state, ...fields })).toBe(true);
}

// ---------------------------------------------------------------- the jobs and write requests the drainer joins

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

async function addJob(engine: BrainEngine, name: string): Promise<number> {
  const out: Awaited<ReturnType<BrainEngine['admitJob']>> = await engine.admitJob({ maxSpawnDepth: 5, insert: values(name) } as AdmitJobSpec, policy());
  await Bun.sleep(2);
  return Number(out.row.id);
}

const claimSpec = (name: string): ClaimJobSpec => ({
  lockToken: `wake:${name}`, lockDurationMs: 30_000, queue: 'default', names: [name], handlerTimeouts: {},
  handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 },
});

/** A job that was claimed and then left `how` (or is still `active`, or `waiting`). */
async function jobIn(engine: BrainEngine, name: string, how: 'waiting' | 'active' | 'completed' | 'failed' | 'dead' | 'cancelled'): Promise<number> {
  const id = await addJob(engine, name);
  if (how === 'waiting') return id;
  if (how === 'cancelled') {
    await engine.cancelJobs([id]);
    return id;
  }
  expect(Number((await engine.claimNextJob(claimSpec(name)))?.id)).toBe(id);
  if (how === 'completed') await engine.completeJob(id, `wake:${name}`);
  else if (how === 'failed' || how === 'dead') await engine.failJob(id, `wake:${name}`, `${how} on purpose`, how);
  return id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const requestId = (n: number) => `b0000000-0000-4000-8000-0000000000b${n}`;

/** A queued write request; its journal id. */
async function admitRequest(engine: BrainEngine, n: number): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'parity-writer', requestId: requestId(n), operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  expect(row.id).toMatch(UUID);
  return row.id;
}

/** A write request in `state`: queued, running (claimed), or finished as committed, failed, conflict or cancelled. */
async function requestIn(engine: BrainEngine, n: number, state: 'queued' | 'running' | 'committed' | 'failed' | 'conflict' | 'cancelled'): Promise<string> {
  const id = await admitRequest(engine, n);
  if (state === 'queued') return id;
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  if (state === 'running') return id;
  await engine.completeWriteRow({
    id, state, outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null,
    errorDetail: null, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800, terminalReservation: 4096, probePurges: false,
  });
  return id;
}

/** The instant a `*_us` text names agrees with the timestamp beside it, to the millisecond a `Date` keeps. */
const sameInstant = (us: string | null, at: unknown) => us === null ? at == null : at != null && Math.abs(Math.floor(Number(us) / 1000) - new Date(at as string | Date).getTime()) <= 1;

describe('engine parity: wake watches', () => {
  parityTest('openWakeWatch records a watch; a second open watch of one subscription keeps its row, moves the expiry and spends a sequence value',
    { methods: ['openWakeWatch', 'listWakeWatches', 'endWakeWatches'] }, async (engine) => {
      const first = await engine.openWakeWatch(watch({ wsSubscriptionId: 'ws-a', target: '11', expiresAt: FAR_B }));
      const again = await engine.openWakeWatch(watch({ wsSubscriptionId: 'ws-a', target: '99', expiresAt: FAR }));
      const other = await engine.openWakeWatch(watch({ wsSubscriptionId: 'ws-b', target: '12' }));
      const otherUser = await engine.openWakeWatch(watch({ wsSubscriptionId: 'ws-a', wakeUser: user(2), target: '13' }));
      const rows = await engine.listWakeWatches(mine);
      expect(await engine.endWakeWatches({ reason: 'unwatched', id: first })).toEqual([{ id: first, wake_user: user(1), ws_subscription_id: 'ws-a' }]);
      const reopened = await engine.openWakeWatch(watch({ wsSubscriptionId: 'ws-a', target: '14' }));
      const after = await engine.listWakeWatches(mine);
      const answers = {
        ids: [first, again, other, otherUser, reopened].map(id => id - first),
        rows: rows.map(r => view(r, first)),
        after: after.map(r => view(r, first)),
      };
      expect(answers.ids).toEqual([0, 0, 2, 3, 4]);
      expect(answers.rows.map(r => [r.id, r.target, r.expires, r.state])).toEqual([
        [3, '13', FAR, 'open'], [2, '12', FAR, 'open'], [0, '11', FAR, 'open'],
      ]);
      expect(answers.after.map(r => [r.id, r.state, r.last_error])).toEqual([[4, 'open', null], [3, 'open', null], [2, 'open', null], [0, 'ended', 'unwatched']]);
      return answers;
    });

  parityTest('openWakeWatch refuses a row that breaks a column rule and keeps no row of it',
    { methods: ['openWakeWatch', 'listWakeWatches'] }, async (engine) => {
      const tries: Array<[string, Partial<WakeWatchInsert>]> = [
        ['event outside gbrain.', { event: 'job.finished' }],
        ['event upper case', { event: 'gbrain.Job' }],
        ['event too long', { event: `gbrain.${'a'.repeat(49)}` }],
        ['empty target', { target: '' }],
        ['target of 129', { target: 'x'.repeat(129) }],
        ['unknown principal kind', { principalKind: 'robot' as WakeWatchInsert['principalKind'] }],
        ['wake user not hex', { wakeUser: 'zz' }],
        ['wake user upper case', { wakeUser: user(10).toUpperCase().replace(/0/g, 'A') }],
        ['empty subscription', { wsSubscriptionId: '' }],
        ['subscription of 201', { wsSubscriptionId: 's'.repeat(201) }],
      ];
      const outcomes: string[] = [];
      for (const [label, extra] of tries) {
        outcomes.push(`${label}: ${await engine.openWakeWatch(watch(extra)).then(() => 'recorded', () => 'refused')}`);
      }
      const edge = await engine.openWakeWatch(watch({ event: `gbrain.${'a'.repeat(48)}`, target: 'x'.repeat(128), wsSubscriptionId: 's'.repeat(200) })).then(() => 'recorded', () => 'refused');
      const kept = await engine.listWakeWatches(mine);
      expect(outcomes.every(o => o.endsWith('refused'))).toBe(true);
      expect(edge).toBe('recorded');
      expect(kept).toHaveLength(1);
      return { outcomes, edge, kept: kept.map(r => [r.event.length, r.target.length, r.ws_subscription_id.length]) };
    });

  parityTest('listWakeWatches holds one principal, newest first, 50 at most, a NULL member matching only a NULL member',
    { methods: ['openWakeWatch', 'listWakeWatches', 'endWakeWatches'] }, async (engine) => {
      const ids: number[] = [];
      for (let i = 0; i < 52; i++) ids.push(await engine.openWakeWatch(watch({ target: String(i) })));
      await engine.openWakeWatch(watch({ principalId: 'someone-else', target: 'p' }));
      await engine.openWakeWatch(watch({ principalKind: 'oauth_client', target: 'k' }));
      await engine.openWakeWatch(watch({ memberId: 'm-1', target: 'm1' }));
      await engine.openWakeWatch(watch({ event: CRON_FINISHED, target: 'nightly' }));
      const base = ids[0]!;
      const rel = (rows: WakeWatchRow[]) => rows.map(r => r.id - base);
      const newest = rel(await engine.listWakeWatches(mine));
      const ended = (await engine.endWakeWatches({ reason: 'unwatched', id: ids[51]! })).map(r => r.id - base);
      const openOnly = rel(await engine.listWakeWatches({ ...mine, scope: 'open' }));
      const recent = await engine.listWakeWatches(mine);
      const answers = {
        newest, ended,
        openOnly: [openOnly.length, openOnly[0], openOnly.at(-1)],
        recent: [recent.length, recent[0]!.id - base, recent[1]!.id - base, recent[1]!.state],
        otherPrincipal: rel(await engine.listWakeWatches({ ...mine, principalId: 'someone-else' })),
        otherKind: rel(await engine.listWakeWatches({ ...mine, principalKind: 'oauth_client' })),
        member: rel(await engine.listWakeWatches({ ...mine, memberId: 'm-1' })),
        nobody: (await engine.listWakeWatches({ ...mine, memberId: 'm-none' })).length,
        byTarget: rel(await engine.listWakeWatches({ ...mine, event: CRON_FINISHED, target: 'nightly' })),
        byTargetWrongEvent: (await engine.listWakeWatches({ ...mine, event: JOB_FINISHED, target: 'nightly' })).length,
        byId: rel(await engine.listWakeWatches({ ...mine, id: ids[7]! })),
        byIdOtherPrincipal: (await engine.listWakeWatches({ ...mine, principalId: 'someone-else', id: ids[7]! })).length,
      };
      // 52 own watches (0..51), then the other principal (52), the other kind (53), the member (54) and a cron watch (55)
      // that is this principal's own NULL-member row: the newest 50 are 55, then 51 down to 3.
      expect(newest).toEqual([55, ...Array.from({ length: 49 }, (_, i) => 51 - i)]);
      expect(answers.openOnly).toEqual([50, 55, 2]);
      expect(answers.recent).toEqual([50, 55, 51, 'ended']);
      expect(answers.otherPrincipal).toEqual([52]);
      expect(answers.otherKind).toEqual([53]);
      expect(answers.member).toEqual([54]);
      expect(answers.nobody).toBe(0);
      expect(answers.byTarget).toEqual([55]);
      expect(answers.byId).toEqual([7]);
      return answers;
    });

  parityTest('endWakeWatches ends the open watches for each reason and leaves delivered and already ended ones alone',
    { methods: ['openWakeWatch', 'listWakeWatches', 'endWakeWatches', 'claimWakeWatch', 'settleWakeWatch'] }, async (engine) => {
      const unwatched = await engine.openWakeWatch(watch());
      const expired = await engine.openWakeWatch(watch({ expiresAt: '2000-01-01T00:00:00.000Z' }));
      const live = await engine.openWakeWatch(watch());
      const delivered = await engine.openWakeWatch(watch({ expiresAt: '2000-01-01T00:00:00.000Z' }));
      await settleTo(engine, delivered, 'delivered', { marker: 'done' });
      const base = unwatched;
      const rel = (rows: Array<{ id: number }>) => rows.map(r => r.id - base).sort((a, b) => a - b);
      const answers = {
        unwatchedOther: rel(await engine.endWakeWatches({ reason: 'unwatched', id: 999_999 })),
        unwatched: rel(await engine.endWakeWatches({ reason: 'unwatched', id: unwatched })),
        unwatchedAgain: rel(await engine.endWakeWatches({ reason: 'unwatched', id: unwatched })),
        expired: rel(await engine.endWakeWatches({ reason: 'expired' })),
        expiredAgain: rel(await engine.endWakeWatches({ reason: 'expired' })),
        stateBeforeDisable: (await engine.listWakeWatches(mine)).map(r => [r.id - base, r.state, r.last_error]),
        disabled: rel(await engine.endWakeWatches({ reason: 'disabled' })),
        disabledAgain: rel(await engine.endWakeWatches({ reason: 'disabled' })),
        final: (await engine.listWakeWatches(mine)).map(r => [r.id - base, r.state, r.last_error]),
      };
      expect(answers.unwatched).toEqual([0]);
      expect(answers.unwatchedAgain).toEqual([]);
      expect(answers.expired).toEqual([1]);
      expect(answers.expiredAgain).toEqual([]);
      expect(answers.disabled).toEqual([live - base]);
      expect(answers.disabledAgain).toEqual([]);
      expect(answers.final).toEqual([[3, 'delivered', null], [2, 'ended', 'disabled'], [1, 'ended', 'expired'], [0, 'ended', 'unwatched']]);
      return answers;
    });

  parityTest('countWakeWatches and readWakeDoctor group the watches by state and last error, the doctor over open and 7-day rows',
    { methods: ['openWakeWatch', 'endWakeWatches', 'claimWakeWatch', 'settleWakeWatch', 'countWakeWatches', 'readWakeDoctor'] }, async (engine) => {
      expect(await engine.countWakeWatches()).toEqual([]);
      expect(await engine.readWakeDoctor()).toEqual({ watches: [], unregistered: [], stale_forgets: 0, dead_forgets: 0 });
      await engine.openWakeWatch(watch());
      await engine.openWakeWatch(watch());
      const delivered = await engine.openWakeWatch(watch());
      const unwatched = await engine.openWakeWatch(watch());
      const reusedA = await engine.openWakeWatch(watch());
      const reusedB = await engine.openWakeWatch(watch());
      const network = await engine.openWakeWatch(watch());
      const quiet = await engine.openWakeWatch(watch());
      await settleTo(engine, delivered, 'delivered');
      await engine.endWakeWatches({ reason: 'unwatched', id: unwatched });
      await settleTo(engine, reusedA, 'dead', { error: 'id_reused' });
      await settleTo(engine, reusedB, 'dead', { error: 'id_reused' });
      await settleTo(engine, network, 'dead', { error: 'network' });
      await settleTo(engine, quiet, 'ended');
      const counts = await engine.countWakeWatches();
      const doctor = await engine.readWakeDoctor();
      expect(counts).toEqual([
        { state: 'dead', last_error: 'id_reused', n: 2 }, { state: 'dead', last_error: 'network', n: 1 },
        { state: 'delivered', last_error: null, n: 1 },
        { state: 'ended', last_error: 'unwatched', n: 1 }, { state: 'ended', last_error: null, n: 1 },
        { state: 'open', last_error: null, n: 2 },
      ]);
      expect(doctor.watches).toEqual([
        { state: 'dead', id_reused: false, n: 1 }, { state: 'dead', id_reused: true, n: 2 },
        { state: 'delivered', id_reused: null, n: 1 },
        { state: 'ended', id_reused: false, n: 1 }, { state: 'ended', id_reused: null, n: 1 },
        { state: 'open', id_reused: null, n: 2 },
      ]);
      return { counts, doctor };
    });
});

describe('engine parity: wake crons, runs and terms', () => {
  parityTest('the cron registry lists names in byte order with each last run, keeps runs 30 days, and says whether a run was for a registered name',
    { methods: ['addWakeCron', 'hasWakeCron', 'listWakeCrons', 'recordWakeCronRun'] }, async (engine) => {
      for (const name of ['cx', 'c.two', 'c-x', 'c.four', 'c.one', 'c.three']) await engine.addWakeCron(name);
      await engine.addWakeCron('c.one');
      const unregistered = await engine.recordWakeCronRun({ name: 'nope', status: 'ok', finishedAt: null });
      const registered = await engine.recordWakeCronRun({ name: 'c.four', status: 'failed', finishedAt: null });
      // c.one: a failed and an ok run at one instant (the later row is the last), an older run recorded last, and a duplicate.
      await engine.recordWakeCronRun({ name: 'c.one', status: 'ok', finishedAt: FAR_B });
      await engine.recordWakeCronRun({ name: 'c.one', status: 'failed', finishedAt: FAR_B });
      await engine.recordWakeCronRun({ name: 'c.one', status: 'ok', finishedAt: '2097-01-01T00:00:00.000Z' });
      await engine.recordWakeCronRun({ name: 'c.one', status: 'failed', finishedAt: FAR_B });
      const old = ago(40);
      const kept = ago(20);
      await engine.recordWakeCronRun({ name: 'c.two', status: 'ok', finishedAt: old });
      await engine.recordWakeCronRun({ name: 'c.three', status: 'ok', finishedAt: kept });
      const listed = await engine.listWakeCrons();
      const answers = {
        unregistered, registered,
        has: [await engine.hasWakeCron('c.one'), await engine.hasWakeCron('nope'), await engine.hasWakeCron('C.ONE')],
        created: listed.map(c => c.created_at instanceof Date),
        finished: listed.map(c => c.name === 'c.four' ? 'now' : c.name === 'c.three' ? iso(c.last_finished_at) === kept : iso(c.last_finished_at)),
      };
      expect(listed.map(c => c.name)).toEqual(['c-x', 'c.four', 'c.one', 'c.three', 'c.two', 'cx']);
      expect(listed.map(c => c.last_status)).toEqual([null, 'failed', 'failed', 'ok', null, null]);
      expect(iso(listed[2]!.last_finished_at)).toBe(FAR_B);
      expect(iso(listed[3]!.last_finished_at)).toBe(kept);
      expect(unregistered).toEqual({ registered: false });
      expect(registered).toEqual({ registered: true });
      return answers;
    });

  parityTest('removeWakeCron unregisters a name and ends only the open watches on that cron',
    { methods: ['addWakeCron', 'hasWakeCron', 'removeWakeCron', 'openWakeWatch', 'listWakeWatches', 'endWakeWatches'] }, async (engine) => {
      await engine.addWakeCron('c.one');
      await engine.addWakeCron('c.two');
      const a = await engine.openWakeWatch(watch({ event: CRON_FINISHED, target: 'c.one' }));
      const b = await engine.openWakeWatch(watch({ event: CRON_FINISHED, target: 'c.one', wakeUser: user(2) }));
      const gone = await engine.openWakeWatch(watch({ event: CRON_FINISHED, target: 'c.one' }));
      await engine.endWakeWatches({ reason: 'unwatched', id: gone });
      const twoCron = await engine.openWakeWatch(watch({ event: CRON_FINISHED, target: 'c.two' }));
      const sameNameJob = await engine.openWakeWatch(watch({ event: JOB_FINISHED, target: 'c.one' }));
      const removed = (await engine.removeWakeCron('c.one')).sort((x, y) => x.id - y.id);
      const removedAgain = await engine.removeWakeCron('c.one');
      const unknown = await engine.removeWakeCron('never.registered');
      const rows = (await engine.listWakeWatches(mine)).map(r => [r.id - a, r.event === CRON_FINISHED ? 'cron' : 'job', r.target, r.state, r.last_error]);
      const answers = {
        removed: removed.map(r => [r.id - a, r.wake_user, r.ws_subscription_id.startsWith('ws-')]),
        removedAgain, unknown, rows,
        has: [await engine.hasWakeCron('c.one'), await engine.hasWakeCron('c.two')],
      };
      expect(removed.map(r => r.id)).toEqual([a, b]);
      expect(answers.has).toEqual([false, true]);
      expect(rows).toEqual([
        [twoCron + 1 - a, 'job', 'c.one', 'open', null], [twoCron - a, 'cron', 'c.two', 'open', null],
        [2, 'cron', 'c.one', 'ended', 'unwatched'], [1, 'cron', 'c.one', 'ended', 'cron_removed'], [0, 'cron', 'c.one', 'ended', 'cron_removed'],
      ]);
      void sameNameJob;
      return answers;
    });

  parityTest('the doctor reads cron runs of unregistered names in the last 7 days, in byte order, and dead forgets in 30 days',
    { methods: ['addWakeCron', 'recordWakeCronRun', 'readWakeDoctor', 'queueWakeForget', 'claimWakeForgets', 'settleWakeForget', 'countPendingWakeForgets'] }, async (engine) => {
      await engine.addWakeCron('reg');
      for (const [name, status, at] of [['zz.job', 'ok', null], ['a-b', 'failed', null], ['ab', 'ok', null], ['a-b', 'ok', null], ['reg', 'ok', null],
        ['old.run', 'ok', ago(8)], ['late.run', 'failed', ago(6)]] as const) {
        await engine.recordWakeCronRun({ name, status, finishedAt: at });
      }
      await engine.queueWakeForget(user(1), null);
      await engine.queueWakeForget(user(2), null);
      const claims = (await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 })).sort((x, y) => x.id - y.id);
      await engine.settleWakeForget({ id: claims[0]!.id, lease: claims[0]!.lease, state: 'dead', attempts: 5, error: 'refused' });
      await engine.settleWakeForget({ id: claims[1]!.id, lease: claims[1]!.lease, state: 'done', attempts: 1, error: null });
      const doctor = await engine.readWakeDoctor();
      expect(doctor.unregistered).toEqual(['a-b', 'ab', 'late.run', 'zz.job']);
      expect(doctor.dead_forgets).toBe(1);
      expect(doctor.stale_forgets).toBe(0);
      expect(await engine.countPendingWakeForgets()).toBe(0);
      return doctor;
    });

  parityTest('terms acceptances are recorded once per principal key and version, and a malformed one is refused',
    { methods: ['hasWakeTermsAcceptance', 'recordWakeTermsAcceptance'] }, async (engine) => {
      const v1 = 'a'.repeat(16);
      const v2 = 'b'.repeat(16);
      const before = await engine.hasWakeTermsAcceptance('member:m-1', v1);
      await engine.recordWakeTermsAcceptance('member:m-1', v1);
      await engine.recordWakeTermsAcceptance('member:m-1', v1);
      const answers = {
        before,
        after: await engine.hasWakeTermsAcceptance('member:m-1', v1),
        otherVersion: await engine.hasWakeTermsAcceptance('member:m-1', v2),
        otherKey: await engine.hasWakeTermsAcceptance('member:m-2', v1),
        badVersion: await engine.recordWakeTermsAcceptance('member:m-1', 'xyz').then(() => 'recorded', () => 'refused'),
        upperVersion: await engine.recordWakeTermsAcceptance('member:m-1', 'A'.repeat(16)).then(() => 'recorded', () => 'refused'),
        emptyKey: await engine.recordWakeTermsAcceptance('', v1).then(() => 'recorded', () => 'refused'),
        longKey: await engine.recordWakeTermsAcceptance('k'.repeat(301), v1).then(() => 'recorded', () => 'refused'),
        edgeKey: await engine.recordWakeTermsAcceptance('k'.repeat(300), v1).then(() => 'recorded', () => 'refused'),
        edgeRead: await engine.hasWakeTermsAcceptance('k'.repeat(300), v1),
        badRead: await engine.hasWakeTermsAcceptance('member:m-1', 'xyz'),
      };
      expect(answers).toEqual({
        before: false, after: true, otherVersion: false, otherKey: false, badVersion: 'refused', upperVersion: 'refused',
        emptyKey: 'refused', longKey: 'refused', edgeKey: 'recorded', edgeRead: true, badRead: false,
      });
      return answers;
    });
});

/** The ids (relative to `base`) of the watches the drainer finds due, in the order it reads them. */
const dueIds = async (engine: BrainEngine, base: number, ids?: number[]) => (await engine.listDueWakeWatches(ids ? { ids } : {})).map(r => r.id - base);

describe('engine parity: due wake watches', () => {
  parityTest('listDueWakeWatches finds the job watches whose job ended, or is gone, and joins the job by its numeric target',
    { methods: ['openWakeWatch', 'listDueWakeWatches', 'admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'getJob'] }, async (engine) => {
      const done = await jobIn(engine, 'wake-done', 'completed');
      const failed = await jobIn(engine, 'wake-failed', 'failed');
      const dead = await jobIn(engine, 'wake-dead', 'dead');
      const cancelled = await jobIn(engine, 'wake-cancelled', 'cancelled');
      const waiting = await jobIn(engine, 'wake-waiting', 'waiting');
      const active = await jobIn(engine, 'wake-active', 'active');
      const targets = [
        ...[done, failed, dead, cancelled, waiting, active].map(id => [String(id), String(id)] as const),
        ['missing', '99999999'], ['not a number', 'abc'], ['19 digits', '1234567890123456789'], ['zero padded', `000${done}`], ['empty digits', '12a'],
      ];
      const first = await engine.openWakeWatch(watch({ target: targets[0]![1] }));
      const ids = [first];
      for (const [, target] of targets.slice(1)) ids.push(await engine.openWakeWatch(watch({ target })));
      const due = await engine.listDueWakeWatches();
      const byLabel = new Map(due.map(r => [r.id - first, r]));
      const answers: Record<string, unknown> = { due: due.map(r => r.id - first) };
      const jobs = new Map<number, Awaited<ReturnType<BrainEngine['getJob']>>>();
      for (const id of [done, failed, dead, cancelled]) jobs.set(id, await engine.getJob(id));
      for (const [i, [label]] of targets.entries()) {
        const row = byLabel.get(i);
        const job = row?.job_id == null ? null : jobs.get(row.job_id);
        answers[`row ${i} ${label}`] = row && {
          shape: [row.event, row.target, row.target_ref, row.principal_kind, row.principal_id, row.member_id, row.wake_user, row.attempts],
          created: /^\d{16}$/.test(row.created_us),
          job: row.job_id === null ? null : [row.job_name, row.job_status, row.job_id === done],
          times: job ? [iso(row.started_at) === iso(job.started_at), iso(row.finished_at) === iso(job.finished_at), sameInstant(row.finished_us, job.finished_at)] : [row.started_at, row.finished_at, row.finished_us],
          other: [row.req_id, row.req_state, row.req_operation, row.req_source_id, row.req_created_at, row.req_settled_at, row.req_settled_us, row.run_id, row.run_status, row.run_finished_at],
        };
      }
      expect(due.map(r => r.id - first)).toEqual([0, 1, 2, 3, 6, 7, 8, 9, 10]);
      expect(typeof due[0]!.id).toBe('number');
      return answers;
    });

  parityTest('listDueWakeWatches finds a write watch once its request settled or is gone, and reads the request it joined',
    { methods: ['openWakeWatch', 'listDueWakeWatches', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'readWriteRequestById'] }, async (engine) => {
      const states = ['queued', 'running', 'committed', 'failed', 'conflict', 'cancelled'] as const;
      const requests: string[] = [];
      for (const [i, state] of states.entries()) requests.push(await requestIn(engine, i + 1, state));
      const refs: Array<[string, string | null]> = [
        ...requests.map((id, i): [string, string | null] => [states[i]!, id]),
        ['unknown uuid', 'b0000000-0000-4000-8000-0000000000ff'], ['null ref', null], ['not a uuid', 'not-a-uuid'], ['upper case uuid', requests[2]!.toUpperCase()],
      ];
      const first = await engine.openWakeWatch(watch({ event: WRITE_SETTLED, target: refs[0]![1] ?? 'none', targetRef: refs[0]![1] }));
      for (const [, ref] of refs.slice(1)) await engine.openWakeWatch(watch({ event: WRITE_SETTLED, target: ref ?? 'none', targetRef: ref }));
      const due = await engine.listDueWakeWatches();
      const answers: Record<string, unknown> = { due: due.map(r => r.id - first) };
      for (const [i, [label]] of refs.entries()) {
        const row = due.find(r => r.id - first === i);
        const stored = i < states.length ? await engine.readWriteRequestById(requests[i]!) : null;
        answers[`row ${i} ${label}`] = row && {
          req: [row.req_id === (stored?.id ?? null), row.req_state, row.req_operation, row.req_source_id],
          created: stored ? iso(row.req_created_at) === iso(stored.created_at) : row.req_created_at,
          settled: stored ? [iso(row.req_settled_at) === iso(stored.completed_at ?? stored.updated_at), sameInstant(row.req_settled_us, stored.completed_at ?? stored.updated_at)] : [row.req_settled_at, row.req_settled_us],
          job: [row.job_id, row.run_id],
        };
      }
      expect(due.map(r => r.id - first)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      return answers;
    });

  parityTest('listDueWakeWatches finds a cron watch for the first run at or after it began, by time and then id, and never for a cron without one',
    { methods: ['openWakeWatch', 'listDueWakeWatches', 'addWakeCron', 'recordWakeCronRun'] }, async (engine) => {
      for (const name of ['c.none', 'c.old', 'c.now', 'c.first', 'c.tie']) await engine.addWakeCron(name);
      const names = ['c.none', 'c.old', 'c.now', 'c.first', 'c.tie', 'c.unregistered'];
      const first = await engine.openWakeWatch(watch({ event: CRON_FINISHED, target: names[0]! }));
      for (const target of names.slice(1)) await engine.openWakeWatch(watch({ event: CRON_FINISHED, target }));
      // a run before the watch began does not count; one after it does
      // an hour before the watch began: old enough to miss it, recent enough that the 30-day clean-up keeps it
      await engine.recordWakeCronRun({ name: 'c.old', status: 'ok', finishedAt: new Date(Date.now() - 3600_000).toISOString() });
      await engine.recordWakeCronRun({ name: 'c.now', status: 'failed', finishedAt: null });
      // the later run was recorded first: the first by time (not by id) is the watch's run
      await engine.recordWakeCronRun({ name: 'c.first', status: 'ok', finishedAt: FAR });
      await engine.recordWakeCronRun({ name: 'c.first', status: 'failed', finishedAt: FAR_B });
      await engine.recordWakeCronRun({ name: 'c.tie', status: 'failed', finishedAt: FAR_B });
      await engine.recordWakeCronRun({ name: 'c.tie', status: 'ok', finishedAt: FAR_B });
      const due = await engine.listDueWakeWatches();
      const runs = due.map(r => [r.id - first, r.target, r.run_status, r.run_finished_at === null ? null : r.target === 'c.now' ? 'now' : iso(r.run_finished_at), r.job_id, r.req_id]);
      const runIds = due.map(r => r.run_id);
      expect(due.map(r => r.target)).toEqual(['c.now', 'c.first', 'c.tie']);
      expect(runs).toEqual([[2, 'c.now', 'failed', 'now', null, null], [3, 'c.first', 'failed', FAR_B, null, null], [4, 'c.tie', 'failed', FAR_B, null, null]]);
      // the tie's first run is the lower id: the one recorded second for c.first is the id just before the tie's pair
      return { runs, runsAreInOrder: Number(runIds[1]) < Number(runIds[2]) };
    });

  parityTest('listDueWakeWatches reads at most 20 watches by due time then id, narrows to the ids asked for, and skips a leased or delayed watch',
    { methods: ['openWakeWatch', 'listDueWakeWatches', 'claimWakeWatch', 'settleWakeWatch', 'admitJob', 'claimNextJob', 'completeJob'] }, async (engine) => {
      const job = await jobIn(engine, 'wake-limit', 'completed');
      const ids: number[] = [];
      for (let i = 0; i < 22; i++) ids.push(await engine.openWakeWatch(watch({ target: String(job) })));
      const base = ids[0]!;
      const full = await dueIds(engine, base);
      await settleTo(engine, ids[0]!, 'open', { delayS: 0 });
      const afterRetry = await dueIds(engine, base);
      const claimed = await engine.claimWakeWatch(ids[1]!, 60);
      const whileLeased = await dueIds(engine, base);
      const answers = {
        full, afterRetry, whileLeased,
        some: await dueIds(engine, base, [ids[21]!, ids[5]!, 999_999]),
        none: await dueIds(engine, base, []),
        onlyLeased: await dueIds(engine, base, [ids[1]!]),
        afterRetryOnly: await dueIds(engine, base, [ids[0]!, ids[2]!]),
        claimed: claimed !== null,
      };
      expect(full).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(afterRetry).toEqual([1, ...Array.from({ length: 19 }, (_, i) => i + 2)]);
      expect(whileLeased).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
      expect(answers.some).toEqual([5, 21]);
      expect(answers.none).toEqual([]);
      expect(answers.onlyLeased).toEqual([]);
      expect(answers.afterRetryOnly).toEqual([2, 0]);
      return answers;
    });
});

describe('engine parity: wake watch and forget leases', () => {
  parityTest('claimWakeWatch leases an open due watch once, and settleWakeWatch applies only to the holder of the lease',
    { methods: ['openWakeWatch', 'listWakeWatches', 'listDueWakeWatches', 'claimWakeWatch', 'settleWakeWatch', 'endWakeWatches', 'admitJob', 'claimNextJob', 'completeJob'] }, async (engine) => {
      const job = await jobIn(engine, 'wake-lease', 'completed');
      const a = await engine.openWakeWatch(watch({ target: String(job) }));
      const b = await engine.openWakeWatch(watch({ target: String(job) }));
      const c = await engine.openWakeWatch(watch({ target: String(job) }));
      const gone = await engine.openWakeWatch(watch({ target: String(job) }));
      const base = a;
      const stateOf = async () => (await engine.listWakeWatches(mine)).map(r => [r.id - base, r.state, r.attempts, r.last_error]);
      const lease = await engine.claimWakeWatch(a, 60);
      const second = await engine.claimWakeWatch(a, 60);
      const wrong = await engine.settleWakeWatch({ id: a, lease: '0000000000000000', state: 'delivered' });
      const dueWhileLeased = await dueIds(engine, base, [a]);
      const delivered = await engine.settleWakeWatch({ id: a, lease: lease!.lease, state: 'delivered', marker: 'm-1', attempts: 2, error: null });
      const again = await engine.settleWakeWatch({ id: a, lease: lease!.lease, state: 'delivered' });
      const claimDelivered = await engine.claimWakeWatch(a, 60);
      const delayed = await engine.claimWakeWatch(b, 60);
      const delayedSettled = await engine.settleWakeWatch({ id: b, lease: delayed!.lease, state: 'open', attempts: 1, delayS: 3600, error: 'network' });
      const claimDelayed = await engine.claimWakeWatch(b, 60);
      const dueDelayed = await dueIds(engine, base, [b]);
      // a lease of 0 seconds lapses at once: the next claim takes it, and the old holder's settle loses
      const short = await engine.claimWakeWatch(c, 0);
      await Bun.sleep(5);
      const retaken = await engine.claimWakeWatch(c, 60);
      const staleSettle = await engine.settleWakeWatch({ id: c, lease: short!.lease, state: 'delivered' });
      const freshSettle = await engine.settleWakeWatch({ id: c, lease: retaken!.lease, state: 'dead', error: 'refused' });
      // an unwatch takes the lease away: the drainer's settle then loses
      const held = await engine.claimWakeWatch(gone, 60);
      await engine.endWakeWatches({ reason: 'unwatched', id: gone });
      const settleEnded = await engine.settleWakeWatch({ id: gone, lease: held!.lease, state: 'delivered' });
      const answers = {
        leaseShape: [LEASE.test(lease!.lease), lease!.attempts, LEASE.test(short!.lease), LEASE.test(retaken!.lease), retaken!.lease !== short!.lease],
        second, wrong, dueWhileLeased, delivered, again, claimDelivered, delayedSettled, claimDelayed, dueDelayed,
        staleSettle, freshSettle, settleEnded, final: await stateOf(),
      };
      expect(second).toBeNull();
      expect(wrong).toBe(false);
      expect(dueWhileLeased).toEqual([]);
      expect(delivered).toBe(true);
      expect(again).toBe(false);
      expect(claimDelivered).toBeNull();
      expect(delayedSettled).toBe(true);
      expect(claimDelayed).toBeNull();
      expect(dueDelayed).toEqual([]);
      expect(staleSettle).toBe(false);
      expect(freshSettle).toBe(true);
      expect(settleEnded).toBe(false);
      expect(answers.final).toEqual([[3, 'ended', 0, 'unwatched'], [2, 'dead', 0, 'refused'], [1, 'open', 1, 'network'], [0, 'delivered', 2, null]]);
      return answers;
    });

  parityTest('queueWakeForget queues one pending forget per user, claimWakeForgets leases them, and settleWakeForget applies only to the lease holder',
    { methods: ['queueWakeForget', 'claimWakeForgets', 'settleWakeForget', 'countPendingWakeForgets', 'readWakeDoctor'] }, async (engine) => {
      await engine.queueWakeForget(user(1), null);
      await engine.queueWakeForget(user(1), null);
      await engine.queueWakeForget(user(2), null);
      // a member id queues too while no access_members row names it live
      await engine.queueWakeForget(user(3), 'm-gone');
      const pending = await engine.countPendingWakeForgets();
      const one = await engine.claimWakeForgets({ leaseSeconds: 60, limit: 1 });
      const rest = (await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 })).sort((x, y) => x.id - y.id);
      const none = await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 });
      // the id sequence may be spent by the repeated queue, so ids are compared as ranks among the claimed rows
      const ranked = [one[0]!, ...rest].map(c => c.id);
      const base = (id: number) => ranked.indexOf(id);
      const lease = (c: { lease: string }) => LEASE.test(c.lease);
      const wrong = await engine.settleWakeForget({ id: one[0]!.id, lease: '0000000000000000', state: 'done', attempts: 1, error: null });
      const retry = await engine.settleWakeForget({ id: one[0]!.id, lease: one[0]!.lease, state: 'pending', attempts: 1, error: 'network', delayS: 3600 });
      const repeat = await engine.settleWakeForget({ id: one[0]!.id, lease: one[0]!.lease, state: 'pending', attempts: 1, error: 'network', delayS: 3600 });
      const claimDelayed = await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 });
      const done = await engine.settleWakeForget({ id: rest[0]!.id, lease: rest[0]!.lease, state: 'done', attempts: 1, error: null });
      const dead = await engine.settleWakeForget({ id: rest[1]!.id, lease: rest[1]!.lease, state: 'dead', attempts: 5, error: 'refused' });
      const pendingAfter = await engine.countPendingWakeForgets();
      await engine.queueWakeForget(user(2), null);
      const requeued = await engine.countPendingWakeForgets();
      const reclaimed = await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 });
      const doctor = await engine.readWakeDoctor();
      const answers = {
        pending, one: one.map(c => [base(c.id), c.wake_user, c.attempts, lease(c)]), rest: rest.map(c => [base(c.id), c.wake_user, c.attempts, lease(c)]),
        none, wrong, retry, repeat, claimDelayed, done, dead, pendingAfter, requeued,
        reclaimed: reclaimed.map(c => [c.wake_user, c.attempts]), dead_forgets: doctor.dead_forgets, stale_forgets: doctor.stale_forgets,
      };
      expect(pending).toBe(3);
      expect(one.map(c => c.wake_user)).toEqual([user(1)]);
      expect(rest.map(c => c.wake_user)).toEqual([user(2), user(3)]);
      expect(none).toEqual([]);
      expect([wrong, retry, repeat, done, dead]).toEqual([false, true, false, true, true]);
      expect(claimDelayed).toEqual([]);
      expect([pendingAfter, requeued]).toEqual([1, 2]);
      expect(reclaimed).toHaveLength(1);
      expect(doctor.dead_forgets).toBe(1);
      return answers;
    });
  parityTest('queueWakeForget with a member id queues only when no live access member has that id: a live or disabled member keeps its user, a removed or unknown one does not',
    { methods: ['queueWakeForget', 'countPendingWakeForgets', 'claimWakeForgets', 'insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember'] }, async (engine) => {
      const member = (id: string) => ({ id, displayName: null, email: null, kind: 'person' as const, groups: [], bindTokenId: null });
      await engine.insertAccessMember(member('live-example'));
      await engine.insertAccessMember(member('disabled-example'));
      await engine.setAccessMemberDisabled('disabled-example', true);
      await engine.insertAccessMember(member('removed-example'));
      await engine.tombstoneAccessMember('removed-example');
      await engine.queueWakeForget(user(1), 'live-example');
      await engine.queueWakeForget(user(2), 'disabled-example');
      // the id is compared exactly: a live member's id in another case is not that member
      await engine.queueWakeForget(user(3), 'LIVE-EXAMPLE');
      await engine.queueWakeForget(user(4), 'removed-example');
      await engine.queueWakeForget(user(5), 'unknown-example');
      const pending = await engine.countPendingWakeForgets();
      const queued = (await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 })).map(c => c.wake_user).sort();
      expect(queued).toEqual([user(3), user(4), user(5)]);
      expect(pending).toBe(3);
      return { pending, queued };
    });
  parityTest('forgetWakeMember queues a forget of each user the removed member watched under, ends its open watches and drops only its own terms acceptances',
    { methods: ['forgetWakeMember', 'openWakeWatch', 'endWakeWatches', 'listWakeWatches', 'queueWakeForget', 'claimWakeForgets', 'countPendingWakeForgets', 'recordWakeTermsAcceptance', 'hasWakeTermsAcceptance'] }, async (engine) => {
      const m1 = { memberId: 'm-1' };
      const twoSubs = [await engine.openWakeWatch(watch({ ...m1, wakeUser: user(1) })), await engine.openWakeWatch(watch({ ...m1, wakeUser: user(1) }))];
      const alreadyEnded = await engine.openWakeWatch(watch({ ...m1, wakeUser: user(4) }));
      await engine.endWakeWatches({ reason: 'unwatched', id: alreadyEnded });
      const pendingUser = await engine.openWakeWatch(watch({ ...m1, wakeUser: user(5) }));
      await engine.queueWakeForget(user(5), null);
      const otherMember = await engine.openWakeWatch(watch({ memberId: 'm-2', wakeUser: user(6) }));
      const lookalike = await engine.openWakeWatch(watch({ memberId: 'm-10', wakeUser: user(8) }));
      const noMember = await engine.openWakeWatch(watch({ wakeUser: user(7) }));
      const v1 = 'a'.repeat(16);
      const v2 = 'b'.repeat(16);
      for (const [key, version] of [['member:m-1', v1], ['member:m-1', v2], ['member:m-10', v1], ['member:m-2', v1], ['m-1', v1]] as const) {
        await engine.recordWakeTermsAcceptance(key, version);
      }
      const first = await engine.forgetWakeMember('m-1');
      const again = await engine.forgetWakeMember('m-1');
      const nobody = await engine.forgetWakeMember('m-none');
      const pending = await engine.countPendingWakeForgets();
      const claimed = (await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 })).map(c => c.wake_user).sort();
      const stateOf = async (memberId: string | null, id: number) => {
        const [row] = await engine.listWakeWatches({ ...mine, memberId, id });
        return row ? [row.state, row.last_error] : null;
      };
      const answers = {
        first, again, nobody, pending, claimed,
        watches: {
          twoSubs: [await stateOf('m-1', twoSubs[0]!), await stateOf('m-1', twoSubs[1]!)],
          alreadyEnded: await stateOf('m-1', alreadyEnded),
          pendingUser: await stateOf('m-1', pendingUser),
          otherMember: await stateOf('m-2', otherMember),
          lookalike: await stateOf('m-10', lookalike),
          noMember: await stateOf(null, noMember),
        },
        terms: {
          m1v1: await engine.hasWakeTermsAcceptance('member:m-1', v1),
          m1v2: await engine.hasWakeTermsAcceptance('member:m-1', v2),
          m10: await engine.hasWakeTermsAcceptance('member:m-10', v1),
          m2: await engine.hasWakeTermsAcceptance('member:m-2', v1),
          bare: await engine.hasWakeTermsAcceptance('m-1', v1),
        },
      };
      // users 1 and 4 are queued (4's watch had already ended); user 5 had a forget pending; the three open m-1 watches end
      expect(first).toEqual({ ended: 3, queued: 2 });
      expect(again).toEqual({ ended: 0, queued: 0 });
      expect(nobody).toEqual({ ended: 0, queued: 0 });
      expect(pending).toBe(3);
      expect(claimed).toEqual([user(1), user(4), user(5)]);
      const revoked = ['ended', 'principal_revoked'];
      expect(answers.watches).toEqual({
        twoSubs: [revoked, revoked], alreadyEnded: ['ended', 'unwatched'], pendingUser: revoked,
        otherMember: ['open', null], lookalike: ['open', null], noMember: ['open', null],
      });
      expect(answers.terms).toEqual({ m1v1: false, m1v2: false, m10: true, m2: true, bare: true });
      return answers;
    });
  const revoked = ['ended', 'principal_revoked'];
  const watchOf = (engine: BrainEngine, principalKind: WakeWatchInsert['principalKind'], principalId: string) =>
    async (memberId: string | null, id: number) => {
      const [row] = await engine.listWakeWatches({ principalKind, principalId, memberId, scope: 'open_or_recent', id });
      return row ? [row.state, row.last_error] : null;
    };
  parityTest('forgetWakeCredential for a deleted OAuth client queues its member-less users, ends all its open watches and drops only its own terms acceptances',
    { methods: ['forgetWakeCredential', 'openWakeWatch', 'endWakeWatches', 'listWakeWatches', 'queueWakeForget', 'claimWakeForgets', 'countPendingWakeForgets', 'recordWakeTermsAcceptance', 'hasWakeTermsAcceptance'] }, async (engine) => {
      const c = { principalKind: 'oauth_client', principalId: 'client-A' } as const;
      const bare = await engine.openWakeWatch(watch({ ...c, wakeUser: user(1) }));
      const bound = await engine.openWakeWatch(watch({ ...c, memberId: 'm-1', wakeUser: user(2) }));
      const alreadyEnded = await engine.openWakeWatch(watch({ ...c, wakeUser: user(3) }));
      await engine.endWakeWatches({ reason: 'unwatched', id: alreadyEnded });
      const pendingUser = await engine.openWakeWatch(watch({ ...c, wakeUser: user(4) }));
      await engine.queueWakeForget(user(4), null);
      const otherCase = await engine.openWakeWatch(watch({ principalKind: 'oauth_client', principalId: 'client-a', wakeUser: user(5) }));
      const otherKind = await engine.openWakeWatch(watch({ principalKind: 'legacy_token', principalId: 'client-A', wakeUser: user(6) }));
      const v1 = 'a'.repeat(16);
      const keys = ['oauth_client:client-A', 'oauth_client:client-AB', 'oauth_client:client-a', 'legacy_token:client-A', 'client-A'];
      for (const key of keys) await engine.recordWakeTermsAcceptance(key, v1);
      const first = await engine.forgetWakeCredential('oauth_client', 'client-A');
      const again = await engine.forgetWakeCredential('oauth_client', 'client-A');
      const nobody = await engine.forgetWakeCredential('oauth_client', 'client-none');
      const pending = await engine.countPendingWakeForgets();
      const claimed = (await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 })).map(r => r.wake_user).sort();
      const stateOf = watchOf(engine, 'oauth_client', 'client-A');
      const answers = {
        first, again, nobody, pending, claimed,
        watches: {
          bare: await stateOf(null, bare), bound: await stateOf('m-1', bound), alreadyEnded: await stateOf(null, alreadyEnded),
          pendingUser: await stateOf(null, pendingUser), otherCase: await watchOf(engine, 'oauth_client', 'client-a')(null, otherCase),
          otherKind: await watchOf(engine, 'legacy_token', 'client-A')(null, otherKind),
        },
        terms: Object.fromEntries(await Promise.all(keys.map(async k => [k, await engine.hasWakeTermsAcceptance(k, v1)] as const))),
      };
      // users 1 and 3 queue (3's watch had ended); user 2 rode a member and outlives the client; user 4 had a forget pending
      expect(first).toEqual({ ended: 3, queued: 2 });
      expect(again).toEqual({ ended: 0, queued: 0 });
      expect(nobody).toEqual({ ended: 0, queued: 0 });
      expect(pending).toBe(3);
      expect(claimed).toEqual([user(1), user(3), user(4)]);
      expect(answers.watches).toEqual({
        bare: revoked, bound: revoked, alreadyEnded: ['ended', 'unwatched'], pendingUser: revoked,
        otherCase: ['open', null], otherKind: ['open', null],
      });
      expect(answers.terms).toEqual({
        'oauth_client:client-A': false, 'oauth_client:client-AB': true, 'oauth_client:client-a': true, 'legacy_token:client-A': true, 'client-A': true,
      });
      return answers;
    });
  parityTest('forgetWakeCredential for a revoked legacy token matches the token id in lower case and leaves other tokens alone',
    { methods: ['forgetWakeCredential', 'openWakeWatch', 'listWakeWatches', 'claimWakeForgets', 'countPendingWakeForgets', 'recordWakeTermsAcceptance', 'hasWakeTermsAcceptance'] }, async (engine) => {
      const id = 'abcdef01-2345-6789-abcd-ef0123456789';
      const t = { principalKind: 'legacy_token', principalId: id } as const;
      const bare = await engine.openWakeWatch(watch({ ...t, wakeUser: user(1) }));
      const bound = await engine.openWakeWatch(watch({ ...t, memberId: 'm-1', wakeUser: user(2) }));
      const otherToken = await engine.openWakeWatch(watch({ principalKind: 'legacy_token', principalId: id.replace('a', 'b'), wakeUser: user(3) }));
      const sameIdClient = await engine.openWakeWatch(watch({ principalKind: 'oauth_client', principalId: id, wakeUser: user(4) }));
      const v1 = 'a'.repeat(16);
      const keys = [`legacy_token:${id}`, `legacy_token:${id.toUpperCase()}`, `oauth_client:${id}`];
      for (const key of keys) await engine.recordWakeTermsAcceptance(key, v1);
      const first = await engine.forgetWakeCredential('legacy_token', id.toUpperCase());
      const again = await engine.forgetWakeCredential('legacy_token', id);
      const pending = await engine.countPendingWakeForgets();
      const claimed = (await engine.claimWakeForgets({ leaseSeconds: 60, limit: 10 })).map(r => r.wake_user).sort();
      const stateOf = watchOf(engine, 'legacy_token', id);
      const answers = {
        first, again, pending, claimed,
        watches: {
          bare: await stateOf(null, bare), bound: await stateOf('m-1', bound),
          otherToken: await watchOf(engine, 'legacy_token', id.replace('a', 'b'))(null, otherToken),
          sameIdClient: await watchOf(engine, 'oauth_client', id)(null, sameIdClient),
        },
        terms: Object.fromEntries(await Promise.all(keys.map(async k => [k, await engine.hasWakeTermsAcceptance(k, v1)] as const))),
      };
      expect(first).toEqual({ ended: 2, queued: 1 });
      expect(again).toEqual({ ended: 0, queued: 0 });
      expect(pending).toBe(1);
      expect(claimed).toEqual([user(1)]);
      expect(answers.watches).toEqual({ bare: revoked, bound: revoked, otherToken: ['open', null], sameIdClient: ['open', null] });
      expect(answers.terms).toEqual({ [`legacy_token:${id}`]: false, [`legacy_token:${id.toUpperCase()}`]: true, [`oauth_client:${id}`]: true });
      return answers;
    });

  parityTest('after revoke: a revoked token and a deleted client end their watches and are no longer live principals',
    { methods: ['insertAccessToken', 'insertOauthClient', 'openWakeWatch', 'listWakeWatches', 'accessTokenLive', 'oauthClientLive', 'revokeAccessToken', 'deleteOAuthClient', 'forgetWakeCredential'] }, async (engine) => {
      const grant = { source_grant: 'default', source_id: null, federated_read: null, allowed_operations: null, takes_holders: null };
      const token = await engine.insertAccessToken({ name: 'watcher', token_hash: hashToken('h-watcher'), scopes: ['read'], permissions: {}, ...grant });
      const other = await engine.insertAccessToken({ name: 'bystander', token_hash: hashToken('h-bystander'), scopes: ['read'], permissions: {}, ...grant });
      await engine.insertOauthClient({ client_id: 'client-watch', client_name: 'watching client', grant_types: ['client_credentials'] });
      const principal = (kind: 'legacy_token' | 'oauth_client', id: string) => ({ principal_kind: kind, principal_id: id, member_id: null });
      const tokenWatch = await engine.openWakeWatch(watch({ principalKind: 'legacy_token', principalId: token.id, wakeUser: user(1) }));
      const otherWatch = await engine.openWakeWatch(watch({ principalKind: 'legacy_token', principalId: other.id, wakeUser: user(2) }));
      const clientWatch = await engine.openWakeWatch(watch({ principalKind: 'oauth_client', principalId: 'client-watch', wakeUser: user(3) }));
      const liveNow = async () => ({
        token: await principalLive(engine, principal('legacy_token', token.id)), other: await principalLive(engine, principal('legacy_token', other.id)),
        client: await principalLive(engine, principal('oauth_client', 'client-watch')), nobody: await principalLive(engine, principal('oauth_client', 'client-none')),
      });
      const before = await liveNow();
      const revokedToken = await revokeLegacyTokenById(engine, token.id);
      const deleted = await engine.deleteOAuthClient('client-watch');
      if (deleted) await forgetWakePrincipal(engine, { kind: 'oauth_client', id: 'client-watch' });
      const stateOf = async (kind: WakeWatchInsert['principalKind'], id: string, watchId: number) => {
        const [row] = await engine.listWakeWatches({ principalKind: kind, principalId: id, memberId: null, scope: 'open_or_recent', id: watchId });
        return row ? [row.state, row.last_error] : null;
      };
      return {
        before, revokedToken, deleted, after: await liveNow(),
        watches: { token: await stateOf('legacy_token', token.id, tokenWatch), other: await stateOf('legacy_token', other.id, otherWatch), client: await stateOf('oauth_client', 'client-watch', clientWatch) },
      };
    });
});
