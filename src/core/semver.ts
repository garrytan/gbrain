/**
 * Tiny semver comparison helpers, extracted from `check-update.ts` so both
 * the update-check path and the new self-upgrade decision module
 * (`src/core/self-upgrade.ts`) can depend on them without an import cycle
 * (self-upgrade ← check-update would cycle once check-update imports the
 * cache helpers back from self-upgrade). `check-update.ts` re-exports
 * `parseSemver` / `isMinorOrMajorBump` for back-compat with existing importers.
 *
 * Supports both 3-segment (`0.41.38`) and 4-segment (`0.42.3.0`) gbrain
 * version strings. The 4th `.MICRO` segment is gbrain's dot-suffix
 * follow-up channel; comparisons use it as a 4th ordering key.
 */

/** A parsed version tuple (major, minor, patch). The 4th `.MICRO` segment is
 * deliberately NOT compared — micro bumps collapse to "equal" with the patch,
 * which is the desired "ignored" behavior for the self-upgrade decision (we
 * only ever act on minor/major bumps). Kept 3-wide for back-compat with
 * existing `parseSemver` callers/tests. */
export type SemverTuple = [number, number, number];

/** Strict shape gate for a remote version string before it reaches the agent.
 * Accepts both 3-segment (`0.41.38`) and 4-segment (`0.42.3.0`) gbrain versions. */
export const VERSION_RE = /^\d+\.\d+(?:\.\d+){0,2}$/;

/** True iff `v` (optionally `v`-prefixed) is a plain numeric dotted version. */
export function isValidVersionString(v: string): boolean {
  return VERSION_RE.test(v.replace(/^v/, ''));
}

/**
 * Parse a version string into a (major, minor, patch) tuple. Returns null on
 * any non-numeric or too-short input. Accepts a leading `v`. A 4th `.MICRO`
 * segment is accepted by the shape gate but truncated here.
 */
export function parseSemver(v: string): SemverTuple | null {
  const clean = v.replace(/^v/, '');
  const parts = clean.split('.');
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

/** Strict greater-than over the tuple. */
export function semverGt(a: SemverTuple, b: SemverTuple): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** a <= b. */
export function semverLte(a: SemverTuple, b: SemverTuple): boolean {
  return !semverGt(a, b);
}

/**
 * True when `latest` is a minor or major bump over `current` (patch / micro
 * bumps are deliberately ignored, matching `gbrain check-update`'s
 * established posture — patch noise should not nag every invocation).
 * Unparseable inputs are treated as "not a bump" (fail-open to up-to-date).
 */
export function isMinorOrMajorBump(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const lat = parseSemver(latest);
  if (!cur || !lat) return false;
  if (lat[0] > cur[0]) return true;
  if (lat[0] === cur[0] && lat[1] > cur[1]) return true;
  return false;
}
