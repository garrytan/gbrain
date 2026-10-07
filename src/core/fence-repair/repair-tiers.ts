/**
 * #6188 fence repair tiers for one candidate: the free tiers (Tier 1 rules,
 * Tier 2 verified holders) decide a proposal or what is left, and Tier 3 (the
 * chat model) runs only for residual rows a model can realign, under the
 * per-page cap, the daily USD ledger and the attempt memo.
 *
 * Tier 2 (E12): each `holder_unresolved` cell is looked up with
 * `resolveStrictEntityReference` (no same-name arm), accepting only a
 * `people/` or `companies/` page, with private pages excluded on a world
 * page. A miss stays residual and, being manual-only after Tier 2, is never
 * sent to the model.
 *
 * Every proposal, whichever tier made it, passes `validateFenceRepair`
 * gates (a)-(g) against the bytes as read and is a Tier 1 fixed point (a
 * model answer that is not is normalized once and checked again, E14).
 * Messages and stored verdicts carry reason codes, gate letters and row
 * numbers only.
 */
import type { BrainEngine } from '../engine.ts';
import { resolveStrictEntityReference } from '../entities/resolve.ts';
import { chatCallUsd, estimateChatCallUsd, type DailyLedger } from '../budget/daily-ledger.ts';
import type { PricingOverrides } from '../budget/reservation-cost.ts';
import type { NoPricingGuidance } from '../budget/no-pricing.ts';
import type { CapSource } from '../consent.ts';
import { attemptMemoKey, type AttemptClaim, type AttemptStore } from './attempts.ts';
import { storedFenceRows } from './import-step.ts';
import { safeNormalizeFences, FENCE_RULES_VERSION } from './normalize.ts';
import { extractRawRows } from './raw-rows.ts';
import { scanCanonicalFences } from './refusal.ts';
import { GATE_REASONS, renderFenceFix, type FenceMessageLocation } from './reasons.ts';
import { residualLocation } from './tier1.ts';
import { validateFenceRepair } from './validate.ts';
import { callTier3, FENCE_REPAIR_PROMPT_VERSION, spliceTier3, tier3Requests, tier3TokenBudget, TIER3_REASONS, type Tier3Request, type Tier3Table } from './llm.ts';
import type { FenceCtx, FenceFix, FenceIssue, FencePage, FenceReason, GateLetter } from './types.ts';
import type { FenceTarget } from './repair-io.ts';

export type FenceAnalysis =
  | { status: 'clean' }
  | { status: 'proposal'; tier: 'deterministic' | 'resolver'; after: FencePage; fixes: FenceFix[]; ctx: FenceCtx }
  | { status: 'llm'; base: FencePage; fixes: FenceFix[]; residual: FenceIssue[]; requests: Tier3Request[]; ctx: FenceCtx }
  | { status: 'manual'; reason: FenceReason; location: FenceMessageLocation; resolution: string; gate?: GateLetter; rows?: number[] };

/** The holder text of the row an issue names, read from the bytes as written. */
function holderAt(page: FencePage, issue: FenceIssue): string | null {
  const text = issue.section === 'body' ? page.compiled_truth : page.timeline;
  for (const fence of extractRawRows(text ?? '', issue.section).fences) {
    if (fence.kind !== issue.fence) continue;
    const row = fence.rows.find(r => r.line === issue.line);
    const who = row?.byColumn.get('who')?.text.trim();
    if (who) return who;
  }
  return null;
}

/** Tier 2: the verified `people/` / `companies/` slug for each unresolved holder text that resolves strictly. */
async function verifyHolders(engine: BrainEngine, sourceId: string, page: FencePage, issues: readonly FenceIssue[], ctx: FenceCtx): Promise<Map<string, string>> {
  const verified = new Map<string, string>();
  const texts = new Set(issues.filter(i => i.reason === 'holder_unresolved').map(i => holderAt(page, i)).filter((t): t is string => !!t));
  for (const text of texts) {
    const found = await resolveStrictEntityReference(engine, sourceId, text, { excludePrivate: ctx.pageVisibility === 'world' });
    if (found.slug && /^(people|companies)\//.test(found.slug)) verified.set(text, found.slug);
  }
  return verified;
}

function manual(issues: readonly FenceIssue[], extra: { gate?: GateLetter; rows?: number[]; reason?: FenceReason } = {}): FenceAnalysis {
  const location = residualLocation(issues);
  const at = extra.reason ? { ...location, reason: extra.reason, rows: extra.rows ?? location.rows } : location;
  return { status: 'manual', reason: at.reason, location: at, resolution: renderFenceFix(at), ...(extra.gate ? { gate: extra.gate } : {}), ...(extra.rows ? { rows: extra.rows } : {}) };
}

/** A page whose output is a Tier 1 fixed point that compiles. */
function settled(page: FencePage, ctx: FenceCtx): boolean {
  const again = safeNormalizeFences(page, ctx);
  return !again.fixes.length && !again.residual.length && !scanCanonicalFences(page).defects.length;
}

/**
 * The free tiers over a candidate's current bytes: `clean` (nothing to do),
 * a validated `proposal`, `llm` (only Tier 3 residuals are left, with the
 * model requests), or `manual` with the exact location-only edit.
 */
export async function analyzeFences(engine: BrainEngine, target: FenceTarget, opts: { pageId: number | null }): Promise<FenceAnalysis> {
  const page = target.page;
  if (!scanCanonicalFences(page).defects.length) return { status: 'clean' };
  let ctx: FenceCtx = { ...target.ctx };
  let base = safeNormalizeFences(page, ctx);
  if (base.fixes.some(f => f.class === 'renumber')) {
    ctx = { ...ctx, storedRows: await storedFenceRows(engine, target.sourceId, target.slug, opts.pageId) };
    base = safeNormalizeFences(page, ctx);
  }
  let tier: 'deterministic' | 'resolver' = 'deterministic';
  if (base.residual.some(i => i.reason === 'holder_unresolved')) {
    const verified = await verifyHolders(engine, target.sourceId, page, base.residual, ctx);
    if (verified.size) {
      ctx = { ...ctx, verifiedHolders: verified };
      base = safeNormalizeFences(page, ctx);
      tier = 'resolver';
    }
  }
  if (!base.residual.length) {
    if (!base.fixes.length) return manual([{ row: null, column: null, ...scanIssue(page) }]);
    const verdict = validateFenceRepair(page, base.page, { ...ctx, tier, issues: base.fixes });
    if (!verdict.ok) return manual(base.fixes.map(f => ({ ...f, reason: verdict.reason })), { gate: verdict.gate, rows: verdict.rows, reason: verdict.reason });
    if (!settled(base.page, ctx)) return manual(base.fixes.map(f => ({ ...f, reason: 'normalizer_failed' as const })), { reason: 'normalizer_failed' });
    return { status: 'proposal', tier, after: base.page, fixes: base.fixes, ctx };
  }
  const manualIssues = base.residual.filter(i => !TIER3_REASONS.has(i.reason));
  if (manualIssues.length) return manual(manualIssues);
  const { requests, ineligible } = tier3Requests(base.page, base.residual, ctx.pageVisibility);
  if (ineligible.length || !requests.length) return manual(base.residual);
  return { status: 'llm', base: base.page, fixes: base.fixes, residual: base.residual, requests, ctx };
}

function scanIssue(page: FencePage): Pick<FenceIssue, 'fence' | 'section' | 'reason' | 'line'> {
  const defect = scanCanonicalFences(page).defects[0]!;
  return { fence: defect.fence, section: defect.section, reason: defect.reason, line: defect.line };
}

/** The first call's worst-case estimate for every request of a page. */
export function tier3Estimate(requests: readonly Tier3Request[], pricing: { model: string; overrides?: PricingOverrides; capSource: CapSource }):
  { ok: true; usd: number; estimated: boolean } | { ok: false; reason: 'no_pricing'; guidance: NoPricingGuidance } {
  let usd = 0;
  let estimated = false;
  for (const req of requests) {
    const budget = tier3TokenBudget(req, pricing.model);
    const quote = estimateChatCallUsd({ model: pricing.model, inputTokens: budget.inputTokens, maxOutputTokens: budget.maxOutputTokens, overrides: pricing.overrides, capSource: pricing.capSource });
    if (!quote.ok) return quote;
    usd += quote.quote.usd;
    estimated ||= quote.quote.estimated;
  }
  return { ok: true, usd, estimated };
}

export interface Tier3Deps {
  ledger: DailyLedger;
  store: AttemptStore;
  model: string;
  overrides?: PricingOverrides;
  capSource: CapSource;
  perPageUsd: number;
  perDayUsd: number;
  /** What is left of the run's own paid-model allowance (`--max-usd`, doctor); undefined = none. */
  allowanceUsd?: number;
  /** Per-call provider timeout. */
  timeoutMs: number;
  now: () => Date;
}

export type Tier3Outcome =
  | { ok: true; after: FencePage; spentUsd: number; claim: AttemptClaim; cleared: FenceReason[] }
  | { ok: false; reason: FenceReason | 'claimed_elsewhere'; spentUsd: number; message: string; gate?: GateLetter; rows?: number[];
    /** The whole run should stop (the daily ledger refused the call). */
    stop?: boolean; resetsAt?: string; memoHit?: boolean; guidance?: NoPricingGuidance };

/** The attempt-store candidate of a target: one per file path, else per page slug. */
export function attemptCandidate(target: FenceTarget, incarnation: string) {
  return { sourceId: target.sourceId, incarnation, key: target.path ? `path:${target.path}` : `slug:${target.slug}` };
}

export function tier3Memo(target: FenceTarget, model: string): string {
  return attemptMemoKey({ contentSha256: target.before, model, fenceVersion: FENCE_RULES_VERSION, promptVersion: FENCE_REPAIR_PROMPT_VERSION });
}

/**
 * Tier 3 for one candidate: claim the attempt (a rejected memo returns its
 * stored verdict and spends nothing), call the model per fence under the
 * ledger, splice, normalize, validate, and re-ask once after a structural
 * failure (gate (a) or (e)); any other gate, or a HOLD, is final.
 * On success the claim is left `settled`: the caller publishes it after the
 * write lands, or marks it transient when the write could not run.
 */
export async function runTier3(target: FenceTarget, analysis: Extract<FenceAnalysis, { status: 'llm' }>, incarnation: string, deps: Tier3Deps): Promise<Tier3Outcome> {
  const claimed = await deps.store.claim(attemptCandidate(target, incarnation), tier3Memo(target, deps.model));
  if (!claimed.ok) {
    if (claimed.reason === 'claimed_elsewhere') return { ok: false, reason: 'claimed_elsewhere', spentUsd: 0, message: 'Another repair run holds this candidate; it is left to that run.' };
    if (claimed.reason === 'store_unavailable') return { ok: false, reason: 'ledger_unavailable', spentUsd: 0, message: 'The repair attempt store could not be read, so no model call was made.' };
    const record = claimed.record;
    const reason = (record.reason ?? 'still_invalid') as FenceReason;
    return { ok: false, reason, spentUsd: 0, memoHit: true, ...(record.gate ? { gate: record.gate as GateLetter } : {}), ...(record.rows ? { rows: record.rows } : {}),
      message: `The model's repair of these exact bytes was already rejected (${reason}${record.gate ? `, gate ${record.gate}` : ''}); no new call is made until the file, the model or the rules change.` };
  }
  let claim = claimed.claim;
  let spent = 0;
  const tables = new Map<number, { table: Tier3Table; text: string }>();
  const transient = async (reason: FenceReason, message: string, extra: Partial<Extract<Tier3Outcome, { ok: false }>> = {}): Promise<Tier3Outcome> => {
    await deps.store.transient(claim, reason);
    return { ok: false, reason, spentUsd: spent, message, ...extra };
  };
  const reject = async (reason: FenceReason, message: string, gate?: GateLetter, rows?: number[]): Promise<Tier3Outcome> => {
    await deps.store.reject(claim, { reason, ...(gate ? { gate } : {}), ...(rows ? { rows } : {}) });
    return { ok: false, reason, spentUsd: spent, message, ...(gate ? { gate } : {}), ...(rows ? { rows } : {}) };
  };
  let correction: { index: number; gate: GateLetter; rows: number[] } | null = null;
  for (let round = 0; round < 2; round++) {
    const indexes = correction ? [correction.index] : analysis.requests.map((_, i) => i);
    for (const index of indexes) {
      const req = analysis.requests[index]!;
      const prior = correction ? tables.get(index)!.text : undefined;
      const budget = tier3TokenBudget(req, deps.model, prior !== undefined ? { answer: prior } : undefined);
      const quote = estimateChatCallUsd({ model: deps.model, inputTokens: budget.inputTokens, maxOutputTokens: budget.maxOutputTokens, overrides: deps.overrides, capSource: deps.capSource });
      if (!quote.ok) return transient('no_pricing', `A spend cap is set but gbrain has no price for ${deps.model}; no call was made.`, { guidance: quote.guidance });
      const estimate = quote.quote.usd;
      if (spent + estimate > deps.perPageUsd + 1e-9) {
        if (correction) return reject(GATE_REASONS[correction.gate], `The model's repair failed gate ${correction.gate} and a corrective re-ask would exceed the per-page cap.`, correction.gate, correction.rows);
        return transient('budget_exhausted', `The estimated model cost ($${estimate.toFixed(4)}) exceeds fences.repair.max_usd_per_page ($${deps.perPageUsd.toFixed(2)}).`);
      }
      if (deps.allowanceUsd !== undefined && spent + estimate > deps.allowanceUsd + 1e-9) {
        if (correction) return reject(GATE_REASONS[correction.gate], `The model's repair failed gate ${correction.gate} and this run's allowance cannot cover a corrective re-ask.`, correction.gate, correction.rows);
        return transient('budget_exhausted', `This run's paid-model allowance ($${deps.allowanceUsd.toFixed(4)} left) cannot cover the estimate ($${estimate.toFixed(4)}).`, { stop: true });
      }
      const reserved = await deps.ledger.reserve(estimate, { capUsd: deps.perDayUsd });
      if (!reserved.ok) {
        if (reserved.reason === 'ledger_unavailable') return transient('ledger_unavailable', 'The spend ledger could not be read, so no model call was made; the next run retries.');
        return transient('budget_exhausted', `The daily fence-repair budget is spent ($${(reserved.committedUsd + reserved.reservedUsd).toFixed(4)} of $${reserved.capUsd.toFixed(2)} committed or reserved today; `
          + `this call needs $${reserved.estimateUsd.toFixed(4)}). It resets at ${reserved.resetsAt}.`, { stop: true, resetsAt: reserved.resetsAt });
      }
      const moved = await deps.store.dispatched(claim, reserved.reservation.id);
      if (!moved.ok) {
        await deps.ledger.release(reserved.reservation.id);
        if (moved.reason === 'lost_claim') return { ok: false, reason: 'claimed_elsewhere', spentUsd: spent, message: 'Another repair run took over this candidate.' };
        return reject(correction ? GATE_REASONS[correction.gate] : 'llm_malformed', 'The attempt reached its call limit.', correction?.gate, correction?.rows);
      }
      claim = moved.claim;
      if (!await deps.ledger.dispatch(reserved.reservation.id)) {
        await deps.ledger.release(reserved.reservation.id);
        await deps.store.settled(claim).then(r => { if (r.ok) claim = r.claim; });
        return transient('ledger_unavailable', 'The spend ledger refused to dispatch the reservation, so no model call was made.');
      }
      const answer = await callTier3(req, { model: deps.model, timeoutMs: deps.timeoutMs, ...(correction ? { correction: { answer: prior!, gate: correction.gate, rows: correction.rows } } : {}) });
      const actual = answer.result ? chatCallUsd(deps.model, { inputTokens: answer.result.usage.input_tokens, outputTokens: answer.result.usage.output_tokens }, deps.overrides).usd : estimate;
      const settle = await deps.ledger.settle(reserved.reservation.id, actual);
      spent += settle.settled ? settle.actualUsd : actual;
      const done = await deps.store.settled(claim);
      if (done.ok) claim = done.claim;
      if (!answer.ok && answer.reason === 'llm_unavailable') return transient('llm_unavailable', `The repair model was unavailable (${answer.error ?? 'provider error'}); the next run retries.`);
      if (!answer.ok && answer.reason === 'llm_declined') return reject('llm_declined', 'The repair model declined: a row has more than one reasonable reading, so it needs a person.');
      if (!answer.ok && answer.reason !== 'row_count_changed') return reject(answer.reason, `The repair model's answer was unusable (${answer.reason}).`);
      tables.set(index, { table: answer.table, text: answer.text });
    }
    let current: FencePage | null = analysis.base;
    for (const [index, req] of analysis.requests.entries()) current = current && spliceTier3(current, req, tables.get(index)!.table);
    let failure: { gate: GateLetter; rows: number[]; index: number } | null = null;
    let after: FencePage | null = null;
    if (!current) {
      const index = analysis.requests.findIndex((req, i) => tables.get(i)!.table.rows.length !== req.rows.length);
      failure = { gate: 'e', rows: [], index: Math.max(0, index) };
    } else {
      const final = safeNormalizeFences(current, analysis.ctx);
      const verdict = final.residual.length ? { ok: false as const, gate: 'a' as GateLetter, rows: final.residual.flatMap(i => i.row === null ? [] : [i.row]), fence: final.residual[0]!.fence, section: final.residual[0]!.section }
        : validateFenceRepair(target.page, final.page, { ...analysis.ctx, tier: 'llm', issues: [...analysis.fixes, ...analysis.residual] });
      if (verdict.ok && settled(final.page, analysis.ctx)) after = final.page;
      else {
        const v = verdict.ok ? { gate: 'a' as GateLetter, rows: [] as number[], fence: null, section: null } : verdict;
        const index = analysis.requests.findIndex(req => req.kind === v.fence && req.section === v.section);
        failure = { gate: v.gate, rows: v.rows, index: index < 0 ? 0 : index };
      }
    }
    if (after) {
      const cleared = [...new Set(analysis.residual.map(i => i.reason))].sort();
      return { ok: true, after, spentUsd: spent, claim, cleared };
    }
    // Only a structural failure earns the re-ask: naming gate (f) steers a model toward whatever placement the gates allow.
    if (round === 0 && (failure!.gate === 'a' || failure!.gate === 'e')) { correction = failure; continue; }
    return reject(GATE_REASONS[failure!.gate], `LLM repair rejected by gate ${failure!.gate}; needs a manual edit${failure!.rows.length ? ` at row(s) ${failure!.rows.join(', ')}` : ''}.`, failure!.gate, failure!.rows);
  }
  return reject('still_invalid', 'LLM repair did not settle.');
}
