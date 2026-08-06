/**
 * openrouter-rates.ts — cached OpenRouter rate table.
 *
 * OpenRouter resells other vendors' models and can charge its own spread, so a
 * router-prefixed id (`openrouter:openai/gpt-5.2`) must NOT be priced by
 * aliasing it to the vendor's direct rate — that under-estimates spend and
 * hands back a cap that is quietly wrong. Historically such ids simply priced
 * `null`, which under the TX2 contract (BudgetTracker hard-fails when a cap is
 * set and pricing is missing) took out every cost-capped path for anyone
 * routing through OpenRouter. See garrytan/gbrain#2504.
 *
 * OpenRouter publishes both halves machine-readably, on two SEPARATE endpoints:
 *
 *   GET /api/v1/models             chat/completion only — no embedding entries
 *   GET /api/v1/embeddings/models  embedding models, with pricing
 *
 * Both report `pricing.prompt` / `pricing.completion` as USD **per token** as
 * decimal strings; this module normalizes to USD per 1M tokens to match
 * `model-pricing.ts` and `embedding-pricing.ts`.
 *
 * ── Resolution order (deliberate) ────────────────────────────────────────────
 *   1. in-memory (this process)
 *   2. disk cache — last successful fetch, used REGARDLESS OF AGE
 *   3. caller's bundled table (the hardcoded constants) as the floor
 *   4. undefined → caller decides (null estimate → TX2 refusal)
 *
 * A failed or absent fetch is a NON-EVENT: it logs nothing to the hot path,
 * keeps serving the last good cache, and never causes a refusal on its own.
 * That is the whole point — refusing to spend because a network call timed out
 * would recreate the class of bug this exists to fix. Rates move on the order
 * of months (gbrain's own bundled table was still cent-accurate 11 days after
 * its verification stamp), so a stale cache is overwhelmingly better than none.
 *
 * Reads are SYNCHRONOUS by necessity: `BudgetTracker.reserve()` prices inline,
 * so a lookup can never await. Refresh is async and runs OUT OF BAND (cycle /
 * doctor), never at reserve time.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { gbrainPath } from './config.ts';
import { splitProviderModelId } from './model-id.ts';
import type { ModelPricing } from './model-pricing.ts';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_EMBEDDING_URL = 'https://openrouter.ai/api/v1/embeddings/models';

/** Cache schema. Bump `schema_version` on any shape change; readers reject mismatches. */
export const RATES_SCHEMA_VERSION = 1;

export interface OpenRouterRatesCache {
  schema_version: number;
  /** ISO timestamp of the last SUCCESSFUL fetch. */
  fetched_at: string;
  /** `openai/gpt-5.2` → USD per 1M tokens. */
  chat: Record<string, ModelPricing>;
  /** `openai/text-embedding-3-small` → USD per 1M tokens. */
  embedding: Record<string, number>;
}

export function ratesCachePath(): string {
  return gbrainPath('openrouter-rates.json');
}

// ── read path (sync, hot) ───────────────────────────────────────────────────

let _memo: OpenRouterRatesCache | null | undefined;

/** Reset the in-process memo. Tests only. */
export function _resetRatesMemo(): void {
  _memo = undefined;
}

/**
 * Last known rates, or null when there is no usable cache. Never throws — a
 * missing, unreadable, malformed, or schema-mismatched cache is indistinguishable
 * from "no cache yet" and must degrade to the caller's bundled table.
 */
export function readCachedRates(): OpenRouterRatesCache | null {
  if (_memo !== undefined) return _memo;
  try {
    const raw = readFileSync(ratesCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as OpenRouterRatesCache;
    if (
      !parsed ||
      parsed.schema_version !== RATES_SCHEMA_VERSION ||
      typeof parsed.chat !== 'object' ||
      typeof parsed.embedding !== 'object'
    ) {
      _memo = null;
      return null;
    }
    _memo = parsed;
    return parsed;
  } catch {
    _memo = null;
    return null;
  }
}

/**
 * Strip a leading `openrouter` provider segment, returning the catalogue id
 * (`openai/gpt-5.2`). Null for anything that is not a router id.
 *
 * Delegates to `splitProviderModelId` rather than hand-splitting on ':' so it
 * inherits slash-form support — `openrouter/openai/gpt-5.2` arrives from CLI
 * flags and recipe lists exactly as the colon form does (see #1540/#1698), and
 * a colon-only check would silently miss it.
 */
export function routerTail(modelId: string): string | null {
  const { provider, model } = splitProviderModelId(modelId);
  if (!provider || provider.trim().toLowerCase() !== 'openrouter') return null;
  const tail = (model ?? '').trim();
  return tail.length > 0 ? tail : null;
}

/** Chat rate for an `openrouter:`-prefixed id, or undefined when unknown. */
export function lookupOpenRouterChatPrice(modelId: string): ModelPricing | undefined {
  const tail = routerTail(modelId);
  if (!tail) return undefined;
  return readCachedRates()?.chat[tail];
}

/** Embedding rate (USD per 1M tokens) for an `openrouter:`-prefixed id. */
export function lookupOpenRouterEmbeddingPrice(modelId: string): number | undefined {
  const tail = routerTail(modelId);
  if (!tail) return undefined;
  return readCachedRates()?.embedding[tail];
}

/** Age of the cache in days, or null when there is none. Surfaced by doctor. */
export function ratesAgeDays(): number | null {
  const cached = readCachedRates();
  if (!cached?.fetched_at) return null;
  const ms = Date.now() - Date.parse(cached.fetched_at);
  return Number.isFinite(ms) ? ms / 86_400_000 : null;
}

// ── refresh path (async, out-of-band) ───────────────────────────────────────

interface RawModel {
  id?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
}

/** Decimal-string USD/token → USD/1M-tokens. Returns null for junk. */
function perMTok(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

async function fetchJson(url: string, timeoutMs: number): Promise<{ data?: RawModel[] } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as { data?: RawModel[] };
  } catch {
    return null;
  }
}

export interface RefreshResult {
  ok: boolean;
  chatCount: number;
  embeddingCount: number;
  /** Populated when ok=false; the previous cache is left untouched. */
  error?: string;
}

/**
 * Fetch both catalogues and replace the cache. On any failure the previous
 * cache is left exactly as it was — a bad refresh must never be worse than no
 * refresh. Run from maintenance paths only, never from a pricing lookup.
 */
export async function refreshOpenRouterRates(
  opts: { timeoutMs?: number } = {},
): Promise<RefreshResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const [chatRes, embedRes] = await Promise.all([
    fetchJson(OPENROUTER_CHAT_URL, timeoutMs),
    fetchJson(OPENROUTER_EMBEDDING_URL, timeoutMs),
  ]);

  if (!chatRes && !embedRes) {
    return { ok: false, chatCount: 0, embeddingCount: 0, error: 'both catalogue fetches failed' };
  }

  const chat: Record<string, ModelPricing> = {};
  for (const m of chatRes?.data ?? []) {
    if (typeof m?.id !== 'string') continue;
    const input = perMTok(m.pricing?.prompt);
    const output = perMTok(m.pricing?.completion);
    // Free models legitimately price 0; only a missing/unparseable rate is a skip.
    if (input === null || output === null) continue;
    chat[m.id] = { input, output };
  }

  const embedding: Record<string, number> = {};
  for (const m of embedRes?.data ?? []) {
    if (typeof m?.id !== 'string') continue;
    const rate = perMTok(m.pricing?.prompt);
    if (rate === null) continue;
    embedding[m.id] = rate;
  }

  // Refuse to overwrite a good cache with an empty one — a 200 carrying no
  // usable rows is a upstream-shape change, not a reason to lose what we have.
  if (Object.keys(chat).length === 0 && Object.keys(embedding).length === 0) {
    return { ok: false, chatCount: 0, embeddingCount: 0, error: 'catalogues returned no priceable models' };
  }

  const previous = readCachedRates();
  const next: OpenRouterRatesCache = {
    schema_version: RATES_SCHEMA_VERSION,
    fetched_at: new Date().toISOString(),
    // A half-failure keeps the other half from the previous cache rather than
    // dropping it: losing embedding rates because the chat endpoint blipped
    // would re-break capped enrich runs.
    chat: Object.keys(chat).length > 0 ? chat : (previous?.chat ?? {}),
    embedding: Object.keys(embedding).length > 0 ? embedding : (previous?.embedding ?? {}),
  };

  try {
    const path = ratesCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (err) {
    return {
      ok: false,
      chatCount: 0,
      embeddingCount: 0,
      error: `cache write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  _memo = next;
  return {
    ok: true,
    chatCount: Object.keys(next.chat).length,
    embeddingCount: Object.keys(next.embedding).length,
  };
}

/** True when the cache is missing or older than `maxAgeDays`. */
export function ratesNeedRefresh(maxAgeDays = 7): boolean {
  const age = ratesAgeDays();
  return age === null || age > maxAgeDays;
}

/** mtime of the cache file, for diagnostics that want it without a parse. */
export function ratesCacheMtime(): Date | null {
  try {
    return statSync(ratesCachePath()).mtime;
  } catch {
    return null;
  }
}
