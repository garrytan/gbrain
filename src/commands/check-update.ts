import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';

const DEFAULT_RELEASE_REPO = 'Versatly/Cortex';

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

function releaseRepo(): string {
  return process.env.CORTEX_RELEASE_REPO || DEFAULT_RELEASE_REPO;
}

function releaseBaseUrl(): string {
  return `https://github.com/${releaseRepo()}`;
}

function rawChangelogUrl(): string {
  return `https://raw.githubusercontent.com/${releaseRepo()}/main/CHANGELOG.md`;
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
    case 'bun': return 'bun update cortex-brain';
    case 'clawhub': return 'clawhub update cortex-brain';
    case 'binary': return `Download from ${releaseBaseUrl()}/releases`;
    default: return 'cortex upgrade';
  }
}

async function fetchLatestRelease(): Promise<{ tag: string; published_at: string; url: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${releaseRepo()}/releases/latest`, {
      headers: { 'User-Agent': `cortex/${VERSION}` },
      signal: AbortSignal.timeout(10_000),
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

async function fetchChangelog(currentVersion: string, latestVersion: string): Promise<string> {
  try {
    const res = await fetch(rawChangelogUrl(), {
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
        if (semverGt(verParsed, fromParsed)) {
          capturing = true;
          entries.push(line);
        }
      } else {
        if (semverLte(verParsed, fromParsed)) break;
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
    console.log(
      'Usage: cortex check-update [--json]\n\n' +
      'Check for new Cortex versions.\n\n' +
      'Only reports minor/major version bumps (v0.X.0), not patches.\n' +
      'Set CORTEX_RELEASE_REPO=owner/repo to override the release source.\n' +
      'Fails silently on network errors.',
    );
    return;
  }

  const json = args.includes('--json');
  const method = detectInstallMethod();
  const upgradeCmd = upgradeCommandForMethod(method);
  const release = await fetchLatestRelease();

  if (!release) {
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
      console.log(`Cortex ${VERSION} - could not check for updates (no releases found or network unavailable).`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  const updateAvailable = isMinorOrMajorBump(VERSION, latestVersion);
  const changelogDiff = updateAvailable ? await fetchChangelog(VERSION, latestVersion) : '';

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
    console.log(`Cortex update available: ${VERSION} -> ${latestVersion}`);
    console.log(`Run: ${upgradeCmd}`);
    console.log(`Release: ${release.url}`);
  } else {
    console.log(`Cortex ${VERSION} is up to date.`);
  }
}
