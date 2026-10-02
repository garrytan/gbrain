/**
 * decide_health (System One): key present when a Jev provider is set, alias
 * in use, slots requested on but inactive (with the catalogued cause and fix),
 * calibration model versus the model recently resolved (drift), alias
 * rollouts (mixed resolved ids), 24-hour error rate over 5%, daily budget
 * exhausted, egress refusals, retired pinned models and every force_on bypass.
 * All-off brains report ok.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const ERROR_RATE_WARN = 0.05;

async function runDecideHealth(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('decide_health');
  try {
    const { loadDecideState, policyFor, effectiveModeLine } = await import('../../decide.ts');
    const { isTypesafeAlias, providerKind } = await import('../../../core/ai/decide/config.ts');
    const { KEY_DEFAULT_LABEL, keyDefaultOptOut } = await import('../../../core/ai/decide/policy.ts');
    const { dailySpend, mixedModelDecisions, recentResolvedModels, receiptStats, slotUsage } = await import('../../../core/ai/decide/store.ts');
    const { DECIDE_SLOTS } = await import('../../../core/ai/decide/types.ts');
    const state = await loadDecideState(engine);
    const policies = DECIDE_SLOTS.map((slot) => policyFor(state, slot));
    const active = policies.filter((p) => p.requested !== 'off');
    const jevReranker = state.rerankerEnabled && state.rerankerModel.startsWith('typesafe:');
    const providers = new Set([...active.map((p) => p.provider), ...(jevReranker ? [state.rerankerModel] : [])]);
    if (active.length === 0 && !jevReranker) {
      checks.push({ name: 'decide_health', status: 'ok', message: 'System One is off (every decide slot is off; nothing is sent).' });
      return checks;
    }
    const warns: string[] = [];
    const notes: string[] = [];
    if ([...providers].some((p) => providerKind(p) === 'typesafe') && !state.key.present) {
      warns.push('a TypeSafe provider is configured but TYPESAFE_API_KEY (or JEV_TYPESAFE_API_KEY) is not set: export TYPESAFE_API_KEY=... && gbrain decide probe');
    }
    for (const p of providers) if (isTypesafeAlias(p)) warns.push(`${p} is a moving alias; pin it: gbrain decide enable <slot> (writes the resolved id)`);
    for (const p of policies) {
      const line = effectiveModeLine(p);
      if (line && p.requested !== 'off') warns.push(line);
      if (p.forceOn) warns.push(`decide.slots.${p.slot}.force_on is true: the action-precision gate is bypassed`);
      if (p.thresholdSource === 'override' && p.requested === 'on') notes.push(`${p.slot} uses an uncalibrated operator threshold override (${p.threshold})`);
    }
    const [recent, mixed, usage, spend, stats] = await Promise.all([
      recentResolvedModels(engine, 24), mixedModelDecisions(engine, 24), slotUsage(engine, 24), dailySpend(engine),
      receiptStats(engine, { sinceHours: 24 }),
    ]);
    for (const p of active) {
      const seen = recent.find((r) => r.slot === p.slot && r.provider === p.provider);
      if (p.calibration && seen && seen.model_resolved !== p.calibration.model_resolved) {
        warns.push(`${p.slot}: calibration ${p.calibration.ref} is for ${p.calibration.model_resolved} but ${p.provider} now answers as ${seen.model_resolved} (drift: calls run with off behavior); gbrain decide calibrations list --slot ${p.slot}`);
      }
    }
    for (const m of mixed) warns.push(`${m.slot}: ${m.n} receipt(s) failed on mixed resolved models (alias rollout in progress); pin the provider id`);
    for (const u of usage) {
      if (u.rows >= 20 && u.errors / u.rows > ERROR_RATE_WARN) warns.push(`${u.slot}: ${(100 * u.errors / u.rows).toFixed(1)}% of receipts errored in 24 h (over 5%); see gbrain decide receipts --slot ${u.slot}`);
      if (u.egress > 0) notes.push(`${u.slot}: ${u.egress} egress refusal(s) in 24 h`);
    }
    if (stats.some((s) => s.error_reason === 'pinned_model_unavailable')) {
      warns.push('the pinned model is no longer served (pinned_model_unavailable): gbrain config set decide.provider typesafe:<new-id>, then recalibrate or adopt a reference calibration');
    }
    if (spend.total >= state.cfg.dailyUsd) warns.push(`daily decide budget exhausted ($${spend.total.toFixed(4)} of $${state.cfg.dailyUsd.toFixed(2)}); slots take their fail direction until UTC midnight: gbrain config set decide.budget.daily_usd <usd>`);
    const keyDefaults = active.filter((p) => state.cfg.slots[p.slot].keyDefault).map((p) => p.slot);
    if (keyDefaults.length > 0) notes.push(`opt out of the key-aware default: ${keyDefaults.map(keyDefaultOptOut).join(' && ')}`);
    const label = (p: (typeof active)[number]) => state.cfg.slots[p.slot].keyDefault ? ` (${KEY_DEFAULT_LABEL})` : '';
    const summary = `${active.map((p) => `${p.slot}=${p.effective === p.requested ? `${p.requested}${label(p)}` : `${p.requested}(inactive: ${p.inactive})`}`).join(', ') || 'no decide slots'}${jevReranker ? `; Jev reranker ${state.rerankerModel}` : ''}`;
    checks.push({
      name: 'decide_health',
      status: warns.length > 0 ? 'warn' : 'ok',
      message: [summary, ...warns, ...notes].join('; '),
      details: { warnings: warns, notes, spent_today_usd: spend.total, daily_usd: state.cfg.dailyUsd },
    });
  } catch (err) {
    checks.push({ name: 'decide_health', status: 'warn', message: `System One state could not be read: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const decideHealthEntry: DoctorEntry = { name: 'decide_health', emits: ['decide_health'], run: runDecideHealth };
