/**
 * The install canary as a condition of stable promotion.
 *
 * The install canary installs each release tag into every supported harness (Claude Code, Codex, OpenClaw, Hermes
 * and the rest) and runs its setup. It reports by posting a commit status on the release tag's commit, with context
 * CANARY_CONTEXT: `success` when the release is promotable, `failure` when a failure blocks stable, and `pending`
 * when the job testing that tag starts. It posts nothing for a tag it has not tested. Its description names the tag it tested, as `v<VERSION> run <run id>: pass` or
 * `v<VERSION> run <run id>: fail <harness,...>`. A re-test posts again, and the newest status wins.
 *
 * judgeCanary() trusts a status only when the account that posted it is on the allowlist (the STABLE_CANARY_POSTERS
 * repository variable, comma-separated; DEFAULT_CANARY_POSTERS when it is unset) and its description names the
 * version being promoted. A release with no trusted status is not tested yet, and so is one whose newest status is
 * pending (a job that died leaves a stale pending); the schedule never promotes a release that is not tested
 * yet. A maintainer may promote one by hand with a waiver reason (promote-stable.yml canary_waiver), which the
 * stable record keeps. The canary posts as the Capy GitHub App, so the default allowlist is its bot login.
 *
 * No dependencies beyond node: stable-daily.yml and promote-stable.yml install none.
 */

export const CANARY_CONTEXT = 'gbrain/install-canary';
export const DEFAULT_CANARY_POSTERS = ['capy-ai[bot]'] as const;

export interface CommitStatus {
  context?: string | null;
  state?: string | null;
  description?: string | null;
  target_url?: string | null;
  created_at?: string | null;
  creator?: { login?: string | null } | null;
}

export type CanaryVerdict =
  | { state: 'success'; why: string; description: string }
  | { state: 'failure' | 'untested'; why: string };

/** The allowlist from STABLE_CANARY_POSTERS (comma-separated logins); the default when it is unset or empty. */
export function parseCanaryPosters(value: string | undefined): string[] {
  const logins = (value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return logins.length ? logins : DEFAULT_CANARY_POSTERS.map(s => s.toLowerCase());
}

/**
 * The install canary's verdict on `version` from the statuses on its release commit (GitHub lists them newest
 * first): the newest status in CANARY_CONTEXT from an allowed poster whose description names `v<version>`.
 */
export function judgeCanary(statuses: readonly CommitStatus[], version: string, posters: readonly string[]): CanaryVerdict {
  const allowed = new Set(posters.map(p => p.toLowerCase()));
  const tag = `v${version}`;
  const named = (d: string) => d.startsWith(tag) && (d.length === tag.length || /^[\s:]/.test(d.slice(tag.length)));
  const ours = statuses.filter(s => s.context === CANARY_CONTEXT);
  const trusted = ours.filter(s => allowed.has((s.creator?.login ?? '').toLowerCase()) && named((s.description ?? '').trim()));
  const at = (s: CommitStatus) => Date.parse(s.created_at ?? '') || 0;
  const newest = [...trusted].sort((a, b) => at(b) - at(a))[0];
  if (!newest) {
    const ignored = ours.length ? ` (${ours.length} ${CANARY_CONTEXT} status${ours.length === 1 ? '' : 'es'} ignored: not posted by ${[...allowed].join(', ')} or not naming v${version})` : '';
    return { state: 'untested', why: `v${version} is not tested yet: the install canary has posted no status for it${ignored}` };
  }
  const description = (newest.description ?? '').trim();
  if (newest.state === 'success') return { state: 'success', why: `the install canary passed v${version} (${description})`, description };
  if (newest.state === 'pending') return { state: 'untested', why: `v${version} is not tested yet: the install canary's newest status for it is pending (${description})` };
  return { state: 'failure', why: `the install canary failed v${version} (${description})` };
}

export const CANARY_STATUS_PAGES = 10;

/**
 * Every status on `commit` (GitHub pages them 100 at a time, newest first), up to CANARY_STATUS_PAGES pages. A failed
 * read throws, so a caller holds stable instead of guessing.
 */
export async function readCanaryStatuses(ghApi: (path: string) => Promise<unknown>, repo: string, commit: string): Promise<CommitStatus[]> {
  const all: CommitStatus[] = [];
  for (let page = 1; page <= CANARY_STATUS_PAGES; page++) {
    const rows = await ghApi(`repos/${repo}/commits/${commit}/statuses?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error(`the commit statuses of ${commit} are not a list`);
    all.push(...(rows as CommitStatus[]));
    if (rows.length < 100) break;
  }
  return all;
}
