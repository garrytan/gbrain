/**
 * synopsis-tier.ts — makes `gbrain eval longmemeval --mode tokenmax` measure
 * the vectors production builds for that mode.
 *
 * Production imports every page at the free title tier and leaves the
 * `per_chunk_synopsis` tier to the contextual-reindex backfill, which calls
 * `reembedPageWithContextualRetrieval` per page with the resolved
 * contextual-synopsis model. The benchmark imports the same way, so without
 * this step a tokenmax run scores title-tier vectors. When the resolved mode's
 * tier is `per_chunk_synopsis`, the harness runs that same service on every
 * imported session (same model resolution, prompt, page-level fall-back and
 * guarded install), with two eval-only additions:
 *
 *   - a content-addressed on-disk synopsis cache keyed by the service's own
 *     cache-key shape (`buildSynopsisCacheKey`), so shards and reruns never
 *     pay twice; only answers the model actually returned are cached;
 *   - a spend meter and cap over uncached synopsis calls, priced from the
 *     provider-reported usage.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { BrainEngine } from '../../core/engine.ts';
import {
  computeCorpusGeneration,
  computeSourceTextHash,
  reembedPageWithContextualRetrieval,
  resolveContextualChunkConcurrency,
} from '../../core/contextual-retrieval-service.ts';
import { resolveContextualSynopsisModel } from '../../core/minions/handlers/contextual-reindex-per-chunk.ts';
import {
  buildSynopsisCacheKey,
  generatePerChunkSynopsis,
  SYNOPSIS_DOC_MAX_CHARS,
  SYNOPSIS_MAX_TOKENS,
  SYNOPSIS_PROMPT_VERSION,
  type GeneratePerChunkSynopsisArgs,
  type GeneratePerChunkSynopsisResult,
} from '../../core/page-summary.ts';
import { canonicalLookup } from '../../core/model-pricing.ts';
import type { ResolvedSearchKnobs } from '../../core/search/mode.ts';
import type { RetrievalPins } from './run-config.ts';

const TRANSIENT_ATTEMPTS = 5;

export interface SynopsisTierOptions {
  maxUsd: number;
  concurrency: number;
  cachePath?: string;
}

export function newSynopsisTierOptions(): SynopsisTierOptions {
  return { maxUsd: 20, concurrency: 8 };
}

export const LME_SYNOPSIS_FLAGS: Array<{ name: string; arg?: string; help: string[]; apply: (o: { synopsis: SynopsisTierOptions }, value: string) => void }> = [
  { name: '--synopsis-max-usd', arg: 'N', help: [
      'Spend cap for uncached per-chunk synopses when the resolved mode\'s tier is',
      'per_chunk_synopsis (tokenmax; default 20). At the cap the run stops after',
      'the current question; cached synopses are free.'],
    apply: (o, v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`--synopsis-max-usd must be a positive number (got: ${v})`); o.synopsis.maxUsd = n; } },
  { name: '--synopsis-concurrency', arg: 'N', help: ['Sessions synopsized in parallel per question (default 8; chunks within a session follow GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY).'],
    apply: (o, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`--synopsis-concurrency must be an integer from 1 to 64 (got: ${v})`); o.synopsis.concurrency = n; } },
  { name: '--synopsis-cache', arg: 'FILE', help: ['Synopsis cache (JSONL). Default: ~/.cache/gbrain-eval/synopsis-<model>.jsonl.'],
    apply: (o, v) => { o.synopsis.cachePath = v; } },
];

export function defaultSynopsisCachePath(model: string): string {
  return join(homedir(), '.cache', 'gbrain-eval', `synopsis-${model.replace(/[^a-z0-9.-]+/gi, '_')}.jsonl`);
}

export class SynopsisSpendCapReached extends Error {
  constructor(readonly maxUsd: number, readonly cachePath: string) {
    super(`synopsis spend reached its cap ($${maxUsd.toFixed(2)}); raise --synopsis-max-usd or reuse the cache at ${cachePath}`);
    this.name = 'SynopsisSpendCapReached';
  }
}

export class SynopsisSpend {
  usd = 0;
  calls = 0;
  cacheHits = 0;
  inputTokens = 0;
  outputTokens = 0;
  constructor(readonly maxUsd: number) {}
  add(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): number {
    this.calls++;
    if (!usage) return 0;
    this.inputTokens += usage.input_tokens ?? 0;
    this.outputTokens += usage.output_tokens ?? 0;
    const p = canonicalLookup(model);
    if (!p) return 0;
    const usd = ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output) / 1_000_000;
    this.usd += usd;
    return usd;
  }
  exhausted(): boolean {
    return this.usd >= this.maxUsd;
  }
}

type CachedSynopsis = { kind: GeneratePerChunkSynopsisResult['kind']; synopsis?: string; detail?: string };

class SynopsisCache {
  private readonly map = new Map<string, CachedSynopsis>();
  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { key: string; value: CachedSynopsis };
        if (row && typeof row.key === 'string' && row.value && typeof row.value.kind === 'string') this.map.set(row.key, row.value);
      } catch { /* a torn final line is skipped */ }
    }
  }
  get(key: string): CachedSynopsis | undefined { return this.map.get(key); }
  set(key: string, value: CachedSynopsis): void {
    this.map.set(key, value);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ key, value })}\n`);
  }
}

const caches = new Map<string, SynopsisCache>();
function cacheFor(path: string): SynopsisCache {
  let c = caches.get(path);
  if (!c) { c = new SynopsisCache(path); caches.set(path, c); }
  return c;
}

export interface SynopsisTier {
  model: string;
  maxTokens: number;
  cachePath: string;
  concurrency: number;
  chunkConcurrency: number;
  spend: SynopsisSpend;
  /** Set when the run stopped early because the spend cap was reached. */
  stoppedAtCap: boolean;
}

/** Pins folded into retrieval_config_hash for a synopsis-tier run. */
export function synopsisPins(tier: SynopsisTier): Record<string, unknown> {
  return { model: tier.model, prompt_version: SYNOPSIS_PROMPT_VERSION, doc_max_chars: SYNOPSIS_DOC_MAX_CHARS, max_tokens: tier.maxTokens };
}

/**
 * The synopsis tier for this run, or null when the resolved mode does not
 * build synopsis vectors (or the run never embeds). The model resolves the
 * way the production backfill resolves it on a brain with no override, and
 * its pins join the run's retrieval pins (so retrieval_config_hash covers it).
 */
export async function resolveSynopsisTier(knobs: ResolvedSearchKnobs, keywordOnly: boolean, o: SynopsisTierOptions, pins: RetrievalPins): Promise<SynopsisTier | null> {
  if (keywordOnly || knobs.contextual_retrieval_disabled || knobs.contextual_retrieval !== 'per_chunk_synopsis') return null;
  const model = await resolveContextualSynopsisModel(null);
  const tier: SynopsisTier = {
    model,
    maxTokens: SYNOPSIS_MAX_TOKENS,
    cachePath: o.cachePath ?? defaultSynopsisCachePath(model),
    concurrency: o.concurrency,
    chunkConcurrency: resolveContextualChunkConcurrency(),
    spend: new SynopsisSpend(o.maxUsd),
    stoppedAtCap: false,
  };
  pins.contextual_synopsis = synopsisPins(tier);
  return tier;
}

/** Run-end stderr lines for the synopsis tier; true when the run stopped at the spend cap (a failed run). */
export function reportSynopsisRunEnd(tier: SynopsisTier | null, questionsRun: number): boolean {
  if (!tier || questionsRun === 0) return false;
  const sp = tier.spend;
  process.stderr.write(`[longmemeval] synopsis tier: ${tier.model}, ${sp.calls} call(s), ${sp.cacheHits} cache hit(s), ${sp.inputTokens} in / ${sp.outputTokens} out tokens, $${sp.usd.toFixed(4)} (cap $${sp.maxUsd.toFixed(2)}; cache ${tier.cachePath})\n`);
  if (!tier.stoppedAtCap) return false;
  process.stderr.write(`[longmemeval] FAIL --synopsis-max-usd: synopsis spend reached $${sp.maxUsd.toFixed(2)}; the run stopped early. Resume with a higher cap (cached synopses are free).\n`);
  return true;
}

function cacheKey(args: GeneratePerChunkSynopsisArgs, model: string, maxTokens: number): string {
  return buildSynopsisCacheKey({
    contentHash: createHash('sha256').update(`${args.pageTitle}\n${maxTokens}\n${args.chunkText}`).digest('hex'),
    chunkIndex: args.chunkIndex,
    corpusGeneration: computeCorpusGeneration({ crMode: 'per_chunk_synopsis', synopsisModel: model, synopsisDocMaxChars: SYNOPSIS_DOC_MAX_CHARS }),
    sourceTextHash: computeSourceTextHash(args.documentText),
  });
}

export interface SynopsisTierResult {
  pages: number;
  pages_synopsis: number;
  pages_fallback: number;
  chunks: number;
  calls: number;
  cache_hits: number;
  usd: number;
}

/**
 * Re-embed every imported session at the synopsis tier through the
 * production service. A transient provider failure retries with backoff; one
 * that persists, a permanent failure, or the spend cap fails the question.
 */
export async function applySynopsisTier(
  engine: BrainEngine,
  pages: ReadonlyArray<{ slug: string }>,
  tier: SynopsisTier,
  generate: typeof generatePerChunkSynopsis = generatePerChunkSynopsis,
): Promise<SynopsisTierResult> {
  const cache = cacheFor(tier.cachePath);
  const out: SynopsisTierResult = { pages: pages.length, pages_synopsis: 0, pages_fallback: 0, chunks: 0, calls: 0, cache_hits: 0, usd: 0 };
  const cachedGenerate: typeof generatePerChunkSynopsis = async (args) => {
    const key = cacheKey(args, tier.model, tier.maxTokens);
    const hit = cache.get(key);
    if (hit) {
      tier.spend.cacheHits++;
      out.cache_hits++;
      return hit.kind === 'success' ? { kind: 'success', synopsis: hit.synopsis ?? '' } : { kind: hit.kind, detail: hit.detail };
    }
    if (tier.spend.exhausted()) throw new SynopsisSpendCapReached(tier.spend.maxUsd, tier.cachePath);
    const res = await generate(args);
    if (!res.usage) return res;
    out.calls++;
    out.usd += tier.spend.add(tier.model, res.usage);
    cache.set(key, res.kind === 'success' ? { kind: 'success', synopsis: res.synopsis } : { kind: res.kind, detail: res.detail });
    return res;
  };
  const queue = [...pages];
  await Promise.all(Array.from({ length: Math.min(tier.concurrency, queue.length) }, async () => {
    for (let page = queue.shift(); page; page = queue.shift()) {
      for (let attempt = 1; ; attempt++) {
        const r = await reembedPageWithContextualRetrieval({
          engine, pageSlug: page.slug, sourceId: 'default', globalMode: 'per_chunk_synopsis',
          synopsisModel: tier.model, synopsisMaxTokens: tier.maxTokens, chunkConcurrency: tier.chunkConcurrency, generateSynopsis: cachedGenerate,
        });
        if (r.kind === 'success') { out.pages_synopsis++; out.chunks += r.chunks_embedded; break; }
        if (r.kind === 'page_fallback') { out.pages_fallback++; out.chunks += r.chunks_embedded; break; }
        if (r.kind === 'skipped') break;
        if (r.kind === 'transient_error' && attempt < TRANSIENT_ATTEMPTS) {
          await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(`synopsis tier ${r.kind} for ${page.slug} (${r.cause}): ${r.detail}`);
      }
    }
  }));
  return out;
}
