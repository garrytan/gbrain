import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';
import {
  isMinorOrMajorBump,
  isNewerVersion,
  isValidVersionString,
  parseSemver,
  semverGt,
  semverLte,
} from '../core/semver.ts';
import { readUpdateCache, writeUpdateCache, type UpdateMarker } from '../core/self-upgrade.ts';

/** Best-effort cache write — a read-only ~/.gbrain must never make the check throw. */
function safeWriteCache(marker: UpdateMarker): void {
  try {
    writeUpdateCache(marker);
  } catch {
    /* fail-open: no cache this run, next invocation re-checks */
  }
}

// Back-compat re-exports: these used to live here; moved to ../core/semver.ts
// so the self-upgrade decision module can depend on them without an import
// cycle. Existing importers (`test/check-update.test.ts`, etc.) keep working.
export { parseSemver, isMinorOrMajorBump, isNewerVersion };

interface CheckUpdateResult {
  current_version: string;
  current_source: 'package-json';
  latest_version: string;
  update_available: boolean;
  upgrade_command: string;
  release_url: string;
  changelog_diff: string;
  published_at: string;
  error?: string;
}

function upgradeCommandForMethod(method: string): string {
  switch (method) {
    case 'bun': return 'bun update gbrain';
    case 'clawhub': return 'clawhub update gbrain';
    case 'binary': return 'gbrain self-upgrade';
    default: return 'gbrain upgrade';
  }
}

/** Where the latest version is resolved from. The release train's source of
 * truth is the `VERSION` file on master — same trusted host `fetchChangelog`
 * already uses. GitHub releases are published from it per VERSION bump
 * (`.github/workflows/release.yml`, #3521) and carry the binary assets, but
 * this check deliberately does NOT read `releases/latest`: it was a permanent
 * 404 before releases existed (#3520) and can still lag master. An npm
 * fallback was rejected: the `gbrain` package on npm is an unrelated GPU
 * library (#505), so it would produce false upgrade prompts pointing at a
 * stranger's package. */
const VERSION_SOURCE_URL = 'https://raw.githubusercontent.com/garrytan/gbrain/master/VERSION';
const RELEASE_NOTES_URL = 'https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md';

/** Extract a version from the raw VERSION file body: first line, optional `v`
 * prefix, optional `-suffix` channel tag (`0.31.1.1-fixwave` compares as its
 * numeric base — fail-safe: a suffix-only bump never prompts). Body is bounded
 * before parsing so a malformed/huge response can't blow up the check. */
export function parseVersionFileBody(body: string): string | null {
  const firstLine = body.slice(0, 256).trim().split('\n')[0].trim();
  const m = firstLine.match(/^v?(\d+\.\d+\.\d+(?:\.\d+)?)(?:[-+][0-9A-Za-z.-]+)?$/);
  return m && isValidVersionString(m[1]) ? m[1] : null;
}

export type LatestReleaseResult =
  | { ok: true; tag: string; published_at: string; url: string }
  | { ok: false; reason: 'network_error' | 'no_releases' };

/**
 * Resolve the latest published gbrain version (from VERSION on master — see
 * VERSION_SOURCE_URL). Exported (v0.42) so the self-upgrade refresh path and
 * tests can reuse it. 5s timeout — this runs on the detached refresh, never the
 * hot path. Failures are discriminated: `network_error` (offline/timeout) vs
 * `no_releases` (endpoint answered but no usable version).
 */
export async function fetchLatestRelease(): Promise<LatestReleaseResult> {
  let res: Response;
  try {
    res = await fetch(VERSION_SOURCE_URL, {
      headers: { 'User-Agent': `gbrain/${VERSION}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }
  try {
    if (!res.ok) return { ok: false, reason: 'no_releases' };
    const tag = parseVersionFileBody(await res.text());
    if (!tag) return { ok: false, reason: 'no_releases' };
    return { ok: true, tag, published_at: '', url: RELEASE_NOTES_URL };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

export async function fetchChangelog(currentVersion: string, latestVersion: string): Promise<string> {
  try {
    const res = await fetch('https://raw.githubusercontent.com/garrytan/gbrain/master/CHANGELOG.md', {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return '';
    const text = await res.text();
    return extractChangelogBetween(text, currentVersion, latestVersion);
  } catch {
    return '';
  }
}

export function extractChangelogBetween(changelog: string, from: string, to: string): string {
  const lines = changelog.split('\n');
  const entries: string[] = [];
  let capturing = false;
  const fromParsed = parseSemver(from);
  if (!fromParsed) return '';

  for (const line of lines) {
    const versionMatch = line.match(/^## \[(\d+\.\d+\.\d+(?:\.\d+)?)\]/);
    if (versionMatch) {
      const verParsed = parseSemver(versionMatch[1]);
      if (!verParsed) {
        if (capturing) entries.push(line);
        continue;
      }
      if (!capturing) {
        // Start capturing at any version newer than current
        if (semverGt(verParsed, fromParsed)) {
          capturing = true;
          entries.push(line);
        }
      } else {
        // Stop capturing when we hit the current version or older
        if (semverLte(verParsed, fromParsed)) {
          break;
        }
        entries.push(line);
      }
    } else if (capturing) {
      entries.push(line);
    }
  }

  return entries.join('\n').trim();
}

/**
 * A failed check must NEVER write `up_to_date` — that was #486: the fetch
 * failed permanently (dead releases API) and every user was told "you're
 * current" forever. Instead, re-write the last-known-good marker (bumping its
 * mtime so the cache TTL still throttles retries and a network blip can't
 * erase a pending upgrade_available notice). No prior marker → write nothing;
 * the next invocation retries.
 */
function preserveCacheOnFailedCheck(): void {
  try {
    const prior = readUpdateCache();
    if (prior) safeWriteCache(prior.marker);
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch the latest version and write the self-upgrade cache (the marker line
 * read by the CLI startup hook). On fetch failure the last-known-good marker is
 * preserved (see preserveCacheOnFailedCheck) — never a fabricated `up_to_date`.
 * This is the function the detached single-flight refresh (`gbrain
 * check-update --refresh-cache`) invokes.
 */
export async function refreshUpdateCache(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release.ok) {
    preserveCacheOnFailedCheck();
    return;
  }
  const latestVersion = release.tag.replace(/^v/, '');
  if (!isValidVersionString(latestVersion) || !isNewerVersion(VERSION, latestVersion)) {
    safeWriteCache({ kind: 'up_to_date', current: VERSION });
    return;
  }
  safeWriteCache({ kind: 'upgrade_available', current: VERSION, latest: latestVersion });
}

export async function runCheckUpdate(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain check-update [--json] [--refresh-cache]\n\nCheck for new GBrain versions.\n\nReports any strictly newer release, including patch and micro updates.\nFails silently on network errors.\n\n--refresh-cache  Fetch + update the self-upgrade cache, print nothing (used by\n                 the CLI startup hook\'s detached refresh).');
    return;
  }

  // Detached refresh path: warm the cache for the next invocation, emit nothing.
  // Single-flight via the refresh lock so many simultaneous stale-cache
  // invocations don't stampede GitHub. If another refresh holds the lock, exit.
  if (args.includes('--refresh-cache')) {
    const { tryAcquireRefreshLock, releaseRefreshLock } = await import('../core/self-upgrade.ts');
    const lock = tryAcquireRefreshLock();
    if (!lock) return; // another refresh is in flight
    try {
      await refreshUpdateCache();
    } finally {
      releaseRefreshLock(lock);
    }
    return;
  }

  const json = args.includes('--json');
  const method = detectInstallMethod();
  const upgradeCmd = upgradeCommandForMethod(method);

  const release = await fetchLatestRelease();

  if (!release.ok) {
    preserveCacheOnFailedCheck();
    if (json) {
      console.log(JSON.stringify({
        current_version: VERSION,
        current_source: 'package-json',
        latest_version: '',
        update_available: false,
        upgrade_command: upgradeCmd,
        release_url: '',
        changelog_diff: '',
        published_at: '',
        error: release.reason,
      }, null, 2));
    } else if (release.reason === 'network_error') {
      console.log(`GBrain ${VERSION} — could not check for updates (network unavailable).`);
    } else {
      console.log(`GBrain ${VERSION} — could not determine the latest published version.`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  const updateAvailable = isValidVersionString(latestVersion) && isNewerVersion(VERSION, latestVersion);

  // Warm the self-upgrade cache so the next `gbrain <cmd>` startup hook can emit
  // the marker without a network call.
  safeWriteCache(
    updateAvailable
      ? { kind: 'upgrade_available', current: VERSION, latest: latestVersion }
      : { kind: 'up_to_date', current: VERSION },
  );

  let changelogDiff = '';
  if (updateAvailable) {
    changelogDiff = await fetchChangelog(VERSION, latestVersion);
  }

  const result: CheckUpdateResult = {
    current_version: VERSION,
    current_source: 'package-json',
    latest_version: latestVersion,
    update_available: updateAvailable,
    upgrade_command: upgradeCmd,
    release_url: release.url,
    changelog_diff: changelogDiff,
    published_at: release.published_at,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (updateAvailable) {
    console.log(`GBrain update available: ${VERSION} → ${latestVersion}`);
    console.log(`Run: ${upgradeCmd}`);
    console.log(`Release: ${release.url}`);
  } else {
    console.log(`GBrain ${VERSION} is up to date.`);
  }
}
