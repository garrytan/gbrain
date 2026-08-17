/**
 * Numeric env-var resolution with a shared warn-once memo.
 *
 * Relocated from `src/commands/doctor.ts` (where `_resolveEnvNumber` was already
 * exported but `_resolveSyncFreshnessHours` was module-private). `src/core/source-health.ts`
 * needs the hours resolver for the staleness ceiling, and doctor.ts already imports
 * FROM `source-health.ts` — so having core reach back into commands would close an import
 * cycle. Duplicating the helper instead would create a SECOND `_envNumberWarned` set, so
 * the same bad env var would warn once per module and the "warn exactly once" contract
 * would quietly become "warn twice".
 *
 * One module, one memo, imported by both planes.
 *
 * The warning prefix is `[gbrain]` rather than `[gbrain doctor]` because these vars are
 * now read outside doctor. No test asserted the old prefix (verified before the move).
 */

/** Warn-once memo, keyed by env var name. Module-level so every caller shares it. */
const _envNumberWarned = new Set<string>();

/**
 * Read a POSITIVE number from an env var; warn once and fall back on garbage.
 *
 * `opts.unit` is cosmetic, used only in the warning string ('h', '%', '').
 * Zero and negative values are treated as garbage: every consumer of this helper wants
 * a positive threshold, and `0` is far more often an unset-variable accident than an
 * intentional "disable".
 */
export function resolveEnvNumber(
  varName: string,
  fallback: number,
  opts?: { unit?: string },
): number {
  const raw = process.env[varName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (!_envNumberWarned.has(varName)) {
      _envNumberWarned.add(varName);
      console.warn(
        `[gbrain] Ignoring invalid ${varName}=${raw}; using default ${fallback}${opts?.unit ?? ''}.`,
      );
    }
    return fallback;
  }
  return n;
}

/** `resolveEnvNumber` with the hours unit pre-applied. */
export function resolveHoursEnv(varName: string, fallback: number): number {
  return resolveEnvNumber(varName, fallback, { unit: 'h' });
}

/**
 * Warn once for `varName` using the SAME memo as `resolveEnvNumber`.
 *
 * For env vars that are disabled-unless-set, where `resolveEnvNumber`'s
 * "fall back to a default" shape does not apply (e.g.
 * `GBRAIN_EXTRACTION_LAG_FAIL_PCT`, whose absence means "no hard fail"), but
 * whose invalid-value warning must still fire exactly once per process.
 * Exposed instead of the raw Set so the memo stays encapsulated.
 */
export function warnOnceForEnv(varName: string, message: string): void {
  if (_envNumberWarned.has(varName)) return;
  _envNumberWarned.add(varName);
  console.warn(message);
}

/**
 * Test seam: clear the warn-once memo so a suite can assert the warning fires.
 * Production code must never call this.
 */
export function _resetEnvNumberWarnedForTests(): void {
  _envNumberWarned.clear();
}
