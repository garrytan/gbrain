/**
 * Trust decisions (#5575: ENG-4, A5/I3, CEO-12): the typed `trust_proposals`
 * record and its checked handlers. A proposal links the row a decision would
 * change (`target`) to the row that caused it (`related`): the lower-tier fact
 * that would supersede a higher-tier one, the higher-tier fact a remote caller
 * asked to forget, the page an agent edit lowered. `before_state` holds the
 * exact state the accept path re-checks under lock (tiers, ids, revisions).
 *
 * Storage goes through the engine's typed members (engine-sql/trust-proposals.ts
 * on the SQL engines, the Rust store's `trust::proposals`).
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
import type { NewTrustProposal, TrustProposalFilter, TrustProposalRow, TrustProposalStatus, TrustProposalAction } from '../engine-sql/trust-proposals.ts';
import { noteBelief } from '../belief/ledger.ts';

export type { TrustProposalAction, TrustProposalStatus, TrustProposalRow, NewTrustProposal, TrustProposalFilter } from '../engine-sql/trust-proposals.ts';
export type TrustDecision = 'accept' | 'reject' | 'undo';

/** The typed CLI ref of a trust proposal. */
export const trustProposalRef = (id: number | string): string => `tp${id}`;

/** GST-2897 B: the guard of a member's share about another member, held private on a confirm proposal for the brain owner. */
export const SHARE_HELD_GUARD = 'remember.share_held';
/** `tp<id>` (or a bare id) to the proposal id; null when the ref names something else. */
export function parseTrustProposalRef(ref: string): number | null {
  const m = /^(?:tp)?(\d{1,18})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Inserts a pending proposal inside the caller's transaction, or returns the
 * pending one already recorded for the same (action, target, related): a
 * retried write or a second agent edit of one page reuses one queue item
 * (ENG-22). The proposer principal and request come from the transaction's
 * attribution settings.
 */
export async function insertTrustProposal(tx: BrainEngine, input: NewTrustProposal): Promise<{ id: number; created: boolean }> {
  const result = await tx.insertTrustProposal(input);
  noteBelief({ kind: 'contested', table: input.target.table, rowId: input.target.id, proposalId: result.id, guard: input.proposer });
  return result;
}

export async function getTrustProposal(engine: BrainEngine, id: number, lock = false): Promise<TrustProposalRow | null> {
  return engine.getTrustProposal(id, lock);
}

export async function listTrustProposals(engine: BrainEngine, filter: TrustProposalFilter = {}): Promise<TrustProposalRow[]> {
  return engine.listTrustProposals(filter);
}

/** Pending proposals naming a row as target or related (guards and explain read this). */
export async function pendingTrustProposalsFor(engine: BrainEngine, table: TrustTable, id: number): Promise<TrustProposalRow[]> {
  return engine.pendingTrustProposalsFor(table, id);
}

/** Refreshes a pending proposal's after state (a later write folded into the same queue item). */
export async function updatePendingTrustProposalAfter(tx: BrainEngine, id: number, after: Record<string, unknown>): Promise<void> {
  await tx.updatePendingTrustProposalAfter(id, after);
}

/** Compare-and-set on status; records the decider and an after state. False when the proposal was not in `from`. */
export async function transitionTrustProposal(tx: BrainEngine, id: number, from: TrustProposalStatus, to: TrustProposalStatus,
  opts: { after?: Record<string, unknown>; decidedBy?: Principal | null } = {}): Promise<boolean> {
  return tx.transitionTrustProposal(id, from, to, { after: opts.after, decidedBy: opts.decidedBy ? { kind: opts.decidedBy.kind, id: opts.decidedBy.id } : null });
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
/** Registers the handler for an action; returns the call that puts the previous registration back (a test stub must restore it: the registry is process-global). */
export function registerTrustProposalHandler(action: TrustProposalAction, handler: TrustProposalHandler): () => void {
  const previous = handlers.get(action);
  handlers.set(action, handler);
  return () => { if (previous) handlers.set(action, previous); else handlers.delete(action); };
}

/**
 * Load every module that registers a proposal handler and return the actions
 * now registered. The registering modules import this one, so they cannot be
 * static imports here; loading them at the read point keeps a decision from
 * depending on which modules the calling command happened to load first.
 */
export async function ensureTrustProposalHandlers(): Promise<TrustProposalAction[]> {
  await Promise.all([import('./page-handlers.ts'), import('./supersede-handlers.ts')]);
  return [...handlers.keys()];
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
  await ensureTrustProposalHandlers();
  const handler = handlers.get(proposal.action);
  if (decision === 'reject') return (handler?.reject ?? rejectOnly)(engine, proposal, ctx);
  if (!handler) return decisionResult(proposal, decision, 'refused', { reason: 'no_handler' });
  if (decision === 'undo') return handler.undo ? handler.undo(engine, proposal, ctx) : decisionResult(proposal, decision, 'refused', { reason: 'undo_unsupported' });
  return handler.accept(engine, proposal, ctx);
}
