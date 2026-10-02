/**
 * System One search stages (S1 rerank receipts/shadow, S3 evidence gate) and
 * the per-request decide context hybridSearch threads through its stages.
 *
 * All-off contract: `resolveDecideSearchContext` returns undefined when every
 * slot is off, so the pipeline does no decide work, adds no meta and output is
 * byte-identical. Every stage fails open to today's path.
 *
 * S3 runs inside sizeReturnPool between stampEvidence and adaptive return (and
 * at the equivalent point of the keyword-only path): one packed request, state
 * = the query, one probability question per candidate. It never reorders,
 * never prunes a protected result (protection.ts), never goes below min_keep.
 * Co-packed slots (S5) register a handler with `registerEvidenceCoPack`.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { getCliOptions } from '../cli-options.ts';
import { allSlotsOff, readDecideConfig, type DecideConfig, DEFAULT_TYPESAFE_PROVIDER } from '../ai/decide/config.ts';
import { evidenceQuestion, reduceEvidence, type EvidenceOutcome } from '../ai/decide/evidence.ts';
import { hasTypesafeKey, runDecide } from '../ai/decide/index.ts';
import { packShape } from '../ai/decide/pack.ts';
import { driftReason, resolveSlotPolicy, type SlotPolicy } from '../ai/decide/policy.ts';
import { isProtectedResult } from '../ai/decide/protection.ts';
import { writeReceipts } from '../ai/decide/receipts.ts';
import { rerankQuestions } from '../ai/decide/rerank-adapter.ts';
import { createQueryBudget, runShadow, sampled, stageDeadlineMs, type DecideQueryBudget } from '../ai/decide/runtime.ts';
import { listCalibrations, pageSubject, recentResolvedModels, type CalibrationRow } from '../ai/decide/store.ts';
import { DecideError, type DecideMode, type DecideQuestion, type DecideResult, type DecideSlot } from '../ai/decide/types.ts';
import { candidateItem, injectionCoPack, launchSearchIntent, startQueryAnswerability, type AnswerabilityVerdict, type IntentAsk } from './decide-retrieval.ts';
import { capRerankDoc } from './rerank.ts';

export interface DecideSlotMeta {
  mode: DecideMode;
  effective: DecideMode;
  provider?: string;
  model_resolved?: string;
  threshold?: number;
  judged?: number;
  outcomes?: Record<string, number>;
  /** Fail-open or inactive cause (catalogued reason). */
  skipped?: string;
  latency_ms?: number;
  /** S1 shadow: agreement between today's order and Jev's. */
  agreement?: { top1: boolean; kendall_tau: number };
  /** One-line answer summary (S2 label, S4 probability and verdict). */
  answer?: string;
  /** S1 on: input tokens the Jev reranker reported (its spend is BudgetKind rerank, not decide_spend). */
  input_tokens?: number;
}

/** S4 on the query op: `meta.answerability` (diagnostic only; shadow shows it only when awaited). */
export type AnswerabilityMeta = AnswerabilityVerdict;

export type DecideSearchMeta = Partial<Record<DecideSlot, DecideSlotMeta>>;

export interface DecideSearchContext {
  engine: BrainEngine;
  cfg: DecideConfig;
  budget: DecideQueryBudget;
  remote: boolean;
  callSite: string;
  /** --explain (this query) or shadow_wait: await shadow and emit its diagnostics. */
  explain: boolean;
  policies: Partial<Record<DecideSlot, SlotPolicy>>;
  meta: DecideSearchMeta;
  sourceId?: string;
  /** S2: the in-flight search question (launched at hybridSearch entry, or think's precomputed one). */
  intentAsk?: IntentAsk;
  /** S4 query-op verdict for `meta.answerability`. */
  answerability?: AnswerabilityMeta;
}

/** Hybrid opts the op layer passes (remote spend accounting; crag re-runs turn S2-S5 off). */
export interface DecideSearchOpts {
  remote?: boolean;
  callSite?: string;
  /** Run only S1 (a crag_escalation re-run judges its new candidates with S2-S5 off). */
  rerankOnly?: boolean;
  /** Run today's pipeline with every slot off (decide probe --query baseline). */
  off?: boolean;
  /** S6 fire retrieval (turn context): take the keyword-only return path, no embedding call. */
  keywordOnly?: boolean;
  /** S2: think's one precomputed search-intent answer, shared by its gather legs. */
  intent?: IntentAsk;
  /** S4: the `query` op asks answerability over the pre-S3 top-k (diagnostic only). */
  answerability?: boolean;
}

/** Max candidates the S3 request judges (fixed by design; the unjudged tail is kept). */
export const EVIDENCE_MAX_CANDIDATES = 50;

// ---------------------------------------------------------------------------
// Co-pack registry (S5 rides the S3 request)
// ---------------------------------------------------------------------------

export interface EvidenceCoPackHandler {
  slot: DecideSlot;
  /** Question ids must be prefixed with `${slot}:`. */
  questions(query: string, candidates: readonly SearchResult[], policy: SlotPolicy): DecideQuestion[];
  /** Apply answers (never below the S3 min_keep cut); `judged[i]` is the candidate question index i asked about. Returns receipt outcomes by question id, or a skip reason (drift). */
  apply(pool: SearchResult[], result: DecideResult, policy: SlotPolicy, ctx: DecideSearchContext, judged: readonly SearchResult[]): { pool: SearchResult[]; outcomes: Record<string, string>; reason?: string };
}

const coPackHandlers: EvidenceCoPackHandler[] = [];

export function registerEvidenceCoPack(handler: EvidenceCoPackHandler): void {
  if (!coPackHandlers.some((h) => h.slot === handler.slot)) coPackHandlers.push(handler);
}

/** Slots riding the S3 request under `cfg` (part of the evidence pack_shape). */
export function evidenceCoPackedSlots(cfg: DecideConfig): DecideSlot[] {
  return coPackHandlers.filter((h) => cfg.slots[h.slot].mode !== 'off').map((h) => h.slot);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const CACHE_MS = 60_000;
let calibrationCache = new WeakMap<BrainEngine, { at: number; rows: CalibrationRow[]; resolved: Record<string, string> }>();

/** Calibration rows and last resolved models, cached per engine for 60 s (search and think share it). */
export async function calibrationState(engine: BrainEngine): Promise<{ rows: CalibrationRow[]; resolved: Record<string, string> }> {
  const hit = calibrationCache.get(engine);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const [rows, recent] = await Promise.all([
    listCalibrations(engine).catch(() => [] as CalibrationRow[]),
    recentResolvedModels(engine).catch(() => []),
  ]);
  const resolved: Record<string, string> = {};
  for (const r of recent) resolved[r.provider] ??= r.model_resolved;
  const entry = { at: Date.now(), rows, resolved };
  calibrationCache.set(engine, entry);
  return entry;
}

/** Drop cached calibrations (after calibrate/adopt/retire, and in tests). */
export function resetDecideSearchCache(): void {
  calibrationCache = new WeakMap();
}

export async function resolveDecideSearchContext(
  engine: BrainEngine,
  snapshot: Record<string, string> | null | undefined,
  opts: { rerankerModel?: string; rerankerEnabled: boolean; decide?: DecideSearchOpts; sourceId?: string },
): Promise<DecideSearchContext | undefined> {
  if (opts.decide?.off) return undefined;
  const cfg = readDecideConfig(snapshot ?? null);
  if (opts.decide?.rerankOnly) {
    for (const slot of Object.keys(cfg.slots) as DecideSlot[]) if (slot !== 'rerank') cfg.slots[slot] = { ...cfg.slots[slot], mode: 'off' };
  }
  if (allSlotsOff(cfg)) return undefined;
  const state = await calibrationState(engine);
  const hasKey = hasTypesafeKey();
  const callSite = opts.decide?.callSite ?? 'search';
  const policies: Partial<Record<DecideSlot, SlotPolicy>> = {};
  const rerankerModel = opts.rerankerEnabled ? opts.rerankerModel : undefined;
  if (cfg.slots.rerank.mode !== 'off') {
    policies.rerank = resolveSlotPolicy({ cfg, slot: 'rerank', callSite, packShape: packShape('rerank'), calibrations: state.rows, lastResolved: state.resolved, hasTypesafeKey: hasKey, rerankerModel });
  }
  // Co-packed slots (S5) always ride the S3-shaped request, whether or not S3 itself is on.
  const coPacked = evidenceCoPackedSlots(cfg);
  if (cfg.slots.evidence.mode !== 'off') {
    policies.evidence = resolveSlotPolicy({ cfg, slot: 'evidence', callSite, packShape: packShape('evidence', coPacked), calibrations: state.rows, lastResolved: state.resolved, hasTypesafeKey: hasKey });
  }
  for (const slot of coPacked) {
    policies[slot] = resolveSlotPolicy({ cfg, slot, callSite, packShape: packShape('evidence', coPacked), calibrations: state.rows, lastResolved: state.resolved, hasTypesafeKey: hasKey });
  }
  // S2's search question keys on call site `search` even inside think's gather.
  if (cfg.slots.intent.mode !== 'off') {
    policies.intent = resolveSlotPolicy({ cfg, slot: 'intent', callSite: 'search', packShape: packShape('intent'), calibrations: state.rows, lastResolved: state.resolved, hasTypesafeKey: hasKey });
  }
  if (cfg.slots.answerable.mode !== 'off' && opts.decide?.answerability) {
    policies.answerable = resolveSlotPolicy({ cfg, slot: 'answerable', callSite: 'query', packShape: packShape('answerable', [], { unpacked: true }), calibrations: state.rows, lastResolved: state.resolved, hasTypesafeKey: hasKey });
  }
  const explain = getCliOptions().explain === true;
  return {
    engine, cfg, budget: createQueryBudget(cfg.queryBudgetMs), remote: opts.decide?.remote === true, callSite, explain,
    policies, meta: {}, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
  };
}

/** Resolve the context and launch S2 at once (hybridSearch entry). */
export async function resolveAndLaunchDecide(
  engine: BrainEngine,
  snapshot: Record<string, string> | null | undefined,
  query: string,
  opts: { rerankerModel?: string; rerankerEnabled: boolean; decide?: DecideSearchOpts; sourceId?: string },
): Promise<DecideSearchContext | undefined> {
  const ctx = await resolveDecideSearchContext(engine, snapshot, opts);
  return ctx ? launchSearchIntent(ctx, query, opts.decide?.intent) : undefined;
}

/**
 * The decide part of the search cache key: each non-off slot's mode, effective
 * threshold, min_keep, calibration row and last resolved model. Undefined when
 * every slot is off, so the all-off key is byte-identical. (The semantic result
 * cache is disabled; this is future compatibility.)
 */
export function decideKnobsPart(ctx: DecideSearchContext | undefined): string | undefined {
  if (!ctx) return undefined;
  const parts = (Object.entries(ctx.policies) as Array<[DecideSlot, SlotPolicy]>)
    .filter(([, p]) => p.requested !== 'off')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([slot, p]) => `${slot}=${p.requested}/${p.effective}:${p.threshold?.toFixed(4) ?? 'none'}:${p.minKeep}:${p.calibration?.ref ?? 'none'}:${p.model ?? 'none'}`);
  return parts.length > 0 ? parts.join(',') : undefined;
}

/** The meta block to merge into HybridSearchMeta (undefined when nothing is visible). */
export function decideMetaFor(ctx: DecideSearchContext | undefined): DecideSearchMeta | undefined {
  return ctx && Object.keys(ctx.meta).length > 0 ? ctx.meta : undefined;
}

const tally = (outcomes: Record<string, string>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const o of Object.values(outcomes)) out[o] = (out[o] ?? 0) + 1;
  return out;
};

// ---------------------------------------------------------------------------
// S3 evidence gate
// ---------------------------------------------------------------------------

/**
 * S3 evidence gate plus everything that rides its position: the S3/S5 packed
 * request and, on the `query` op, the concurrent S4 request over the pre-S3
 * pool. No-op when every slot here is off.
 */
export async function applyEvidenceGate(ctx: DecideSearchContext | undefined, query: string, pool: SearchResult[]): Promise<SearchResult[]> {
  if (!ctx || pool.length === 0) return pool;
  ctx.budget.anchor();
  const answerability = startQueryAnswerability(ctx, query, pool);
  try {
    return await evidenceStage(ctx, query, pool);
  } finally {
    if (answerability) await answerability;
  }
}

async function evidenceStage(ctx: DecideSearchContext, query: string, pool: SearchResult[]): Promise<SearchResult[]> {
  const policy = ctx.policies.evidence;
  const s3Requested = policy !== undefined && policy.requested !== 'off';
  const coRequested = coPackHandlers.filter((h) => ctx.policies[h.slot] && ctx.policies[h.slot]!.requested !== 'off');
  if (!s3Requested && coRequested.length === 0) return pool;
  const judged = pool.slice(0, EVIDENCE_MAX_CANDIDATES);
  const questions = judged.map((r, i) => evidenceQuestion(`evidence:${i}`, i, candidateItem(r), isProtectedResult(r)));
  const subjectFor = (q: DecideQuestion): [string, string] => [q.id, pageSubject(judged[q.rank!]!.source_id, judged[q.rank!]!.slug)];
  const subjects = Object.fromEntries(questions.map(subjectFor));
  const state = { query: { text: query, class: 'query' as const } };
  const receiptBase = { slot: 'evidence' as const, callSite: ctx.callSite, lane: 'hot' as const, provider: policy?.provider ?? '', policy, questions, state, subjects, sourceId: ctx.sourceId ?? null, remote: ctx.remote };
  const coQuestions = new Map(coRequested.map((h) => [h.slot, h.questions(query, judged, ctx.policies[h.slot]!)]));
  const coBase = (h: EvidenceCoPackHandler) => {
    const hp = ctx.policies[h.slot]!;
    const qs = coQuestions.get(h.slot)!;
    return { slot: h.slot, callSite: ctx.callSite, lane: 'hot' as const, provider: hp.provider, policy: hp, questions: qs, state, subjects: Object.fromEntries(qs.map(subjectFor)), sourceId: ctx.sourceId ?? null, remote: ctx.remote };
  };
  const modeOf = (p: SlotPolicy): 'on' | 'shadow' => (p.effective === 'shadow' || (p.effective === 'off' && p.requested === 'shadow') ? 'shadow' : 'on');

  // Inactive slots (on (inactive: reason)) record the reason and take off behavior.
  if (s3Requested && policy.effective === 'off') {
    ctx.meta.evidence = { mode: policy.requested, effective: 'off', skipped: policy.inactive };
    void writeReceipts(ctx.engine, { ...receiptBase, mode: modeOf(policy), outcomes: {}, fallbackOutcome: 'skipped', reason: policy.inactive });
  }
  for (const h of coRequested) {
    const hp = ctx.policies[h.slot]!;
    if (hp.effective !== 'off') continue;
    ctx.meta[h.slot] = { mode: hp.requested, effective: 'off', skipped: hp.inactive };
    void writeReceipts(ctx.engine, { ...coBase(h), mode: modeOf(hp), outcomes: {}, fallbackOutcome: 'skipped', reason: hp.inactive });
  }
  const s3Runs = s3Requested && policy.effective !== 'off';
  const coPacked = coRequested.filter((h) => ctx.policies[h.slot]!.effective !== 'off');
  if (!s3Runs && coPacked.length === 0) return pool;
  const lead = s3Runs ? policy : ctx.policies[coPacked[0]!.slot]!;
  const extra = coPacked.flatMap((h) => coQuestions.get(h.slot)!);

  const run = async (visible: boolean): Promise<{ pool: SearchResult[] }> => {
    const seen = (p: SlotPolicy) => visible && (p.effective === 'on' || ctx.explain || p.shadowWait);
    const failAll = (reason: string, outcome: 'skipped' | 'error') => {
      if (s3Runs) {
        if (seen(policy)) ctx.meta.evidence = { mode: policy.requested, effective: 'off', provider: policy.provider, skipped: reason };
        void writeReceipts(ctx.engine, { ...receiptBase, mode: modeOf(policy), outcomes: {}, fallbackOutcome: outcome, reason });
      }
      for (const h of coPacked) {
        const hp = ctx.policies[h.slot]!;
        if (seen(hp)) ctx.meta[h.slot] = { mode: hp.requested, effective: 'off', provider: hp.provider, skipped: reason };
        void writeReceipts(ctx.engine, { ...coBase(h), mode: modeOf(hp), outcomes: {}, fallbackOutcome: outcome, reason });
      }
      return { pool };
    };
    const deadline = stageDeadlineMs(ctx.budget, ctx.cfg.timeoutMs);
    if (deadline === null) return failAll('late', 'skipped');
    let result: DecideResult;
    try {
      result = await runDecide({
        slot: 'evidence', callSite: ctx.callSite, state, questions: [...questions, ...extra], deadlineMs: deadline,
        provider: lead.provider, remote: ctx.remote, coPacked: coPacked.map((h) => h.slot),
      }, { engine: ctx.engine, config: ctx.cfg, sourceId: ctx.sourceId });
    } catch (err) {
      return failAll(err instanceof DecideError ? err.reason : 'provider_error', 'error');
    }
    let next = pool;
    if (s3Runs) {
      const mode = modeOf(policy);
      const drift = driftReason(policy, result.model_resolved);
      const judgements = questions.map((q) => {
        const a = result.answers[q.id];
        return { id: q.id, rank: q.rank!, p: a && a.kind === 'noul' ? a.p : null, protected: q.protected === true };
      });
      const outcomes: Record<string, EvidenceOutcome> = reduceEvidence(judgements, { threshold: policy.threshold!, margin: policy.margin, minKeep: policy.minKeep });
      const acting = mode === 'on' && !drift;
      void writeReceipts(ctx.engine, {
        ...receiptBase, mode, result, outcomes: drift ? {} : outcomes, fallbackOutcome: 'skipped', ...(drift ? { reason: drift } : {}),
      });
      if (seen(policy)) ctx.meta.evidence = {
        mode: policy.requested, effective: acting ? 'on' : mode === 'shadow' ? 'shadow' : 'off', provider: result.provider,
        model_resolved: result.model_resolved, threshold: policy.threshold, judged: questions.length,
        outcomes: tally(outcomes), latency_ms: result.latency_ms, ...(drift ? { skipped: drift } : {}),
      };
      if (acting) {
        const keep = new Set<number>();
        judged.forEach((r, i) => {
          const p = judgements[i]!.p;
          if (p !== null) r.decide_evidence = { p, clears: p >= policy.threshold! };
          if (outcomes[`evidence:${i}`] !== 'pruned') keep.add(i);
        });
        next = pool.filter((_, i) => i >= judged.length || keep.has(i));
      }
    }
    for (const h of coPacked) {
      const hp = ctx.policies[h.slot]!;
      const applied = h.apply(next, result, hp, ctx, judged);
      next = applied.pool;
      void writeReceipts(ctx.engine, {
        ...coBase(h), result, mode: modeOf(hp), outcomes: applied.outcomes, fallbackOutcome: 'skipped', ...(applied.reason ? { reason: applied.reason } : {}),
      });
      if (seen(hp)) ctx.meta[h.slot] = {
        mode: hp.requested, effective: applied.reason ? 'off' : hp.effective, provider: result.provider, model_resolved: result.model_resolved,
        threshold: hp.threshold, judged: coQuestions.get(h.slot)!.length, outcomes: tally(applied.outcomes), latency_ms: result.latency_ms,
        ...(applied.reason ? { skipped: applied.reason } : {}),
      };
    }
    return { pool: next };
  };

  const acting = (s3Runs && policy.effective === 'on') || coPacked.some((h) => ctx.policies[h.slot]!.effective === 'on');
  if (!acting) {
    // Every running slot is shadow: sampled, and detached unless awaited (--explain / shadow_wait).
    if (!sampled(lead.shadowSample)) return pool;
    if (ctx.explain || [lead, ...coPacked.map((h) => ctx.policies[h.slot]!)].some((p) => p.shadowWait)) {
      await run(true);
      return pool;
    }
    const started = runShadow(async () => { await run(false); });
    if (!started) {
      if (s3Runs) void writeReceipts(ctx.engine, { ...receiptBase, mode: 'shadow', outcomes: {}, fallbackOutcome: 'skipped', reason: 'shadow_queue_full' });
      for (const h of coPacked) void writeReceipts(ctx.engine, { ...coBase(h), mode: 'shadow', outcomes: {}, fallbackOutcome: 'skipped', reason: 'shadow_queue_full' });
    }
    return pool;
  }
  return (await run(true)).pool;
}

// ---------------------------------------------------------------------------
// S1 rerank: receipts in on mode, Jev shadow scoring beside a non-Jev reranker
// ---------------------------------------------------------------------------

/** Kendall tau-a between two orders of the same ids. */
export function kendallTau(a: readonly number[], b: readonly number[]): number {
  const pos = new Map(b.map((id, i) => [id, i]));
  const ids = a.filter((id) => pos.has(id));
  let concordant = 0, discordant = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = pos.get(ids[i]!)! - pos.get(ids[j]!)!;
      if (d < 0) concordant++;
      else if (d > 0) discordant++;
    }
  }
  const pairs = (ids.length * (ids.length - 1)) / 2;
  return pairs === 0 ? 1 : (concordant - discordant) / pairs;
}

/**
 * S1 `on`: one receipt per reranked candidate (outcome kept; answer = the
 * normalized rubric score), or skipped/error receipts with the reason when the
 * slot is inactive or the reranker failed open.
 */
export function recordRerankReceipts(
  ctx: DecideSearchContext | undefined,
  query: string,
  head: readonly SearchResult[],
  meta: { model_resolved: string; latency_ms: number; input_tokens: number } | undefined,
  failure?: string,
): void {
  const policy = ctx?.policies.rerank;
  if (!ctx || !policy || policy.requested === 'off' || policy.effective === 'shadow') return;
  const questions = rerankQuestions(head.map((r) => r.chunk_text || r.title || ''));
  const subjects = Object.fromEntries(head.map((r, i) => [`document_${i}`, pageSubject(r.source_id, r.slug)]));
  const base = {
    slot: 'rerank' as const, mode: 'on' as const, callSite: ctx.callSite, lane: 'hot' as const, provider: policy.provider, policy, questions,
    state: { query: { text: query, class: 'query' as const } }, subjects, sourceId: ctx.sourceId ?? null, remote: ctx.remote,
  };
  const skip = policy.effective === 'off' ? policy.inactive : failure ?? (meta ? undefined : 'provider_error');
  if (skip) {
    ctx.meta.rerank = { mode: policy.requested, effective: 'off', skipped: skip };
    void writeReceipts(ctx.engine, { ...base, outcomes: {}, fallbackOutcome: policy.effective === 'off' || skip === 'egress_denied' ? 'skipped' : 'error', reason: skip });
    return;
  }
  const result: DecideResult = {
    decision_id: randomUUID(), provider: policy.provider, model_alias: policy.provider.replace(/^typesafe:/, ''),
    model_resolved: meta!.model_resolved, refused: {}, usage: { input_tokens: meta!.input_tokens, output_tokens: 0 }, cost_usd: 0,
    latency_ms: meta!.latency_ms, batches: 1, lane: 'hot',
    answers: Object.fromEntries(head.map((r, i) => [`document_${i}`, {
      kind: 'score' as const, score: (r.rerank_score ?? 0) * 3, normalized: r.rerank_score ?? 0, confidence: 1, probabilities: {},
    }])),
  };
  void writeReceipts(ctx.engine, { ...base, result, outcomes: Object.fromEntries(questions.map((q) => [q.id, 'kept'])) });
  ctx.meta.rerank = {
    mode: policy.requested, effective: 'on', provider: policy.provider, model_resolved: meta!.model_resolved,
    judged: head.length, outcomes: { kept: head.length }, latency_ms: meta!.latency_ms, input_tokens: meta!.input_tokens,
  };
}

/**
 * S1 shadow beside a non-Jev reranker (Voyage or none): Jev scores the same
 * top_n_in candidates in parallel under the rerank deadline, through the decide
 * egress gate, with the TypeSafe key; receipts record Jev's order and its rank
 * agreement with today's order. Results never change. Returns a promise the
 * caller awaits only when diagnostics are visible (--explain / shadow_wait).
 */
export function startRerankShadow(ctx: DecideSearchContext | undefined, query: string, head: readonly SearchResult[], timeoutMs: number): ((finalOrder: readonly SearchResult[]) => Promise<void>) | null {
  const policy = ctx?.policies.rerank;
  if (!ctx || !policy || policy.effective !== 'shadow' || head.length === 0) return null;
  if (!sampled(policy.shadowSample)) return null;
  const provider = policy.provider.startsWith('typesafe:') ? policy.provider : DEFAULT_TYPESAFE_PROVIDER;
  const questions: DecideQuestion[] = rerankQuestions(head.map((r) => capRerankDoc(r.chunk_text || r.title || ''))).map((q, i) => ({
    ...q, inputs: { candidate: { ...q.inputs!.candidate!, slug: head[i]!.slug, source_id: head[i]!.source_id ?? 'default' } },
  }));
  const subjects = Object.fromEntries(head.map((r, i) => [`document_${i}`, pageSubject(r.source_id, r.slug)]));
  const state = { query: { text: query, class: 'query' as const } };
  const deadline = stageDeadlineMs(ctx.budget, timeoutMs);
  const pending = deadline === null ? Promise.reject(new DecideError('late', 'late')) : runDecide(
    { slot: 'rerank', callSite: ctx.callSite, state, questions, deadlineMs: deadline, provider, remote: ctx.remote },
    { engine: ctx.engine, config: ctx.cfg, sourceId: ctx.sourceId },
  );
  pending.catch(() => {});
  const visible = ctx.explain || policy.shadowWait;
  const finish = async (finalOrder: readonly SearchResult[]) => {
    let result: DecideResult;
    try {
      result = await pending;
    } catch (err) {
      const reason = err instanceof DecideError ? err.reason : 'provider_error';
      if (visible) ctx.meta.rerank = { mode: 'shadow', effective: 'off', provider, skipped: reason };
      void writeReceipts(ctx.engine, { slot: 'rerank', mode: 'shadow', callSite: ctx.callSite, lane: 'hot', provider, policy, questions, state, subjects, outcomes: {}, fallbackOutcome: 'error', reason, sourceId: ctx.sourceId ?? null, remote: ctx.remote });
      return;
    }
    const jevOrder = questions.map((q, i) => ({ i, s: result.answers[q.id]?.kind === 'score' ? (result.answers[q.id] as { normalized: number }).normalized : -1 }))
      .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.i);
    const index = new Map(head.map((r, i) => [r, i]));
    const todayOrder = finalOrder.map((r) => index.get(r)).filter((i): i is number => i !== undefined);
    const agreement = { top1: jevOrder[0] === todayOrder[0], kendall_tau: Number(kendallTau(todayOrder, jevOrder).toFixed(3)) };
    const rankOf = new Map(jevOrder.map((id, r) => [id, r]));
    const ranked = questions.map((q, i) => ({ ...q, rank: rankOf.get(i) ?? i }));
    void writeReceipts(ctx.engine, {
      slot: 'rerank', mode: 'shadow', callSite: ctx.callSite, lane: 'hot', provider, policy, result, questions: ranked, state, subjects,
      outcomes: Object.fromEntries(questions.map((q) => [q.id, 'kept'])), sourceId: ctx.sourceId ?? null, remote: ctx.remote,
      runMeta: `rank_agreement top1=${agreement.top1 ? 1 : 0} tau=${agreement.kendall_tau}`,
    });
    if (visible) ctx.meta.rerank = { mode: 'shadow', effective: 'shadow', provider, model_resolved: result.model_resolved, judged: head.length, agreement, latency_ms: result.latency_ms };
  };
  if (visible) return finish;
  return (finalOrder) => { runShadow(() => finish(finalOrder)); return Promise.resolve(); };
}

// S5 rides the S3 request (src/core/search/decide-retrieval.ts).
registerEvidenceCoPack(injectionCoPack);
