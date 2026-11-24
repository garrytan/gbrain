/**
 * Trust: the typed `trust_proposals` record (DDL in trust/schema.ts), the queue of trust decisions a guard files for the
 * owner. Each function runs the statement trust/proposals.ts ran through `executeRaw`, with the same statement and
 * parameters; only its home moved. The checked accept/reject/undo handlers and the belief-ledger note stay in
 * trust/proposals.ts.
 *
 * The proposer principal and write request are read by the insert itself from the transaction's attribution settings
 * (`gbrain.write_principal_kind`, `gbrain.write_principal_id`, `gbrain.write_request`); no member passes them.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { TrustTable } from '../trust/schema.ts';
import { TRUST_PROPOSAL_ACTIONS, TRUST_PROPOSAL_STATUSES } from '../trust/schema.ts';

export type TrustProposalAction = typeof TRUST_PROPOSAL_ACTIONS[number];
export type TrustProposalStatus = typeof TRUST_PROPOSAL_STATUSES[number];

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

export interface TrustProposalFilter {
  status?: TrustProposalStatus | 'all';
  sourceId?: string;
  action?: TrustProposalAction;
  since?: Date;
  limit?: number;
}

/** The row limit `listTrustProposals` applies: 500 by default, at least 1 and at most 5000. */
export const trustProposalLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 500, 1), 5000);

const json = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return {};
};
const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string).toISOString();

/** A stored row as callers read it: ids as numbers, jsonb states as objects, times as ISO text. */
export function normalizeTrustProposal(r: Record<string, unknown>): TrustProposalRow {
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

/**
 * Inserts a pending proposal, or returns the pending one already recorded for the same (action, target, related) with
 * `created: false` (the partial unique index; `ON CONFLICT DO NOTHING`).
 */
export async function insertTrustProposal(exec: SqlExecutor, input: NewTrustProposal): Promise<{ id: number; created: boolean }> {
  const params = [input.action, input.sourceId, input.target.table, input.target.id, input.related?.table ?? null, input.related?.id ?? null,
    JSON.stringify(input.before), JSON.stringify(input.after ?? {}), input.proposer];
  const [inserted] = await exec.executeRaw<{ id: number }>(
    `INSERT INTO trust_proposals (action, source_id, target_table, target_id, related_table, related_id, before_state, after_state, proposer,
        proposer_principal_kind, proposer_principal_id, write_request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9,
        NULLIF(current_setting('gbrain.write_principal_kind', true), ''), NULLIF(current_setting('gbrain.write_principal_id', true), ''),
        NULLIF(current_setting('gbrain.write_request', true), '')::uuid)
      ON CONFLICT DO NOTHING RETURNING id`, params);
  if (inserted) return { id: Number(inserted.id), created: true };
  const [existing] = await exec.executeRaw<{ id: number }>(
    `SELECT id FROM trust_proposals WHERE status = 'pending' AND action = $1 AND target_table = $2 AND target_id = $3
       AND related_table IS NOT DISTINCT FROM $4 AND related_id IS NOT DISTINCT FROM $5 ORDER BY id LIMIT 1`,
    [input.action, input.target.table, input.target.id, input.related?.table ?? null, input.related?.id ?? null]);
  if (!existing) throw new Error('trust proposal insert conflicted but no pending row was found');
  return { id: Number(existing.id), created: false };
}

/** One proposal by id; `lock` takes it `FOR UPDATE` for the decision that follows. */
export async function getTrustProposal(exec: LegacyUnscopedRead, id: number, lock = false): Promise<TrustProposalRow | null> {
  const [row] = await exec.executeRaw<Record<string, unknown>>(lock ? 'SELECT * FROM trust_proposals WHERE id = $1 FOR UPDATE' : 'SELECT * FROM trust_proposals WHERE id = $1', [id]);
  return row ? normalizeTrustProposal(row) : null;
}

/** Proposals by status (`pending` by default; `all`), source, action and creation time, oldest first. */
export async function listTrustProposals(exec: LegacyUnscopedRead, filter: TrustProposalFilter = {}): Promise<TrustProposalRow[]> {
  const status = filter.status ?? 'pending';
  const rows = await exec.executeRaw<Record<string, unknown>>(
    `SELECT * FROM trust_proposals
      WHERE ($1::text = 'all' OR status = $1) AND ($2::text IS NULL OR source_id = $2) AND ($3::text IS NULL OR action = $3)
        AND ($4::timestamptz IS NULL OR created_at >= $4)
      ORDER BY created_at, id LIMIT $5`,
    [status, filter.sourceId ?? null, filter.action ?? null, filter.since?.toISOString() ?? null, trustProposalLimit(filter.limit)]);
  return rows.map(normalizeTrustProposal);
}
