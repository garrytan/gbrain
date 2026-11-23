/**
 * S9 storage. The deferred-retry table and the decide_proposals reads and writes go through engine members
 * (engine-sql/decide-proposals.ts), and so does the per-source sweep watermark (an internal decide_state key,
 * through the typed getDecideState/setDecideState members). Sweep fact selection, neighbour lookup and the
 * answered-pair read stay on `engine.executeRaw`.
 * Proposals are never pruned by receipt retention.
 */
import type { BrainEngine } from '../../engine.ts';
import { AUDIT_ROW_SOURCES } from '../../facts/audit-sources.ts';
import { CONFLICT_NEIGHBOURS } from './conflict.ts';
import { PROPOSAL_STATUSES } from '../../engine-sql/decide-proposals.ts';
import type { NewProposal, ProposalListing, ProposalRow, ProposalStatus } from '../../engine-sql/decide-proposals.ts';
import { getDecideState, setDecideState } from './store.ts';

export { PROPOSAL_STATUSES };
export type { NewProposal, ProposalListing, ProposalRow, ProposalStatus };

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
  valid_from: Date | string;
  created_at: Date | string;
  has_embedding: boolean;
}

const SWEEP_FACT_COLUMNS = `id, source_id, entity_slug, fact, visibility, valid_from, created_at,
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
  valid_from: Date | string;
  created_at: Date | string;
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
            c.valid_from, c.created_at, (1 - (c.embedding <=> n.embedding))::float8 AS similarity
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
// Deferred retries (transient skips: no_embedding, provider failure) and
// relinked facts handed over by `gbrain facts relink`
// ---------------------------------------------------------------------------

/** Due retries, oldest due first (fact id breaks ties), so a large relinked backlog never starves a transient retry. */
export async function dueDeferred(engine: BrainEngine, sourceId: string, limit: number): Promise<Array<{ fact_id: number; attempts: number }>> {
  return engine.listDueDecideSweepDeferred(sourceId, limit);
}

export async function deferFact(engine: BrainEngine, sourceId: string, factId: number, reason: string): Promise<void> {
  await engine.applyDecideSweepDeferred(sourceId, { op: 'defer', fact_id: factId, reason });
}

/**
 * Queue facts that just gained an entity for the next conflict sweep: attempts 0, due now, reason `relinked`.
 * An existing row (a pending transient retry) is left untouched. Pass the caller's transaction engine so the
 * handoff commits with the relink write. Returns the number of rows queued.
 */
export async function enqueueRelinked(engine: BrainEngine, sourceId: string, factIds: readonly number[]): Promise<number> {
  if (factIds.length === 0) return 0;
  return engine.applyDecideSweepDeferred(sourceId, { op: 'relinked', fact_ids: factIds });
}

export async function clearDeferred(engine: BrainEngine, sourceId: string, factId: number): Promise<void> {
  await engine.applyDecideSweepDeferred(sourceId, { op: 'clear', fact_id: factId });
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
  return new Set((await engine.listDecideProposedPairs(sourceId, factId)).map((r) => `${r.a}:${r.b}`));
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const insertProposal = (engine: BrainEngine, p: NewProposal): Promise<number | null> => engine.insertDecideProposal(p);

export const getProposal = (engine: BrainEngine, id: number, lock = false): Promise<ProposalRow | null> => engine.getDecideProposal(id, lock);

export const proposalIdsFromSweep = (engine: BrainEngine, sweepId: string, status: ProposalStatus): Promise<number[]> =>
  engine.listDecideProposalIds(sweepId, status);

/** Proposals with both facts' text (local CLI only; never written to receipts). */
export const listProposals = (engine: BrainEngine, opts: { status?: ProposalStatus | 'all'; limit?: number } = {}): Promise<ProposalListing[]> =>
  engine.listDecideProposals(opts);

/** Compare-and-set a proposal's status; returns false when it is no longer `from`. */
export const transitionProposal = (engine: BrainEngine, id: number, from: ProposalStatus, to: ProposalStatus,
  state: { before?: string | null; after?: string | null } = {}): Promise<boolean> => engine.transitionDecideProposal(id, from, to, state);

/** Active facts and how many are private (the S9 egress share `decide enable conflict` prints). */
export async function privateFactShare(engine: BrainEngine): Promise<{ total: number; private: number }> {
  const [row] = await engine.executeRaw<{ total: number | string; private: number | string }>(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE visibility <> 'world')::int AS private FROM facts
      WHERE expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())`);
  return { total: Number(row?.total ?? 0), private: Number(row?.private ?? 0) };
}
