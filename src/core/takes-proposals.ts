/**
 * #1467 — take-proposal review queue (list / accept / reject).
 *
 * The propose_takes cycle phase writes candidate claims to `take_proposals`;
 * this module is the operator path from queue to canonical fence that
 * propose-takes.ts's doc comment promises ("User accepts/rejects via
 * `gbrain takes propose`"). Shared by the `takes_proposals_list` /
 * `takes_proposal_resolve` operations and the `gbrain takes propose` CLI.
 *
 * Accept follows the same markdown-is-canonical contract as `takes add`:
 * per-page file lock → fence append via upsertTakeRow → DB mirror via
 * addTakesBatch → verdict row update (promoted_row_num recorded for audit).
 */

import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { upsertTakeRow } from './takes-fence.ts';
import { withPageLock } from './page-lock.ts';
import { GBrainError } from './types.ts';

export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  model_id: string;
  proposed_at: string;
  promoted_row_num: number | null;
}

const PROPOSAL_COLUMNS =
  'id, source_id, page_slug, status, claim_text, kind, holder, weight, ' +
  'domain, model_id, proposed_at, promoted_row_num';

export interface ListTakeProposalsOpts {
  sourceId?: string;
  sourceIds?: string[];
  /** pending (default) | accepted | rejected | superseded */
  status?: string;
  pageSlug?: string;
  limit?: number;   // default 50, cap 200
  offset?: number;
  /** Per-token holder allow-list (MCP callers) — same contract as takes_list. */
  takesHoldersAllowList?: string[];
}

export async function listTakeProposals(
  engine: BrainEngine,
  opts: ListTakeProposalsOpts = {},
): Promise<TakeProposalRow[]> {
  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];

  // Source isolation: federated array beats scalar (sourceScopeOpts precedence).
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    where.push(`source_id IN (${opts.sourceIds.map(bind).join(', ')})`);
  } else if (opts.sourceId) {
    where.push(`source_id = ${bind(opts.sourceId)}`);
  }
  where.push(`status = ${bind(opts.status ?? 'pending')}`);
  if (opts.pageSlug) where.push(`page_slug = ${bind(opts.pageSlug)}`);
  if (opts.takesHoldersAllowList) {
    // Fail-closed: an empty allow-list means "no holders visible", not "all".
    if (opts.takesHoldersAllowList.length === 0) return [];
    where.push(`holder IN (${opts.takesHoldersAllowList.map(bind).join(', ')})`);
  }

  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  return engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM take_proposals
      WHERE ${where.join(' AND ')}
      ORDER BY proposed_at DESC, id DESC
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
    params,
  );
}

export interface ResolveTakeProposalOpts {
  id: number;
  verdict: 'accept' | 'reject';
  /** Brain repo dir. Required for accept (markdown is canonical). */
  brainDir?: string;
  sourceId?: string;
  sourceIds?: string[];
  /** Audit tag for acted_by (default 'cli'). */
  actedBy?: string;
}

export interface ResolveTakeProposalResult {
  id: number;
  status: 'accepted' | 'rejected';
  page_slug: string;
  promoted_row_num?: number;
}

export async function resolveTakeProposal(
  engine: BrainEngine,
  opts: ResolveTakeProposalOpts,
): Promise<ResolveTakeProposalResult> {
  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [`id = ${bind(opts.id)}`];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    where.push(`source_id IN (${opts.sourceIds.map(bind).join(', ')})`);
  } else if (opts.sourceId) {
    where.push(`source_id = ${bind(opts.sourceId)}`);
  }
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM take_proposals WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  );
  const proposal = rows[0];
  if (!proposal) {
    throw new GBrainError(
      'PROPOSAL_NOT_FOUND',
      `take proposal #${opts.id} not found in scope`,
      'list pending proposals with `gbrain takes propose` and use one of the listed ids',
    );
  }
  if (proposal.status !== 'pending') {
    throw new GBrainError(
      'PROPOSAL_ALREADY_RESOLVED',
      `take proposal #${opts.id} is already ${proposal.status}`,
      'only pending proposals can be accepted or rejected',
    );
  }

  const actedBy = opts.actedBy ?? 'cli';

  if (opts.verdict === 'reject') {
    await engine.executeRaw(
      `UPDATE take_proposals SET status = 'rejected', acted_at = now(), acted_by = $1 WHERE id = $2`,
      [actedBy, proposal.id],
    );
    return { id: proposal.id, status: 'rejected', page_slug: proposal.page_slug };
  }

  // Accept: promote into the canonical fence + DB, then mark the verdict.
  if (!opts.brainDir) {
    throw new GBrainError(
      'NO_BRAIN_DIR',
      'accepting a proposal writes the canonical markdown fence, which needs the brain repo path',
      'pass --dir <path> or set the sync.repo_path config',
    );
  }
  // Page must exist in the DB (proposals are extracted from DB pages; a
  // missing page means it was deleted or the source drifted — fail loudly).
  const pageRows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
    [proposal.page_slug, proposal.source_id],
  );
  const pageId = pageRows[0]?.id;
  if (!pageId) {
    throw new GBrainError(
      'PROPOSAL_PAGE_NOT_FOUND',
      `page ${proposal.page_slug} (source=${proposal.source_id}) is no longer in the brain`,
      'run `gbrain sync` to reconcile, or reject the proposal',
    );
  }

  let promotedRowNum = 0;
  await withPageLock(proposal.page_slug, async () => {
    const path = join(opts.brainDir!, `${proposal.page_slug}.md`);
    const body = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const next = upsertTakeRow(body, {
      claim: proposal.claim_text,
      kind: proposal.kind,
      holder: proposal.holder,
      weight: proposal.weight,
      source: `proposed by ${proposal.model_id}`,
      active: true,
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next.body, 'utf-8');
    promotedRowNum = next.rowNum;

    await engine.addTakesBatch([{
      page_id: pageId,
      row_num: promotedRowNum,
      claim: proposal.claim_text,
      kind: proposal.kind,
      holder: proposal.holder,
      weight: proposal.weight,
      source: `proposed by ${proposal.model_id}`,
      active: true,
      superseded_by: null,
    }]);

    await engine.executeRaw(
      `UPDATE take_proposals
          SET status = 'accepted', acted_at = now(), acted_by = $1, promoted_row_num = $2
        WHERE id = $3`,
      [actedBy, promotedRowNum, proposal.id],
    );
  });

  return {
    id: proposal.id,
    status: 'accepted',
    page_slug: proposal.page_slug,
    promoted_row_num: promotedRowNum,
  };
}
