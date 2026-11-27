/**
 * BrainEngine parity — minion queue members beyond the job lifecycle (engine-sql/jobs-queue.ts): the single-job writes
 * (delete, pause, resume, parent resolve and fail, detach, progress, tokens, delay, watchdog release and mark), the
 * sweeps (delayed promotion, cancel, the two timeout kills, prune, retry), the dream synthesis completion archive the
 * prune keeps and its two reads, the inbox, the private-queue recovery reads, the stat and list reads, and job
 * attachments.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the queue's operator writes, sweeps, inbox, private-queue reads, stats and attachments return the same
 *    observable rows and counts on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts): which statuses a write moves from, that a stale lock token changes nothing, how a
 *    cancelled, killed or detached child wakes or fails its parent, which owner fence a cancel or a page read keeps,
 *    the order of every list, and what a delete takes with it.
 *  - Regression: an engine that drifts on a status guard (pause, resume, retry, delete), the token fence of progress,
 *    token counts, delay, watchdog release and the inbox, the cancel closure (descendants, reason only on requested
 *    roots, `child_done` to a live parent, the owner and actor fence), the two timeout sweeps (drain-lease beacon and
 *    lease guards, the parent notification), the prune cut-off and its dream-synthesis archive (which rows it keeps,
 *    under which source, first write wins, and the union and window of the two completion reads), the private-queue
 *    lease (never shrinks) and recovery state, the stat counts and bytewise family order, the page cursor, or the
 *    attachment uniqueness and cascade — the rules that keep a job from running twice or a parent from waiting forever.
 *  - Why existing coverage misses it: test/minions*.test.ts drive `MinionQueue` on PGLite only and reach these
 *    statements through the queue; nothing compares the engines on one scenario, and a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Expired states come from negative durations
 *    and past dates, or from cut-offs a case sets between two submissions, never from waiting out a clock. Ids are
 *    compared relative to the case's first job (sequences keep counting across resets on Postgres), and clock
 *    readings are compared only as present or absent. Submissions are 2 ms apart so created_at never ties.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues, JobRow } from '../../src/core/engine-sql/jobs.ts';
import type { JobAttachmentInsert, JobStatsRead, RetryJobPolicy } from '../../src/core/engine-sql/jobs-queue.ts';
import { APPLICATION_AUTHORITY, authorityDigest, authorizeJobExecution, coalesceDecision, parseSubmissionAuthority, prepareRemoteJob, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { WATCHDOG_SUSPECT_MARK } from '../../src/core/minions/watchdog-attribution.ts';
import { admitDelegatedRetry, checkDelegatedCapacity } from '../../src/core/minions/delegated-admission.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PAST = '2000-01-01T00:00:00.000Z';
const FAR = '2099-01-01T00:00:00.000Z';
const OTHER_AUTHORITY = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' } } as unknown as SubmissionAuthority;

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

/** The queue's policy for a caller holding `authority` (no delegated client). */
function policy(authority: SubmissionAuthority = APPLICATION_AUTHORITY): AdmitJobPolicy {
  return {
    decide: async (_tx, row) => coalesceDecision(row, authority),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  };
}

function admit(engine: BrainEngine, spec: Partial<AdmitJobSpec> & { insert: JobInsertValues }, authority?: SubmissionAuthority) {
  return engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy(authority));
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, { insert: values(name, extra) });
  expect(out.coalesced).toBe(false);
  // The claim and list orders break priority ties on created_at, which two quick submissions can share on PGLite.
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** A new job, claimed by `token` (the job's name is unique to the case, so the claim takes this row). */
async function active(engine: BrainEngine, name: string, token: string, extra: Partial<JobInsertValues> = {}, claim: Partial<ClaimJobSpec> = {}): Promise<number> {
  const id = await add(engine, name, extra);
  const row = await engine.claimNextJob(claimSpec(token, { names: [name], queue: extra.queue ?? 'default', ...claim }));
  expect(Number(row?.id)).toBe(id);
  return id;
}

/** A new job that ended as `how`. */
async function finished(engine: BrainEngine, name: string, how: 'completed' | 'failed' | 'dead', extra: Partial<JobInsertValues> = {}): Promise<number> {
  const id = await active(engine, name, `fin:${name}`, extra);
  if (how === 'completed') await engine.completeJob(id, `fin:${name}`);
  else await engine.failJob(id, `fin:${name}`, `${how} on purpose`, how);
  return id;
}

/** What a thrown error is, for comparing refusals across arms. */
function refusal(error: unknown) {
  const e = error as { name?: string; code?: unknown; message?: string };
  return { name: e.name, code: e.code ?? null, message: e.message };
}

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return refusal(error);
  }
}

/** Like `thrown`, but a typed refusal propagates, so the Rust arm counts it as refused instead of comparing it. */
async function denied(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') throw error;
    return refusal(error);
  }
}

/** Whether a call threw, for errors whose text names the engine's own driver (constraint messages differ by arm). */
async function threw(run: () => Promise<unknown>): Promise<boolean> {
  return (await thrown(run)) !== null;
}

const rel = (base: number) => (v: unknown) => (v == null ? null : Number(v) - base);
/** A lease is a fixed date a case set, or a reading of the clock (a renew) that is only compared as live. */
const leaseView = (v: unknown) => {
  const t = iso(v);
  return t === null || t === FAR || t === PAST ? t : 'clock';
};
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

/** A row as the engines must agree on it: ids relative to `base`, clock readings as present or absent. */
function rowView(base: number) {
  const r$ = rel(base);
  return (r: JobRow | null | undefined) => {
    if (!r) return null;
    const out: Record<string, unknown> = {
      id: r$(r.id), name: r.name, queue: r.queue, status: r.status, priority: r.priority, data: r.data, depth: r.depth,
      parent_job_id: r$(r.parent_job_id), on_child_fail: r.on_child_fail, max_children: r.max_children,
      attempts_made: r.attempts_made, attempts_started: Number(r.attempts_started), stalled_counter: r.stalled_counter,
      max_stalled: r.max_stalled, lock_token: r.lock_token, lock_duration_ms: r.lock_duration_ms, timeout_ms: r.timeout_ms,
      error_text: r.error_text, stacktrace: r.stacktrace, result: r.result, progress: r.progress,
      tokens: [Number(r.tokens_input), Number(r.tokens_output), Number(r.tokens_cache_read)],
      idempotency_key: r.idempotency_key, submission_authority: r.submission_authority,
      remove_on_complete: r.remove_on_complete, remove_on_fail: r.remove_on_fail,
      owner: r$(r.private_queue_owner_job_id), owner_token: r.private_queue_owner_token, lease: leaseView(r.private_queue_lease_until),
      has: Object.fromEntries(['lock_until', 'delay_until', 'timeout_at', 'started_at', 'finished_at'].map(k => [k, r[k] != null])),
    };
    if ('legacy_authority_is_null' in r) out.legacy_authority_is_null = r.legacy_authority_is_null;
    return out;
  };
}

/** Rows by ascending id, as views. */
function byId(rows: readonly JobRow[], base: number) {
  const view = rowView(base);
  return sorted(rows.map(r => view(r)!), r => String(r.id).padStart(8, '0'));
}

/** A payload with its `child_id` (an absolute job id) made relative to `base`. */
const relChild = (payload: unknown, base: number) => {
  const p = payload as Record<string, unknown> | null;
  return p && typeof p === 'object' && 'child_id' in p ? { ...p, child_id: Number(p.child_id) - base } : payload;
};

/** One inbox row: job id relative, clock readings as present or absent. The row id is left out: the SQL engines spend an identity value on a refused post and Rust does not, so ids differ by arm; the list order carries the sequence. */
function inboxView(jobBase: number) {
  return (r: JobRow) => ({
    job_id: Number(r.job_id) - jobBase, sender: r.sender, payload: relChild(r.payload, jobBase),
    sent: r.sent_at != null, read: r.read_at != null,
  });
}

/** `child_done` payloads with their child ids relative to `base`. */
const childDone = (base: number) => (payloads: unknown[]) =>
  payloads.map(p => ({ ...(p as Record<string, unknown>), child_id: Number((p as { child_id: unknown }).child_id) - base }));

function attachment(filename: string, bytes: number[], contentType = 'application/octet-stream'): JobAttachmentInsert {
  const buf = Uint8Array.from(bytes);
  return { filename, content_type: contentType, bytes: buf, size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** An attachment row: ids relative, the content as hex, the clock reading as present or absent. */
function attachmentView(jobBase: number, idBase: number) {
  return (r: JobRow | null | undefined) => {
    if (!r) return null;
    const out: Record<string, unknown> = {
      job_id: Number(r.job_id) - jobBase, filename: r.filename, content_type: r.content_type,
      storage_uri: r.storage_uri ?? null, size_bytes: Number(r.size_bytes), sha256: r.sha256, created: r.created_at != null,
    };
    if ('content' in r) out.content = Buffer.from(r.content as Uint8Array).toString('hex');
    return out;
  };
}

/** An authority carrying an accepted actor (`grant.actor`) and audience (`grant.actingFor`), as the owner fence reads it. */
function grantAuthority(grant: Record<string, unknown>): SubmissionAuthority {
  return { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' }, grant } as unknown as SubmissionAuthority;
}

/**
 * Jobs for the owner and actor fence (cancelJobs, listJobPage): the client that owns each, and the actor and audience
 * its authority was accepted for. Ids come back keyed by what makes each one different.
 */
async function ownerJobs(engine: BrainEngine) {
  const owned = (client: string) => ({ __owner_client_id: client });
  const actor = (a: Record<string, unknown>) => ({ actor: a });
  const sme = { system: 's', external_id: 'e', member: 'm' };
  const ids = {
    arrayAudience: await add(engine, 'fenced', { data: owned('client-a'), submission_authority: grantAuthority({ ...actor(sme), actingFor: ['b', 'a', 'a'] }) }),
    noAudience: await add(engine, 'fenced', { data: owned('client-a'), submission_authority: grantAuthority(actor(sme)) }),
    otherClient: await add(engine, 'fenced', { data: owned('client-b'), submission_authority: grantAuthority({ ...actor(sme), actingFor: ['a', 'b'] }) }),
    otherMember: await add(engine, 'fenced', { data: owned('client-a'), submission_authority: grantAuthority({ ...actor({ ...sme, member: 'x' }), actingFor: ['a', 'b'] }) }),
    noGrant: await add(engine, 'fenced', { data: owned('client-a') }),
    oddActor: await add(engine, 'fenced', { data: owned('client-a'), submission_authority: grantAuthority({ actor: { system: null, external_id: 42, member: 'm' }, actingFor: 'solo' }) }),
    unowned: await add(engine, 'fenced', { submission_authority: grantAuthority({ ...actor(sme), actingFor: ['a', 'b'] }) }),
  };
  return ids;
}

describe('engine parity: minion queue', () => {
  // ------------------------------------------------------------ writes on one job

  parityTest('deleteTerminalJob deletes only a finished job and takes its attachments, parent links and private-queue ownership',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'failParentJob', 'postInboxMessage', 'insertJobAttachment', 'listJobAttachmentNames', 'deleteTerminalJob', 'getJob'] }, async (engine) => {
      const waiting = await add(engine, 'live');
      const view = rowView(waiting);
      const running = await active(engine, 'running', 'w1:a');
      const done = await finished(engine, 'done', 'completed');
      const dead = await finished(engine, 'dead', 'dead');
      const failed = await finished(engine, 'failed', 'failed');
      const cancelledId = await add(engine, 'cancelled');
      await engine.cancelJobs([cancelledId]);
      await engine.postInboxMessage(done, 'cli', { note: 'hello' });
      await engine.insertJobAttachment(done, attachment('a.txt', [1, 2, 3]));
      // A failed parent with a live child, and a private queue member owned by a completed job.
      const parent = await add(engine, 'parent');
      const child = await add(engine, 'kid', { parent_job_id: parent });
      await engine.failParentJob(parent, 'parent gave up');
      const owner = await finished(engine, 'owner', 'completed');
      const member = await add(engine, 'member', { queue: 'dream-inline-1-aaaa', private_queue_owner_job_id: owner, private_queue_owner_token: 'tok', private_queue_lease_until: FAR });
      const memberBefore = (await engine.getJob(member))!;
      await Bun.sleep(5);
      const refused = { waiting: await engine.deleteTerminalJob(waiting), running: await engine.deleteTerminalJob(running), missing: await engine.deleteTerminalJob(waiting + 100_000) };
      const deleted = {
        done: await engine.deleteTerminalJob(done), again: await engine.deleteTerminalJob(done), dead: await engine.deleteTerminalJob(dead),
        failed: await engine.deleteTerminalJob(failed), cancelled: await engine.deleteTerminalJob(cancelledId),
        parent: await engine.deleteTerminalJob(parent), owner: await engine.deleteTerminalJob(owner),
      };
      const memberAfter = (await engine.getJob(member))!;
      return {
        refused, deleted,
        waiting: view(await engine.getJob(waiting)), running: view(await engine.getJob(running)),
        doneRow: await engine.getJob(done), attachments: await engine.listJobAttachmentNames(done),
        child: view(await engine.getJob(child)), member: view(memberAfter),
        // The ownership link clears without a fresh update stamp.
        memberStamp: memberAfter.updated_at instanceof Date && (memberAfter.updated_at as Date).getTime() === (memberBefore.updated_at as Date).getTime(),
      };
    });

  parityTest('pauseJob pauses a waiting, active or delayed job and clears its lock; resumeJob returns only a paused job to waiting',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'pauseJob', 'resumeJob', 'getJob'] }, async (engine) => {
      const waiting = await add(engine, 'wait');
      const view = rowView(waiting);
      const running = await active(engine, 'run', 'w1:a');
      const delayed = await add(engine, 'later', { status: 'delayed', delay_until: FAR });
      const done = await finished(engine, 'done', 'completed');
      const pausedWaiting = await engine.pauseJob(waiting);
      const pausedRunning = await engine.pauseJob(running);
      const pausedDelayed = await engine.pauseJob(delayed);
      const result = {
        pausedWaiting: view(pausedWaiting), pausedRunning: view(pausedRunning), pausedDelayed: view(pausedDelayed),
        again: view(await engine.pauseJob(waiting)), done: view(await engine.pauseJob(done)), missing: await engine.pauseJob(waiting + 100_000),
        staleComplete: await engine.completeJob(running, 'w1:a'),
      };
      const resumed = await engine.resumeJob(waiting);
      return {
        ...result,
        resumed: view(resumed), resumeWaiting: view(await engine.resumeJob(waiting)), resumeDone: view(await engine.resumeJob(done)),
        resumeMissing: await engine.resumeJob(waiting + 100_000), resumedRunning: view(await engine.resumeJob(running)),
        stillPaused: view(await engine.getJob(delayed)),
      };
    });

  parityTest('resolveParentJob, failParentJob and resolveStrandedParents wake or fail a parent waiting on children; detachChildJob removes the link',
    { methods: ['admitJob', 'claimNextJob', 'detachChildJob', 'resolveParentJob', 'failParentJob', 'resolveStrandedParents', 'getJob'] }, async (engine) => {
      const a = await add(engine, 'parent');
      const view = rowView(a);
      const a1 = await add(engine, 'work', { parent_job_id: a });
      const a2 = await add(engine, 'work', { parent_job_id: a });
      const blocked = await engine.resolveParentJob(a);
      await engine.detachChildJob(a1);
      const afterOne = await engine.resolveParentJob(a);
      await engine.detachChildJob(a2);
      const resolved = await engine.resolveParentJob(a);
      const notWaitingChildren = await engine.resolveParentJob(a);
      // failParentJob fails only a parent that is waiting on children.
      const b = await add(engine, 'parent');
      await add(engine, 'work', { parent_job_id: b });
      const failedB = await engine.failParentJob(b, 'child job 7 failed: boom');
      const failedAgain = await engine.failParentJob(b, 'again');
      const plain = await add(engine, 'plain');
      const failPlain = await engine.failParentJob(plain, 'nope');
      // Stranded parents: a parent whose only child was detached, one that still has a live child, and a finished-child one.
      const c = await add(engine, 'parent');
      const c1 = await add(engine, 'work', { parent_job_id: c });
      await engine.detachChildJob(c1);
      const d = await add(engine, 'parent');
      await add(engine, 'work', { parent_job_id: d });
      const e = await add(engine, 'parent');
      const e1 = await add(engine, 'other', { parent_job_id: e });
      await engine.claimNextJob(claimSpec('w1:a', { names: ['work'] }));
      await engine.claimNextJob(claimSpec('w2:a', { names: ['other'] }));
      await engine.detachChildJob(e1);
      const stranded = await engine.resolveStrandedParents();
      const strandedAgain = await engine.resolveStrandedParents();
      return {
        blocked: view(blocked), afterOne: view(afterOne), resolved: view(resolved), notWaitingChildren: view(notWaitingChildren),
        a1: view(await engine.getJob(a1)), failedB: view(failedB), failedAgain: view(failedAgain), failPlain: view(failPlain),
        missing: { resolve: await engine.resolveParentJob(a + 100_000), fail: await engine.failParentJob(a + 100_000, 'x') },
        stranded, strandedAgain, c: view(await engine.getJob(c)), d: view(await engine.getJob(d)), e: view(await engine.getJob(e)),
        detachMissing: await engine.detachChildJob(a + 100_000),
      };
    });

  parityTest('updateJobProgress and addJobTokens change only an active job the token holds',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'updateJobProgress', 'addJobTokens', 'getJob'] }, async (engine) => {
      const waiting = await add(engine, 'idle');
      const view = rowView(waiting);
      const id = await active(engine, 'busy', 'w1:a');
      const results = {
        waiting: [await engine.updateJobProgress(waiting, 'w1:a', { pct: 1 }), await engine.addJobTokens(waiting, 'w1:a', { input: 1, output: 1, cache_read: 1 })],
        stale: [await engine.updateJobProgress(id, 'w9:a', { pct: 1 }), await engine.addJobTokens(id, 'w9:a', { input: 5, output: 5, cache_read: 5 })],
        missing: [await engine.updateJobProgress(id + 100_000, 'w1:a', 1), await engine.addJobTokens(id + 100_000, 'w1:a', { input: 1, output: 0, cache_read: 0 })],
      };
      const untouched = view(await engine.getJob(id));
      const progress = await engine.updateJobProgress(id, 'w1:a', { pct: 50, items: ['a', { b: true }] });
      const tokens1 = await engine.addJobTokens(id, 'w1:a', { input: 10, output: 20, cache_read: 30 });
      const tokens2 = await engine.addJobTokens(id, 'w1:a', { input: 1, output: 2, cache_read: 3 });
      const first = view(await engine.getJob(id));
      const replaced = await engine.updateJobProgress(id, 'w1:a', ['replaced', 1]);
      const second = view(await engine.getJob(id));
      await engine.completeJob(id, 'w1:a');
      const finishedUpdates = [await engine.updateJobProgress(id, 'w1:a', { late: true }), await engine.addJobTokens(id, 'w1:a', { input: 1, output: 1, cache_read: 1 })];
      return { results, untouched, progress, tokens1, tokens2, first, replaced, second, finishedUpdates, final: view(await engine.getJob(id)), waitingRow: view(await engine.getJob(waiting)) };
    });

  parityTest('delayActiveJob returns a held job to delayed in its three modes without counting an attempt',
    { methods: ['admitJob', 'claimNextJob', 'delayActiveJob', 'promoteDelayedJobs', 'getJob'] }, async (engine) => {
      // The lease-full bounce keeps the timeout and appends to the stacktrace; the other two clear the timeout.
      const bounce = await active(engine, 'bounce', 'w1:a', { timeout_ms: 600_000 });
      const view = rowView(bounce);
      const defer = await active(engine, 'defer', 'w2:a', { timeout_ms: 600_000 });
      const config = await active(engine, 'config', 'w3:a', { timeout_ms: 600_000 });
      const idle = await add(engine, 'idle');
      const stale = await engine.delayActiveJob(bounce, 'w9:a', { errorText: 'x', delayMs: 60_000, appendStack: true, clearTimeout: false });
      const notActive = await engine.delayActiveJob(idle, 'w1:a', { errorText: 'x', delayMs: 60_000, appendStack: true, clearTimeout: false });
      const bounced = await engine.delayActiveJob(bounce, 'w1:a', { errorText: 'lease_full: try later', delayMs: 60_000, appendStack: true, clearTimeout: false });
      const deferred = await engine.delayActiveJob(defer, 'w2:a', { errorText: 'quiet hours', delayMs: 120_000, appendStack: false, clearTimeout: true });
      const configured = await engine.delayActiveJob(config, 'w3:a', { errorText: 'worker_configuration_blocked', delayMs: 30_000, appendStack: false, clearTimeout: true });
      const twice = await engine.delayActiveJob(bounce, 'w1:a', { errorText: 'again', delayMs: 1, appendStack: true, clearTimeout: false });
      const delayUntil = (r: JobRow | null) => (r?.delay_until instanceof Date ? r.delay_until.getTime() - Date.now() : null);
      const near = (ms: number | null, want: number) => ms !== null && ms > want - 20_000 && ms <= want + 1_000;
      return {
        stale: view(stale), notActive: view(notActive), bounced: view(bounced), deferred: view(deferred), configured: view(configured), twice: view(twice),
        delays: [near(delayUntil(bounced), 60_000), near(delayUntil(deferred), 120_000), near(delayUntil(configured), 30_000)],
        // Nothing is due yet, so no delayed job is promoted.
        promoted: (await engine.promoteDelayedJobs()).length, still: view(await engine.getJob(bounce)),
      };
    });

  parityTest('releaseWatchdogClaim requeues a held job with the suspect mark once; markJobWatchdogSuspect marks any job without a new update stamp; hasOverdueWatchdogSuspect reads the mark',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'releaseWatchdogClaim', 'markJobWatchdogSuspect', 'hasOverdueWatchdogSuspect', 'cancelJobs', 'getJob'] }, async (engine) => {
      const held = await active(engine, 'held', 'w1:a', { timeout_ms: 600_000 });
      const view = rowView(held);
      const stale = await engine.releaseWatchdogClaim(held, 'w9:a', 'worker_stalled_with_co_runners: w1');
      const released = await engine.releaseWatchdogClaim(held, 'w1:a', 'worker_stalled_with_co_runners: w1');
      const releasedAgain = await engine.releaseWatchdogClaim(held, 'w1:a', 'second');
      const afterRelease = view(await engine.getJob(held));
      const quiet = await add(engine, 'quiet');
      const before = (await engine.getJob(quiet))!;
      await Bun.sleep(5);
      await engine.markJobWatchdogSuspect(quiet);
      await engine.markJobWatchdogSuspect(quiet);
      const marked = (await engine.getJob(quiet))!;
      const done = await finished(engine, 'done', 'completed');
      await engine.markJobWatchdogSuspect(done);
      const fresh = await add(engine, 'fresh');
      const other = await add(engine, 'quiet', { queue: 'side' });
      await engine.markJobWatchdogSuspect(other);
      const overdue = (queue: string, names: string[], waitMs: number) => engine.hasOverdueWatchdogSuspect(queue, names, waitMs);
      const gone = await add(engine, 'gone');
      await engine.markJobWatchdogSuspect(gone);
      await engine.cancelJobs([gone]);
      return {
        stale, released, releasedAgain, afterRelease, mark: WATCHDOG_SUSPECT_MARK,
        marked: view(marked), stamp: (marked.updated_at as Date).getTime() === (before.updated_at as Date).getTime(),
        done: view(await engine.getJob(done)), fresh: view(await engine.getJob(fresh)),
        overdue: {
          held: await overdue('default', ['held'], -1_000), heldLong: await overdue('default', ['held'], 3_600_000),
          quiet: await overdue('default', ['quiet'], -1_000), quietLong: await overdue('default', ['quiet'], 3_600_000),
          wrongName: await overdue('default', ['fresh'], -1_000), noNames: await overdue('default', [], -1_000),
          side: await overdue('side', ['quiet'], -1_000), noSide: await overdue('side', ['held'], -1_000),
          done: await overdue('default', ['done'], -1_000), gone: await overdue('default', ['gone'], -1_000),
        },
      };
    });

  // ------------------------------------------------------------ sweeps

  parityTest('promoteDelayedJobs returns only delayed jobs whose delay passed to waiting',
    { methods: ['admitJob', 'claimNextJob', 'promoteDelayedJobs', 'getJob'] }, async (engine) => {
      const due1 = await add(engine, 'due', { status: 'delayed', delay_until: PAST, priority: 3 });
      const view = rowView(due1);
      const later = await add(engine, 'later', { status: 'delayed', delay_until: FAR });
      const due2 = await add(engine, 'due', { status: 'delayed', delay_until: PAST });
      const waiting = await add(engine, 'idle');
      const promoted = await engine.promoteDelayedJobs();
      const again = await engine.promoteDelayedJobs();
      const claimed = await engine.claimNextJob(claimSpec('w1:a', { names: ['due'] }));
      return {
        promoted: byId(promoted, due1), again: again.length, later: view(await engine.getJob(later)),
        waiting: view(await engine.getJob(waiting)), claimed: view(claimed), claimable: [due1, due2].includes(Number(claimed?.id)),
      };
    });

  parityTest('cancelJobs cancels live roots and their descendants, stamps the reason on the requested roots, and tells the live parent',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'pauseJob', 'failParentJob', 'cancelJobs', 'readChildCompletions', 'getJob'] }, async (engine) => {
      // P > R > (C1 > G, C2 completed, C3 paused); R is the requested root.
      const p = await add(engine, 'grand');
      const view = rowView(p);
      const r = await add(engine, 'root', { parent_job_id: p });
      const c1 = await add(engine, 'kid', { parent_job_id: r });
      const g = await add(engine, 'leaf', { parent_job_id: c1 });
      const c2 = await active(engine, 'done-kid', 'w1:a', { parent_job_id: r });
      await engine.completeJob(c2, 'w1:a');
      const c3 = await add(engine, 'paused-kid', { parent_job_id: r });
      await engine.pauseJob(c3);
      const stop = await engine.cancelJobs([r], { reason: 'stop it' });
      const again = await engine.cancelJobs([r], { reason: 'stop it' });
      const unknown = await engine.cancelJobs([r + 100_000]);
      const empty = await engine.cancelJobs([]);
      // The parent was woken and holds one child_done for R, none for the cancelled descendants.
      const parent = view(await engine.getJob(p));
      const claimedParent = await engine.claimNextJob(claimSpec('w2:a', { names: ['grand'] }));
      const notices = childDone(p)(await engine.readChildCompletions(p, 'w2:a'));
      // Root status fence and the kept error text.
      const x = await add(engine, 'fence');
      const fenced = await engine.cancelJobs([x], { rootStatuses: ['paused', 'active'], reason: 'no' });
      const allowed = await engine.cancelJobs([x], { rootStatuses: ['waiting'], reason: 'yes' });
      const keep = await active(engine, 'keep', 'w3:a');
      await engine.failJob(keep, 'w3:a', 'oops', 'delayed', 60_000);
      const kept = await engine.cancelJobs([keep], { reason: null });
      const over = await active(engine, 'over', 'w4:a');
      await engine.failJob(over, 'w4:a', 'oops', 'delayed', 60_000);
      const overwritten = await engine.cancelJobs([over], { reason: 'because' });
      // A finished root: its live child is still cancelled, without the reason, and the finished root is not returned.
      const q = await add(engine, 'finished-root');
      const qk = await add(engine, 'orphan', { parent_job_id: q });
      await engine.failParentJob(q, 'gave up');
      const closure = await engine.cancelJobs([q], { reason: 'x' });
      // A requested root that is also a descendant keeps the reason.
      const top = await add(engine, 'top');
      const nested = await add(engine, 'nested', { parent_job_id: top });
      const both = await engine.cancelJobs([top, nested], { reason: 'both' });
      return {
        stop: byId(stop, p), again: again.length, unknown: unknown.length, empty: empty.length, parent, claimedParent: view(claimedParent), notices,
        c2: view(await engine.getJob(c2)), fenced: fenced.length, allowed: byId(allowed, p), kept: byId(kept, p), overwritten: byId(overwritten, p),
        closure: byId(closure, p), closureRoot: view(await engine.getJob(q)), closureChild: view(await engine.getJob(qk)),
        both: byId(both, p), leaf: view(await engine.getJob(g)),
      };
    });

  parityTest('cancelJobs with an owner fence cancels only the client\'s jobs accepted for the same actor and audience',
    { methods: ['admitJob', 'cancelJobs', 'getJob'] }, async (engine) => {
      const j = await ownerJobs(engine);
      const base = j.arrayAudience;
      const all = Object.values(j);
      const ids = (rows: JobRow[]) => rows.map(r => Number(r.id) - base).sort((a, b) => a - b);
      const rel$ = (id: number) => id - base;
      // The audience is the sorted distinct list: ['b','a','a'] reads 'a,b'; a lone value that is not a list reads '!'.
      const wrongAudience = await engine.cancelJobs(all, { ownerClientId: 'client-a', ownerActor: ['s', 'e', 'm', 'b,a'] });
      const array = await engine.cancelJobs(all, { ownerClientId: 'client-a', ownerActor: ['s', 'e', 'm', 'a,b'] });
      const none = await engine.cancelJobs(all, { ownerClientId: 'client-a', ownerActor: ['s', 'e', 'm', ''] });
      const noGrant = await engine.cancelJobs(all, { ownerClientId: 'client-a', ownerActor: ['', '', '', ''] });
      const odd = await engine.cancelJobs(all, { ownerClientId: 'client-a', ownerActor: ['', '42', 'm', '!'] });
      const noActor = await engine.cancelJobs(all, { ownerClientId: 'client-a' });
      const otherClient = await engine.cancelJobs(all, { ownerClientId: 'client-b', ownerActor: ['s', 'e', 'm', 'a,b'] });
      const unfenced = await engine.cancelJobs([j.otherMember, j.unowned]);
      return {
        wrongAudience: ids(wrongAudience), array: ids(array), none: ids(none), noGrant: ids(noGrant), odd: ids(odd), noActor: ids(noActor),
        otherClient: ids(otherClient), unfenced: ids(unfenced), map: Object.fromEntries(Object.entries(j).map(([k, id]) => [k, rel$(id)])),
        statuses: Object.fromEntries(await Promise.all(Object.entries(j).map(async ([k, id]) => [k, (await engine.getJob(id))?.status] as const))),
      };
    });

  parityTest('killTimedOutJobs kills active jobs past timeout_at that hold a live lease, except the drain-lease beacon, and notifies the parent',
    { methods: ['admitJob', 'claimNextJob', 'killTimedOutJobs', 'readChildCompletions', 'getJob'] }, async (engine) => {
      const parent = await add(engine, 'parent');
      const view = rowView(parent);
      const timedOut = await active(engine, 'timed', 'w1:a', { timeout_ms: 1, parent_job_id: parent, remove_on_fail: true });
      const plain = await active(engine, 'plain', 'w2:a', { timeout_ms: 1, max_stalled: 2 });
      const roomy = await active(engine, 'roomy', 'w3:a', { timeout_ms: 600_000 });
      const noTimeout = await active(engine, 'none', 'w4:a');
      const lapsed = await active(engine, 'lapsed', 'w5:a', { timeout_ms: 1 }, { lockDurationMs: -60_000 });
      const beacon = await active(engine, 'beacon', 'w6:a', { queue: 'gbrain-drain-lease', timeout_ms: 1 });
      const waiting = await add(engine, 'waiting', { timeout_ms: 1 });
      await Bun.sleep(25);
      const killed = await engine.killTimedOutJobs();
      const again = await engine.killTimedOutJobs();
      const woken = await engine.claimNextJob(claimSpec('w7:a', { names: ['parent'] }));
      const notices = childDone(parent)(await engine.readChildCompletions(parent, 'w7:a'));
      const after = async (...ids: number[]) => Promise.all(ids.map(async id => view(await engine.getJob(id))));
      return { killed: byId(killed, parent), again: again.length, woken: view(woken), notices, untouched: await after(roomy, noTimeout, lapsed, beacon, waiting), plain: view(await engine.getJob(plain)), timedOut: view(await engine.getJob(timedOut)) };
    });

  parityTest('killWallClockJobs kills active jobs running past twice their timeout or lease times max_stalled, except the drain-lease beacon, and notifies the parent',
    { methods: ['admitJob', 'claimNextJob', 'killWallClockJobs', 'readChildCompletions', 'getJob'] }, async (engine) => {
      const parent = await add(engine, 'parent');
      const view = rowView(parent);
      const timeoutChild = await active(engine, 'tight', 'w1:a', { timeout_ms: 1, parent_job_id: parent });
      const roomy = await active(engine, 'roomy', 'w2:a', { timeout_ms: 600_000 });
      const leased = await active(engine, 'leased', 'w3:a', { lock_duration_ms: 20_000, max_stalled: 3 });
      const bare = await active(engine, 'bare', 'w4:a');
      const beacon = await active(engine, 'beacon', 'w5:a', { queue: 'gbrain-drain-lease', timeout_ms: 1 });
      const waiting = await add(engine, 'waiting', { timeout_ms: 1 });
      await Bun.sleep(25);
      // With a generous fallback only the 1 ms timeout has run past its wall-clock threshold.
      const first = await engine.killWallClockJobs(30_000);
      const afterFirst = view(await engine.getJob(bare));
      // A negative fallback puts a job with no timeout of its own past it; a job with its own lease keeps that lease.
      const second = await engine.killWallClockJobs(-1_000);
      const again = await engine.killWallClockJobs(-1_000);
      const woken = await engine.claimNextJob(claimSpec('w6:a', { names: ['parent'] }));
      const notices = childDone(parent)(await engine.readChildCompletions(parent, 'w6:a'));
      const after = async (...ids: number[]) => Promise.all(ids.map(async id => view(await engine.getJob(id))));
      return { first: byId(first, parent), afterFirst, second: byId(second, parent), again: again.length, woken: view(woken), notices, untouched: await after(roomy, leased, beacon, waiting), timeoutChild: view(await engine.getJob(timeoutChild)) };
    });

  parityTest('pruneJobs counts on a dry run, deletes the named statuses older than the cut-off, and keeps newer and other rows',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'pruneJobs', 'insertJobAttachment', 'listJobAttachmentNames', 'getJob', 'listSynthesisCompletionKeys'] }, async (engine) => {
      const oldDone = await finished(engine, 'old-done', 'completed');
      const view = rowView(oldDone);
      const oldFailed = await finished(engine, 'old-failed', 'failed');
      const oldWaiting = await add(engine, 'old-waiting');
      // A completed subagent whose key is not a dream synthesis, and a failed one whose key is: neither is archived.
      const oldSubagent = await finished(engine, 'subagent', 'completed', { idempotency_key: 'other:key' });
      const oldDreamFailed = await finished(engine, 'subagent', 'failed', { idempotency_key: 'dream:synth:src:1' });
      await engine.insertJobAttachment(oldDone, attachment('a.bin', [9]));
      await Bun.sleep(20);
      const cut = new Date();
      await Bun.sleep(20);
      const newDone = await finished(engine, 'new-done', 'completed');
      const all = ['completed', 'failed', 'dead', 'cancelled', 'waiting'];
      const longAgo = new Date(PAST);
      const dry = await engine.pruneJobs({ statuses: all, olderThan: cut, dryRun: true });
      const dryEmptyStatuses = await engine.pruneJobs({ statuses: [], olderThan: cut, dryRun: true });
      const dryPast = await engine.pruneJobs({ statuses: all, olderThan: longAgo, dryRun: true });
      const noneDeleted = await engine.pruneJobs({ statuses: all, olderThan: longAgo });
      const afterDry = await Promise.all([oldDone, oldFailed, oldWaiting, newDone].map(async id => view(await engine.getJob(id))?.status ?? null));
      const completedOnly = await engine.pruneJobs({ statuses: ['completed'], olderThan: cut });
      const afterCompleted = await Promise.all([oldDone, oldSubagent, oldFailed, newDone].map(async id => view(await engine.getJob(id))?.status ?? null));
      const rest = await engine.pruneJobs({ statuses: all, olderThan: cut });
      const afterRest = await Promise.all([oldFailed, oldWaiting, oldDreamFailed, newDone].map(async id => view(await engine.getJob(id))?.status ?? null));
      const archived = await engine.listSynthesisCompletionKeys('default', 'dream:synth:');
      return { dry, dryEmptyStatuses, dryPast, noneDeleted, afterDry, completedOnly, afterCompleted, rest, afterRest, archived, attachments: await engine.listJobAttachmentNames(oldDone), again: await engine.pruneJobs({ statuses: all, olderThan: cut }) };
    });

  parityTest('pruneJobs archives the key of a completed dream synthesis subagent as it deletes it, and the completion reads still find it',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'pruneJobs', 'getJob', 'listSynthesisCompletionKeys', 'listRecentSynthesisCompletions'] }, async (engine) => {
      const synth = await finished(engine, 'subagent', 'completed', { idempotency_key: 'dream:synth:src:1', data: { source_id: 'src' } });
      const v2 = await finished(engine, 'subagent', 'completed', { idempotency_key: 'dream:synth-v2:src:2', data: { source_id: 'src' } });
      // An empty source_id is the default source; a failed synthesis and a non-dream key are not completions.
      const v2Default = await finished(engine, 'subagent', 'completed', { idempotency_key: 'dream:synth-v2:def:3', data: { source_id: '' } });
      await finished(engine, 'subagent', 'failed', { idempotency_key: 'dream:synth:src:4', data: { source_id: 'src' } });
      await finished(engine, 'subagent', 'completed', { idempotency_key: 'other:src:5', data: { source_id: 'src' } });
      const other = await finished(engine, 'work', 'completed');
      const reads = async () => ({
        v1: sorted(await engine.listSynthesisCompletionKeys('src', 'dream:synth:')),
        v2: sorted(await engine.listSynthesisCompletionKeys('src', 'dream:synth-v2:')),
        v1Default: sorted(await engine.listSynthesisCompletionKeys('default', 'dream:synth:')),
        v2Default: sorted(await engine.listSynthesisCompletionKeys('default', 'dream:synth-v2:')),
        recent: (await engine.listRecentSynthesisCompletions('src', 1)).map(r => [r.idempotency_key, r.at instanceof Date]),
        recentDefault: (await engine.listRecentSynthesisCompletions('default', 1)).map(r => r.idempotency_key),
      });
      const live = await reads();
      const cut = new Date(Date.now() + 60_000);
      const dry = await engine.pruneJobs({ statuses: ['completed', 'failed'], olderThan: cut, dryRun: true });
      const afterDry = await reads();
      const pruned = await engine.pruneJobs({ statuses: ['completed', 'failed'], olderThan: cut });
      const archived = await reads();
      const firstAt = (await engine.listRecentSynthesisCompletions('src', 1))[0]?.at.getTime();
      // The same key completes again: live and archived it reads once as a key and twice as a recent completion.
      const again = await finished(engine, 'subagent', 'completed', { idempotency_key: 'dream:synth-v2:src:2', data: { source_id: 'src' } });
      const twice = await reads();
      // Pruned again, the archive keeps its first row (ON CONFLICT DO NOTHING).
      const prunedAgain = await engine.pruneJobs({ statuses: ['completed'], olderThan: new Date(Date.now() + 60_000) });
      const kept = await engine.listRecentSynthesisCompletions('src', 1);
      await Bun.sleep(50);
      const outsideWindow = await engine.listRecentSynthesisCompletions('src', 0.00001);
      return {
        dry, pruned, live, afterDry, archived, twice, prunedAgain, outsideWindow,
        keptFirstAt: kept.length === 1 && kept[0]!.at.getTime() === firstAt,
        gone: await Promise.all([synth, v2, v2Default, other, again].map(async id => (await engine.getJob(id)) === null)),
      };
    });

  parityTest('retryJob requeues a failed or dead job after the policy admits it, and does nothing for any other job or a refused retry',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'retryJob', 'getFailedJobForRetry', 'getJob'] }, async (engine) => {
      const failed = await finished(engine, 'failed', 'failed', { data: { n: 1 }, timeout_ms: 600_000 });
      const view = rowView(failed);
      const dead = await finished(engine, 'dead', 'dead');
      const done = await finished(engine, 'done', 'completed');
      const waiting = await add(engine, 'waiting');
      const refused = await finished(engine, 'refused', 'failed');
      const seen: Array<{ status: unknown; name: unknown; failedFor: unknown; job: unknown }> = [];
      const admitting: RetryJobPolicy = {
        admit: async (tx, prior) => {
          const job = await tx.getJob(Number(prior.id));
          const failedFor = await tx.getFailedJobForRetry(Number(prior.id));
          seen.push({ status: prior.status, name: prior.name, failedFor, job: job?.status });
          return failedFor !== null;
        },
      };
      const declining: RetryJobPolicy = { admit: async () => false };
      const row$ = {
        failed: view(await engine.retryJob(failed, admitting)),
        dead: view(await engine.retryJob(dead, admitting)),
        done: view(await engine.retryJob(done, admitting)),
        waiting: view(await engine.retryJob(waiting, admitting)),
        missing: await engine.retryJob(failed + 100_000, admitting),
        declined: view(await engine.retryJob(refused, declining)),
        twice: view(await engine.retryJob(failed, admitting)),
      };
      return {
        ...row$, seen, refusedStill: view(await engine.getJob(refused)), failedForRetry: [await engine.getFailedJobForRetry(refused), await engine.getFailedJobForRetry(failed)],
        claimable: Number((await engine.claimNextJob(claimSpec('w9:a', { names: ['failed'] })))?.id) === failed,
      };
    });

  // The retry policy runs in the retry's transaction on every arm, so any engine read it makes (this listJobs) answers.
  parityTest('retryJob runs a delegated client\'s retry policy through the retry transaction',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'retryJob'] }, async (engine) => {
      const id = await finished(engine, 'failed', 'failed');
      const out = await engine.retryJob(id, { admit: async (tx) => { await tx.listJobs({ limit: 1 }); return true; } });
      return { status: out?.status ?? null };
    });

  // The queue's own retry policy (MinionQueue.retryJob's admitDelegatedRetry). A job with no delegated owner needs no
  // client lock, so every arm re-queues it.
  parityTest('retryJob with the delegated retry policy re-queues a failed job that has no delegated owner',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'retryJob'] }, async (engine) => {
      const id = await finished(engine, 'subagent', 'failed', { data: { task: 'mine' } });
      const out = await engine.retryJob(id, { admit: (tx) => admitDelegatedRetry(tx, id) });
      return { status: out?.status ?? null, again: await engine.retryJob(id, { admit: (tx) => admitDelegatedRetry(tx, id) }) };
    });

  // A legacy delegated job (an owner but no frozen grant snapshot) is never replayed: the policy refuses it before any
  // client lock or grant read, so every arm returns the same refusal and the job stays failed.
  parityTest('retryJob with the delegated retry policy refuses a legacy delegated job that has no frozen grant snapshot',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'retryJob', 'getJob'] }, async (engine) => {
      const id = await finished(engine, 'subagent', 'failed', { data: { __owner_client_id: 'gone-client', allowed_tools: ['search'], source_id: 'default' } });
      const out = await thrown(() => engine.retryJob(id, { admit: (tx) => admitDelegatedRetry(tx, id) }));
      return { out, status: (await engine.getJob(id))?.status };
    });

  // A delegated job with a frozen grant snapshot: the policy locks the client (lockOAuthClient) and reads the client's
  // grant. PGLite and Postgres find no OAuth row and refuse the retry (client_deleted); the Rust store reads the missing
  // row as absent through readOauthClient, so the Rust arm refuses the same way.
  parityTest('retryJob with the delegated retry policy refuses a delegated job whose OAuth client is gone',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'retryJob', 'getJob'] }, async (engine) => {
      const grant = {
        clientId: 'gone-client', sourceId: 'default', brainId: null, namespace: 'job', tools: ['search'], allowedOperations: null,
        slugPrefixes: ['wiki/agents/{job_id}/*'], readSources: ['default'], scopes: ['read', 'write', 'agent'], maxConcurrent: 2, budgetUsdPerDay: null,
      };
      const id = await finished(engine, 'subagent', 'failed', { data: { __owner_client_id: 'gone-client', __delegation_grant: grant } });
      const out = await denied(() => engine.retryJob(id, { admit: (tx) => admitDelegatedRetry(tx, id) }));
      return { out, status: (await engine.getJob(id))?.status };
    });

  // readJobSourceState is the agent job authority check's source read: archived and the creation stamp, or null.
  parityTest('readJobSourceState reads an agent job source\'s archived flag and creation stamp, and null for an unknown source',
    { methods: ['readJobSourceState', 'getSource'] }, async (engine) => {
      const state = await engine.readJobSourceState('default');
      const created = (await engine.getSource('default'))?.created_at;
      return {
        archived: state?.archived ?? null,
        isDate: state?.created_at instanceof Date,
        sameStamp: !!state && !!created && state.created_at.toISOString() === new Date(created).toISOString(),
        unknown: await engine.readJobSourceState('no-such-source'),
      };
    });

  // A generic remote submit (sync, import, lint) reads its source's registration (archived, root, config, creation
  // stamp) through readJobSourceState, at acceptance and again when the job runs; a Rust brain answers it from its store.
  parityTest('a remote import submit by an OAuth client reads its source registration through readJobSourceState, and refuses an archived, connector, relative or missing source',
    { methods: ['readJobSourceState', 'readOauthClient', 'insertOauthClient', 'getSource'] }, async (engine, backend) => {
      const scratch = mkdtempSync(join(tmpdir(), 'gbrain-remote-submit-'));
      try {
        const root = join(scratch, 'checkout');
        mkdirSync(root);
        await createSource(engine, backend, 'job-src', {}, root);
        await createSource(engine, backend, 'job-connector', { kind: 'example-connector' }, root);
        await createSource(engine, backend, 'job-relative', {}, 'relative/checkout');
        await createSource(engine, backend, 'job-archived', {}, root);
        await archiveSource(engine, backend, 'job-archived');
        const ctx = (sourceId: string) => {
          const clientId = `submit-${sourceId}`;
          return { engine, remote: true, sourceId,
            auth: { token: 'fixture-token', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId } } as unknown as OperationContext;
        };
        for (const id of ['job-src', 'job-connector', 'job-relative', 'job-archived']) {
          await engine.insertOauthClient({ client_id: `submit-${id}`, client_name: `submit-${id}`, grant_types: ['client_credentials'], scope: 'admin', source_id: id });
        }
        const canonical = realpathSync(root);
        const scrub = (v: unknown) => JSON.parse(JSON.stringify(v).split(canonical).join('<root>')) as unknown;
        const accepted = await prepareRemoteJob(ctx('job-src'), 'import', {});
        const created = (await engine.getSource('job-src'))?.created_at;
        const grant = accepted.authority.grant as unknown as Record<string, unknown>;
        const rechecked = await denied(() => authorizeJobExecution(engine, { name: 'import', data: accepted.data, submission_authority: accepted.authority } as never));
        return {
          data: scrub(accepted.data),
          grant: scrub({ ...grant, sourceCreatedAt: undefined }),
          sameStamp: !!created && grant.sourceCreatedAt === new Date(created).toISOString(),
          rechecked,
          connector: await denied(() => prepareRemoteJob(ctx('job-connector'), 'import', {})),
          relative: await denied(() => prepareRemoteJob(ctx('job-relative'), 'lint', {})),
          archived: await denied(() => prepareRemoteJob(ctx('job-archived'), 'import', {})),
          missing: await denied(() => prepareRemoteJob(ctx('job-missing'), 'import', {})),
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

  /** A failed agent (`remote_agent`) job accepted against `sourceId` as created at `sourceCreatedAt`. */
  async function failedAgentJob(engine: BrainEngine, sourceId: string, sourceCreatedAt: string): Promise<number> {
    const data = { task: 'summarize', source_id: sourceId, allowed_tools: ['search'], allowed_slug_prefixes: ['wiki/agents/'] };
    const authority = {
      version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'agent-client' },
      grant: { scopes: ['read', 'write', 'agent'], sourceId, sourceCreatedAt, allowedTools: ['search'], allowedSlugPrefixes: ['wiki/agents/'] },
      payloadHash: authorityDigest(data),
    } as unknown as SubmissionAuthority;
    return finished(engine, 'subagent', 'failed', { data, submission_authority: authority });
  }

  // The queue's whole retry policy (MinionQueue.retryJob: the job authority check, then the delegated retry). The
  // authority check reads the agent job's source first; a source that is gone or was created again after the job was
  // accepted denies the retry on every arm, before any OAuth read, and the job stays failed.
  parityTest('MinionQueue.retryJob denies an agent job whose source is missing or was created again after acceptance',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'retryJob', 'getJob'] }, async (engine) => {
      const queue = new MinionQueue(engine);
      const missing = await failedAgentJob(engine, 'gone-source', PAST);
      const replaced = await failedAgentJob(engine, 'default', PAST);
      return {
        missing: await thrown(() => queue.retryJob(missing)),
        replaced: await thrown(() => queue.retryJob(replaced)),
        status: [(await engine.getJob(missing))?.status, (await engine.getJob(replaced))?.status],
      };
    });

  // With a current source the authority check goes on to the job owner's OAuth client. PGLite and Postgres find no
  // client and deny the retry; the Rust store reads the missing row as absent through readOauthClient, so the Rust arm
  // denies it the same way.
  parityTest('MinionQueue.retryJob refuses an agent job with a current source at the owner\'s grant read',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'retryJob', 'getJob', 'getSource'] }, async (engine) => {
      const created = (await engine.getSource('default'))?.created_at;
      const id = await failedAgentJob(engine, 'default', new Date(created as Date).toISOString());
      const out = await denied(() => new MinionQueue(engine).retryJob(id));
      return { out, status: (await engine.getJob(id))?.status };
    });

  // ------------------------------------------------------------ inbox

  parityTest('postInboxMessage, readJobInbox and readChildCompletions fence on the lock token; reads mark messages read and completions keep their order',
    { methods: ['admitJob', 'claimNextJob', 'postInboxMessage', 'readJobInbox', 'readChildCompletions'] }, async (engine) => {
      const idle = await add(engine, 'idle');
      const job = await active(engine, 'busy', 'w1:a');
      const jobBase = job;
      await engine.postInboxMessage(job, 'child', { type: 'child_done', child_id: job + 5, job_name: 'a', result: null, outcome: 'completed', error: null });
      const view = inboxView(jobBase);
      await engine.postInboxMessage(job, 'ops', { type: 'note', text: ['hello', { deep: 1 }] });
      await Bun.sleep(20);
      const since = new Date();
      await Bun.sleep(20);
      await engine.postInboxMessage(job, 'child', { type: 'child_done', child_id: job + 6, job_name: 'b', result: { x: 1 }, outcome: 'failed', error: 'boom' });
      const toIdle = await engine.postInboxMessage(idle, 'cli', { type: 'note' });
      const missing = await threw(() => engine.postInboxMessage(job + 100_000, 'cli', { type: 'note' }));
      const done = childDone(jobBase);
      const completions = {
        all: done(await engine.readChildCompletions(job, 'w1:a')), since: done(await engine.readChildCompletions(job, 'w1:a', since)),
        future: await engine.readChildCompletions(job, 'w1:a', new Date(Date.now() + 3_600_000)), stale: await engine.readChildCompletions(job, 'w9:a'),
        idle: await engine.readChildCompletions(idle, 'w1:a'), missing: await engine.readChildCompletions(job + 100_000, 'w1:a'),
      };
      const reads = {
        stale: (await engine.readJobInbox(job, 'w9:a')).length, idle: (await engine.readJobInbox(idle, 'w1:a')).length, missing: (await engine.readJobInbox(job + 100_000, 'w1:a')).length,
        first: (await engine.readJobInbox(job, 'w1:a')).map(view), second: (await engine.readJobInbox(job, 'w1:a')).length,
      };
      await engine.postInboxMessage(job, 'late', { type: 'note', n: 4 });
      const third = (await engine.readJobInbox(job, 'w1:a')).map(view);
      return { toIdle: view(toIdle), missing, completions, reads, third, afterRead: done(await engine.readChildCompletions(job, 'w1:a')).length };
    });

  // ------------------------------------------------------------ private queues

  parityTest('listOpenJobIdsInQueue, renewPrivateQueueLease and readPrivateQueueState read a private queue\'s live rows, owners and leases',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'listOpenJobIdsInQueue', 'renewPrivateQueueLease', 'readPrivateQueueState', 'getJob'] }, async (engine) => {
      const QA = 'dream-inline-100-aaaa';
      const owner = await active(engine, 'owner', 'o1:a');
      const base = owner;
      const view = rowView(base);
      const ownerWaiting = await add(engine, 'owner2');
      const ownerDone = await finished(engine, 'owner3', 'completed');
      const m1 = await add(engine, 'm1', { queue: QA, private_queue_owner_job_id: owner, private_queue_owner_token: 'tok-a', private_queue_lease_until: FAR });
      const m2 = await add(engine, 'm2', { queue: QA, private_queue_owner_job_id: owner, private_queue_owner_token: 'tok-a', private_queue_lease_until: PAST });
      const m3 = await active(engine, 'm3', 'q1:a', { queue: QA, private_queue_owner_job_id: ownerDone, private_queue_owner_token: 'tok-a' });
      const m4 = await finished(engine, 'm4', 'completed', { queue: QA, private_queue_owner_job_id: ownerWaiting, private_queue_owner_token: 'tok-a', private_queue_lease_until: FAR });
      const m5 = await add(engine, 'm5', { queue: QA, private_queue_owner_job_id: ownerWaiting, private_queue_owner_token: 'tok-b' });
      const rel$ = rel(base);
      const open = async (q: string) => (await engine.listOpenJobIdsInQueue(q)).map(id => id - base);
      const state = async (q: string) => {
        const s = await engine.readPrivateQueueState(q);
        return { ...s, owner_ids: s.owner_ids.map(id => id - base), max_lease_until: s.max_lease_until === null ? null : new Date(s.max_lease_until).toISOString() };
      };
      const before = { open: await open(QA), openDefault: await open('default'), empty: await open('dream-inline-none'), state: await state(QA), emptyState: await state('dream-inline-none') };
      const renewed = {
        wrongToken: await engine.renewPrivateQueueLease(QA, 'nope', 60_000), wrongQueue: await engine.renewPrivateQueueLease('dream-inline-none', 'tok-a', 60_000),
        holder: await engine.renewPrivateQueueLease(QA, 'tok-a', 60_000),
      };
      const lease = async (id: number) => {
        const t = (await engine.getJob(id))?.private_queue_lease_until;
        return t == null ? null : { far: new Date(t as Date).toISOString() === FAR, soon: new Date(t as Date).getTime() > Date.now() && new Date(t as Date).getTime() < Date.now() + 120_000 };
      };
      return {
        before, renewed, leases: { m1: await lease(m1), m2: await lease(m2), m3: await lease(m3), m4: await lease(m4), m5: await lease(m5) },
        after: await state(QA), ids: [m1, m2, m3, m4, m5, ownerWaiting].map(rel$), owner: view(await engine.getJob(m3)),
      };
    });

  parityTest('listOwnedPrivateQueues lists dream-inline queues with live owner metadata, oldest first, within the limit',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'listOwnedPrivateQueues'] }, async (engine) => {
      // The oldest queue sorts last by name, so created_at order differs from name order.
      await add(engine, 'z1', { queue: 'dream-inline-900-zzzz', private_queue_lease_until: FAR });
      const owner = await add(engine, 'owner');
      await add(engine, 'a1', { queue: 'dream-inline-100-aaaa', private_queue_owner_job_id: owner, private_queue_owner_token: 't' });
      await add(engine, 'legacy', { queue: 'dream-inline-300-cccc' });
      await finished(engine, 'finished', 'completed', { queue: 'dream-inline-400-dddd', private_queue_lease_until: FAR });
      await add(engine, 'foreign', { queue: 'other-queue', private_queue_lease_until: FAR });
      await add(engine, 'near', { queue: 'dream-inlineX', private_queue_lease_until: FAR });
      await add(engine, 'a2', { queue: 'dream-inline-100-aaaa', private_queue_lease_until: PAST });
      return {
        all: await engine.listOwnedPrivateQueues(10), one: await engine.listOwnedPrivateQueues(1), none: await engine.listOwnedPrivateQueues(0),
      };
    });

  // ------------------------------------------------------------ served options of the slice 1 members

  // The SQL engines carry the minion_queue_protocol trigger (v149), which refuses an insert with no submission
  // authority; the Rust store refuses the same insert with the trigger's message. Nothing is stored, so the key stays
  // free for an authorized caller.
  parityTest('admitJob refuses a job with no submission authority',
    { methods: ['admitJob'] }, async (engine) => {
      const says = async (run: () => Promise<unknown>) =>
        (await thrown(run))?.message?.includes('Minion queue protocol 1 required') ?? false;
      const keyed = await says(() => admit(engine, { insert: values('work', { idempotency_key: 'legacy', submission_authority: null }) }));
      const plain = await says(() => admit(engine, { insert: values('work', { submission_authority: null }) }));
      const after = await admit(engine, { insert: values('work', { idempotency_key: 'legacy' }) });
      return { keyed, plain, after: after.coalesced };
    });

  parityTest('admitJob stores private-queue owner fields as given and the queue claims them like any job',
    { methods: ['admitJob', 'claimNextJob', 'getJob'] }, async (engine) => {
      const owner = await add(engine, 'owner');
      const view = rowView(owner);
      const member = await add(engine, 'work', { queue: 'dream-inline-1-aaaa', private_queue_owner_job_id: owner, private_queue_owner_token: 'tok', private_queue_lease_until: FAR });
      const stored = view(await engine.getJob(member));
      const claimed = await engine.claimNextJob(claimSpec('w1:a', { queue: 'dream-inline-1-aaaa' }));
      return { stored, claimed: view(claimed) };
    });

  parityTest('claimNextJob with suspectWaitMs claims an overdue watchdog suspect first, or stops while one waits when suspects are excluded',
    { methods: ['admitJob', 'claimNextJob', 'markJobWatchdogSuspect'] }, async (engine) => {
      // Priority sorts ascending: B first, then C, then the suspect A.
      const a = await add(engine, 'work', { priority: 5 });
      const view = rowView(a);
      const b = await add(engine, 'work', { priority: 0 });
      const c = await add(engine, 'work', { priority: 1 });
      await engine.markJobWatchdogSuspect(a);
      const take = async (token: string, extra: Partial<ClaimJobSpec>) => view(await engine.claimNextJob(claimSpec(token, extra)));
      const blocked = await take('w1:a', { excludeWatchdogSuspects: true, suspectWaitMs: -1_000 });
      const skipped = await take('w2:a', { excludeWatchdogSuspects: true, suspectWaitMs: 3_600_000 });
      const ordinary = await take('w3:a', { suspectWaitMs: 3_600_000 });
      const overdueFirst = await take('w4:a', { suspectWaitMs: -1_000 });
      const empty = await take('w5:a', { suspectWaitMs: -1_000 });
      return { blocked, skipped, ordinary, overdueFirst, empty, ids: [a, b, c].map(id => id - a) };
    });

  // ------------------------------------------------------------ reads

  parityTest('listStaleWaitingJobIds and countTtlExpiredWaiting read waiting jobs of one name older than the cut-off, oldest update first',
    { methods: ['admitJob', 'claimNextJob', 'pauseJob', 'resumeJob', 'listStaleWaitingJobIds', 'countTtlExpiredWaiting'] }, async (engine) => {
      const s1 = await add(engine, 'stale');
      const s2 = await add(engine, 'stale');
      const s3 = await add(engine, 'stale');
      const other = await add(engine, 'other');
      const running = await add(engine, 'stale', { priority: -9 });
      await engine.claimNextJob(claimSpec('w1:a', { names: ['stale'] }));
      // S1 is touched last, so it sorts after S2 and S3 despite being created first.
      await engine.pauseJob(s1);
      await engine.resumeJob(s1);
      // The hours=0 cut-off is now(): PGLite's clock ticks in milliseconds, so a read in the resume's millisecond saw
      // S1's updated_at equal to now() and left it out, while Postgres and Rust (microseconds) kept it. Let the clock
      // move past the resume, so every arm reads S1 as older than the cut-off.
      await Bun.sleep(20);
      const r$ = (ids: number[]) => ids.map(id => id - s1);
      const out = {
        all: r$(await engine.listStaleWaitingJobIds('stale', -1, 10)), limited: r$(await engine.listStaleWaitingJobIds('stale', -1, 2)),
        now: r$(await engine.listStaleWaitingJobIds('stale', 0, 10)), fresh: await engine.listStaleWaitingJobIds('stale', 24, 10),
        other: r$(await engine.listStaleWaitingJobIds('other', -1, 10)), nobody: await engine.listStaleWaitingJobIds('nobody', -1, 10), zero: await engine.listStaleWaitingJobIds('stale', -1, 0),
        counts: [await engine.countTtlExpiredWaiting('stale', -1), await engine.countTtlExpiredWaiting('stale', 0), await engine.countTtlExpiredWaiting('stale', 24), await engine.countTtlExpiredWaiting('other', -1), await engine.countTtlExpiredWaiting('nobody', -1)],
        ids: r$([s2, s3, other, running]),
      };
      const [d2, d3] = out.ids;
      expect({ now: out.now, countNow: out.counts[1] }).toEqual({ now: [d2, d3, 0], countNow: 3 });
      return out;
    });

  parityTest('the hours=0 stale read and count include a waiting job resumed just before them, round after round',
    { methods: ['admitJob', 'pauseJob', 'resumeJob', 'listStaleWaitingJobIds', 'countTtlExpiredWaiting'], timeout: 120_000 }, async (engine) => {
      // Ten resume-then-read rounds: before the clock moved past the resume, PGLite left the resumed job out of about
      // half of them, so this failed on PGLite on almost every run.
      const rounds: Array<{ listed: boolean; counted: number }> = [];
      for (let i = 0; i < 10; i++) {
        const name = `tie-${i}`;
        await add(engine, name);
        const resumed = await add(engine, name);
        await engine.pauseJob(resumed);
        await engine.resumeJob(resumed);
        await Bun.sleep(20);
        rounds.push({ listed: (await engine.listStaleWaitingJobIds(name, 0, 10)).includes(resumed), counted: await engine.countTtlExpiredWaiting(name, 0) });
      }
      expect(rounds).toEqual(Array(10).fill({ listed: true, counted: 2 }));
      return rounds;
    });

  parityTest('listUnfinishedJobsByName lists every unfinished job of the names by id, whatever its status, and no finished one',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'pauseJob', 'cancelJobs', 'listUnfinishedJobsByName'] }, async (engine) => {
      const waiting = await add(engine, 'm-waiting');
      const running = await active(engine, 'm-active', 'w1:a');
      const delayed = await add(engine, 'm-delayed', { status: 'delayed', delay_until: FAR });
      const paused = await add(engine, 'm-paused');
      await engine.pauseJob(paused);
      // A parent waiting on children is inserted directly; the insert type lists only the two statuses a submission makes.
      const children = await add(engine, 'm-children', { status: 'waiting-children' as unknown as 'waiting' });
      const done = await finished(engine, 'm-done', 'completed');
      const failed = await finished(engine, 'm-failed', 'failed');
      const dead = await finished(engine, 'm-dead', 'dead');
      const cancelled = await add(engine, 'm-cancelled');
      await engine.cancelJobs([cancelled]);
      const second = await add(engine, 'm-waiting');
      const outside = await add(engine, 'm-elsewhere');
      const names = ['m-waiting', 'm-active', 'm-delayed', 'm-paused', 'm-children', 'm-done', 'm-failed', 'm-dead', 'm-cancelled'];
      const view = (rows: Array<{ id: number; name: string; status: string }>) => rows.map(r => ({ id: r.id - waiting, name: r.name, status: r.status }));
      return {
        all: view(await engine.listUnfinishedJobsByName(names)),
        some: view(await engine.listUnfinishedJobsByName(['m-paused', 'm-done', 'm-waiting'])),
        finishedOnly: await engine.listUnfinishedJobsByName(['m-done', 'm-failed', 'm-dead', 'm-cancelled']),
        nobody: await engine.listUnfinishedJobsByName(['nobody']), none: await engine.listUnfinishedJobsByName([]),
        ids: [waiting, running, delayed, paused, children, done, failed, dead, cancelled, second, outside].map(id => id - waiting),
      };
    });

  parityTest('listUnfinishedJobsByName reads every matching job in one go: 1,001 waiting jobs of one name come back whole, by id',
    { methods: ['admitJob', 'listUnfinishedJobsByName'], timeout: 180_000 }, async (engine) => {
      const first = await add(engine, 'm-many');
      for (let i = 1; i < 1001; i++) await admit(engine, { insert: values('m-many') });
      const rows = await engine.listUnfinishedJobsByName(['m-many']);
      return { count: rows.length, ordered: rows.every((r, i) => i === 0 || rows[i - 1]!.id < r.id), first: rows[0]!.id - first, last: rows[1000]!.id - first, statuses: [...new Set(rows.map(r => r.status))] };
    });

  parityTest('readJobStats counts by status, name, drain and queue depth, the stalled leases and one queue\'s wedge signature',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'cancelJobs', 'pauseJob', 'readJobStats'] }, async (engine) => {
      const normalize = (s: JobStatsRead) => ({
        by_status: sorted(s.by_status, r => r.status),
        types: sorted(s.types.map(t => ({ ...t, avg_duration_ms: t.avg_duration_ms === null ? null : typeof t.avg_duration_ms === 'number' && t.avg_duration_ms >= 0 })), r => r.name),
        drained: sorted(s.drained, r => r.name),
        depth: sorted(s.depth.map(d => ({ ...d, oldest_waiting_seconds: Number.isFinite(d.oldest_waiting_seconds) && d.oldest_waiting_seconds >= 0 })), r => r.name),
        stalled: s.stalled,
        wedge: { ...s.wedge, last_completed: s.wedge.last_completed === null ? null : /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/.test(s.wedge.last_completed) },
      });
      // Early rows, a cut-off, then later rows.
      await finished(engine, 'work', 'completed');
      await finished(engine, 'work', 'failed');
      const cancelled = await add(engine, 'other');
      await engine.cancelJobs([cancelled]);
      await finished(engine, 'side-work', 'completed', { queue: 'side' });
      await Bun.sleep(20);
      const cut = new Date();
      await Bun.sleep(20);
      await finished(engine, 'work', 'dead');
      await add(engine, 'work');
      await add(engine, 'other', { queue: 'side' });
      const paused = await add(engine, 'work');
      await engine.pauseJob(paused);
      await active(engine, 'running', 'w1:a');
      await active(engine, 'stalled', 'w2:a', {}, { lockDurationMs: -60_000 });
      const epoch = new Date(0);
      const future = new Date(Date.now() + 3_600_000);
      return {
        all: normalize(await engine.readJobStats(epoch, 'default')), since: normalize(await engine.readJobStats(cut, 'default')),
        side: normalize(await engine.readJobStats(epoch, 'side')), future: normalize(await engine.readJobStats(future, 'default')),
        none: normalize(await engine.readJobStats(epoch, 'nowhere')),
      };
    });

  parityTest('readQueueFamilyStats folds dream-inline queues into one family and lists families in byte order',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'readQueueFamilyStats'] }, async (engine) => {
      await add(engine, 'w0', { queue: 'default' });
      await finished(engine, 'w1', 'completed');
      await finished(engine, 'w2', 'failed');
      await add(engine, 'w3', { queue: 'dream-inline-1-aaaa' });
      await add(engine, 'w4', { queue: 'dream-inline-2-bbbb' });
      await finished(engine, 'w5', 'dead', { queue: 'dream-inline-2-bbbb' });
      await finished(engine, 'w6', 'completed', { queue: 'dream-inline-3-cccc' });
      await add(engine, 'w7', { queue: 'Zeta' });
      await add(engine, 'w8', { queue: 'alpha' });
      await add(engine, 'w9', { queue: '_under' });
      await active(engine, 'running', 'w1:a', { queue: 'beta' });
      await finished(engine, 'w10', 'completed', { queue: 'only-finished' });
      const future = new Date(Date.now() + 3_600_000);
      return { since: await engine.readQueueFamilyStats(new Date(0)), future: await engine.readQueueFamilyStats(future) };
    });

  parityTest('listUnreviewedJobs lists live jobs whose authority is not exactly the application authority, by id',
    { methods: ['admitJob', 'cancelJobs', 'pauseJob', 'listUnreviewedJobs'] }, async (engine) => {
      const application = await add(engine, 'app');
      const remote = await add(engine, 'remote', { submission_authority: OTHER_AUTHORITY });
      const extra = await add(engine, 'extra', { submission_authority: { version: 1, kind: 'application', note: 'x' } as unknown as SubmissionAuthority });
      const delayed = await add(engine, 'delayed', { status: 'delayed', delay_until: FAR, submission_authority: OTHER_AUTHORITY });
      const paused = await add(engine, 'paused', { submission_authority: OTHER_AUTHORITY });
      await engine.pauseJob(paused);
      const cancelled = await add(engine, 'cancelled', { submission_authority: OTHER_AUTHORITY });
      await engine.cancelJobs([cancelled]);
      const parent = await add(engine, 'parent');
      await add(engine, 'child', { parent_job_id: parent, submission_authority: OTHER_AUTHORITY });
      const list = async () => (await engine.listUnreviewedJobs()).map(r => ({ id: Number(r.id) - application, authority: r.submission_authority }));
      const before = await list();
      await engine.cancelJobs([parent]);
      return { before, after: await list(), ids: [remote, extra, delayed, paused, cancelled].map(id => id - application) };
    });

  parityTest('getFailedJobForRetry reads the name and data of a failed or dead job only',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'getFailedJobForRetry'] }, async (engine) => {
      const failed = await finished(engine, 'failed', 'failed', { data: { a: [1, { b: 2 }] } });
      const dead = await finished(engine, 'dead', 'dead', { data: { z: null } });
      const done = await finished(engine, 'done', 'completed');
      const waiting = await add(engine, 'waiting');
      return {
        failed: await engine.getFailedJobForRetry(failed), dead: await engine.getFailedJobForRetry(dead), done: await engine.getFailedJobForRetry(done),
        waiting: await engine.getFailedJobForRetry(waiting), missing: await engine.getFailedJobForRetry(failed + 100_000),
      };
    });

  // The delegated client's slot count (checkDelegatedCapacity). Owner matching is on the text of `__owner_client_id`, so a
  // number owner matches its digits and a null owner matches nothing.
  parityTest('countOpenJobsByOwner counts a delegated client\'s subagent jobs in every queue and non-terminal status',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'failJob', 'pauseJob', 'getJob', 'countOpenJobsByOwner'] }, async (engine) => {
      const owned = (owner: unknown, extra: Partial<JobInsertValues> = {}) => ({ data: { __owner_client_id: owner, task: 't' }, ...extra });
      const claimed = await active(engine, 'subagent', 'w1:a', owned('c1'), { names: ['subagent'] });
      await finished(engine, 'subagent', 'completed', owned('c1'));
      await finished(engine, 'subagent', 'failed', owned('c1'));
      const waiting = await add(engine, 'subagent', owned('c1'));
      const paused = await add(engine, 'subagent', owned('c1'));
      await engine.pauseJob(paused);
      await add(engine, 'subagent', owned('c1', { queue: 'side' }));
      await add(engine, 'subagent', owned('c1', { status: 'delayed', delay_until: FAR }));
      await add(engine, 'work', owned('c1'));
      await add(engine, 'subagent', owned('c2'));
      await add(engine, 'subagent', owned(7));
      await add(engine, 'subagent', owned(null));
      await add(engine, 'subagent', { data: { task: 'unowned' } });
      const count = (c: string) => engine.countOpenJobsByOwner(c);
      const before = { c1: await count('c1'), c2: await count('c2'), seven: await count('7'), nul: await count('null'), nobody: await count('nobody-example') };
      await engine.completeJob(claimed, 'w1:a');
      return { before, afterComplete: await count('c1'), statuses: [(await engine.getJob(waiting))?.status, (await engine.getJob(paused))?.status] };
    });

  parityTest('checkDelegatedCapacity refuses a delegated client at its limit and counts nothing without a limit',
    { methods: ['admitJob', 'countOpenJobsByOwner'] }, async (engine) => {
      await add(engine, 'subagent', { data: { __owner_client_id: 'c1' } });
      await add(engine, 'subagent', { data: { __owner_client_id: 'c1' }, queue: 'side' });
      const outcome = (limit: number | null) => checkDelegatedCapacity(engine, 'c1', limit).then(() => 'admitted', refusal);
      return { atLimit: await outcome(2), under: await outcome(3), unlimited: await outcome(null) };
    });

  // PGLite and Postgres lock the client's oauth_clients row (none here, so nothing is locked); the Rust store admits one
  // write at a time, so the lock holds nothing more and the call resolves the same way.
  parityTest('lockOAuthClient resolves for a client with no OAuth row',
    { methods: ['lockOAuthClient'] }, async (engine) => ({ locked: (await engine.lockOAuthClient('nobody-example')) ?? null }));

  parityTest('listJobPage filters by status, queue, name and the owner fence, newest first, and pages on the (created_at, id) cursor',
    { methods: ['admitJob', 'claimNextJob', 'listJobPage'] }, async (engine) => {
      const j = await ownerJobs(engine);
      const base = j.arrayAudience;
      const plain = await add(engine, 'work');
      await add(engine, 'work', { queue: 'side' });
      const running = await active(engine, 'running', 'w1:a');
      const ids = async (spec: Parameters<BrainEngine['listJobPage']>[0]) => (await engine.listJobPage(spec)).map(r => Number(r.id) - base);
      const pages: number[][] = [];
      let cursor: { micros: string; id: number } | null = null;
      for (let i = 0; i < 10; i++) {
        const rows: JobRow[] = await engine.listJobPage({ limit: 4, cursor });
        pages.push(rows.map(r => Number(r.id) - base));
        expect(rows.every(r => /^\d{16}$/.test(String(r.created_us)))).toBe(true);
        if (rows.length < 4) break;
        const last = rows[rows.length - 1]!;
        cursor = { micros: String(last.created_us), id: Number(last.id) };
      }
      // The tuple compares micros first, then id: the same micros with a higher id keeps the row, with its own id drops it.
      const anchor = (await engine.listJobPage({ limit: 3 }))[2]!;
      const same = { micros: String(anchor.created_us), id: Number(anchor.id) };
      return {
        all: await ids({ limit: 100 }), pages, limit: await ids({ limit: 2 }), status: await ids({ limit: 100, status: 'active' }), queue: await ids({ limit: 100, queue: 'side' }),
        name: await ids({ limit: 100, name: 'fenced' }), combined: await ids({ limit: 100, name: 'work', queue: 'default' }), nothing: await ids({ limit: 100, name: 'absent' }),
        owner: await ids({ limit: 100, ownerClientId: 'client-a', ownerActor: ['s', 'e', 'm', 'a,b'] }), ownerNoGrant: await ids({ limit: 100, ownerClientId: 'client-a', ownerActor: ['', '', '', ''] }),
        ownerOdd: await ids({ limit: 100, ownerClientId: 'client-a', ownerActor: ['', '42', 'm', '!'] }), ownerNoActor: await ids({ limit: 100, ownerClientId: 'client-a' }),
        ownerOther: await ids({ limit: 100, ownerClientId: 'client-b', ownerActor: ['s', 'e', 'm', 'a,b'] }), ownerStatus: await ids({ limit: 100, ownerClientId: 'client-a', ownerActor: ['s', 'e', 'm', ''], status: 'waiting' }),
        before: await ids({ limit: 100, cursor: same }), tie: await ids({ limit: 100, cursor: { micros: same.micros, id: same.id + 1_000_000 } }),
        beyond: await ids({ limit: 100, cursor: { micros: '1', id: 1 } }), map: { ...Object.fromEntries(Object.entries(j).map(([k, id]) => [k, id - base])), plain: plain - base, running: running - base },
      };
    });

  // ------------------------------------------------------------ attachments

  parityTest('job attachments store bytes, refuse a duplicate filename, list oldest first, and delete one at a time',
    { methods: ['admitJob', 'listJobAttachmentNames', 'insertJobAttachment', 'listJobAttachments', 'getJobAttachment', 'deleteJobAttachment'] }, async (engine) => {
      const job = await add(engine, 'work');
      const other = await add(engine, 'work');
      const empty = await engine.listJobAttachmentNames(job);
      const missingNames = await engine.listJobAttachmentNames(job + 100_000);
      const bytes = [0, 255, 1, 254, 128, 10, 13, 0];
      const first = await engine.insertJobAttachment(job, attachment('b.bin', bytes));
      const idBase = Number(first.id);
      const view = attachmentView(job, idBase);
      await Bun.sleep(2);
      const second = await engine.insertJobAttachment(job, attachment('a.txt', [104, 105], 'text/plain'));
      const sameName = await engine.insertJobAttachment(other, attachment('b.bin', [7]));
      const duplicate = await thrown(() => engine.insertJobAttachment(job, attachment('b.bin', [1, 2])));
      const noJob = await threw(() => engine.insertJobAttachment(job + 100_000, attachment('x', [1])));
      const got = await engine.getJobAttachment(job, 'b.bin');
      const read = {
        names: sorted((await engine.listJobAttachmentNames(job))!), listed: (await engine.listJobAttachments(job)).map(view),
        got: view(got), content: Array.from(got?.content as Uint8Array), gotText: view(await engine.getJobAttachment(job, 'a.txt')),
        missingName: await engine.getJobAttachment(job, 'nope.txt'), otherJob: view(await engine.getJobAttachment(other, 'b.bin')), noSuchJob: await engine.getJobAttachment(job + 100_000, 'b.bin'),
        isBuffer: got?.content instanceof Uint8Array,
      };
      // The SQL engines spend an identity value on the refused duplicate insert and Rust does not, so the new id is
      // compared only as later than every earlier one.
      const reinsert = async () => {
        const row = await engine.insertJobAttachment(job, attachment('b.bin', [3]));
        return { ...view(row), id: Number(row.id) > Number(second.id) };
      };
      const removed = [await engine.deleteJobAttachment(job, 'b.bin'), await engine.deleteJobAttachment(job, 'b.bin'), await engine.deleteJobAttachment(job, 'nope'), await engine.deleteJobAttachment(job + 100_000, 'a.txt')];
      return {
        empty, missingNames, first: view(first), second: view(second), sameName: view(sameName), duplicateRefused: duplicate !== null && /uniq_minion_attachments_job_filename/.test(String(duplicate.message)),
        noJob, read, removed, after: (await engine.listJobAttachments(job)).map(view), otherAfter: await engine.listJobAttachmentNames(other),
        gone: await engine.getJobAttachment(job, 'b.bin'), reinserted: await reinsert(),
      };
    });
});
