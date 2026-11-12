/**
 * GST-1158 memory_propose (GBRA-284): QM's held writes, a timeline entry or a typed link it proposes for the person it
 * attests, waiting in memory_proposals (v300) for the brain owner's yes. Nothing here is page content and nothing here
 * reaches git, an export or a recall: on approval the write is admitted into the persistence journal under the
 * proposal's stored authority, in the same transaction that marks the proposal approved (the failed-writes replay seam,
 * replayAuthority), and published through the normal writer door. One request id names the proposal and the write.
 *
 * States: awaiting_owner until the owner approves (approved: a journal row now carries the write), denies (denied, with
 * the owner's reason), the TTL passes (expired), the proposer cancels (cancelled), or the approval checks refuse it
 * (failed: the person was unlinked, the attest right or grant revoked, the page gone; conflict: the page or the link
 * target changed while it waited). Every closed row is purged after the retention window.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { uuidV5 } from './preconditions.ts';
import { sha256 } from './digest.ts';
import type { Principal, SqlEngine, WriteAuthority, WriteRequest } from './model.ts';
import { principalKey } from './model.ts';

export const PROPOSAL_STATES = ['awaiting_owner', 'approved', 'denied', 'expired', 'cancelled', 'failed', 'conflict'] as const;
export type ProposalState = typeof PROPOSAL_STATES[number];
export const PROPOSAL_KINDS = ['timeline', 'link'] as const;
export type ProposalKind = typeof PROPOSAL_KINDS[number];
/** Namespace of the per-member proposal request-id namespaces. Changing it orphans every held proposal's receipt. */
export const QM_PROPOSE_REQUEST_NAMESPACE = '0c4f1d7e-93a2-4b6c-8e15-7a9d2f3b6c41';
/** The link_source every proposed link publishes with. */
export const PROPOSAL_LINK_SOURCE = 'qm-proposal';
/** How soon a proposer polls an awaiting_owner proposal (or its expiry, when sooner). */
export const PROPOSAL_RETRY_AFTER_MS = 300_000;
/** Approval checks whose refusal closes a proposal: failed (the person or the grant) and conflict (the target moved). */
const FAILED_CODES = new Set(['actor_unlinked', 'actor_not_attested', 'permission_denied', 'page_not_found', 'source_changed']);
/** Upkeep closes an awaiting proposal failed on these (permission_denied is run-scoped to ItemRun, so it is decided first); any other error is one row's. */
const UPKEEP_CLOSE_CODES = new Set(['actor_unlinked', 'actor_not_attested', 'permission_denied']);

export interface ProposalLimits {
  ttlHours: number; maxPendingPerActor: number; maxPendingPerCredential: number; retentionDays: number; maxPayloadChars: number; maxReasonChars: number;
}
/** Operator-tunable (gbrain config set proposals.<key>), each clamped to its range; the payload and reason caps only go down. */
export const PROPOSAL_LIMIT_KEYS: Record<keyof ProposalLimits, { key: string; min: number; max: number; default: number }> = {
  ttlHours: { key: 'proposals.ttl_hours', min: 1, max: 720, default: 168 },
  maxPendingPerActor: { key: 'proposals.max_pending_per_actor', min: 1, max: 1000, default: 10 },
  maxPendingPerCredential: { key: 'proposals.max_pending_per_credential', min: 1, max: 10_000, default: 50 },
  retentionDays: { key: 'proposals.retention_days', min: 1, max: 365, default: 30 },
  maxPayloadChars: { key: 'proposals.max_payload_chars', min: 100, max: 1000, default: 1000 },
  maxReasonChars: { key: 'proposals.max_reason_chars', min: 1, max: 500, default: 500 },
};

export async function readProposalLimits(engine: Pick<BrainEngine, 'getConfig'>): Promise<ProposalLimits> {
  const entries = await Promise.all(Object.entries(PROPOSAL_LIMIT_KEYS).map(async ([name, spec]) => {
    const raw = await engine.getConfig(spec.key).catch(() => null);
    const value = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    return [name, Number.isInteger(value) && value >= spec.min && value <= spec.max ? value : spec.default] as const;
  }));
  return Object.fromEntries(entries) as unknown as ProposalLimits;
}

export interface MemoryProposal {
  principal_kind: string; principal_id: string; request_id: string; system: string; external_id: string; member_id: string;
  source_id: string; source_incarnation: string; kind: ProposalKind; operation: 'add_timeline_entry' | 'add_link'; slug: string; to_slug: string | null;
  payload: Record<string, unknown> | null; payload_digest: string; expected_revision: string | null; authority: WriteAuthority; state: ProposalState;
  reason: string | null; error_code: string | null; decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string; expires_at: string;
}

const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string).toISOString();
const parsed = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
function normalize(row: Record<string, unknown>): MemoryProposal {
  return { ...row, request_id: String(row.request_id), source_incarnation: String(row.source_incarnation),
    payload: row.payload === null ? null : parsed(row.payload), authority: parsed(row.authority),
    decided_at: iso(row.decided_at), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!, expires_at: iso(row.expires_at)! } as MemoryProposal;
}

/** The request id of a proposal: uuidv5 of the key under the credential's and member's own proposal namespace, so a key never crosses credentials or members, or collides with a memory_write. */
export function proposalRequestId(principal: Principal, member: string, idempotencyKey: string): string {
  return uuidV5(uuidV5(QM_PROPOSE_REQUEST_NAMESPACE, `${principalKey(principal)}:member:${member}`), idempotencyKey);
}

/** Replay identity: only the fields the caller sent. */
export function proposalDigest(sent: Record<string, unknown>): string {
  return sha256(JSON.stringify(Object.keys(sent).sort().filter(k => sent[k] !== undefined).map(k => [k, sent[k]])));
}

export async function getProposal(engine: SqlEngine, principal: Principal, requestId: string): Promise<MemoryProposal | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT * FROM memory_proposals WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid', [principal.kind, principal.id, requestId]);
  return row ? normalize(row) : null;
}

const proposalNotFound = (requestId: string) => opError('not_found', `No memory proposal has request id ${requestId}.`,
  'List the proposals awaiting a decision with gbrain memory-proposals list, and pass one of their request ids.');

/** The proposal an owner names by request id. The namespace holds the credential, so two credentials share one only by a uuidv5 collision; that is refused, never guessed. */
export async function ownerProposal(engine: SqlEngine, requestId: string): Promise<MemoryProposal> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw proposalNotFound(requestId);
  const rows = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM memory_proposals WHERE request_id=$1::uuid LIMIT 2', [requestId]);
  if (!rows.length) throw proposalNotFound(requestId);
  if (rows.length > 1) throw opError('invalid_params', `Request id ${requestId} names proposals from two credentials.`,
    'Decide each from its credential\'s list (gbrain memory-proposals list --json shows principal_kind and principal_id).');
  return normalize(rows[0]!);
}

export const proposalClosedError = (row: Pick<MemoryProposal, 'request_id' | 'state'>) => opError('proposal_closed',
  `Proposal ${row.request_id} is ${row.state}; only a proposal awaiting the owner can be approved or denied.`,
  `Nothing changed. gbrain memory-proposals show ${row.request_id} shows how it ended; the proposer sends a new proposal if the change is still wanted.`);
export const proposalExpiredError = (row: Pick<MemoryProposal, 'request_id'>) => opError('proposal_expired',
  `Proposal ${row.request_id} expired before a decision.`,
  'Nothing was written. The proposer sends a new proposal if the change is still wanted; proposals.ttl_hours sets how long one waits.');

export interface NewProposal {
  principal: Principal; requestId: string; actor: { system: string; external_id: string; member: string }; sourceId: string; sourceIncarnation: string;
  kind: ProposalKind; operation: 'add_timeline_entry' | 'add_link'; slug: string; toSlug: string | null; payload: Record<string, unknown>; digest: string;
  expectedRevision: string | null; authority: WriteAuthority;
}

/**
 * Inserts a proposal under the caps, or returns the existing row for its request id (the caller compares digests).
 * One advisory lock per credential serializes its inserts, so concurrent calls never pass either cap; the credential's
 * overdue rows are expired first in the same transaction, so a stale row never holds a slot.
 */
export async function insertProposal(engine: BrainEngine, input: NewProposal, limits: ProposalLimits): Promise<{ row: MemoryProposal; created: boolean }> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`memory_proposals:${principalKey(input.principal)}`]);
    const [existing] = await tx.executeRaw<Record<string, unknown>>(
      'SELECT * FROM memory_proposals WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid', [input.principal.kind, input.principal.id, input.requestId]);
    if (existing) return { row: normalize(existing), created: false };
    await tx.executeRaw(`UPDATE memory_proposals SET state='expired', reason=$3, decided_by='gbrain:expiry', decided_at=now(), updated_at=now()
      WHERE principal_kind=$1 AND principal_id=$2 AND state='awaiting_owner' AND expires_at<=now()`,
      [input.principal.kind, input.principal.id, expiryReason(limits)]);
    const [counts] = await tx.executeRaw<{ actor: number | string; credential: number | string }>(`SELECT count(*) FILTER (WHERE member_id=$3) AS actor, count(*) AS credential
      FROM memory_proposals WHERE principal_kind=$1 AND principal_id=$2 AND state='awaiting_owner' AND expires_at>now()`,
      [input.principal.kind, input.principal.id, input.actor.member]);
    const actor = Number(counts?.actor ?? 0), credential = Number(counts?.credential ?? 0);
    if (actor >= limits.maxPendingPerActor) throw pendingLimit('actor', actor, limits.maxPendingPerActor);
    if (credential >= limits.maxPendingPerCredential) throw pendingLimit('credential', credential, limits.maxPendingPerCredential);
    const [row] = await tx.executeRaw<Record<string, unknown>>(`INSERT INTO memory_proposals (principal_kind, principal_id, request_id, system, external_id,
        member_id, source_id, source_incarnation, kind, operation, slug, to_slug, payload, payload_digest, expected_revision, authority, expires_at)
      VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12,$13::text::jsonb,$14,$15,$16::text::jsonb, now() + ($17::integer * interval '1 hour'))
      RETURNING *`,
      [input.principal.kind, input.principal.id, input.requestId, input.actor.system, input.actor.external_id, input.actor.member, input.sourceId,
        input.sourceIncarnation, input.kind, input.operation, input.slug, input.toSlug, JSON.stringify(input.payload), input.digest, input.expectedRevision,
        JSON.stringify(input.authority), limits.ttlHours]);
    return { row: normalize(row!), created: true };
  });
}

function pendingLimit(scope: 'actor' | 'credential', pending: number, cap: number): OperationError {
  return opError('proposals_pending_limit', `${pending} proposals already await the owner for this ${scope === 'actor' ? 'person' : 'credential'} (cap ${cap}).`,
    'Nothing was saved. Wait for the owner to decide or for a proposal to expire, or cancel one with cancel_write_request; the operator sets the cap (proposals.max_pending_per_' + (scope === 'actor' ? 'actor' : 'credential') + ').',
    { reason: scope });
}

const expiryReason = (limits: ProposalLimits) => `No owner decision within ${limits.ttlHours} hours.`;

type CloseFields = { reason: string | null; code?: string | null; decidedBy: string };

/** Closes an awaiting_owner proposal; returns the row as it is afterwards (unchanged when another decision got there first). */
async function closeProposal(engine: SqlEngine, row: MemoryProposal, state: Exclude<ProposalState, 'awaiting_owner' | 'approved'>, fields: CloseFields): Promise<MemoryProposal> {
  return (await decideClose(engine, row, state, fields)).row;
}

/** closeProposal, also saying whether this call's own conditional UPDATE made the change (decided) or another decision got there first. */
async function decideClose(engine: SqlEngine, row: MemoryProposal, state: Exclude<ProposalState, 'awaiting_owner' | 'approved'>,
  fields: CloseFields): Promise<{ row: MemoryProposal; decided: boolean }> {
  const [updated] = await engine.executeRaw<Record<string, unknown>>(`UPDATE memory_proposals SET state=$4, reason=$5, error_code=$6, decided_by=$7,
      decided_at=now(), updated_at=now() WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid AND state='awaiting_owner' RETURNING *`,
    [row.principal_kind, row.principal_id, row.request_id, state, fields.reason, fields.code ?? null, fields.decidedBy]);
  if (updated) return { row: normalize(updated), decided: true };
  return { row: (await getProposal(engine, { kind: row.principal_kind, id: row.principal_id } as Principal, row.request_id)) ?? row, decided: false };
}

async function overdue(engine: SqlEngine, row: MemoryProposal): Promise<boolean> {
  const [r] = await engine.executeRaw<{ overdue: boolean }>(`SELECT expires_at<=now() AS overdue FROM memory_proposals
    WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid`, [row.principal_kind, row.principal_id, row.request_id]);
  return r?.overdue === true;
}

/** The proposer withdraws an awaiting proposal (cancel_write_request); a closed one is returned as it is. */
export async function cancelOwnProposal(engine: SqlEngine, row: MemoryProposal): Promise<MemoryProposal> {
  if (row.state !== 'awaiting_owner') return row;
  return closeProposal(engine, row, 'cancelled', { reason: 'Cancelled by the proposer.', code: null, decidedBy: 'proposer' });
}

/**
 * The upkeep pass (consumer maintenance and the one-shot housekeeping turn): expires overdue proposals, closes awaiting
 * ones whose stored authority no longer resolves (the person unlinked or disabled, memory_propose or the grant revoked;
 * OV8: the proposer still reads and cancels them meanwhile), and purges every closed row older than the retention window.
 * Any other authority-check failure is that row's (GBRA-130, ItemRun): it stays awaiting, is counted in `failed`, and the
 * pass goes on; a run-scoped failure or a systemic run still stops it.
 */
export async function runMemoryProposalUpkeep(engine: BrainEngine, opts: { scanLimit?: number } = {}): Promise<{ expired: number; closed: number; failed: number; purged: number }> {
  const limits = await readProposalLimits(engine);
  let expired: unknown[];
  try {
    expired = await engine.executeRaw(`UPDATE memory_proposals SET state='expired', reason=$1, decided_by='gbrain:expiry', decided_at=now(), updated_at=now()
      WHERE state='awaiting_owner' AND expires_at<=now() RETURNING 1`, [expiryReason(limits)]);
  } catch (error) {
    const { isMissingSchemaObject } = await import('../utils.ts');
    if (isMissingSchemaObject(error, 'table', 'memory_proposals')) return { expired: 0, closed: 0, failed: 0, purged: 0 };
    throw error;
  }
  const { authorizeWrite } = await import('./authority.ts');
  const pending = (await engine.executeRaw<Record<string, unknown>>(`SELECT * FROM memory_proposals WHERE state='awaiting_owner'
    ORDER BY created_at LIMIT $1`, [opts.scanLimit ?? 200])).map(normalize);
  const { ItemRun } = await import('../item-failure.ts');
  const run = new ItemRun('memory_proposals.upkeep_authority');
  let closed = 0;
  for (const row of pending) {
    try { await authorizeWrite(engine, row.authority, row.operation, row.slug); } catch (error) {
      if (!(error instanceof OperationError) || !UPKEEP_CLOSE_CODES.has(error.code)) { run.fail(row.request_id, error); continue; }
      const after = await closeProposal(engine, row, 'failed', { reason: error.message, code: error.code, decidedBy: 'gbrain:upkeep' });
      if (after.state === 'failed') closed++;
    }
    run.succeed();
  }
  const purged = await engine.executeRaw(`DELETE FROM memory_proposals WHERE state<>'awaiting_owner'
    AND COALESCE(decided_at, updated_at) <= now() - ($1::integer * interval '1 day') RETURNING 1`, [limits.retentionDays]);
  return { expired: expired.length, closed, failed: run.failures.length, purged: purged.length };
}

/** What QM reads for a proposal with no journal row (get_write_request, cancel_write_request): never the proposed text. */
export function proposalReceipt(row: MemoryProposal, now = Date.now()): Record<string, unknown> {
  const waiting = row.state === 'awaiting_owner';
  const untilExpiry = Math.max(0, new Date(row.expires_at).getTime() - now);
  return {
    request_id: row.request_id, state: row.state, retry_after_ms: waiting ? Math.min(PROPOSAL_RETRY_AFTER_MS, untilExpiry) : null,
    operation: row.operation, source_id: row.source_id, slug: row.slug, created_at: row.created_at, updated_at: row.updated_at,
    proposal: { kind: row.kind, target: row.slug, ...(row.to_slug ? { to: row.to_slug } : {}), expires_at: row.expires_at },
    ...(waiting ? {} : { decision: { reason: row.reason, decided_at: row.decided_at } }),
    ...(row.error_code ? { write_error: row.error_code } : {}),
  };
}

type Prepared = { admission: import('./journal.ts').WriteAdmission } | { prior: WriteRequest } | { state: 'failed' | 'conflict'; code: string; reason: string };

/**
 * The approval checks, re-run on today's state under the proposal's stored authority: the person still linked to the
 * same enabled member with memory_propose still attested, the live grant, the page still there at the revision QM
 * showed, a link's target still there and readable by that person, and the write-through decision as the source is
 * configured now. Returns the admission to commit, or the refusal that closes the proposal.
 */
async function prepareApproval(ctx: OperationContext, row: MemoryProposal): Promise<Prepared> {
  const engine = ctx.engine;
  const authority = row.authority;
  const refusal = (error: unknown): Prepared => {
    if (!(error instanceof OperationError)) throw error;
    if (FAILED_CODES.has(error.code)) return { state: 'failed', code: error.code, reason: error.message };
    if (error.code === 'revision_conflict') return { state: 'conflict', code: 'revision_changed', reason: error.message };
    throw error;
  };
  const { parseStoredActor, storedActorIdentity, attestedCallerAccess } = await import('../access/actor.ts');
  const actor = parseStoredActor(authority.actingFor);
  if (!actor) return { state: 'failed', code: 'permission_denied', reason: 'The stored attested person is malformed.' };
  let identity: string[];
  try { identity = await storedActorIdentity(engine, authority.principal, actor, 'memory_propose'); } catch (error) { return refusal(error); }
  const { withCallerAccess } = await import('../search/private-visibility.ts');
  const access = await attestedCallerAccess(engine, actor, identity);
  return withCallerAccess(access, async (): Promise<Prepared> => {
    const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
    if (!snapshot || snapshot.page.deleted_at) return { state: 'failed', code: 'page_not_found', reason: `The target page ${row.slug} no longer exists.` };
    if (row.expected_revision && snapshot.revision !== row.expected_revision) {
      return { state: 'conflict', code: 'revision_changed', reason: `${row.slug} changed while the proposal waited; the person should see the page again before proposing.` };
    }
    if (row.kind === 'link' && row.to_slug && !await linkTargetReadable(engine, authority, row.source_id, row.to_slug)) {
      return { state: 'conflict', code: 'link_target_changed', reason: `The link target ${row.to_slug} was removed or is no longer readable by the person it was proposed for.` };
    }
    const lane: OperationContext = { ...ctx, auth: undefined, remote: authority.remote, replayAuthority: authority, attestedOp: 'memory_propose',
      takesHoldersAllowList: [...(authority.takesHolders ?? ['world'])], sourceId: row.source_id };
    try {
      const { preparePageAdmission } = await import('./page-mutations.ts');
      const params: Record<string, unknown> = { ...row.payload, request_id: row.request_id,
        ...(row.expected_revision ? { expected_revision: row.expected_revision } : {}) };
      const prepared = await preparePageAdmission(lane, { operation: row.operation, params });
      return prepared.prior ? { prior: prepared.prior } : { admission: prepared.admission! };
    } catch (error) { return refusal(error); }
  });
}

/** OV3: a proposed link's target exists in the source and the person it was proposed for may still read it. */
export async function linkTargetReadable(engine: SqlEngine & Pick<BrainEngine, 'readPageSnapshot'>, authority: WriteAuthority, sourceId: string, slug: string): Promise<boolean> {
  const target = await engine.readPageSnapshot(slug, { sourceId });
  if (!target || target.page.deleted_at) return false;
  const { authorizePageVisibility } = await import('./page-visibility.ts');
  return authorizePageVisibility(engine, authority, slug).then(() => true, () => false);
}

function publicJournal(row: WriteRequest): Record<string, unknown> {
  return { request_id: row.request_id, state: row.state, operation: row.operation, source_id: row.source_id, slug: row.slug,
    ...(row.error_code ? { write_error: row.error_code, write_error_message: row.error_message } : {}) };
}

/**
 * The owner's yes: re-runs the approval checks, then in one transaction locks the proposal, admits the write into the
 * journal under the same request id and marks the proposal approved, so neither commits without the other; then waits
 * for publication like any write. A refused check closes the proposal failed or conflict with that code. A second
 * approve after a lost reply returns the same journal receipt. `decided` is true only when this call's own conditional
 * update made the decision; once the approval commits nothing throws, so a failed wait returns the admitted receipt.
 */
export async function approveMemoryProposal(ctx: OperationContext, requestId: string, opts: { decidedBy: string; waitMs?: number }): Promise<Record<string, unknown>> {
  const engine = ctx.engine;
  const row = await ownerProposal(engine, requestId);
  const principal = { kind: row.principal_kind, id: row.principal_id } as Principal;
  const { getWriteRequest } = await import('./journal.ts');
  if (row.state === 'approved') {
    const written = await getWriteRequest(engine, principal, row.request_id);
    return { status: 'approved', decided: false, request_id: row.request_id, decided_at: row.decided_at, ...(written ? { write_request: publicJournal(written) } : {}) };
  }
  if (row.state !== 'awaiting_owner') throw proposalClosedError(row);
  if (await overdue(engine, row)) {
    if (!ctx.dryRun) await closeProposal(engine, row, 'expired', { reason: expiryReason(await readProposalLimits(engine)), decidedBy: 'gbrain:expiry' });
    throw proposalExpiredError(row);
  }
  const prepared = await prepareApproval(ctx, row);
  if ('state' in prepared) {
    if (ctx.dryRun) return { dry_run: true, action: 'approve', request_id: row.request_id, would: prepared.state, error_code: prepared.code, reason: prepared.reason };
    const closed = await decideClose(engine, row, prepared.state, { reason: prepared.reason, code: prepared.code, decidedBy: opts.decidedBy });
    if (!closed.decided) throw proposalClosedError(closed.row);
    return { status: closed.row.state, decided: true, request_id: row.request_id, error_code: closed.row.error_code, reason: closed.row.reason };
  }
  if (ctx.dryRun) return { dry_run: true, action: 'approve', request_id: row.request_id, would: 'approved' };
  const { admitWriteInTransaction } = await import('./journal.ts');
  const { declareDurablePersistence } = await import('./protocol.ts');
  const outcome = await engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    const [locked] = await tx.executeRaw<{ state: string; overdue: boolean }>(`SELECT state, expires_at<=now() AS overdue FROM memory_proposals
      WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid FOR UPDATE`, [row.principal_kind, row.principal_id, row.request_id]);
    if (!locked) throw proposalNotFound(row.request_id);
    if (locked.state !== 'awaiting_owner') return { closed: locked.state } as const;
    if (locked.overdue) return { expired: true } as const;
    const written = 'prior' in prepared ? prepared.prior : await admitWriteInTransaction(tx, prepared.admission);
    await tx.executeRaw(`UPDATE memory_proposals SET state='approved', decided_by=$4, decided_at=now(), updated_at=now()
      WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid`, [row.principal_kind, row.principal_id, row.request_id, opts.decidedBy]);
    return { written } as const;
  });
  if ('closed' in outcome) throw proposalClosedError({ request_id: row.request_id, state: outcome.closed as ProposalState });
  if ('expired' in outcome) {
    await closeProposal(engine, row, 'expired', { reason: expiryReason(await readProposalLimits(engine)), decidedBy: 'gbrain:expiry' });
    throw proposalExpiredError(row);
  }
  try {
    const { waitForWrite } = await import('./service.ts');
    const settled = await waitForWrite(engine, outcome.written, ctx.config, opts.waitMs ?? 5000);
    return { status: 'approved', decided: true, request_id: row.request_id, write_request: publicJournal(settled) };
  } catch {
    return { status: 'approved', decided: true, request_id: row.request_id, write_request: publicJournal(outcome.written) };
  }
}

/** The owner's no, with a reason (1 to proposals.max_reason_chars characters). */
export async function denyMemoryProposal(ctx: OperationContext, requestId: string, rawReason: unknown, opts: { decidedBy: string }): Promise<Record<string, unknown>> {
  const limits = await readProposalLimits(ctx.engine);
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (!reason || reason.length > limits.maxReasonChars) {
    throw opError('invalid_params', `A denial needs a reason of 1 to ${limits.maxReasonChars} characters.`, 'Pass --reason "<why>"; the proposer reads it on the receipt.');
  }
  const row = await ownerProposal(ctx.engine, requestId);
  if (row.state !== 'awaiting_owner') throw proposalClosedError(row);
  if (await overdue(ctx.engine, row)) {
    if (!ctx.dryRun) await closeProposal(ctx.engine, row, 'expired', { reason: expiryReason(limits), decidedBy: 'gbrain:expiry' });
    throw proposalExpiredError(row);
  }
  if (ctx.dryRun) return { dry_run: true, action: 'deny', request_id: row.request_id, would: 'denied' };
  const after = await decideClose(ctx.engine, row, 'denied', { reason, decidedBy: opts.decidedBy });
  if (after.row.state !== 'denied') throw proposalClosedError(after.row);
  return { status: 'denied', decided: after.decided, request_id: row.request_id, reason: after.row.reason, decided_at: after.row.decided_at };
}

/** An approve that did not publish: the checks closed the proposal, or the approved write ended without committing. */
export function approveFailed(result: Record<string, unknown>): boolean {
  if (result.dry_run) return false;
  if (result.status !== 'approved') return true;
  const state = (result.write_request as { state?: string } | undefined)?.state;
  return state === 'conflict' || state === 'failed' || state === 'cancelled';
}

/** The opaque page cursor after a listed proposal: its creation time (to the millisecond the list orders by) and request id. */
export function proposalCursor(row: Pick<MemoryProposal, 'created_at' | 'request_id'>): string {
  return Buffer.from(JSON.stringify([row.created_at, row.request_id])).toString('base64url');
}

function parseProposalCursor(cursor: string): [string, string] {
  let at: unknown, id: unknown;
  try { [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* refused below */ }
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw opError('invalid_params', 'The cursor is not one this list returned.', 'Pass next_cursor from the previous page, or omit it for the first page.');
  }
  return [at, id];
}

/** The owner's list: oldest first, 50 a page, after the upkeep pass; `after` is the previous page's proposalCursor. */
export async function listMemoryProposals(engine: BrainEngine, opts: { sourceId?: string; all?: boolean; limit?: number; after?: string } = {}): Promise<MemoryProposal[]> {
  const [afterAt, afterId] = opts.after === undefined ? [null, null] : parseProposalCursor(opts.after);
  await runMemoryProposalUpkeep(engine);
  const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT * FROM memory_proposals WHERE ($1::text IS NULL OR source_id=$1)
    AND ($2::boolean OR state='awaiting_owner')
    AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), request_id) > ($4::timestamptz, $5::uuid))
    ORDER BY date_trunc('milliseconds', created_at), request_id LIMIT $3`,
    [opts.sourceId ?? null, opts.all === true, Math.max(1, Math.min(500, opts.limit ?? 50)), afterAt, afterId]);
  return rows.map(normalize);
}

/** Pending count and the oldest pending proposal's age, for doctor and status; zero on a schema that predates v300. */
export async function pendingProposalSummary(engine: SqlEngine): Promise<{ pending: number; oldest_hours: number | null }> {
  try {
    const [row] = await engine.executeRaw<{ n: number | string; oldest: number | string | null }>(`SELECT count(*) AS n,
      EXTRACT(EPOCH FROM now() - min(created_at)) / 3600 AS oldest FROM memory_proposals WHERE state='awaiting_owner' AND expires_at>now()`);
    const pending = Number(row?.n ?? 0);
    return { pending, oldest_hours: pending && row?.oldest !== null && row?.oldest !== undefined ? Math.floor(Number(row.oldest)) : null };
  } catch (error) {
    const { isMissingSchemaObject } = await import('../utils.ts');
    if (isMissingSchemaObject(error, 'table', 'memory_proposals')) return { pending: 0, oldest_hours: null };
    throw error;
  }
}
