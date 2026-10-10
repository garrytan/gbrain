/**
 * Trust decisions (#5575: ENG-4, A5/I3, CEO-12): the typed `trust_proposals`
 * record and its checked handlers. A proposal links the row a decision would
 * change (`target`) to the row that caused it (`related`): the lower-tier fact
 * that would supersede a higher-tier one, the higher-tier fact a remote caller
 * asked to forget, the page an agent edit lowered. `before_state` holds the
 * exact state the accept path re-checks under lock (tiers, ids, revisions).
 *
 * Storage goes through `engine.executeRaw` (the proposals-store.ts pattern).
 * decide_proposals gets no rows from here; CLI refs are `tp<id>`. Proposals
 * are inserted inside the publication transaction that created them, so the
 * proposer is read from that transaction's attribution settings.
 *
 * Accept/reject/undo dispatch to one handler per action, registered by the
 * module that owns the write path (trust/supersede-handlers.ts for facts,
 * takes and forget; the owner-ops module for lower_page). Every handler runs
 * only after the caller established the owner's confirmation (CEO-9,
 * trust/confirm.ts); handlers re-check `before_state` under lock and refuse
 * stale proposals instead of applying them.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Principal } from '../persistence/model.ts';
import type { OwnerConfirmation } from './confirm.ts';
import type { TrustTable } from './schema.ts';
import { TRUST_PROPOSAL_ACTIONS, TRUST_PROPOSAL_STATUSES } from './schema.ts';

export type TrustProposalAction = typeof TRUST_PROPOSAL_ACTIONS[number];
export type TrustProposalStatus = typeof TRUST_PROPOSAL_STATUSES[number];
export type TrustDecision = 'accept' | 'reject' | 'undo';

export interface TrustProposalRow {
  id: number;
  action: TrustProposalAction;
  source_id: string;
  target_table: TrustTable;
  target_id: number;
  related_table: TrustTable | null;
  related_id: number | null;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  proposer: string;
  proposer_principal_kind: string | null;
  proposer_principal_id: string | null;
  write_request_id: string | null;
  status: TrustProposalStatus;
  decided_at: string | null;
  decided_principal_kind: string | null;
  decided_principal_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The typed CLI ref of a trust proposal. */
export const trustProposalRef = (id: number | string): string => `tp${id}`;
/** `tp<id>` (or a bare id) to the proposal id; null when the ref names something else. */
export function parseTrustProposalRef(ref: string): number | null {
  const m = /^(?:tp)?(\d{1,18})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

const json = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return {};
};
const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string).toISOString();
function normalize(r: Record<string, unknown>): TrustProposalRow {
  return {
    id: Number(r.id), action: r.action as TrustProposalAction, source_id: String(r.source_id),
    target_table: r.target_table as TrustTable, target_id: Number(r.target_id),
    related_table: (r.related_table as TrustTable | null) ?? null, related_id: r.related_id === null || r.related_id === undefined ? null : Number(r.related_id),
    before_state: json(r.before_state), after_state: json(r.after_state), proposer: String(r.proposer),
    proposer_principal_kind: (r.proposer_principal_kind as string | null) ?? null, proposer_principal_id: (r.proposer_principal_id as string | null) ?? null,
    write_request_id: (r.write_request_id as string | null) ?? null, status: r.status as TrustProposalStatus,
    decided_at: iso(r.decided_at), decided_principal_kind: (r.decided_principal_kind as string | null) ?? null,
    decided_principal_id: (r.decided_principal_id as string | null) ?? null,
    created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
  };
}

export interface NewTrustProposal {
  action: TrustProposalAction;
  sourceId: string;
  target: { table: TrustTable; id: number };
  related?: { table: TrustTable; id: number } | null;
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Short name of the guard that raised it, e.g. `remember.replaces`, `fence_projection`, `remote_forget`, `agent_page_edit`. */
  proposer: string;
}

/**
 * Inserts a pending proposal inside the caller's transaction, or returns the
 * pending one already recorded for the same (action, target, related): a
 * retried write or a second agent edit of one page reuses one queue item
 * (ENG-22). The proposer principal and request come from the transaction's
 * attribution settings.
 */
export async function insertTrustProposal(tx: BrainEngine, input: NewTrustProposal): Promise<{ id: number; created: boolean }> {
  const params = [input.action, input.sourceId, input.target.table, input.target.id, input.related?.table ?? null, input.related?.id ?? null,
    JSON.stringify(input.before), JSON.stringify(input.after ?? {}), input.proposer];
  const [inserted] = await tx.executeRaw<{ id: number }>(
    `INSERT INTO trust_proposals (action, source_id, target_table, target_id, related_table, related_id, before_state, after_state, proposer,
        proposer_principal_kind, proposer_principal_id, write_request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9,
        NULLIF(current_setting('gbrain.write_principal_kind', true), ''), NULLIF(current_setting('gbrain.write_principal_id', true), ''),
        NULLIF(current_setting('gbrain.write_request', true), '')::uuid)
      ON CONFLICT DO NOTHING RETURNING id`, params);
  if (inserted) return { id: Number(inserted.id), created: true };
  const [existing] = await tx.executeRaw<{ id: number }>(
    `SELECT id FROM trust_proposals WHERE status = 'pending' AND action = $1 AND target_table = $2 AND target_id = $3
       AND related_table IS NOT DISTINCT FROM $4 AND related_id IS NOT DISTINCT FROM $5 ORDER BY id LIMIT 1`,
    [input.action, input.target.table, input.target.id, input.related?.table ?? null, input.related?.id ?? null]);
  if (!existing) throw new Error('trust proposal insert conflicted but no pending row was found');
  return { id: Number(existing.id), created: false };
}

export async function getTrustProposal(engine: BrainEngine, id: number, lock = false): Promise<TrustProposalRow | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT * FROM trust_proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return row ? normalize(row) : null;
}

export interface TrustProposalFilter {
  status?: TrustProposalStatus | 'all';
  sourceId?: string;
  action?: TrustProposalAction;
  since?: Date;
  limit?: number;
}

export async function listTrustProposals(engine: BrainEngine, filter: TrustProposalFilter = {}): Promise<TrustProposalRow[]> {
  const status = filter.status ?? 'pending';
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM trust_proposals
      WHERE ($1::text = 'all' OR status = $1) AND ($2::text IS NULL OR source_id = $2) AND ($3::text IS NULL OR action = $3)
        AND ($4::timestamptz IS NULL OR created_at >= $4)
      ORDER BY created_at, id LIMIT $5`,
    [status, filter.sourceId ?? null, filter.action ?? null, filter.since?.toISOString() ?? null, Math.min(Math.max(filter.limit ?? 500, 1), 5000)]);
  return rows.map(normalize);
}

/** Pending proposals naming a row as target or related (guards and explain read this). */
export async function pendingTrustProposalsFor(engine: BrainEngine, table: TrustTable, id: number): Promise<TrustProposalRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM trust_proposals WHERE status = 'pending'
       AND ((target_table = $1 AND target_id = $2) OR (related_table = $1 AND related_id = $2)) ORDER BY id`, [table, id]);
  return rows.map(normalize);
}

/** Refreshes a pending proposal's after state (a later write folded into the same queue item). */
export async function updatePendingTrustProposalAfter(tx: BrainEngine, id: number, after: Record<string, unknown>): Promise<void> {
  await tx.executeRaw(`UPDATE trust_proposals SET after_state = $2::text::jsonb, updated_at = now() WHERE id = $1 AND status = 'pending'`, [id, JSON.stringify(after)]);
}

/** Compare-and-set on status; records the decider and an after state. False when the proposal was not in `from`. */
export async function transitionTrustProposal(tx: BrainEngine, id: number, from: TrustProposalStatus, to: TrustProposalStatus,
  opts: { after?: Record<string, unknown>; decidedBy?: Principal | null } = {}): Promise<boolean> {
  const rows = await tx.executeRaw<{ id: number }>(
    `UPDATE trust_proposals SET status = $3, updated_at = now(),
        after_state = CASE WHEN $4::text IS NULL THEN after_state ELSE $4::text::jsonb END,
        decided_at = CASE WHEN $3 IN ('accepted', 'rejected', 'undone') THEN now() ELSE decided_at END,
        decided_principal_kind = COALESCE($5, decided_principal_kind), decided_principal_id = COALESCE($6, decided_principal_id)
      WHERE id = $1 AND status = $2 RETURNING id`,
    [id, from, to, opts.after ? JSON.stringify(opts.after) : null, opts.decidedBy?.kind ?? null, opts.decidedBy?.id ?? null]);
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Checked handlers
// ---------------------------------------------------------------------------

export interface TrustDecisionResult {
  id: number;
  ref: string;
  action: TrustProposalAction;
  decision: TrustDecision;
  status: TrustProposalStatus | 'refused' | 'not_found' | 'stale';
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface TrustDecisionContext {
  config?: GBrainConfig;
  /** How the owner confirmed (trust/confirm.ts requireOwnerConfirmation); required for accept and undo. */
  confirmation: OwnerConfirmation;
  /** The owner principal recorded as the decider. */
  decidedBy?: Principal | null;
}

export interface TrustProposalHandler {
  accept(engine: BrainEngine, proposal: TrustProposalRow, ctx: TrustDecisionContext): Promise<TrustDecisionResult>;
  reject?(engine: BrainEngine, proposal: TrustProposalRow, ctx: TrustDecisionContext): Promise<TrustDecisionResult>;
  undo?(engine: BrainEngine, proposal: TrustProposalRow, ctx: TrustDecisionContext): Promise<TrustDecisionResult>;
}

const handlers = new Map<TrustProposalAction, TrustProposalHandler>();
export function registerTrustProposalHandler(action: TrustProposalAction, handler: TrustProposalHandler): void {
  handlers.set(action, handler);
}

export function decisionResult(proposal: Pick<TrustProposalRow, 'id' | 'action'>, decision: TrustDecision,
  status: TrustDecisionResult['status'], extra: { reason?: string; detail?: Record<string, unknown> } = {}): TrustDecisionResult {
  return { id: proposal.id, ref: trustProposalRef(proposal.id), action: proposal.action, decision, status, ...extra };
}

/** The default reject: the proposal closes and nothing else changes. */
async function rejectOnly(engine: BrainEngine, proposal: TrustProposalRow, ctx: TrustDecisionContext): Promise<TrustDecisionResult> {
  return await transitionTrustProposal(engine, proposal.id, 'pending', 'rejected', { decidedBy: ctx.decidedBy })
    ? decisionResult(proposal, 'reject', 'rejected')
    : decisionResult(proposal, 'reject', 'refused', { reason: (await getTrustProposal(engine, proposal.id))?.status ?? 'not_found' });
}

/**
 * Applies one owner decision. The caller has already established the owner's
 * confirmation for this exact proposal (CEO-9); the handler re-checks the
 * recorded state under lock. Unknown ids and wrong states are reported, not thrown.
 */
export async function decideTrustProposal(engine: BrainEngine, id: number, decision: TrustDecision, ctx: TrustDecisionContext): Promise<TrustDecisionResult> {
  const proposal = await getTrustProposal(engine, id);
  if (!proposal) return { id, ref: trustProposalRef(id), action: 'confirm', decision, status: 'not_found' };
  const want = decision === 'undo' ? 'accepted' : 'pending';
  if (proposal.status !== want) return decisionResult(proposal, decision, 'refused', { reason: proposal.status });
  const handler = handlers.get(proposal.action);
  if (decision === 'reject') return (handler?.reject ?? rejectOnly)(engine, proposal, ctx);
  if (!handler) return decisionResult(proposal, decision, 'refused', { reason: 'no_handler' });
  if (decision === 'undo') return handler.undo ? handler.undo(engine, proposal, ctx) : decisionResult(proposal, decision, 'refused', { reason: 'undo_unsupported' });
  return handler.accept(engine, proposal, ctx);
}
