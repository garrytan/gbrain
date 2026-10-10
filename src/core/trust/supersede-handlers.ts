/**
 * Guarded supersession (#5575 A5/I3, ENG-4): a write whose tier is lower than
 * the fact or take it would supersede (or forget) does not change it. The new
 * row is inserted active and contested, and a `trust_proposals` row links the
 * higher-tier target to it; the owner's accept applies the supersession
 * through the checked decide_proposals primitives (facts/proposal-supersede.ts,
 * managed and unmanaged paths) and confirms the new row (CEO-9). Writers make
 * the decision in prepare and re-check it in validate(tx) under lock.
 *
 * before_state records the guard: `{ guard, old: {id, tier}, new: {id, tier} }`
 * (ids and tiers only, never claim text). The checked supersede's own
 * before/after record lives in after_state.supersede.
 */
import type { BrainEngine } from '../engine.ts';
import {
  applyProposalAction, type PairProposal, type PairProposalStore, type ProposalActionResult,
} from '../facts/proposal-supersede.ts';
import { currentWriteTrust, withTrustPromotion, withWriteAttribution } from '../persistence/context.ts';
import { normalizeDimension } from '../chronicle/ontology.ts';
import { verbError, type OperationError } from '../ops/contract.ts';
import type { Principal } from '../persistence/model.ts';
import {
  decisionResult, getTrustProposal, insertTrustProposal, pendingTrustProposalsFor, registerTrustProposalHandler, transitionTrustProposal, trustProposalRef,
  type TrustDecision, type TrustDecisionContext, type TrustProposalAction, type TrustProposalRow,
} from './proposals.ts';
import { tierRaiseFix } from './confirm.ts';
import { queueTierProjection } from './page-write.ts';
import { compareTrust, effectiveWriteTrust, storedTrustTier, trustRankSql, type TrustTier, type WriteTrust } from './tier.ts';

/** I3: a write at `writer` may supersede, expire or forget a row at `target` only when it is at least as trusted. */
export function supersessionGuarded(writer: TrustTier | null | undefined, target: unknown): boolean {
  return compareTrust(writer ?? 'unknown', storedTrustTier(target)) < 0;
}

/** Word tokens for the keyless conflict slot: NFKC, lowercase, letters and digits only. */
function slotTokens(text: string): Set<string> {
  return new Set(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean));
}
/** The keyless conflict-slot threshold: shared words over all words (Jaccard) of two claims about one entity. */
export const LEXICAL_SLOT_THRESHOLD = 0.5;

/**
 * 38-3: the conflict slot on a brain without fact vectors. The most similar
 * active fact about the same entity, kind and visibility that is MORE trusted
 * than the writer, when the two claims share at least half their words and
 * differ (an exact match is a duplicate, handled first). It only contests
 * (files a proposal); without a vector the slot never supersedes. Deterministic,
 * zero model calls.
 */
export async function lexicalContestCandidate(engine: BrainEngine, sourceId: string,
  input: { fact: string; kind: string; visibility: string; entity_slug: string | null }, writer: TrustTier): Promise<{ id: number; trust_tier: TrustTier } | null> {
  if (!input.entity_slug) return null;
  const rows = await engine.executeRaw<{ id: number; fact: string; trust_tier: string }>(
    `SELECT id, fact, trust_tier FROM facts WHERE source_id = $1 AND entity_slug = $2 AND kind = $3 AND visibility = $4
       AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND ${trustRankSql('trust_tier')} > ${trustRankSql('$5::text')}
     ORDER BY id DESC LIMIT 200`, [sourceId, input.entity_slug, input.kind, input.visibility, writer]);
  const mine = slotTokens(input.fact);
  let best: { id: number; trust_tier: TrustTier; score: number } | null = null;
  for (const row of rows) {
    const theirs = slotTokens(row.fact);
    const shared = [...mine].filter(t => theirs.has(t)).length;
    const score = shared / (mine.size + theirs.size - shared || 1);
    if (score >= LEXICAL_SLOT_THRESHOLD && score < 1 && (!best || score > best.score)) best = { id: Number(row.id), trust_tier: storedTrustTier(row.trust_tier), score };
  }
  return best ? { id: best.id, trust_tier: best.trust_tier } : null;
}

/** The pending supersede_fact proposal for a contested write, inside its publication transaction. */
export async function recordContestedFact(tx: BrainEngine, input: { sourceId: string; oldId: number; oldTier: TrustTier; newId: number; newTier: TrustTier; guard: string }): Promise<{ proposal_ref: string }> {
  const { id } = await insertTrustProposal(tx, {
    action: 'supersede_fact', sourceId: input.sourceId, target: { table: 'facts', id: input.oldId }, related: { table: 'facts', id: input.newId },
    proposer: input.guard, before: { guard: input.guard, old: { id: input.oldId, tier: input.oldTier }, new: { id: input.newId, tier: input.newTier } },
  });
  return { proposal_ref: trustProposalRef(id) };
}

/** The pending supersede_take proposal for a contested take write. */
export async function recordContestedTake(tx: BrainEngine, input: { sourceId: string; oldId: number; oldTier: TrustTier; newId: number; newTier: TrustTier; guard: string }): Promise<{ proposal_ref: string }> {
  const { id } = await insertTrustProposal(tx, {
    action: 'supersede_take', sourceId: input.sourceId, target: { table: 'takes', id: input.oldId }, related: { table: 'takes', id: input.newId },
    proposer: input.guard, before: { guard: input.guard, old: { id: input.oldId, tier: input.oldTier }, new: { id: input.newId, tier: input.newTier } },
  });
  return { proposal_ref: trustProposalRef(id) };
}

/**
 * A remote `forget` of a higher-tier fact (DX-1): files a `forget` proposal in
 * its own transaction (attributed to the caller) and returns the verb error
 * `forget_requires_owner` carrying its ref. The frozen `forget.expired`
 * meaning is untouched: nothing was expired. A retry reuses the same proposal.
 */
export async function forgetRequiresOwner(engine: BrainEngine, input: { sourceId: string; factId: number; factTier: TrustTier; writerTier: TrustTier; principal: Principal; reason: string | null }): Promise<OperationError> {
  const { id } = await engine.transaction(tx => withWriteAttribution(tx, { requestId: null, principal: input.principal }, () => insertTrustProposal(tx, {
    action: 'forget', sourceId: input.sourceId, target: { table: 'facts', id: input.factId }, proposer: 'remote_forget',
    before: { guard: 'remote_forget', fact: { id: input.factId, tier: input.factTier }, writer_tier: input.writerTier, ...(input.reason ? { has_reason: true } : {}) },
  })));
  const ref = trustProposalRef(id);
  // Frozen MEMORY_VERBS v1 pair: `error` stays scope_denied, `code` is the canonical forget_requires_owner.
  const error = verbError('scope_denied',
    `forget_requires_owner: fact #${input.factId} is ${input.factTier}; an agent cannot forget it. Proposal ${ref} asks the owner.`,
    `Do not retry. Tell the user fact #${input.factId} needs their decision: they can forget it with gbrain trust confirm ${ref} on the brain host.`,
    JSON.stringify({ proposal_ref: ref, fact_id: String(input.factId) }));
  error.canonical = 'forget_requires_owner';
  error.fix = tierRaiseFix(['gbrain', 'trust', 'confirm', ref],
    'Forgetting a fact the owner confirmed or curated is their decision; the confirm prompt applies the forget.',
    `Run on the brain host, in a terminal: gbrain trust confirm ${ref}`);
  return error;
}

/** Pre-admission check for a remote forget: a guarded target becomes a `forget` proposal and the verb error. */
export async function guardRemoteForget(engine: BrainEngine, input: { sourceId: string; factId: number; principal: Principal; reason: string | null }): Promise<void> {
  const [fact] = await engine.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM facts WHERE id = $1 AND source_id = $2 AND visibility = 'world'`, [input.factId, input.sourceId]);
  if (!fact || !supersessionGuarded('agent_written', fact.trust_tier)) return;
  throw await forgetRequiresOwner(engine, { ...input, factTier: storedTrustTier(fact.trust_tier), writerTier: 'agent_written' });
}

/** The target's tier rose between the pre-check and the locked read: refuse without changing anything; a retry files the proposal. */
export function remoteForgetRaced(factId: number): OperationError {
  const error = verbError('scope_denied', `forget_requires_owner: fact #${factId} became more trusted while this forget was prepared; nothing was forgotten.`,
    'Retry once to file the owner proposal, then tell the user it needs their decision.');
  error.canonical = 'forget_requires_owner';
  return error;
}

/** The declared tier of an `ontology_propose` observation: an agent write (remote or local CLI). */
export function ontologyWriteTrust(ctx: { remote?: boolean }): WriteTrust {
  return effectiveWriteTrust({ channel: 'agent_written', origin: { channel: `${ctx.remote === false ? 'cli' : 'mcp'}:ontology_propose` } });
}

/**
 * After mergeOntologyFact inserted a new stint without closing the current one
 * (the engines' ONTOLOGY_SUPERSEDE_GUARD refused because it is more trusted),
 * files the supersede_fact proposal and returns the additive `contested` field.
 */
export async function contestOntologySupersession(tx: BrainEngine, sourceId: string, entitySlug: string, dimension: string,
  result: { action: string; factId: number | null }): Promise<{ contested?: { proposal_ref: string } }> {
  if (result.action !== 'inserted' || result.factId === null) return {};
  const writer = (await currentWriteTrust(tx))?.tier ?? 'unknown';
  const [current] = await tx.executeRaw<{ id: number; trust_tier: string }>(
    `SELECT id, trust_tier FROM facts WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND id <> $4
       AND expired_at IS NULL AND valid_until IS NULL AND (dim_status IS NULL OR dim_status = 'active')
     ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC LIMIT 1`, [sourceId, entitySlug, normalizeDimension(dimension), result.factId]);
  if (!current || !supersessionGuarded(writer, current.trust_tier)) return {};
  return { contested: await recordContestedFact(tx, { sourceId, oldId: Number(current.id), oldTier: storedTrustTier(current.trust_tier),
    newId: result.factId, newTier: writer, guard: 'ontology' }) };
}

// ---------------------------------------------------------------------------
// trust_proposals as a checked-supersede store
// ---------------------------------------------------------------------------

/** decide_proposals says `stale` where trust_proposals says `superseded` (the proposal no longer applies). */
const toPair = (status: string) => (status === 'superseded' ? 'stale' : status);
const fromPair = (status: string) => (status === 'stale' ? 'superseded' : status);

function pairOf(row: TrustProposalRow): PairProposal | null {
  if ((row.action !== 'supersede_fact') || row.related_id === null) return null;
  const supersede = row.after_state.supersede as { before?: unknown; after?: unknown } | undefined;
  return {
    id: row.id, source_id: row.source_id, old_fact_id: row.target_id, new_fact_id: row.related_id, status: toPair(row.status) as PairProposal['status'],
    before_state: supersede?.before ? JSON.stringify(supersede.before) : null, after_state: supersede?.after ? JSON.stringify(supersede.after) : null,
  };
}

export const TRUST_PAIR_STORE: PairProposalStore = {
  name: 'trust',
  async get(engine, id, lock) {
    const row = await getTrustProposal(engine, id, lock);
    return row ? pairOf(row) : null;
  },
  async transition(engine, id, from, to, state) {
    const row = await getTrustProposal(engine, id, true);
    if (!row) return false;
    const after = state?.before || state?.after
      ? { ...row.after_state, supersede: { before: state.before ? JSON.parse(state.before) : null, after: state.after ? JSON.parse(state.after) : null } }
      : undefined;
    return transitionTrustProposal(engine, id, fromPair(from) as TrustProposalRow['status'], fromPair(to) as TrustProposalRow['status'], after ? { after } : {});
  },
  /** CEO-9: the owner's accept also confirms the new fact. */
  async onAccept(tx, proposal) {
    await withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(
      `UPDATE facts SET trust_tier = 'user_confirmed' WHERE id = $1 AND source_id = $2`, [proposal.new_fact_id, proposal.source_id]));
    for (const id of [proposal.old_fact_id, proposal.new_fact_id]) await queueTierProjection(tx, 'facts', id);
  },
  /** Undo returns the new fact to the tier it had before the accept confirmed it (lowering needs no promotion). */
  async onUndo(tx, proposal) {
    const row = await getTrustProposal(tx, proposal.id);
    const prior = storedTrustTier((row?.before_state.new as { tier?: unknown } | undefined)?.tier);
    await tx.executeRaw(`UPDATE facts SET trust_tier = $3 WHERE id = $1 AND source_id = $2`, [proposal.new_fact_id, proposal.source_id, prior]);
    for (const id of [proposal.old_fact_id, proposal.new_fact_id]) await queueTierProjection(tx, 'facts', id);
  },
};

/**
 * The same proposal read reversed (38-4): the owner confirmed the OLD side of a
 * contested pair, so the contested new row is superseded by it. Accepting this
 * view closes the proposal as `rejected` (the lower-tier write lost) and
 * confirms the old row.
 */
export const TRUST_REVERSE_PAIR_STORE: PairProposalStore = {
  name: 'trust_reverse',
  async get(engine, id, lock) {
    const pair = await TRUST_PAIR_STORE.get(engine, id, lock);
    return pair ? { ...pair, old_fact_id: pair.new_fact_id, new_fact_id: pair.old_fact_id } : null;
  },
  transition: (engine, id, from, to, state) => TRUST_PAIR_STORE.transition(engine, id, from, to === 'accepted' ? 'rejected' : to, state),
  onAccept: (tx, proposal) => TRUST_PAIR_STORE.onAccept!(tx, proposal),
};

/**
 * CEO-9 + A5 (38-4): confirming either side of a contested fact resolves its
 * pending supersede_fact proposal through the checked supersede, so one value
 * stays current: confirming the contested (new) row accepts the proposal;
 * confirming the higher-tier (old) row supersedes the contested one. Null when
 * the fact has no pending supersede_fact proposal.
 */
export async function resolveContestedFactOnConfirm(engine: BrainEngine, factId: number, ctx: TrustDecisionContext): Promise<{ ref: string; status: string; reason?: string } | null> {
  const pending = (await pendingTrustProposalsFor(engine, 'facts', factId)).find(p => p.action === 'supersede_fact');
  if (!pending) return null;
  const store = pending.related_id === factId ? TRUST_PAIR_STORE : TRUST_REVERSE_PAIR_STORE;
  const result = await applyProposalAction(engine, pending.id, 'accept', ctx.config, store);
  return { ref: trustProposalRef(pending.id), status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
}

function fromPairResult(proposal: TrustProposalRow, decision: TrustDecision, result: ProposalActionResult) {
  const status = result.status === 'stale' ? 'superseded' : result.status;
  return decisionResult(proposal, decision, status as never, result.reason ? { reason: result.reason } : {});
}

/** The actions this module registers handlers for. */
export const SUPERSEDE_HANDLER_ACTIONS: readonly TrustProposalAction[] = ['supersede_fact', 'supersede_take', 'forget'];

registerTrustProposalHandler('supersede_fact', {
  async accept(engine, proposal, ctx: TrustDecisionContext) {
    return fromPairResult(proposal, 'accept', await applyProposalAction(engine, proposal.id, 'accept', ctx.config, TRUST_PAIR_STORE));
  },
  async undo(engine, proposal, ctx: TrustDecisionContext) {
    return fromPairResult(proposal, 'undo', await applyProposalAction(engine, proposal.id, 'undo', ctx.config, TRUST_PAIR_STORE));
  },
});

/**
 * supersede_take accept: the owner's confirmed decision rides a journaled local
 * `takes_supersede` whose intent carries the proposal id and a one-time nonce
 * the handler stored on the proposal; takes-prepare applies it only when both
 * match a pending proposal for that exact pair (ownerAcceptedTake), striking
 * the old row toward the contested row instead of adding a new one.
 */
export async function ownerAcceptedTake(engine: BrainEngine, row: { authority: { remote: boolean }; intent: Record<string, unknown> | null },
  oldTakeId: number, pageId: number): Promise<{ id: number; newId: number; newRow: number } | null> {
  const id = Number(row.intent?.trust_accept);
  const nonce = row.intent?.trust_accept_nonce;
  if (row.authority.remote !== false || !Number.isSafeInteger(id) || typeof nonce !== 'string') return null;
  const proposal = await getTrustProposal(engine, id);
  if (!proposal || proposal.status !== 'pending' || proposal.action !== 'supersede_take' || proposal.target_id !== oldTakeId
    || proposal.related_id === null || proposal.after_state.accept_nonce !== nonce) return null;
  const [contested] = await engine.executeRaw<{ row_num: number }>('SELECT row_num FROM takes WHERE id = $1 AND page_id = $2 AND active', [proposal.related_id, pageId]);
  return contested ? { id, newId: proposal.related_id, newRow: Number(contested.row_num) } : null;
}

/** Inside the publication: the proposal closes and the contested take becomes the owner's confirmed take. */
export async function finishOwnerAcceptedTake(tx: BrainEngine, accepted: { id: number; newId: number }): Promise<void> {
  if (!await transitionTrustProposal(tx, accepted.id, 'pending', 'accepted')) throw new Error(`trust proposal tp${accepted.id} is no longer pending`);
  await withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE takes SET trust_tier = 'user_confirmed' WHERE id = $1`, [accepted.newId]));
  await queueTierProjection(tx, 'takes', accepted.newId);
}

registerTrustProposalHandler('supersede_take', {
  async accept(engine, proposal, ctx: TrustDecisionContext) {
    const [old] = await engine.executeRaw<{ row_num: number; slug: string; source_id: string }>(
      'SELECT t.row_num, p.slug, p.source_id FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1', [proposal.target_id]);
    const [fresh] = await engine.executeRaw<{ claim: string }>('SELECT claim FROM takes WHERE id = $1', [proposal.related_id]);
    if (!old || !fresh) return decisionResult(proposal, 'accept', 'superseded', { reason: 'take_missing' });
    const nonce = crypto.randomUUID();
    await engine.executeRaw(`UPDATE trust_proposals SET after_state = after_state || jsonb_build_object('accept_nonce', $2::text) WHERE id = $1 AND status = 'pending'`, [proposal.id, nonce]);
    const { submitPageMutation } = await import('../persistence/page-mutations.ts');
    const local = { engine, sourceId: old.source_id, remote: false as const, dryRun: false,
      config: ctx.config ?? ({ engine: engine.kind } as never), logger: { info() {}, warn() {}, error() {} } };
    await submitPageMutation(local as never, { operation: 'takes_supersede', params: { slug: old.slug, source_id: old.source_id, row_num: Number(old.row_num),
      claim: fresh.claim, trust_accept: proposal.id, trust_accept_nonce: nonce, request_id: crypto.randomUUID() } });
    const after = await getTrustProposal(engine, proposal.id);
    return after?.status === 'accepted' ? decisionResult(proposal, 'accept', 'accepted')
      : decisionResult(proposal, 'accept', 'refused', { reason: after?.status ?? 'not_found' });
  },
});

/** The owner applies the forget a remote caller asked for, as a trusted local forget. */
registerTrustProposalHandler('forget', {
  async accept(engine, proposal, ctx: TrustDecisionContext) {
    const { submitForgetMutation } = await import('../persistence/memory-mutations.ts');
    const local = { engine, sourceId: proposal.source_id, remote: false as const, dryRun: false,
      config: ctx.config ?? ({ engine: engine.kind } as never), logger: { info() {}, warn() {}, error() {} } };
    const outcome = await submitForgetMutation(local as never, 'forget', { id: String(proposal.target_id), request_id: crypto.randomUUID(),
      reason: `owner accepted ${trustProposalRef(proposal.id)}` });
    if (!await transitionTrustProposal(engine, proposal.id, 'pending', 'accepted', { decidedBy: ctx.decidedBy, after: { forget: { expired: (outcome as { expired?: unknown }).expired ?? null } } })) {
      return decisionResult(proposal, 'accept', 'refused', { reason: (await getTrustProposal(engine, proposal.id))?.status ?? 'not_found' });
    }
    return decisionResult(proposal, 'accept', 'accepted', { detail: { fact_id: String(proposal.target_id) } });
  },
});
