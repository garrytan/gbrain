/**
 * S9 sweep: judges facts written since the per-source watermark against
 * their nearest eligible neighbours, one packed `choice` request per fact.
 * Runs as the tail of the extract_facts cycle phase (only when the slot is
 * not off) and on demand (`gbrain decide sweep --slot conflict`). The fact
 * write path stays zero-LLM and unchanged; the sweep never supersedes
 * anything: `supersede` answers at or above the proposal floor become pending
 * decide_proposals rows in `on` mode (receipts only in shadow), reviewed with
 * `gbrain decide proposals`.
 *
 * Scope: the first run records the current max fact id and sweeps nothing
 * unless `since` is given. The watermark only advances past facts created
 * more than 60 s ago. Transient skips (no embedding, provider failure) go to
 * decide_sweep_deferred and are retried with an attempt cap; `gbrain facts
 * relink` queues facts that just gained an entity there too (enqueueRelinked).
 * A pair is always presented newer fact first (valid_from, then created_at),
 * so a relinked older fact never becomes the claim that retires a newer one.
 */
import { randomBytes } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { loadConfigSnapshot } from '../../config-snapshot.ts';
import { readDecideConfig, type DecideConfig } from './config.ts';
import {
  CONFLICT_INSTRUCTIONS, CONFLICT_OPTIONS, DEFAULT_PROPOSAL_FLOOR, conflictQuestion, conflictState, datedConflictQuestion,
  datedConflictState, eligibleCandidate, isOlderFact, pairKey, proposalDirection, reduceConflict, supersedeProbability, sweepWindow, type ConflictOutcome,
} from './conflict.ts';
import { hasTypesafeKey, runDecide } from './index.ts';
import { packShape } from './pack.ts';
import { driftReason, resolveSlotPolicy, type SlotPolicy } from './policy.ts';
import {
  answeredPairRefs, clearDeferred, conflictNeighbours, deferFact, dueDeferred, factsAfter, factsByIds, getSweepWatermark,
  insertProposal, maxFactId, proposedPairs, setSweepWatermark, type ConflictCandidateRow, type SweepFact,
} from './proposals-store.ts';
import { writeReceipts } from './receipts.ts';
import { flushDecideWrites, hmacRef, listCalibrations, receiptSalt, recentResolvedModels } from './store.ts';
import { DecideError, type DecideQuestion, type DecideResult } from './types.ts';

export const SWEEP_MAX_FACTS = 200;
const SWEEP_REQUEST_DEADLINE_MS = 30_000;
/** Provider failures are transient and retried; egress refusals and oversized payloads are not. */
const PERMANENT_FAILURES = new Set(['egress', 'payload_too_large']);

export interface ConflictSweepResult {
  sweep_id: string;
  source_id: string;
  mode: string;
  effective: string;
  inactive?: string;
  first_run: boolean;
  facts: number;
  retried: number;
  pairs: number;
  duplicates: number;
  proposals: number;
  shadow_proposals: number;
  independents: number;
  skipped: number;
  deferred: number;
  watermark: { from: number | null; to: number | null };
  stopped?: string;
}

export interface ConflictSweepOpts {
  sourceId?: string;
  /** Sweep facts with an id above this one instead of the stored watermark. */
  since?: number;
  signal?: AbortSignal;
  maxFacts?: number;
  deadlineMs?: number;
  now?: () => number;
}

function newSweepId(now: number): string {
  return `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Proposal floor: the operator's decide.slots.conflict.proposal_floor, else the calibration's floor (only when the
 * duplicate threshold also comes from that calibration: the floor was fitted on the pairs its threshold leaves), else
 * the default.
 */
export function proposalFloor(snapshot: Record<string, string> | null, calibrated?: number): number {
  const raw = snapshot?.['decide.slots.conflict.proposal_floor'];
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return calibrated ?? DEFAULT_PROPOSAL_FLOOR;
}

interface SweepContext {
  engine: BrainEngine;
  cfg: DecideConfig;
  policy: SlotPolicy;
  fallbackPolicy?: SlotPolicy;
  floor: number;
  sweepId: string;
  sourceId: string;
  salt: string;
  judged: Set<string>;
  pairIndex: number;
  deadlineMs: number;
  now: () => number;
  result: ConflictSweepResult;
  receipts: Promise<void>[];
  signal?: AbortSignal;
}

const factQuestion: DecideQuestion = { id: 'conflict:fact', kind: 'choice', instructions: CONFLICT_INSTRUCTIONS, options: { ...CONFLICT_OPTIONS } };

function receiptMode(policy: SlotPolicy): 'on' | 'shadow' {
  return policy.effective === 'shadow' ? 'shadow' : 'on';
}

/** A fact-level skip or error: one receipt row, no text (the state is hashed). */
function factReceipt(ctx: SweepContext, fact: SweepFact, outcome: 'skipped' | 'error', reason: string): void {
  ctx.receipts.push(writeReceipts(ctx.engine, {
    slot: 'conflict', mode: receiptMode(ctx.policy), callSite: 'sweep', lane: 'background', provider: ctx.policy.provider, policy: ctx.policy,
    questions: [factQuestion], state: conflictState(fact), outcomes: {}, fallbackOutcome: outcome, reason,
    subjects: { [factQuestion.id]: `fact:${fact.source_id}:${fact.id}` }, sourceId: fact.source_id,
  }));
}

async function candidatesFor(ctx: SweepContext, fact: SweepFact) {
  const now = ctx.now();
  const eligible = (await conflictNeighbours(ctx.engine, fact.id, fact.source_id)).filter((c) => eligibleCandidate(fact, c, now));
  const proposed = await proposedPairs(ctx.engine, fact.source_id, fact.id);
  const refs = eligible.map((c) => hmacRef(ctx.salt, pairKey(fact.source_id, fact.id, c.id)));
  const answered = await answeredPairRefs(ctx.engine, refs);
  return eligible.filter((c, i) => {
    const key = pairKey(fact.source_id, fact.id, c.id);
    return !ctx.judged.has(key) && !answered.has(refs[i]!) && !proposed.has(`${Math.min(fact.id, c.id)}:${Math.max(fact.id, c.id)}`);
  });
}

function fallbackPolicyFor(ctx: SweepContext): SlotPolicy {
  return ctx.fallbackPolicy ??= resolveSlotPolicy({
    cfg: { ...ctx.cfg, slots: { ...ctx.cfg.slots, conflict: { ...ctx.cfg.slots.conflict, provider: ctx.cfg.egressFallback } } },
    slot: 'conflict', callSite: 'sweep', packShape: packShape('conflict'), calibrations: [], hasTypesafeKey: hasTypesafeKey(),
  });
}

type PairFact = SweepFact | ConflictCandidateRow;

/**
 * One request: `claim` is presented as `fact` and judged against each of `others` as `candidate`. A proposal
 * would retire the `candidate`. `dated` marks a pair reordered by chronology (the swept fact is the older one),
 * whose evidence carries both facts' timestamps. Returns 'error' after a failed request (the swept fact is
 * deferred unless the failure is permanent) and 'stop' when the sweep must stop.
 */
async function judgePairs(ctx: SweepContext, fact: SweepFact, claim: PairFact, others: readonly PairFact[], dated: boolean):
  Promise<'answered' | 'unanswered' | 'error' | 'stop'> {
  const { engine, result } = ctx;
  const questions = others.map((c, i) => dated ? datedConflictQuestion(`conflict:${i}`, i, c) : conflictQuestion(`conflict:${i}`, i, c));
  const subjects = Object.fromEntries(others.map((c, i) => [`conflict:${i}`, pairKey(fact.source_id, claim.id, c.id)]));
  const state = dated ? datedConflictState(claim) : conflictState(claim);
  const base = { slot: 'conflict' as const, callSite: 'sweep', lane: 'background' as const, state, subjects, sourceId: fact.source_id };
  let r: DecideResult;
  try {
    r = await runDecide({ slot: 'conflict', callSite: 'sweep', state, questions, deadlineMs: ctx.deadlineMs, provider: ctx.policy.provider, lane: 'background', signal: ctx.signal },
      { engine, config: ctx.cfg, sourceId: fact.source_id });
  } catch (err) {
    const reason = err instanceof DecideError ? err.reason : 'provider_error';
    ctx.receipts.push(writeReceipts(engine, { ...base, mode: receiptMode(ctx.policy), provider: ctx.policy.provider, policy: ctx.policy, questions, outcomes: {}, fallbackOutcome: 'error', reason }));
    result.skipped++;
    if (!PERMANENT_FAILURES.has(reason)) {
      await deferFact(engine, fact.source_id, fact.id, reason);
      result.deferred++;
    }
    if (reason === 'budget_exhausted' || ctx.signal?.aborted) { result.stopped = ctx.signal?.aborted ? 'aborted' : reason; return 'stop'; }
    return 'error';
  }
  const primaryIds = questions.filter((q) => !r.fallback?.answers[q.id]).map((q) => q.id);
  const fallbackIds = questions.filter((q) => r.fallback?.answers[q.id]).map((q) => q.id);
  let answeredAny = false;
  const judge = async (ids: string[], policy: SlotPolicy, sub: DecideResult) => {
    if (ids.length === 0) return;
    const skip = policy.effective === 'off' ? policy.inactive ?? 'no_provider' : driftReason(policy, sub.model_resolved);
    const outcomes: Record<string, ConflictOutcome> = {};
    for (const id of ids) {
      const answer = sub.answers[id];
      if (skip || !answer || answer.kind !== 'choice') continue;
      const candidate = others[Number(id.split(':')[1])]!;
      const outcome = reduceConflict(answer, { threshold: policy.threshold, proposalFloor: ctx.floor });
      outcomes[id] = outcome;
      answeredAny = true;
      ctx.judged.add(pairKey(fact.source_id, claim.id, candidate.id));
      result.pairs++;
      if (outcome === 'duplicate') result.duplicates++;
      else if (outcome === 'independent') result.independents++;
      else if (policy.effective !== 'on') result.shadow_proposals++;
      else {
        const proposalId = await insertProposal(engine, {
          source_id: fact.source_id, sweep_id: ctx.sweepId, pair_index: ctx.pairIndex++, new_fact_id: claim.id, old_fact_id: candidate.id,
          direction: proposalDirection(claim.id, candidate.id), p_supersede: supersedeProbability(answer), threshold: policy.threshold ?? null,
          proposal_floor: ctx.floor, model_resolved: sub.model_resolved || null,
        });
        if (proposalId !== null) result.proposals++;
      }
    }
    ctx.receipts.push(writeReceipts(engine, {
      ...base, mode: receiptMode(policy), provider: policy.provider, policy, result: sub, questions: questions.filter((q) => ids.includes(q.id)),
      outcomes, fallbackOutcome: 'skipped', ...(skip ? { reason: skip } : {}),
    }));
  };
  await judge(primaryIds, ctx.policy, r);
  if (r.fallback) await judge(fallbackIds, fallbackPolicyFor(ctx), r.fallback);
  return answeredAny ? 'answered' : 'unanswered';
}

/**
 * Judge one fact; returns false when the sweep must stop (daily budget spent, caller abort). Neighbours older than
 * the fact share one request with the fact as the new claim; each neighbour newer than the fact gets its own
 * request with that neighbour as the new claim, so a proposal never retires the newer fact.
 */
async function sweepFact(ctx: SweepContext, fact: SweepFact, retry: boolean): Promise<boolean> {
  const { engine, result } = ctx;
  result.facts++;
  if (!fact.entity_slug) {
    factReceipt(ctx, fact, 'skipped', 'no_entity');
    result.skipped++;
    if (retry) await clearDeferred(engine, fact.source_id, fact.id);
    return true;
  }
  if (!fact.has_embedding) {
    factReceipt(ctx, fact, 'skipped', 'no_embedding');
    await deferFact(engine, fact.source_id, fact.id, 'no_embedding');
    result.skipped++;
    result.deferred++;
    return true;
  }
  const candidates = await candidatesFor(ctx, fact);
  if (candidates.length === 0) {
    if (retry) await clearDeferred(engine, fact.source_id, fact.id);
    return true;
  }
  const older = candidates.filter((c) => !isOlderFact(fact, c));
  const requests: Array<[PairFact, readonly PairFact[], boolean]> = [
    ...(older.length > 0 ? [[fact, older, false] as [PairFact, readonly PairFact[], boolean]] : []),
    ...candidates.filter((c) => isOlderFact(fact, c)).map((c): [PairFact, readonly PairFact[], boolean] => [c, [fact], true]),
  ];
  let answeredAny = false;
  for (const [claim, others, dated] of requests) {
    const outcome = await judgePairs(ctx, fact, claim, others, dated);
    if (outcome === 'stop') return false;
    if (outcome === 'error') return true;
    answeredAny ||= outcome === 'answered';
  }
  if (!answeredAny) result.skipped++;
  if (retry) await clearDeferred(engine, fact.source_id, fact.id);
  return true;
}

function emptyResult(sweepId: string, sourceId: string, policy: SlotPolicy): ConflictSweepResult {
  return {
    sweep_id: sweepId, source_id: sourceId, mode: policy.requested, effective: policy.effective, ...(policy.inactive ? { inactive: policy.inactive } : {}),
    first_run: false, facts: 0, retried: 0, pairs: 0, duplicates: 0, proposals: 0, shadow_proposals: 0, independents: 0, skipped: 0, deferred: 0,
    watermark: { from: null, to: null },
  };
}

export async function runConflictSweep(engine: BrainEngine, opts: ConflictSweepOpts = {}): Promise<ConflictSweepResult> {
  const now = opts.now ?? Date.now;
  const sourceId = opts.sourceId ?? 'default';
  const snapshot = await loadConfigSnapshot(engine);
  const cfg = readDecideConfig(snapshot, { typesafeKey: hasTypesafeKey() });
  const [calibrations, recent] = await Promise.all([listCalibrations(engine, { slot: 'conflict' }), recentResolvedModels(engine, 24 * 7)]);
  const lastResolved: Record<string, string> = {};
  for (const row of recent) lastResolved[row.provider] ??= row.model_resolved;
  const policy = resolveSlotPolicy({ cfg, slot: 'conflict', callSite: 'sweep', packShape: packShape('conflict'), calibrations, lastResolved, hasTypesafeKey: hasTypesafeKey() });
  const result = emptyResult(newSweepId(now()), sourceId, policy);
  if (policy.effective === 'off') return result;

  const stored = await getSweepWatermark(engine, sourceId);
  if (opts.since === undefined && stored === null) {
    const max = await maxFactId(engine, sourceId);
    await setSweepWatermark(engine, sourceId, max);
    return { ...result, first_run: true, watermark: { from: null, to: max } };
  }
  const start = opts.since ?? stored!;
  const ctx: SweepContext = {
    engine, cfg, policy, floor: proposalFloor(snapshot, policy.thresholdSource === 'override' ? undefined : policy.calibration?.proposal_floor), sweepId: result.sweep_id, sourceId, salt: await receiptSalt(engine),
    judged: new Set(), pairIndex: 0, deadlineMs: opts.deadlineMs ?? SWEEP_REQUEST_DEADLINE_MS, now, result, receipts: [], signal: opts.signal,
  };
  const max = opts.maxFacts ?? SWEEP_MAX_FACTS;
  let going = true;
  const due = await dueDeferred(engine, sourceId, max);
  const retries = await factsByIds(engine, sourceId, due.map((d) => d.fact_id));
  for (const gone of due.filter((d) => !retries.some((f) => f.id === d.fact_id))) await clearDeferred(engine, sourceId, gone.fact_id);
  for (const fact of retries) {
    if (!going || opts.signal?.aborted) break;
    result.retried++;
    going = await sweepFact(ctx, fact, true);
  }
  let last: number | null = null;
  const window = sweepWindow(await factsAfter(engine, sourceId, start, max), now());
  for (const fact of window) {
    if (!going || opts.signal?.aborted) break;
    going = await sweepFact(ctx, fact, false);
    last = fact.id;
  }
  if (opts.signal?.aborted) result.stopped ??= 'aborted';
  const next = last === null ? stored ?? start : Math.max(stored ?? 0, last);
  if (next !== stored) await setSweepWatermark(engine, sourceId, next);
  result.watermark = { from: start, to: next };
  await Promise.all(ctx.receipts);
  await flushDecideWrites();
  return result;
}

/**
 * The extract_facts phase tail: undefined when the slot is off (so the phase
 * output stays byte-identical), else the sweep counts for the phase details.
 */
export async function conflictSweepTail(engine: BrainEngine, sourceId: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const cfg = readDecideConfig(await loadConfigSnapshot(engine), { typesafeKey: hasTypesafeKey() });
  if (cfg.slots.conflict.mode === 'off') return undefined;
  try {
    const r = await runConflictSweep(engine, { sourceId, signal });
    return {
      sweep_id: r.sweep_id, effective: r.effective, ...(r.inactive ? { inactive: r.inactive } : {}), facts: r.facts, duplicates: r.duplicates,
      proposals: r.proposals, independents: r.independents, skipped: r.skipped, deferred: r.deferred,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
