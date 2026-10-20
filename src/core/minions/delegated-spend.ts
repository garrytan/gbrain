import type { BrainEngine } from '../engine.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { overrideFor, priceFor, type PricingOverrides } from '../budget/reservation-cost.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';
import type { ModelPricing } from '../model-pricing.ts';
import { withAIInvocationGuard, type AIInvocation, type AIInvocationUsage } from '../ai/invocation-guard.ts';
import { reserve, settle } from './budget-meter.ts';
import { effectiveDelegation, type DelegationSnapshot } from './delegated-policy.ts';
import { UnrecoverableError } from './types.ts';

export class DelegationPricingError extends UnrecoverableError {
  constructor(reason: string) { super(`agent_spend_unbounded: ${reason}`); this.name = 'DelegationPricingError'; }
}

function rowFor(call: AIInvocation, overrides?: PricingOverrides): ModelPricing | null {
  if (call.kind === 'chat') return priceFor(call.model, 'chat', overrides)?.pricing ?? null;
  if (call.kind === 'embedding') return priceFor(call.model, 'embed', overrides)?.pricing ?? null;
  if (call.kind !== 'rerank') return null;
  const known = lookupEmbeddingPrice(call.model);
  return overrideFor(call.model, overrides) ?? (known.kind === 'known' ? { input: known.pricePerMTok, output: 0 } : null);
}

function prices(call: AIInvocation, overrides?: PricingOverrides): { input: number; output: number; read: number; write: number } | null {
  const p = rowFor(call, overrides);
  if (!p) return null;
  return { input: p.input, output: p.output, read: p.cache_read ?? p.input,
    write: call.cacheWriteTtl === '1h' ? p.input * 2 : p.cache_write ?? p.input };
}

export function maximumInvocationCents(call: AIInvocation, overrides?: PricingOverrides): number | null {
  const p = prices(call, overrides);
  const maxOutputTokens = call.maxOutputTokens ?? (call.kind === 'embedding' || call.kind === 'rerank' ? 0 : undefined);
  if (!p || !Number.isSafeInteger(call.maxInputTokens) || call.maxInputTokens! < 0
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens! < 0) return null;
  // Full declared input ceiling covers cache, tools and provider framing.
  // 1h cache writes can cost 2x base input; reserve that worst case.
  return Math.ceil((call.maxInputTokens! * Math.max(p.input * 2, p.read, p.write) + maxOutputTokens! * p.output) / 100) / 100;
}

/** Why maximumInvocationCents is null: a known price with no declared input ceiling is `no_context_ceiling` (#6990). */
export function unboundedInvocationCause(call: AIInvocation, overrides?: PricingOverrides): 'no_pricing' | 'no_context_ceiling' {
  return prices(call, overrides) && !Number.isSafeInteger(call.maxInputTokens) ? 'no_context_ceiling' : 'no_pricing';
}

export function actualCents(call: AIInvocation, usage: AIInvocationUsage | null, overrides?: PricingOverrides): number | null {
  const p = prices(call, overrides);
  if (!p || !usage) return null;
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (values.some(v => !Number.isFinite(v) || v < 0)) return null;
  return (values[0]! * p.input + values[1]! * p.output + values[2]! * p.read + values[3]! * p.write) / 10_000;
}

export function withDelegatedSpend<T>(engine: BrainEngine, snapshot: DelegationSnapshot | null, jobId: number, run: () => Promise<T>): Promise<T> {
  if (!snapshot) return run();
  let pricing: Promise<PricingOverrides | undefined> | undefined;
  return withAIInvocationGuard(async call => {
    const effective = await effectiveDelegation(engine, snapshot, jobId);
    const cap = effective.budgetUsdPerDay === null ? null : Math.round(Number(effective.budgetUsdPerDay) * 100);
    const overrides = await (pricing ??= loadPricingOverrides(engine));
    const max = maximumInvocationCents(call, overrides);
    if (cap !== null && max === null) throw new DelegationPricingError(`${call.operation} has no known price and enforced maximum for ${call.model}; no provider call was made`);
    const hold = await reserve(engine, { clientId: snapshot.clientId, capCents: cap,
      estimatedCents: max ?? 0, estimateKnown: max !== null, model: call.model,
      provider: call.model.split(':')[0] || 'unknown', jobId,
      validateAdmission: async tx => { await effectiveDelegation(tx, snapshot, jobId); } });
    return { async settle(usage) {
      const cents = actualCents(call, usage, overrides);
      if (cents !== null) await settle(engine, hold.reservationId, cents, call.operation);
      else await engine.executeRaw(
        `UPDATE mcp_spend_reservations SET usage_unknown_reason = $2 WHERE reservation_id = $1 AND status IN ('pending','expired')`,
        [hold.reservationId, usage === null ? 'provider_usage_unknown' : 'pricing_unknown'],
      );
    } };
  }, run, { inherit: true });
}
