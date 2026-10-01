/**
 * S9 storage through `engine.executeRaw` (the store.ts pattern; no engine
 * method): the per-source sweep watermark (an internal decide_state key),
 * sweep fact selection and neighbour lookup, the deferred-retry table,
 * cross-sweep pair dedup, and decide_proposals reads and writes.
 * Proposals are never pruned by receipt retention.
 */
import type { BrainEngine } from '../../engine.ts';
import { AUDIT_ROW_SOURCES } from '../../facts/audit-sources.ts';
import { CONFLICT_NEIGHBOURS } from './conflict.ts';
import { getDecideState, setDecideState } from './store.ts';

export const DEFERRED_MAX_ATTEMPTS = 5;
const DEFERRED_BACKOFF_MINUTES = 30;

const watermarkKey = (sourceId: string) => `conflict_watermark:${sourceId}`;

export async function getSweepWatermark(engine: BrainEngine, sourceId: string): Promise<number | null> {
  const raw = await getDecideState(engine, watermarkKey(sourceId));
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

export async function setSweepWatermark(engine: BrainEngine, sourceId: string, factId: number): Promise<void> {
  await setDecideState(engine, watermarkKey(sourceId), String(factId));
}

export async function maxFactId(engine: BrainEngine, sourceId: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string | null }>('SELECT MAX(id) AS n FROM facts WHERE source_id = $1', [sourceId]);
  return Number(row?.n ?? 0);
}

export interface SweepFact {
  id: number;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  visibility: 'private' | 'world';
  created_at: Date | string;
  has_embedding: boolean;
}

const SWEEP_FACT_COLUMNS = `id, source_id, entity_slug, fact, visibility, created_at,
  (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedded_text_hash = md5(fact)) AS has_embedding`;
const ACTIVE = `expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND source <> ALL($2::text[])`;

function normalizeFact(r: SweepFact): SweepFact {
  return { ...r, id: Number(r.id), has_embedding: r.has_embedding === true || (r.has_embedding as unknown) === 't' };
}

/** Active, non-audit facts above the watermark, ascending id. */
export async function factsAfter(engine: BrainEngine, sourceId: string, afterId: number, limit: number): Promise<SweepFact[]> {
  const rows = await engine.executeRaw<SweepFact>(
    `SELECT ${SWEEP_FACT_COLUMNS} FROM facts WHERE source_id = $1 AND id > $3 AND ${ACTIVE} ORDER BY id LIMIT $4`,
    [sourceId, [...AUDIT_ROW_SOURCES], afterId, limit],
  );
  return rows.map(normalizeFact);
}

export async function factsByIds(engine: BrainEngine, sourceId: string, ids: readonly number[]): Promise<SweepFact[]> {
  if (ids.length === 0) return [];
  const rows = await engine.executeRaw<SweepFact>(
    `SELECT ${SWEEP_FACT_COLUMNS} FROM facts WHERE source_id = $1 AND id = ANY($3::text[]::bigint[]) AND ${ACTIVE} ORDER BY id`,
    [sourceId, [...AUDIT_ROW_SOURCES], ids.map(String)],
  );
  return rows.map(normalizeFact);
}

export interface ConflictCandidateRow {
  id: number;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  visibility: 'private' | 'world';
  expired_at: Date | string | null;
  valid_until: Date | string | null;
  source_markdown_slug: string | null;
  similarity: number;
}

/**
 * The swept fact's nearest neighbours with every eligibility filter applied
 * BEFORE the limit (so the fact itself and ineligible rows never take a slot):
 * the decideSingleFact guards (same source, entity and visibility, active and
 * not expired, candidate source_markdown_slug unset or equal to the fact's
 * entity), a matching embedding, and no audit rows.
 */
export async function conflictNeighbours(engine: BrainEngine, factId: number, sourceId: string): Promise<ConflictCandidateRow[]> {
  const rows = await engine.executeRaw<ConflictCandidateRow>(
    `SELECT c.id, c.source_id, c.entity_slug, c.fact, c.visibility, c.expired_at, c.valid_until, c.source_markdown_slug,
            (1 - (c.embedding <=> n.embedding))::float8 AS similarity
       FROM facts n JOIN facts c
         ON c.source_id = n.source_id AND c.entity_slug = n.entity_slug AND c.visibility = n.visibility AND c.id <> n.id
      WHERE n.id = $1 AND n.source_id = $3
        AND c.expired_at IS NULL AND (c.valid_until IS NULL OR c.valid_until > now())
        AND c.embedding IS NOT NULL AND c.embedding_model = n.embedding_model AND c.embedded_text_hash = md5(c.fact)
        AND (c.source_markdown_slug IS NULL OR c.source_markdown_slug = n.entity_slug)
        AND c.source <> ALL($2::text[])
      ORDER BY c.embedding <=> n.embedding, c.id
      LIMIT $4`,
    [factId, [...AUDIT_ROW_SOURCES], sourceId, CONFLICT_NEIGHBOURS],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), similarity: Number(r.similarity) }));
}

// ---------------------------------------------------------------------------
// Deferred retries (transient skips: no_embedding, provider failure)
// ---------------------------------------------------------------------------

export async function dueDeferred(engine: BrainEngine, sourceId: string, limit: number): Promise<Array<{ fact_id: number; attempts: number }>> {
  const rows = await engine.executeRaw<{ fact_id: number | string; attempts: number | string }>(
    `SELECT fact_id, attempts FROM decide_sweep_deferred
      WHERE slot = 'conflict' AND source_id = $1 AND attempts < $2 AND next_attempt_at <= now()
      ORDER BY fact_id LIMIT $3`,
    [sourceId, DEFERRED_MAX_ATTEMPTS, limit],
  );
  return rows.map((r) => ({ fact_id: Number(r.fact_id), attempts: Number(r.attempts) }));
}

export async function deferFact(engine: BrainEngine, sourceId: string, factId: number, reason: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts, next_attempt_at)
     VALUES ($1, $2, 'conflict', $3, 1, now() + ($4::int * interval '1 minute'))
     ON CONFLICT (slot, source_id, fact_id) DO UPDATE SET reason = EXCLUDED.reason,
       attempts = decide_sweep_deferred.attempts + 1,
       next_attempt_at = now() + ($4::int * (decide_sweep_deferred.attempts + 1) * interval '1 minute')`,
    [sourceId, factId, reason, DEFERRED_BACKOFF_MINUTES],
  );
}

export async function clearDeferred(engine: BrainEngine, sourceId: string, factId: number): Promise<void> {
  await engine.executeRaw(`DELETE FROM decide_sweep_deferred WHERE slot = 'conflict' AND source_id = $1 AND fact_id = $2`, [sourceId, factId]);
}

// ---------------------------------------------------------------------------
// Pair dedup across sweeps: answered receipts (hashed pair subject) and proposals
// ---------------------------------------------------------------------------

export async function answeredPairRefs(engine: BrainEngine, refs: readonly string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = await engine.executeRaw<{ subject_ref: string }>(
    `SELECT DISTINCT subject_ref FROM decision_receipts
      WHERE slot = 'conflict' AND subject_ref = ANY($1::text[]) AND outcome IN ('duplicate', 'proposal', 'independent')`,
    [refs],
  );
  return new Set(rows.map((r) => r.subject_ref));
}

/** Unordered pairs (lo:hi) that already carry a proposal, any status. */
export async function proposedPairs(engine: BrainEngine, sourceId: string, factId: number): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ a: number | string; b: number | string }>(
    `SELECT LEAST(new_fact_id, old_fact_id) AS a, GREATEST(new_fact_id, old_fact_id) AS b FROM decide_proposals
      WHERE source_id = $1 AND (new_fact_id = $2 OR old_fact_id = $2)`,
    [sourceId, factId],
  );
  return new Set(rows.map((r) => `${Number(r.a)}:${Number(r.b)}`));
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

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

export async function insertProposal(engine: BrainEngine, p: NewProposal): Promise<number | null> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, direction, p_supersede, threshold, proposal_floor, model_resolved)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (sweep_id, pair_index) DO NOTHING RETURNING id`,
    [p.source_id, p.sweep_id, p.pair_index, p.new_fact_id, p.old_fact_id, p.direction, p.p_supersede, p.threshold, p.proposal_floor, p.model_resolved],
  );
  return rows[0] ? Number(rows[0].id) : null;
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

export async function getProposal(engine: BrainEngine, id: number, lock = false): Promise<ProposalRow | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT * FROM decide_proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? normalizeProposal(rows[0]) : null;
}

export async function proposalIdsFromSweep(engine: BrainEngine, sweepId: string, status: ProposalStatus): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number | string }>('SELECT id FROM decide_proposals WHERE sweep_id = $1 AND status = $2 ORDER BY pair_index', [sweepId, status]);
  return rows.map((r) => Number(r.id));
}

export interface ProposalListing extends ProposalRow {
  new_fact: string | null;
  old_fact: string | null;
  entity_slug: string | null;
}

/** Proposals with both facts' text (local CLI only; never written to receipts). */
export async function listProposals(engine: BrainEngine, opts: { status?: ProposalStatus | 'all'; limit?: number } = {}): Promise<ProposalListing[]> {
  const status = opts.status ?? 'pending';
  const rows = await engine.executeRaw<Record<string, unknown>>(
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

/** Compare-and-set a proposal's status; returns false when it is no longer `from`. */
export async function transitionProposal(engine: BrainEngine, id: number, from: ProposalStatus, to: ProposalStatus,
  state: { before?: string | null; after?: string | null } = {}): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `UPDATE decide_proposals SET status = $3, decided_at = now(),
       before_state = COALESCE($4, before_state), after_state = COALESCE($5, after_state)
     WHERE id = $1 AND status = $2 RETURNING id`,
    [id, from, to, state.before ?? null, state.after ?? null],
  );
  return rows.length === 1;
}

/** Active facts and how many are private (the S9 egress share `decide enable conflict` prints). */
export async function privateFactShare(engine: BrainEngine): Promise<{ total: number; private: number }> {
  const [row] = await engine.executeRaw<{ total: number | string; private: number | string }>(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE visibility <> 'world')::int AS private FROM facts
      WHERE expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())`);
  return { total: Number(row?.total ?? 0), private: Number(row?.private ?? 0) };
}
