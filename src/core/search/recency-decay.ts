/**
 * v0.29.1 — Per-prefix recency decay map.
 *
 * Drives the recency boost ONLY (per D9 codex resolution). Salience is a
 * separate orthogonal axis based on emotional_weight + take_count and
 * does NOT consume this map. The two axes compose multiplicatively in
 * runPostFusionStages when both opt in.
 *
 * Keyed by slug prefix. Longest-prefix-match wins (sorted at lookup time
 * inside sql-ranking.ts). Defaults are GENERIC prefixes only (no fork-
 * specific names like 'openclaw/chat/' — that's a privacy violation per
 * CLAUDE.md and tracked in iteration-1 codex finding C-CX-3).
 *
 * Override priority (later wins):
 *   1. DEFAULT_RECENCY_DECAY (this file)
 *   2. gbrain.yml `recency:` section
 *   3. GBRAIN_RECENCY_DECAY env var (prefix:halflifeDays:coefficient,...)
 *   4. Per-call SearchOpts.recency_decay (tests + library consumers; not
 *      exposed on MCP)
 *
 * Per-prefix interpretation:
 *   - halflifeDays = 0  → evergreen, no decay (recency component = 0)
 *   - halflifeDays > 0  → hyperbolic decay; coefficient × halflife / (halflife + days_old)
 *   - At days_old=0:        recency component = coefficient (max boost)
 *   - At days_old=halflife: recency component = coefficient / 2
 *
 * Pure module. No side effects. Tested in test/recency-decay.test.ts.
 */

export interface RecencyDecayConfig {
  /** Days at which the recency component is halved. 0 = no decay (evergreen). */
  halflifeDays: number;
  /** Max recency boost contribution at days_old = 0. Must be >= 0. */
  coefficient: number;
}

export type RecencyDecayMap = Record<string, RecencyDecayConfig>;

export const DEFAULT_RECENCY_DECAY: RecencyDecayMap = {
  // Evergreen (curated, opinion, knowledge artifacts) — no decay.
  // concepts/ is the canonical evergreen tier; originals/ + writing/ get
  // long-tail decay so freshly-published essays do see a small nudge.
  'concepts/':       { halflifeDays:   0, coefficient: 0   },
  'originals/':      { halflifeDays: 180, coefficient: 0.5 },
  'writing/':        { halflifeDays: 365, coefficient: 0.4 },

  // Time-bound personal records — strongest decay, biggest coefficient.
  // The user is asking "what was on my plate this week" / "what did we
  // discuss in our 1:1"; freshness IS the signal.
  'daily/':          { halflifeDays:  14, coefficient: 1.5 },
  'meetings/':       { halflifeDays:  60, coefficient: 1.0 },

  // Bulk feeds — generic prefixes only. Real fork names go in user
  // gbrain.yml, never in shipped defaults.
  'chat/':           { halflifeDays:   7, coefficient: 1.0 },
  'media/x/':        { halflifeDays:   7, coefficient: 1.5 },
  'media/articles/': { halflifeDays:  90, coefficient: 0.5 },

  // Entities — slow decay (a deal from 2 years ago is still relevant
  // to a current portfolio query; less so to "what's new lately").
  'people/':         { halflifeDays: 365, coefficient: 0.3 },
  'companies/':      { halflifeDays: 365, coefficient: 0.3 },
  'deals/':          { halflifeDays: 180, coefficient: 0.5 },
};

/** Fallback applied to slugs that don't match any default or override prefix. */
export const DEFAULT_FALLBACK: RecencyDecayConfig = {
  halflifeDays: 90,
  coefficient: 0.5,
};

/** Sentinel error thrown by parsers; CLI catches it and exits with a useful message. */
export class RecencyDecayParseError extends Error {
  constructor(message: string, public readonly source: 'env' | 'yaml' | 'caller') {
    super(message);
    this.name = 'RecencyDecayParseError';
  }
}

/**
 * Parse the GBRAIN_RECENCY_DECAY env var.
 * Format: comma-separated `prefix:halflifeDays:coefficient` triples.
 * Example: "daily/:7:2.0,concepts/:0:0,custom/:30:1.0"
 *
 * Refuses on parse error (codex M-CX-3 / iteration-2 review). The source-boost
 * env parser silently skipped malformed entries; that pattern bit users for
 * years. Recency parser fails LOUD so misconfigurations surface at startup
 * instead of silently degrading rankings.
 */
export function parseRecencyDecayEnv(env: string | undefined): RecencyDecayMap {
  if (!env) return {};
  const out: RecencyDecayMap = {};
  const triples = env.split(',').map(s => s.trim()).filter(Boolean);
  for (const triple of triples) {
    // Prefix can't contain `:` because the field separator is `:`. We split
    // on the FIRST and SECOND `:` from the right so the prefix may safely
    // contain `/` etc. but NOT colons.
    const lastIdx = triple.lastIndexOf(':');
    if (lastIdx <= 0) {
      throw new RecencyDecayParseError(
        `Invalid GBRAIN_RECENCY_DECAY entry "${triple}": expected prefix:halflife:coefficient`,
        'env',
      );
    }
    const beforeLast = triple.slice(0, lastIdx);
    const middleIdx = beforeLast.lastIndexOf(':');
    if (middleIdx <= 0) {
      throw new RecencyDecayParseError(
        `Invalid GBRAIN_RECENCY_DECAY entry "${triple}": expected prefix:halflife:coefficient`,
        'env',
      );
    }
    const prefix = triple.slice(0, middleIdx).trim();
    const halflifeRaw = triple.slice(middleIdx + 1, lastIdx).trim();
    const coefficientRaw = triple.slice(lastIdx + 1).trim();
    const halflife = Number.parseFloat(halflifeRaw);
    const coefficient = Number.parseFloat(coefficientRaw);
    if (!prefix) {
      throw new RecencyDecayParseError(`Empty prefix in GBRAIN_RECENCY_DECAY entry "${triple}"`, 'env');
    }
    if (!Number.isFinite(halflife) || halflife < 0) {
      throw new RecencyDecayParseError(
        `Invalid halflifeDays "${halflifeRaw}" in GBRAIN_RECENCY_DECAY (must be number >= 0; 0 = evergreen)`,
        'env',
      );
    }
    if (!Number.isFinite(coefficient) || coefficient < 0) {
      throw new RecencyDecayParseError(
        `Invalid coefficient "${coefficientRaw}" in GBRAIN_RECENCY_DECAY (must be number >= 0)`,
        'env',
      );
    }
    out[prefix] = { halflifeDays: halflife, coefficient };
  }
  return out;
}

/**
 * Parse a `recency:` section from a parsed gbrain.yml. The shape is:
 *   recency:
 *     daily/: { halflifeDays: 14, coefficient: 1.5 }
 *     concepts/: { halflifeDays: 0, coefficient: 0 }
 *
 * `parsed` is the already-parsed YAML object. This is a pure transform.
 * Caller is responsible for reading + parsing the YAML file.
 */
export function parseRecencyDecayYaml(parsed: unknown): RecencyDecayMap {
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const recency = obj.recency;
  if (recency == null) return {};
  if (typeof recency !== 'object' || Array.isArray(recency)) {
    throw new RecencyDecayParseError(`gbrain.yml recency: must be a map, got ${typeof recency}`, 'yaml');
  }
  const out: RecencyDecayMap = {};
  for (const [prefix, raw] of Object.entries(recency as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new RecencyDecayParseError(
        `gbrain.yml recency."${prefix}" must be an object with halflifeDays + coefficient`,
        'yaml',
      );
    }
    const cfg = raw as Record<string, unknown>;
    const halflife = Number(cfg.halflifeDays);
    const coefficient = Number(cfg.coefficient);
    if (!Number.isFinite(halflife) || halflife < 0) {
      throw new RecencyDecayParseError(
        `gbrain.yml recency."${prefix}".halflifeDays invalid (must be number >= 0)`,
        'yaml',
      );
    }
    if (!Number.isFinite(coefficient) || coefficient < 0) {
      throw new RecencyDecayParseError(
        `gbrain.yml recency."${prefix}".coefficient invalid (must be number >= 0)`,
        'yaml',
      );
    }
    out[prefix] = { halflifeDays: halflife, coefficient };
  }
  return out;
}

/**
 * Merge defaults + yaml + env + caller-supplied overrides into the effective
 * decay map. Later sources win. Empty entries are dropped.
 */
export function resolveRecencyDecayMap(opts: {
  yaml?: unknown;
  envValue?: string;
  caller?: RecencyDecayMap;
} = {}): RecencyDecayMap {
  const fromYaml = opts.yaml !== undefined ? parseRecencyDecayYaml(opts.yaml) : {};
  const fromEnv = parseRecencyDecayEnv(opts.envValue ?? process.env.GBRAIN_RECENCY_DECAY);
  return {
    ...DEFAULT_RECENCY_DECAY,
    ...fromYaml,
    ...fromEnv,
    ...(opts.caller ?? {}),
  };
}
