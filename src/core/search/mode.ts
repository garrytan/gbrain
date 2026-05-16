/**
 * v0.32.3 search-lite mode bundles.
 *
 * Three named modes that bundle the search-lite knobs from PR #897 into a
 * single config key so users pick once at install time and stop thinking
 * about it. Each mode resolves to a complete knob set; per-call SearchOpts
 * and per-key config overrides still win — mode just supplies the default.
 *
 * The resolution chain matches the v0.31.12 model-tier pattern at
 * `src/core/model-config.ts:resolveModel`:
 *   per-call opts → per-key config → MODE_BUNDLES[cfg.search.mode] → MODE_BUNDLES.balanced
 *
 * `resolveSearchMode` is called at the top of bare `hybridSearch`, NOT just
 * inside the `hybridSearchCached` wrapper. Eval commands (`eval replay`,
 * `eval longmemeval`) call bare hybridSearch and must test the same
 * mode-affected behavior as production. See `[CDX-5+6]` in the plan.
 *
 * `knobsHash` produces the SHA-256 the query cache uses to prevent
 * cross-mode contamination. The PR #897 cache keyed only on
 * (source_id, query_text) — a tokenmax run with expansion+limit=50 would
 * populate a row that a subsequent conservative call reads back. Migration
 * v56 adds `knobs_hash` column; lookup filters by knobs_hash equality AND
 * embedding similarity. See `[CDX-4]` in the plan.
 */

import { createHash } from 'crypto';

export type SearchMode = 'conservative' | 'balanced' | 'tokenmax';

export const SEARCH_MODES: ReadonlyArray<SearchMode> = Object.freeze([
  'conservative',
  'balanced',
  'tokenmax',
]);

/**
 * A complete knob set for one mode. Every field is required so the bundle
 * is self-contained and per-key overrides are obvious diffs.
 */
export interface ModeBundle {
  /** Semantic query cache (PR #897). Free win; on for everyone. */
  cache_enabled: boolean;
  cache_similarity_threshold: number;
  cache_ttl_seconds: number;
  /** Zero-LLM intent classifier weight adjustments (PR #897). On for everyone. */
  intentWeighting: boolean;
  /**
   * Per-call token budget cap (PR #897). undefined = no-op (tokenmax).
   * 4000 = tight (conservative, fits Haiku context loop).
   * 12000 = balanced (sweet-spot for Sonnet).
   */
  tokenBudget: number | undefined;
  /**
   * LLM multi-query expansion (Haiku call per search).
   * Per CLAUDE.md TODOS the corpus eval shows ~97.6% lift relative to no
   * expansion — barely measurable. Off for conservative/balanced;
   * on for tokenmax to preserve power-user retrieval ceiling.
   */
  expansion: boolean;
  /**
   * Default `limit` for the operation layer (`src/core/operations.ts:1087`).
   * Note: production `query` op TODAY defaults to 20. Mode bundle becomes
   * the default ONLY when the caller omits the field — same chain semantics
   * as model-tier resolution. See `[CDX-1+2+3]` in the plan: the original
   * "tokenmax preserves Garry's setup" framing is wrong; tokenmax is an
   * EXPANSION from the implicit current default (limit 20).
   */
  searchLimit: number;
  /**
   * v0.35.0.0+ — cross-encoder reranker. Off for conservative/balanced,
   * on for tokenmax. ZeroEntropy zerank-2 by default; can be overridden
   * via `search.reranker.model`. Slots between dedup and token-budget
   * enforcement in hybrid.ts; fail-open on any RerankError (audit-logged).
   * Cost anchor: ~$0.0003/query at tokenmax topNIn=30 × ~400 tokens/chunk
   * (rounding error vs Opus, meaningful vs Haiku).
   */
  reranker_enabled: boolean;
  /**
   * Provider:model for the reranker. Default `'zeroentropyai:zerank-2'`.
   * Other ZE rerankers (`zerank-1`, `zerank-1-small`) work via the same
   * recipe; future Cohere/Voyage rerankers drop in as new recipes
   * declaring `touchpoints.reranker`.
   */
  reranker_model: string;
  /** Candidates to send upstream (default 30). The full result list always
   *  reaches the user — topNIn just caps API spend on the rerank call. */
  reranker_top_n_in: number;
  /**
   * Truncate the reranked output to this many. `null` = no truncate; the
   * caller's `limit` is what trims final output. Distinct from undefined
   * (which would fall through to mode bundle) — `null` is the explicit
   * "don't truncate" signal, see CDX2-F15+F16.
   */
  reranker_top_n_out: number | null;
  /** HTTP timeout in ms (default 5000). Threaded into gateway.rerank. */
  reranker_timeout_ms: number;
}

/**
 * The three mode bundles. Frozen at import time so a typo can't redefine
 * "conservative" to mean different things on different installs — the
 * public eval table depends on these being canonical. Power-user
 * customization happens via per-key config overrides; if there's real
 * demand for a custom bundle, that's a v0.34 conversation.
 */
export const MODE_BUNDLES: Readonly<Record<SearchMode, Readonly<ModeBundle>>> = Object.freeze({
  conservative: Object.freeze({
    cache_enabled: true,
    cache_similarity_threshold: 0.92,
    cache_ttl_seconds: 3600,
    intentWeighting: true,
    tokenBudget: 4000,
    expansion: false,
    searchLimit: 10,
    // v0.35.0.0+: reranker off — conservative is cost-sensitive; reranker
    // spend doesn't fit the tier's value prop.
    reranker_enabled: false,
    reranker_model: 'zeroentropyai:zerank-2',
    reranker_top_n_in: 30,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
  }),
  balanced: Object.freeze({
    cache_enabled: true,
    cache_similarity_threshold: 0.92,
    cache_ttl_seconds: 3600,
    intentWeighting: true,
    tokenBudget: 12000,
    expansion: false,
    searchLimit: 25,
    // Off in balanced too — operators opt in via
    // `gbrain config set search.reranker.enabled true` until eval data
    // backs a mode-bundle default change.
    reranker_enabled: false,
    reranker_model: 'zeroentropyai:zerank-2',
    reranker_top_n_in: 30,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
  }),
  tokenmax: Object.freeze({
    cache_enabled: true,
    cache_similarity_threshold: 0.92,
    cache_ttl_seconds: 3600,
    intentWeighting: true,
    tokenBudget: undefined,
    expansion: true,
    searchLimit: 50,
    // tokenmax is the high-cost-tolerant tier that already pays for LLM
    // expansion + 50-result payloads. Reranker is the natural capstone:
    // better ordering of a large candidate set is where rerankers earn
    // their fee. ~$0.0003/query at this shape; rounding error vs the
    // tier's $700/mo @ Opus pairing per CLAUDE.md cost matrix.
    reranker_enabled: true,
    reranker_model: 'zeroentropyai:zerank-2',
    reranker_top_n_in: 30,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
  }),
});

export const DEFAULT_SEARCH_MODE: SearchMode = 'balanced';

export function isSearchMode(x: unknown): x is SearchMode {
  return typeof x === 'string' && (SEARCH_MODES as ReadonlyArray<string>).includes(x);
}

/**
 * Per-key config overrides. Read at search-time from the `config` table.
 * Every field is optional; an undefined field means "fall through to the
 * mode bundle default."
 */
export interface SearchKeyOverrides {
  cache_enabled?: boolean;
  cache_similarity_threshold?: number;
  cache_ttl_seconds?: number;
  intentWeighting?: boolean;
  tokenBudget?: number;
  expansion?: boolean;
  searchLimit?: number;
  // v0.35.0.0+ reranker overrides
  reranker_enabled?: boolean;
  reranker_model?: string;
  reranker_top_n_in?: number;
  // CDX2-F16: null is the explicit "don't truncate" signal; undefined
  // means "fall through to mode bundle". Use number | null, not
  // number | undefined.
  reranker_top_n_out?: number | null;
  reranker_timeout_ms?: number;
}

/**
 * Per-call opts that can override the bundle for this single search.
 * Same shape as ModeBundle but every field is optional. These are passed
 * through from `SearchOpts` / `HybridSearchOpts` so the existing per-call
 * surface continues to work — mode just provides the default that the
 * caller's explicit field overrides.
 */
export interface SearchPerCallOpts {
  cache_enabled?: boolean;
  cache_similarity_threshold?: number;
  cache_ttl_seconds?: number;
  intentWeighting?: boolean;
  tokenBudget?: number;
  expansion?: boolean;
  searchLimit?: number;
  // v0.35.0.0+ reranker per-call overrides (same shape as SearchKeyOverrides).
  reranker_enabled?: boolean;
  reranker_model?: string;
  reranker_top_n_in?: number;
  reranker_top_n_out?: number | null;
  reranker_timeout_ms?: number;
}

/**
 * Resolve the active search knob set for one search call.
 *
 * Resolution chain (matches v0.31.12 model-tier semantics):
 *   1. perCallOpts.<key> if defined → wins
 *   2. config.search.<key> if defined → wins
 *   3. MODE_BUNDLES[config.search.mode].<key> → mode default
 *   4. MODE_BUNDLES.balanced.<key> → safety fallback when config.search.mode is invalid/unset
 *
 * Pure function: no DB calls, no env reads. Caller pre-loads the relevant
 * config rows (one SELECT for the whole batch of keys, not one per key).
 */
export interface ResolveSearchModeInput {
  /** Resolved value of `config.search.mode`. Undefined → fallback to balanced. */
  mode?: string;
  /** Resolved per-key overrides from config table. */
  overrides?: SearchKeyOverrides;
  /** Per-call opts (SearchOpts / HybridSearchOpts). */
  perCall?: SearchPerCallOpts;
}

export interface ResolvedSearchKnobs extends ModeBundle {
  /** Which mode bundle supplied the defaults (after fallback). */
  resolved_mode: SearchMode;
  /** True if the caller's `mode` input was a recognized SearchMode. */
  mode_valid: boolean;
}

export function resolveSearchMode(input: ResolveSearchModeInput): ResolvedSearchKnobs {
  const requested = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  const valid = isSearchMode(requested);
  const resolved_mode: SearchMode = valid ? (requested as SearchMode) : DEFAULT_SEARCH_MODE;
  const bundle = MODE_BUNDLES[resolved_mode];

  const ov = input.overrides ?? {};
  const pc = input.perCall ?? {};

  const pick = <K extends keyof ModeBundle>(key: K): ModeBundle[K] => {
    if (pc[key] !== undefined) return pc[key] as ModeBundle[K];
    if (ov[key] !== undefined) return ov[key] as ModeBundle[K];
    return bundle[key];
  };

  return {
    cache_enabled: pick('cache_enabled'),
    cache_similarity_threshold: pick('cache_similarity_threshold'),
    cache_ttl_seconds: pick('cache_ttl_seconds'),
    intentWeighting: pick('intentWeighting'),
    tokenBudget: pick('tokenBudget'),
    expansion: pick('expansion'),
    searchLimit: pick('searchLimit'),
    reranker_enabled: pick('reranker_enabled'),
    reranker_model: pick('reranker_model'),
    reranker_top_n_in: pick('reranker_top_n_in'),
    reranker_top_n_out: pick('reranker_top_n_out'),
    reranker_timeout_ms: pick('reranker_timeout_ms'),
    resolved_mode,
    mode_valid: valid,
  };
}

/**
 * Per-knob source attribution for `gbrain search modes` dashboard.
 * Tells the user where each resolved value came from so override drift
 * is legible. Mirrors `gbrain models` (v0.31.12) attribution shape.
 */
export type KnobSource = 'per-call' | 'override' | 'mode' | 'fallback';

export interface ResolvedKnobAttribution {
  knob: keyof ModeBundle;
  value: ModeBundle[keyof ModeBundle];
  source: KnobSource;
  // For 'override' source, the config key path; for 'mode' source, the mode name.
  source_detail: string;
}

export function attributeKnob<K extends keyof ModeBundle>(
  knob: K,
  input: ResolveSearchModeInput,
  resolved: ResolvedSearchKnobs,
): ResolvedKnobAttribution {
  const pc = input.perCall ?? {};
  const ov = input.overrides ?? {};
  if (pc[knob] !== undefined) {
    return { knob, value: resolved[knob], source: 'per-call', source_detail: 'SearchOpts' };
  }
  if (ov[knob] !== undefined) {
    return { knob, value: resolved[knob], source: 'override', source_detail: `config: search.${knob}` };
  }
  if (resolved.mode_valid) {
    return { knob, value: resolved[knob], source: 'mode', source_detail: `mode: ${resolved.resolved_mode}` };
  }
  return { knob, value: resolved[knob], source: 'fallback', source_detail: `mode: ${DEFAULT_SEARCH_MODE} (default — search.mode unset)` };
}

/**
 * Stable hash of the resolved knob set. Used as part of the query_cache
 * primary key so a tokenmax cache write can't be served to a conservative
 * lookup (cross-mode contamination, [CDX-4]).
 *
 * Knob order is FIXED so the hash is deterministic across releases. NEVER
 * reorder or add a knob without bumping a constant — a hash collision would
 * mean stale cache rows silently reading the wrong shape.
 */
// v0.35.0.0+ bump 1→2: reranker fields participate in the cache key so a
// tokenmax-with-reranker write can't be served to a reranker-off lookup.
// CDX2-F13 convention: under a version bump, additions are APPEND-ONLY at
// the end of `parts[]` — reordering existing fields would silently rebuild
// the hash for every existing row.
//
// CDX2-F12 mid-deploy duplicate-row note: because `cacheRowId()` (in
// src/core/search/query-cache.ts) includes knobsHash, a v=1 process and a
// v=2 process writing the same `(source_id, query_text)` produce DISTINCT
// row IDs. Expect a temporary hit-rate dip + cache-row doubling for hot
// queries during a rolling deploy. Clears naturally within
// `cache.ttl_seconds` (default 3600s). The CHANGELOG note covers this.
export const KNOBS_HASH_VERSION = 2;

export function knobsHash(knobs: ResolvedSearchKnobs): string {
  // Fixed-order key list. Adding a knob here REQUIRES bumping
  // KNOBS_HASH_VERSION and is a breaking change for any persisted cache.
  const parts = [
    `v=${KNOBS_HASH_VERSION}`,
    `mode=${knobs.resolved_mode}`,
    `cache=${knobs.cache_enabled ? 1 : 0}`,
    `sim=${knobs.cache_similarity_threshold.toFixed(4)}`,
    `ttl=${knobs.cache_ttl_seconds}`,
    `iw=${knobs.intentWeighting ? 1 : 0}`,
    `tb=${knobs.tokenBudget ?? 'none'}`,
    `exp=${knobs.expansion ? 1 : 0}`,
    `lim=${knobs.searchLimit}`,
    // v=2 additions (append-only).
    `rr=${knobs.reranker_enabled ? 1 : 0}`,
    `rrm=${knobs.reranker_model}`,
    `rri=${knobs.reranker_top_n_in}`,
    `rro=${knobs.reranker_top_n_out ?? 'none'}`,
    `rrt=${knobs.reranker_timeout_ms}`,
  ];
  const h = createHash('sha256');
  h.update(parts.join('|'));
  return h.digest('hex').slice(0, 16);
}

/**
 * Convenience: build SearchKeyOverrides from a flat config-table snapshot.
 * Used by hybridSearch's hot path so the search code pays one round-trip
 * to load all relevant config keys rather than one per knob.
 *
 * Returns sparse overrides — only keys actually present in the config
 * map appear. Falsy/missing keys fall through to the mode bundle default.
 */
export function loadOverridesFromConfig(
  configMap: Record<string, string | undefined>,
): SearchKeyOverrides {
  const out: SearchKeyOverrides = {};
  const get = (k: string): string | undefined => configMap[k];

  const ce = get('search.cache.enabled');
  if (ce !== undefined) {
    out.cache_enabled = ce === '1' || ce.toLowerCase() === 'true';
  }
  const st = get('search.cache.similarity_threshold');
  if (st !== undefined) {
    const n = parseFloat(st);
    if (Number.isFinite(n) && n > 0 && n <= 1) out.cache_similarity_threshold = n;
  }
  const tt = get('search.cache.ttl_seconds');
  if (tt !== undefined) {
    const n = parseInt(tt, 10);
    if (Number.isFinite(n) && n > 0) out.cache_ttl_seconds = n;
  }
  const iw = get('search.intentWeighting');
  if (iw !== undefined) {
    out.intentWeighting = iw === '1' || iw.toLowerCase() === 'true';
  }
  const tb = get('search.tokenBudget');
  if (tb !== undefined) {
    const n = parseInt(tb, 10);
    if (Number.isFinite(n) && n > 0) out.tokenBudget = n;
  }
  const ex = get('search.expansion');
  if (ex !== undefined) {
    out.expansion = ex === '1' || ex.toLowerCase() === 'true';
  }
  const sl = get('search.searchLimit');
  if (sl !== undefined) {
    const n = parseInt(sl, 10);
    if (Number.isFinite(n) && n > 0) out.searchLimit = n;
  }

  // v0.35.0.0+ reranker overrides
  const re = get('search.reranker.enabled');
  if (re !== undefined) {
    out.reranker_enabled = re === '1' || re.toLowerCase() === 'true';
  }
  const rm = get('search.reranker.model');
  if (rm !== undefined && rm.trim().length > 0) {
    out.reranker_model = rm.trim();
  }
  const ri = get('search.reranker.top_n_in');
  if (ri !== undefined) {
    const n = parseInt(ri, 10);
    if (Number.isFinite(n) && n > 0) out.reranker_top_n_in = n;
  }
  // CDX2-F15 null parsing: top_n_out distinguishes three input shapes:
  //   key absent → undefined → fall through to mode bundle
  //   'null' / 'none' / '' → explicit null (no truncate)
  //   positive integer → that number
  const ro = get('search.reranker.top_n_out');
  if (ro !== undefined) {
    const trimmed = ro.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'none') {
      out.reranker_top_n_out = null;
    } else {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n) && n > 0) out.reranker_top_n_out = n;
    }
  }
  const rt = get('search.reranker.timeout_ms');
  if (rt !== undefined) {
    const n = parseInt(rt, 10);
    if (Number.isFinite(n) && n > 0) out.reranker_timeout_ms = n;
  }

  return out;
}

/** The full list of config keys this module reads. Used by `gbrain search modes --reset`. */
export const SEARCH_MODE_CONFIG_KEYS: ReadonlyArray<string> = Object.freeze([
  'search.cache.enabled',
  'search.cache.similarity_threshold',
  'search.cache.ttl_seconds',
  'search.intentWeighting',
  'search.tokenBudget',
  'search.expansion',
  'search.searchLimit',
  // v0.35.0.0+ reranker keys
  'search.reranker.enabled',
  'search.reranker.model',
  'search.reranker.top_n_in',
  'search.reranker.top_n_out',
  'search.reranker.timeout_ms',
]);

/**
 * The mode-selection config key itself. Separated from SEARCH_MODE_CONFIG_KEYS
 * because `--reset` clears OVERRIDES (the per-knob keys) but should NOT clear
 * the operator's mode choice.
 */
export const SEARCH_MODE_KEY = 'search.mode';

/**
 * Load the live mode config (mode + per-key overrides) from the brain engine.
 * Runs ONE round-trip per knob currently — the BrainEngine.getConfig interface
 * is single-key. A future v0.34 batch loader can collapse this. Volume is
 * small (~8 keys); call site is once per search.
 *
 * Errors are swallowed and fall through to mode-bundle defaults. The cache
 * config table predates v0.32.3 and may not exist on very old brains, so
 * silent fallback is the right shape.
 */
export async function loadSearchModeConfig(
  engine: { getConfig(key: string): Promise<string | null> },
): Promise<ResolveSearchModeInput> {
  const safeGet = async (k: string): Promise<string | undefined> => {
    try {
      const v = await engine.getConfig(k);
      return v == null ? undefined : v;
    } catch {
      return undefined;
    }
  };

  const [mode, ...overrideValues] = await Promise.all([
    safeGet(SEARCH_MODE_KEY),
    ...SEARCH_MODE_CONFIG_KEYS.map(safeGet),
  ]);

  const configMap: Record<string, string | undefined> = {};
  SEARCH_MODE_CONFIG_KEYS.forEach((key, i) => {
    if (overrideValues[i] !== undefined) configMap[key] = overrideValues[i];
  });

  return {
    mode,
    overrides: loadOverridesFromConfig(configMap),
  };
}

