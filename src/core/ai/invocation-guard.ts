import { AsyncLocalStorage } from 'node:async_hooks';

export interface AIInvocation {
  operation: string;
  model: string;
  kind: 'chat' | 'embedding' | 'rerank' | 'multimodal' | 'decide' | 'transcription';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  cacheWriteTtl?: '5m' | '1h';
}
export interface AIInvocationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
export interface AIInvocationPermit { settle(usage: AIInvocationUsage | null): Promise<void> }
export type AIInvocationGuard = (call: AIInvocation) => Promise<AIInvocationPermit>;
const guards = new AsyncLocalStorage<AIInvocationGuard>();
const refused = new WeakSet<object>();

/** Preserve admission refusals through provider fallback/error normalization. */
export function isAIInvocationPolicyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && refused.has(error);
}

/** Isolated to this async job; concurrent local work never inherits its owner. */
export function withAIInvocationGuard<T>(guard: AIInvocationGuard, run: () => Promise<T>, opts: { inherit?: boolean } = {}): Promise<T> {
  const parent = opts.inherit ? guards.getStore() : undefined;
  if (!parent) return guards.run(guard, run);
  return guards.run(async call => {
    const outer = await parent(call);
    let inner: AIInvocationPermit;
    try { inner = await guard(call); }
    catch (error) { await outer.settle(null); throw error; }
    return { settle: async usage => { await outer.settle(usage); await inner.settle(usage); } };
  }, run);
}
export function withAIInvocationPreflight<T>(preflight: (call: AIInvocation) => Promise<void>, run: () => Promise<T>): Promise<T> {
  const parent = guards.getStore();
  return guards.run(async call => {
    await preflight(call);
    return parent ? parent(call) : { settle: async () => {} };
  }, run);
}
export function hasAIInvocationGuard(): boolean { return guards.getStore() !== undefined; }

/**
 * Who a model call is for: the write request, effect, job or cycle phase that
 * caused it. Set by the persistence effect dispatcher, the facts queue, the job
 * worker and the cycle runner; read by invocation observers.
 */
export interface AIAttribution {
  request_id?: string;
  effect?: string;
  job_id?: number | string;
  job_name?: string;
  phase?: string;
}
const attributions = new AsyncLocalStorage<AIAttribution>();

/** Run `fn` with `patch` merged over the current attribution. */
export function withAIAttribution<T>(patch: AIAttribution, fn: () => T): T {
  return attributions.run({ ...attributions.getStore(), ...patch }, fn);
}
export function currentAIAttribution(): AIAttribution | null { return attributions.getStore() ?? null; }

/**
 * One observed model call. Observation never changes execution: retries,
 * token defaults and admission behave exactly as with no observer installed.
 * Usage is the provider-reported usage of the call's final attempt.
 */
export interface AIInvocationEvent {
  call: AIInvocation;
  outcome: 'ok' | 'error' | 'refused';
  usage: AIInvocationUsage | null;
  startedAt: number;
  ms: number;
  attribution: AIAttribution | null;
}
export type AIInvocationObserver = (event: AIInvocationEvent) => void;
const observers = new Set<AIInvocationObserver>();
let observerFailures = 0;

/** Register an observer of every model call in this process. Returns its disposer; adding the same function twice is a no-op. */
export function observeAIInvocations(observer: AIInvocationObserver): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
export function hasAIInvocationObservers(): boolean { return observers.size > 0; }
/** Observer throws are swallowed and counted here, never surfaced to the call. */
export function aiInvocationObserverFailures(): number { return observerFailures; }

function notifyObservers(event: AIInvocationEvent): void {
  for (const observer of observers) {
    try { observer(event); } catch { observerFailures += 1; }
  }
}

/**
 * One provider attempt. No guessed usage, no release on an ambiguous failure:
 * a failed attempt settles null (keep the maximum) unless `rejected` proves the
 * provider refused the request unbilled.
 */
export async function invokeAI<T>(call: AIInvocation, run: () => Promise<T>, usage: (result: T) => AIInvocationUsage | null | Promise<AIInvocationUsage | null>,
  rejected?: (error: unknown) => AIInvocationUsage | null): Promise<T> {
  if (observers.size === 0) return admitAndRun(call, run, usage, rejected);
  const startedAt = Date.now();
  let outcome: AIInvocationEvent['outcome'] = 'error';
  let measured: AIInvocationUsage | null = null;
  try {
    const result = await admitAndRun(call, run, usage, rejected);
    outcome = 'ok';
    try { measured = await usage(result); } catch { measured = null; }
    return result;
  } catch (error) {
    if (isAIInvocationPolicyError(error)) outcome = 'refused';
    throw error;
  } finally {
    notifyObservers({ call, outcome, usage: measured, startedAt, ms: Date.now() - startedAt, attribution: currentAIAttribution() });
  }
}

async function admitAndRun<T>(call: AIInvocation, run: () => Promise<T>, usage: (result: T) => AIInvocationUsage | null | Promise<AIInvocationUsage | null>,
  rejected?: (error: unknown) => AIInvocationUsage | null): Promise<T> {
  const guard = guards.getStore();
  if (!guard) return run();
  let permit: AIInvocationPermit;
  try { permit = await guard(call); }
  catch (error) {
    if (typeof error === 'object' && error !== null) refused.add(error);
    throw error;
  }
  let result: T;
  try { result = await run(); }
  catch (error) { await permit.settle(rejected?.(error) ?? null); throw error; }
  let measured: AIInvocationUsage | null;
  try { measured = await usage(result); }
  catch (error) { await permit.settle(null); throw error; }
  await permit.settle(measured);
  return result;
}

export function sdkInvocationUsage(result: unknown): AIInvocationUsage | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, any>;
  const u = r.usage;
  if (!u || typeof u !== 'object') return null;
  const reportedInput = u.inputTokens ?? u.input_tokens ?? u.prompt_tokens ?? u.tokens ?? u.total_tokens;
  const output = u.outputTokens ?? u.output_tokens ?? u.completion_tokens ?? (u.tokens !== undefined || u.total_tokens !== undefined ? 0 : undefined);
  if (!Number.isFinite(reportedInput) || reportedInput < 0 || !Number.isFinite(output) || output < 0) return null;
  const cache = r.providerMetadata?.anthropic ?? {};
  const read = u.inputTokenDetails?.cacheReadTokens ?? cache.cacheReadInputTokens ?? cache.cache_read_input_tokens
    ?? u.cache_read_tokens ?? u.cache_read_input_tokens ?? u.cachedInputTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const write = u.inputTokenDetails?.cacheWriteTokens ?? cache.cacheCreationInputTokens ?? cache.cache_creation_input_tokens
    ?? u.cache_creation_tokens ?? u.cache_creation_input_tokens ?? 0;
  // AI SDK/OpenAI report total input including cached tokens. Anthropic's
  // Messages API reports uncached input separately from cache reads/writes.
  const input = u.inputTokenDetails?.noCacheTokens
    ?? (u.inputTokens !== undefined || u.prompt_tokens !== undefined ? reportedInput - read - write : reportedInput);
  if ([input, read, write].some(n => !Number.isFinite(n) || n < 0)) return null;
  return { inputTokens: input, outputTokens: output,
    cacheReadTokens: read, cacheWriteTokens: write };
}

export async function responseInvocationUsage(response: Response): Promise<AIInvocationUsage | null> {
  try { return sdkInvocationUsage(await response.clone().json()); } catch { return null; }
}
