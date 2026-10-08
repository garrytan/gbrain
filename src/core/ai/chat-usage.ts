/**
 * chat-usage.ts — durable per-call chat usage accounting (#4218, reviving the
 * #3392 shape).
 *
 * gateway.chat() calls `recordChatUsage` at its SUCCESS boundary (both the
 * production provider path and the test-transport path) with the answering
 * model + token usage. This module:
 *
 *   - attributes a best-effort PHASE via AsyncLocalStorage (`withChatPhase`):
 *     the minion worker wraps handler execution in `job:<name>`; direct CLI /
 *     op callers record with phase NULL unless they opt in. Attribution is
 *     advisory — a missing phase never blocks the record.
 *   - prices the call from CANONICAL_PRICING (`estimateChatCostUsd`),
 *     including cache_read/cache_write tokens at the provider's cache rates
 *     when the table carries them (Anthropic), falling back to the input
 *     rate otherwise. Unknown models record cost_usd = NULL (never a fake 0).
 *   - forwards the record to the registered sink FIRE-AND-FORGET. Accounting
 *     is strictly fail-open: a sink error (missing table pre-migration,
 *     closed engine, disk pressure) must never break a chat call.
 *
 * Coverage contract (surfaced verbatim by the `get_usage` op): only
 * gateway.chat() calls are logged. The subagent raw-SDK path, embeddings
 * (embedding-pricing.ts owns those), and calls made before the sink was
 * registered or before migration v140 are NOT covered. Failed chat calls are
 * not logged either — the budget tracker (budget-tracker.ts) remains the
 * pessimistic in-flight spend gate; this table is the after-the-fact ledger.
 *
 * No engine import here (the sink is injected) — this module stays a leaf so
 * the gateway can import it statically without deepening any cycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalLookup } from '../model-pricing.ts';
import { priceFor, type PricingOverrides } from '../budget/reservation-cost.ts';

export interface ChatUsageRecord {
  /** "provider:modelId" of the model that actually answered. */
  model: string;
  /** Recipe/provider id when known (e.g. 'anthropic'). */
  provider: string | null;
  /** Best-effort attribution, e.g. 'job:embed-backfill'. NULL = direct/unattributed. */
  phase: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** USD, priced from CANONICAL_PRICING. NULL when the model has no pricing. */
  cost_usd: number | null;
}

export type ChatUsageSink = (record: ChatUsageRecord) => void | Promise<void>;

const __chatPhaseStore = new AsyncLocalStorage<string>();

/** Run `fn` with every gateway.chat() inside it attributed to `phase`. */
export function withChatPhase<T>(phase: string, fn: () => T): T {
  return __chatPhaseStore.run(phase, fn);
}

export function currentChatPhase(): string | null {
  return __chatPhaseStore.getStore() ?? null;
}

/**
 * Successful chat calls counted for one cycle phase (phase containment,
 * dream_paid_loop) or one nightly probe run. A meter that declares
 * `cost_usd` also prices each call with the budget tracker's resolver
 * (`priceFor`: `pricing_overrides`, then the shipped tables, the claude-cli
 * sibling rate and free local providers; table rows keep their cache-token
 * rates): priced calls add to `cost_usd`, unpriced ones add to
 * `unpriced_calls` instead of counting as 0.
 */
export interface ChatCallMeter {
  calls: number;
  cost_usd?: number;
  unpriced_calls?: number;
  pricing_overrides?: PricingOverrides;
}
const __chatMeterStore = new AsyncLocalStorage<ChatCallMeter>();

/** Run `fn` counting every successful gateway.chat() inside it on `meter`. */
export function withChatCallMeter<T>(meter: ChatCallMeter, fn: () => T): T {
  return __chatMeterStore.run(meter, fn);
}

/**
 * #4480: sink REGISTRY (stack), not a last-wins scalar. A multi-engine
 * process (migrate-engine source+target, doctor probes, tests) used to lose
 * its ledger permanently: the most recently created engine overwrote the
 * sink, and once that engine disconnected every later record was swallowed
 * by a closed engine. Registration now returns a deregister handle; the
 * engine factory calls it on engine.disconnect, restoring the previous live
 * sink. Records route to the TOP live entry (still single-writer —
 * simultaneous multi-brain attribution stays documented best-effort).
 */
interface SinkEntry { sink: ChatUsageSink }
let _sinks: SinkEntry[] = [];

/** Register a usage sink. Returns an idempotent deregister handle. */
export function registerChatUsageSink(sink: ChatUsageSink): () => void {
  const entry: SinkEntry = { sink };
  _sinks.push(entry);
  return () => {
    _sinks = _sinks.filter((e) => e !== entry);
  };
}

/**
 * Legacy scalar API (tests + one-shot callers): clears the registry and
 * installs `sink` as the only entry (null = clear).
 */
export function setChatUsageSink(sink: ChatUsageSink | null): void {
  _sinks = sink ? [{ sink }] : [];
}

/**
 * Price a chat call in USD from the canonical table. Cache tokens use the
 * table's cache_read/cache_write rates when present, else the input rate
 * (documented best-effort — see module doc). Unknown model → null.
 */
export function estimateChatCostUsd(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  },
): number | null {
  const p = canonicalLookup(model);
  if (!p) return null;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      cacheRead * (p.cache_read ?? p.input) +
      cacheWrite * (p.cache_write ?? p.input)) /
    1_000_000
  );
}

/**
 * Called by gateway.chat() at its success boundary. Never throws; the sink
 * runs fire-and-forget with errors swallowed. `usage` is the gateway's
 * `ChatResult.usage` (AI SDK convention): `input_tokens` is the TOTAL input,
 * and the cache read/write counts are subsets of it, so the call is priced as
 * (input - cache) at the input rate plus each cache bucket at its own rate,
 * never the cache tokens a second time on top of the total.
 */
export function recordChatUsage(input: {
  model: string;
  provider?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}): void {
  const meter = __chatMeterStore.getStore();
  if (meter) meter.calls++;
  const sink = _sinks.length > 0 ? _sinks[_sinks.length - 1]!.sink : null;
  const pricedMeter = meter && meter.cost_usd !== undefined ? meter : null;
  if (!sink && !pricedMeter) return;
  try {
    const { input_tokens, output_tokens, cache_read_tokens = 0, cache_write_tokens = 0 } = input.usage;
    const uncached = Math.max(0, input_tokens - cache_read_tokens - cache_write_tokens);
    const cost_usd = estimateChatCostUsd(input.model, { ...input.usage, input_tokens: uncached });
    if (pricedMeter) {
      const price = priceFor(input.model, 'chat', pricedMeter.pricing_overrides);
      const meterCost = price === null ? null
        : price.source === 'table' && cost_usd !== null ? cost_usd
        : (input_tokens * price.pricing.input + output_tokens * price.pricing.output) / 1_000_000;
      if (meterCost === null) pricedMeter.unpriced_calls = (pricedMeter.unpriced_calls ?? 0) + 1;
      else pricedMeter.cost_usd = (pricedMeter.cost_usd ?? 0) + meterCost;
    }
    if (!sink) return;
    const record: ChatUsageRecord = {
      model: input.model,
      provider: input.provider ?? null,
      phase: currentChatPhase(),
      input_tokens: Math.max(0, Math.round(input.usage.input_tokens || 0)),
      output_tokens: Math.max(0, Math.round(input.usage.output_tokens || 0)),
      cache_read_tokens: Math.max(0, Math.round(input.usage.cache_read_tokens || 0)),
      cache_write_tokens: Math.max(0, Math.round(input.usage.cache_write_tokens || 0)),
      cost_usd,
    };
    void Promise.resolve(sink(record)).catch(() => {
      /* fail-open: accounting must never break a chat call */
    });
  } catch {
    /* fail-open */
  }
}

/**
 * Standard sink: INSERT into chat_usage_log via the engine's executeRaw.
 * Positional parameters only — no JSONB, no string-built SQL. Registered by
 * the engine factory (last engine created wins; multi-brain processes log
 * against the most recently created engine — documented best-effort).
 */
export function makeEngineChatUsageSink(engine: {
  executeRaw: (sql: string, params?: unknown[]) => Promise<unknown>;
}): ChatUsageSink {
  return async (r: ChatUsageRecord): Promise<void> => {
    await engine.executeRaw(
      `INSERT INTO chat_usage_log
         (model, provider, phase, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        r.model,
        r.provider,
        r.phase,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.cost_usd,
      ],
    );
  };
}
