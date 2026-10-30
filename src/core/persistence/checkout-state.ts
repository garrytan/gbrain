/**
 * Q1 (GBRA-153 shape A): what a managed canonical checkout holds that its upstream does not, read without fetching.
 *
 * A commit made in the checkout outside gbrain (a cron's bare `git commit`, a hand edit) is not on the upstream until
 * the owner's next Git publish, and once the upstream moves on the checkout has diverged: `gbrain sources refresh`
 * refuses `refresh_diverged`. `sources writer status` and doctor `git_convergence` report each such commit (sha,
 * author, date, subject, paths) and the porcelain counts, so an operator sees who wrote what before anything is pushed.
 * Every git call is time-bounded and read-only; the comparison is with the last fetched upstream.
 */
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';

const GIT_TIMEOUT_MS = 5_000;
export const CHECKOUT_COMMITS_MAX = 20;
export const CHECKOUT_COMMIT_PATHS_MAX = 20;

export interface CheckoutCommit { sha: string; author: string; date: string; subject: string; paths: string[]; paths_total: number }
export interface CheckoutPorcelain { staged: number; modified: number; untracked: number; conflicted: number }
export interface CheckoutState {
  root: string; branch: string | null; upstream: string | null; ahead: number; behind: number; diverged: boolean;
  unpushed_commits: CheckoutCommit[]; unpushed_truncated: boolean; porcelain: CheckoutPorcelain; fetched: false; problem?: string;
}

function git(root: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, env: gitChildEnv() }).toString(); }
  catch { return null; }
}

/** Each commit on HEAD that `@{upstream}` lacks, newest first, at most CHECKOUT_COMMITS_MAX of them. */
export function readUnpushedCommits(root: string): CheckoutCommit[] {
  const out = git(root, ['log', '@{upstream}..HEAD', `-n${CHECKOUT_COMMITS_MAX}`, '--name-only', '--format=%x1e%H%x1f%an <%ae>%x1f%aI%x1f%s']) ?? '';
  return out.split('\x1e').filter(Boolean).map(record => {
    const [header, ...lines] = record.split('\n');
    const [sha, author, date, subject] = header.split('\x1f');
    const paths = lines.map(line => line.trim()).filter(Boolean);
    return { sha, author, date, subject: subject ?? '', paths: paths.slice(0, CHECKOUT_COMMIT_PATHS_MAX), paths_total: paths.length };
  });
}

export function readPorcelain(root: string): CheckoutPorcelain {
  const counts: CheckoutPorcelain = { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const entries = (git(root, ['status', '--porcelain', '-z']) ?? '').split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    if (/^[RC]/.test(entry)) i++;
    const [x, y] = [entry[0], entry[1]];
    if (x === '?') counts.untracked++;
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) counts.conflicted++;
    else {
      if (x !== ' ' && x !== '!') counts.staged++;
      if (y !== ' ' && y !== '!') counts.modified++;
    }
  }
  return counts;
}

/** The checkout's state against its last fetched upstream; `problem` when git cannot read it or no upstream is set. */
export function readCheckoutState(root: string): CheckoutState {
  const empty = { branch: null, upstream: null, ahead: 0, behind: 0, diverged: false, unpushed_commits: [], unpushed_truncated: false,
    porcelain: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, fetched: false as const };
  const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return { root, ...empty, problem: 'not a readable git checkout' };
  const branch = git(top, ['branch', '--show-current'])?.trim() || null;
  const porcelain = readPorcelain(top);
  const upstream = git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])?.trim() || null;
  const counts = upstream ? git(top, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])?.trim().split(/\s+/).map(Number) : undefined;
  if (!upstream || !counts || counts.length !== 2 || counts.some(n => !Number.isFinite(n))) return { root: top, ...empty, branch, porcelain, problem: 'no upstream branch' };
  const [behind, ahead] = counts as [number, number];
  const unpushed = ahead ? readUnpushedCommits(top) : [];
  return { root: top, branch, upstream, ahead, behind, diverged: ahead > 0 && behind > 0, unpushed_commits: unpushed,
    unpushed_truncated: ahead > unpushed.length, porcelain, fetched: false };
}
