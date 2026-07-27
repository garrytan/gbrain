/**
 * Tiny semver comparison helpers, extracted from `check-update.ts` so both
 * the update-check path and the new self-upgrade decision module
 * (`src/core/self-upgrade.ts`) can depend on them without an import cycle
 * (self-upgrade ← check-update would cycle once check-update imports the
 * cache helpers back from self-upgrade). `check-update.ts` re-exports the
 * public helpers for back-compat with existing importers.
 *
 * Supports both 3-segment (`0.41.38`) and 4-segment (`0.42.3.0`) gbrain
 * version strings. The 4th `.MICRO` segment is gbrain's dot-suffix
 * follow-up channel; comparisons use it as a 4th ordering key.
 */

/** A parsed gbrain version tuple (major, minor, patch, micro). Historical
 * 3-segment versions are normalized with a zero micro segment. */
export type SemverTuple = [number, number, number, number];

/** Strict shape gate for a remote version string before it reaches the agent.
 * Accepts both 3-segment (`0.41.38`) and 4-segment (`0.42.3.0`) gbrain versions. */
export const VERSION_RE = /^\d+\.\d+(?:\.\d+){0,2}$/;

/** True iff `v` (optionally `v`-prefixed) is a plain numeric dotted version. */
export function isValidVersionString(v: string): boolean {
  return VERSION_RE.test(v.replace(/^v/, ''));
}

/**
 * Parse a version string into a (major, minor, patch, micro) tuple. Returns
 * null on any malformed input. Accepts a leading `v`; historical 3-segment
 * versions are padded with a zero micro segment.
 */
export function parseSemver(v: string): SemverTuple | null {
  const clean = v.replace(/^v/, '');
  if (!VERSION_RE.test(clean)) return null;
  const parts = clean.split('.');
  if (parts.length < 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2], nums[3] ?? 0];
}

/** Strict greater-than over the tuple. */
export function semverGt(a: SemverTuple, b: SemverTuple): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** a <= b. */
export function semverLte(a: SemverTuple, b: SemverTuple): boolean {
  return !semverGt(a, b);
}

/** True when `latest` is any strictly newer gbrain release than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const lat = parseSemver(latest);
  return !!cur && !!lat && semverGt(lat, cur);
}

/**
 * True when `latest` is a minor or major bump over `current` (patch / micro
 * bumps are deliberately ignored). Kept for callers that intentionally want
 * coarse release-channel drift rather than a general update check.
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
