/**
 * System One retrieval slots on the search path: S2 intent (query routing at
 * hybridSearch entry), S4 answerable on the `query` op (diagnostic only, its
 * own request concurrent with the S3/S5 packed request), the S5 injection
 * co-pack handler (rides the S3 request), and the Jev-reranker egress check.
 *
 * Every path fails open to today's behavior: late, below-threshold or failed
 * S2 answers keep the regex intent; S4 never changes results; S5 never drops
 * content and never crosses the S3 min_keep cut. Imports decide-stage for
 * types only (decide-stage imports this module), so there is no runtime cycle.
 */
import type { SearchResult } from '../types.ts';
import { answerableK, answerableQuestion, reduceAnswerable, ANSWERABLE_MAX_K, type AnswerableOutcome } from '../ai/decide/answerable.ts';
import type { DecideConfig } from '../ai/decide/config.ts';
import { runDecide } from '../ai/decide/index.ts';
import { demoteFlagged, injectionQuestion, reduceInjection } from '../ai/decide/injection.ts';
import { intentRequest, reduceIntent, type IntentCallSite } from '../ai/decide/intent.ts';
import { driftReason, type SlotPolicy } from '../ai/decide/policy.ts';
import { isProtectedResult } from '../ai/decide/protection.ts';
import { writeReceipts } from '../ai/decide/receipts.ts';
import { runShadow, sampled, stageDeadlineMs, type DecideQueryBudget } from '../ai/decide/runtime.ts';
import { SLOT_SPECS } from '../ai/decide/slots.ts';
import { DecideError, type DecideResult, type EvidenceItem } from '../ai/decide/types.ts';
import type { BrainEngine } from '../engine.ts';
import { gradeRetrievalConfidence } from './crag.ts';
import type { DecideSearchContext, EvidenceCoPackHandler } from './decide-stage.ts';
import { intentToDetail, type QueryIntent, type QuerySuggestions } from './query-intent.ts';
import { capRerankDoc } from './rerank.ts';

/** A candidate as decide evidence (page provenance for the egress gate). */
export function candidateItem(r: SearchResult): EvidenceItem {
  const text = capRerankDoc([r.title, r.chunk_text].filter(Boolean).join('\n'));
  return { text, class: 'candidates', slug: r.slug, source_id: r.source_id ?? 'default' };
}

const fmt = (n: number): string => n.toFixed(2);

// ---------------------------------------------------------------------------
// S2 intent
// ---------------------------------------------------------------------------

/** One in-flight S2 question. `done` never rejects. */
export interface IntentAsk {
  launchedAt: number;
  done: Promise<{ result?: DecideResult; error?: string }>;
}

export interface IntentAskInputs {
  engine: BrainEngine;
  cfg: DecideConfig;
  policy: SlotPolicy;
  budget: DecideQueryBudget;
  query: string;
  callSite: IntentCallSite;
  remote: boolean;
  sourceId?: string;
}

/** Launch one S2 question under the stage deadline (the wait bound is applied by the consumer). */
export function askIntent(i: IntentAskInputs): IntentAsk {
  const launchedAt = Date.now();
  const deadline = stageDeadlineMs(i.budget, i.cfg.timeoutMs);
  if (deadline === null) return { launchedAt, done: Promise.resolve({ error: 'late' }) };
  const { state, questions } = intentRequest(i.query, i.callSite);
  const done = runDecide(
    { slot: 'intent', callSite: i.callSite, state, questions, deadlineMs: deadline, provider: i.policy.provider, remote: i.remote },
    { engine: i.engine, config: i.cfg, sourceId: i.sourceId },
  ).then((result) => ({ result }), (err) => ({ error: err instanceof DecideError ? err.reason : 'provider_error' }));
  return { launchedAt, done };
}

/** Wait for `ask` at most `waitMs` from its launch; undefined when late. */
export async function awaitWithin<T>(ask: { launchedAt: number; done: Promise<T> }, waitMs: number): Promise<T | undefined> {
  const left = ask.launchedAt + waitMs - Date.now();
  if (left <= 0) return Promise.race([ask.done, Promise.resolve(undefined)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), left); timer.unref?.(); });
  try {
    return await Promise.race([ask.done, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface IntentVerdict {
  label: string;
  outcome: 'override' | 'fallback_regex' | 'error' | 'skipped';
  reason?: string;
  answer?: string;
}

/**
 * Settle one S2 answer into a label and write its receipt. Shared by the
 * search and think call sites. `settled` undefined = the wait bound passed:
 * the regex label stands (fallback_regex, reason late) and the receipt is
 * written when the answer lands.
 */
export function settleIntent(
  i: IntentAskInputs & { ask: IntentAsk; mode: 'on' | 'shadow'; regexLabel: string },
  settled: { result?: DecideResult; error?: string } | undefined,
): IntentVerdict {
  const { state, questions } = intentRequest(i.query, i.callSite);
  const base = { slot: 'intent' as const, mode: i.mode, callSite: i.callSite, lane: 'hot' as const, provider: i.policy.provider, policy: i.policy, questions, state, sourceId: i.sourceId ?? null, remote: i.remote };
  if (!settled) {
    void i.ask.done.then((late) => writeReceipts(i.engine, { ...base, ...(late.result ? { result: late.result } : {}), outcomes: {}, fallbackOutcome: late.error ? 'error' : 'fallback_regex', reason: late.error ?? 'late' }));
    return { label: i.regexLabel, outcome: 'fallback_regex', reason: 'late' };
  }
  if (!settled.result) {
    void writeReceipts(i.engine, { ...base, outcomes: {}, fallbackOutcome: 'error', reason: settled.error ?? 'provider_error' });
    return { label: i.regexLabel, outcome: 'error', reason: settled.error ?? 'provider_error' };
  }
  const result = settled.result;
  const refused = result.refused['intent:0'];
  if (refused) {
    void writeReceipts(i.engine, { ...base, result, outcomes: {}, fallbackOutcome: 'skipped', reason: refused });
    return { label: i.regexLabel, outcome: 'skipped', reason: refused };
  }
  const drift = driftReason(i.policy, result.model_resolved);
  const r = reduceIntent(result.answers['intent:0'], i.regexLabel, { threshold: i.policy.threshold ?? 1 }, i.callSite);
  const a = result.answers['intent:0'];
  const answer = a?.kind === 'choice' ? `${a.choice} p ${fmt(r.p ?? a.confidence)} (regex ${i.regexLabel})` : undefined;
  void writeReceipts(i.engine, { ...base, result, outcomes: drift ? {} : { 'intent:0': r.outcome }, fallbackOutcome: 'skipped', ...(drift ? { reason: drift } : {}) });
  if (drift) return { label: i.regexLabel, outcome: 'skipped', reason: drift, ...(answer ? { answer } : {}) };
  return { label: i.mode === 'on' ? r.label : i.regexLabel, outcome: r.outcome, ...(answer ? { answer } : {}) };
}

function intentInputs(ctx: DecideSearchContext, policy: SlotPolicy, query: string): IntentAskInputs {
  return { engine: ctx.engine, cfg: ctx.cfg, policy, budget: ctx.budget, query, callSite: 'search', remote: ctx.remote, ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}) };
}

/**
 * Launch the S2 search question as early as hybridSearch can (right after the
 * decide context resolves, alongside the regex classifier). `on` and awaited
 * shadow only; async shadow launches from `applySearchIntent`. `precomputed`
 * is think's one search answer shared by its gather legs.
 */
export function launchSearchIntent(ctx: DecideSearchContext, query: string, precomputed?: IntentAsk): DecideSearchContext {
  const policy = ctx.policies.intent;
  if (!policy || policy.effective === 'off') return ctx;
  if (policy.effective === 'shadow' && !(ctx.explain || policy.shadowWait)) return ctx;
  ctx.intentAsk = precomputed ?? askIntent(intentInputs(ctx, policy, query));
  return ctx;
}

/**
 * S2 at hybridSearch entry: an above-threshold label replaces the regex
 * intent (and re-derives the detail it maps to) before weights, detail and
 * search options are derived; everything else keeps the regex suggestions.
 */
export async function applySearchIntent(ctx: DecideSearchContext, query: string, regex: QuerySuggestions): Promise<QuerySuggestions> {
  const policy = ctx.policies.intent;
  if (!policy || policy.requested === 'off') return regex;
  const inputs = intentInputs(ctx, policy, query);
  const receiptBase = { slot: 'intent' as const, callSite: 'search', lane: 'hot' as const, provider: policy.provider, policy, ...intentRequest(query, 'search'), sourceId: ctx.sourceId ?? null, remote: ctx.remote };
  if (policy.effective === 'off') {
    ctx.meta.intent = { mode: policy.requested, effective: 'off', skipped: policy.inactive };
    void writeReceipts(ctx.engine, { ...receiptBase, mode: policy.requested === 'shadow' ? 'shadow' : 'on', outcomes: {}, fallbackOutcome: 'skipped', reason: policy.inactive });
    return regex;
  }
  const mode = policy.effective === 'shadow' ? 'shadow' : 'on';
  if (mode === 'shadow' && !ctx.intentAsk) {
    if (!sampled(policy.shadowSample)) return regex;
    const started = runShadow(async () => {
      const ask = askIntent(inputs);
      settleIntent({ ...inputs, ask, mode, regexLabel: regex.intent }, await ask.done);
    });
    if (!started) void writeReceipts(ctx.engine, { ...receiptBase, mode, outcomes: {}, fallbackOutcome: 'skipped', reason: 'shadow_queue_full' });
    return regex;
  }
  const ask = ctx.intentAsk ?? askIntent(inputs);
  const waitStarted = Date.now();
  const settled = mode === 'shadow' ? await ask.done : await awaitWithin(ask, ctx.cfg.intentWaitMs);
  ctx.budget.charge(Date.now() - waitStarted);
  const v = settleIntent({ ...inputs, ask, mode, regexLabel: regex.intent }, settled);
  const result = settled?.result;
  ctx.meta.intent = {
    mode: policy.requested, effective: v.outcome === 'override' || v.outcome === 'fallback_regex' ? mode : 'off', provider: policy.provider,
    ...(result ? { model_resolved: result.model_resolved, latency_ms: result.latency_ms } : {}), threshold: policy.threshold,
    ...(v.answer ? { answer: `${v.answer} → ${mode === 'on' ? v.label : `${v.label} (shadow)`}` } : {}),
    ...(v.outcome === 'override' || v.outcome === 'fallback_regex' ? { outcomes: { [v.outcome]: 1 } } : {}),
    ...(v.reason ? { skipped: v.reason } : {}),
  };
  if (mode !== 'on' || v.label === regex.intent) return regex;
  const intent = v.label as QueryIntent;
  return { ...regex, intent, suggestedDetail: intentToDetail(intent) };
}

// ---------------------------------------------------------------------------
// S4 answerable on the query op (diagnostic only)
// ---------------------------------------------------------------------------

export interface AnswerabilityVerdict {
  p: number | null;
  threshold: number | null;
  verdict: AnswerableOutcome;
  k_used: number;
}

/**
 * Start S4 over the pre-S3 top-k, concurrently with the S3/S5 request.
 * Returns a promise the gate awaits before returning (null when S4 does not
 * run on this request or runs as detached shadow). Never changes results.
 */
export function startQueryAnswerability(ctx: DecideSearchContext, query: string, pool: readonly SearchResult[]): Promise<void> | null {
  const policy = ctx.policies.answerable;
  if (!policy || policy.requested === 'off' || pool.length === 0) return null;
  const top = pool.slice(0, ANSWERABLE_MAX_K);
  const evidence = top.map(candidateItem);
  const k = answerableK(query, evidence);
  const state = { query: { text: query, class: 'query' as const } };
  const question = answerableQuestion(evidence.slice(0, Math.max(k, 1)));
  const receiptBase = { slot: 'answerable' as const, callSite: 'query', lane: 'hot' as const, provider: policy.provider, policy, questions: [question], state, sourceId: ctx.sourceId ?? null, remote: ctx.remote, kUsed: k };
  const mode = policy.effective === 'shadow' ? 'shadow' : 'on';
  if (policy.effective === 'off' || k === 0) {
    const reason = policy.effective === 'off' ? policy.inactive : 'payload_too_large';
    ctx.meta.answerable = { mode: policy.requested, effective: 'off', skipped: reason };
    void writeReceipts(ctx.engine, { ...receiptBase, mode: policy.requested === 'shadow' ? 'shadow' : 'on', outcomes: {}, fallbackOutcome: 'skipped', reason });
    return null;
  }
  const signals = {
    complete: k === top.length,
    identityHit: top.slice(0, k).some(isProtectedResult),
    strongGrade: gradeRetrievalConfidence([...pool], { ignoreDecideEvidence: true }).level === 'strong',
  };
  const run = async (visible: boolean): Promise<void> => {
    const deadline = stageDeadlineMs(ctx.budget, ctx.cfg.timeoutMs);
    let result: DecideResult;
    try {
      if (deadline === null) throw new DecideError('late', 'late');
      result = await runDecide({ slot: 'answerable', callSite: 'query', state, questions: [question], deadlineMs: deadline, provider: policy.provider, remote: ctx.remote }, { engine: ctx.engine, config: ctx.cfg, sourceId: ctx.sourceId });
    } catch (err) {
      const reason = err instanceof DecideError ? err.reason : 'provider_error';
      if (visible) ctx.meta.answerable = { mode: policy.requested, effective: 'off', provider: policy.provider, skipped: reason };
      void writeReceipts(ctx.engine, { ...receiptBase, mode, outcomes: {}, fallbackOutcome: reason === 'late' ? 'skipped' : 'error', reason });
      return;
    }
    const refused = result.refused['answerable:0'];
    const drift = refused ? undefined : driftReason(policy, result.model_resolved);
    const a = result.answers['answerable:0'];
    const p = a?.kind === 'noul' ? a.p : null;
    const verdict: AnswerableOutcome = p === null ? 'incomplete' : reduceAnswerable(p, { threshold: policy.threshold!, margin: policy.margin }, signals);
    void writeReceipts(ctx.engine, { ...receiptBase, mode, result, outcomes: drift ? {} : { 'answerable:0': verdict }, fallbackOutcome: 'skipped', ...(drift ? { reason: drift } : refused ? { reason: refused } : {}) });
    if (!visible) return;
    ctx.meta.answerable = {
      mode: policy.requested, effective: drift ? 'off' : mode, provider: result.provider, model_resolved: result.model_resolved, threshold: policy.threshold,
      answer: `p ${p === null ? 'n/a' : fmt(p)}, verdict ${verdict}, k ${k}`, outcomes: { [verdict]: 1 }, latency_ms: result.latency_ms,
      ...(drift ? { skipped: drift } : refused ? { skipped: refused } : {}),
    };
    if (!drift) ctx.answerability = { p, threshold: policy.threshold ?? null, verdict, k_used: k };
  };
  if (mode === 'shadow') {
    if (!sampled(policy.shadowSample)) return null;
    if (ctx.explain || policy.shadowWait) return run(true);
    if (!runShadow(() => run(false))) void writeReceipts(ctx.engine, { ...receiptBase, mode, outcomes: {}, fallbackOutcome: 'skipped', reason: 'shadow_queue_full' });
    return null;
  }
  return run(true);
}

// ---------------------------------------------------------------------------
// S5 injection (co-packed with S3)
// ---------------------------------------------------------------------------

/**
 * Rides the S3 request (registered by decide-stage). `on`: stamps
 * `injection_p` on judged candidates and moves flagged ones below the clean
 * candidates of their evidence class without crossing the S3 min_keep cut.
 */
export const injectionCoPack: EvidenceCoPackHandler = {
  slot: 'injection',
  questions(_query, candidates) {
    return candidates.map((r, i) => injectionQuestion(`injection:${i}`, i, candidateItem(r), isProtectedResult(r)));
  },
  apply(pool, result, policy, ctx, judged) {
    const judgements = judged.map((r, i) => {
      const a = result.answers[`injection:${i}`];
      return { id: `injection:${i}`, p: a?.kind === 'noul' ? a.p : null, protected: isProtectedResult(r) };
    });
    const outcomes = reduceInjection(judgements, { threshold: policy.threshold ?? 1 });
    const drift = result.model_resolved ? driftReason(policy, result.model_resolved) : undefined;
    if (drift) return { pool, outcomes: {}, reason: drift };
    if (policy.effective !== 'on') return { pool, outcomes };
    const flagged = new Set<SearchResult>();
    judged.forEach((r, i) => {
      const p = judgements[i]!.p;
      if (p !== null) r.injection_p = p;
      if (outcomes[`injection:${i}`] === 'demoted') { r.injection_suspected = true; flagged.add(r); }
    });
    if (flagged.size === 0) return { pool, outcomes };
    const cut = ctx.policies.evidence?.minKeep ?? SLOT_SPECS.evidence.defaultMinKeep ?? 0;
    return { pool: demoteFlagged(pool, flagged, (r) => r.evidence ?? 'unclassified', cut), outcomes };
  },
};

// ---------------------------------------------------------------------------
// Jev reranker egress (owner decision 2026-09-30)
// ---------------------------------------------------------------------------

/**
 * True when the Jev reranker (`search.reranker.model typesafe:*`) would
 * receive a candidate from a source in `decide.egress.deny_sources`: the
 * query skips reranking (fail open to RRF order) with reason egress_denied.
 */
export function rerankEgressDenied(decideSnapshot: Record<string, string> | undefined, model: string | undefined, head: readonly SearchResult[]): boolean {
  const raw = decideSnapshot?.['decide.egress.deny_sources'];
  if (!raw || !model?.startsWith('typesafe:')) return false;
  let denied: unknown;
  try { denied = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(denied) || denied.length === 0) return false;
  return head.some((r) => denied.includes(r.source_id ?? 'default'));
}
