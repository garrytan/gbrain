/**
 * #2411 / #4102 — drain surface for the `take_proposals` queue.
 *
 * The propose_takes cycle phase (src/core/cycle/propose-takes.ts) WRITES
 * proposals; the D17 auto-resolve posture says the ONLY path from queue to
 * canonical fence is explicit operator accept. This module is that path:
 *
 *   - listPendingProposals — source-scoped pending queue (newest first).
 *   - acceptProposal       — promote via a coordinated `takes_add` mutation
 *                            (submitPageMutation, the same path `gbrain
 *                            takes add` uses), then stamp status='accepted' +
 *                            promoted_row_num + acted_at/acted_by.
 *   - rejectProposal       — stamp status='rejected' + acted_at/acted_by.
 *
 * All reads/writes are parameterized and scoped to the caller's source when
 * one is provided (the CLI always resolves one via resolveSourceId).
 *
 * The promote write goes through submitPageMutation (the SAME coordinated
 * pipeline `takes add`/`takes update`/`takes supersede`/`takes resolve` use),
 * not the uncoordinated addTakeToPage — a managed brain (persistence_brain
 * enabled: Postgres/Supabase with a coordinator-owned worktree) refuses any
 * direct file write outside that pipeline with 'writer_coordinator_required'
 * ("This file belongs to a managed canonical worktree."). Calling
 * addTakeToPage directly here made every `takes propose --accept` fail on a
 * managed brain — including the Slack report-lane's accept-before-correct
 * step, so a corrective reply on a pending proposal could never land.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine, TakeKind } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import type { OperationContext } from './ops/contract.ts';
import { submitPageMutation } from './persistence/page-mutations.ts';
import { waitForWrite } from './persistence/service.ts';
import type { WriteRequest } from './persistence/model.ts';
import { emitTakeProposalEvent } from './notifications/emit.ts';

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
  /** Who decided (a reviewer email, the owner holder, `cli`); null while pending. */
  acted_by?: string | null;
  acted_at?: string | Date | null;
  /** The surface the decision came through: `cli`, `mcp:<client>`, `slack:<sink>`. */
  acted_via?: string | null;
  /** The reviewer's reason for a reject, when one was given. */
  decision_reason?: string | null;
}

/** Normalize Postgres driver values to the public numeric row contract. */
function normalizeTakeProposalRow(row: TakeProposalRow): TakeProposalRow {
  return {
    ...row,
    id: Number(row.id),
    weight: Number(row.weight),
    promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
  };
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
  'id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, model_id, promoted_row_num, ' +
  'acted_by, acted_at, acted_via, decision_reason';
/** Longest reject reason stored; callers refuse a longer one. */
export const DECISION_REASON_MAX_CHARS = 500;
export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'superseded'] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

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
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM take_proposals
      WHERE ${where.join(' AND ')}
      ORDER BY proposed_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(normalizeTakeProposalRow);
}

export interface ListProposalsOpts {
  /** One source, or several (a federated grant). Omit both = every source (trusted local only). */
  sourceId?: string;
  sourceIds?: string[];
  /** Default pending; 'all' lists every status. */
  status?: ProposalStatus | 'all';
  pageSlug?: string;
  kind?: string;
  holder?: string;
  minWeight?: number;
  /** Holder allow-list: a proposal outside it is never listed. undefined = every holder (trusted local). */
  holders?: string[];
  /** SQL predicate over the joined page alias `p` hiding pages the caller may not read; the page must then exist. */
  pageFilterSql?: string;
  limit?: number;
  offset?: number;
}

function proposalWhere(opts: ListProposalsOpts, params: unknown[]): string[] {
  const where: string[] = [];
  const add = (sql: (n: number) => string, value: unknown) => { params.push(value); where.push(sql(params.length)); };
  if (opts.status && opts.status !== 'all') add(n => `tp.status = $${n}`, opts.status);
  if (opts.sourceIds && opts.sourceIds.length > 0) add(n => `tp.source_id = ANY($${n}::text[])`, opts.sourceIds);
  else if (opts.sourceId) add(n => `tp.source_id = $${n}`, opts.sourceId);
  if (opts.pageSlug) add(n => `tp.page_slug = $${n}`, opts.pageSlug);
  if (opts.kind) add(n => `tp.kind = $${n}`, opts.kind);
  if (opts.holder) add(n => `tp.holder = $${n}`, opts.holder);
  if (opts.minWeight !== undefined) add(n => `tp.weight >= $${n}`, opts.minWeight);
  if (opts.holders !== undefined) add(n => `tp.holder = ANY($${n}::text[])`, opts.holders);
  if (opts.pageFilterSql) where.push(opts.pageFilterSql);
  return where;
}

function proposalFrom(opts: Pick<ListProposalsOpts, 'pageFilterSql'>): string {
  return opts.pageFilterSql
    ? 'take_proposals tp JOIN pages p ON p.source_id = tp.source_id AND p.slug = tp.page_slug AND p.deleted_at IS NULL'
    : 'take_proposals tp';
}

const PROPOSAL_SELECT = PROPOSAL_COLUMNS.split(',').map(column => `tp.${column.trim()}`).join(', ');

/**
 * Proposals with the review filters, newest first, and how many matched.
 * Pending is the default; `status: 'all'` lists decided rows too.
 */
export async function listProposals(engine: BrainEngine, opts: ListProposalsOpts = {}): Promise<{ proposals: TakeProposalRow[]; total: number }> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 20)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const params: unknown[] = [];
  const where = proposalWhere({ status: 'pending', ...opts }, params);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${proposalFrom(opts)} ${clause}`, params);
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_SELECT} FROM ${proposalFrom(opts)} ${clause}
      ORDER BY tp.proposed_at DESC, tp.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { proposals: rows.map(normalizeTakeProposalRow), total: Number(total[0]?.n ?? 0) };
}

/** One proposal of any status inside the scope `listProposals` applies, or null. */
export async function getProposal(
  engine: BrainEngine,
  id: number,
  opts: Omit<ListProposalsOpts, 'status' | 'limit' | 'offset'> = {},
): Promise<TakeProposalRow | null> {
  const params: unknown[] = [id];
  const where = ['tp.id = $1', ...proposalWhere(opts, params)];
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_SELECT} FROM ${proposalFrom(opts)} WHERE ${where.join(' AND ')}`, params);
  return rows.length ? normalizeTakeProposalRow(rows[0]!) : null;
}

async function loadProposal(
  engine: BrainEngine,
  id: number,
  sourceId?: string,
  opts: { allowStranded?: boolean } = {},
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
  const row = normalizeTakeProposalRow(rows[0]);
  if (row.status !== 'pending') {
    // wave-g (#4480 follow-up): a crash between the accept CAS and the fence
    // write (or a failed rollback) strands the row as status='accepted' with
    // no promoted take — invisible in the pending list, so surface the
    // repairable shape exactly where a human retry lands.
    if (row.status === 'accepted' && row.promoted_row_num == null) {
      if (opts.allowStranded) return row;
      throw new TakeProposalError(
        'not_pending',
        `Proposal #${id} is claimed 'accepted' but its take is not recorded yet (its write is pending, or a crash stopped it). ` +
        `Re-run \`gbrain takes propose --accept ${id}\` to finish it; it resumes the same write and never adds a second take.`,
      );
    }
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} is already '${row.status}' (acted on) — only pending proposals can be accepted or rejected.`,
    );
  }
  return row;
}

export interface ProposalActionTarget {
  engine: BrainEngine;
  /** Not read: the takes_add mutation accept submits resolves its write root from the proposal's source (#7271). */
  brainDir?: string;
  /** Source scope: a proposal outside this source reads as not_found. */
  sourceId?: string;
  /** Recorded in acted_by. Defaults to 'cli'. */
  actedBy?: string;
  /** Threaded into the coordinated takes_add mutation accept performs. */
  config: GBrainConfig;
  /** An explicit `--dir`: validated against the source's canonical root, as `takes add --dir` is. */
  localDir?: string;
  /** Recorded in acted_via: the surface the decision came through (`cli` by default, `mcp:<client>`, `slack:<sink>`). */
  actedVia?: string;
  /**
   * The caller's own operation context. When set, the promoting takes_add runs AS that caller (its remote flag,
   * principal, holder allow-list, agent label and end user), so the write is fenced and attributed like a direct
   * takes_add from it; unset keeps the trusted local context the CLI always used.
   */
  callerCtx?: OperationContext;
}

/** #5214: reviewer edits applied over the proposal at accept; the queue row keeps the original text. */
export interface ProposalEdits { claim?: string; weight?: number; holder?: string; kind?: string }

/**
 * One write request per claim: derived from the proposal id and the claim's
 * acted_at, so resuming a claimed-but-unrecorded accept replays the same
 * durable request (a pending or committed takes_add is never admitted twice),
 * while a fresh claim after a released failure gets a new request.
 */
const SETTLED_WITHOUT_COMMIT = new Set(['failed', 'cancelled', 'conflict']);

async function claimRequestStates(engine: BrainEngine, requestId: string): Promise<WriteRequest[]> {
  return engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id = $1::uuid', [requestId]);
}

/** A claim younger than this may belong to an accept that is still submitting its write. */
const RESUME_GRACE_MS = 2 * 60_000;

function claimRequestId(id: number, actedAt: string): string {
  const h = createHash('sha256').update(`take-proposal-accept:${id}:${actedAt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Promotes an accepted proposal into the page's fence via the SAME
 * coordinated `takes_add` mutation `gbrain takes add` uses — never the
 * uncoordinated addTakeToPage — so a managed brain's writer-coordinator
 * guard (assertManagedFilesystemWrite) sees this write the same way it sees
 * every other takes mutation, instead of refusing it as an uncoordinated
 * legacy writer.
 *
 * The mutation resolves its own write root from the proposal's source
 * (source.local_path / sync.repo_path), as `gbrain takes add <slug>` does; an
 * explicit `--dir` rides along as `local_dir`, which the coordinator refuses
 * unless it is that canonical root.
 */
async function promoteProposalViaTakesAdd(
  target: ProposalActionTarget,
  proposal: TakeProposalRow,
  requestId: string,
  edits: ProposalEdits,
): Promise<number> {
  const ctx: OperationContext = target.callerCtx ? { ...target.callerCtx, sourceId: proposal.source_id, dryRun: false } : {
    engine: target.engine,
    config: target.config,
    remote: false,
    sourceId: proposal.source_id,
    dryRun: false,
    logger: { info: message => console.error(message), warn: message => console.error(message), error: message => console.error(message) },
  };
  const edited = Object.values(edits).some(value => value !== undefined);
  const params: Record<string, unknown> = {
    slug: proposal.page_slug,
    claim: edits.claim ?? proposal.claim_text,
    kind: edits.kind ?? coerceProposalKind(proposal.kind),
    holder: edits.holder ?? proposal.holder,
    weight: edits.weight ?? (typeof proposal.weight === 'number' ? proposal.weight : Number(proposal.weight)),
    source: `take_proposals#${proposal.id}${edited ? ' (edited)' : ''}`,
    source_id: proposal.source_id,
    request_id: requestId,
    ...(target.localDir !== undefined ? { local_dir: target.localDir } : {}),
  };
  const result = await submitPageMutation(ctx, { operation: 'takes_add', params });
  return Number(result.row_num);
}

/**
 * Promote a pending proposal into the page's takes fence.
 *
 * #4480 (TOCTOU): the row is CLAIMED FIRST via a CAS
 * (`status='pending' → 'accepted'` with the rowcount CHECKED), and only the
 * claim winner performs the fence write. The old order (fence write first,
 * status flip after, rowcount ignored) let two concurrent accepts both pass
 * the pending check and both append the take to the .md — the loser's no-op
 * UPDATE reported success anyway. If the fence write fails after a
 * successful claim, the claim is rolled back (best-effort compensation) so
 * a retry can act on the row.
 */
export async function acceptProposal(
  target: ProposalActionTarget,
  id: number,
  edits: ProposalEdits = {},
): Promise<{ proposal: TakeProposalRow; rowNum: number }> {
  const { engine } = target;
  const proposal = await loadProposal(engine, id, target.sourceId, { allowStranded: true });
  // Claim-first CAS: exactly one caller wins the pending row. A claim that is
  // already held without a recorded take resumes under its own request id.
  const claimed = proposal.status === 'accepted'
    ? await engine.executeRaw<{ id: number; acted_at: unknown }>(
      `SELECT id, acted_at FROM take_proposals WHERE id = $1 AND status = 'accepted' AND promoted_row_num IS NULL`, [id])
    : await engine.executeRaw<{ id: number; acted_at: unknown }>(
      `UPDATE take_proposals
          SET status = 'accepted', acted_at = now(), acted_by = $2, acted_via = $3
        WHERE id = $1 AND status = 'pending'
        RETURNING id, acted_at`,
      [id, target.actedBy ?? 'cli', target.actedVia ?? 'cli'],
    );
  if (claimed.length === 0) {
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} was acted on concurrently — only one accept/reject can win a pending row.`,
    );
  }
  const claimedAt = claimed[0]!.acted_at == null ? null : new Date(claimed[0]!.acted_at as string | Date).toISOString();
  const actedAt = claimedAt ?? 'unclaimed';
  const requestId = claimRequestId(id, actedAt);
  // The claim's durable request may already exist, under this or another
  // local writer (the journal keys requests per principal). Settle from it
  // instead of submitting a second takes_add.
  let prior = await claimRequestStates(engine, requestId);
  const inFlight = prior.find(r => r.state !== 'committed' && !SETTLED_WITHOUT_COMMIT.has(r.state));
  if (inFlight) {
    // Drive the existing request through this host's persistence owner (a
    // standalone CLI has none running) instead of submitting another.
    await waitForWrite(engine, inFlight, target.config).catch(() => undefined);
    prior = await claimRequestStates(engine, requestId);
  } else if (prior.length === 0 && proposal.status === 'accepted' && claimedAt && Date.now() - Date.parse(claimedAt) < RESUME_GRACE_MS) {
    throw new TakeProposalError('not_pending', `Proposal #${id} was just claimed by another accept that may still be submitting its take. Re-run \`gbrain takes propose --accept ${id}\` in a few minutes.`);
  }
  const committed = prior.find(r => r.state === 'committed');
  let rowNum: number;
  if (committed) {
    rowNum = Number((committed.outcome as { row_num?: unknown } | null)?.row_num);
    if (!Number.isSafeInteger(rowNum) || rowNum < 1) {
      throw new TakeProposalError('not_pending', `Proposal #${id}'s take was written (request ${requestId}) but its receipt no longer names the row; check the page's takes and record it by hand.`);
    }
  } else if (prior.some(r => !SETTLED_WITHOUT_COMMIT.has(r.state))) {
    throw new TakeProposalError('not_pending', `Proposal #${id}'s take is still being written (request ${requestId}). Re-run \`gbrain takes propose --accept ${id}\` once it settles.`);
  } else {
    try {
      // The row's OWN source, never the caller's, is what promoteProposalViaTakesAdd
      // scopes the mutation to — the scoped load above already proved they agree
      // when a caller scope was provided.
      rowNum = await promoteProposalViaTakesAdd(target, proposal, requestId, edits);
    } catch (e) {
      // Release the claim only when its write provably cannot commit: no
      // durable request was admitted, or every one settled without committing.
      // A pending, replay-conflicting or committed request keeps the claim, so
      // neither a reject nor a second accept can race it; re-running accept
      // settles from it. Compensation is bound to this exact, unpromoted claim.
      const after = await claimRequestStates(engine, requestId);
      if (after.every(r => SETTLED_WITHOUT_COMMIT.has(r.state))) {
        try {
          await engine.executeRaw(
            `UPDATE take_proposals
                SET status = 'pending', acted_at = NULL, acted_by = NULL, acted_via = NULL, promoted_row_num = NULL
              WHERE id = $1 AND status = 'accepted' AND promoted_row_num IS NULL
                AND date_trunc('milliseconds', acted_at) IS NOT DISTINCT FROM $2::timestamptz`,
            [id, claimedAt],
          );
        } catch { /* compensation is best-effort */ }
      }
      throw e;
    }
  }
  await engine.executeRaw(
    `UPDATE take_proposals SET promoted_row_num = $2 WHERE id = $1`,
    [id, rowNum],
  );
  // Outbound sinks (notify.sinks) hear about the decision; never throws.
  await emitTakeProposalEvent(engine, 'take_proposal.accepted', [id]);
  return { proposal, rowNum };
}

/** Mark a pending proposal rejected. No markdown write. #4480: rowcount is
 * CHECKED — a reject that loses a race (row already accepted/rejected) now
 * reports the truth instead of claiming a rejection it never performed. */
export async function rejectProposal(
  target: Pick<ProposalActionTarget, 'engine' | 'sourceId' | 'actedBy' | 'actedVia'>,
  id: number,
  reason?: string,
): Promise<TakeProposalRow> {
  const { engine } = target;
  const proposal = await loadProposal(engine, id, target.sourceId);
  const rejected = await engine.executeRaw<{ id: number }>(
    `UPDATE take_proposals
        SET status = 'rejected', acted_at = now(), acted_by = $2, acted_via = $3, decision_reason = $4
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [id, target.actedBy ?? 'cli', target.actedVia ?? 'cli', reason?.trim() ? reason.trim().slice(0, DECISION_REASON_MAX_CHARS) : null],
  );
  if (rejected.length === 0) {
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} was acted on concurrently — only one accept/reject can win a pending row.`,
    );
  }
  await emitTakeProposalEvent(engine, 'take_proposal.rejected', [id]);
  return proposal;
}
