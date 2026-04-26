import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';

type CheckUpdateError =
  | 'no_releases'         // GitHub returned 404 — repo has no releases yet (permanent until publish)
  | 'network_unavailable' // fetch threw (DNS, timeout, offline) — transient
  | 'rate_limited'        // HTTP 429 — transient, backs off naturally on next cron
  | 'http_error';         // HTTP 5xx / other non-2xx — transient

interface CheckUpdateResult {
  current_version: string;
  current_source: 'package-json';
  latest_version: string;
  update_available: boolean;
  upgrade_command: string;
  release_url: string;
  changelog_diff: string;
  published_at: string;
  error?: CheckUpdateError;
  /**
   * True when `error` is a transient failure that will likely succeed on the
   * next run (network, rate-limit, 5xx). Callers (cron jobs, agents) MUST NOT
   * surface a warning when this is true — let the next cycle retry silently.
   * Only `no_releases` is non-transient.
   */
  error_transient?: boolean;
}

type FetchReleaseResult =
  | { ok: true; tag: string; published_at: string; url: string }
  | { ok: false; error: CheckUpdateError; transient: boolean };

export function classifyHttpStatus(status: number): { error: CheckUpdateError; transient: boolean } {
  if (status === 404) return { error: 'no_releases', transient: false };
  if (status === 429) return { error: 'rate_limited', transient: true };
  return { error: 'http_error', transient: true };
}

export function parseSemver(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/, '');
  const parts = clean.split('.');
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map(Number);
  if (nums.some(isNaN)) return null;
  return nums as [number, number, number];
}

export function isMinorOrMajorBump(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const lat = parseSemver(latest);
  if (!cur || !lat) return false;
  if (lat[0] > cur[0]) return true;
  if (lat[0] === cur[0] && lat[1] > cur[1]) return true;
  return false;
}

function upgradeCommandForMethod(method: string): string {
  switch (method) {
    case 'bun': return 'bun update gbrain';
    case 'clawhub': return 'clawhub update gbrain';
    case 'binary': return 'Download from https://github.com/garrytan/gbrain/releases';
    default: return 'gbrain upgrade';
  }
}

async function fetchLatestRelease(): Promise<FetchReleaseResult> {
  let res: Response;
  try {
    res = await fetch('https://api.github.com/repos/garrytan/gbrain/releases/latest', {
      headers: { 'User-Agent': `gbrain/${VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: 'network_unavailable', transient: true };
  }
  if (!res.ok) {
    return { ok: false, ...classifyHttpStatus(res.status) };
  }
  const data = await res.json() as any;
  return {
    ok: true,
    tag: data.tag_name || '',
    published_at: data.published_at || '',
    url: data.html_url || '',
  };
}

async function fetchChangelog(currentVersion: string, latestVersion: string): Promise<string> {
  try {
    const res = await fetch('https://raw.githubusercontent.com/garrytan/gbrain/master/CHANGELOG.md', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    const text = await res.text();
    return extractChangelogBetween(text, currentVersion, latestVersion);
  } catch {
    return '';
  }
}

function semverGt(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

function semverLte(a: [number, number, number], b: [number, number, number]): boolean {
  return !semverGt(a, b);
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

export async function runCheckUpdate(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain check-update [--json]\n\nCheck for new GBrain versions.\n\nOnly reports minor/major version bumps (v0.X.0), not patches.\nFails silently on network errors.');
    return;
  }

  const json = args.includes('--json');
  const method = detectInstallMethod();
  const upgradeCmd = upgradeCommandForMethod(method);

  const release = await fetchLatestRelease();

  if (!release.ok) {
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
        error: release.error,
        error_transient: release.transient,
      }, null, 2));
    } else {
      const reason = release.error === 'no_releases'
        ? 'no releases published yet'
        : release.error === 'rate_limited'
          ? 'GitHub API rate limit, will retry next cycle'
          : release.error === 'network_unavailable'
            ? 'network unavailable, will retry next cycle'
            : 'GitHub API unreachable, will retry next cycle';
      console.log(`GBrain ${VERSION} — could not check for updates (${reason}).`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  const updateAvailable = isMinorOrMajorBump(VERSION, latestVersion);

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
