/**
 * The decide proposal tables: `decide_proposals` (supersede proposals the conflict sweep leaves for the owner),
 * `decide_review_proposals` (the review lane's), the review lane's work queue `decide_review_queue` and the conflict
 * sweep's retry table `decide_sweep_deferred`. SQL once for both engines, so a store that is not SQL serves the same
 * members (rust/docs/store/decide-proposals.md).
 *
 * What is here: the proposal inserts, reads, listings and compare-and-set transitions, the doctor's review-rate
 * counts, the queue's enqueue, due read, clear and defer, and the sweep-deferred table's due read, defer, relink
 * handoff and clear. What is not: reads of `facts`, `pages`, `fact_withdrawals` and `decision_receipts` (the sweep's
 * fact selection, neighbour search and answered-pair filters), which stay in proposals-store.ts and review-lane.ts.
 *
 * Every function takes the transaction (or the engine, for a single statement) it runs on. Rows come back typed:
 * ids and counts as numbers, timestamps as ISO strings (supersede proposals) or Postgres text (review proposals).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

// ---------------------------------------------------------------- supersede proposals

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'stale', 'undone'] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

export interface NewProposal {
  source_id: string;
  sweep_id: string;
  pair_index: number;
  new_fact_id: number;
  old_fact_id: number;
  direction: string;
  p_supersede: number;
  threshold: number | null;
  proposal_floor: number;
  model_resolved: string | null;
}

export interface ProposalRow extends NewProposal {
  id: number;
  created_at: string;
  status: ProposalStatus;
  decided_at: string | null;
  before_state: string | null;
  after_state: string | null;
}

export interface ProposalListing extends ProposalRow {
  new_fact: string | null;
  old_fact: string | null;
  entity_slug: string | null;
}

const toTime = (v: unknown): string | null => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function normalizeProposal(r: Record<string, unknown>): ProposalRow {
  return {
    ...(r as unknown as ProposalRow),
    id: Number(r.id), pair_index: Number(r.pair_index), new_fact_id: Number(r.new_fact_id), old_fact_id: Number(r.old_fact_id),
    p_supersede: Number(r.p_supersede), threshold: r.threshold === null ? null : Number(r.threshold), proposal_floor: Number(r.proposal_floor),
    created_at: toTime(r.created_at)!, decided_at: toTime(r.decided_at),
  };
}

/** The new proposal's id, or null when its sweep slot or (for claim sweeps) its fact pair already carries one. */
export async function insertDecideProposal(tx: Raw, p: NewProposal): Promise<number | null> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    `INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, direction, p_supersede, threshold, proposal_floor, model_resolved)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [p.source_id, p.sweep_id, p.pair_index, p.new_fact_id, p.old_fact_id, p.direction, p.p_supersede, p.threshold, p.proposal_floor, p.model_resolved],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** One proposal, or null. `lock` takes the row lock a caller inside a transaction wants (a store with no row locks reads it plain). */
export async function getDecideProposal(tx: Raw, id: number, lock = false): Promise<ProposalRow | null> {
  const rows = await tx.executeRaw<Record<string, unknown>>(lock ? 'SELECT * FROM decide_proposals WHERE id = $1 FOR UPDATE' : 'SELECT * FROM decide_proposals WHERE id = $1', [id]);
  return rows[0] ? normalizeProposal(rows[0]) : null;
}

/** The ids of one sweep's proposals in a status, by pair index. */
export async function listDecideProposalIds(tx: Raw, sweepId: string, status: ProposalStatus): Promise<number[]> {
  const rows = await tx.executeRaw<{ id: number | string }>('SELECT id FROM decide_proposals WHERE sweep_id = $1 AND status = $2 ORDER BY pair_index', [sweepId, status]);
  return rows.map((r) => Number(r.id));
}

/** Proposals with both facts' text, oldest first; `status` `all` lists every status. */
export async function listDecideProposals(tx: Raw, opts: { status?: ProposalStatus | 'all'; limit?: number } = {}): Promise<ProposalListing[]> {
  const status = opts.status ?? 'pending';
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT p.*, n.fact AS new_fact, o.fact AS old_fact, COALESCE(n.entity_slug, o.entity_slug) AS entity_slug
       FROM decide_proposals p
       LEFT JOIN facts n ON n.id = p.new_fact_id
       LEFT JOIN facts o ON o.id = p.old_fact_id
      WHERE ($1::text = 'all' OR p.status = $1)
      ORDER BY p.created_at, p.id LIMIT $2`,
    [status, opts.limit ?? 200],
  );
  return rows.map((r) => ({ ...normalizeProposal(r), new_fact: (r.new_fact as string | null) ?? null, old_fact: (r.old_fact as string | null) ?? null, entity_slug: (r.entity_slug as string | null) ?? null }));
}

/** Compare-and-set a proposal's status; false when it is no longer `from`. A null state keeps the stored one. */
export async function transitionDecideProposal(tx: Raw, id: number, from: ProposalStatus, to: ProposalStatus,
  state: { before?: string | null; after?: string | null } = {}): Promise<boolean> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    `UPDATE decide_proposals SET status = $3, decided_at = now(),
       before_state = COALESCE($4, before_state), after_state = COALESCE($5, after_state)
     WHERE id = $1 AND status = $2 RETURNING id`,
    [id, from, to, state.before ?? null, state.after ?? null],
  );
  return rows.length === 1;
}

/** The ordered fact pairs (`a` <= `b`) that already carry a proposal, in any status, and name `factId`. */
export async function listDecideProposedPairs(tx: Raw, sourceId: string, factId: number): Promise<Array<{ a: number; b: number }>> {
  const rows = await tx.executeRaw<{ a: number | string; b: number | string }>(
    `SELECT LEAST(new_fact_id, old_fact_id) AS a, GREATEST(new_fact_id, old_fact_id) AS b FROM decide_proposals
      WHERE source_id = $1 AND (new_fact_id = $2 OR old_fact_id = $2)`,
    [sourceId, factId],
  );
  return rows.map((r) => ({ a: Number(r.a), b: Number(r.b) }));
}

// ---------------------------------------------------------------- review proposals

export interface NewReviewProposal {
  kind: string;
  source_id: string;
  sweep_id: string;
  a_ref: string;
  b_ref: string;
  subject: string;
  visibility: string | null;
  p_action: number;
  threshold: number | null;
  model_resolved: string | null;
  question_version: string | null;
  receipt: string | null;
}

export interface ReviewProposalRecord {
  id: number;
  kind: string;
  source_id: string;
  sweep_id: string;
  a_ref: string;
  b_ref: string;
  subject: string;
  visibility: string | null;
  p_action: number;
  threshold: number | null;
  model_resolved: string | null;
  status: string;
  /** Postgres `timestamptz::text` in UTC (`2026-06-18 09:00:00.5+00`). */
  created_at: string;
  decided_at: string | null;
  receipt: string | null;
}

const REVIEW_SELECT = `SELECT id, kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, status,
            created_at::text, decided_at::text, receipt
  FROM decide_review_proposals`;

const reviewRow = (r: ReviewProposalRecord): ReviewProposalRecord =>
  ({ ...r, id: Number(r.id), p_action: Number(r.p_action), threshold: r.threshold === null ? null : Number(r.threshold) });

/** The new proposal's id, or null when the (kind, source, a, b, subject) proposal already exists. */
export async function insertDecideReviewProposal(tx: Raw, p: NewReviewProposal): Promise<number | null> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    `INSERT INTO decide_review_proposals (kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, question_version, receipt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
    [p.kind, p.source_id, p.sweep_id, p.a_ref, p.b_ref, p.subject, p.visibility, p.p_action, p.threshold, p.model_resolved, p.question_version, p.receipt],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Review proposals in a status (`all` for every one), by id. */
export async function listDecideReviewProposals(tx: Raw, status: string): Promise<ReviewProposalRecord[]> {
  const rows = await tx.executeRaw<ReviewProposalRecord>(
    REVIEW_SELECT + (status === 'all' ? ' ORDER BY id' : ' WHERE status = $1 ORDER BY id'), status === 'all' ? [] : [status]);
  return rows.map(reviewRow);
}

/** One review proposal, or null. `lock` takes the row lock a caller inside a transaction wants (a store with no row locks reads it plain). */
export async function getDecideReviewProposal(tx: Raw, id: number, lock = false): Promise<ReviewProposalRecord | null> {
  const rows = await tx.executeRaw<ReviewProposalRecord>(
    REVIEW_SELECT + (lock ? ' WHERE id = $1 FOR UPDATE' : ' WHERE id = $1'), [id]);
  return rows[0] ? reviewRow(rows[0]) : null;
}

/** Compare-and-set a review proposal's status; false when it is no longer `from`. */
export async function transitionDecideReviewProposal(tx: Raw, id: number, from: string, to: string): Promise<boolean> {
  const rows = await tx.executeRaw(`UPDATE decide_review_proposals SET status = $3, decided_at = now() WHERE id = $1 AND status = $2 RETURNING id`, [id, from, to]);
  return rows.length > 0;
}

/** The pending review proposals of one sweep, by id; withdrawals only when asked. */
export async function listDecideReviewProposalIds(tx: Raw, sweepId: string, includeWithdrawals: boolean): Promise<number[]> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    `SELECT id FROM decide_review_proposals WHERE sweep_id = $1 AND status = 'pending' AND ($2::boolean OR kind <> 'withdraw') ORDER BY id`,
    [sweepId, includeWithdrawals]);
  return rows.map((r) => Number(r.id));
}

// ---------------------------------------------------------------- review rates

/** One kind's backlog and decisions: `supersede` for decide_proposals, the review kind for decide_review_proposals. */
export interface ProposalReviewCounts {
  kind: string;
  pending: number;
  /** Age in days of the oldest pending proposal, unrounded; null when none is pending. */
  oldest: number | null;
  /** Accepted (or accepted with no action) in the last 30 days. */
  accepted: number;
  rejected: number;
}

const rateSql = (table: 'decide_proposals' | 'decide_review_proposals') => table === 'decide_proposals'
  ? `SELECT 'supersede' AS kind,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))) / 86400.0 AS oldest,
      count(*) FILTER (WHERE status IN ('accepted', 'accepted_no_action') AND decided_at > now() - interval '30 days')::int AS accepted,
      count(*) FILTER (WHERE status = 'rejected' AND decided_at > now() - interval '30 days')::int AS rejected
    FROM decide_proposals GROUP BY 1`
  : `SELECT kind AS kind,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))) / 86400.0 AS oldest,
      count(*) FILTER (WHERE status IN ('accepted', 'accepted_no_action') AND decided_at > now() - interval '30 days')::int AS accepted,
      count(*) FILTER (WHERE status = 'rejected' AND decided_at > now() - interval '30 days')::int AS rejected
    FROM decide_review_proposals GROUP BY 1`;

/**
 * The doctor's proposal review rates: per kind, the pending count, the age of the oldest pending proposal and the
 * accepted and rejected counts of the last 30 days, over both proposal tables. A kind with no proposal has no row.
 * Supersede first, then the review kinds by name.
 */
export async function readProposalReviewRates(tx: Raw): Promise<ProposalReviewCounts[]> {
  type Row = { kind: string; pending: number | string; oldest: number | string | null; accepted: number | string; rejected: number | string };
  const supersede = await tx.executeRaw<Row>(rateSql('decide_proposals'));
  const review = await tx.executeRaw<Row>(rateSql('decide_review_proposals'));
  const shape = (r: Row): ProposalReviewCounts => ({
    kind: r.kind, pending: Number(r.pending), oldest: r.oldest == null ? null : Number(r.oldest),
    accepted: Number(r.accepted), rejected: Number(r.rejected),
  });
  return [...supersede.map(shape), ...review.map(shape).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))];
}

// ---------------------------------------------------------------- review queue

export const REVIEW_MAX_ATTEMPTS = 5;

export interface ReviewQueueKey {
  kind: string;
  source_id: string;
  a_ref: string;
  b_ref: string;
}

export interface ReviewQueueRow extends ReviewQueueKey {
  attempts: number;
}

/** The queue statements a caller runs: queue a pair (idempotent), drop a row, or push a row back with a reason. */
export type ReviewQueueOp =
  | ({ op: 'enqueue'; evidence?: string | null } & ReviewQueueKey)
  | ({ op: 'clear' } & ReviewQueueKey)
  | ({ op: 'defer'; reason: string } & ReviewQueueKey);

/** Rows of one kind and source that are due and not exhausted, oldest due first. */
export async function listDueDecideReviewQueue(tx: Raw, kind: string, sourceId: string, limit: number): Promise<ReviewQueueRow[]> {
  const rows = await tx.executeRaw<ReviewQueueRow>(
    `SELECT kind, source_id, a_ref, b_ref, attempts FROM decide_review_queue
      WHERE kind = $1 AND source_id = $2 AND attempts < $3 AND next_attempt_at <= now()
      ORDER BY next_attempt_at, created_at, a_ref, b_ref LIMIT $4`, [kind, sourceId, REVIEW_MAX_ATTEMPTS, limit]);
  return rows.map(r => ({ ...r, attempts: Number(r.attempts) }));
}

/** Runs one queue statement; the number of rows it queued, deleted or deferred (0 or 1). */
export async function applyDecideReviewQueue(tx: Raw, op: ReviewQueueOp): Promise<number> {
  if (op.op === 'enqueue') {
    const rows = await tx.executeRaw(`INSERT INTO decide_review_queue(kind,source_id,a_ref,b_ref,evidence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING a_ref`,
      [op.kind, op.source_id, op.a_ref, op.b_ref, op.evidence ?? null]);
    return rows.length;
  }
  if (op.op === 'clear') {
    const rows = await tx.executeRaw('DELETE FROM decide_review_queue WHERE kind=$1 AND source_id=$2 AND a_ref=$3 AND b_ref=$4 RETURNING a_ref', [op.kind, op.source_id, op.a_ref, op.b_ref]);
    return rows.length;
  }
  const rows = await tx.executeRaw(`UPDATE decide_review_queue SET attempts = attempts + 1, reason = $5,
      next_attempt_at = now() + ((attempts + 1) * interval '10 minutes')
    WHERE kind=$1 AND source_id=$2 AND a_ref=$3 AND b_ref=$4 RETURNING a_ref`, [op.kind, op.source_id, op.a_ref, op.b_ref, op.reason]);
  return rows.length;
}

// ---------------------------------------------------------------- sweep deferred

export const DEFERRED_MAX_ATTEMPTS = 5;
const DEFERRED_BACKOFF_MINUTES = 30;

/** The retry statements the conflict sweep runs: back a fact off, hand over relinked facts, or drop a fact's row. */
export type SweepDeferredOp =
  | { op: 'defer'; fact_id: number; reason: string }
  | { op: 'relinked'; fact_ids: readonly number[] }
  | { op: 'clear'; fact_id: number };

/** Due conflict retries of a source, oldest due first (fact id breaks ties). */
export async function listDueDecideSweepDeferred(tx: Raw, sourceId: string, limit: number): Promise<Array<{ fact_id: number; attempts: number }>> {
  const rows = await tx.executeRaw<{ fact_id: number | string; attempts: number | string }>(
    `SELECT fact_id, attempts FROM decide_sweep_deferred
      WHERE slot = 'conflict' AND source_id = $1 AND attempts < $2 AND next_attempt_at <= now()
      ORDER BY next_attempt_at, fact_id LIMIT $3`,
    [sourceId, DEFERRED_MAX_ATTEMPTS, limit],
  );
  return rows.map((r) => ({ fact_id: Number(r.fact_id), attempts: Number(r.attempts) }));
}

/**
 * Runs one retry statement; the number of rows it wrote or deleted. `defer` backs the fact off 30 minutes times its
 * attempts so far (a new row: 30); `relinked` queues facts that just gained an entity (attempts 0, due now) and leaves
 * a row that exists untouched; `clear` drops the row.
 */
export async function applyDecideSweepDeferred(tx: Raw, sourceId: string, op: SweepDeferredOp): Promise<number> {
  if (op.op === 'defer') {
    const rows = await tx.executeRaw(
      `INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts, next_attempt_at)
       VALUES ($1, $2, 'conflict', $3, 1, now() + ($4::int * interval '1 minute'))
       ON CONFLICT (slot, source_id, fact_id) DO UPDATE SET reason = EXCLUDED.reason,
         attempts = decide_sweep_deferred.attempts + 1,
         next_attempt_at = now() + ($4::int * (decide_sweep_deferred.attempts + 1) * interval '1 minute') RETURNING fact_id`,
      [sourceId, op.fact_id, op.reason, DEFERRED_BACKOFF_MINUTES],
    );
    return rows.length;
  }
  if (op.op === 'relinked') {
    if (op.fact_ids.length === 0) return 0;
    const rows = await tx.executeRaw(
      `INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts, next_attempt_at)
       SELECT $1, ids.id::bigint, 'conflict', 'relinked', 0, now() FROM unnest($2::text[]) AS ids(id)
       ON CONFLICT (slot, source_id, fact_id) DO NOTHING RETURNING fact_id`,
      [sourceId, op.fact_ids.map(String)],
    );
    return rows.length;
  }
  const rows = await tx.executeRaw(`DELETE FROM decide_sweep_deferred WHERE slot = 'conflict' AND source_id = $1 AND fact_id = $2 RETURNING fact_id`, [sourceId, op.fact_id]);
  return rows.length;
}
