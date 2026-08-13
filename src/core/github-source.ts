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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { BrainEngine } from './engine.ts';
import type { SyncOpts } from '../commands/sync.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitHubSourceConfig {
  /** Env var holding the token (default GH_TOKEN). */
  tokenEnv: string;
  /** GitHub handle for involvement queries and auto-scope (default: none). */
  handle: string;
  /** 'auto' = owner + collaborator + org-member repos; 'repos' = explicit list. */
  scope: 'auto' | 'repos';
  /** owner/name list, only when scope === 'repos'. */
  repos: string[];
  /** Managed dir where pages are materialized. */
  dir: string;
  /** Involvement: also sync items where the handle is author/assignee/commenter/mentioned/reviewer. */
  includeInvolvement: boolean;
}

export interface GitHubItemRef {
  repo: string; // owner/name
  number: number;
  kind: 'issue' | 'pr';
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

export function parseGitHubSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): GitHubSourceConfig {
  const tokenEnv =
    typeof config.gh_token_env === 'string' && config.gh_token_env.length > 0
      ? config.gh_token_env
      : 'GH_TOKEN';
  const handle = typeof config.gh_handle === 'string' ? config.gh_handle : '';
  const scope = config.gh_scope === 'repos' ? 'repos' : 'auto';
  const repos =
    typeof config.gh_repos === 'string'
      ? config.gh_repos
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s))
      : [];
  const dir =
    typeof config.gh_dir === 'string' && config.gh_dir.length > 0
      ? config.gh_dir
      : fallbackDir;
  const includeInvolvement = config.gh_involvement !== false;
  return { tokenEnv, handle, scope, repos, dir, includeInvolvement };
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
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
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

export class GitHubClient {
  constructor(
    private readonly token: string,
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
    const retries = opts.retries ?? 1;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitForBucket(opts.signal);
      const res = await this.fetchImpl(this.apiUrl(path), {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: opts.signal,
      });
      this.trackRate(res);
      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter !== null ? Number(retryAfter) * 1000 : this.rate.resetAt !== null
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
        throw new Error(`GitHub API HTTP ${res.status} on ${path}`);
      }
      if (!res.ok) {
        throw new Error(`GitHub API HTTP ${res.status} on ${path}`);
      }
      return (await res.json()) as T;
    }
    throw new Error(`GitHub API unreachable on ${path}`);
  }

  /** GET all pages of a paginated list, concatenated. */
  async fetchAllPages<T>(
    path: string,
    opts: { signal?: AbortSignal; perPage?: number } = {},
  ): Promise<T[]> {
    const perPage = opts.perPage ?? 100;
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await this.fetchJSON<T[]>(`${path}${sep}per_page=${perPage}&page=${page}`, opts);
      out.push(...batch);
      if (batch.length < perPage) break;
      page++;
      if (page > 100) break; // safety valve
    }
    return out;
  }
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
 * Expand the source's scope to the concrete owner/name list.
 * auto = affiliation owner,collaborator,organization_member (paginated).
 */
export async function resolveScopeRepos(
  cfg: GitHubSourceConfig,
  client: GitHubClient,
  signal?: AbortSignal,
): Promise<string[]> {
  if (cfg.scope === 'repos') {
    return [...cfg.repos];
  }
  const repos = await client.fetchAllPages<RawRepo>(
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name',
    { signal },
  );
  const names = repos.map((r) => r.full_name).sort();
  // Persist the discovered list so webhook repo matching and status display
  // work without an API call.
  mkdirSync(cfg.dir, { recursive: true });
  const state = readState(cfg.dir);
  state.repos = names;
  writeState(cfg.dir, state);
  return names;
}

// ── Item enumeration ─────────────────────────────────────────────────────────

interface RawIssueListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  updated_at: string;
  pull_request?: { url: string };
}

interface RawPullListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  updated_at: string;
  head: { sha: string };
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
  const prNumbers = all.filter((i) => i.pull_request).map((i) => i.number);
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
      prs.push({ number: n, title: '', state: 'closed', updated_at: '', head: { sha: '' } });
    }
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

interface RawStatus {
  state: string;
  statuses: { context: string; state: string }[];
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
      client.fetchJSON<RawCheckRuns>(`/repos/${repo}/commits/${headSha}/check-runs`, opts),
      client.fetchJSON<RawStatus>(`/repos/${repo}/commits/${headSha}/status`, opts),
    ]);
    let pass = 0;
    let fail = 0;
    let pending = 0;
    const failing: string[] = [];
    for (const run of runs.check_runs) {
      if (run.status !== 'completed') {
        pending++;
      } else if (run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped') {
        pass++;
      } else {
        fail++;
        failing.push(run.name);
      }
    }
    for (const s of status.statuses) {
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
  return join(dir, 'gh', repo, `${number}.md`);
}

export function repoCardPath(dir: string, repo: string): string {
  return join(dir, 'gh', repo, 'index.md');
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

export function renderItemPage(data: GitHubItemData): string {
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
  body.push(d.body ? linkifyMentions(d.body, data.repo) : '_no description_', '');

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
      if (r.body) body.push(r.body, '');
    }
  }

  if (data.reviewComments.length > 0) {
    body.push('## Review comments', '');
    for (const rc of data.reviewComments) {
      const loc = rc.path + (rc.line ? `:${rc.line}` : '');
      body.push(`### ${rc.user?.login ?? 'ghost'} · ${loc} · ${rc.created_at}`, '');
      body.push(rc.body, '');
    }
  }

  return frontmatter.join('\n') + '\n' + body.join('\n') + '\n';
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
): Promise<{ slug: string; chunks: number; status: 'imported' | 'skipped' }> {
  const { importFile } = await import('./import-file.ts');
  const rel = relative(deps.cfg.dir, filePath).replace(/\\/g, '/');
  const result = await importFile(deps.engine, filePath, rel, {
    noEmbed: true, // embeddings handled by the size gate below, like sync
    sourceId: deps.sourceId,
    activePack,
  });
  return { slug: result.slug, chunks: result.chunks, status: result.status === 'imported' ? 'imported' : 'skipped' };
}

async function deleteStalePages(
  deps: GitHubSyncDeps,
  keepPaths: Set<string>,
  summary: GitHubSyncSummary,
): Promise<void> {
  const { planReconcileDeletes } = await import('../commands/sync.ts');
  const rows = await deps.engine.executeRaw<{ slug: string; source_path: string | null }>(
    `SELECT slug, source_path FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
    [deps.sourceId],
  );
  const plan = planReconcileDeletes(
    rows,
    keepPaths,
    (p) => p.startsWith('gh/') && p.endsWith('.md'),
  );
  if (plan.staleSlugs.length === 0) return;
  if (plan.massDelete) {
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
  const token = process.env[cfg.tokenEnv] ?? process.env.GH_TOKEN ?? '';
  if (!token) {
    throw new Error(
      `GitHub source "${sourceId}" has no token. Set ${cfg.tokenEnv} (or GH_TOKEN) in the environment.`,
    );
  }
  const client = new GitHubClient(token, fetchImpl);
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

  const repos = await resolveScopeRepos(cfg, client, opts.signal);

  if (opts.githubItem) {
    // Scope guard: only refresh items in the resolved scope. Webhooks for
    // out-of-scope repos are acknowledged upstream but never materialized.
    if (!repos.includes(opts.githubItem.repo)) {
      return syncResult({ ...summary, status: 'up_to_date' }, opts);
    }
    await refreshSingleItem(deps, opts.githubItem, activePack, summary);
    await touchSourceRow(deps, new Date().toISOString());
    return syncResult(summary, opts);
  }

  const state = readState(cfg.dir);
  const since = opts.full ? undefined : state.last_sweep_at ?? undefined;
  const keepPaths = new Set<string>();
  let maxUpdatedAt = state.last_sweep_at ?? '';
  const repoMeta = new Map<string, RawRepo>();

  for (const repo of repos) {
    if (opts.signal?.aborted) break;
    try {
      const { issues, prs } = await enumerateRepoItems(repo, client, { since, signal: opts.signal });
      const all = [
        ...issues.map((i) => ({ repo, number: i.number, kind: 'issue' as const, updated_at: i.updated_at })),
        ...prs.map((p) => ({ repo, number: p.number, kind: 'pr' as const, updated_at: p.updated_at })),
      ];
      for (const item of all) {
        if (item.updated_at > maxUpdatedAt) maxUpdatedAt = item.updated_at;
        const filePath = itemPagePath(cfg.dir, repo, item.number);
        keepPaths.add(relative(cfg.dir, filePath).replace(/\\/g, '/'));
        summary.itemsSeen++;
        if (!opts.full && isPageFresh(filePath, item.updated_at)) continue;
        summary.itemDetailFetches++;
        const data = await fetchItemData(repo, item.number, item.kind, client, { signal: opts.signal });
        mkdirSync(dirname(filePath), { recursive: true });
        const before = existsSync(filePath);
        writeFileSync(filePath, renderItemPage(data), 'utf-8');
        const imported = await importPage(deps, filePath, activePack);
        summary.pagesAffected.push(imported.slug);
        summary.chunksCreated += imported.chunks;
        if (before) summary.modified++; else summary.added++;
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
    } catch (err) {
      deps.client.log?.(`[github] repo ${repo} failed: ${err instanceof Error ? err.message : String(err)}`);
      summary.failedFiles++;
      summary.status = 'partial';
    }
  }

  if (opts.full) {
    await deleteStalePages(deps, keepPaths, summary);
  }

  // Size-gated extract + embed, mirroring performSyncInner's gates.
  await runExtractAndEmbed(deps, summary, activePack);

  state.last_sweep_at = maxUpdatedAt || new Date().toISOString();
  state.repos = repos;
  writeState(cfg.dir, state);
  await touchSourceRow(deps, maxUpdatedAt || new Date().toISOString());

  return syncResult(summary, opts);
}

async function refreshSingleItem(
  deps: GitHubSyncDeps,
  item: GitHubItemRef,
  activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined,
  summary: GitHubSyncSummary,
): Promise<void> {
  const data = await fetchItemData(item.repo, item.number, item.kind, deps.client, { signal: deps.opts.signal });
  const filePath = itemPagePath(deps.cfg.dir, item.repo, item.number);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderItemPage(data), 'utf-8');
  const imported = await importPage(deps, filePath, activePack);
  summary.pagesAffected.push(imported.slug);
  summary.chunksCreated += imported.chunks;
  summary.modified++;
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
    deps.client.log?.(`[github] large sync (${totalChanges} files); extraction deferred to 'gbrain extract --stale --source-id ${deps.sourceId}'`);
  }

  if (!deps.opts.noEmbed && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { runEmbedCore } = await import('../commands/embed.ts');
      await runEmbedCore(deps.engine, { slugs: pagesAffected, sourceId: deps.sourceId });
      summary.embedded = pagesAffected.length;
    } catch { /* embed is best-effort */ }
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
