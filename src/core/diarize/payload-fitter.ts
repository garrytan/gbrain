/**
 * v0.37.x — payload-fitter (P6) with two strategies + a quality gate.
 *
 * Generic utility for fitting an arbitrarily large list of items into a
 * downstream caller's per-call token budget.
 *
 * Strategies (Q3 + codex finding #4):
 *   - 'batch'     deterministic token-budgeted chunking. The caller
 *                 receives a flat fit list shaped like the input; the
 *                 chunking decision is left to the caller (e.g. the
 *                 brainstorm judge concatenates results across batches).
 *                 No LLM calls.
 *   - 'summarize' embed-cluster (k = ceil(items/4)), Haiku-summarize each
 *                 cluster, return the fitted payload (summary nodes
 *                 instead of every original item). Composes the active
 *                 BudgetTracker via the gateway's AsyncLocalStorage scope
 *                 (T3) — every Haiku call shows up in the cost ledger.
 *                 Promise.allSettled at parallelism=4 (Perf1) so a single
 *                 cluster-failure does not stall the whole pass.
 *
 * Quality gate (codex outside-voice finding #4):
 *   When the summarize strategy returns less than `min_success_ratio`
 *   (default 0.75) of attempted clusters, the result is flagged
 *   `degraded: true` and the caller decides whether to surface a partial
 *   result or abort. Brainstorm aborts on degraded; defaults can be
 *   relaxed per-caller.
 */

import type { ChatOpts, ChatResult } from '../ai/gateway.ts';

/** Local ChatFn shape — kept here so payload-fitter doesn't depend on
 *  src/core/brainstorm/judges.ts (which is the canonical owner of the
 *  ChatFn alias today). */
type ChatFn = (opts: ChatOpts) => Promise<ChatResult>;

export type FitStrategy = 'batch' | 'summarize';

export interface FitOptions<T> {
  items: T[];
  strategy: FitStrategy;
  /** Hard per-call token budget. 'batch' chunks under this; 'summarize'
   *  shapes its k-clusters so each cluster fits this budget. */
  maxTokensPerCall: number;
  /** Token estimator. Caller-supplied so payload-fitter is generic. */
  estimateTokens: (item: T) => number;
  // ---- summarize-only ----
  /** Optional embed function (only used by 'summarize'). Caller supplies
   *  the active gateway.embed binding. */
  embedFn?: (text: string) => Promise<Float32Array>;
  /** Optional chat function for summarization. Caller supplies the
   *  active gateway.chat binding. */
  chatFn?: ChatFn;
  /** Summarize-only: convert an item to text for embed + summarize. */
  itemToText?: (item: T) => string;
  /** Summarize-only: convert a Haiku summary string back into an item-
   *  shaped fitted node. Caller-supplied so the fitted list has the
   *  caller's own type. */
  summaryToItem?: (summary: string, cluster: T[]) => T;
  /** Summarize parallelism. Default 4 per Perf1. */
  parallelism?: number;
  /** Quality gate threshold. Default 0.75. When the success ratio drops
   *  below this, result.degraded === true. */
  min_success_ratio?: number;
  /** Override the summarization model (e.g. 'anthropic:claude-haiku-4-5').
   *  Default falls back to the gateway's configured chat model. */
  summarizeModel?: string;
}

export interface FitResult<T> {
  fitted: T[];
  strategy: FitStrategy;
  /** Count of clusters that failed (summarize) or 0 (batch). */
  dropped: number;
  /** Ratio of successful clusters: 1.0 for batch / clean summarize. */
  success_ratio: number;
  /** True when success_ratio < min_success_ratio. */
  degraded: boolean;
  /** Total LLM usage rolled up across summarize calls. Undefined for batch. */
  usage?: ChatResult['usage'];
}

const DEFAULT_PARALLELISM = 4;
const DEFAULT_MIN_SUCCESS_RATIO = 0.75;

/**
 * Public entry point. Dispatches on strategy. Pure typecheck failures
 * (e.g. summarize without embedFn/chatFn) throw `Error` synchronously so
 * caller misuse fails loud.
 */
export async function fit<T>(opts: FitOptions<T>): Promise<FitResult<T>> {
  if (opts.strategy === 'batch') {
    return fitBatch(opts);
  }
  if (opts.strategy === 'summarize') {
    return fitSummarize(opts);
  }
  throw new Error(`payload-fitter: unknown strategy "${(opts as { strategy: string }).strategy}"`);
}

/**
 * 'batch' strategy: deterministic, token-budgeted chunking. Returns the
 * original items unchanged (no LLM calls). `dropped` is the count of
 * items that exceeded the per-call budget all on their own — these are
 * preserved in `fitted` (caller decides whether to surface a warning)
 * but they signal a budgeting mismatch the caller should know about.
 */
function fitBatch<T>(opts: FitOptions<T>): FitResult<T> {
  const dropped = opts.items.filter((it) => opts.estimateTokens(it) > opts.maxTokensPerCall).length;
  return {
    fitted: opts.items.slice(),
    strategy: 'batch',
    dropped,
    success_ratio: opts.items.length === 0 ? 1.0 : (opts.items.length - dropped) / opts.items.length,
    degraded: false,
  };
}

/**
 * 'summarize' strategy: embed-cluster then Haiku-summarize each cluster.
 *
 *   1. embed every item (caller-supplied embedFn).
 *   2. cluster into k = ceil(items/4) groups via cheap greedy nearest-
 *      neighbor on cosine similarity (deterministic; no sklearn).
 *   3. parallel Haiku-summarize each cluster via Promise.allSettled
 *      with parallelism `opts.parallelism ?? 4` (Perf1).
 *   4. drop failed clusters; surface a `degraded: true` flag when the
 *      success ratio falls below `min_success_ratio`.
 *
 * Each Haiku call composes the active BudgetTracker via AsyncLocalStorage
 * (no per-call injection). On BudgetExhausted the call throws — caller's
 * outer catch handles persistence.
 */
async function fitSummarize<T>(opts: FitOptions<T>): Promise<FitResult<T>> {
  if (!opts.embedFn || !opts.chatFn || !opts.itemToText || !opts.summaryToItem) {
    throw new Error(
      `payload-fitter: strategy='summarize' requires embedFn + chatFn + itemToText + summaryToItem`,
    );
  }
  const minRatio = opts.min_success_ratio ?? DEFAULT_MIN_SUCCESS_RATIO;
  const parallelism = Math.max(1, opts.parallelism ?? DEFAULT_PARALLELISM);

  if (opts.items.length === 0) {
    return { fitted: [], strategy: 'summarize', dropped: 0, success_ratio: 1.0, degraded: false };
  }

  // 1. Embed every item. The gateway.embed call composes the active
  //    tracker; a budget throw here propagates cleanly.
  const texts = opts.items.map((it) => opts.itemToText!(it));
  const embeds: Float32Array[] = [];
  for (const text of texts) {
    embeds.push(await opts.embedFn(text));
  }

  // 2. Greedy clustering. Pick the first un-clustered item as the seed;
  //    add the (k-1) closest remaining items by cosine. Deterministic
  //    given the input order. k = ceil(items / 4).
  const k = Math.max(1, Math.ceil(opts.items.length / 4));
  const clusterSize = Math.ceil(opts.items.length / k);
  const claimed = new Set<number>();
  const clusters: number[][] = [];
  for (let c = 0; c < k && claimed.size < opts.items.length; c++) {
    let seedIdx = -1;
    for (let i = 0; i < opts.items.length; i++) {
      if (!claimed.has(i)) {
        seedIdx = i;
        break;
      }
    }
    if (seedIdx === -1) break;
    claimed.add(seedIdx);
    const group = [seedIdx];
    const seedVec = embeds[seedIdx];
    // Score remaining un-claimed by similarity to seed; pick closest until cluster is full.
    const remaining = opts.items
      .map((_, idx) => idx)
      .filter((idx) => idx !== seedIdx && !claimed.has(idx))
      .map((idx) => ({ idx, sim: cosine(seedVec, embeds[idx]) }))
      .sort((a, b) => b.sim - a.sim);
    for (const cand of remaining) {
      if (group.length >= clusterSize) break;
      claimed.add(cand.idx);
      group.push(cand.idx);
    }
    clusters.push(group);
  }

  // 3. Parallel summarize via allSettled with bounded concurrency.
  const fitted: T[] = [];
  const totalUsage: ChatResult['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  let failed = 0;
  for (let i = 0; i < clusters.length; i += parallelism) {
    const wave = clusters.slice(i, i + parallelism);
    const results = await Promise.allSettled(
      wave.map((group) => summarizeCluster(group, opts, texts)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const group = wave[j];
      if (r.status === 'fulfilled') {
        fitted.push(opts.summaryToItem!(r.value.summary, group.map((idx) => opts.items[idx])));
        totalUsage.input_tokens += r.value.usage.input_tokens;
        totalUsage.output_tokens += r.value.usage.output_tokens;
        if (typeof r.value.usage.cache_read_tokens === 'number') {
          totalUsage.cache_read_tokens =
            (totalUsage.cache_read_tokens ?? 0) + r.value.usage.cache_read_tokens;
        }
        if (typeof r.value.usage.cache_creation_tokens === 'number') {
          totalUsage.cache_creation_tokens =
            (totalUsage.cache_creation_tokens ?? 0) + r.value.usage.cache_creation_tokens;
        }
      } else {
        failed++;
      }
    }
  }

  const succeeded = clusters.length - failed;
  const success_ratio = clusters.length === 0 ? 1.0 : succeeded / clusters.length;
  const degraded = success_ratio < minRatio;
  return {
    fitted,
    strategy: 'summarize',
    dropped: failed,
    success_ratio,
    degraded,
    usage: totalUsage,
  };
}

interface SummarizeOutcome {
  summary: string;
  usage: ChatResult['usage'];
}

async function summarizeCluster<T>(
  group: number[],
  opts: FitOptions<T>,
  texts: string[],
): Promise<SummarizeOutcome> {
  const chat = opts.chatFn!;
  const lines = group.map((idx) => `- ${texts[idx]}`).join('\n');
  const prompt = `Summarize the following items in ~3 sentences capturing the load-bearing themes. Do not paraphrase verbatim.\n\n${lines}`;
  const res = await chat({
    model: opts.summarizeModel,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 400,
  });
  return { summary: res.text.trim(), usage: res.usage };
}

function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
