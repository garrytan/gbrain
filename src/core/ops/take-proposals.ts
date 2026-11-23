/**
 * Take-proposal review over MCP: list, read, accept and reject the LLM-proposed takes the dream cycle's
 * propose_takes phase queues in `take_proposals`. Before these, only the host CLI could drain the queue
 * (`gbrain takes propose [--accept|--reject]`), so an agent working for a person could not review it.
 *
 * Scope and fences follow the takes ops: reads need `read`, decisions need `write` (accept writes a take, exactly
 * what `takes_add` needs). Remote callers see only proposals in their source grant, whose holder is in their
 * takes-holder allow-list and whose page they may read; any other id presents as not_found. Accept promotes through
 * the same coordinated takes_add mutation as the CLI, run AS the caller, so the holder write fence applies and the
 * page version records the caller's agent label. acted_by records the caller's agent label (X-Gbrain-Agent-Label, else
 * `mcp:<client>`); acted_via records `mcp:<client>`.
 *
 * Retry-safe: repeating a decision that already took effect returns the recorded outcome with
 * `already_decided: true`; the opposite decision on a decided row is refused (`proposal_already_decided`).
 * Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation, type OperationContext } from './contract.ts';
import { readHolders, sourceScopeOpts, enforceClientSlugFence } from './context.ts';
import { resolveExcludePrivatePages, privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { WRITE_REQUEST_PARAM } from '../persistence/params.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import {
  acceptProposal, getProposal, listProposals, rejectProposal,
  TakeProposalError, DECISION_REASON_MAX_CHARS, PROPOSAL_STATUSES,
  type ListProposalsOpts, type ProposalEdits, type TakeProposalRow,
} from '../take-proposals.ts';

const TAKE_KINDS = ['fact', 'take', 'bet', 'hunch'] as const;

/** The scope a caller reads proposals in: its source grant, holder allow-list and, remotely, readable pages only. */
async function callerScope(ctx: OperationContext): Promise<Omit<ListProposalsOpts, 'status' | 'limit' | 'offset'>> {
  const sources = sourceScopeOpts(ctx);
  const holders = readHolders(ctx);
  const remote = ctx.remote !== false;
  const hidePrivate = remote && await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  return {
    ...sources,
    ...(holders !== undefined ? { holders } : {}),
    // A remote caller only sees proposals on pages that exist and that it may read.
    ...(remote ? { pageFilterSql: hidePrivate ? privatePagesFilterForCaller('p') : 'TRUE' } : {}),
  };
}

function proposalId(raw: unknown): number {
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw opError('invalid_params', 'id must be a positive integer proposal id.', 'Pass the id takes_proposals_list returned.');
  }
  return id;
}

async function visibleProposal(ctx: OperationContext, id: number, op: string): Promise<TakeProposalRow> {
  const row = await getProposal(ctx.engine, id, await callerScope(ctx));
  if (!row) {
    throw opError('not_found', `${op}: no take proposal #${id} visible to this connection.`,
      'List the reviewable proposals with takes_proposals_list and use one of their ids.');
  }
  return row;
}

/** Who decided and through which surface; never a client-supplied value. */
async function reviewer(ctx: OperationContext): Promise<{ actedBy: string; actedVia: string }> {
  if (ctx.remote === false) {
    const owner = resolveOwnerHolder({ configValue: await ctx.engine.getConfig('emotional_weight.user_holder') });
    return { actedBy: owner, actedVia: 'cli' };
  }
  const client = ctx.auth?.clientName ?? ctx.auth?.clientId ?? ctx.transport ?? 'stdio';
  return { actedBy: ctx.agentLabel ?? `mcp:${client}`, actedVia: `mcp:${client}` };
}

/** The review fields of a row: what list/get return (claim text included). */
function view(row: TakeProposalRow) {
  return {
    id: row.id,
    source_id: row.source_id,
    page_slug: row.page_slug,
    claim: row.claim_text,
    kind: row.kind,
    holder: row.holder,
    weight: row.weight,
    domain: row.domain,
    status: row.status,
    proposed_at: iso(row.proposed_at),
    model_id: row.model_id,
    promoted_row_num: row.promoted_row_num,
    acted_by: row.acted_by ?? null,
    acted_at: iso(row.acted_at ?? null),
    acted_via: row.acted_via ?? null,
    reason: row.decision_reason ?? null,
  };
}

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** The outcome of a decision: ids and status only, never stored text. */
function decision(row: TakeProposalRow, extra: Record<string, unknown> = {}) {
  return {
    id: row.id, page_slug: row.page_slug, status: row.status, promoted_row_num: row.promoted_row_num,
    acted_by: row.acted_by ?? null, acted_at: iso(row.acted_at ?? null), acted_via: row.acted_via ?? null, ...extra,
  };
}

function alreadyDecided(op: string, row: TakeProposalRow): never {
  throw opError('proposal_already_decided', `${op}: proposal #${row.id} is already '${row.status}'${row.acted_by ? ` (by ${row.acted_by})` : ''}.`,
    'Only a pending proposal can be accepted or rejected; list pending ones with takes_proposals_list.');
}

const takes_proposals_list: Operation = {
  name: 'takes_proposals_list',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'List take proposals: claims the dream cycle proposed from pages, waiting for review (accept with ' +
    'takes_proposal_accept, reject with takes_proposal_reject). Default pending, newest first. Remote callers see ' +
    'proposals in their source grant, on pages they may read, whose holder is in their takes-holder allow-list.',
  params: {
    status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'superseded', 'all'], description: 'Status filter (default pending).' },
    page_slug: { type: 'string', description: 'Only proposals on this page.' },
    kind: { type: 'string', enum: [...TAKE_KINDS], description: 'Only this kind.' },
    holder: { type: 'string', description: 'Only this holder.' },
    min_weight: { type: 'number', description: 'Only proposals with at least this weight (0..1).' },
    limit: { type: 'number', description: 'Max rows (default 20, cap 200).' },
    offset: { type: 'number', description: 'Skip the first N rows.' },
  },
  scope: 'read',
  area: 'takes',
  handler: async (ctx, p) => {
    const minWeight = p.min_weight === undefined ? undefined : Number(p.min_weight);
    if (minWeight !== undefined && (!Number.isFinite(minWeight) || minWeight < 0 || minWeight > 1)) {
      throw opError('invalid_params', 'min_weight must be a number from 0 to 1.', 'Pass min_weight between 0 and 1, or leave it out.');
    }
    const status = (p.status as string | undefined) ?? 'pending';
    if (status !== 'all' && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      throw opError('invalid_params', `Unknown status '${status}'.`, 'Pass pending, accepted, rejected, superseded or all.');
    }
    const { proposals, total } = await listProposals(ctx.engine, {
      ...await callerScope(ctx),
      status: status as ListProposalsOpts['status'],
      ...(p.page_slug ? { pageSlug: p.page_slug as string } : {}),
      ...(p.kind ? { kind: p.kind as string } : {}),
      ...(p.holder ? { holder: p.holder as string } : {}),
      ...(minWeight !== undefined ? { minWeight } : {}),
      ...(p.limit !== undefined ? { limit: Number(p.limit) } : {}),
      ...(p.offset !== undefined ? { offset: Number(p.offset) } : {}),
    });
    return { total, proposals: proposals.map(view) };
  },
  cliHints: { name: 'takes-proposals-list' },
};

const takes_proposal_get: Operation = {
  name: 'takes_proposal_get',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Read one take proposal by id (any status): claim, kind, holder, weight, page, and the decision once made.',
  params: {
    id: { type: 'number', required: true, description: 'Proposal id (from takes_proposals_list).' },
  },
  scope: 'read',
  area: 'takes',
  handler: async (ctx, p) => view(await visibleProposal(ctx, proposalId(p.id), 'takes_proposal_get')),
  cliHints: { name: 'takes-proposal-get', positional: ['id'] },
};

const takes_proposal_accept: Operation = {
  name: 'takes_proposal_accept',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    "Accept a pending take proposal: writes it as a take into the page's takes fence (markdown-canonical, the " +
    'same write takes_add makes) and marks the proposal accepted. Optional edits (claim, weight, kind, holder) ' +
    'replace the proposed values; the take\'s source then says "(edited)". Remote callers: the holder must be in ' +
    'their takes-holder allow-list. Repeating an accept that took effect returns it with already_decided: true.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    id: { type: 'number', required: true, description: 'Proposal id (from takes_proposals_list).' },
    claim: { type: 'string', description: 'Edited claim text (one line). Default: the proposed claim.' },
    weight: { type: 'number', description: 'Edited confidence 0..1. Default: the proposed weight.' },
    kind: { type: 'string', enum: [...TAKE_KINDS], description: 'Edited kind. Default: the proposed kind.' },
    holder: { type: 'string', description: 'Edited holder (world | people/<slug> | companies/<slug> | brain). Default: the proposed holder.' },
  },
  scope: 'write',
  area: 'takes',
  handler: async (ctx, p) => {
    const id = proposalId(p.id);
    const edits: ProposalEdits = {};
    if (p.claim !== undefined) {
      if (typeof p.claim !== 'string' || !p.claim.trim()) throw opError('invalid_params', 'claim must be non-empty text.', 'Pass the edited claim, or leave claim out.');
      edits.claim = p.claim;
    }
    if (p.weight !== undefined) {
      const weight = Number(p.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw opError('invalid_params', 'weight must be a number from 0 to 1.', 'Pass weight between 0 and 1, or leave it out.');
      edits.weight = weight;
    }
    if (p.kind !== undefined) {
      if (!(TAKE_KINDS as readonly string[]).includes(p.kind as string)) throw opError('invalid_params', 'kind must be fact, take, bet or hunch.', 'Pass one of the four kinds, or leave kind out.');
      edits.kind = p.kind as string;
    }
    if (p.holder !== undefined) {
      if (typeof p.holder !== 'string' || !p.holder.trim()) throw opError('invalid_params', 'holder must be non-empty text.', 'Pass a holder, or leave holder out.');
      edits.holder = p.holder;
    }
    const row = await visibleProposal(ctx, id, 'takes_proposal_accept');
    if (row.status === 'accepted' && row.promoted_row_num != null) return decision(row, { already_decided: true });
    if (row.status !== 'pending' && row.status !== 'accepted') alreadyDecided('takes_proposal_accept', row);
    enforceClientSlugFence(ctx, row.page_slug, 'takes_proposal_accept');
    const holder = edits.holder ?? row.holder;
    const holders = ctx.remote === false ? undefined : (ctx.takesHoldersAllowList ?? ['world']);
    if (holders && !holders.includes(holder)) {
      throw opError('permission_denied', `takes_proposal_accept: holder '${holder}' is not in this connection's takes-holder allow-list.`,
        "Ask the brain host's operator to grant this holder to the connection, or accept with a holder the connection may write.");
    }
    if (ctx.dryRun) return { dry_run: true, action: 'takes_proposal_accept', id, page_slug: row.page_slug };
    const who = await reviewer(ctx);
    try {
      const { rowNum } = await acceptProposal({
        engine: ctx.engine, config: ctx.config, sourceId: row.source_id, ...who, callerCtx: ctx,
      }, id, edits);
      const after = await getProposal(ctx.engine, id, { sourceId: row.source_id });
      return decision(after ?? { ...row, status: 'accepted', promoted_row_num: rowNum }, { row_num: rowNum, edited: Object.keys(edits).length > 0 });
    } catch (error) {
      if (!(error instanceof TakeProposalError)) throw error;
      const now = await getProposal(ctx.engine, id, { sourceId: row.source_id });
      if (now?.status === 'accepted' && now.promoted_row_num != null) return decision(now, { already_decided: true });
      if (now && now.status !== 'pending' && now.status !== 'accepted') alreadyDecided('takes_proposal_accept', now);
      throw opError('proposal_already_decided', `takes_proposal_accept: ${error.message}`, 'Retry the same call in a minute; it resumes the same write and never adds a second take.');
    }
  },
  cliHints: { name: 'takes-proposal-accept', positional: ['id'] },
};

const takes_proposal_reject: Operation = {
  name: 'takes_proposal_reject',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Reject a pending take proposal (optional reason). Writes no take. Repeating a reject that took effect ' +
    'returns it with already_decided: true.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    id: { type: 'number', required: true, description: 'Proposal id (from takes_proposals_list).' },
    reason: { type: 'string', description: `Why it was rejected (at most ${DECISION_REASON_MAX_CHARS} characters).` },
  },
  scope: 'write',
  area: 'takes',
  handler: async (ctx, p) => {
    const id = proposalId(p.id);
    const reason = p.reason === undefined ? undefined : String(p.reason);
    if (reason !== undefined && reason.length > DECISION_REASON_MAX_CHARS) {
      throw opError('invalid_params', `reason is longer than ${DECISION_REASON_MAX_CHARS} characters.`, 'Shorten the reason.');
    }
    const row = await visibleProposal(ctx, id, 'takes_proposal_reject');
    if (row.status === 'rejected') return decision(row, { already_decided: true });
    if (row.status !== 'pending') alreadyDecided('takes_proposal_reject', row);
    if (ctx.dryRun) return { dry_run: true, action: 'takes_proposal_reject', id, page_slug: row.page_slug };
    try {
      await rejectProposal({ engine: ctx.engine, sourceId: row.source_id, ...await reviewer(ctx) }, id, reason);
    } catch (error) {
      if (!(error instanceof TakeProposalError)) throw error;
      const now = await getProposal(ctx.engine, id, { sourceId: row.source_id });
      if (now?.status === 'rejected') return decision(now, { already_decided: true });
      alreadyDecided('takes_proposal_reject', now ?? row);
    }
    const after = await getProposal(ctx.engine, id, { sourceId: row.source_id });
    return decision(after ?? { ...row, status: 'rejected' });
  },
  cliHints: { name: 'takes-proposal-reject', positional: ['id'] },
};

export const takeProposalOperations: Operation[] = [
  takes_proposals_list, takes_proposal_get, takes_proposal_accept, takes_proposal_reject,
];
