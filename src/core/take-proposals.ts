/**
 * #2411 / #4102 — drain surface for the `take_proposals` queue.
 *
 * The propose_takes cycle phase (src/core/cycle/propose-takes.ts) WRITES
 * proposals; the D17 auto-resolve posture says the ONLY path from queue to
 * canonical fence is explicit operator accept. This module is that path:
 *
 *   - listPendingProposals — source-scoped pending queue (newest first).
 *   - acceptProposal       — promote via addTakeToPage (markdown-canonical
 *                            write-through), then stamp status='accepted' +
 *                            promoted_row_num + acted_at/acted_by.
 *   - rejectProposal       — stamp status='rejected' + acted_at/acted_by.
 *
 * All reads/writes are parameterized and scoped to the caller's source when
 * one is provided (the CLI always resolves one via resolveSourceId). The
 * accept write goes through the SAME shared write-through core the takes_*
 * ops use, so the fence lock, holder fence, injection guards and DB mirror
 * all apply.
 */

import type { BrainEngine, TakeKind } from './engine.ts';
import { addTakeToPage } from './takes-write.ts';

export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  status: string;
  proposed_at: string | Date;
  model_id: string;
  promoted_row_num: number | null;
}

export type TakeProposalErrorCode = 'not_found' | 'not_pending';

export class TakeProposalError extends Error {
  constructor(
    public readonly code: TakeProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TakeProposalError';
  }
}

/**
 * The producer (parseExtractorOutput) only ever writes the four canonical
 * kinds, but the column is free TEXT — coerce defensively so a legacy or
 * hand-inserted row can't crash the promote path. 'prediction' (the raw
 * extractor-prompt enum) maps to 'bet'; anything else unknown maps to 'take'.
 */
export function coerceProposalKind(raw: string): TakeKind {
  if (raw === 'fact' || raw === 'take' || raw === 'bet' || raw === 'hunch') return raw;
  if (raw === 'prediction') return 'bet';
  return 'take';
}

const PROPOSAL_COLUMNS =
  'id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, model_id, promoted_row_num';

export interface ListPendingOpts {
  /** Scope to one source (the CLI always provides one). Omit = all sources (trusted local only). */
  sourceId?: string;
  limit?: number;
}

/** Pending proposals, newest first. Tombstones never surface (status='rejected'). */
export async function listPendingProposals(
  engine: BrainEngine,
  opts: ListPendingOpts = {},
): Promise<TakeProposalRow[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 20));
  const where = [`status = 'pending'`];
  const params: unknown[] = [];
  if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  params.push(limit);
  return engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM take_proposals
      WHERE ${where.join(' AND ')}
      ORDER BY proposed_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
}

async function loadProposal(
  engine: BrainEngine,
  id: number,
  sourceId?: string,
): Promise<TakeProposalRow> {
  const params: unknown[] = [id];
  let scope = '';
  if (sourceId) {
    params.push(sourceId);
    scope = ` AND source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM take_proposals WHERE id = $1${scope}`,
    params,
  );
  if (rows.length === 0) {
    throw new TakeProposalError('not_found', `No take proposal #${id}${sourceId ? ` in source '${sourceId}'` : ''}.`);
  }
  const row = rows[0];
  if (row.status !== 'pending') {
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} is already '${row.status}' (acted on) — only pending proposals can be accepted or rejected.`,
    );
  }
  return row;
}

export interface ProposalActionTarget {
  engine: BrainEngine;
  /** Brain repo root — accept writes the markdown fence (markdown-canonical). */
  brainDir?: string;
  /** Source scope: a proposal outside this source reads as not_found. */
  sourceId?: string;
  /** Recorded in acted_by. Defaults to 'cli'. */
  actedBy?: string;
}

/**
 * Promote a pending proposal into the page's takes fence, then mark the row
 * accepted. The fence write happens FIRST (addTakeToPage: lock → resolve page
 * → write .md → DB mirror); the status flip is fenced on status='pending' so
 * a concurrent accept can't double-stamp.
 */
export async function acceptProposal(
  target: ProposalActionTarget,
  id: number,
): Promise<{ proposal: TakeProposalRow; rowNum: number }> {
  const { engine } = target;
  const proposal = await loadProposal(engine, id, target.sourceId);
  if (!target.brainDir) {
    throw new TakeProposalError(
      'not_found',
      'Accept requires a brain directory (takes are markdown-canonical). Pass --dir or configure sync.repo_path.',
    );
  }
  const { rowNum } = await addTakeToPage(
    {
      engine,
      slug: proposal.page_slug,
      brainDir: target.brainDir,
      // The row's OWN source, never the caller's — the scoped load above
      // already proved they agree when a caller scope was provided.
      sourceId: proposal.source_id,
    },
    {
      claim: proposal.claim_text,
      kind: coerceProposalKind(proposal.kind),
      holder: proposal.holder,
      weight: typeof proposal.weight === 'number' ? proposal.weight : Number(proposal.weight),
    },
  );
  await engine.executeRaw(
    `UPDATE take_proposals
        SET status = 'accepted', acted_at = now(), acted_by = $2, promoted_row_num = $3
      WHERE id = $1 AND status = 'pending'`,
    [id, target.actedBy ?? 'cli', rowNum],
  );
  return { proposal, rowNum };
}

/** Mark a pending proposal rejected. No markdown write. */
export async function rejectProposal(
  target: Pick<ProposalActionTarget, 'engine' | 'sourceId' | 'actedBy'>,
  id: number,
): Promise<TakeProposalRow> {
  const { engine } = target;
  const proposal = await loadProposal(engine, id, target.sourceId);
  await engine.executeRaw(
    `UPDATE take_proposals
        SET status = 'rejected', acted_at = now(), acted_by = $2
      WHERE id = $1 AND status = 'pending'`,
    [id, target.actedBy ?? 'cli'],
  );
  return proposal;
}
