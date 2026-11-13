/**
 * Upgrade matrix (GBRA-224 W2): which published releases a run upgrades from.
 *
 * Resolved once per run from published release tags and recorded in the run
 * receipt: N-1, N-10 and N-50 (the 1st, 10th and 50th newest release older
 * than the candidate), the release published closest to 30 days before the
 * candidate, and the current stable tag when one exists and is older. The
 * pull-request profile keeps N-1 and N-50. A role that cannot be filled (too
 * few older releases, stable missing or not older) is recorded as skipped
 * with the reason, never silently dropped.
 */
import { isNewerVersion, isValidVersionString } from '../../src/core/semver.ts';

export type FromRole = 'N-1' | 'N-10' | 'N-50' | '30d' | 'stable';
export type Profile = 'full' | 'pr';
export const PROFILE_ROLES: Record<Profile, FromRole[]> = { full: ['N-1', 'N-10', 'N-50', '30d', 'stable'], pr: ['N-1', 'N-50'] };

export interface Release { tag: string; version: string; published_at: string }
export interface Candidate { tag: string | null; sha: string; tree: string; version: string; published_at: string }
export interface FromVersion { tag: string; version: string; published_at: string; roles: FromRole[] }
export interface SkippedRole { role: FromRole; reason: string }

const DAY_MS = 86_400_000;
export const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:\.\d+)?)$/;

/** Releases older than the candidate (semver), newest first. */
export function olderReleases(releases: readonly Release[], candidateVersion: string): Release[] {
  return releases
    .filter(r => isValidVersionString(r.version) && isNewerVersion(r.version, candidateVersion))
    .sort((a, b) => (isNewerVersion(a.version, b.version) ? 1 : isNewerVersion(b.version, a.version) ? -1 : 0));
}

export function resolveFromVersions(
  releases: readonly Release[],
  candidate: Pick<Candidate, 'version' | 'published_at'>,
  opts: { profile: Profile; stableVersion?: string | null },
): { from: FromVersion[]; skipped: SkippedRole[] } {
  const older = olderReleases(releases, candidate.version);
  const picked = new Map<string, FromVersion>();
  const skipped: SkippedRole[] = [];
  const take = (role: FromRole, r: Release | undefined, reason: string) => {
    if (!r) { skipped.push({ role, reason }); return; }
    const prior = picked.get(r.tag);
    if (prior) prior.roles.push(role);
    else picked.set(r.tag, { tag: r.tag, version: r.version, published_at: r.published_at, roles: [role] });
  };
  for (const role of PROFILE_ROLES[opts.profile]) {
    if (role === 'N-1' || role === 'N-10' || role === 'N-50') {
      const k = Number(role.slice(2));
      take(role, older[k - 1], 'only ' + older.length + ' published releases are older than the candidate');
    } else if (role === '30d') {
      const target = Date.parse(candidate.published_at) - 30 * DAY_MS;
      let best: Release | undefined;
      for (const r of older) {
        const d = Math.abs(Date.parse(r.published_at) - target);
        if (!best || d < Math.abs(Date.parse(best.published_at) - target)) best = r;
      }
      take(role, best, 'no published release is older than the candidate');
    } else {
      const stable = opts.stableVersion ?? null;
      if (!stable) { skipped.push({ role, reason: 'no stable tag exists' }); continue; }
      if (!isNewerVersion(stable, candidate.version)) { skipped.push({ role, reason: 'stable (' + stable + ') is not older than the candidate' }); continue; }
      take(role, older.find(r => r.version === stable), 'stable (' + stable + ') has no published release');
    }
  }
  return { from: [...picked.values()], skipped };
}

function token(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

/** Published (non-draft, non-prerelease) release tags, newest first, reading pages until 'enough' holds. */
export async function fetchReleases(repo: string, enough: (releases: Release[]) => boolean, fetchImpl: typeof fetch = fetch): Promise<Release[]> {
  const out: Release[] = [];
  const auth = token();
  for (let page = 1; page <= 30; page++) {
    const res = await fetchImpl('https://api.github.com/repos/' + repo + '/releases?per_page=100&page=' + page, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'gbrain-upgrade-matrix', ...(auth ? { authorization: 'Bearer ' + auth } : {}) },
    });
    if (!res.ok) throw new Error('GET releases page ' + page + ' returned HTTP ' + res.status + (auth ? '' : ' (unauthenticated: set GITHUB_TOKEN)'));
    const rows = await res.json() as Array<{ tag_name: string; published_at: string | null; draft: boolean; prerelease: boolean }>;
    for (const r of rows) {
      const m = RELEASE_TAG.exec(r.tag_name);
      if (m && !r.draft && !r.prerelease && r.published_at) out.push({ tag: r.tag_name, version: m[1]!, published_at: r.published_at });
    }
    if (rows.length < 100 || enough(out)) break;
  }
  return out;
}

/** Enough history for every role: 50 older releases and one published 31 days before the candidate. */
export function hasEnoughHistory(releases: readonly Release[], candidate: Pick<Candidate, 'version' | 'published_at'>): boolean {
  const older = olderReleases(releases, candidate.version);
  const horizon = Date.parse(candidate.published_at) - 31 * DAY_MS;
  return older.length >= 50 && older.some(r => Date.parse(r.published_at) < horizon);
}
