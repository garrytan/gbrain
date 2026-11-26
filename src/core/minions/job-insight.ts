/**
 * #7241: what a job row does not say by itself, computed on read: who submitted it (`submitted_by`), why a
 * job that is not running is not running (`blocked_by`), the lease liveness of an active job
 * (`heartbeat_age_ms`, `lock_expires_in_ms`, `stalled`) and what it spent (`spend`).
 *
 * Every time is measured on the database clock. An owner-fenced caller (an agent token without admin,
 * `ops/jobs.ts` agentOwnerFence) sees another principal only as its kind: a foreign submitter, parent,
 * queue-slot holder or lock holder is never named, and foreign children are left out of spend.
 */
import type { BrainEngine } from '../engine.ts';
import { parseGlobalFlags } from '../cli-options.ts';
import type { Action } from '../agent-output.ts';
import { currentSubmissionAuthority } from './submission-authority.ts';
import { currentChatPhase } from '../ai/chat-usage.ts';
import { jobOwnerSql, type MinionJob } from './types.ts';

const HOLDER_ROW_QUEUE = 'gbrain-drain-lease';
const LIST_CAP = 10;

let labelOverride: string | null = null;
/** Tests only: pin the label `submitterLabel` returns (null restores argv detection). */
export function setSubmitterLabelForTests(label: string | null): void { labelOverride = label; }

/**
 * The local submitter of an application job. A handler submitting from inside a running job is
 * `job:<name>`; otherwise the CLI command that owns the process (`autopilot`, `serve`, `worker` for
 * `jobs work` / `jobs supervisor`, `cli:<command>`), or `library` outside the CLI.
 */
export function submitterLabel(): string {
  if (labelOverride) return labelOverride;
  if (currentSubmissionAuthority()) {
    const phase = currentChatPhase();
    return phase?.startsWith('job:') ? phase : 'job';
  }
  let rest: string[];
  try { rest = parseGlobalFlags(process.argv.slice(2)).rest; } catch { return 'library'; }
  const [command, sub] = rest;
  if (!command || !/^[a-z][a-z0-9-]{0,40}$/.test(command)) return 'library';
  if (command === 'autopilot' || command === 'serve') return command;
  if (command === 'jobs' && (sub === 'work' || sub === 'supervisor')) return 'worker';
  return `cli:${command}`;
}

/**
 * Job data as `MinionQueue.add` stores it: a caller-supplied `__submitter` is always dropped, and an
 * application submit from a labelled local process carries `submitterLabel()` there. A display label only:
 * never authority, excluded from the param hash, and read back only for application-authority rows.
 */
export function withSubmitterLabel(data: Record<string, unknown> | undefined, application: boolean): Record<string, unknown> {
  const { __submitter: _dropped, ...rest } = data ?? {};
  const label = application ? submitterLabel() : 'library';
  return label === 'library' ? rest : { ...rest, __submitter: label };
}

export type SubmittedBy =
  | { kind: 'mcp_client'; id?: string; principal_kind?: string }
  | { kind: 'parent_job'; id?: number }
  | { kind: 'local'; via?: string }
  | { kind: 'unreviewed' };

export type DelayReason = 'retry_backoff' | 'deferred' | 'handed_back' | 'scheduled';

export type BlockedBy =
  | { kind: 'waiting_children'; pending: number; child_ids: number[] }
  | { kind: 'delayed'; delay_until: string | null; reason: DelayReason; detail?: string }
  | { kind: 'paused' }
  | { kind: 'unreviewed_authority'; fix: Action }
  | { kind: 'queue'; queue: string; queue_position: number; ahead: number; active: number; active_jobs: Array<{ id: number; name: string }>; private_queue?: true }
  | { kind: 'lock'; held: true; lock?: string; holder_job_id?: number; holder?: { kind: string; pid?: number; host?: string; acquired_at: string | null; ttl_expires_at: string | null } };

export interface JobSpend {
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  /** Settled, priced provider spend (mcp_spend_reservations) of the job and its visible descendants; null when none was priced. */
  cost_usd: number | null;
  cost_basis: 'settled_reservations' | 'unpriced';
  includes_children: boolean;
  /** Reservations still pending, expired or settled without usage: their cost is not in cost_usd. */
  unsettled_reservations: number;
  /** Fenced callers: completed children of another principal were subtracted from the token counts. */
  excludes_foreign_children?: true;
}

export interface JobInsight {
  submitted_by: SubmittedBy;
  blocked_by: BlockedBy[] | null;
  heartbeat_age_ms: number | null;
  heartbeat_basis: 'lease' | 'updated_at' | null;
  lock_expires_in_ms: number | null;
  stalled: boolean | null;
  spend: JobSpend;
}

export interface InsightOpts {
  /** Owner-fenced caller's client id (agentOwnerFence); null or absent = unfenced. */
  owner?: string | null;
  /** Remote caller: lock holder host and pid are never shown. */
  remote?: boolean;
}

export const JOB_INSIGHT_FIELDS: readonly string[] = ['submitted_by', 'blocked_by', 'heartbeat_age_ms', 'heartbeat_basis', 'lock_expires_in_ms', 'stalled', 'spend'];

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const time = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const record = (v: unknown): Record<string, unknown> | null => {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
};

function sourceOf(job: MinionJob): string {
  const s = job.data?.sourceId ?? job.data?.source_id;
  return typeof s === 'string' && s.length > 0 ? s : 'default';
}

/** The DB-row locks a job that is not running takes when it runs: a sync takes gbrain-sync:<src>, a cycle also gbrain-cycle:<src>. */
function locksFor(job: MinionJob): string[] {
  const src = sourceOf(job);
  if (job.name === 'sync') return [`gbrain-sync:${src}`];
  if (job.name === 'autopilot-cycle') return [`gbrain-cycle:${src}`, `gbrain-sync:${src}`];
  return [];
}

function delayReason(job: MinionJob): { reason: DelayReason; detail?: string } {
  const text = job.error_text ?? '';
  const detail = text ? { detail: text.slice(0, 200) } : {};
  if (text.startsWith('deferred')) return { reason: 'deferred', ...detail };
  if (text.startsWith('worker_shutdown') || text.includes('released')) return { reason: 'handed_back', ...detail };
  if (job.attempts_made > 0 && text) return { reason: 'retry_backoff', ...detail };
  return { reason: 'scheduled', ...detail };
}

type LockRow = { holder_pid: number; holder_host: string | null; acquired_at: unknown; ttl_expires_at: unknown; beacon: Record<string, unknown> | null; holder_owner: string | null };
type SpendRow = { root: number; self: boolean; settled_cents: number | string | null; priced: number | string; unsettled: number | string };

/** Insight for each job, keyed by id. Read-only. */
export async function describeJobs(engine: BrainEngine, jobs: MinionJob[], opts: InsightOpts = {}): Promise<Map<number, JobInsight>> {
  const out = new Map<number, JobInsight>();
  if (jobs.length === 0) return out;
  const owner = opts.owner ?? null;
  const ids = jobs.map(j => j.id);
  const owns = (o: unknown) => owner === null || o === owner;

  const [clock] = await engine.executeRaw<{ now: string }>('SELECT now() AS now');
  const now = new Date(clock.now).getTime();

  const meta = new Map((await engine.executeRaw<{ id: number; submitter: string | null; parent_owner: string | null }>(
    `SELECT j.id, CASE WHEN j.submission_authority->>'kind' = 'application' THEN j.data->>'__submitter' END AS submitter,
            ${jobOwnerSql('p')} AS parent_owner
       FROM minion_jobs j LEFT JOIN minion_jobs p ON p.id = j.parent_job_id
      WHERE j.id = ANY($1::int[])`, [ids])).map(r => [Number(r.id), r]));

  const waiting = jobs.filter(j => j.status === 'waiting');
  const positions = new Map<number, number>();
  const holders = new Map<string, Array<{ id: number; name: string; owner: string | null }>>();
  if (waiting.length > 0) {
    const ahead = await engine.executeRaw<{ id: number; ahead: number | string }>(
      `SELECT j.id, (SELECT count(*) FROM minion_jobs w
                      WHERE w.queue = j.queue AND w.status = 'waiting'
                        AND (w.priority, w.created_at, w.id) < (j.priority, j.created_at, j.id)) AS ahead
         FROM minion_jobs j WHERE j.id = ANY($1::int[])`, [waiting.map(j => j.id)]);
    for (const r of ahead) positions.set(Number(r.id), num(r.ahead));
    const active = await engine.executeRaw<{ id: number; name: string; queue: string; owner: string | null }>(
      `SELECT id, name, queue, ${jobOwnerSql()} AS owner FROM minion_jobs
        WHERE status = 'active' AND queue = ANY($1::text[]) AND queue <> $2 ORDER BY started_at ASC NULLS LAST, id ASC LIMIT 500`,
      [[...new Set(waiting.map(j => j.queue))], HOLDER_ROW_QUEUE]);
    for (const r of active) {
      const list = holders.get(r.queue) ?? [];
      list.push({ id: Number(r.id), name: r.name, owner: r.owner });
      holders.set(r.queue, list);
    }
  }

  const children = new Map<number, Array<{ id: number; owner: string | null }>>();
  const parents = jobs.filter(j => j.status === 'waiting-children');
  if (parents.length > 0) {
    const rows = await engine.executeRaw<{ id: number; parent_job_id: number; owner: string | null }>(
      `SELECT id, parent_job_id, ${jobOwnerSql()} AS owner FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status NOT IN ('completed','failed','dead','cancelled') ORDER BY id ASC`,
      [parents.map(j => j.id)]);
    for (const r of rows) {
      const list = children.get(Number(r.parent_job_id)) ?? [];
      list.push({ id: Number(r.id), owner: r.owner });
      children.set(Number(r.parent_job_id), list);
    }
  }

  const locks = new Map<string, LockRow>();
  const lockIds = [...new Set(jobs.filter(j => j.status === 'waiting' || j.status === 'delayed').flatMap(locksFor))];
  if (lockIds.length > 0) {
    const rows = await engine.executeRaw<LockRow & { id: string; beacon: unknown }>(
      `SELECT l.id, l.holder_pid, l.holder_host, l.acquired_at, l.ttl_expires_at, b.data->'drain_lease_beacon' AS beacon,
              ${jobOwnerSql('h')} AS holder_owner
         FROM gbrain_cycle_locks l
         LEFT JOIN minion_jobs b ON b.queue = $2 AND b.lock_token = l.acquisition_token::text
         LEFT JOIN minion_jobs h ON (b.data->'drain_lease_beacon'->>'kind') = 'job'
                                AND h.id::text = (b.data->'drain_lease_beacon'->>'id')
        WHERE l.id = ANY($1::text[]) AND l.ttl_expires_at > now()`, [lockIds, HOLDER_ROW_QUEUE]);
    for (const r of rows) locks.set(r.id, { ...r, beacon: record(r.beacon) });
  }

  const spendRows = await engine.executeRaw<SpendRow>(
    `WITH RECURSIVE tree(root, id, owner, depth) AS (
       SELECT id, id, ${jobOwnerSql()}, 0 FROM minion_jobs WHERE id = ANY($1::int[])
       UNION ALL
       SELECT t.root, c.id, ${jobOwnerSql('c')}, t.depth + 1 FROM minion_jobs c JOIN tree t ON c.parent_job_id = t.id WHERE t.depth < 20
     )
     SELECT t.root, (t.id = t.root) AS self,
            sum(r.actual_cents) FILTER (WHERE r.status = 'settled' AND r.actual_cents IS NOT NULL) AS settled_cents,
            count(*) FILTER (WHERE r.status = 'settled' AND r.actual_cents IS NOT NULL) AS priced,
            count(*) FILTER (WHERE r.status <> 'settled' OR r.actual_cents IS NULL) AS unsettled
       FROM tree t JOIN mcp_spend_reservations r ON r.job_id = t.id
      WHERE t.id = t.root OR $2::text IS NULL OR t.owner = $2::text
      GROUP BY 1, 2`, [ids, owner]);
  const foreignTokens = new Map<number, { i: number; o: number; c: number }>();
  if (owner !== null) {
    const rows = await engine.executeRaw<{ parent_job_id: number; i: number | string; o: number | string; c: number | string }>(
      `SELECT parent_job_id, sum(tokens_input) AS i, sum(tokens_output) AS o, sum(tokens_cache_read) AS c FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status = 'completed' AND ${jobOwnerSql()} IS DISTINCT FROM $2::text
        GROUP BY 1`, [ids, owner]);
    for (const r of rows) foreignTokens.set(Number(r.parent_job_id), { i: num(r.i), o: num(r.o), c: num(r.c) });
  }

  const ctx: BlockCtx = { positions, holders, children, locks, owns, owner, remote: opts.remote === true };
  for (const job of jobs) {
    out.set(job.id, {
      submitted_by: submittedBy(job, meta.get(job.id), owner),
      blocked_by: blockedBy(job, ctx),
      ...liveness(job, now),
      spend: spendOf(job, spendRows.filter(r => Number(r.root) === job.id), foreignTokens.get(job.id)),
    });
  }
  return out;
}

function submittedBy(job: MinionJob, m: { submitter: string | null; parent_owner: string | null } | undefined, owner: string | null): SubmittedBy {
  const authority = job.submission_authority;
  if (authority && authority.kind !== 'application') {
    const id = authority.principal.id;
    if (owner !== null && id !== owner) return { kind: 'mcp_client' };
    return { kind: 'mcp_client', id, principal_kind: authority.principal.kind };
  }
  if (job.parent_job_id != null) {
    if (owner !== null && m?.parent_owner !== owner) return { kind: 'parent_job' };
    return { kind: 'parent_job', id: job.parent_job_id };
  }
  if (!authority) return { kind: 'unreviewed' };
  if (owner !== null || !m?.submitter) return { kind: 'local' };
  return { kind: 'local', via: m.submitter };
}

interface BlockCtx {
  positions: Map<number, number>;
  holders: Map<string, Array<{ id: number; name: string; owner: string | null }>>;
  children: Map<number, Array<{ id: number; owner: string | null }>>;
  locks: Map<string, LockRow>;
  owns: (o: unknown) => boolean;
  owner: string | null;
  remote: boolean;
}

function blockedBy(job: MinionJob, c: BlockCtx): BlockedBy[] | null {
  const reasons: BlockedBy[] = [];
  if (job.status === 'waiting-children') {
    const kids = c.children.get(job.id) ?? [];
    reasons.push({ kind: 'waiting_children', pending: kids.length, child_ids: kids.filter(k => c.owns(k.owner)).slice(0, LIST_CAP).map(k => k.id) });
  } else if (job.status === 'delayed') {
    reasons.push({ kind: 'delayed', delay_until: iso(job.delay_until), ...delayReason(job) });
  } else if (job.status === 'paused') {
    reasons.push({ kind: 'paused' });
  } else if (job.status === 'waiting') {
    if (!job.submission_authority) reasons.push({ kind: 'unreviewed_authority', fix: {
      argv: ['gbrain', 'jobs', 'authorize-legacy', '--ids', String(job.id)], consent: [], actor: 'user', requires_exclusive: false,
      why: 'This job was queued before submission authority existed; the host operator previews it here and then authorizes it to run.' } });
    const active = c.holders.get(job.queue) ?? [];
    const ahead = c.positions.get(job.id) ?? 0;
    reasons.push({ kind: 'queue', queue: job.queue, queue_position: ahead + 1, ahead, active: active.length,
      active_jobs: active.filter(h => c.owns(h.owner)).slice(0, LIST_CAP).map(h => ({ id: h.id, name: h.name })),
      ...(job.queue.startsWith('dream-inline-') ? { private_queue: true as const } : {}) });
  } else {
    return null;
  }
  if (job.status !== 'waiting' && job.status !== 'delayed') return reasons;
  for (const id of locksFor(job)) {
    const lock = c.locks.get(id);
    if (!lock) continue;
    const beacon = lock.beacon;
    const holderJob = beacon?.kind === 'job' && typeof beacon.id === 'string' && /^\d+$/.test(beacon.id) ? Number(beacon.id) : null;
    if (holderJob === job.id) continue;
    if (c.owner !== null) {
      reasons.push(holderJob !== null && lock.holder_owner === c.owner ? { kind: 'lock', held: true, lock: id, holder_job_id: holderJob } : { kind: 'lock', held: true });
      continue;
    }
    reasons.push({ kind: 'lock', held: true, lock: id, ...(holderJob !== null ? { holder_job_id: holderJob } : {}),
      holder: { kind: typeof beacon?.kind === 'string' ? beacon.kind : 'unknown',
        ...(c.remote ? {} : { pid: Number(lock.holder_pid), ...(lock.holder_host ? { host: lock.holder_host } : {}) }),
        acquired_at: iso(lock.acquired_at), ttl_expires_at: iso(lock.ttl_expires_at) } });
  }
  return reasons;
}

function liveness(job: MinionJob, now: number): Pick<JobInsight, 'heartbeat_age_ms' | 'heartbeat_basis' | 'lock_expires_in_ms' | 'stalled'> {
  const until = time(job.lock_until);
  if (job.status !== 'active' || until === null) return { heartbeat_age_ms: null, heartbeat_basis: null, lock_expires_in_ms: null, stalled: null };
  const renewedAt = job.lock_duration_ms != null ? until - job.lock_duration_ms : time(job.updated_at);
  return {
    heartbeat_age_ms: renewedAt === null ? null : Math.max(0, now - renewedAt),
    heartbeat_basis: job.lock_duration_ms != null ? 'lease' : 'updated_at',
    lock_expires_in_ms: until - now,
    stalled: until < now,
  };
}

function spendOf(job: MinionJob, rows: SpendRow[], foreign: { i: number; o: number; c: number } | undefined): JobSpend {
  const priced = rows.reduce((n, r) => n + num(r.priced), 0);
  const cents = rows.reduce((n, r) => n + num(r.settled_cents), 0);
  return {
    tokens_input: Math.max(0, job.tokens_input - (foreign?.i ?? 0)),
    tokens_output: Math.max(0, job.tokens_output - (foreign?.o ?? 0)),
    tokens_cache_read: Math.max(0, job.tokens_cache_read - (foreign?.c ?? 0)),
    cost_usd: priced > 0 ? Math.round(cents * 100) / 10_000 : null,
    cost_basis: priced > 0 ? 'settled_reservations' : 'unpriced',
    includes_children: rows.some(r => !r.self && num(r.priced) > 0),
    unsettled_reservations: rows.reduce((n, r) => n + num(r.unsettled), 0),
    ...(foreign ? { excludes_foreign_children: true as const } : {}),
  };
}

/**
 * The job with its insight merged in. A fenced caller's top-level token counts are replaced by the spend
 * counts, which leave out another principal's completed children (completeJob rolls child tokens into the parent).
 */
export function withInsight<T extends object>(job: T, insight: JobInsight | undefined): T & Partial<JobInsight> {
  if (!insight) return job;
  const tokens = insight.spend.excludes_foreign_children
    ? { tokens_input: insight.spend.tokens_input, tokens_output: insight.spend.tokens_output, tokens_cache_read: insight.spend.tokens_cache_read }
    : {};
  return { ...job, ...tokens, ...insight };
}

/** One compact cell for `jobs list`: why a job waits, or the liveness of a running one. */
export function insightCell(job: MinionJob, insight: JobInsight | undefined): string {
  if (!insight) return '';
  if (job.status === 'active') {
    if (insight.stalled) return 'STALLED';
    return insight.heartbeat_age_ms === null ? '' : `hb ${Math.round(insight.heartbeat_age_ms / 1000)}s`;
  }
  const reasons = insight.blocked_by ?? [];
  const first = reasons.find(b => b.kind !== 'lock' && b.kind !== 'unreviewed_authority') ?? reasons[0];
  if (!first) return '';
  const lock = reasons.some(b => b.kind === 'lock') ? ' +lock' : '';
  switch (first.kind) {
    case 'queue': return `#${first.queue_position} (${first.active} run)${lock}`;
    case 'waiting_children': return `${first.pending} children`;
    case 'delayed': return `${first.reason}${lock}`;
    case 'paused': return 'paused';
    case 'unreviewed_authority': return 'unreviewed';
    case 'lock': return 'lock';
  }
}
