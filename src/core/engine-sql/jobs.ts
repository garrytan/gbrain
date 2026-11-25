/**
 * Minion jobs: the `minion_jobs` lifecycle statements, SQL once for both engines.
 *
 * `MinionQueue` (minions/queue.ts) keeps the policy that runs before and after a statement: validation, the admission
 * policy lookup, the parameter hash, the unreviewed-job gate, stale-plan retries, the coalesce audit flush and spend
 * adoption. The statements, and the order they run in inside each transaction, live here, so the queue reaches the
 * database through typed engine members and a store that is not SQL can serve the same members.
 *
 * Every function takes the transaction (or, for claim and renewal, the engine's direct session pool) it runs on. The
 * statements are the ones the queue ran; the claim and list statements are composed with `sqlFragment`, so their
 * placeholders are numbered once at render time and a value the queue's text named twice is bound twice.
 *
 * Rows come back raw. The queue maps them with `rowToMinionJob`, which stays out of the engine module closure.
 */
import type { BrainEngine } from '../engine.ts';
import { QueueQuotaExceededError } from '../minions/admission.ts';
import { WATCHDOG_SUSPECT_MARK } from '../minions/watchdog-attribution.ts';
import type { LeaseToken } from './lease-token.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

export type JobRow = Record<string, unknown>;
type Raw = Pick<BrainEngine, 'executeRaw'>;
type Direct = Pick<BrainEngine, 'executeRawDirect'>;

/** Audit payload of a coalesced submission, flushed by the queue after commit. */
export type CoalesceAuditEvent = {
  queue: string; name: string; returned_job_id: number;
  waiting_count?: number; max_waiting?: number;
  pending_count?: number; max_pending?: number;
  /** Set when the coalesce matched on an identical payload hash (admission). */
  param_hash?: string;
};

/** The INSERT values of a submission, defaults already applied by the queue. `depth` comes from the parent. */
export interface JobInsertValues {
  name: string;
  queue: string;
  status: 'waiting' | 'delayed';
  priority: number;
  data: unknown;
  max_attempts: number;
  backoff_type: string;
  backoff_delay: number;
  backoff_jitter: number;
  delay_until: string | null;
  parent_job_id: number | null;
  on_child_fail: string;
  max_children: number | null;
  timeout_ms: number | null;
  lock_duration_ms: number | null;
  remove_on_complete: boolean;
  remove_on_fail: boolean;
  idempotency_key: string | null;
  quiet_hours: unknown;
  stagger_key: string | null;
  private_queue_owner_job_id: number | null;
  private_queue_owner_token: string | null;
  private_queue_lease_until: string | null;
  submission_authority: unknown;
  /** JSON text of the spend authorization record, or null. */
  spend_authorization: string | null;
  /** Clamped `max_stalled`; null leaves the column to its schema default. */
  max_stalled: number | null;
}

/** One admission: the row to insert and every check that may return an existing row or refuse it. */
export interface AdmitJobSpec {
  insert: JobInsertValues;
  /** Return the newest identical waiting row (same name, queue and payload hash) instead of inserting. */
  paramCoalesce?: { paramHash: string; maxAgeHours: number | null } | null;
  /** Refuse when this many rows of the name already wait, across every queue. */
  quotaMaxWaiting?: number | null;
  /** Return an existing row when the (name, queue, source) scope is at its pending or waiting cap. */
  backpressure?: { sourceId: string | null; maxPending?: number; maxWaiting?: number } | null;
  maxSpawnDepth: number;
}

/** Caller policy run inside the admission transaction. */
export interface AdmitJobPolicy {
  /** Takes the delegated client's lock; returns its concurrency limit (null: none). */
  lock?: (tx: BrainEngine) => Promise<number | null>;
  /** Refuses when the delegated client is at `limit`. */
  checkCapacity?: (tx: BrainEngine, limit: number | null) => Promise<void>;
  /** Whether an existing row (selected with `legacy_authority_is_null`) is returned or its key released. */
  decide: (tx: BrainEngine, row: JobRow) => Promise<'coalesce' | 'release'>;
  /** The parent's authority kind from its raw column (null: none or unparseable). Default: the JSON object's `kind`. */
  parentAuthorityKind?: (raw: unknown) => string | null;
}

export interface AdmitJobResult {
  row: JobRow;
  coalesced: boolean;
  /** Set when a backpressure or parameter coalesce returned the row. */
  audit: CoalesceAuditEvent | null;
}

const NON_TERMINAL = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'paused']);
const KEYED_ROW_SQL = 'SELECT *, submission_authority IS NULL AS legacy_authority_is_null FROM minion_jobs WHERE idempotency_key = $1';
const PARENT_FOR_UPDATE_SQL = 'SELECT * FROM minion_jobs WHERE id = $1 FOR UPDATE';
const CHILD_DONE_SQL = `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`;
const RESOLVE_PARENT_SQL = `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`;

function defaultAuthorityKind(raw: unknown): string | null {
  const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  return value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string' ? (value as { kind: string }).kind : null;
}

/** Frees a dead or cancelled row's key, keeping it in the row's data; rechecks key, status and authority NULL-ness. */
async function releaseIdempotencyKey(tx: Raw, row: JobRow, key: string): Promise<void> {
  await tx.executeRaw(
    `UPDATE minion_jobs SET idempotency_key = NULL, data = data || $2::text::jsonb
      WHERE id = $1 AND idempotency_key = $3 AND status IN ('dead','cancelled')
        AND (submission_authority IS NULL) = $4::boolean`,
    [row.id, JSON.stringify({ __released_idempotency_key: key }), key, row.legacy_authority_is_null === true],
  );
}

/** The row holding `key`, when `decide` coalesces onto it; null once a releasable key was freed (or none exists). */
export async function coalesceOnIdempotencyKey(tx: BrainEngine, key: string, decide: AdmitJobPolicy['decide']): Promise<JobRow | null> {
  const [existing] = await tx.executeRaw<JobRow>(KEYED_ROW_SQL, [key]);
  if (!existing) return null;
  if (await decide(tx, existing) === 'coalesce') return existing;
  await releaseIdempotencyKey(tx, existing, key);
  return null;
}

/** Runs the INSERT; on an `ON CONFLICT DO NOTHING` miss applies `decide` to the winner, releasing and retrying once. */
async function insertOrCoalesce(
  tx: BrainEngine, insertSql: string, params: unknown[], key: string | null, decide: AdmitJobPolicy['decide'],
): Promise<{ inserted: JobRow } | { coalesced: JobRow }> {
  let [inserted] = await tx.executeRaw<JobRow>(insertSql, params);
  for (let retried = false; !inserted && key; retried = true) {
    const [winner] = await tx.executeRaw<JobRow>(KEYED_ROW_SQL, [key]);
    if (!winner) throw new Error(`idempotency_key ${key} insert returned no row and no existing row found`);
    if (await decide(tx, winner) === 'coalesce') return { coalesced: winner };
    if (retried) throw new Error(`idempotency_key ${key} was released but the retried insert still conflicted`);
    await releaseIdempotencyKey(tx, winner, key);
    [inserted] = await tx.executeRaw<JobRow>(insertSql, params);
  }
  return { inserted: inserted! };
}

const INSERT_COLUMNS = `name, queue, status, priority, data, max_attempts, backoff_type,
            backoff_delay, backoff_jitter, delay_until, parent_job_id, on_child_fail,
            depth, max_children, timeout_ms, lock_duration_ms, remove_on_complete, remove_on_fail, idempotency_key,
            quiet_hours, stagger_key, private_queue_owner_job_id, private_queue_owner_token, private_queue_lease_until, submission_authority, spend_authorization`;

function insertStatement(v: JobInsertValues, depth: number): { text: string; params: unknown[] } {
  const stalled = v.max_stalled !== null;
  const values = sqlFragment`${v.name}, ${v.queue}, ${v.status}, ${v.priority}, ${v.data}::jsonb, ${v.max_attempts}, ${v.backoff_type}, ${v.backoff_delay}, ${v.backoff_jitter}, ${v.delay_until}, ${v.parent_job_id}, ${v.on_child_fail}, ${depth}, ${v.max_children}, ${v.timeout_ms}, ${v.lock_duration_ms}, ${v.remove_on_complete}, ${v.remove_on_fail}, ${v.idempotency_key}, ${v.quiet_hours}::jsonb, ${v.stagger_key}, ${v.private_queue_owner_job_id}, ${v.private_queue_owner_token}, ${v.private_queue_lease_until}, ${v.submission_authority}::jsonb, ${v.spend_authorization}::text::jsonb`;
  const conflict = v.idempotency_key ? sqlFragment`
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` : sqlFragment``;
  return renderFragment(sqlFragment`INSERT INTO minion_jobs (${trustedSql(INSERT_COLUMNS)}${stalled ? trustedSql(', max_stalled') : trustedSql('')})
           VALUES (${values}${stalled ? sqlFragment`, ${v.max_stalled}` : sqlFragment``})${conflict}
           RETURNING *`);
}

const PENDING_COND = `(status = 'waiting' OR (status = 'active' AND lock_until > now()))`;
const SCOPE_EXACT = `COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $3`;

/**
 * Submission: idempotency fast path, parameter coalesce, delegated capacity, name quota, backpressure caps, parent
 * checks, the insert and the parent flip to `waiting-children`, in one transaction and in that order. The advisory
 * locks serialize each check with its insert for the same scope.
 */
export async function admitJob(tx: BrainEngine, spec: AdmitJobSpec, policy: AdmitJobPolicy): Promise<AdmitJobResult> {
  const v = spec.insert;
  const coalesce = async (row: JobRow, audit: Omit<CoalesceAuditEvent, 'returned_job_id'>): Promise<AdmitJobResult> => {
    if (await policy.decide(tx, row) !== 'coalesce') throw new Error(`job ${String(row.id)} is ${String(row.status)} and cannot be a coalesce target`);
    return { row, coalesced: true, audit: { ...audit, returned_job_id: Number(row.id) } };
  };
  const delegatedLimit = policy.lock ? await policy.lock(tx) : null;
  if (v.idempotency_key) {
    const existing = await coalesceOnIdempotencyKey(tx, v.idempotency_key, policy.decide);
    if (existing) return { row: existing, coalesced: true, audit: null };
  }

  if (spec.paramCoalesce) {
    const { paramHash, maxAgeHours } = spec.paramCoalesce;
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(hashtext('minion_admission:' || $1 || ':' || $2 || ':' || $3))`, [v.name, v.queue, paramHash]);
    const age = maxAgeHours != null ? sqlFragment`
              AND updated_at > now() - (${maxAgeHours} * interval '1 hour')` : sqlFragment``;
    const { text, params } = renderFragment(sqlFragment`SELECT *, submission_authority IS NULL AS legacy_authority_is_null FROM minion_jobs
            WHERE name = ${v.name} AND queue = ${v.queue} AND status = 'waiting'
              AND parent_job_id IS NULL
              AND data->>'__param_hash' = ${paramHash}${age}
            ORDER BY created_at DESC, id DESC
            LIMIT 1`);
    const [match] = await tx.executeRaw<JobRow>(text, params);
    if (match) return coalesce(match, { queue: v.queue, name: v.name, param_hash: paramHash });
  }

  if (policy.checkCapacity) await policy.checkCapacity(tx, delegatedLimit);

  if (spec.quotaMaxWaiting != null) {
    await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext('minion_quota:' || $1))`, [v.name]);
    const [quota] = await tx.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM minion_jobs WHERE name = $1 AND status = 'waiting'`, [v.name]);
    const waiting = parseInt(quota?.count ?? '0', 10);
    if (waiting >= spec.quotaMaxWaiting) throw new QueueQuotaExceededError(v.name, waiting, spec.quotaMaxWaiting);
  }

  const bp = spec.backpressure;
  if (bp && (bp.maxPending !== undefined || bp.maxWaiting !== undefined)) {
    const scope = [v.name, v.queue, bp.sourceId];
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(hashtext('minion_maxwaiting:' || $1 || ':' || $2 || ':' || coalesce($3, '')))`, scope);
    if (bp.maxPending !== undefined) {
      const maxPending = Math.max(1, Math.floor(bp.maxPending));
      const [counted] = await tx.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count
             FROM minion_jobs
             WHERE name = $1 AND queue = $2 AND (status = 'waiting' OR (status = 'active' AND lock_until > now()))
               AND COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $3`, scope);
      const pending = parseInt(counted?.count ?? '0', 10);
      if (pending >= maxPending) {
        const [existing] = await tx.executeRaw<JobRow>(
          `SELECT *, submission_authority IS NULL AS legacy_authority_is_null FROM minion_jobs
               WHERE name = $1 AND queue = $2 AND (status = 'waiting' OR (status = 'active' AND lock_until > now()))
                 AND COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $3
               ORDER BY CASE WHEN status = 'waiting' THEN 0 ELSE 1 END, created_at DESC, id DESC
               LIMIT 1`, scope);
        if (existing) return coalesce(existing, { queue: v.queue, name: v.name, pending_count: pending, max_pending: maxPending });
      }
    }
    if (bp.maxWaiting !== undefined) {
      const maxWaiting = Math.max(1, Math.floor(bp.maxWaiting));
      const [counted] = await tx.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count
             FROM minion_jobs
             WHERE name = $1 AND queue = $2 AND status = 'waiting'
               AND ($3::text IS NULL OR COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $3)`, scope);
      const waiting = parseInt(counted?.count ?? '0', 10);
      if (waiting >= maxWaiting) {
        const [existing] = await tx.executeRaw<JobRow>(
          `SELECT *, submission_authority IS NULL AS legacy_authority_is_null FROM minion_jobs
               WHERE name = $1 AND queue = $2 AND status = 'waiting'
                 AND ($3::text IS NULL OR COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $3)
               ORDER BY created_at DESC, id DESC
               LIMIT 1`, scope);
        if (existing) return coalesce(existing, { queue: v.queue, name: v.name, waiting_count: waiting, max_waiting: maxWaiting });
      }
    }
  }

  let depth = 0;
  if (v.parent_job_id) {
    const [parent] = await tx.executeRaw<JobRow>(PARENT_FOR_UPDATE_SQL, [v.parent_job_id]);
    if (!parent) throw new Error(`parent_job_id ${v.parent_job_id} not found`);
    const kind = policy.parentAuthorityKind ? policy.parentAuthorityKind(parent.submission_authority) : defaultAuthorityKind(parent.submission_authority);
    if (kind !== null && kind !== 'application') throw new Error('Remote jobs cannot have descendants');
    if (!NON_TERMINAL.has(String(parent.status))) throw new Error(`parent job ${v.parent_job_id} is ${String(parent.status)}; a finished job cannot get new children`);
    depth = Number(parent.depth ?? 0) + 1;
    if (depth > spec.maxSpawnDepth) throw new Error(`spawn depth ${depth} exceeds maxSpawnDepth ${spec.maxSpawnDepth}`);
    const maxChildren = parent.max_children == null ? null : Number(parent.max_children);
    if (maxChildren !== null) {
      const [counted] = await tx.executeRaw<{ count: string }>(
        `SELECT count(*)::text as count FROM minion_jobs
             WHERE parent_job_id = $1 AND status NOT IN ('completed','failed','dead','cancelled')`, [v.parent_job_id]);
      const live = parseInt(counted?.count ?? '0', 10);
      if (live >= maxChildren) throw new Error(`parent ${v.parent_job_id} already has ${live} live children (max_children=${maxChildren})`);
    }
  }

  const { text, params } = insertStatement(v, depth);
  const outcome = await insertOrCoalesce(tx, text, params, v.idempotency_key, policy.decide);
  if ('coalesced' in outcome) return { row: outcome.coalesced, coalesced: true, audit: null };
  if (v.parent_job_id) {
    await tx.executeRaw(
      `UPDATE minion_jobs SET status = 'waiting-children', updated_at = now()
           WHERE id = $1 AND status IN ('waiting','active','delayed')`, [v.parent_job_id]);
  }
  return { row: outcome.inserted, coalesced: false, audit: null };
}

export async function getJob(tx: Raw, id: number): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>('SELECT * FROM minion_jobs WHERE id = $1', [id]);
  return row ?? null;
}

/** The given ids whose job is waiting, active, delayed, waiting-children or paused; a finished or missing job is dropped. */
export async function readLiveJobIds(tx: Raw, ids: number[]): Promise<number[]> {
  const rows = await tx.executeRaw<{ id: unknown }>(
    "SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) AND status IN ('waiting','active','delayed','waiting-children','paused')", [ids]);
  return rows.map(r => Number(r.id));
}

/** `{ data }` of the job holding `key` (any status), or null; serve-http-webhooks.ts legacyIngestJob reads it. */
export async function readJobDataByIdempotencyKey(tx: Raw, key: string): Promise<{ data: unknown } | null> {
  const [row] = await tx.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE idempotency_key = $1', [key]);
  return row ?? null;
}

export interface ListJobsFilter {
  status?: string;
  queue?: string;
  name?: string;
  /** Only jobs whose `data->>'__owner_client_id'` is this OAuth client id. */
  ownerClientId?: string;
  limit?: number;
  offset?: number;
}

/** Jobs matching every given filter, newest first (default 50 from offset 0). */
export async function listJobs(tx: Raw, filter: ListJobsFilter = {}): Promise<JobRow[]> {
  const conditions: SqlFragment[] = [];
  if (filter.status) conditions.push(sqlFragment`status = ${filter.status}`);
  if (filter.queue) conditions.push(sqlFragment`queue = ${filter.queue}`);
  if (filter.name) conditions.push(sqlFragment`name = ${filter.name}`);
  if (filter.ownerClientId) conditions.push(sqlFragment`data->>'__owner_client_id' = ${filter.ownerClientId}`);
  const where = conditions.length > 0 ? sqlFragment`WHERE ${joinFragments(conditions, ' AND ')} ` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT * FROM minion_jobs ${where}ORDER BY created_at DESC LIMIT ${filter.limit ?? 50} OFFSET ${filter.offset ?? 0}`);
  return tx.executeRaw<JobRow>(text, params);
}

/** The NULL-record rows of the consent-gated producers (spend-authorization.ts `LEGACY_SPEND_KEY_PREFIXES`). */
export const LEGACY_SPEND_PREDICATE_SQL = "(name = 'subagent' AND (idempotency_key LIKE 'book-mirror:%')) OR (name = 'enrich' AND (idempotency_key LIKE 'enrich:%' OR idempotency_key LIKE 'cli:enrich:%'))";

export interface ClaimJobSpec {
  lockToken: string;
  /** The worker's lease, used when neither the row nor the handler map names one. */
  lockDurationMs: number;
  queue: string;
  names: string[];
  excludeNames?: string[] | null;
  /** Skip jobs carrying the watchdog mark (a worker with other jobs in flight). */
  excludeWatchdogSuspects?: boolean;
  /** A marked job requeued at least this long ago leads the order, or blocks a busy worker's claim. */
  suspectWaitMs?: number;
  /** Handler default timeouts and leases by job name, bound as JSON objects. */
  handlerTimeouts: Record<string, number>;
  handlerLockDurations: Record<string, number>;
  /** The `legacy_default` spend record's fresh group id and default cap. */
  legacySpend: { groupId: string; capUsd: number };
  /** The caller's host fence on a multi-user Rust brain; the SQL engines ignore it. */
  fence?: LeaseToken;
}

function markedFragment(): SqlFragment {
  return sqlFragment`(COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array(${WATCHDOG_SUSPECT_MARK}::text))`;
}

function overdueFragment(waitMs: number): SqlFragment {
  return sqlFragment`(${markedFragment()} AND updated_at <= now() - (${waitMs}::double precision * interval '1 millisecond'))`;
}

/**
 * Claims the next waiting job of `names` in `queue` (priority, then age; `FOR UPDATE SKIP LOCKED`, so two workers
 * never take one row): stamps the lease, the resolved timeout and lease, the attempt and the spend fence. Runs on
 * the direct session pool, which the renewal heartbeat also uses.
 */
export async function claimNextJob(direct: Direct, spec: ClaimJobSpec): Promise<JobRow | null> {
  if (spec.names.length === 0) return null;
  const timeouts = spec.handlerTimeouts, leases = spec.handlerLockDurations;
  const lease = sqlFragment`COALESCE(lock_duration_ms, (${leases}::jsonb ->> name)::int)`;
  const clamped = (l: SqlFragment) => sqlFragment`LEAST(GREATEST(${l}, 5000), 3600000)`;
  const timeout = sqlFragment`COALESCE(timeout_ms, (${timeouts}::jsonb ->> name)::int)`;
  const { groupId, capUsd } = spec.legacySpend;
  const overdue = spec.suspectWaitMs === undefined ? null : overdueFragment(spec.suspectWaitMs);
  const suspects = !spec.excludeWatchdogSuspects ? sqlFragment``
    : overdue ? sqlFragment` AND NOT ${markedFragment()} AND NOT EXISTS (SELECT 1 FROM minion_jobs s WHERE s.queue = ${spec.queue}
           AND s.status = 'waiting' AND s.submission_authority IS NOT NULL AND s.name = ANY(${spec.names}) AND ${overdue})`
      : sqlFragment` AND NOT ${markedFragment()}`;
  const names = spec.excludeNames?.length ? sqlFragment` AND NOT (name = ANY(${spec.excludeNames}))` : sqlFragment``;
  const order = overdue && !spec.excludeWatchdogSuspects ? sqlFragment`${overdue} DESC, ` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`UPDATE minion_jobs SET
        status = 'active',
        claim_generation = claim_generation + 1,
        spend_claim_token = claim_generation + 1,
        spend_authorization = CASE WHEN spend_authorization IS NULL AND (${trustedSql(LEGACY_SPEND_PREDICATE_SQL)}) THEN jsonb_build_object(
          'version', 1, 'kind', 'legacy_default', 'group_id', ${groupId}::text,
          'cap_usd', CASE WHEN name = 'enrich' AND jsonb_typeof(data->'maxCostUsd') = 'number'
                          THEN CASE WHEN (data->>'maxCostUsd')::numeric > 0 THEN data->'maxCostUsd' ELSE to_jsonb(${capUsd}::numeric) END
                          ELSE to_jsonb(${capUsd}::numeric) END,
          'cap_source', 'default', 'command', CASE WHEN name = 'enrich' THEN 'enrich' ELSE 'book-mirror' END,
          'authorized_at', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ELSE spend_authorization END,
        lock_token = ${spec.lockToken},
        lock_until = now() + ((CASE WHEN ${lease} IS NULL THEN ${spec.lockDurationMs}
                                    ELSE ${clamped(lease)} END)::double precision * interval '1 millisecond'),
        lock_duration_ms = CASE WHEN ${lease} IS NULL THEN NULL
                                ELSE ${clamped(lease)} END,
        timeout_ms = ${timeout},
        timeout_at = CASE WHEN ${timeout} IS NOT NULL
                          THEN now() + (${timeout}::double precision * interval '1 millisecond')
                          ELSE NULL END,
        attempts_started = attempts_started + 1,
        started_at = COALESCE(started_at, now()),
        updated_at = now()
       WHERE id = (
         SELECT id FROM minion_jobs
         WHERE queue = ${spec.queue} AND status = 'waiting' AND submission_authority IS NOT NULL AND name = ANY(${spec.names})${suspects}${names}
         ORDER BY ${order}priority ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`);
  const [row] = await direct.executeRawDirect<JobRow>(text, params);
  return row ?? null;
}

/** Extends the lease of an active job this token still holds, on the direct pool; false when the claim moved on. */
export async function renewJobLease(direct: Direct, id: number, lockToken: string, lockDurationMs: number, opts?: { signal?: AbortSignal }): Promise<boolean> {
  const rows = await direct.executeRawDirect(
    `UPDATE minion_jobs SET lock_until = now() + ($1::double precision * interval '1 millisecond'), updated_at = now()
       WHERE id = $2 AND lock_token = $3 AND status = 'active'
       RETURNING id`,
    [lockDurationMs, id, lockToken],
    opts,
  );
  return rows.length > 0;
}

/** Locks the parent of job `id` (if any) before the child changes, the queue-wide parents-before-children order. */
async function lockParentOf(tx: Raw, id: number): Promise<void> {
  const [peek] = await tx.executeRaw<{ parent_job_id: number | null }>(`SELECT parent_job_id FROM minion_jobs WHERE id = $1`, [id]);
  const parentId = peek?.parent_job_id ?? null;
  if (parentId) await tx.executeRaw(`SELECT id FROM minion_jobs WHERE id = $1 FOR UPDATE`, [parentId]);
}

/**
 * Completes an active job this token holds: stores the result, rolls its token counts up to a live parent, posts
 * `child_done` to the parent's inbox, wakes a `waiting-children` parent whose children are all finished, and deletes
 * the row when `remove_on_complete`. Returns the completed row (before any delete), or null when the token is stale.
 */
export async function completeJob(tx: Raw, id: number, lockToken: string, result?: Record<string, unknown>): Promise<JobRow | null> {
  await lockParentOf(tx, id);
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'completed', result = $1::jsonb,
          finished_at = now(), lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id = $2 AND status = 'active' AND lock_token = $3
         RETURNING *`,
    [result ?? null, id, lockToken]);
  if (!row) return null;
  const parentId = row.parent_job_id == null ? null : Number(row.parent_job_id);
  if (parentId) {
    const tokens = [Number(row.tokens_input ?? 0), Number(row.tokens_output ?? 0), Number(row.tokens_cache_read ?? 0)];
    if (tokens.some(t => t > 0)) {
      await tx.executeRaw(
        `UPDATE minion_jobs SET
              tokens_input = tokens_input + $1,
              tokens_output = tokens_output + $2,
              tokens_cache_read = tokens_cache_read + $3,
              updated_at = now()
             WHERE id = $4 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')`,
        [...tokens, parentId]);
    }
    const childDone = { type: 'child_done', child_id: Number(row.id), job_name: String(row.name), result: result ?? null, outcome: 'complete' };
    await tx.executeRaw(CHILD_DONE_SQL, [parentId, childDone]);
    await tx.executeRaw(RESOLVE_PARENT_SQL, [parentId]);
  }
  if (row.remove_on_complete === true) await tx.executeRaw(`DELETE FROM minion_jobs WHERE id = $1`, [row.id]);
  return row;
}

/**
 * Fails an active job this token holds: `delayed` (a retry after `backoffMs`), `failed` or `dead`, appending the error
 * to its stack trace and keeping a handler `result`. A terminal failure posts `child_done` and applies the job's
 * `on_child_fail` to its parent, then deletes the row when `remove_on_fail`. Null when the token is stale.
 */
export async function failJob(
  tx: Raw, id: number, lockToken: string, errorText: string, newStatus: 'delayed' | 'failed' | 'dead', backoffMs?: number, result?: Record<string, unknown>,
): Promise<JobRow | null> {
  await lockParentOf(tx, id);
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET
          status = $1, error_text = $2, attempts_made = attempts_made + 1,
          stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($3::text),
          delay_until = CASE WHEN $1 = 'delayed' THEN now() + ($4::double precision * interval '1 millisecond') ELSE NULL END,
          finished_at = CASE WHEN $1 IN ('failed', 'dead') THEN now() ELSE NULL END,
          started_at = CASE WHEN $1 = 'delayed' THEN NULL ELSE started_at END,
          result = COALESCE($7::jsonb, result),
          lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id = $5 AND status = 'active' AND lock_token = $6
         RETURNING *`,
    [newStatus, errorText, errorText, backoffMs ?? 0, id, lockToken, result ?? null]);
  if (!row) return null;
  const terminal = newStatus === 'failed' || newStatus === 'dead';
  const parentId = row.parent_job_id == null ? null : Number(row.parent_job_id);
  if (terminal && parentId) {
    const childDone = { type: 'child_done', child_id: Number(row.id), job_name: String(row.name), result: null, outcome: newStatus === 'dead' ? 'dead' : 'failed', error: errorText };
    await tx.executeRaw(CHILD_DONE_SQL, [parentId, childDone]);
    if (row.on_child_fail === 'fail_parent') {
      await tx.executeRaw(
        `UPDATE minion_jobs SET status = 'failed', lock_token = NULL, lock_until = NULL,
              error_text = $1, finished_at = now(), updated_at = now()
             WHERE id = $2 AND status = 'waiting-children'`,
        [`child job ${String(row.id)} failed: ${errorText}`, parentId]);
    } else {
      if (row.on_child_fail === 'remove_dep') await tx.executeRaw(`UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`, [row.id]);
      await tx.executeRaw(RESOLVE_PARENT_SQL, [parentId]);
    }
  }
  if (terminal && row.remove_on_fail === true) await tx.executeRaw(`DELETE FROM minion_jobs WHERE id = $1`, [row.id]);
  return row;
}

/** Takes the parents' row locks in ascending id order before any child changes (the queue-wide lock order). */
export async function lockParentsOrdered(tx: Raw, candidates: Array<{ parent_job_id: number | null }>): Promise<void> {
  const parentIds = [...new Set(candidates.map(c => c.parent_job_id).filter((p): p is number => p != null))].sort((a, b) => a - b);
  if (parentIds.length === 0) return;
  await tx.executeRaw(`SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [parentIds]);
}

/**
 * The shared tail of every reaper, after the children changed and their parents were locked: `child_done(outcome)` to
 * each live parent, then a `waiting-children` parent whose last open child this was goes back to `waiting`.
 */
export async function killJobs(tx: Raw, rows: JobRow[], outcome: string, errorText: string): Promise<void> {
  const parentIds = new Set<number>();
  for (const r of rows) {
    if (r.parent_job_id == null) continue;
    const parentId = Number(r.parent_job_id);
    parentIds.add(parentId);
    await tx.executeRaw(CHILD_DONE_SQL, [parentId, { type: 'child_done', child_id: Number(r.id), job_name: String(r.name), result: null, outcome, error: errorText }]);
  }
  for (const parentId of [...parentIds].sort((a, b) => a - b)) await tx.executeRaw(RESOLVE_PARENT_SQL, [parentId]);
}

const CO_RUNNER_STALL = 'worker_stalled_with_co_runners: ';
const workerOf = (token: string | null): string | null => token && token.includes(':') ? token.slice(0, token.indexOf(':')) : null;

/**
 * The stalled candidates whose worker held other expired claims (a live worker keeps renewing the claims it still
 * runs), requeued with the watchdog mark and no stall counted. Returns those rows and the candidates left to count.
 */
async function requeueCoRunnerStalls<C extends { id: number }>(tx: Raw, candidates: C[], graceMs: number): Promise<{ requeued: JobRow[]; rest: C[] }> {
  const rows = await tx.executeRaw<{ id: number; lock_token: string | null; marked: boolean }>(
    `SELECT id, lock_token, (COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array($2::text)) AS marked FROM minion_jobs WHERE status = 'active' AND (lock_until < now() OR id = ANY($1::bigint[]))`,
    [candidates.map(c => c.id), WATCHDOG_SUSPECT_MARK]);
  const evidence = new Set((await tx.executeRaw<{ error_text: string }>(
    `SELECT DISTINCT error_text FROM minion_jobs WHERE status IN ('waiting', 'active', 'delayed') AND starts_with(error_text, $1)`, [CO_RUNNER_STALL])).map(r => r.error_text));
  const perWorker = new Map<string, number>();
  for (const row of rows) { const worker = workerOf(row.lock_token); if (worker) perWorker.set(worker, (perWorker.get(worker) ?? 0) + 1); }
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  const shared = new Set(candidates.filter(c => {
    const row = byId.get(Number(c.id));
    const worker = workerOf(row?.lock_token ?? null);
    return row && !row.marked && worker !== null && ((perWorker.get(worker) ?? 0) > 1 || evidence.has(CO_RUNNER_STALL + worker));
  }).map(c => Number(c.id)));
  if (shared.size === 0) return { requeued: [], rest: candidates };
  const requeued = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'waiting', error_text = $3 || split_part(lock_token, ':', 1), stacktrace = CASE WHEN COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array($4::text) THEN stacktrace
    ELSE COALESCE(stacktrace, '[]'::jsonb) || jsonb_build_array($4::text) END,
       started_at = NULL, lock_token = NULL, lock_until = NULL, updated_at = now()
     WHERE id IN (SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) AND status = 'active'
                    AND lock_until < now() - ($2::double precision * interval '1 millisecond') FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [[...shared], graceMs, CO_RUNNER_STALL, WATCHDOG_SUSPECT_MARK]);
  return { requeued, rest: candidates.filter(c => !shared.has(Number(c.id))) };
}

/**
 * The stall sweep: removes drain-lease holder records whose lease is gone, then takes every active job whose lease
 * expired more than `graceMs` ago. A co-runner of a dead multi-claim worker requeues marked with no stall counted;
 * the rest requeue with one stall counted, or go `dead` at `max_stalled` (notifying and waking their parents).
 */
export async function reclaimStalledJobs(tx: Raw, graceMs: number): Promise<{ requeued: JobRow[]; dead: JobRow[] }> {
  await tx.executeRaw(`DELETE FROM minion_jobs b WHERE b.queue = 'gbrain-drain-lease' AND b.status = 'active' AND b.lock_until < now()
        AND NOT EXISTS (SELECT 1 FROM gbrain_cycle_locks l WHERE l.acquisition_token::text = b.lock_token AND l.ttl_expires_at > now())`);
  const candidates = await tx.executeRaw<{ id: number; parent_job_id: number | null; stalled_counter: number; max_stalled: number }>(
    `SELECT id, parent_job_id, stalled_counter, max_stalled
           FROM minion_jobs
          WHERE status = 'active' AND queue <> 'gbrain-drain-lease'
            AND lock_until < now() - ($1::double precision * interval '1 millisecond')`,
    [graceMs]);
  if (candidates.length === 0) return { requeued: [], dead: [] };
  const coRunners = await requeueCoRunnerStalls(tx, candidates, graceMs);
  const ids = coRunners.rest.map(c => c.id);
  await lockParentsOrdered(tx, coRunners.rest.filter(c => Number(c.stalled_counter) + 1 >= Number(c.max_stalled)));
  const requeued = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET
          status = 'waiting', stalled_counter = stalled_counter + 1,
          started_at = NULL,
          lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
              AND lock_until < now() - ($2::double precision * interval '1 millisecond')
              AND stalled_counter + 1 < max_stalled
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
    [ids, graceMs]);
  const dead = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET
          status = 'dead', stalled_counter = stalled_counter + 1,
          attempts_made = attempts_made + 1,
          error_text = 'max stalled count exceeded',
          lock_token = NULL, lock_until = NULL, finished_at = now(), updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
              AND lock_until < now() - ($2::double precision * interval '1 millisecond')
              AND stalled_counter + 1 >= max_stalled
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
    [ids, graceMs]);
  await killJobs(tx, dead, 'dead', 'max stalled count exceeded');
  return { requeued: [...coRunners.requeued, ...requeued], dead };
}
