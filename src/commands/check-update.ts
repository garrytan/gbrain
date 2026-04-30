import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';
import { execSync } from 'child_process';
import { realpathSync, existsSync } from 'fs';
import { dirname, join } from 'path';

interface CheckUpdateResult {
  current_version: string;
  current_source: 'package-json' | 'source';
  latest_version: string;
  update_available: boolean;
  upgrade_command: string;
  release_url: string;
  changelog_diff: string;
  published_at: string;
  error?: string;
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
    case 'source': return 'git pull origin master';
    default: return 'gbrain upgrade';
  }
}

function checkSourceUpdate(): { ahead: number; commits: string[] } | null {
  try {
    const arg1 = process.argv[1] ?? '';
    let dir = dirname(realpathSync(arg1));
    let gitDir = '';
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, '.git'))) { gitDir = dir; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!gitDir) return null;
    execSync('git fetch origin', { cwd: gitDir, stdio: 'pipe', timeout: 15_000 });
    const log = execSync('git log HEAD..origin/master --oneline', {
      cwd: gitDir, encoding: 'utf-8', timeout: 5_000,
    }).trim();
    if (!log) return { ahead: 0, commits: [] };
    const commits = log.split('\n').filter(l => l.trim());
    return { ahead: commits.length, commits };
  } catch {
    return null;
  }
}

async function fetchLatestRelease(): Promise<{ tag: string; published_at: string; url: string } | null> {
  try {
    const res = await fetch('https://api.github.com/repos/garrytan/gbrain/releases/latest', {
      headers: { 'User-Agent': `gbrain/${VERSION}` },
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

  if (method === 'source') {
    const sourceResult = checkSourceUpdate();
    if (sourceResult && sourceResult.ahead > 0) {
      if (json) {
        console.log(JSON.stringify({
          current_version: VERSION,
          current_source: 'source',
          latest_version: `${sourceResult.ahead} commit(s) behind origin/master`,
          update_available: true,
          upgrade_command: upgradeCmd,
          release_url: 'https://github.com/garrytan/gbrain',
          changelog_diff: sourceResult.commits.join('\n'),
          published_at: '',
        }, null, 2));
      } else {
        console.log(`GBrain ${VERSION} (source install) — ${sourceResult.ahead} commit(s) behind origin/master`);
        for (const c of sourceResult.commits.slice(0, 5)) console.log(`  ${c}`);
        if (sourceResult.commits.length > 5) console.log(`  ... and ${sourceResult.commits.length - 5} more`);
        console.log(`Run: ${upgradeCmd}`);
      }
      return;
    }
    if (sourceResult) {
      if (json) {
        console.log(JSON.stringify({
          current_version: VERSION,
          current_source: 'source',
          latest_version: VERSION,
          update_available: false,
          upgrade_command: upgradeCmd,
          release_url: '',
          changelog_diff: '',
          published_at: '',
        }, null, 2));
      } else {
        console.log(`GBrain ${VERSION} (source install) is up to date with origin/master.`);
      }
      return;
    }
  }

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
      console.log(`GBrain ${VERSION} — could not check for updates (no releases found or network unavailable).`);
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
