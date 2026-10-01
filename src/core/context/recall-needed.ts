/**
 * System One S6 `recall_needed` (know-to-ask) at the turn-context call site:
 * serve's `turn_context` IPC handler, which answers the engine-free
 * `gbrain hook user-prompt`.
 *
 *   startRecallNeeded  — launched concurrently with reflex resolution: config,
 *                        policy and (when active) one probability question
 *                        over the prompt plus the previous turn, under its own
 *                        absolute deadline of RECALL_NEEDED_DEADLINE_MS from
 *                        the start of the turn.
 *   applyRecallNeeded  — after the reflex block is assembled: awaits S6 only
 *                        until that deadline, then (on mode) fires one
 *                        keyword-only search when the reflex surfaced nothing,
 *                        or suppresses the reflex window when the probability
 *                        is very low and no identity hit exists.
 *
 * Fail direction: the reflex result stands unchanged on off, inactive,
 * timeout, 429, 5xx, budget, drift, egress refusal and a late or empty
 * retrieval. The fired search runs only when RECALL_FIRE_MIN_REMAINING_MS of
 * the IPC server budget remain and must finish before the budget minus a
 * response margin, so S6 can never make the server budget null the block.
 * Receipts carry hashes only (never prompt text).
 */
import type { BrainEngine } from '../engine.ts';
import { loadConfigSnapshot } from '../config-snapshot.ts';
import { pickDecideConfig, readDecideConfig, RECALL_SUPPRESS_BELOW_DEFAULT, type DecideConfig } from '../ai/decide/config.ts';
import { hasTypesafeKey, runDecide } from '../ai/decide/index.ts';
import { packShape } from '../ai/decide/pack.ts';
import { driftReason, resolveSlotPolicy, type SlotPolicy } from '../ai/decide/policy.ts';
import { writeReceipts, type ReceiptInput } from '../ai/decide/receipts.ts';
import {
  recallNeededQuestion, recallNeededState, recallReflex, reduceRecallNeeded, RECALL_NEEDED_QUESTION_ID, type RecallOutcome,
} from '../ai/decide/recall-needed.ts';
import { createQueryBudget, runShadow, sampled, stageDeadlineMs } from '../ai/decide/runtime.ts';
import { DecideError, type DecideResult, type EvidenceItem } from '../ai/decide/types.ts';
import { calibrationState, type DecideSlotMeta } from '../search/decide-stage.ts';
import { formatDecideSummary } from '../search/explain-formatter.ts';
import type { SearchResult } from '../types.ts';
import type { WindowTurn } from './entity-salience.ts';
import { TURN_CONTEXT_SERVER_BUDGET_MS } from './resolve-ipc.ts';
import { ARM_CONFIDENCE, safeSynopsis, type ReflexPointer } from './retrieval-reflex.ts';
import type { VolunteeredPage } from './volunteer.ts';

/** S6's own deadline, measured from the start of the turn (fixed by design). */
export const RECALL_NEEDED_DEADLINE_MS = 250;
/** The fired search starts only when this much of the IPC server budget is left. */
export const RECALL_FIRE_MIN_REMAINING_MS = 150;
export const RECALL_FIRE_LIMIT = 3;
/** The fired search must finish this long before the server budget ends (response write headroom). */
export const RECALL_RESPONSE_MARGIN_MS = 40;

const LATE = Symbol('late');

/** Resolve with `p`'s value, or LATE at the absolute time `at` (p keeps running; callers catch it). */
async function settleBy<T>(p: Promise<T>, at: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), Math.max(0, at - Date.now())); });
  try {
    return await Promise.race([p, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RecallNeededPrepared {
  cfg: DecideConfig;
  policy: SlotPolicy;
  state: Record<string, EvidenceItem>;
  sessionRef: string;
  sourceId: string;
  /** The decide call, started as soon as the policy allowed it. */
  call?: Promise<DecideResult>;
  /** Why no call was made: the inactive cause, or `late`. */
  skipped?: string;
}

/** Phase 1, concurrent with reflex resolution. Null when the slot is off (the all-off path does no more work). */
export async function startRecallNeeded(
  engine: BrainEngine,
  opts: { sourceId: string; window: readonly WindowTurn[]; sessionId?: string; startedAt: number },
): Promise<RecallNeededPrepared | null> {
  const picked = pickDecideConfig(await loadConfigSnapshot(engine));
  if (!picked) return null;
  const cfg = readDecideConfig(picked);
  if (cfg.slots.recall_needed.mode === 'off') return null;
  const sessionRef = `session:${opts.sessionId ?? 'unknown'}`;
  const state = recallNeededState(opts.window, { transcriptRef: sessionRef, sourceId: opts.sourceId });
  if (!state) return null;
  const cal = await calibrationState(engine);
  const policy = resolveSlotPolicy({
    cfg, slot: 'recall_needed', callSite: 'turn_context', packShape: packShape('recall_needed'),
    calibrations: cal.rows, lastResolved: cal.resolved, hasTypesafeKey: hasTypesafeKey(),
  });
  const base = { cfg, policy, state, sessionRef, sourceId: opts.sourceId };
  if (policy.effective === 'off') return { ...base, skipped: policy.inactive };
  if (policy.effective === 'shadow' && !sampled(policy.shadowSample)) return null;
  const deadlineMs = stageDeadlineMs(createQueryBudget(RECALL_NEEDED_DEADLINE_MS, opts.startedAt), cfg.timeoutMs);
  if (deadlineMs === null) return { ...base, skipped: 'late' };
  const call = runDecide(
    { slot: 'recall_needed', callSite: 'turn_context', state, questions: [recallNeededQuestion()], deadlineMs, provider: policy.provider, lane: 'hot' },
    { engine, config: cfg, sourceId: opts.sourceId },
  );
  call.catch(() => {});
  return { ...base, call };
}

export interface RecallApplyContext {
  startedAt: number;
  prompt: string;
  priorContextText?: string;
  /** The reflex window as rendered (post-budget). */
  pointers: ReflexPointer[];
  volunteered: VolunteeredPage[];
}

export interface RecallNeededApplied {
  meta: DecideSlotMeta;
  /** Present only when S6 changed the reflex window. */
  window?: { pointers: ReflexPointer[]; volunteered: VolunteeredPage[] };
}

function receiptBase(p: RecallNeededPrepared, identityHit: boolean): Omit<ReceiptInput, 'outcomes'> {
  return {
    slot: 'recall_needed', mode: p.policy.requested === 'shadow' ? 'shadow' : 'on', callSite: 'turn_context', lane: 'hot',
    provider: p.policy.provider, policy: p.policy, state: p.state, sourceId: p.sourceId,
    questions: [{ ...recallNeededQuestion(), protected: identityHit }], subjects: { [RECALL_NEEDED_QUESTION_ID]: p.sessionRef },
  };
}

/** The keyword-only search S6 fires: no embedding call, nested decide slots off, world-only safe chunks, the hook's source. */
async function fireRetrieval(engine: BrainEngine, p: RecallNeededPrepared, ctx: RecallApplyContext, deadlineAt: number): Promise<ReflexPointer[] | typeof LATE> {
  const { hybridSearch } = await import('../search/hybrid.ts');
  const search = hybridSearch(engine, ctx.prompt, {
    limit: RECALL_FIRE_LIMIT, expansion: false, sourceId: p.sourceId, excludePrivate: true, requireSafeChunks: true,
    decide: { off: true, keywordOnly: true },
  });
  const results = await settleBy(search.catch(() => [] as SearchResult[]), deadlineAt);
  if (results === LATE) return LATE;
  const prior = ctx.priorContextText?.toLowerCase() ?? '';
  const seen = new Set<string>();
  const pointers: ReflexPointer[] = [];
  for (const r of results) {
    if (seen.has(r.slug) || (prior && prior.includes(r.slug.toLowerCase()))) continue;
    seen.add(r.slug);
    pointers.push({
      display: r.title || r.slug.slice(r.slug.lastIndexOf('/') + 1), slug: r.slug, source_id: r.source_id ?? p.sourceId,
      synopsis: safeSynopsis({ slug: r.slug, source_id: r.source_id ?? p.sourceId, title: r.title, type: null, frontmatter: null, compiled_truth: r.chunk_text }),
      arm: 'recall', confidence: ARM_CONFIDENCE.recall,
    });
  }
  return pointers;
}

/**
 * Phase 2, after the reflex block exists. Returns null when S6 adds nothing
 * visible (off, unsampled or async shadow, or late preparation); otherwise
 * the meta line and, only when S6 acted, the replacement reflex window.
 */
export async function applyRecallNeeded(
  engine: BrainEngine,
  pending: Promise<RecallNeededPrepared | null>,
  ctx: RecallApplyContext,
): Promise<RecallNeededApplied | null> {
  const applied = await decideRecall(engine, pending, ctx);
  // Per-turn explain line for operators running `GBRAIN_DEBUG=1 gbrain serve` (no prompt text).
  if (applied && process.env.GBRAIN_DEBUG === '1') process.stderr.write(`[turn-context] ${formatDecideSummary({ recall_needed: applied.meta })}\n`);
  return applied;
}

async function decideRecall(
  engine: BrainEngine,
  pending: Promise<RecallNeededPrepared | null>,
  ctx: RecallApplyContext,
): Promise<RecallNeededApplied | null> {
  const s6End = ctx.startedAt + RECALL_NEEDED_DEADLINE_MS;
  const safePending = pending.catch(() => null);
  const prepared = await settleBy(safePending, s6End);
  const reflex = recallReflex([...ctx.pointers, ...ctx.volunteered]);
  if (prepared === LATE) {
    void safePending.then((p) => { if (p) void writeReceipts(engine, { ...receiptBase(p, reflex.identityHit), outcomes: {}, fallbackOutcome: 'skipped', reason: 'late' }); });
    return null;
  }
  if (!prepared) return null;
  const { policy } = prepared;
  const base = receiptBase(prepared, reflex.identityHit);
  if (!prepared.call) {
    void writeReceipts(engine, { ...base, outcomes: {}, fallbackOutcome: 'skipped', reason: prepared.skipped });
    return { meta: { mode: policy.requested, effective: 'off', provider: policy.provider, skipped: prepared.skipped } };
  }
  const call = prepared.call;

  const judge = async (): Promise<{ outcome?: RecallOutcome; result?: DecideResult; reason?: string }> => {
    let result: DecideResult;
    try {
      const settled = await settleBy(call, s6End);
      if (settled === LATE) throw new DecideError('timeout', 'recall_needed: deadline exceeded');
      result = settled;
    } catch (err) {
      const reason = err instanceof DecideError ? err.reason : 'provider_error';
      void writeReceipts(engine, { ...base, outcomes: {}, fallbackOutcome: 'error', reason });
      return { reason };
    }
    const answer = result.answers[RECALL_NEEDED_QUESTION_ID];
    const drift = answer ? driftReason(policy, result.model_resolved) : undefined;
    if (!answer || answer.kind !== 'noul' || drift) {
      const reason = drift ?? result.refused[RECALL_NEEDED_QUESTION_ID] ?? 'malformed_response';
      void writeReceipts(engine, { ...base, result, outcomes: {}, fallbackOutcome: 'skipped', reason });
      return { result, reason };
    }
    const outcome = reduceRecallNeeded(answer.p, reflex, { threshold: policy.threshold!, suppressBelow: policy.suppressBelow ?? RECALL_SUPPRESS_BELOW_DEFAULT, margin: policy.margin });
    return { outcome, result };
  };
  const metaFor = (j: Awaited<ReturnType<typeof judge>>, effective: DecideSlotMeta['effective'], reason?: string): DecideSlotMeta => ({
    mode: policy.requested, effective: j.outcome ? effective : 'off', provider: policy.provider,
    ...(j.result?.model_resolved ? { model_resolved: j.result.model_resolved } : {}),
    ...(policy.threshold !== undefined ? { threshold: policy.threshold } : {}), judged: 1,
    ...(j.outcome ? { outcomes: { [j.outcome]: 1 } } : {}),
    ...(j.result ? { latency_ms: j.result.latency_ms } : {}), ...((reason ?? j.reason) ? { skipped: reason ?? j.reason } : {}),
  });

  if (policy.effective === 'shadow') {
    const record = async () => {
      const j = await judge();
      if (j.outcome) void writeReceipts(engine, { ...base, result: j.result, outcomes: { [RECALL_NEEDED_QUESTION_ID]: j.outcome } });
      return j;
    };
    if (!policy.shadowWait) {
      if (!runShadow(async () => { await record(); })) void writeReceipts(engine, { ...base, outcomes: {}, fallbackOutcome: 'skipped', reason: 'shadow_queue_full' });
      return null;
    }
    return { meta: metaFor(await record(), 'shadow') };
  }

  const j = await judge();
  if (!j.outcome) return { meta: metaFor(j, 'off') };
  let window: RecallNeededApplied['window'];
  let reason: string | undefined;
  if (j.outcome === 'suppress') window = { pointers: [], volunteered: [] };
  if (j.outcome === 'fire') {
    const budgetEnd = ctx.startedAt + TURN_CONTEXT_SERVER_BUDGET_MS;
    const fired = budgetEnd - Date.now() < RECALL_FIRE_MIN_REMAINING_MS ? LATE : await fireRetrieval(engine, prepared, ctx, budgetEnd - RECALL_RESPONSE_MARGIN_MS);
    if (fired === LATE) reason = 'late';
    else if (fired.length === 0) reason = 'no_candidates';
    else window = { pointers: fired, volunteered: ctx.volunteered };
  }
  void writeReceipts(engine, { ...base, result: j.result, outcomes: { [RECALL_NEEDED_QUESTION_ID]: j.outcome }, ...(reason ? { reason } : {}) });
  return { meta: metaFor(j, 'on', reason), ...(window ? { window } : {}) };
}
