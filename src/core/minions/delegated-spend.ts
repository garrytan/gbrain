import type { BrainEngine } from '../engine.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';
import { withAIInvocationGuard, type AIInvocation, type AIInvocationUsage } from '../ai/invocation-guard.ts';
import { reserve, settle } from './budget-meter.ts';
import { effectiveDelegation, type DelegationSnapshot } from './delegated-policy.ts';
import { UnrecoverableError } from './types.ts';

export class DelegationPricingError extends UnrecoverableError {
  constructor(reason: string) { super(`agent_spend_unbounded: ${reason}`); this.name = 'DelegationPricingError'; }
}

function prices(call: AIInvocation): { input: number; output: number; read: number; write: number } | null {
  if (call.kind === 'chat') {
    const p = canonicalLookup(call.model);
    if (!p) return null;
    return { input: p.input, output: p.output, read: p.cache_read ?? p.input,
      write: call.cacheWriteTtl === '1h' ? p.input * 2 : p.cache_write ?? p.input };
  }
  if (call.kind !== 'embedding') return null;
  const p = lookupEmbeddingPrice(call.model);
  return p.kind === 'known' ? { input: p.pricePerMTok, output: 0, read: 0, write: 0 } : null;
}

export function maximumInvocationCents(call: AIInvocation): number | null {
  const p = prices(call);
  if (!p || !Number.isSafeInteger(call.maxInputTokens) || call.maxInputTokens! < 0
    || !Number.isSafeInteger(call.maxOutputTokens) || call.maxOutputTokens! < 0) return null;
  // Full declared input ceiling covers cache, tools and provider framing.
  // 1h cache writes can cost 2x base input; reserve that worst case.
  return Math.ceil((call.maxInputTokens! * Math.max(p.input * 2, p.read, p.write) + call.maxOutputTokens! * p.output) / 100) / 100;
}

function actualCents(call: AIInvocation, usage: AIInvocationUsage | null): number | null {
  const p = prices(call);
  if (!p || !usage) return null;
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (values.some(v => !Number.isFinite(v) || v < 0)) return null;
  return (values[0]! * p.input + values[1]! * p.output + values[2]! * p.read + values[3]! * p.write) / 10_000;
}

export function withDelegatedSpend<T>(engine: BrainEngine, snapshot: DelegationSnapshot | null, jobId: number, run: () => Promise<T>): Promise<T> {
  if (!snapshot) return run();
  return withAIInvocationGuard(async call => {
    const effective = await effectiveDelegation(engine, snapshot, jobId);
    const cap = effective.budgetUsdPerDay === null ? null : Math.round(Number(effective.budgetUsdPerDay) * 100);
    const max = maximumInvocationCents(call);
    if (cap !== null && max === null) throw new DelegationPricingError(`${call.operation} has no known price and enforced maximum for ${call.model}; no provider call was made`);
    const hold = await reserve(engine, { clientId: snapshot.clientId, capCents: cap,
      estimatedCents: max ?? 0, estimateKnown: max !== null, model: call.model,
      provider: call.model.split(':')[0] || 'unknown', jobId,
      validateAdmission: async tx => { await effectiveDelegation(tx, snapshot, jobId); } });
    return { async settle(usage) {
      const cents = actualCents(call, usage);
      if (cents !== null) await settle(engine, hold.reservationId, cents, call.operation);
      else await engine.executeRaw(
        `UPDATE mcp_spend_reservations SET usage_unknown_reason = $2 WHERE reservation_id = $1 AND status IN ('pending','expired')`,
        [hold.reservationId, usage === null ? 'provider_usage_unknown' : 'pricing_unknown'],
      );
    } };
  }, run);
}
