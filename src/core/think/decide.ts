/**
 * System One inside `gbrain think`.
 *
 * - S2 think question (`temporal | knowledge_update | other`) replaces
 *   `classifyIntent` as the trajectory-gating decision; the regex stays the
 *   default and the tie source. Launched before gather, awaited after gather
 *   for at most `decide.slots.intent.wait_ms`.
 * - S2 search question: asked once before gather and shared with gather's
 *   hybridSearch (one precomputed answer, call site `search`).
 * - S4 answerable: one separate call over think's final gathered evidence
 *   (pages, takes; trajectory is never sent), after gather and before
 *   synthesis. `on` abstains only when the verdict is `abstain`, which needs
 *   complete coverage and no deterministic evidence signal (identity hit or a
 *   strong CRAG grade computed without S3). Abstention lists the nearest pages
 *   and skips the synthesis call.
 *
 * Undefined (no work at all) when S2 and S4 are both off. Every failure takes
 * the fail-open path: regex intent, normal synthesis.
 */
import type { BrainEngine, TakeHit } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { loadConfigSnapshot } from '../config-snapshot.ts';
import { answerableK, answerableQuestion, reduceAnswerable } from '../ai/decide/answerable.ts';
import { pickDecideConfig, readDecideConfig, type DecideConfig } from '../ai/decide/config.ts';
import { hasTypesafeKey, runDecide } from '../ai/decide/index.ts';
import { packShape } from '../ai/decide/pack.ts';
import { driftReason, resolveSlotPolicy, type SlotPolicy } from '../ai/decide/policy.ts';
import { isProtectedResult } from '../ai/decide/protection.ts';
import { writeReceipts } from '../ai/decide/receipts.ts';
import { createQueryBudget, runShadow, sampled, stageDeadlineMs, type DecideQueryBudget } from '../ai/decide/runtime.ts';
import { intentRequest } from '../ai/decide/intent.ts';
import { DecideError, type EvidenceItem } from '../ai/decide/types.ts';
import { gradeRetrievalConfidence } from '../search/crag.ts';
import { calibrationState } from '../search/decide-stage.ts';
import { askIntent, awaitWithin, candidateItem, settleIntent, type IntentAsk, type IntentAskInputs } from '../search/decide-retrieval.ts';
import { capRerankDoc } from '../search/rerank.ts';
import type { Intent } from './intent.ts';
import type { ThinkResult } from './index.ts';

export interface ThinkAbstention {
  p: number;
  threshold: number;
  /** Nearest gathered pages (slugs), listed in the abstention answer. */
  nearest: string[];
}

export interface ThinkDecide {
  /** S2 search answer for gather's hybridSearch (on mode only). */
  searchIntent?: IntentAsk;
  /** The trajectory-gating intent: S2's think label when on and above threshold, else the regex label. */
  trajectoryIntent(regex: Intent): Promise<Intent>;
  /** S4 over final gathered evidence; an abstention only when `on` and the verdict is abstain. */
  answerability(input: { pages: readonly SearchResult[]; takes: readonly TakeHit[]; trajectory: boolean }): Promise<ThinkAbstention | null>;
}

interface Ctx {
  engine: BrainEngine;
  cfg: DecideConfig;
  budget: DecideQueryBudget;
  remote: boolean;
  sourceId?: string;
  question: string;
}

const NEAREST_PAGES = 5;

function intentThink(ctx: Ctx, policy: SlotPolicy, regexNow: Intent, launch: boolean): ThinkDecide['trajectoryIntent'] {
  const inputs: IntentAskInputs = { engine: ctx.engine, cfg: ctx.cfg, policy, budget: ctx.budget, query: ctx.question, callSite: 'think', remote: ctx.remote, ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}) };
  if (policy.requested === 'off' || !launch) return async (regex) => regex;
  if (policy.effective === 'off') {
    return async (regex) => {
      void writeReceipts(ctx.engine, { slot: 'intent', mode: policy.requested === 'shadow' ? 'shadow' : 'on', callSite: 'think', lane: 'hot', provider: policy.provider, policy, ...intentRequest(ctx.question, 'think'), outcomes: {}, fallbackOutcome: 'skipped', reason: policy.inactive });
      return regex;
    };
  }
  if (policy.effective === 'shadow') {
    if (sampled(policy.shadowSample)) {
      runShadow(async () => {
        const ask = askIntent(inputs);
        settleIntent({ ...inputs, ask, mode: 'shadow', regexLabel: regexNow }, await ask.done);
      });
    }
    return async (regex) => regex;
  }
  const ask = askIntent(inputs);
  return async (regex) => {
    // Gather already gave the answer time to land; wait at most wait_ms more.
    const settled = await awaitWithin({ launchedAt: Date.now(), done: ask.done }, ctx.cfg.intentWaitMs);
    return settleIntent({ ...inputs, ask, mode: 'on', regexLabel: regex }, settled).label as Intent;
  };
}

function answerability(ctx: Ctx, policy: SlotPolicy): ThinkDecide['answerability'] {
  return async ({ pages, takes, trajectory }) => {
    if (policy.requested === 'off') return null;
    const sourceOf = new Map(pages.map((p) => [p.slug, p.source_id ?? 'default']));
    // Takes held by anyone but `world` are private: never sent to a third party without decide.egress.private=allow.
    const thirdParty = policy.provider.startsWith('typesafe:');
    const sendable = takes.filter((t) => !thirdParty || ctx.cfg.egressPrivate === 'allow' || t.holder === 'world');
    const evidence: EvidenceItem[] = [
      ...pages.map(candidateItem),
      ...sendable.map((t) => ({ text: capRerankDoc(t.claim), class: 'candidates' as const, slug: t.page_slug, source_id: sourceOf.get(t.page_slug) ?? ctx.sourceId ?? 'default' })),
    ];
    if (evidence.length === 0) return null;
    const k = answerableK(ctx.question, evidence);
    const state = { query: { text: ctx.question, class: 'query' as const } };
    const question = answerableQuestion(evidence.slice(0, Math.max(k, 1)));
    const receiptBase = { slot: 'answerable' as const, callSite: 'think', lane: 'hot' as const, provider: policy.provider, policy, questions: [question], state, sourceId: ctx.sourceId ?? null, remote: ctx.remote, kUsed: k };
    const mode = policy.effective === 'shadow' ? 'shadow' : 'on';
    if (policy.effective === 'off' || k === 0) {
      void writeReceipts(ctx.engine, { ...receiptBase, mode: policy.requested === 'shadow' ? 'shadow' : 'on', outcomes: {}, fallbackOutcome: 'skipped', reason: policy.effective === 'off' ? policy.inactive : 'payload_too_large' });
      return null;
    }
    const signals = {
      complete: k === evidence.length && sendable.length === takes.length && !trajectory,
      identityHit: pages.some(isProtectedResult),
      strongGrade: gradeRetrievalConfidence([...pages], { ignoreDecideEvidence: true }).level === 'strong',
    };
    const run = async (): Promise<ThinkAbstention | null> => {
      ctx.budget.anchor();
      const deadline = stageDeadlineMs(ctx.budget, ctx.cfg.timeoutMs);
      try {
        if (deadline === null) throw new DecideError('late', 'late');
        const result = await runDecide({ slot: 'answerable', callSite: 'think', state, questions: [question], deadlineMs: deadline, provider: policy.provider, remote: ctx.remote }, { engine: ctx.engine, config: ctx.cfg, sourceId: ctx.sourceId });
        const refused = result.refused['answerable:0'];
        const drift = refused ? undefined : driftReason(policy, result.model_resolved);
        const a = result.answers['answerable:0'];
        const p = a?.kind === 'noul' ? a.p : null;
        const verdict = p === null ? 'incomplete' : reduceAnswerable(p, { threshold: policy.threshold!, margin: policy.margin }, signals);
        void writeReceipts(ctx.engine, { ...receiptBase, mode, result, outcomes: drift ? {} : { 'answerable:0': verdict }, fallbackOutcome: 'skipped', ...(drift ? { reason: drift } : refused ? { reason: refused } : {}) });
        if (mode !== 'on' || drift || verdict !== 'abstain' || p === null) return null;
        return { p, threshold: policy.threshold!, nearest: pages.slice(0, NEAREST_PAGES).map((pg) => pg.slug) };
      } catch (err) {
        const reason = err instanceof DecideError ? err.reason : 'provider_error';
        void writeReceipts(ctx.engine, { ...receiptBase, mode, outcomes: {}, fallbackOutcome: reason === 'late' ? 'skipped' : 'error', reason });
        return null;
      }
    };
    if (mode === 'shadow') {
      if (sampled(policy.shadowSample) && !runShadow(async () => { await run(); })) {
        void writeReceipts(ctx.engine, { ...receiptBase, mode, outcomes: {}, fallbackOutcome: 'skipped', reason: 'shadow_queue_full' });
      }
      return null;
    }
    return run();
  };
}

/** Resolve S2/S4 for one think call and launch its S2 questions before gather. */
export async function startThinkDecide(
  engine: BrainEngine,
  opts: { question: string; remote?: boolean; sourceId?: string; withTrajectory?: boolean },
  regexIntent: Intent,
): Promise<ThinkDecide | undefined> {
  const snapshot = pickDecideConfig(await loadConfigSnapshot(engine).catch(() => null));
  if (!snapshot) return undefined;
  const cfg = readDecideConfig(snapshot);
  if (cfg.slots.intent.mode === 'off' && cfg.slots.answerable.mode === 'off') return undefined;
  const { rows, resolved } = await calibrationState(engine);
  const policy = (slot: 'intent' | 'answerable', callSite: string) => resolveSlotPolicy({
    cfg, slot, callSite, packShape: slot === 'answerable' ? packShape('answerable', [], { unpacked: true }) : packShape('intent'),
    calibrations: rows, lastResolved: resolved, hasTypesafeKey: hasTypesafeKey(),
  });
  const ctx: Ctx = { engine, cfg, budget: createQueryBudget(cfg.queryBudgetMs), remote: opts.remote !== false, question: opts.question, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}) };
  const searchPolicy = policy('intent', 'search');
  return {
    ...(searchPolicy.effective === 'on' ? {
      searchIntent: askIntent({ engine, cfg, policy: searchPolicy, budget: ctx.budget, query: opts.question, callSite: 'search', remote: ctx.remote, ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}) }),
    } : {}),
    trajectoryIntent: intentThink(ctx, policy('intent', 'think'), regexIntent, opts.withTrajectory !== false),
    answerability: answerability(ctx, policy('answerable', 'think')),
  };
}

/** The abstention answer: no synthesis call; the nearest gathered pages are listed, never cited as support. */
export function thinkAbstainResult(
  question: string,
  gather: { pages: SearchResult[]; takes: TakeHit[]; graphSlugs: string[]; diagnostics: ThinkResult['diagnostics'] },
  modelUsed: string,
  warnings: string[],
  abstention: ThinkAbstention,
): ThinkResult {
  const nearest = gather.pages.slice(0, NEAREST_PAGES).map((p) => `- ${p.title || p.slug} [${p.slug}]`);
  warnings.push('DECIDE_ABSTAINED');
  return {
    question,
    answer: `The brain has no evidence that answers this question.\nNearest pages found:\n${nearest.length > 0 ? nearest.join('\n') : '(none)'}`,
    citations: [],
    gaps: ['no stored evidence answers this question'],
    pagesGathered: gather.pages.length,
    takesGathered: gather.takes.length,
    graphHits: gather.graphSlugs.length,
    modelUsed,
    rounds: 0,
    warnings,
    synthesisOk: false,
    synthesis_status: 'ok',
    usage: null,
    abstained: abstention,
    diagnostics: {
      pagesFromHybrid: gather.diagnostics.pagesFromHybrid,
      takesFromKeyword: gather.diagnostics.takesFromKeyword,
      takesFromVector: gather.diagnostics.takesFromVector,
      graphHits: gather.diagnostics.graphHits,
    },
  };
}
