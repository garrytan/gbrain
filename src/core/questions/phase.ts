/**
 * Cycle phase `standing_questions`: refreshes active pinned questions under one
 * BudgetMeter (`cycle.standing_questions.budget_usd`, default $1.00 per run)
 * and `cycle.standing_questions.max_per_cycle` (default 5). Order: never
 * answered, then stale, then new evidence in scope since the watermark. A pin
 * refreshed (or attempted) within its cooldown (`cooldown_days` on the pin, or
 * `cycle.standing_questions.cooldown_days`, default 1) waits, except a pin that
 * was never attempted. Inactive and draft-only pins follow their own rules
 * (inactive: never refreshed; draft: refreshed, not served by context_pack).
 *
 * The phase also brings question pages in line with their pins (materializes
 * pages for pins made over MCP or imported from dream.auto_think, archives
 * unpinned ones) and stamps `cycle.standing_questions.last_run_at`, which is
 * how receipts know a scheduler exists. Kill switch:
 * `cycle.standing_questions.enabled=false`.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { BudgetMeter, loadAllowUnpriced, loadPricingOverrides, parseBudgetUsd } from '../cycle/budget-meter.ts';
import { evaluateAnswer, newEvidenceSinceWatermark } from './freshness.ts';
import { syncQuestionPage } from './pages.ts';
import { LAST_PHASE_RUN_KEY } from './receipt.ts';
import { refreshPin, type QuestionChatFn, type RefreshHooks } from './refresh.ts';
import { listPins, pinId, type PinRow } from './store.ts';
import { DEFAULT_BUDGET_USD } from './service.ts';

export interface StandingQuestionsPhaseOpts {
  dryRun: boolean;
  signal?: AbortSignal;
  /** Test seams. */
  chat?: QuestionChatFn;
  hooks?: RefreshHooks;
}

async function numberConfig(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key).catch(() => null);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function runPhaseStandingQuestions(engine: BrainEngine, opts: StandingQuestionsPhaseOpts): Promise<PhaseResult> {
  const enabled = await engine.getConfig('cycle.standing_questions.enabled').catch(() => null);
  if (enabled === 'false') {
    return { phase: 'standing_questions', status: 'skipped', duration_ms: 0, summary: 'cycle.standing_questions.enabled is false', details: { reason: 'disabled' } };
  }
  const maxPerCycle = Math.max(1, Math.floor(await numberConfig(engine, 'cycle.standing_questions.max_per_cycle', 5)));
  const defaultCooldownDays = Math.max(0, await numberConfig(engine, 'cycle.standing_questions.cooldown_days', 1));
  const budgetUsd = parseBudgetUsd(await engine.getConfig('cycle.standing_questions.budget_usd'), DEFAULT_BUDGET_USD);
  const meter = new BudgetMeter({
    budgetUsd, phase: 'standing_questions', pricingOverrides: await loadPricingOverrides(engine),
    allowUnpriced: (await engine.getConfig('cycle.standing_questions.allow_unpriced')) === 'true' || await loadAllowUnpriced(engine),
  });
  const ctx = { engine, config: { engine: engine.kind } as never, remote: false as const };
  const pins = await listPins(engine, { includeArchived: true });
  let pagesSynced = 0;
  for (const pin of pins) {
    if (opts.dryRun) break;
    try { if ((await syncQuestionPage(ctx, pin)) !== 'unchanged') pagesSynced++; }
    catch (e) { process.stderr.write(`[questions] page sync for ${pinId(pin)} failed: ${(e as Error).message}\n`); }
  }
  const now = Date.now();
  const candidates: Array<{ pin: PinRow; rank: number }> = [];
  for (const pin of pins.filter(p => p.state === 'active')) {
    const neverAttempted = pin.last_attempt_at === null;
    const cooldownMs = (pin.cooldown_days ?? defaultCooldownDays) * 86_400_000;
    if (!neverAttempted && pin.last_attempt_at && now - pin.last_attempt_at.getTime() < cooldownMs) continue;
    if (pin.answer_revision === 0) { candidates.push({ pin, rank: 0 }); continue; }
    const evaluation = await evaluateAnswer(engine, pin, { readableSources: null });
    if (evaluation.stale > 0) { candidates.push({ pin, rank: 1 }); continue; }
    if (await newEvidenceSinceWatermark(engine, pin)) candidates.push({ pin, rank: 2 });
  }
  candidates.sort((a, b) => a.rank - b.rank || (a.pin.last_attempt_at?.getTime() ?? 0) - (b.pin.last_attempt_at?.getTime() ?? 0));
  const tally = { candidates: candidates.length, refreshed: 0, blocked: 0, failed: 0, conflicts: 0, in_progress: 0, pages_synced: pagesSynced };
  const outcomes: Array<{ id: string; status: string }> = [];
  for (const { pin } of candidates.slice(0, maxPerCycle)) {
    opts.signal?.throwIfAborted();
    if (opts.dryRun) { outcomes.push({ id: pinId(pin), status: 'dry_run' }); continue; }
    const outcome = await refreshPin(engine, pin.source_id, pin.slug, {
      trigger: 'cycle', meter, leaseOwner: 'cycle', ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.chat ? { chat: opts.chat } : {}), ...(opts.hooks ? { hooks: opts.hooks } : {}),
    });
    outcomes.push({ id: pinId(pin), status: outcome.status === 'blocked' ? `blocked:${outcome.blocked_reason}` : outcome.status });
    if (outcome.status === 'published') tally.refreshed++;
    else if (outcome.status === 'blocked') {
      tally.blocked++;
      if (outcome.blocked_reason === 'budget_exhausted' || outcome.blocked_reason === 'no_model_key') break;
    } else if (outcome.status === 'failed') tally.failed++;
    else if (outcome.status === 'conflict') tally.conflicts++;
    else if (outcome.status === 'in_progress') tally.in_progress++;
  }
  if (!opts.dryRun) await engine.setConfig(LAST_PHASE_RUN_KEY, new Date().toISOString());
  const status = tally.failed > 0 || tally.blocked > 0 ? 'warn' : candidates.length === 0 && pagesSynced === 0 ? 'skipped' : 'ok';
  return {
    phase: 'standing_questions', status, duration_ms: 0,
    summary: `${tally.refreshed} refreshed, ${tally.blocked} blocked, ${tally.failed} failed, ${tally.conflicts} conflicts of ${candidates.length} due; ` +
      `$${meter.totalSpent.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
    details: { ...tally, spend_usd: meter.totalSpent, budget_usd: budgetUsd, max_per_cycle: maxPerCycle, outcomes },
  };
}
