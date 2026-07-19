/**
 * Source-Type Boost Map
 *
 * Multiplies into ts_rank / vector cosine score at SQL build time so that
 * curated content (originals/, concepts/, writing/) outranks bulk content
 * (openclaw/chat/, daily/, media/x/) for non-temporal queries.
 *
 * Keyed by slug prefix. Longest-prefix-match wins (sorted at lookup time
 * inside sql-ranking.ts). Defaults grounded in the composition of the
 * canonical brain at ~/git/brain/.
 *
 * Override via env: GBRAIN_SOURCE_BOOST="originals/:1.8,openclaw/chat/:0.3"
 * Hard-exclude via env: GBRAIN_SEARCH_EXCLUDE="test/,scratch/"
 */

export const DEFAULT_SOURCE_BOOSTS: Record<string, number> = {
  // Curated, opinionated, high-signal — Garry's own writing
  'originals/': 1.5,
  // Reusable knowledge frameworks
  'concepts/': 1.3,
  // Long-form essays / articles
  'writing/': 1.4,
  // Entity pages
  'people/': 1.2,
  'companies/': 1.2,
  'deals/': 1.2,
  // Notes from real meetings
  'meetings/': 1.1,
  // Ingested third-party content
  'media/articles/': 1.1,
  'media/repos/': 1.1,
  // Neutral baselines (explicit for clarity)
  'yc/': 1.0,
  'civic/': 1.0,
  // Bulk / noisy
  'daily/': 0.8,
  'media/x/': 0.7,
  // Chat transcripts — massive, noisy, swamp keyword queries
  'openclaw/chat/': 0.5,
  // Archived historical content — findable by default but ranked below curated
  // content (issue #1777). NOT hard-excluded: archive/ routinely holds high-signal
  // history (conversation exports, prior-system logs, older notes) users expect to
  // retrieve. Demote-not-exclude keeps it findable without letting it dominate. The
  // 0.5 is a prior applied in the SQL/fusion layer; the cross-encoder reranker can
  // still PROMOTE a strongly-matching archive page that survives the demote into the
  // rerank candidate window.
  'archive/': 0.5,
  // v0.42 extract_receipt pages — surface when relevant (extraction
  // questions, audit trail) but never dominate user content. Per plan
  // D-EXTRACT-42. Receipts stamp `type: extract_receipt` AND
  // `dream_generated: true` in their frontmatter; demote here keeps them
  // findable but ranked below all curated user content.
  'extracts/': 0.3,
};

/**
 * Hard-excludes — slug prefixes that should never enter search results
 * (unless explicitly opted-in via include_slug_prefixes).
 *
 * These are genuine noise: test fixtures, binary attachments, raw sidecars.
 * `archive/` is deliberately NOT here (issue #1777) — it holds high-signal
 * historical content users expect to find, so it is DEMOTED via
 * DEFAULT_SOURCE_BOOSTS (`archive/`: 0.5) instead of hidden.
 */
export const DEFAULT_HARD_EXCLUDES: string[] = [
  'test/',
  'attachments/',
  '.raw/',
];

/**
 * Parse GBRAIN_SOURCE_BOOST env var.
 * Format: comma-separated prefix:factor pairs.
 * Example: "originals/:1.8,openclaw/chat/:0.3"
 *
 * Malformed entries are skipped silently. Returns empty object if env is
 * unset or unparseable in its entirety.
 */
export function parseSourceBoostEnv(env: string | undefined): Record<string, number> {
  if (!env) return {};
  const out: Record<string, number> = {};
  for (const pair of env.split(',')) {
    const idx = pair.lastIndexOf(':');
    if (idx <= 0) continue;
    const prefix = pair.slice(0, idx).trim();
    const factor = Number.parseFloat(pair.slice(idx + 1).trim());
    if (!prefix || !Number.isFinite(factor) || factor < 0) continue;
    out[prefix] = factor;
  }
  return out;
}

/**
 * Parse GBRAIN_SEARCH_EXCLUDE env var.
 * Format: comma-separated slug prefixes.
 * Example: "test/,scratch/,private/"
 *
 * Blank entries skipped. Returns empty array if env is unset.
 */
export function parseHardExcludesEnv(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Resolve the effective boost map by merging defaults with env override.
 * Env entries override defaults (shallow merge); env-only entries are added.
 */
export function resolveBoostMap(
  envValue: string | undefined = process.env.GBRAIN_SOURCE_BOOST,
): Record<string, number> {
  const override = parseSourceBoostEnv(envValue);
  return { ...DEFAULT_SOURCE_BOOSTS, ...override };
}

/**
 * v0.42.63 — persistent boost-map config key. Value is a JSON object of
 * prefix → factor, e.g. `{"resources/":0.8,"emails/":0.8}`. Set via
 * `gbrain config set search.source_boosts '{"resources/":0.8}'`.
 */
export const SOURCE_BOOSTS_CONFIG_KEY = 'search.source_boosts';

/**
 * Parse the `search.source_boosts` config value (JSON object string).
 * Same per-entry guards as parseSourceBoostEnv (finite factor, >= 0,
 * non-empty prefix) but malformed entries are skipped LOUDLY via a stderr
 * warning — config is user-authored intent, so silent drops would hide a
 * typo'd prefix until someone notices rankings never changed. An
 * unparseable value in its entirety also warns and returns {}.
 */
export function parseSourceBoostConfig(raw: string | null | undefined): Record<string, number> {
  if (raw === undefined || raw === null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[source-boost] ${SOURCE_BOOSTS_CONFIG_KEY} is not valid JSON — ignoring config value`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[source-boost] ${SOURCE_BOOSTS_CONFIG_KEY} must be a JSON object of {"prefix/": factor} — ignoring config value`);
    return {};
  }
  const out: Record<string, number> = {};
  for (const [prefix, factor] of Object.entries(parsed as Record<string, unknown>)) {
    const f = typeof factor === 'number' ? factor : Number.parseFloat(String(factor));
    if (!prefix.trim() || !Number.isFinite(f) || f < 0) {
      console.error(`[source-boost] skipping malformed ${SOURCE_BOOSTS_CONFIG_KEY} entry ${JSON.stringify(prefix)}: ${JSON.stringify(factor)} (need non-empty prefix and finite factor >= 0)`);
      continue;
    }
    out[prefix] = f;
  }
  return out;
}

/**
 * v0.42.63 — the ONE shared async resolution ladder for the effective
 * boost map: DEFAULT_SOURCE_BOOSTS ← `search.source_boosts` config ←
 * GBRAIN_SOURCE_BOOST env (env last: the emergency override that beats
 * config, mirroring the pace-mode precedent). Used by every op-surface
 * caller (hybrid search, the plain `search` op, the image-branch
 * searchVector); engines fall back to env-only resolveBoostMap() only
 * when no map was threaded via SearchOpts.sourceBoosts.
 *
 * Config read failures fall through to defaults+env (fail-open — a config
 * hiccup must never kill search).
 */
export async function resolveSourceBoostsForEngine(
  engine: { getConfig(key: string): Promise<string | null> },
  envValue: string | undefined = process.env.GBRAIN_SOURCE_BOOST,
): Promise<Record<string, number>> {
  let configMap: Record<string, number> = {};
  try {
    const raw = await engine.getConfig(SOURCE_BOOSTS_CONFIG_KEY);
    configMap = parseSourceBoostConfig(typeof raw === 'string' ? raw : undefined);
  } catch {
    // fail-open: defaults + env
  }
  return { ...DEFAULT_SOURCE_BOOSTS, ...configMap, ...parseSourceBoostEnv(envValue) };
}

/**
 * Canonical serialization of a resolved boost map for the query-cache
 * knobs hash: sorted keys, fixed 4-decimal factors, comma-joined. Stable
 * across key insertion order so two processes with the same effective map
 * produce the same hash part.
 */
export function serializeBoostMap(map: Record<string, number>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${k}:${map[k]!.toFixed(4)}`)
    .join(',');
}

/**
 * Resolve the effective hard-exclude prefix list.
 *
 * - Defaults union with env-supplied excludes
 * - Subtract any caller-supplied include_slug_prefixes (opt-back-in)
 * - Caller-supplied exclude_slug_prefixes adds to the union
 */
export function resolveHardExcludes(
  excludeOpt?: string[],
  includeOpt?: string[],
  envValue: string | undefined = process.env.GBRAIN_SEARCH_EXCLUDE,
): string[] {
  const envExcludes = parseHardExcludesEnv(envValue);
  const union = new Set<string>([...DEFAULT_HARD_EXCLUDES, ...envExcludes, ...(excludeOpt ?? [])]);
  if (includeOpt?.length) {
    for (const p of includeOpt) union.delete(p);
  }
  return Array.from(union);
}
