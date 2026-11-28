/**
 * chat-usage.ts — durable per-call chat usage accounting (#4218, reviving the
 * #3392 shape).
 *
 * gateway.chat() calls `recordChatUsage` at its SUCCESS boundary (both the
 * production provider path and the test-transport path) with the answering
 * model + token usage. This module:
 *
 *   - attributes a best-effort PHASE via AsyncLocalStorage (`withChatPhase`):
 *     the minion worker wraps handler execution in `job:<name>`; `think`
 *     records as `think` when nothing outside set a phase
 *     (`withDefaultChatPhase`); query expansion always records as
 *     `expansion` (#7176); other direct CLI / op callers record with phase
 *     NULL unless they opt in. Attribution is advisory — a missing phase never
 *     blocks the record.
 *   - prices the call from CANONICAL_PRICING (`estimateChatCostUsd`),
 *     including cache_read/cache_write tokens at the provider's cache rates
 *     when the table carries them (Anthropic), falling back to the input
 *     rate otherwise; the engine sink applies the operator's
 *     `pricing.overrides` on top, as the budget meter does. Unknown models
 *     record cost_usd = NULL (never a fake 0).
 *   - forwards the record to the registered sink FIRE-AND-FORGET. Accounting
 *     is strictly fail-open: a sink error (missing table pre-migration,
 *     closed engine, disk pressure) must never break a chat call.
 *
 * Coverage contract (surfaced verbatim by the `get_usage` op): only
 * gateway.chat() and gateway.expand() calls are logged. The subagent raw-SDK path, embeddings
 * (embedding-pricing.ts owns those), and calls made before the sink was
 * registered or before migration v140 are NOT covered. Failed chat calls are
 * not logged either — the budget tracker (budget-tracker.ts) remains the
 * pessimistic in-flight spend gate; this table is the after-the-fact ledger.
 *
 * No engine import here (the sink is injected) — this module stays a leaf so
 * the gateway can import it statically without deepening any cycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalLookup, priceAtPromptSize } from '../model-pricing.ts';
import { overrideFor, priceFor, type PricingOverrides } from '../budget/reservation-cost.ts';
import { embeddedEngineInScope } from '../engine-scope.ts';
import { engineKey } from '../engine-key.ts';
import type { BrainEngine } from '../engine.ts';

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

/** Like `withChatPhase`, but an enclosing phase (`job:<name>`, `phase:synthesize`) wins. */
export function withDefaultChatPhase<T>(phase: string, fn: () => T): T {
  return currentChatPhase() === null ? withChatPhase(phase, fn) : fn();
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
interface SinkEntry { sink: ChatUsageSink; engine?: object }
let _sinks: SinkEntry[] = [];
/** An embedded engine's own sink, keyed by engineKey; never on the stack, and kept across reconnect() until it closes. */
const _engineSinks = new WeakMap<object, ChatUsageSink>();

/**
 * The sink a record goes to: in an embedded engine's scope, that engine's own (engine-scope.ts) or none once it
 * closed; otherwise the top of the stack, which never holds an embedded engine, so one brain's usage never lands in
 * another's database.
 */
function sinkInScope(): ChatUsageSink | null {
  const scoped = embeddedEngineInScope();
  if (scoped) return _engineSinks.get(engineKey(scoped)) ?? null;
  return _sinks.at(-1)?.sink ?? null;
}

/** Gives an engine opened from settings its own sink, off the process stack. Returns the handle its close calls. */
export function registerEngineChatUsageSink(engine: object, sink: ChatUsageSink): () => void {
  _engineSinks.set(engineKey(engine), sink);
  return () => { _engineSinks.delete(engineKey(engine)); };
}

/** Register a usage sink, for `engine` when given. Returns an idempotent deregister handle. */
export function registerChatUsageSink(sink: ChatUsageSink, engine?: object): () => void {
  const entry: SinkEntry = { sink, engine };
  _sinks.push(entry);
  return () => {
    _sinks = _sinks.filter((e) => e !== entry);
  };
}

/** @internal exported for tests: how many sinks the process stack holds. */
export function __chatUsageSinkCountForTests(): number {
  return _sinks.length;
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
  const row = canonicalLookup(model);
  if (!row) return null;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  // #6448 item 1: the prompt size that selects a long-prompt tier is the
  // whole prompt — uncached input plus both cache buckets.
  const p = priceAtPromptSize(row, usage.input_tokens + cacheRead + cacheWrite);
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
  /** An operation's own phase (`expansion`), over the ambient one. */
  phase?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}): void {
  const meter = __chatMeterStore.getStore();
  if (meter) meter.calls++;
  const sink = sinkInScope();
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
      phase: input.phase ?? currentChatPhase(),
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

/** How long a sink reuses the `pricing.overrides` it read before reading config again. */
export const CHAT_USAGE_OVERRIDES_TTL_MS = 60_000;
/** How long an engine's close waits for ledger rows still being written; a stalled write never holds the close past it. */
export const CHAT_USAGE_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Standard sink: appends the record to chat_usage_log through the engine's
 * typed `logChatUsage` member (SQL in engine-sql/chat-usage.ts). Registered by
 * the engine factory (last engine created wins; multi-brain processes log
 * against the most recently created engine — documented best-effort).
 *
 * #10424: a model the operator priced with `pricing.overrides` is priced
 * here the way the budget meter prices it (`priceFor`: the override wins,
 * input and output tokens at its rates), so `get_usage` reports the spend
 * the meter caps. The sink reads the overrides at most once per
 * CHAT_USAGE_OVERRIDES_TTL_MS, never once per row; a failed read keeps the
 * table price (or NULL) the record arrived with, and the next row reads again.
 * Because a row waits for that read before its INSERT, the engine's close
 * awaits `drain()` so a row recorded just before it still lands, for at most
 * CHAT_USAGE_DRAIN_TIMEOUT_MS: a stalled write never holds the close.
 */
export function makeEngineChatUsageSink(engine: Pick<BrainEngine, 'logChatUsage'> & {
  getConfig?: (key: string) => Promise<string | null>;
}): ChatUsageSink & { drain(timeoutMs?: number): Promise<void> } {
  let cached: { overrides: Promise<PricingOverrides | undefined>; readAt: number } | null = null;
  const pricingOverrides = (): Promise<PricingOverrides | undefined> => {
    const getConfig = engine.getConfig;
    if (!getConfig) return Promise.resolve(undefined);
    const now = Date.now();
    if (!cached || now - cached.readAt >= CHAT_USAGE_OVERRIDES_TTL_MS) {
      const entry = {
        readAt: now,
        overrides: Promise.all([getConfig.call(engine, 'pricing.overrides'), import('../budget/budget-tracker.ts')])
          .then(([raw, { parsePricingOverrides }]) => parsePricingOverrides(raw))
          // silent-read-ok: a failed read prices nothing from overrides and is not cached, so the next row reads again
          .catch(() => { if (cached === entry) cached = null; return undefined; }),
      };
      cached = entry;
    }
    return cached.overrides;
  };
  const pending = new Set<Promise<void>>();
  const write = async (record: ChatUsageRecord): Promise<void> => {
    const override = overrideFor(record.model, await pricingOverrides());
    const r = override
      ? { ...record, cost_usd: (record.input_tokens * override.input + record.output_tokens * override.output) / 1_000_000 }
      : record;
    await engine.logChatUsage(r);
  };
  const sink = (record: ChatUsageRecord): Promise<void> => {
    const write$ = write(record);
    pending.add(write$);
    const settle = () => { pending.delete(write$); };
    write$.then(settle, settle);
    return write$;
  };
  const drain = async (timeoutMs = CHAT_USAGE_DRAIN_TIMEOUT_MS): Promise<void> => {
    if (!pending.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); timer.unref?.(); });
    try { await Promise.race([Promise.allSettled([...pending]), deadline]); } finally { clearTimeout(timer); }
  };
  return Object.assign(sink, { drain });
}
