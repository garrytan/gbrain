/**
 * Embed retry/backoff primitives + the title-tier restamp helper, peeled from
 * `src/commands/embed.ts` (mw2 layering fix).
 *
 * Why a core module: `src/core/import-file.ts` and `src/core/embed-stale.ts`
 * consume `embedBatchWithBackoff` / `restampIfDemotedToTitleTier`. When these
 * lived in the commands layer, every import-file consumer (sync, ops/pages,
 * operations.ts, MCP) eagerly loaded the embed COMMAND module, and any future
 * value import of operations.ts from embed.ts's closure would complete a real
 * ESM cycle — the exact class that produced a prior release's module-cycle
 * break. `src/commands/embed.ts` re-exports everything here (façade rule), so
 * historical import sites and tests never chase the peel.
 */

import { embedBatch } from './embedding.ts';
import { serr } from './console-prefix.ts';
import { titleTierCorpusGeneration } from './contextual-retrieval-service.ts';
import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';

/**
 * #3507 — after a plain re-embed fully re-embedded a `per_chunk_synopsis`
 * page at the title-only tier (see wrapChunkTextsForStoredMode), restamp the
 * page's CR state to 'title' so `contextual_retrieval_mode` keeps describing
 * the vectors actually in the column. The reindex sweep restores the synopsis
 * tier later. No-op for every other mode.
 */
export async function restampIfDemotedToTitleTier(
  engine: BrainEngine,
  page: Pick<Page, 'contextual_retrieval_mode'> | null | undefined,
  slug: string,
  sourceId: string,
): Promise<void> {
  if (page?.contextual_retrieval_mode !== 'per_chunk_synopsis') return;
  await engine.updatePageContextualRetrievalState(slug, sourceId, 'title', titleTierCorpusGeneration());
}

/**
 * v0.33.3: rate-limit-aware embedBatch wrapper.
 * #3966: also retries transient gateway errors (502/503/504) that NIM and
 * similar providers emit under sustained bulk load.
 *
 * The OpenAI SDK has built-in retry with exponential backoff, but its
 * backoff window (max ~4s) is too short for TPM (tokens-per-minute)
 * rate limits on large pages (~90K tokens).  This wrapper catches
 * 429-shaped and gateway-overload errors, parses the retry delay from
 * the error message (e.g. "Please try again in 248ms"), and sleeps before retrying.
 *
 * v0.33.4 hardening (codex + re-review findings):
 *   - D4: detect 429 via the wrapped error's `cause.status` (the gateway's
 *     normalizeAIError stores the original error there). Bare `e.status`
 *     never fires against an `AITransientError` wrap. Message-match stays
 *     as a fallback.
 *   - D4a: pass `maxRetries: 0` through `embedBatch` so the AI SDK's
 *     default 2-retry stack doesn't multiply this wrapper's 5 attempts.
 *   - D2: jitter the parsed delay ±30% so 20 concurrent workers don't
 *     resynchronize on the next 429 wave.
 *   - D3a/D8: when an external AbortSignal fires (wall-clock budget), the
 *     sleep wakes up early AND the abortSignal is threaded into the gateway
 *     embed call so an in-flight HTTP request cancels too.
 *
 * Up to MAX_RATE_LIMIT_RETRIES attempts with the parsed (jittered) delay
 * (or a 60s fallback when the message can't be parsed).
 *
 * @internal Exported for unit tests; not part of the public surface.
 */
export const MAX_RATE_LIMIT_RETRIES = 5;
export const RATE_LIMIT_FALLBACK_MS = 60_000;
export const RATE_LIMIT_PAD_MS = 500;
export const RATE_LIMIT_JITTER = 0.3;

export interface EmbedBatchWithBackoffOpts {
  abortSignal?: AbortSignal;
}

/**
 * Walk the cause chain looking for a 429 status. The current
 * `normalizeAIError` wraps once into `AITransientError` with `cause = original`,
 * so one level is sufficient — but iterate to handle future wrap layers
 * defensively (max 5 levels to bound a malformed cyclic chain).
 *
 * @internal exported for unit tests.
 */
export function detect429FromCause(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (obj.status === 429 || obj.statusCode === 429) return true;
    cur = obj.cause;
  }
  return false;
}

/** Gateway overload statuses retried with the same backoff as 429 (#3966). */
const RETRIABLE_GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Walk the cause chain looking for 502/503/504. Same depth bound as
 * detect429FromCause — one normalizeAIError wrap is typical.
 *
 * @internal exported for unit tests.
 */
export function detectGatewayErrorFromCause(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    const status = obj.status ?? obj.statusCode;
    if (typeof status === 'number' && RETRIABLE_GATEWAY_STATUSES.has(status)) return true;
    cur = obj.cause;
  }
  return false;
}

/**
 * Parse a Retry-After hint out of an OpenAI-style 429 message. Falls back
 * to `RATE_LIMIT_FALLBACK_MS` when the message can't be parsed. Adds
 * `RATE_LIMIT_PAD_MS` padding and `RATE_LIMIT_JITTER` randomization so
 * concurrent workers don't resynchronize.
 *
 * @internal exported for unit tests.
 */
export function parseRetryDelayMs(msg: string, rng: () => number = Math.random): number {
  let delayMs = RATE_LIMIT_FALLBACK_MS;
  const msMatch = msg.match(/try again in (\d+)ms/i);
  const secMatch = msg.match(/try again in ([\d.]+)s/i);
  if (msMatch) delayMs = parseInt(msMatch[1], 10) + RATE_LIMIT_PAD_MS;
  else if (secMatch) delayMs = Math.ceil(parseFloat(secMatch[1]) * 1000) + RATE_LIMIT_PAD_MS;
  // D2: ±30% jitter to decorrelate the herd of 20 workers.
  const jitterFactor = 1 + (rng() * 2 - 1) * RATE_LIMIT_JITTER;
  return Math.max(1, Math.floor(delayMs * jitterFactor));
}

/**
 * #3796 — attempt-scaled floor for 429 waits. Providers with ROLLING
 * per-minute token budgets (TPM) return tiny Retry-After hints ("try again
 * in 132ms") that are honest about the next REQUEST slot but not about the
 * token budget: five hint-sized waits burn every retry inside the same TPM
 * minute and the batch fails despite the limit being about to clear.
 * Escalating floors guarantee the retry ladder spans the rolling window
 * (sum ≈ 120s ≫ 60s even at -30% jitter) while a LARGER provider hint still
 * wins (a 4-minute Retry-After must be honored, not floored down).
 */
export const RATE_LIMIT_ATTEMPT_FLOOR_MS = [1_000, 4_000, 10_000, 30_000, 75_000] as const;

let _rateLimitFloorsMs: readonly number[] = RATE_LIMIT_ATTEMPT_FLOOR_MS;

/**
 * Test seam: shrink the #3796 floors so sustained-429 exhaustion tests don't
 * spend ~2min of real wall clock (the production ladder's whole point).
 * Pass null to restore. @internal
 */
export function _setRateLimitFloorsForTests(floors: readonly number[] | null): void {
  _rateLimitFloorsMs = floors ?? RATE_LIMIT_ATTEMPT_FLOOR_MS;
}

/**
 * #3796 — the effective 429 wait: max(jittered provider hint, jittered
 * attempt-scaled floor). Keeps parseRetryDelayMs's contract (hint + pad +
 * jitter) intact for its other consumers/tests; the floor gets its own
 * jitter so a floored herd doesn't resynchronize.
 *
 * @internal exported for unit tests.
 */
export function rateLimitDelayMs(
  msg: string,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const hinted = parseRetryDelayMs(msg, rng);
  const floorIdx = Math.min(Math.max(attempt, 0), _rateLimitFloorsMs.length - 1);
  const jitterFactor = 1 + (rng() * 2 - 1) * RATE_LIMIT_JITTER;
  const floored = Math.max(1, Math.floor(_rateLimitFloorsMs[floorIdx] * jitterFactor));
  return Math.max(hinted, floored);
}

/**
 * Sleep for `ms` milliseconds. Resolves early (not rejects) when `signal`
 * fires, so the retry loop's caller can re-check `signal.aborted` and
 * exit cleanly without an unhandled rejection.
 *
 * NOTE: distinct contract from `src/core/retry.ts:abortableSleep`, which
 * REJECTS with RetryAbortError on abort. This one resolves.
 *
 * @internal exported for unit tests.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function embedBatchWithBackoff(
  texts: string[],
  opts: EmbedBatchWithBackoffOpts = {},
): Promise<Float32Array[]> {
  const signal = opts.abortSignal;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('embed budget aborted');
    try {
      // D4a + D8: maxRetries:0 disables the SDK's stacked retries (so this
      // wrapper is the single source of truth) and abortSignal threads
      // through to the gateway so an in-flight HTTP request cancels mid-fetch.
      return await embedBatch(texts, { maxRetries: 0, ...(signal && { abortSignal: signal }) });
    } catch (e: unknown) {
      // If the budget fired we may have been aborted mid-fetch; bubble out.
      // This check is what keeps caller-initiated aborts out of BOTH retry
      // branches below (#3374) — an abort is never reclassified as transient.
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      const rateLimitish = isEmbedRetriableError(e);
      // #3374 — transient NETWORK blips (socket timeout / conn reset) get a
      // plain bounded backoff beside the 429/gateway retry-after path.
      const netTransient = !rateLimitish && isTransientNetworkEmbedError(e);
      if ((!rateLimitish && !netTransient) || attempt === MAX_RATE_LIMIT_RETRIES) throw e;

      // #3796: 429s take the attempt-floored wait (rolling-TPM-aware);
      // network blips keep their own bounded exponential ladder.
      const delayMs = rateLimitish ? rateLimitDelayMs(msg, attempt) : transientBackoffMs(attempt);
      // One label for every retriable class — 429, gateway and network blips share the loop.
      serr(`  [embed-retry] attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}, waiting ${delayMs}ms...`);
      await abortableSleep(delayMs, signal);
    }
  }
  // Unreachable, but TypeScript needs it.
  return embedBatch(texts);
}

/**
 * Retriable embed errors: 429 rate limits plus transient gateway overload
 * (502/503/504). Shared by embedBatchWithBackoff (retry decision) and
 * embedPageTexts (fan-out decision). D4: structured detection first
 * (gateway-wrapped errors via cause chain); message-match as fallback for
 * providers whose wrappers strip `cause.status`.
 */
export function isEmbedRetriableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    detect429FromCause(e) ||
    detectGatewayErrorFromCause(e) ||
    /rate.?limit|429/i.test(msg) ||
    /bad gateway|502|503|504|service unavailable|gateway timeout/i.test(msg)
  );
}

/** #3374 — plain bounded backoff knobs for transient network errors. */
export const TRANSIENT_NET_BASE_MS = 1_000;
export const TRANSIENT_NET_MAX_MS = 15_000;

/**
 * #3374 — plain bounded exponential backoff for transient network errors.
 * There is no retry-after header to parse on a conn-reset, and the 429
 * fallback (60s) is wildly oversized for a socket blip: base × 2^attempt,
 * capped, with the same ±30% jitter as the rate-limit path.
 *
 * @internal exported for unit tests.
 */
export function transientBackoffMs(attempt: number, rng: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_NET_BASE_MS * 2 ** attempt, TRANSIENT_NET_MAX_MS);
  const jitterFactor = 1 + (rng() * 2 - 1) * RATE_LIMIT_JITTER;
  return Math.max(1, Math.floor(raw * jitterFactor));
}

/**
 * #3374 — transient NETWORK failures: socket timeouts, connection resets,
 * DNS blips. Structured detection first (error `code` / TimeoutError name
 * through the cause chain, matching statusFromCause's walk), message-match
 * fallback for wrappers that strip the code. Deliberately does NOT match
 * caller-initiated aborts: the retry loop re-checks `signal.aborted` BEFORE
 * classification, and nothing abort-shaped appears in these patterns.
 *
 * @internal exported for unit tests.
 */
export function isTransientNetworkEmbedError(e: unknown): boolean {
  const TRANSIENT_CODES = /^(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|ECONNABORTED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/;
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof obj.code === 'string' && TRANSIENT_CODES.test(obj.code)) return true;
    if (obj.name === 'TimeoutError') return true;
    cur = obj.cause;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN)\b|socket hang up|fetch failed|connect(ion)? timeout|connection (reset|closed)|network (error|timeout)|request timed out|timed out/i.test(msg);
}
