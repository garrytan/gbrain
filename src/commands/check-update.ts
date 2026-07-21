import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';
import {
  isMinorOrMajorBump,
  isValidVersionString,
  parseSemver,
  semverGt,
  semverLte,
} from '../core/semver.ts';
import { writeUpdateCache, type UpdateMarker } from '../core/self-upgrade.ts';

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
export { parseSemver, isMinorOrMajorBump };

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

/**
 * Fetch the latest GitHub release. Exported (v0.42) so the self-upgrade refresh
 * path and tests can reuse it. 5s timeout (was 10s) — this runs on the detached
 * refresh, never the hot path, but a tight bound keeps the refresh cheap.
 */
export async function fetchLatestRelease(): Promise<{ tag: string; published_at: string; url: string } | null> {
  try {
    const res = await fetch('https://api.github.com/repos/garrytan/gbrain/releases/latest', {
      headers: { 'User-Agent': `gbrain/${VERSION}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      tag: data.tag_name || '',
      published_at: data.published_at || '',
      url: data.html_url || '',
    };
  } catch {
    return null;
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
 * Fetch the latest release and write the self-upgrade cache (the marker line
 * read by the CLI startup hook). Fail-open: on any network failure we cache
 * `UP_TO_DATE <current>` so the TTL prevents hammering GitHub on every
 * invocation. Returns the resolved marker for callers that want it. This is the
 * function the detached single-flight refresh (`gbrain check-update
 * --refresh-cache`) invokes.
 */
export async function refreshUpdateCache(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release) {
    safeWriteCache({ kind: 'up_to_date', current: VERSION });
    return;
  }
  const latestVersion = release.tag.replace(/^v/, '');
  if (!isValidVersionString(latestVersion) || !isMinorOrMajorBump(VERSION, latestVersion)) {
    safeWriteCache({ kind: 'up_to_date', current: VERSION });
    return;
  }
  safeWriteCache({ kind: 'upgrade_available', current: VERSION, latest: latestVersion });
}

export async function runCheckUpdate(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain check-update [--json] [--refresh-cache]\n\nCheck for new GBrain versions.\n\nOnly reports minor/major version bumps (v0.X.0), not patches.\nFails silently on network errors.\n\n--refresh-cache  Fetch + update the self-upgrade cache, print nothing (used by\n                 the CLI startup hook\'s detached refresh).');
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

  if (!release) {
    // Warm the cache fail-open so the startup hook doesn't re-fetch every call.
    safeWriteCache({ kind: 'up_to_date', current: VERSION });
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
        error: 'no_releases',
      }, null, 2));
    } else {
      console.log(`GBrain ${VERSION} — could not check for updates (no releases found or network unavailable).`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  const updateAvailable = isValidVersionString(latestVersion) && isMinorOrMajorBump(VERSION, latestVersion);

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
