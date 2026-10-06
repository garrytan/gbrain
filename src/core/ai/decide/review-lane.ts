/**
 * The ambiguous-band review lane: model-judged, owner-accepted review of pairs
 * a cosine threshold cannot settle. Kinds:
 *
 *   withdraw          an active fact that may restate a withdrawn (forgotten)
 *                     claim; accepting withdraws it the same way `forget` does.
 *   duplicate_page    two pages that may describe the same thing (candidates
 *                     enqueued by the page-duplicate detector).
 *   duplicate_entity  two entity pages left ambiguous by deterministic entity
 *                     dedup (candidates enqueued by entity resolution).
 *
 * Rides the `conflict` slot's provider, egress and spend controls, with one
 * call site per kind (`review_<kind>`) so each kind has its own calibration
 * and qualification. A kind proposes only when its calibration is qualified
 * for action precision (decide.slots.conflict.min_action_precision); without
 * that it does not call the provider at all. Never applies anything itself:
 * outcomes are pending rows in decide_review_proposals, reviewed with
 * `gbrain decide proposals`. Work is durable in decide_review_queue, written in
 * the same transaction as the event that created it (a withdrawal, or the
 * owning subsystem's enqueue), so nothing is skipped by a timestamp cursor.
 */
import { randomBytes } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { loadConfigSnapshot } from '../../config-snapshot.ts';
import { readDecideConfig, type DecideConfig } from './config.ts';
import { CONFLICT_INSTRUCTIONS, CONFLICT_MIN_COSINE, CONFLICT_NEIGHBOURS, CONFLICT_OPTIONS } from './conflict.ts';
import { hasTypesafeKey, runDecide } from './index.ts';
import { packShape } from './pack.ts';
import { resolveSlotPolicy, type SlotPolicy } from './policy.ts';
import { writeReceipts } from './receipts.ts';
import { reviewWithdrawOn } from '../../facts/withdrawal.ts';
import { flushDecideWrites, hmacRef, listCalibrations, receiptSalt, recentResolvedModels } from './store.ts';
import { DecideError, type ChoiceAnswer, type DecideQuestion, type EvidenceItem } from './types.ts';

export const REVIEW_KINDS = ['withdraw', 'duplicate_page', 'duplicate_entity'] as const;
export type ReviewKind = typeof REVIEW_KINDS[number];

export const REVIEW_CALL_SITES: Readonly<Record<ReviewKind, string>> = {
  withdraw: 'review_withdraw', duplicate_page: 'review_duplicate_page', duplicate_entity: 'review_duplicate_entity',
};
export const REVIEW_CONFIG_KEYS: Readonly<Record<ReviewKind, string>> = {
  withdraw: 'decide.slots.conflict.review_withdraw',
  duplicate_page: 'decide.slots.conflict.review_duplicate_page',
  duplicate_entity: 'decide.slots.conflict.review_duplicate_entity',
};
/** Anchors (or pairs) judged per kind per run, so one kind never starves another. */
export const REVIEW_BUDGET_PER_RUN = 50;
const REVIEW_MAX_ATTEMPTS = 5;
const REVIEW_REQUEST_DEADLINE_MS = 30_000;
const PAGE_TEXT_LIMIT = 2_000;
const PERMANENT_FAILURES = new Set(['egress', 'payload_too_large']);
export const REVIEW_QUESTION_VERSION = 1;

const SAME_OPTIONS: Readonly<Record<'same' | 'different', string>> = {
  same: '`page` and `candidate` describe the same real-world person, company, place, project or idea',
  different: '`page` and `candidate` describe different things, even if related',
};
const SAME_INSTRUCTIONS = 'Do `page` and `candidate` describe the same thing?';

export interface ReviewLaneResult {
  kind: ReviewKind;
  source_id: string;
  sweep_id: string;
  effective: 'on' | 'shadow' | 'off';
  inactive?: string;
  anchors: number;
  pairs: number;
  proposals: number;
  shadow_proposals: number;
  independents: number;
  skipped: number;
  deferred: number;
  stopped?: string;
}

const truthy = (v: string | undefined | null) => ['true', 'on', '1', 'yes'].includes((v ?? '').trim().toLowerCase());

/** `withdraw` is on unless turned off (held-out qualification passed); the duplicate kinds stay opt-in. */
export function reviewKindEnabled(snapshot: Record<string, string | undefined> | null, kind: ReviewKind): boolean {
  const raw = snapshot?.[REVIEW_CONFIG_KEYS[kind]];
  return kind === 'withdraw' ? reviewWithdrawOn(raw) : truthy(raw);
}

// ---------------------------------------------------------------------------
// Enqueue API (other subsystems) and accept-handler registry
// ---------------------------------------------------------------------------

export interface ReviewCandidate {
  kind: Exclude<ReviewKind, 'withdraw'>;
  source_id: string;
  /** Page slugs within `source_id`. */
  a_ref: string;
  b_ref: string;
  /** Why the pair was flagged (e.g. `cosine 0.86`); stored, never sent to a provider. */
  evidence?: string;
}

/** Queue a candidate pair for review; call inside the transaction that discovered it. Idempotent per pair. */
export async function enqueueReviewCandidate(tx: BrainEngine, c: ReviewCandidate): Promise<void> {
  const [a, b] = c.a_ref <= c.b_ref ? [c.a_ref, c.b_ref] : [c.b_ref, c.a_ref];
  await tx.executeRaw(`INSERT INTO decide_review_queue(kind,source_id,a_ref,b_ref,evidence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [c.kind, c.source_id, a, b, c.evidence ?? null]);
}

export interface ReviewProposalRow {
  id: number;
  kind: ReviewKind;
  source_id: string;
  sweep_id: string;
  a_ref: string;
  b_ref: string;
  subject: string;
  visibility: string | null;
  p_action: number;
  threshold: number | null;
  model_resolved: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  receipt: string | null;
}

/** What accepting a duplicate-kind proposal does; registered by the subsystem that owns the merge or link. Must be idempotent: a crashed accept resumes by calling it again. */
export type ReviewAcceptHandler = (engine: BrainEngine, proposal: ReviewProposalRow) => Promise<{ status: 'accepted' | 'stale'; detail?: string }>;
const acceptHandlers = new Map<ReviewKind, ReviewAcceptHandler>();
export function registerReviewAcceptHandler(kind: Exclude<ReviewKind, 'withdraw'>, handler: ReviewAcceptHandler): void {
  acceptHandlers.set(kind, handler);
}
export function reviewAcceptHandler(kind: ReviewKind): ReviewAcceptHandler | undefined { return acceptHandlers.get(kind); }

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface QueueRow { kind: ReviewKind; source_id: string; a_ref: string; b_ref: string; attempts: number }

async function dueQueue(engine: BrainEngine, kind: ReviewKind, sourceId: string, limit: number): Promise<QueueRow[]> {
  const rows = await engine.executeRaw<QueueRow>(
    `SELECT kind, source_id, a_ref, b_ref, attempts FROM decide_review_queue
      WHERE kind = $1 AND source_id = $2 AND attempts < $3 AND next_attempt_at <= now()
      ORDER BY next_attempt_at, created_at, a_ref, b_ref LIMIT $4`, [kind, sourceId, REVIEW_MAX_ATTEMPTS, limit]);
  return rows.map(r => ({ ...r, attempts: Number(r.attempts) }));
}

async function clearQueue(engine: BrainEngine, row: QueueRow): Promise<void> {
  await engine.executeRaw('DELETE FROM decide_review_queue WHERE kind=$1 AND source_id=$2 AND a_ref=$3 AND b_ref=$4', [row.kind, row.source_id, row.a_ref, row.b_ref]);
}

async function deferQueue(engine: BrainEngine, row: QueueRow, reason: string): Promise<void> {
  await engine.executeRaw(`UPDATE decide_review_queue SET attempts = attempts + 1, reason = $5,
      next_attempt_at = now() + ((attempts + 1) * interval '10 minutes')
    WHERE kind=$1 AND source_id=$2 AND a_ref=$3 AND b_ref=$4`, [row.kind, row.source_id, row.a_ref, row.b_ref, reason]);
}

/**
 * A fact the conflict sweep just processed may restate a claim already withdrawn
 * for its entity: re-queue up to two such withdrawn anchors so the next lane run
 * compares them against their current neighbours (pair dedup skips old pairs).
 */
export async function requeueWithdrawnAnchorsNear(engine: BrainEngine, sourceId: string, factId: number): Promise<number> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `SELECT c.id FROM facts n JOIN facts c
        ON c.source_id = n.source_id AND c.entity_slug = n.entity_slug AND c.visibility = n.visibility AND c.id <> n.id
      WHERE n.id = $1 AND n.source_id = $2 AND c.expired_at IS NOT NULL
        AND c.embedding IS NOT NULL AND n.embedding IS NOT NULL AND c.embedding_model = n.embedding_model
        AND (1 - (c.embedding <=> n.embedding)) >= $3
        AND EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = c.source_id AND w.visibility = c.visibility
          AND w.fact_hash IN (gbrain_fact_fingerprint(c.fact), gbrain_fact_fingerprint_v1(c.fact))
          AND (w.subject = '*' OR w.subject = c.entity_slug))
      ORDER BY c.embedding <=> n.embedding, c.id LIMIT 2`, [factId, sourceId, CONFLICT_MIN_COSINE]);
  for (const r of rows) {
    await engine.executeRaw(`INSERT INTO decide_review_queue(kind,source_id,a_ref) VALUES ('withdraw',$1,$2)
      ON CONFLICT (kind, source_id, a_ref, b_ref) DO UPDATE SET next_attempt_at = LEAST(decide_review_queue.next_attempt_at, now())`, [sourceId, String(r.id)]);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

interface Pair {
  /** Plain subject identity (hashed into the receipt). */
  subject: string;
  b_ref: string;
  candidate: EvidenceItem;
  candidateHash?: string;
}

interface Anchor {
  a_ref: string;
  subject: string;
  visibility: string | null;
  state: Record<string, EvidenceItem>;
  pairs: Pair[];
}

/** P(action) for one answer: P(duplicate) for withdraw, P(same) for duplicate kinds. */
export function reviewActionProbability(kind: ReviewKind, answer: ChoiceAnswer): number {
  const key = kind === 'withdraw' ? 'duplicate' : 'same';
  return answer.probabilities[key] ?? (answer.choice === key ? answer.confidence : 0);
}

function question(kind: ReviewKind, id: string, rank: number, candidate: EvidenceItem): DecideQuestion {
  return kind === 'withdraw'
    ? { id, kind: 'choice', rank, instructions: CONFLICT_INSTRUCTIONS, options: { ...CONFLICT_OPTIONS }, inputs: { candidate } }
    : { id, kind: 'choice', rank, instructions: SAME_INSTRUCTIONS, options: { ...SAME_OPTIONS }, inputs: { candidate } };
}

async function withdrawAnchor(engine: BrainEngine, row: QueueRow, cfg: DecideConfig): Promise<Anchor | { skip: string }> {
  const anchorId = Number(row.a_ref);
  if (!Number.isSafeInteger(anchorId)) return { skip: 'no_candidates' };
  const [anchor] = await engine.executeRaw<{ id: number; fact: string; entity_slug: string | null; visibility: 'private' | 'world'; has_embedding: boolean; withdrawn: boolean }>(
    `SELECT f.id, f.fact, f.entity_slug, f.visibility, f.embedding IS NOT NULL AS has_embedding,
            EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
              AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
              AND (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*'))) AS withdrawn
       FROM facts f WHERE f.id = $1 AND f.source_id = $2`, [anchorId, row.source_id]);
  if (!anchor || !anchor.withdrawn) return { skip: 'no_candidates' };
  if (!anchor.has_embedding) return { skip: 'no_embedding' };
  // A forgotten private claim is sent only when the owner explicitly allows private egress (not by key default).
  if (anchor.visibility === 'private' && cfg.egressPrivate !== 'allow') return { skip: 'egress_private_denied' };
  const rows = await engine.executeRaw<{ id: number | string; fact: string; visibility: 'private' | 'world'; text_hash: string }>(
    `SELECT c.id, c.fact, c.visibility, md5(c.fact) AS text_hash
       FROM facts n JOIN facts c
         ON c.source_id = n.source_id AND c.entity_slug IS NOT DISTINCT FROM n.entity_slug AND c.visibility = n.visibility AND c.id <> n.id
      WHERE n.id = $1 AND n.source_id = $2
        AND c.expired_at IS NULL AND (c.valid_until IS NULL OR c.valid_until > now())
        AND c.embedding IS NOT NULL AND c.embedding_model = n.embedding_model
        AND gbrain_fact_fingerprint(c.fact) <> gbrain_fact_fingerprint(n.fact)
        AND (1 - (c.embedding <=> n.embedding)) >= $3
      ORDER BY c.embedding <=> n.embedding, c.id LIMIT $4`, [anchorId, row.source_id, CONFLICT_MIN_COSINE, CONFLICT_NEIGHBOURS]);
  const subject = anchor.entity_slug ?? '*';
  return {
    a_ref: row.a_ref, subject, visibility: anchor.visibility,
    state: { fact: { text: anchor.fact, class: 'facts', fact_id: anchor.id, source_id: row.source_id, visibility: anchor.visibility } },
    pairs: rows.map(c => ({
      subject: `review:withdraw:${row.source_id}:${anchorId}:${Number(c.id)}`, b_ref: String(Number(c.id)), candidateHash: c.text_hash,
      candidate: { text: c.fact, class: 'facts', fact_id: Number(c.id), source_id: row.source_id, visibility: c.visibility },
    })),
  };
}

async function pagePairAnchor(engine: BrainEngine, row: QueueRow): Promise<Anchor | { skip: string }> {
  const pages = await engine.executeRaw<{ slug: string; title: string; compiled_truth: string }>(
    `SELECT slug, title, compiled_truth FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`,
    [row.source_id, [row.a_ref, row.b_ref]]);
  const a = pages.find(p => p.slug === row.a_ref);
  const b = pages.find(p => p.slug === row.b_ref);
  if (!a || !b) return { skip: 'no_candidates' };
  const text = (p: { title: string; compiled_truth: string }) => `${p.title}\n\n${p.compiled_truth}`.slice(0, PAGE_TEXT_LIMIT);
  return {
    a_ref: row.a_ref, subject: '*', visibility: null,
    state: { page: { text: text(a), class: 'candidates', slug: a.slug, source_id: row.source_id } },
    pairs: [{ subject: `review:${row.kind}:${row.source_id}:${row.a_ref}:${row.b_ref}`, b_ref: row.b_ref,
      candidate: { text: text(b), class: 'candidates', slug: b.slug, source_id: row.source_id } }],
  };
}

async function answeredSubjects(engine: BrainEngine, refs: readonly string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = await engine.executeRaw<{ subject_ref: string }>(
    `SELECT DISTINCT subject_ref FROM decision_receipts WHERE slot = 'conflict' AND subject_ref = ANY($1::text[]) AND outcome IN ('proposal', 'independent')`, [refs]);
  return new Set(rows.map(r => r.subject_ref));
}

/** Whether a kind may act: on, and its calibration qualified for action precision. */
export function reviewGate(policy: SlotPolicy, cfg: DecideConfig): { effective: 'on' | 'shadow' | 'off'; inactive?: string } {
  if (policy.requested === 'off') return { effective: 'off' };
  if (policy.effective === 'off') return { effective: 'off', inactive: policy.inactive ?? 'no_provider' };
  if (policy.requested === 'shadow') return { effective: 'shadow' };
  const c = policy.calibration;
  if (policy.thresholdSource === 'override') return { effective: 'off', inactive: 'no_qualification' };
  if (!c || c.action_precision_lb === null) return { effective: 'off', inactive: 'no_qualification' };
  if (c.action_precision_lb < cfg.slots.conflict.minActionPrecision) return { effective: 'off', inactive: 'action_precision_low' };
  if (c.policy_fingerprint && c.policy_fingerprint !== policy.fingerprint) return { effective: 'off', inactive: 'policy_changed' };
  return { effective: 'on' };
}

export async function runReviewLane(engine: BrainEngine, opts: { kind: ReviewKind; sourceId?: string; signal?: AbortSignal; maxAnchors?: number; deadlineMs?: number }): Promise<ReviewLaneResult> {
  const kind = opts.kind;
  const sourceId = opts.sourceId ?? 'default';
  const snapshot = await loadConfigSnapshot(engine);
  const cfg = readDecideConfig(snapshot, { typesafeKey: hasTypesafeKey() });
  const sweepId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-r${randomBytes(3).toString('hex')}`;
  const result: ReviewLaneResult = { kind, source_id: sourceId, sweep_id: sweepId, effective: 'off', anchors: 0, pairs: 0, proposals: 0,
    shadow_proposals: 0, independents: 0, skipped: 0, deferred: 0 };
  if (!reviewKindEnabled(snapshot, kind)) return { ...result, inactive: 'review_kind_off' };
  const [calibrations, recent] = await Promise.all([listCalibrations(engine, { slot: 'conflict' }), recentResolvedModels(engine, 24 * 7)]);
  const lastResolved: Record<string, string> = {};
  for (const row of recent) lastResolved[row.provider] ??= row.model_resolved;
  const callSite = REVIEW_CALL_SITES[kind];
  const policy = resolveSlotPolicy({ cfg, slot: 'conflict', callSite, packShape: packShape('conflict'), calibrations, lastResolved, hasTypesafeKey: hasTypesafeKey() });
  const gate = reviewGate(policy, cfg);
  result.effective = gate.effective;
  if (gate.inactive) result.inactive = gate.inactive;
  if (gate.effective === 'off') return result;
  const mode = gate.effective;
  const salt = await receiptSalt(engine);
  const receipts: Promise<void>[] = [];
  const due = await dueQueue(engine, kind, sourceId, opts.maxAnchors ?? REVIEW_BUDGET_PER_RUN);
  for (const row of due) {
    if (opts.signal?.aborted) { result.stopped = 'aborted'; break; }
    result.anchors++;
    const built = kind === 'withdraw' ? await withdrawAnchor(engine, row, cfg) : await pagePairAnchor(engine, row);
    if ('skip' in built) {
      result.skipped++;
      if (built.skip === 'no_embedding') { await deferQueue(engine, row, built.skip); result.deferred++; } else await clearQueue(engine, row);
      continue;
    }
    const refs = built.pairs.map(p => hmacRef(salt, p.subject));
    const answered = await answeredSubjects(engine, refs);
    const pairs = built.pairs.filter((_, i) => !answered.has(refs[i]!));
    if (pairs.length === 0) { await clearQueue(engine, row); continue; }
    const questions = pairs.map((p, i) => question(kind, `review:${i}`, i, p.candidate));
    const subjects = Object.fromEntries(pairs.map((p, i) => [`review:${i}`, p.subject]));
    const base = { slot: 'conflict' as const, callSite, lane: 'background' as const, state: built.state, subjects, sourceId };
    let r;
    try {
      r = await runDecide({ slot: 'conflict', callSite, state: built.state, questions, deadlineMs: opts.deadlineMs ?? REVIEW_REQUEST_DEADLINE_MS,
        provider: policy.provider, lane: 'background', signal: opts.signal }, { engine, config: cfg, sourceId });
    } catch (err) {
      const reason = err instanceof DecideError ? err.reason : 'provider_error';
      receipts.push(writeReceipts(engine, { ...base, mode, provider: policy.provider, policy, questions, outcomes: {}, fallbackOutcome: 'error', reason }));
      result.skipped++;
      if (PERMANENT_FAILURES.has(reason)) await clearQueue(engine, row);
      else { await deferQueue(engine, row, reason); result.deferred++; }
      if (reason === 'budget_exhausted' || opts.signal?.aborted) { result.stopped = opts.signal?.aborted ? 'aborted' : reason; break; }
      continue;
    }
    const outcomes: Record<string, string> = {};
    for (const [i, pair] of pairs.entries()) {
      const answer = r.answers[`review:${i}`];
      if (!answer || answer.kind !== 'choice') continue;
      result.pairs++;
      const p = reviewActionProbability(kind, answer);
      const act = policy.threshold !== undefined ? p >= policy.threshold : answer.choice === (kind === 'withdraw' ? 'duplicate' : 'same');
      if (!act) { outcomes[`review:${i}`] = 'independent'; result.independents++; continue; }
      outcomes[`review:${i}`] = 'proposal';
      if (mode !== 'on') { result.shadow_proposals++; continue; }
      const inserted = await engine.executeRaw<{ id: number }>(
        `INSERT INTO decide_review_proposals (kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, question_version, receipt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
        [kind, sourceId, sweepId, built.a_ref, pair.b_ref, built.subject, built.visibility, p, policy.threshold ?? null, r.model_resolved || null,
          String(REVIEW_QUESTION_VERSION), JSON.stringify({ candidate_hash: pair.candidateHash ?? null, call_site: callSite })]);
      if (inserted.length) result.proposals++;
    }
    receipts.push(writeReceipts(engine, { ...base, mode, provider: policy.provider, policy, result: r, questions, outcomes, fallbackOutcome: 'skipped' }));
    await clearQueue(engine, row);
  }
  await Promise.all(receipts);
  await flushDecideWrites();
  return result;
}

/** Every enabled review kind for one source; undefined when none is enabled. */
export async function runReviewLanes(engine: BrainEngine, sourceId: string, signal?: AbortSignal): Promise<ReviewLaneResult[] | undefined> {
  const snapshot = await loadConfigSnapshot(engine);
  const kinds = REVIEW_KINDS.filter(k => reviewKindEnabled(snapshot, k));
  if (kinds.length === 0) return undefined;
  const out: ReviewLaneResult[] = [];
  for (const kind of kinds) out.push(await runReviewLane(engine, { kind, sourceId, signal }));
  return out;
}

// ---------------------------------------------------------------------------
// Proposals store
// ---------------------------------------------------------------------------

export const REVIEW_PROPOSAL_STATUSES = ['pending', 'accepting', 'accepted', 'rejected', 'stale', 'accepted_no_action'] as const;

export async function listReviewProposals(engine: BrainEngine, filter: { status?: string | 'all' } = {}): Promise<ReviewProposalRow[]> {
  const status = filter.status ?? 'pending';
  const rows = await engine.executeRaw<ReviewProposalRow>(
    `SELECT id, kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, status,
            created_at::text, decided_at::text, receipt
       FROM decide_review_proposals WHERE ($1 = 'all' OR status = $1) ORDER BY id`, [status]);
  return rows.map(r => ({ ...r, id: Number(r.id), p_action: Number(r.p_action), threshold: r.threshold === null ? null : Number(r.threshold) }));
}

export async function getReviewProposal(engine: BrainEngine, id: number, lock = false): Promise<ReviewProposalRow | null> {
  const rows = await engine.executeRaw<ReviewProposalRow>(
    `SELECT id, kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, status,
            created_at::text, decided_at::text, receipt FROM decide_review_proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  const r = rows[0];
  return r ? { ...r, id: Number(r.id), p_action: Number(r.p_action), threshold: r.threshold === null ? null : Number(r.threshold) } : null;
}

export async function transitionReviewProposal(engine: BrainEngine, id: number, from: string, to: string): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE decide_review_proposals SET status = $3, decided_at = now() WHERE id = $1 AND status = $2 RETURNING id`, [id, from, to]);
  return rows.length > 0;
}

export async function reviewProposalIdsFromSweep(engine: BrainEngine, sweepId: string, opts: { includeWithdrawals: boolean }): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `SELECT id FROM decide_review_proposals WHERE sweep_id = $1 AND status = 'pending' AND ($2::boolean OR kind <> 'withdraw') ORDER BY id`,
    [sweepId, opts.includeWithdrawals]);
  return rows.map(r => Number(r.id));
}

export interface ProposalReviewRate {
  kind: 'supersede' | ReviewKind;
  enabled: boolean;
  pending: number;
  oldest_pending_days: number | null;
  accepted_30d: number;
  rejected_30d: number;
}

/** Whether owners act on proposals: pending backlog and 30-day decisions per kind (supersede proposals and each review kind). */
export async function proposalReviewRates(engine: BrainEngine): Promise<ProposalReviewRate[]> {
  const snapshot = await loadConfigSnapshot(engine);
  const sql = (table: string, kindExpr: string) => `SELECT ${kindExpr} AS kind,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))) / 86400.0 AS oldest,
      count(*) FILTER (WHERE status IN ('accepted', 'accepted_no_action') AND decided_at > now() - interval '30 days')::int AS accepted,
      count(*) FILTER (WHERE status = 'rejected' AND decided_at > now() - interval '30 days')::int AS rejected
    FROM ${table} GROUP BY 1`;
  const rows = [
    ...await engine.executeRaw<{ kind: string; pending: number; oldest: number | null; accepted: number; rejected: number }>(sql('decide_proposals', `'supersede'`)),
    ...await engine.executeRaw<{ kind: string; pending: number; oldest: number | null; accepted: number; rejected: number }>(sql('decide_review_proposals', 'kind')),
  ];
  return (['supersede', ...REVIEW_KINDS] as const).map((kind) => {
    const r = rows.find(x => x.kind === kind);
    return { kind, enabled: kind === 'supersede' || reviewKindEnabled(snapshot, kind), pending: Number(r?.pending ?? 0),
      oldest_pending_days: r?.oldest == null ? null : Math.round(Number(r.oldest) * 10) / 10,
      accepted_30d: Number(r?.accepted ?? 0), rejected_30d: Number(r?.rejected ?? 0) };
  });
}
