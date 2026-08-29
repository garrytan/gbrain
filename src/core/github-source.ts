/**
 * github-source — GitHub issues/PR sync for the `github` source kind.
 *
 * Opt-in source kind (v0.46): a source registered with kind=github mirrors
 * issues, pull requests, comments, reviews, review comments, labels,
 * assignees, milestones and open-PR checks summaries into markdown pages
 * under the source's managed directory. Pages flow through the standard
 * import pipeline (chunks, embeds, link extraction, dream-cycle atoms), so
 * the brain's existing machinery does the rest.
 *
 * Freshness model (three layers, cheapest to fastest):
 *  1. `gbrain sync --source <id>` — delta sweep via the `since` filter.
 *     Picks up everything changed since the last sweep. Zero standing infra.
 *  2. `gbrain sync --source <id> --full` — full reconcile: re-enumerates
 *     every item, refreshes stale pages, deletes pages for vanished items.
 *     Run nightly via cron or autopilot.
 *  3. Webhook (`POST /webhooks/github`) — instant targeted refresh of the
 *     single item that changed. Optional accelerator; the webhook handler
 *     submits a `sync` job with `github_item` and this module refreshes
 *     exactly that item.
 *
 * Conventions:
 *  - Slug per item: gh/<owner>/<repo>/<n> — GitHub numbers are unique per
 *    repo across issues AND PRs, so one namespace per repo is correct.
 *  - Repo card slug: gh/<owner>/<repo>.
 *  - Every `#<n>` mention in a body or comment becomes a wikilink to the
 *    item page, and Closes/Fixes/Resolves references become explicit links.
 *
 * Rate limits: the client honors x-ratelimit headers, backs off on 403/429
 * and is resumable by construction (each page carries the API updated_at in
 * frontmatter; a re-run skips items whose page is already fresh).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, join, relative } from 'node:path';

import type { BrainEngine } from './engine.ts';
import type { SyncOpts } from '../commands/sync.ts';
import { isWriteTargetContained } from './path-confine.ts';
import { createProgress, startHeartbeat } from './progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from './cli-options.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitHubAppConfig {
  /** GitHub App ID (Settings -> Developer settings -> GitHub Apps). */
  appId: number;
  /** Path to the app's private key PEM (rsa). */
  pemPath: string;
  /** Installation id; when absent the first installation of the app is used. */
  installId?: number;
}

export interface GitHubSourceConfig {
  /** Env var holding the token (default GH_TOKEN). Ignored when `app` is set. */
  tokenEnv: string;
  /** GitHub App credentials; when set, the sync mints hourly installation tokens itself. */
  app: GitHubAppConfig | null;
  /** 'auto' = owner + collaborator + org-member repos; 'repos' = explicit list. */
  scope: 'auto' | 'repos';
  /** owner/name list (lowercase), only when scope === 'repos'. */
  repos: string[];
  /** Managed dir where pages are materialized. */
  dir: string;
}

export interface GitHubItemRef {
  repo: string; // owner/name
  number: number;
  kind: 'issue' | 'pr';
  deleted?: boolean;
}

export interface GitHubSyncSummary {
  status: 'synced' | 'up_to_date' | 'first_sync' | 'partial';
  added: number;
  modified: number;
  deleted: number;
  chunksCreated: number;
  embedded: number;
  pagesAffected: string[];
  itemsSeen: number;
  itemDetailFetches: number;
  failedFiles: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

const GH_KIND = 'github';

export function isGitHubSourceConfig(config: Record<string, unknown>): boolean {
  return config.kind === GH_KIND;
}

/** True for "owner/name" with no dot segments, slashes, or empty parts. */
export function isValidRepoName(repo: string): boolean {
  if (repo.length === 0 || repo.length > 200) return false;
  if (repo.startsWith('/') || repo.endsWith('/')) return false;
  const parts = repo.split('/');
  if (parts.length !== 2) return false;
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..' && /^[\w.-]+$/.test(p));
}

export function parseGitHubSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): GitHubSourceConfig {
  const tokenEnv =
    typeof config.gh_token_env === 'string' && config.gh_token_env.length > 0
      ? config.gh_token_env
      : 'GH_TOKEN';
  const app: GitHubAppConfig | null =
    typeof config.gh_app_id === 'number' &&
    Number.isInteger(config.gh_app_id) &&
    typeof config.gh_app_pem_path === 'string' &&
    config.gh_app_pem_path.length > 0
      ? {
          appId: config.gh_app_id,
          pemPath: config.gh_app_pem_path,
          installId:
            typeof config.gh_app_install_id === 'number' &&
            Number.isInteger(config.gh_app_install_id) &&
            config.gh_app_install_id > 0
              ? config.gh_app_install_id
              : undefined,
        }
      : null;
  // gh_handle / gh_involvement are reserved config keys: tolerated when
  // present but ignored (the involvement expansion is not implemented).
  const scope = config.gh_scope === 'repos' ? 'repos' : 'auto';
  // Repo names are case-insensitive on GitHub; everything downstream (page
  // paths, state file, webhook matching, slugs) keys on the lowercase form.
  const repos =
    typeof config.gh_repos === 'string'
      ? config.gh_repos
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(isValidRepoName)
      : [];
  const dir =
    typeof config.gh_dir === 'string' && config.gh_dir.length > 0
      ? config.gh_dir
      : fallbackDir;
  return { tokenEnv, app, scope, repos, dir };
}

export function gitHubStateFile(dir: string): string {
  return join(dir, '.github-source.json');
}

interface GitHubState {
  last_sweep_at: string | null;
  /** owner/name -> default branch (for check fetches we only need head sha, so this stays small). */
  repos: string[];
}

function readState(dir: string): GitHubState {
  try {
    const raw = readFileSync(gitHubStateFile(dir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GitHubState>;
    return {
      last_sweep_at: typeof parsed.last_sweep_at === 'string' ? parsed.last_sweep_at : null,
      // Legacy state files may carry canonical-case names; the module keys
      // on lowercase everywhere.
      repos: Array.isArray(parsed.repos)
        ? parsed.repos.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
        : [],
    };
  } catch {
    return { last_sweep_at: null, repos: [] };
  }
}

function writeState(dir: string, state: GitHubState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(gitHubStateFile(dir), JSON.stringify(state, null, 2), 'utf-8');
}

// ── HTTP client (rate-limit aware, injectable for tests) ─────────────────────

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

interface RateInfo {
  remaining: number | null;
  resetAt: number | null;
}

// ── Token acquisition (PAT or GitHub App) ────────────────────────────────────

/** A credential source the client can refresh mid-run (apps mint hourly tokens). */
export interface GitHubTokenProvider {
  getToken(): Promise<string>;
  refresh(): Promise<string>;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

interface MintedInstallationToken {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * Mint an installation access token for a GitHub App:
 * RS256 JWT (iss = app id, 9 min) -> find installation -> POST access_tokens.
 * Installation tokens last 1 hour; callers refresh before expiry.
 */
export async function mintAppInstallationToken(
  app: GitHubAppConfig,
  fetchImpl: FetchImpl = fetch,
): Promise<MintedInstallationToken> {
  const pem = readFileSync(app.pemPath, 'utf-8');
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec, exp: nowSec + 540, iss: app.appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(pem, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${payload}.${sig}`;
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };

  let installId = app.installId;
  if (!installId) {
    const res = await fetchImpl('https://api.github.com/app/installations', { headers });
    if (!res.ok) throw new Error(`GitHub App installations HTTP ${res.status}`);
    const installs = (await res.json()) as Array<{ id: number }>;
    if (installs.length === 0) throw new Error('GitHub App has no installations');
    installId = installs[0].id;
  }
  const res = await fetchImpl(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) throw new Error(`GitHub App access_tokens HTTP ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/** Caches a minted installation token and refreshes it before expiry. */
export class AppTokenProvider implements GitHubTokenProvider {
  private cached: MintedInstallationToken | null = null;

  constructor(
    private readonly app: GitHubAppConfig,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 5 * 60_000 > Date.now()) return this.cached.token;
    return this.refresh();
  }

  async refresh(): Promise<string> {
    this.cached = await mintAppInstallationToken(this.app, this.fetchImpl);
    return this.cached.token;
  }
}

export class GitHubClient {
  constructor(
    private readonly token: string | GitHubTokenProvider,
    private readonly fetchImpl: FetchImpl = fetch,
    public readonly log: (msg: string) => void = () => {},
  ) {}

  private rate: RateInfo = { remaining: null, resetAt: null };

  private apiUrl(path: string): string {
    return `https://api.github.com${path}`;
  }

  /** Wait for the rate-limit reset when we are near the bucket edge. */
  private async waitForBucket(signal: AbortSignal | undefined): Promise<void> {
    const { remaining, resetAt } = this.rate;
    if (remaining === null || resetAt === null) return;
    if (remaining > 20) return;
    const waitMs = Math.max(0, resetAt - Date.now()) + 1000;
    if (waitMs <= 0) return;
    this.log(`[github] rate bucket low (${remaining} left); waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, waitMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      }
    });
  }

  private trackRate(res: Response): void {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rate.remaining = Number(remaining);
    if (reset !== null) this.rate.resetAt = Number(reset) * 1000;
  }

  async fetchJSON<T>(
    path: string,
    opts: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<T> {
    const { data } = await this.fetchJSONWithMeta<T>(path, opts);
    return data;
  }

  private async tokenValue(): Promise<string> {
    return typeof this.token === 'string' ? this.token : this.token.getToken();
  }

  private async fetchJSONWithMeta<T>(
    pathOrUrl: string,
    opts: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<{ data: T; link: string | null }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.apiUrl(pathOrUrl);
    const retries = opts.retries ?? 1;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitForBucket(opts.signal);
      const res = await this.fetchImpl(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${await this.tokenValue()}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: opts.signal,
      });
      this.trackRate(res);
      if (res.status === 401 && typeof this.token !== 'string' && attempt < retries) {
        // Installation tokens expire hourly; a 401 mid-run means the minted
        // token lapsed. Refresh once and retry the same request.
        this.log('[github] HTTP 401; refreshing token');
        await this.token.refresh();
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        // A 403 with no Retry-After and budget left in the rate bucket is a
        // permission/abuse error, not a rate limit — sleeping until the
        // bucket reset can't fix it.
        const rateExhausted = this.rate.remaining !== null && this.rate.remaining <= 2;
        if (res.status === 403 && retryAfterMs === null && !rateExhausted) {
          throw new Error(`GitHub API HTTP 403 on ${pathOrUrl} (not rate-limited; check token permissions)`);
        }
        const waitMs = retryAfterMs !== null ? retryAfterMs : this.rate.resetAt !== null
          ? Math.max(0, this.rate.resetAt - Date.now()) + 1000
          : 60_000;
        if (attempt < retries) {
          this.log(`[github] HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s`);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs);
            if (opts.signal) {
              opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
            }
          });
          continue;
        }
        throw new Error(`GitHub API HTTP ${res.status} on ${pathOrUrl}`);
      }
      if (!res.ok) {
        throw new Error(`GitHub API HTTP ${res.status} on ${pathOrUrl}`);
      }
      return { data: (await res.json()) as T, link: res.headers.get('link') };
    }
    throw new Error(`GitHub API unreachable on ${pathOrUrl}`);
  }

  /**
   * GET all pages of a paginated list, concatenated. Follows the Link
   * header (rel="next"), which GitHub sends for every paginated endpoint.
   * Throws GitHubPaginationError when the safety cap is hit so callers
   * can treat the enumeration as incomplete (never reconcile a truncated
   * list against the brain).
   */
  async fetchAllPages<T>(
    path: string,
    opts: { signal?: AbortSignal; perPage?: number; field?: string } = {},
  ): Promise<T[]> {
    const perPage = opts.perPage ?? 100;
    const out: T[] = [];
    let url = `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}&page=1`;
    let pages = 0;
    for (;;) {
      const { data, link } = await this.fetchJSONWithMeta<Record<string, unknown> | unknown[]>(url, opts);
      const raw = Array.isArray(data) ? data : opts.field ? (data as Record<string, unknown>)[opts.field] : data;
      // Fail loud on shape drift: silently treating a non-array payload as
      // empty would let a reconcile see "no items" where the API sent some.
      if (!Array.isArray(raw)) {
        throw new Error(
          `GitHub API returned a non-array payload on ${path}${opts.field ? ` (field "${opts.field}")` : ''}`,
        );
      }
      const batch = raw as T[];
      out.push(...batch);
      const next = link !== null ? linkNextUrl(link) : null;
      if (next === null) break;
      // Never follow a Link header off api.github.com: the bearer token
      // must not leak to an arbitrary host (codex LOW, round 3).
      if (!next.startsWith('https://api.github.com/')) {
        throw new GitHubPaginationError(`Link header points off api.github.com: ${next}`);
      }
      // Cap counts only pages that actually continue: a complete 500-page
      // enumeration is valid, a 501st page is not (codex LOW, round 4).
      pages++;
      if (pages >= 500) {
        throw new GitHubPaginationError(`pagination cap (500 pages) hit on ${path}; refusing to treat a truncated list as complete`);
      }
      url = next;
    }
    return out;
  }
}

/**
 * Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Returns milliseconds to wait, or null when absent/unparseable — never NaN,
 * which would turn the backoff sleep into a hot retry loop.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

/** Thrown when pagination hits the safety cap; callers treat enumeration as incomplete. */
export class GitHubPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPaginationError';
  }
}

/** Parse the Link header and return the rel="next" URL, or null. */
export function linkNextUrl(link: string): string | null {
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// ── Scope resolution ─────────────────────────────────────────────────────────

interface RawRepo {
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  description: string | null;
}

/**
 * Expand the source's scope to the concrete owner/name list (lowercase —
 * GitHub repo names are case-insensitive and the whole module keys on the
 * lowercase form).
 * auto = affiliation owner,collaborator,organization_member (paginated).
 *
 * NEVER persists state.repos: only a sweep that fully succeeded for a repo
 * may state-list it (see runGitHubSync). Persisting at discovery time — in
 * particular during a webhook single-item refresh — would mark unswept repos
 * as already bootstrapped and silently skip their history on the next sweep.
 */
export async function resolveScopeRepos(
  cfg: GitHubSourceConfig,
  client: GitHubClient,
  signal?: AbortSignal,
): Promise<string[]> {
  if (cfg.scope === 'repos') {
    return [...new Set(cfg.repos.map((r) => r.toLowerCase()))];
  }
  // Installation tokens cannot call /user/repos, so the app path resolves
  // through /installation/repositories (object-shaped: { repositories }).
  const names = cfg.app
    ? (
        await client.fetchAllPages<RawRepo>('/installation/repositories', {
          signal,
          field: 'repositories',
        })
      ).map((r) => r.full_name.toLowerCase())
    : (
        await client.fetchAllPages<RawRepo>(
          '/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name',
          { signal },
        )
      ).map((r) => r.full_name.toLowerCase());
  return [...new Set(names)].sort();
}

// ── Item enumeration ─────────────────────────────────────────────────────────

/**
 * List-payload shapes. The enumeration endpoints return most issue fields
 * (body, labels, assignees, author, milestone, dates) without extra calls,
 * so pass 1 of a sync materializes pages from these alone.
 */
interface RawIssueListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  updated_at: string;
  pull_request?: { url: string };
  body?: string | null;
  html_url?: string;
  created_at?: string;
  closed_at?: string | null;
  labels?: { name: string }[];
  assignees?: { login: string }[];
  milestone?: RawMilestone | null;
  user?: { login: string } | null;
  draft?: boolean;
}

interface RawPullListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  updated_at: string;
  head: { sha: string };
  body?: string | null;
  html_url?: string;
  created_at?: string;
  closed_at?: string | null;
  labels?: { name: string }[];
  assignees?: { login: string }[];
  milestone?: RawMilestone | null;
  user?: { login: string } | null;
  draft?: boolean;
  merged?: boolean;
  mergeable_state?: string | null;
}

/**
 * Enumerate items for one repo. `since` (ISO) restricts to items updated
 * after it; when absent the full history is enumerated.
 * Returns { issues, prs } where prs carry head sha for open-PR checks.
 */
export async function enumerateRepoItems(
  repo: string,
  client: GitHubClient,
  opts: { since?: string; signal?: AbortSignal } = {},
): Promise<{ issues: RawIssueListItem[]; prs: RawPullListItem[] }> {
  const sinceQuery = opts.since ? `&since=${encodeURIComponent(opts.since)}` : '';
  // The issues endpoint returns PRs too; we classify by the pull_request key.
  const all = await client.fetchAllPages<RawIssueListItem>(
    `/repos/${repo}/issues?state=all${sinceQuery}`,
    opts,
  );
  const issues = all.filter((i) => !i.pull_request);
  const prsFromIssues = all.filter((i) => i.pull_request);
  const updatedByNumber = new Map(prsFromIssues.map((i) => [i.number, i.updated_at]));
  const prNumbers = prsFromIssues.map((i) => i.number);
  // Open PRs get head sha so we can refresh checks cheaply.
  const openPrs = await client.fetchAllPages<RawPullListItem>(
    `/repos/${repo}/pulls?state=open`,
    opts,
  );
  const openByNumber = new Map(openPrs.map((p) => [p.number, p]));
  const prs: RawPullListItem[] = [];
  for (const n of prNumbers) {
    const open = openByNumber.get(n);
    if (open) {
      prs.push(open);
    } else {
      // Keep the real updated_at from the issues list so delta sweeps
      // re-fetch closed PRs that changed (comments, merge, review), and
      // carry the issue-list fields so a pass-1 render is never blank.
      const src = prsFromIssues.find((i) => i.number === n);
      prs.push({
        number: n,
        title: src?.title ?? '',
        state: 'closed',
        updated_at: updatedByNumber.get(n) ?? '',
        head: { sha: '' },
        body: src?.body ?? null,
        html_url: src?.html_url ?? '',
        created_at: src?.created_at,
        closed_at: src?.closed_at ?? null,
        labels: src?.labels ?? [],
        assignees: src?.assignees ?? [],
        milestone: src?.milestone ?? null,
        user: src?.user ?? null,
        draft: src?.draft,
      });
    }
  }
  // Open PRs whose updated_at predates `since` never appear in the issues
  // list, but their check state can change without bumping updated_at (a new
  // check run doesn't touch it). Union them in so the per-sweep open-PR
  // refresh actually sees every open PR, not just recently-updated ones.
  const sinceFiltered = new Set(prNumbers);
  for (const p of openPrs) {
    if (!sinceFiltered.has(p.number)) prs.push(p);
  }
  return { issues, prs };
}

// ── Detail fetching ──────────────────────────────────────────────────────────

interface RawComment {
  user: { login: string } | null;
  body: string;
  created_at: string;
}

interface RawReview {
  user: { login: string } | null;
  state: string;
  body: string;
  submitted_at: string | null;
}

interface RawReviewComment {
  user: { login: string } | null;
  body: string;
  created_at: string;
  path: string;
  line: number | null;
  original_line: number | null;
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface RawCheckRuns {
  total_count: number;
  check_runs: RawCheckRun[];
}

interface RawStatusEntry {
  state: string;
  context: string;
}

interface RawMilestone {
  title: string;
  state: string;
}

interface RawIssueDetail {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  milestone: RawMilestone | null;
  html_url: string;
  draft?: boolean;
  user: { login: string } | null;
}

interface RawPullDetail extends RawIssueDetail {
  merged: boolean;
  mergeable_state: string | null;
  review_decision: string | null;
  head: { sha: string; ref: string };
}

export interface GitHubItemData {
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  detail: RawIssueDetail;
  comments: RawComment[];
  reviews: RawReview[];
  reviewComments: RawReviewComment[];
  checks: { pass: number; fail: number; pending: number; failing: string[] } | null;
  /** Item numbers referenced via Closes/Fixes/Resolves in the description. */
  linked: number[];
}

export async function fetchItemData(
  repo: string,
  number: number,
  kind: 'issue' | 'pr',
  client: GitHubClient,
  opts: { signal?: AbortSignal } = {},
): Promise<GitHubItemData> {
  const detail = await client.fetchJSON<RawIssueDetail>(
    `/repos/${repo}/issues/${number}`,
    opts,
  );
  const comments = await client.fetchAllPages<RawComment>(
    `/repos/${repo}/issues/${number}/comments`,
    opts,
  );
  let reviews: RawReview[] = [];
  let reviewComments: RawReviewComment[] = [];
  let checks: GitHubItemData['checks'] = null;
  if (kind === 'pr') {
    const prDetail = detail as RawPullDetail;
    if (prDetail.merged === undefined) {
      const fetched = await client.fetchJSON<RawPullDetail>(`/repos/${repo}/pulls/${number}`, opts);
      Object.assign(detail, fetched);
    }
    reviews = await client.fetchAllPages<RawReview>(`/repos/${repo}/pulls/${number}/reviews`, opts);
    reviewComments = await client.fetchAllPages<RawReviewComment>(
      `/repos/${repo}/pulls/${number}/comments`,
      opts,
    );
    if ((detail as RawPullDetail).state === 'open' && (detail as RawPullDetail).head?.sha) {
      checks = await fetchChecks(repo, (detail as RawPullDetail).head.sha, client, opts);
    }
  }
  const linked = extractLinkedNumbers(detail.body ?? '');
  return {
    repo,
    number,
    kind,
    detail,
    comments,
    reviews,
    reviewComments,
    checks,
    linked,
  };
}

async function fetchChecks(
  repo: string,
  headSha: string,
  client: GitHubClient,
  opts: { signal?: AbortSignal },
): Promise<GitHubItemData['checks']> {
  try {
    const [runs, status] = await Promise.all([
      client.fetchAllPages<RawCheckRun>(`/repos/${repo}/commits/${headSha}/check-runs`, { ...opts, field: 'check_runs' }),
      client.fetchAllPages<RawStatusEntry>(`/repos/${repo}/commits/${headSha}/status`, { ...opts, field: 'statuses' }),
    ]);
    let pass = 0;
    let fail = 0;
    let pending = 0;
    const failing: string[] = [];
    for (const run of runs) {
      if (run.status !== 'completed') {
        pending++;
      } else if (run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped') {
        pass++;
      } else {
        fail++;
        failing.push(run.name);
      }
    }
    for (const s of status) {
      if (s.state === 'success') pass++;
      else if (s.state === 'pending') pending++;
      else {
        fail++;
        failing.push(s.context);
      }
    }
    return { pass, fail, pending, failing: [...new Set(failing)].slice(0, 20) };
  } catch {
    return null; // checks are best-effort
  }
}

const LINK_RE = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;

export function extractLinkedNumbers(body: string): number[] {
  const out = new Set<number>();
  const re = new RegExp(LINK_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

const MENTION_RE = /(^|\s)#(\d{1,7})(?![A-Za-z0-9_])/g;

/** Replace #n mentions with wikilinks to the item pages. */
export function linkifyMentions(body: string, repo: string): string {
  return body.replace(MENTION_RE, (_all, lead: string, num: string) => {
    return `${lead}[[gh/${repo}/${num}|#${num}]]`;
  });
}

// ── Page rendering ───────────────────────────────────────────────────────────

function yamlStr(v: string): string {
  return JSON.stringify(v);
}

function yamlList(v: string[]): string {
  if (v.length === 0) return '[]';
  return `\n${v.map((s) => `  - ${yamlStr(s)}`).join('\n')}`;
}

export function itemPagePath(dir: string, repo: string, number: number): string {
  const p = join(dir, 'gh', repo, `${number}.md`);
  assertContained(dir, p, repo);
  return p;
}

export function repoCardPath(dir: string, repo: string): string {
  const p = join(dir, 'gh', repo, 'index.md');
  assertContained(dir, p, repo);
  return p;
}

/**
 * Path-containment guard: a crafted repo name must never escape the managed
 * dir. Symlink-safe: `isWriteTargetContained` realpaths the deepest existing
 * ancestor, so a planted `gh/` symlink pointing outside the managed dir is
 * caught where a lexical prefix check would pass.
 */
function assertContained(dir: string, path: string, repo: string): void {
  if (!isValidRepoName(repo)) {
    throw new Error(`Invalid GitHub repo name: "${repo}"`);
  }
  if (!isWriteTargetContained(path, dir)) {
    throw new Error(`Path escapes managed dir: "${path}"`);
  }
}

export function renderRepoCard(repo: string, data: RawRepo): string {
  const now = new Date().toISOString();
  return [
    '---',
    `kind: repo`,
    `repo: ${yamlStr(repo)}`,
    `url: ${yamlStr(`https://github.com/${repo}`)}`,
    `description: ${yamlStr(data.description ?? '')}`,
    `default_branch: ${yamlStr(data.default_branch)}`,
    `archived: ${data.archived}`,
    `private: ${data.private}`,
    `synced_at: ${yamlStr(now)}`,
    '---',
    '',
    `# ${repo}`,
    '',
    data.description ?? '',
    '',
    `Default branch: ${data.default_branch}`,
    '',
  ].join('\n');
}

function checksSummaryLines(checks: GitHubItemData['checks']): string[] {
  if (!checks) return [];
  const line = `**Checks:** ${checks.pass} passing, ${checks.fail} failing, ${checks.pending} pending`;
  const failing = checks.failing.length > 0 ? `\n\nFailing: ${checks.failing.join(', ')}` : '';
  return ['', line + failing, ''];
}

export function renderItemPage(data: GitHubItemData, detailFetched = true): string {
  const d = data.detail;
  const now = new Date().toISOString();
  const isPr = data.kind === 'pr';
  const pr = d as RawPullDetail;
  const status = isPr
    ? pr.merged ? 'merged' : d.state === 'open' ? (d.draft ? 'draft' : 'open') : 'closed'
    : d.state;
  const reviewDecision = isPr && d.state === 'open' ? (pr.review_decision ?? '') : '';
  const frontmatter: string[] = [
    '---',
    `kind: ${isPr ? 'pr' : 'issue'}`,
    `repo: ${yamlStr(data.repo)}`,
    `number: ${d.number}`,
    `title: ${yamlStr(d.title)}`,
    `state: ${d.state}`,
    `status: ${yamlStr(status)}`,
    `url: ${yamlStr(d.html_url)}`,
    `author: ${yamlStr(d.user?.login ?? '')}`,
    `created_at: ${yamlStr(d.created_at)}`,
    `updated_at: ${yamlStr(d.updated_at)}`,
    `closed_at: ${yamlStr(d.closed_at ?? '')}`,
    `synced_at: ${yamlStr(now)}`,
    `detail_fetched: ${detailFetched}`,
    `labels: ${yamlList(d.labels.map((l) => l.name))}`,
    `assignees: ${yamlList(d.assignees.map((a) => a.login))}`,
    `milestone: ${yamlStr(d.milestone?.title ?? '')}`,
    `linked: ${yamlList(data.linked.map((n) => String(n)))}`,
  ];
  if (isPr) {
    frontmatter.push(
      `merged: ${pr.merged}`,
      `mergeable_state: ${yamlStr(pr.mergeable_state ?? '')}`,
      `review_decision: ${yamlStr(reviewDecision)}`,
      `head_ref: ${yamlStr(pr.head?.ref ?? '')}`,
    );
    if (data.checks) {
      frontmatter.push(
        `checks_pass: ${data.checks.pass}`,
        `checks_fail: ${data.checks.fail}`,
        `checks_pending: ${data.checks.pending}`,
      );
    }
  }
  frontmatter.push('---');

  const body: string[] = [];
  body.push(`# ${d.title}`, '');
  body.push(`[${isPr ? 'PR' : 'Issue'} #${d.number}](${d.html_url}) · ${d.state}${isPr && pr.merged ? ' · merged' : ''}`, '');
  if (data.checks && data.checks.fail > 0) {
    body.push(...checksSummaryLines(data.checks));
  }
  body.push('## Description', '');
  if (d.body) {
    body.push(linkifyMentions(d.body, data.repo), '');
  } else {
    body.push('_no description_', '');
    // Empty-body items render almost nothing matchable (title alone), which
    // makes them near-unrecallable by label/milestone/assignee queries.
    // Surface the structured context so retrieval has tokens to hit.
    const ctx: string[] = [];
    if (d.labels.length) ctx.push(`labels: ${d.labels.map((l) => l.name).join(', ')}`);
    if (d.milestone) ctx.push(`milestone: ${d.milestone.title}`);
    if (d.assignees.length) ctx.push(`assignees: ${d.assignees.map((a) => a.login).join(', ')}`);
    ctx.push(`repo: ${data.repo}`);
    body.push('', '## Context', '', ...ctx.map((c) => `- ${c}`), '');
  }

  if (data.linked.length > 0) {
    body.push(
      '## Linked',
      '',
      ...data.linked.map((n) => `- [[gh/${data.repo}/${n}|#${n}]]`),
      '',
    );
  }

  if (data.comments.length > 0) {
    body.push('## Comments', '');
    for (const c of data.comments) {
      body.push(`### ${c.user?.login ?? 'ghost'} · ${c.created_at}`, '');
      body.push(linkifyMentions(c.body, data.repo), '');
    }
  }

  if (data.reviews.length > 0) {
    body.push('## Reviews', '');
    for (const r of data.reviews) {
      body.push(`### ${r.user?.login ?? 'ghost'} · ${r.state}${r.submitted_at ? ` · ${r.submitted_at}` : ''}`, '');
      if (r.body) body.push(linkifyMentions(r.body, data.repo), '');
    }
  }

  if (data.reviewComments.length > 0) {
    body.push('## Review comments', '');
    for (const rc of data.reviewComments) {
      const loc = rc.path + (rc.line ? `:${rc.line}` : '');
      body.push(`### ${rc.user?.login ?? 'ghost'} · ${loc} · ${rc.created_at}`, '');
      body.push(linkifyMentions(rc.body, data.repo), '');
    }
  }

  return frontmatter.join('\n') + '\n' + body.join('\n') + '\n';
}

/**
 * Build the pass-1 page from list payloads alone (no per-item detail calls).
 * Approximate for PRs: review_decision/merged/mergeable_state come from the
 * pulls list when available; comments, reviews and checks are filled by pass 2.
 */
export function renderListItemPage(
  repo: string,
  kind: 'issue' | 'pr',
  item: RawIssueListItem | RawPullListItem,
): string {
  const isPr = kind === 'pr';
  const pr = item as RawPullListItem;
  const detail: RawIssueDetail = {
    number: item.number,
    title: item.title,
    state: item.state,
    state_reason: null,
    body: item.body ?? null,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at,
    closed_at: item.closed_at ?? null,
    labels: item.labels ?? [],
    assignees: item.assignees ?? [],
    milestone: item.milestone ?? null,
    html_url: item.html_url ?? '',
    draft: item.draft,
    user: item.user ?? null,
  };
  if (isPr) {
    // merged stays null until pass 2: the list payloads do not carry it for
    // closed PRs, and a wrong `merged: false` on a merged PR is worse than
    // an unknown one.
    Object.assign(detail, {
      merged: pr.merged ?? null,
      mergeable_state: pr.mergeable_state ?? null,
      review_decision: null,
      head: { sha: pr.head?.sha ?? '', ref: '' },
    });
  }
  const data: GitHubItemData = {
    repo,
    number: item.number,
    kind,
    detail,
    comments: [],
    reviews: [],
    reviewComments: [],
    checks: null,
    linked: extractLinkedNumbers(detail.body ?? ''),
  };
  return renderItemPage(data, false);
}

// ── Page freshness helpers ───────────────────────────────────────────────────

interface StoredFrontmatter {
  updated_at?: string;
}

function readStoredUpdatedAt(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const m = raw.match(/^updated_at:\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** True when the on-disk page is already at least as fresh as the API value. */
export function isPageFresh(filePath: string, apiUpdatedAt: string): boolean {
  if (!existsSync(filePath)) return false;
  const stored = readStoredUpdatedAt(filePath);
  if (stored === null) return false;
  return stored >= apiUpdatedAt; // ISO-8601 strings compare lexicographically
}

/**
 * True when the page went through a detail fetch (comments, reviews, checks).
 * Pages written before the two-pass change have no marker and ARE complete,
 * so a missing marker reads as true; only `detail_fetched: false` (pass-1
 * list render) is treated as pending detail.
 */
export function pageHasDetail(filePath: string): boolean {
  // A missing file has no detail yet: pass 1 materializes the cheap list
  // page first, pass 2 enriches it. Only markerless EXISTING pages (written
  // before the two-pass change) are treated as complete.
  if (!existsSync(filePath)) return false;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const m = raw.match(/^detail_fetched:\s*(true|false)/m);
    return m ? m[1] === 'true' : true;
  } catch {
    return true;
  }
}

// ── Sync runner ──────────────────────────────────────────────────────────────

interface GitHubSyncDeps {
  engine: BrainEngine;
  sourceId: string;
  cfg: GitHubSourceConfig;
  opts: SyncOpts;
  client: GitHubClient;
}

async function importPage(
  deps: GitHubSyncDeps,
  filePath: string,
  activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined,
  relPathOverride?: string,
): Promise<{ slug: string; chunks: number; status: 'imported' | 'skipped' }> {
  const { importFile } = await import('./import-file.ts');
  const rel = relPathOverride ?? relative(deps.cfg.dir, filePath).replace(/\\/g, '/');
  const result = await importFile(deps.engine, filePath, rel, {
    noEmbed: true, // embeddings handled by the size gate below, like sync
    sourceId: deps.sourceId,
    activePack,
  });
  if (result.status === 'error' || result.error) {
    throw new Error(result.error ?? `Import failed for ${rel}`);
  }
  return { slug: result.slug, chunks: result.chunks, status: result.status === 'imported' ? 'imported' : 'skipped' };
}

async function deleteStalePages(
  deps: GitHubSyncDeps,
  keepPaths: Set<string>,
  summary: GitHubSyncSummary,
  succeededRepos: ReadonlySet<string>,
): Promise<void> {
  const { planReconcileDeletes } = await import('../commands/sync.ts');
  const allRows = await deps.engine.executeRaw<{ slug: string; source_path: string | null }>(
    `SELECT slug, source_path FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
    [deps.sourceId],
  );
  // Data-loss guard: a repo that errored mid-sweep contributes no keepPaths,
  // so its pages must be EXCLUDED from the reconcile entirely, otherwise a
  // transient API failure would look like a bulk deletion.
  const rows = allRows.filter((r) => {
    if (r.source_path === null) return false;
    const parts = r.source_path.split('/');
    const ownerRepo = parts.length >= 3 ? parts.slice(0, 3).join('/') : '';
    // Case-folded: legacy rows may carry canonical-case source_paths while
    // succeededRepos keys on the lowercase form.
    return ownerRepo !== '' && succeededRepos.has(ownerRepo.toLowerCase());
  });
  const plan = planReconcileDeletes(
    rows,
    keepPaths,
    (p) => p.startsWith('gh/') && p.endsWith('.md'),
  );
  if (plan.staleSlugs.length === 0) return;
  const { massReconcileAllowed } = await import('../commands/sync.ts');
  if (plan.massDelete && !massReconcileAllowed()) {
    deps.client.log?.(`[github] mass-delete guard refused ${plan.staleSlugs.length} deletes for source ${deps.sourceId}`);
    return;
  }
  const bySlug = new Map(rows.map((r) => [r.slug, r.source_path]));
  const batchSize = 500;
  for (let i = 0; i < plan.staleSlugs.length; i += batchSize) {
    const batch = plan.staleSlugs.slice(i, i + batchSize);
    await deps.engine.deletePages(batch, { sourceId: deps.sourceId });
    // We own these files (unlike git sources): remove them so a re-add of
    // the same number starts from a clean page.
    for (const slug of batch) {
      const rel = bySlug.get(slug);
      if (!rel) continue;
      try {
        const { rmSync } = await import('node:fs');
        rmSync(join(deps.cfg.dir, rel), { force: true });
      } catch { /* best-effort */ }
    }
  }
  summary.deleted += plan.staleSlugs.length;
}

/**
 * Main entry for the github source kind. Called from performSyncInner when
 * the resolved source is kind=github. Handles:
 *  - opts.githubItem   -> single-item refresh (webhook path)
 *  - opts.full         -> full reconcile (re-enumerate everything + delete)
 *  - otherwise         -> delta sweep since last run
 */
export async function runGitHubSync(
  engine: BrainEngine,
  sourceId: string,
  cfg: GitHubSourceConfig,
  opts: SyncOpts,
  fetchImpl?: FetchImpl,
): Promise<import('../commands/sync.ts').SyncResult> {
  // Credential source: a GitHub App (auto-minted hourly installation tokens)
  // wins when configured; otherwise cfg.tokenEnv is the single source of
  // truth (the default is GH_TOKEN; a custom --token-env that is unset fails
  // loudly instead of silently using a different token scope, codex LOW).
  if (!cfg.app && !process.env[cfg.tokenEnv]) {
    throw new Error(
      `GitHub source "${sourceId}" has no token. Set ${cfg.tokenEnv} in the environment or configure a GitHub App (gh_app_id + gh_app_pem_path).`,
    );
  }
  const client = cfg.app
    ? new GitHubClient(new AppTokenProvider(cfg.app, fetchImpl ?? fetch), fetchImpl)
    : new GitHubClient(process.env[cfg.tokenEnv] ?? '', fetchImpl);
  const deps: GitHubSyncDeps = { engine, sourceId, cfg, opts, client };
  const summary: GitHubSyncSummary = {
    status: 'synced',
    added: 0,
    modified: 0,
    deleted: 0,
    chunksCreated: 0,
    embedded: 0,
    pagesAffected: [],
    itemsSeen: 0,
    itemDetailFetches: 0,
    failedFiles: 0,
  };

  // Active pack for pack-aware typing, mirroring performSyncInner.
  let activePack: GitHubSyncDeps['opts'] extends never ? never : { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
  activePack = undefined;
  if (!opts.noSchemaPack) {
    try {
      const { loadActivePack } = await import('./schema-pack/load-active.ts');
      const { loadConfig } = await import('./config.ts');
      const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
      activePack = { page_types: resolved.manifest.page_types };
    } catch { /* fall back to legacy typing */ }
  }

  // Keep previous scope before this run resolves its refreshed repo list.
  // A repo added to an existing source needs a history bootstrap even when
  // the source-wide cursor is already ahead of its old items.
  const state = readState(cfg.dir);
  const previousRepos = new Set(state.repos);

  // Shared bulk-progress reporter (docs/progress-events.md, phase
  // sync.github_materialize): stderr-only heartbeats during the network
  // phases, one tick per item. finish() is guaranteed by the finally so a
  // thrown error never leaves a live phase behind.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('sync.github_materialize');
  try {
    const stopScopeHb = startHeartbeat(progress, 'resolving repo scope');
    let repos: string[];
    try {
      repos = await resolveScopeRepos(cfg, client, opts.signal);
    } finally {
      stopScopeHb();
    }

    if (opts.githubItem) {
      // Scope guard: only refresh items in the resolved scope. Webhooks for
      // out-of-scope repos are acknowledged upstream but never materialized.
      // Repo casing is normalized so a webhook payload that differs in case
      // from the stored repo still matches (GitHub repo names are
      // case-insensitive; the managed dir layout is lowercase).
      const item = { ...opts.githubItem, repo: opts.githubItem.repo.toLowerCase() };
      if (!repos.includes(item.repo)) {
        return syncResult({ ...summary, status: 'up_to_date' }, opts);
      }
      const stopItemHb = startHeartbeat(progress, `refreshing ${item.repo}#${item.number}`);
      try {
        await refreshSingleItem(deps, item, activePack, summary);
      } finally {
        stopItemHb();
      }
      await touchSourceRow(deps, new Date().toISOString());
      return syncResult(summary, opts);
    }

    const since = opts.full ? undefined : state.last_sweep_at ?? undefined;
    const keepPaths = new Set<string>();
    const succeededRepos = new Set<string>();
    // Pages counted in pass 1 must not be counted again when pass 2 replaces
    // them in the same run (added/modified describe distinct page outcomes).
    const countedSlugs = new Set<string>();
    let maxUpdatedAt = state.last_sweep_at ?? '';
    const repoMeta = new Map<string, RawRepo>();

    for (const repo of repos) {
      if (opts.signal?.aborted) break;
      try {
        const repoSince = opts.full || !previousRepos.has(repo) ? undefined : since;
        const stopListHb = startHeartbeat(progress, `listing ${repo}`);
        let issues: RawIssueListItem[];
        let prs: RawPullListItem[];
        try {
          ({ issues, prs } = await enumerateRepoItems(repo, client, { since: repoSince, signal: opts.signal }));
        } finally {
          stopListHb();
        }
        const items: Array<{
          repo: string;
          number: number;
          kind: 'issue' | 'pr';
          state: string;
          updated_at: string;
          list: RawIssueListItem | RawPullListItem;
        }> = [
          ...issues.map((i) => ({ repo, number: i.number, kind: 'issue' as const, state: i.state, updated_at: i.updated_at, list: i as RawIssueListItem })),
          ...prs.map((p) => ({ repo, number: p.number, kind: 'pr' as const, state: p.state, updated_at: p.updated_at, list: p as RawPullListItem })),
        ];
        // Item count known: restart the phase with this repo's total. Every
        // item ticks exactly once (fresh skip, pass-1 failure, or pass 2).
        progress.start('sync.github_materialize', items.length);
        const pendingDetail: typeof items = [];
        for (const item of items) {
          const filePath = itemPagePath(cfg.dir, repo, item.number);
          keepPaths.add(relative(cfg.dir, filePath).replace(/\\/g, '/'));
          summary.itemsSeen++;
          // Open PRs are never fresh: their check state can change without
          // touching the PR's updated_at (a new check run does not bump it),
          // so they are re-fetched every sweep. Cost is bounded by the number
          // of open PRs, which is small in practice.
          const isOpenPr = item.kind === 'pr' && item.state === 'open';
          const fresh = isPageFresh(filePath, item.updated_at);
          const hasDetail = pageHasDetail(filePath);
          if (!opts.full && !isOpenPr && fresh && hasDetail) {
            // Cursor accounting: a fresh skip is a success too. Without this,
            // a repo whose newest item is always fresh stays re-listed on
            // every sweep (the since filter never passes it).
            if (item.updated_at > maxUpdatedAt) maxUpdatedAt = item.updated_at;
            progress.tick(1, `${repo}#${item.number} fresh`);
            continue;
          }
          // Pass 1 (cheap): materialize from the list payload when the page is
          // missing or never detail-fetched. Pages that already carry detail
          // are left intact until pass 2 replaces them, so comments never
          // vanish mid-sweep.
          if (!hasDetail) {
            try {
              mkdirSync(dirname(filePath), { recursive: true });
              const before = existsSync(filePath);
              // Temp-write then import then rename: a failed refresh must never
              // destroy the previously-good page (codex HIGH, round 3). The
              // import declares the canonical relative path, so the page slug
              // and source_path stay correct despite the temp filename.
              const tmpPath = `${filePath}.tmp`;
              writeFileSync(tmpPath, renderListItemPage(repo, item.kind, item.list), 'utf-8');
              try {
                const imported = await importPage(deps, tmpPath, activePack, relative(cfg.dir, filePath).replace(/\\/g, '/'));
                renameSync(tmpPath, filePath);
                summary.pagesAffected.push(imported.slug);
                summary.chunksCreated += imported.chunks;
                if (!countedSlugs.has(imported.slug)) {
                  if (before) summary.modified++; else summary.added++;
                  countedSlugs.add(imported.slug);
                }
              } finally {
                rmSync(tmpPath, { force: true });
              }
            } catch (err) {
              deps.client.log?.(`[github] item ${repo}#${item.number} list render failed: ${err instanceof Error ? err.message : String(err)}`);
              summary.failedFiles++;
              summary.status = 'partial';
              progress.tick(1, `${repo}#${item.number} failed`);
              continue;
            }
          }
          pendingDetail.push(item);
        }
        // Pass 2 (expensive): comments, reviews, checks, exact merge state.
        // Runs in the same sweep so the final page is complete; an item that
        // fails here keeps its pass-1 (or previous) page and the cursor does
        // not advance past it, so the next sweep retries just that item.
        const stopDetailHb = startHeartbeat(progress, `fetching item detail for ${repo}`);
        try {
          for (const item of pendingDetail) {
            if (opts.signal?.aborted) {
              summary.status = 'partial';
              break;
            }
            const filePath = itemPagePath(cfg.dir, repo, item.number);
            summary.itemDetailFetches++;
            try {
              const data = await fetchItemData(repo, item.number, item.kind, client, { signal: opts.signal });
              mkdirSync(dirname(filePath), { recursive: true });
              const before = existsSync(filePath);
              const tmpPath = `${filePath}.tmp`;
              writeFileSync(tmpPath, renderItemPage(data), 'utf-8');
              try {
                const imported = await importPage(deps, tmpPath, activePack, relative(cfg.dir, filePath).replace(/\\/g, '/'));
                renameSync(tmpPath, filePath);
                summary.pagesAffected.push(imported.slug);
                summary.chunksCreated += imported.chunks;
                if (!countedSlugs.has(imported.slug)) {
                  if (before) summary.modified++; else summary.added++;
                  countedSlugs.add(imported.slug);
                }
              } finally {
                rmSync(tmpPath, { force: true });
              }
            } catch (err) {
              deps.client.log?.(`[github] item ${repo}#${item.number} failed: ${err instanceof Error ? err.message : String(err)}`);
              summary.failedFiles++;
              summary.status = 'partial';
              progress.tick(1, `${repo}#${item.number} failed`);
              continue;
            }
            progress.tick(1, `${repo}#${item.number}`);
            // Cursor advances only for items that fully succeeded.
            if (item.updated_at > maxUpdatedAt) maxUpdatedAt = item.updated_at;
          }
        } finally {
          stopDetailHb();
        }
        // Repo card, refreshed once per repo.
        const cardPath = repoCardPath(cfg.dir, repo);
        keepPaths.add(relative(cfg.dir, cardPath).replace(/\\/g, '/'));
        if (opts.full || !existsSync(cardPath)) {
          try {
            const meta = await client.fetchJSON<RawRepo>(`/repos/${repo}`, { signal: opts.signal });
            repoMeta.set(repo, meta);
            mkdirSync(dirname(cardPath), { recursive: true });
            const cardExisted = existsSync(cardPath);
            writeFileSync(cardPath, renderRepoCard(repo, meta), 'utf-8');
            const imported = await importPage(deps, cardPath, activePack);
            if (!summary.pagesAffected.includes(imported.slug)) summary.pagesAffected.push(imported.slug);
            if (cardExisted) summary.modified++; else summary.added++;
          } catch { /* card is best-effort */ }
        } else {
          keepPaths.add(relative(cfg.dir, cardPath).replace(/\\/g, '/'));
        }
        succeededRepos.add(`gh/${repo}`);
      } catch (err) {
        deps.client.log?.(`[github] repo ${repo} failed: ${err instanceof Error ? err.message : String(err)}`);
        summary.failedFiles++;
        summary.status = 'partial';
      }
    }

    // A page can be imported twice in a run (pass 1 list render, then pass 2
    // detail render): dedupe before extract/embed so each page is processed once.
    summary.pagesAffected = [...new Set(summary.pagesAffected)];

    if (opts.full) {
      await deleteStalePages(deps, keepPaths, summary, succeededRepos);
    }

    // Size-gated extract + embed, mirroring performSyncInner's gates.
    await runExtractAndEmbed(deps, summary, activePack);

    // Cursor discipline: the sweep cursor only advances on a fully successful
    // run. On a partial run (item or repo failures) or an aborted signal we
    // keep the previous cursor so the next sweep re-enumerates from the old
    // point; fresh pages are still skipped by content hash, so the only real
    // cost is the retry of whatever failed.
    if (opts.signal?.aborted) summary.status = 'partial';
    // A repo enters state.repos only once a sweep fully succeeded for it (or
    // it was already listed): state-listing an unswept repo would skip its
    // history bootstrap on the next run (previousRepos gates the since filter).
    state.repos = repos.filter((r) => succeededRepos.has(`gh/${r}`) || previousRepos.has(r));
    if (summary.status === 'synced') {
      state.last_sweep_at = maxUpdatedAt || new Date().toISOString();
      writeState(cfg.dir, state);
      await touchSourceRow(deps, maxUpdatedAt || new Date().toISOString());
    } else {
      writeState(cfg.dir, state);
      await touchSourceRow(deps, state.last_sweep_at ?? new Date().toISOString());
    }

    return syncResult(summary, opts);
  } finally {
    progress.finish();
  }
}

async function refreshSingleItem(
  deps: GitHubSyncDeps,
  item: GitHubItemRef,
  activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined,
  summary: GitHubSyncSummary,
): Promise<void> {
  const repo = item.repo.toLowerCase();
  const filePath = itemPagePath(deps.cfg.dir, repo, item.number);
  const slug = `gh/${repo}/${item.number}`;
  if (item.deleted) {
    const rows = await deps.engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [deps.sourceId, slug],
    );
    if (rows.length > 0) {
      await deps.engine.deletePages([slug], { sourceId: deps.sourceId });
      summary.deleted += rows.length;
    }
    rmSync(filePath, { force: true });
    return;
  }
  const data = await fetchItemData(repo, item.number, item.kind, deps.client, { signal: deps.opts.signal });
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, renderItemPage(data), 'utf-8');
  try {
    const imported = await importPage(deps, tmpPath, activePack, relative(deps.cfg.dir, filePath).replace(/\\/g, '/'));
    summary.pagesAffected.push(imported.slug);
    summary.chunksCreated += imported.chunks;
    summary.modified++;
    renameSync(tmpPath, filePath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
  await runExtractAndEmbed(deps, summary, activePack);
}

async function runExtractAndEmbed(
  deps: GitHubSyncDeps,
  summary: GitHubSyncSummary,
  activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined,
): Promise<void> {
  const totalChanges = summary.added + summary.modified;
  const pagesAffected = summary.pagesAffected;
  if (totalChanges === 0 || pagesAffected.length === 0) return;

  if (!deps.opts.noExtract && totalChanges <= 100) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted } = await import('../commands/extract.ts');
      const extractOpts = { sourceId: deps.sourceId };
      await extractLinksForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await extractTimelineForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await stampExtracted(
        deps.engine,
        pagesAffected.map((slug) => ({ slug, source_id: deps.sourceId })),
      );
    } catch { /* extraction is best-effort */ }
  } else if (totalChanges > 100 && !deps.opts.noExtract) {
    process.stderr.write(`[github] large sync (${totalChanges} pages); extraction deferred to 'gbrain extract --stale --source-id ${deps.sourceId}'\n`);
  }

  if (!deps.opts.noEmbed && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { runEmbedCore } = await import('../commands/embed.ts');
      await runEmbedCore(deps.engine, { slugs: pagesAffected, sourceId: deps.sourceId });
      summary.embedded = pagesAffected.length;
    } catch { /* embed is best-effort */ }
  } else if (!deps.opts.noEmbed && totalChanges > 100) {
    // Large sync skips the inline embed; queue a capped backfill job so the
    // mirrored pages don't sit unembedded until someone notices recall is
    // keyword-only. Mirrors performSync's auto-defer chaser.
    // #3697: embed's source filter is `--source` (embed.ts parses no --source-id).
    const drainHint = `run 'gbrain embed --stale --source ${deps.sourceId}' to drain now`;
    try {
      const { submitEmbedBackfill } = await import('./embed-backfill-submit.ts');
      const sub = await submitEmbedBackfill(deps.engine, deps.sourceId, { reason: 'github_sync_defer' });
      if (sub.status === 'submitted') {
        process.stderr.write(`[github] large sync (${totalChanges} pages); embeds deferred to embed-backfill job ${sub.jobId} — or ${drainHint}\n`);
      } else if (sub.status === 'cooldown' || sub.status === 'spend_capped' || sub.status === 'no_worker_surface') {
        process.stderr.write(`[github] large sync (${totalChanges} pages); embed-backfill not queued (${sub.status}) — ${drainHint}\n`);
      } else { sub satisfies never; }
    } catch (err) {
      process.stderr.write(`[github] embed-backfill submission failed: ${err instanceof Error ? err.message : String(err)} — ${drainHint}\n`);
    }
  }
}

async function touchSourceRow(deps: GitHubSyncDeps, newestContentAt: string): Promise<void> {
  try {
    await deps.engine.executeRaw(
      `UPDATE sources SET last_sync_at = now(), newest_content_at = $1::timestamptz WHERE id = $2`,
      [newestContentAt, deps.sourceId],
    );
  } catch { /* best-effort */ }
}

function syncResult(
  summary: GitHubSyncSummary,
  opts: SyncOpts,
): import('../commands/sync.ts').SyncResult {
  const first = summary.added > 0 && summary.modified === 0 && summary.deleted === 0
    && summary.itemDetailFetches === summary.itemsSeen;
  return {
    status: summary.status === 'partial' ? 'partial' : (first ? 'first_sync' : summary.added + summary.modified + summary.deleted > 0 ? 'synced' : 'up_to_date'),
    fromCommit: null,
    toCommit: '',
    added: summary.added,
    modified: summary.modified,
    deleted: summary.deleted,
    renamed: 0,
    chunksCreated: summary.chunksCreated,
    embedded: summary.embedded,
    pagesAffected: summary.pagesAffected,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
  };
}
