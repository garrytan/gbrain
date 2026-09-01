/**
 * Pure TTL parsing — a dependency-free leaf (E1, ambient-writeback wave).
 *
 * The `remember` verb's ttl grammar lived inside src/core/ops/facts.ts, whose
 * import graph reaches ai/gateway.ts. The engine-free hook child (Stop-hook
 * writeback lane) and the writeback config resolver need the SAME grammar
 * without dragging that stack in, so the grammar lives here and
 * ops/facts.ts's `parseTtlParam` wraps it (wire contract unchanged — the
 * verbError messages are produced at the wrapper from the typed codes below).
 *
 * Grammar (frozen in docs/protocol/MEMORY_VERBS_v1.md):
 *   - relative duration shorthand: '30d', '12h', '45m', '90s' (also
 *     spelled-out: '30 days', '12 hours') → now + duration
 *   - absolute ISO 8601 date or datetime
 *   - ISO-8601 DURATION syntax ('P30D') is a documented trap → typed rejection
 */

export type TtlParseResult =
  | { ok: true; validUntil: Date | null }
  | { ok: false; code: 'not_string' | 'iso_duration' | 'unparseable'; input: string };

const DURATION_RE = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i;

/** Duration shorthand → milliseconds; null when the string is not shorthand. */
export function parseDurationShorthandMs(raw: string): number | null {
  const dur = raw.trim().match(DURATION_RE);
  if (!dur) return null;
  const n = parseInt(dur[1], 10);
  const unit = dur[2].toLowerCase();
  return unit.startsWith('s') ? n * 1000 :
    unit.startsWith('m') ? n * 60 * 1000 :
    unit.startsWith('h') ? n * 60 * 60 * 1000 :
    n * 24 * 60 * 60 * 1000;
}

/**
 * Parse a ttl value into an absolute `valid_until` Date. Non-throwing: every
 * failure is a typed code the caller renders (the verb wrapper keeps its
 * existing verbError copy byte-for-byte; config callers fall back silently).
 * `{ ok: true, validUntil: null }` = never expires (null/undefined/empty).
 */
export function parseTtlShorthand(raw: unknown): TtlParseResult {
  if (raw == null) return { ok: true, validUntil: null };
  if (typeof raw !== 'string') return { ok: false, code: 'not_string', input: String(raw) };
  const s = raw.trim();
  if (!s) return { ok: true, validUntil: null };

  // ISO-8601 DURATION syntax is a documented trap — typed rejection with the
  // original two-stage probe (cheap prefix test, then the full shape).
  if (/^P(T|\d)/i.test(s) && /^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/i.test(s)) {
    return { ok: false, code: 'iso_duration', input: s };
  }

  const ms = parseDurationShorthandMs(s);
  if (ms !== null) return { ok: true, validUntil: new Date(Date.now() + ms) };

  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return { ok: true, validUntil: new Date(iso) };

  return { ok: false, code: 'unparseable', input: s };
}

/** Bounds for the TRANSIENT-ttl config value (OV2-16): a standing config must
 * be a positive duration shorthand no longer than a year — an absolute
 * timestamp would rot, zero would expire instantly, and a multi-year
 * "transient" is a misconfiguration. */
export const TRANSIENT_TTL_MAX_MS = 365 * 24 * 60 * 60 * 1000;

/** The one home for the transient-TTL bounds predicate (config-set rejection
 * and the resolver's degrade path must agree byte-for-byte). */
export function isValidTransientTtl(s: string): boolean {
  const ms = parseDurationShorthandMs(s);
  return ms !== null && ms > 0 && ms <= TRANSIENT_TTL_MAX_MS;
}

/**
 * Validate `memory.auto_writeback_transient_ttl` config input. Never throws.
 * Invalid/out-of-range → `{ valid: false, ttl: fallback }` so resolvers can
 * degrade to the default while diagnostics surface `ttl_valid: false`.
 */
export function validateTtlConfig(raw: unknown, fallback: string): { valid: boolean; ttl: string } {
  if (raw == null) return { valid: true, ttl: fallback };
  if (typeof raw !== 'string' || !raw.trim()) return { valid: false, ttl: fallback };
  const s = raw.trim();
  if (!isValidTransientTtl(s)) return { valid: false, ttl: fallback };
  return { valid: true, ttl: s };
}
