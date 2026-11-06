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
import {
  DEFAULT_RELEASE_CHANNEL,
  currentReleaseChannel,
  invalidChannelMessage,
  offeredVersion,
  readUpdateCache,
  resolveReleaseChannel,
  writeUpdateCache,
  type CacheWriteOptions,
  type ReleaseChannel,
  type UpdateMarker,
} from '../core/self-upgrade.ts';
import { loadConfig } from '../core/config.ts';
import { fetchStableRecord, stableFailureFix, stableFailureMessage, type StableCode } from '../core/stable-channel.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

/** Best-effort cache write — a read-only ~/.gbrain must never make the check throw. */
function safeWriteCache(marker: UpdateMarker | null, opts: CacheWriteOptions): void {
  try {
    writeUpdateCache(marker, opts);
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

/** Where the alpha channel's version is resolved from: the VERSION file at the
 * `latest-stable` tag, which release.yml moves on every published release. This
 * is the alpha channel's own ref, not the install ref (core/install-ref.ts). release.yml moves
 * it only after the release checks pass and the assets publish, so it names a
 * published release, the one `bun update` installs on the canonical install.
 * Master's VERSION is NOT a release: the next PR stamps it before release.yml
 * mints its tag, and a superseded version never gets one, so offering it made
 * the auto channel "upgrade" to a version the install could not reach and
 * blocklist it (#6718, #6828). Same trusted host as before. `releases/latest`
 * stays unread: it was a permanent 404 before releases existed (#3520). An npm
 * fallback was rejected: the `gbrain` package on npm is an unrelated GPU
 * library (#505), so it would produce false upgrade prompts pointing at a
 * stranger's package. The stable channel (the default, GBRA-224) never reads a
 * bare VERSION file: it reads the evidence record (core/stable-channel.ts). */
const RELEASE_REF_RAW = 'https://raw.githubusercontent.com/garrytan/gbrain/latest-stable';
const ALPHA_VERSION_URL = `${RELEASE_REF_RAW}/VERSION`;
const RELEASE_NOTES_URL = 'https://github.com/garrytan/gbrain/blob/latest-stable/CHANGELOG.md';

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
  | { ok: true; tag: string; published_at: string; url: string; knownBad: string[] }
  | { ok: false; reason: 'network_error' | 'no_releases' }
  | { ok: false; reason: StableCode; cause: string };

/**
 * Resolve a release channel's version: alpha from VERSION at `latest-stable`, stable from the evidence record
 * (with its known_bad list). Exported (v0.42) so the self-upgrade refresh path and tests can reuse it. 5s timeout —
 * this runs on the detached refresh, never the hot path. Failures are discriminated: `network_error`
 * (offline/timeout) vs `no_releases` (endpoint answered but no usable version) on alpha; the typed stable codes on
 * stable.
 */
export async function fetchLatestRelease(channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): Promise<LatestReleaseResult> {
  if (channel === 'stable') {
    const r = await fetchStableRecord(fetch, `gbrain/${VERSION}`);
    return r.ok
      ? { ok: true, tag: r.record.version, published_at: r.record.promoted_at, url: RELEASE_NOTES_URL, knownBad: r.record.known_bad }
      : { ok: false, reason: r.code, cause: r.cause };
  }
  let res: Response;
  try {
    res = await fetch(ALPHA_VERSION_URL, {
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
    return { ok: true, tag, published_at: '', url: RELEASE_NOTES_URL, knownBad: [] };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

export async function fetchChangelog(currentVersion: string, latestVersion: string): Promise<string> {
  try {
    const res = await fetch(`${RELEASE_REF_RAW}/CHANGELOG.md`, {
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
 * current" forever. Instead, re-write the last-known-good answer (bumping its
 * mtime so the cache TTL still throttles retries and a network blip can't
 * erase a pending upgrade_available notice). No prior answer → write nothing on
 * alpha; the next invocation retries. On stable the failure itself is recorded
 * (`error`) so doctor and --check-only report it: an unreadable record keeps the
 * last verified answer for the notice (never for an apply), a missing or invalid
 * one drops it.
 */
function recordFailedCheck(channel: ReleaseChannel, release: Extract<LatestReleaseResult, { ok: false }>, checkedAt: number): void {
  try {
    const prior = readUpdateCache(channel);
    if (!('cause' in release)) {
      if (prior?.marker) safeWriteCache(prior.marker, { channel, latest: prior.latest, knownBad: prior.knownBad, checkedAt });
      return;
    }
    const keep = release.reason === 'stable_unreadable' ? prior : null;
    safeWriteCache(keep?.marker ?? null, { channel, latest: keep?.latest ?? null, knownBad: keep?.knownBad ?? [], error: { code: release.reason, cause: release.cause }, checkedAt });
  } catch {
    /* best-effort */
  }
}

/** Write a successful check's answer for this build. */
function recordCheck(channel: ReleaseChannel, release: Extract<LatestReleaseResult, { ok: true }>, checkedAt: number): string | null {
  const latestVersion = release.tag.replace(/^v/, '');
  const offered = offeredVersion(VERSION, latestVersion, release.knownBad);
  safeWriteCache(
    offered ? { kind: 'upgrade_available', current: VERSION, latest: offered } : { kind: 'up_to_date', current: VERSION },
    { channel, latest: isValidVersionString(latestVersion) ? latestVersion : null, knownBad: release.knownBad, checkedAt },
  );
  return offered;
}

/**
 * Fetch the channel's version and write its cache partition (read by the CLI startup hook). On fetch failure the
 * last-known-good answer is preserved (see recordFailedCheck) — never a fabricated `up_to_date`, and never an alpha
 * answer on stable. This is the function the detached single-flight refresh (`gbrain check-update --refresh-cache`)
 * invokes. An invalid configured channel refreshes nothing.
 */
export async function refreshUpdateCache(channel: ReleaseChannel | null = currentReleaseChannel()): Promise<void> {
  if (!channel) return;
  const checkedAt = Date.now();
  const release = await fetchLatestRelease(channel);
  if (!release.ok) recordFailedCheck(channel, release, checkedAt);
  else recordCheck(channel, release, checkedAt);
}

export async function runCheckUpdate(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain check-update [--json] [--refresh-cache]\n\nCheck for new GBrain versions on this install\'s release channel (stable by default;\nGBRAIN_RELEASE_CHANNEL or self_upgrade.channel selects alpha, every release).\n\nReports any strictly newer release, including patch and micro updates.\nFails silently on network errors.\n\n--refresh-cache  Fetch + update the self-upgrade cache, print nothing (used by\n                 the CLI startup hook\'s detached refresh).');
    return;
  }

  // Detached refresh path: warm the cache for the next invocation, emit nothing.
  // Single-flight via the channel's refresh lock so many simultaneous stale-cache
  // invocations don't stampede GitHub. If another refresh holds the lock, exit.
  if (args.includes('--refresh-cache')) {
    const channel = currentReleaseChannel();
    if (!channel) return;
    const { tryAcquireRefreshLock, releaseRefreshLock } = await import('../core/self-upgrade.ts');
    const lock = tryAcquireRefreshLock(undefined, channel);
    if (!lock) return; // another refresh is in flight
    try {
      await refreshUpdateCache(channel);
    } finally {
      releaseRefreshLock(lock);
    }
    return;
  }

  const json = args.includes('--json');
  const resolution = resolveReleaseChannel(loadConfig());
  if (!resolution.ok) {
    setCliExitVerdict(writeCliError(opError('invalid_params', invalidChannelMessage(resolution), `Set a valid channel: gbrain config set self_upgrade.channel stable (or alpha).`), 'check-update', { json }));
    return;
  }
  const { channel } = resolution;
  const upgradeCmd = channel === 'stable' ? 'gbrain upgrade' : upgradeCommandForMethod(detectInstallMethod());
  const checkedAt = Date.now();
  const release = await fetchLatestRelease(channel);
  const channelFields = { channel, channel_source: resolution.source };

  if (!release.ok) {
    recordFailedCheck(channel, release, checkedAt);
    const stable = 'cause' in release ? { message: stableFailureMessage({ code: release.reason, cause: release.cause }), fix: stableFailureFix({ code: release.reason }, resolution) } : null;
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
        ...channelFields,
        ...(stable ?? {}),
      }, null, 2));
    } else if (stable) {
      console.log(`GBrain ${VERSION} — ${stable.message} ${stable.fix}`);
    } else if (release.reason === 'network_error') {
      console.log(`GBrain ${VERSION} — could not check for updates (network unavailable).`);
    } else {
      console.log(`GBrain ${VERSION} — could not determine the latest published version.`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  // Warm the self-upgrade cache so the next `gbrain <cmd>` startup hook can emit
  // the marker without a network call.
  const offered = recordCheck(channel, release, checkedAt);
  const updateAvailable = offered !== null;
  const withdrawn = updateAvailable && release.knownBad.includes(VERSION);

  let changelogDiff = '';
  if (updateAvailable && !withdrawn) {
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
    console.log(JSON.stringify({ ...result, ...channelFields, ...(withdrawn ? { withdrawn: true } : {}) }, null, 2));
  } else if (withdrawn) {
    console.log(`GBrain ${VERSION} was withdrawn from the stable channel; the current stable release is ${latestVersion}.`);
    console.log(`Run: ${upgradeCmd}`);
  } else if (updateAvailable) {
    console.log(`GBrain update available (${channel} channel): ${VERSION} → ${latestVersion}`);
    console.log(`Run: ${upgradeCmd}`);
    console.log(`Release: ${release.url}`);
  } else {
    console.log(`GBrain ${VERSION} is up to date on the ${channel} channel.`);
  }
}
