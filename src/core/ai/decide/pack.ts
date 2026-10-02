/**
 * Packing planner and bounded batch runner (generalized from the #5178
 * TypeSafe reranker adapter).
 *
 * Shared state is sent once per batch, one question per candidate/segment.
 * Token estimates are conservative (2x the local estimate, with a digit floor
 * because some tokenizers split digits individually). Batches are split BEFORE
 * any transport call; evidence is never truncated. Limits: 64k tokens per
 * request (state + all questions) and 32k for state + the longest question.
 */
import { estimateTokens } from '../../chunkers/token-estimate.ts';
import { DecideError, type DecideLane, type DecideQuestion, type DecideSlot } from './types.ts';

export const STATE_QUESTION_BUDGET = 32_000;
export const TOTAL_INPUT_BUDGET = 64_000;
export const TOKEN_HEADROOM = 2_048;
export const MAX_CONCURRENT_BATCHES = 16;
/** Per-question serialization overhead (id, type, data boundary). */
const QUESTION_OVERHEAD_TOKENS = 16;
/** Bumped when the planner's order rule or state template changes (part of pack_shape). */
export const PACK_VERSION = 1;

/** Conservative estimate, not the provider tokenizer. */
export function estimateContextTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.max(estimateTokens(text) * 2, (text.match(/\d/g) ?? []).length);
}

/** Planner order: candidate rank, then id (stable across calibration, evals and production). */
export function orderQuestions<T extends Pick<DecideQuestion, 'id' | 'rank'>>(questions: readonly T[]): T[] {
  return [...questions].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PlannedBatch {
  /** Indices into the ordered question list. */
  indices: number[];
  estimatedInputTokens: number;
}

/**
 * Split questions into batches under both limits. Throws payload_too_large
 * when one state + question pair cannot fit (never trims evidence).
 */
export function planBatches(stateTokens: number, questionTokens: readonly number[]): PlannedBatch[] {
  const batches: PlannedBatch[] = [];
  let start = 0;
  while (start < questionTokens.length) {
    let accepted = 0;
    let acceptedTokens = 0;
    let total = 0;
    let longest = 0;
    for (let count = 1; count <= questionTokens.length - start; count++) {
      const t = questionTokens[start + count - 1]! + QUESTION_OVERHEAD_TOKENS;
      total += t;
      longest = Math.max(longest, t);
      const estimated = stateTokens + total + TOKEN_HEADROOM;
      if (stateTokens + longest + TOKEN_HEADROOM > STATE_QUESTION_BUDGET || estimated > TOTAL_INPUT_BUDGET) break;
      accepted = count;
      acceptedTokens = estimated;
    }
    if (!accepted) throw new DecideError('payload_too_large', 'decide: one state/question pair exceeds the context budget');
    batches.push({ indices: Array.from({ length: accepted }, (_, i) => start + i), estimatedInputTokens: acceptedTokens });
    start += accepted;
  }
  return batches;
}

/**
 * The packing shape a calibration is valid for. Calibration, evals and
 * production build requests with the same shape; `on` refuses a calibration
 * whose shape differs.
 */
export function packShape(slot: DecideSlot, coPacked: readonly DecideSlot[] = [], opts: { unpacked?: boolean } = {}): string {
  const slots = [...new Set([slot, ...coPacked])].sort().join('+');
  return `v${PACK_VERSION}:order=rank-id:max=${opts.unpacked ? '1' : 'budget'}:slots=${slots}`;
}

export interface RunBatchesOpts {
  concurrency: number;
  /** Absolute epoch-ms deadline for the whole logical decision. */
  deadlineAt: number;
  signal: AbortSignal;
  lane: DecideLane;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Thrown by `send` for HTTP 429; carries the provider's retry-after (ms) when given. */
export class RateLimitedError extends Error {
  retryAfterMs?: number;
  constructor(retryAfterMs?: number) {
    super('decide: rate limited');
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

/**
 * Run batches with at most `concurrency` in flight (capped at 16). A worker
 * that finishes starts the next batch, so one slow batch holds no group
 * barrier. The first failure stops queueing; started requests settle so spend
 * stays complete. A 429 retries once only when its retry-after fits the
 * deadline; background lanes also drop to one worker after a 429.
 */
export async function runBatches<T>(
  count: number,
  send: (index: number) => Promise<T>,
  opts: RunBatchesOpts,
): Promise<T[]> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const cap = Math.max(1, Math.min(MAX_CONCURRENT_BATCHES, Math.floor(opts.concurrency)));
  const results: T[] = new Array(count);
  let next = 0;
  let allowed = cap;
  let failure: unknown;
  let failed = false;
  opts.signal.throwIfAborted();
  const attempt = async (index: number): Promise<T> => {
    try {
      return await send(index);
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      if (opts.lane === 'background') allowed = 1;
      const wait = err.retryAfterMs;
      if (wait === undefined || now() + wait >= opts.deadlineAt) throw new DecideError('rate_limited', 'decide: rate limited (retry-after does not fit the deadline)', 429);
      await sleep(wait, opts.signal);
      try {
        return await send(index);
      } catch (retryErr) {
        if (retryErr instanceof RateLimitedError) throw new DecideError('rate_limited', 'decide: rate limited after retry', 429);
        throw retryErr;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(cap, count) }, async (_, worker) => {
    while (!failed && !opts.signal.aborted && next < count && worker < allowed) {
      const index = next++;
      try {
        results[index] = await attempt(index);
      } catch (err) {
        if (!failed) { failed = true; failure = err; }
      }
    }
  }));
  if (failed) throw failure;
  opts.signal.throwIfAborted();
  if (next < count) throw new DecideError('provider_error', 'decide: batches left unsent');
  return results;
}
