/**
 * Full-text search language configuration.
 *
 * Postgres tsvector/tsquery require a text search configuration name (e.g.
 * 'english', 'portuguese', 'spanish'). Historically GBrain hardcoded
 * 'english' across engines and trigger functions, which broke search
 * quality for non-English brains (no stemming, no stop-word removal).
 *
 * This helper centralizes the choice. Default stays 'english' for backward
 * compatibility — only users who set GBRAIN_FTS_LANGUAGE see different
 * behavior.
 *
 * Custom configs (e.g. accent-insensitive 'pt_br' built with unaccent +
 * portuguese stemmer) are supported as long as the configuration exists
 * in the target Postgres instance. See docs/guides/multi-language-fts.md
 * for setup instructions.
 *
 * Validation: only allow lowercase letters, digits, and underscores. This
 * prevents SQL injection when the value is interpolated into queries
 * (Postgres tsvector functions don't accept parameterized config names —
 * they must be literals or identifiers).
 */

const VALID_CONFIG_NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_LANGUAGE = 'english';

let cachedLanguage: string | null = null;

/**
 * Returns the configured Postgres text search configuration name.
 *
 * Resolution order:
 *   1. process.env.GBRAIN_FTS_LANGUAGE (if set and valid)
 *   2. 'english' (default — preserves existing behavior)
 *
 * The return value is safe to interpolate directly into SQL because it
 * passes the VALID_CONFIG_NAME guard. If validation fails, falls back to
 * the default and emits a one-time warning.
 *
 * Cached on first call; reset with `resetFtsLanguageCache()` (test only).
 */
export function getFtsLanguage(): string {
  if (cachedLanguage !== null) return cachedLanguage;

  const raw = process.env.GBRAIN_FTS_LANGUAGE?.trim();
  if (!raw) {
    cachedLanguage = DEFAULT_LANGUAGE;
    return cachedLanguage;
  }

  if (!VALID_CONFIG_NAME.test(raw)) {
    console.warn(
      `[gbrain] Invalid GBRAIN_FTS_LANGUAGE='${raw}' — must match /^[a-z][a-z0-9_]*$/. ` +
      `Falling back to '${DEFAULT_LANGUAGE}'.`
    );
    cachedLanguage = DEFAULT_LANGUAGE;
    return cachedLanguage;
  }

  cachedLanguage = raw;
  return cachedLanguage;
}

/**
 * Resets the cached language. Tests only — don't use in production code.
 */
export function resetFtsLanguageCache(): void {
  cachedLanguage = null;
}
