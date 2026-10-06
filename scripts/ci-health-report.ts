#!/usr/bin/env bun
/**
 * CI health report (GBRA-47 V-6, ENG-14; green master wave E6).
 *
 *   bun scripts/ci-health-report.ts [--days 7 | --since <date> [--until <date>]] [--responders a,b] [--repo owner/name] [--dry-run]
 *
 * Reads one window of runs of test.yml and e2e.yml through the REST API
 * (runs, jobs, check-run annotations, issues; never logs, fork runs or fork
 * artifacts) and upserts one issue (label `ci-health`): `CI health (week of
 * <since>)` for the weekly `--days` window, `CI health (<since>..<until>)`
 * for an explicit acceptance window. It reports:
 *
 * - first-attempt pass rate of same-repository pull-request runs and of
 *   push-to-master runs, per workflow (`firstAttempt()`: a run that needed a
 *   re-run failed its first attempt; cancelled and skipped runs are excluded;
 *   dispatch and scheduled runs are not read);
 * - the exit criteria (master Test and E2E >= 95%, PR test.yml and e2e.yml
 *   >= 90%), each met, missed or indeterminate. The window is paged in full
 *   (a query over the API's 1000-result search cap is split in halves);
 *   when completeness cannot be established the criterion is indeterminate,
 *   never satisfied. In an explicit window a missed target upserts a
 *   follow-up issue listing the top failing files;
 * - stress-gate failures (`stress-changed-tests`) counted separately, the
 *   failure classification of every failed first attempt (stress gate, test
 *   or check, infrastructure) and the cancellation and completion coverage;
 * - master-red time to first response: from the issue opening to the first
 *   comment by an allowlisted responder (repository owner, member or
 *   collaborator, or a `--responders` login; bots other than those never
 *   count) or the first linked repair PR from any author. The 1-hour target
 *   is measured, not enforced;
 * - the nightly-watch residual (watched-workflow runs on master that still
 *   create a skipped watch run), the test files with the most failure
 *   annotations (failed runs sampled), shard spread with the weights miner
 *   command, serial files added in the window and nightly-watch's status.
 *
 * Exit 0 on any report; 1 when the API cannot be read (the error says why
 * and how to fix it); 2 usage error. Docs: docs/ci-red-runbook.md#ci-health-report
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  commentIssue, createIssue, ensureLabel, findIssueByTitle, inert, jsonBlock, linkedPulls, listLabeled, restClient, updateIssue, type GitHubClient,
} from './lib/gh-issue.ts';

const ROOT = resolve(import.meta.dir, '..');
export const LABEL = 'ci-health';
export const DOCS = 'docs/ci-red-runbook.md#ci-health-report';
export const SPREAD_LIMIT = 1.25;
export const CAPS = { failedRunsSampled: 15, spreadRunsSampled: 10, searchResults: 1000, minSplitMs: 3_600_000 };
export const TARGETS = { master: 0.95, pr: 0.9 };
export const STRESS_JOB = 'stress-changed-tests';
const AGGREGATORS = new Set(['test-status', 'e2e-status']);
const WORKFLOWS = [
  { file: 'test.yml', name: 'Test', shard: /^test \(\d+\)$/, lane: 'unit' },
  { file: 'e2e.yml', name: 'E2E Tests', shard: /^Selected E2E \(diff-relevant\)/, lane: 'e2e' },
] as const;
const WATCHED = ['test.yml', 'e2e.yml', 'heavy-tests.yml', 'scale-tier.yml', 'macos-validation.yml', 'semgrep.yml', 'osv-scanner.yml', 'ci-health.yml'];
const ALLOWLISTED_PUSH = new Set(['test.yml', 'e2e.yml']);
const RESPONDER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface Run {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  head_branch?: string;
  head_repository?: { full_name: string } | null;
  repository?: { full_name: string };
}
export interface Job { id: number; name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; steps?: Array<{ name: string; conclusion: string | null }> }
export interface Annotation { annotation_level: string; path?: string; title?: string | null; message: string }
export interface Window { since: string; until: string }

export interface Coverage { total: number; completed: number; cancelled: number; skipped: number }
export interface Classification { stress_gate: number; test: number; infrastructure: number; unread: number }
export interface Series {
  workflow: string;
  event: 'pull_request' | 'push';
  runs: number;
  fork_runs_excluded: number;
  first_attempt_pass: number;
  first_attempt_rate: number | null;
  complete: boolean;
  coverage: Coverage;
  classification: Classification;
  stress_gate_failures: number;
}
export interface WorkflowHealth extends Series {
  spread: { runs: number; mean_ratio: number | null; worst_ratio: number | null };
  miner: string | null;
}
export interface Criterion { name: string; target: number; rate: number | null; runs: number; verdict: 'met' | 'missed' | 'indeterminate'; why?: string }
export interface Response { issue: number; title: string; opened: string; first_response: string | null; via: 'comment' | 'pull_request' | null; hours: number | null }
export interface HealthData {
  since: string;
  until: string;
  workflows: WorkflowHealth[];
  master: Series[];
  criteria: Criterion[];
  master_red: { issues: Response[]; median_hours: number | null; within_hour: number; complete: boolean };
  watch_residual: { skipped_watch_runs: number | null; master_runs_outside_allowlist: number | null };
  failing_files: Array<{ file: string; count: number; sample: string }>;
  serial_added: string[] | null;
  serial_total: number;
  nightly_watch: string;
  truncated: string[];
}

export function sameRepo(run: Run): boolean {
  return !run.head_repository || !run.repository || run.head_repository.full_name === run.repository.full_name;
}

export function firstAttempt(runs: Run[]): { runs: number; pass: number; rate: number | null } {
  const done = runs.filter(r => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  const pass = done.filter(r => r.conclusion === 'success' && r.run_attempt === 1).length;
  return { runs: done.length, pass, rate: done.length ? pass / done.length : null };
}

export function coverage(runs: Run[]): Coverage {
  return {
    total: runs.length,
    completed: runs.filter(r => r.status === 'completed').length,
    cancelled: runs.filter(r => r.conclusion === 'cancelled').length,
    skipped: runs.filter(r => r.conclusion === 'skipped').length,
  };
}

/** One failed first attempt: the stress gate alone, an infrastructure failure (timeouts, startup, setup steps), or a test or check. */
export function classify(jobs: Job[]): keyof Omit<Classification, 'unread'> {
  const failing = jobs.filter(j => (j.conclusion === 'failure' || j.conclusion === 'timed_out' || j.conclusion === 'startup_failure') && !AGGREGATORS.has(j.name));
  if (failing.length && failing.every(j => j.name === STRESS_JOB)) return 'stress_gate';
  const setup = /^(set up job|initialize containers|.*(install|checkout|setup-bun|cache|download|docker|service).*)$/i;
  if (failing.some(j => j.conclusion !== 'failure' || (j.steps ?? []).some(s => s.conclusion === 'failure' && setup.test(s.name)))) return 'infrastructure';
  return 'test';
}

/** Slowest shard / mean shard duration for one run's shard jobs; null under two timed shards. */
export function shardRatio(jobs: Job[], shard: RegExp): number | null {
  const secs = jobs.filter(j => shard.test(j.name) && j.started_at && j.completed_at)
    .map(j => (Date.parse(j.completed_at!) - Date.parse(j.started_at!)) / 1000).filter(s => s > 0);
  if (secs.length < 2) return null;
  const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
  return Math.max(...secs) / mean;
}

export function topFailingFiles(annotations: Annotation[], limit = 10): HealthData['failing_files'] {
  const counts = new Map<string, { count: number; sample: string }>();
  for (const a of annotations) {
    if (a.annotation_level !== 'failure' || !a.path || !/\.test\.ts$/.test(a.path)) continue;
    const entry = counts.get(a.path) ?? { count: 0, sample: inert(a.title || a.message, 160) };
    entry.count++;
    counts.set(a.path, entry);
  }
  return [...counts].map(([file, v]) => ({ file: inert(file, 160), ...v })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)).slice(0, limit);
}

export function serialFiles(dir = join(ROOT, 'test')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...serialFiles(path));
    else if (name.endsWith('.serial.test.ts')) out.push(relative(ROOT, path));
  }
  return out.sort();
}

/** Serial test files added since the date, or null when the clone is shallow (history unknown). */
export function serialAddedSince(since: string, until?: string): string[] | null {
  const shallow = Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], { cwd: ROOT, stdout: 'pipe' }).stdout.toString().trim();
  if (shallow !== 'false') return null;
  const r = Bun.spawnSync(['git', 'log', `--since=${since}`, ...(until ? [`--until=${until}`] : []), '--diff-filter=A', '--name-only', '--format=', '--', '*.serial.test.ts'], { cwd: ROOT, stdout: 'pipe' });
  return [...new Set(r.stdout.toString().split('\n').filter(Boolean))].sort();
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const createdRange = (w: { from: number; to: number }) => encodeURIComponent(`${iso(w.from)}..${iso(w.to)}`);

/**
 * Every run of one workflow and event created in the window. The search API
 * returns at most 1000 results per query, so a window over the cap is split
 * in halves; `complete` is false when a slice still exceeds the cap at the
 * smallest split or the pages do not add up to the reported total.
 */
export async function listRuns(client: GitHubClient, file: string, query: string, from: number, to: number): Promise<{ runs: Run[]; complete: boolean }> {
  const base = `repos/{repo}/actions/workflows/${file}/runs?${query}&created=${createdRange({ from, to })}&per_page=100`;
  const first = await client.request<{ workflow_runs: Run[]; total_count: number }>('GET', `${base}&page=1`);
  if (first.total_count > CAPS.searchResults) {
    if (to - from <= CAPS.minSplitMs) return { runs: first.workflow_runs, complete: false };
    const mid = from + Math.floor((to - from) / 2);
    const [a, b] = [await listRuns(client, file, query, from, mid), await listRuns(client, file, query, mid + 1000, to)];
    return { runs: [...a.runs, ...b.runs], complete: a.complete && b.complete };
  }
  const runs = [...first.workflow_runs];
  for (let page = 2; runs.length < first.total_count && page <= CAPS.searchResults / 100; page++) {
    const r = await client.request<{ workflow_runs: Run[] }>('GET', `${base}&page=${page}`);
    if (!r.workflow_runs.length) break;
    runs.push(...r.workflow_runs);
  }
  const unique = [...new Map(runs.map(r => [r.id, r])).values()];
  return { runs: unique, complete: unique.length >= first.total_count };
}

export function criterion(name: string, target: number, s: Pick<Series, 'first_attempt_rate' | 'runs' | 'complete'>): Criterion {
  if (!s.complete) return { name, target, rate: s.first_attempt_rate, runs: s.runs, verdict: 'indeterminate', why: 'the window could not be read in full' };
  if (s.first_attempt_rate === null) return { name, target, rate: null, runs: 0, verdict: 'indeterminate', why: 'no completed runs in the window' };
  return { name, target, rate: s.first_attempt_rate, runs: s.runs, verdict: s.first_attempt_rate >= target ? 'met' : 'missed' };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Time from a master-red issue opening to its first response: an allowlisted comment or the first linked PR from anyone. */
export async function responseTimes(client: GitHubClient, window: Window, responders: string[]): Promise<HealthData['master_red']> {
  const from = Date.parse(window.since);
  const to = Date.parse(window.until);
  let complete = true;
  const issues = (await listLabeled(client, 'master-red', 'all', 10)).filter(i => {
    const at = Date.parse(i.created_at ?? '');
    return at >= from && at <= to;
  });
  const out: Response[] = [];
  for (const issue of issues) {
    const opened = issue.created_at!;
    let first: { at: string; via: Response['via'] } | null = null;
    try {
      const comments = await client.request<Array<{ created_at: string; user?: { login: string; type?: string }; author_association?: string }>>('GET', `repos/{repo}/issues/${issue.number}/comments?per_page=100`);
      const c = comments.find(x => responders.includes(x.user?.login ?? '') || (RESPONDER_ASSOCIATIONS.has(x.author_association ?? '') && x.user?.type !== 'Bot'));
      if (c) first = { at: c.created_at, via: 'comment' };
      const pr = (await linkedPulls(client, issue.number)).filter(p => p.linked_at).sort((a, b) => a.linked_at.localeCompare(b.linked_at))[0];
      if (pr && (!first || pr.linked_at < first.at)) first = { at: pr.linked_at, via: 'pull_request' };
    } catch {
      complete = false;
    }
    out.push({ issue: issue.number, title: inert(issue.title, 100), opened, first_response: first?.at ?? null, via: first?.via ?? null, hours: first ? (Date.parse(first.at) - Date.parse(opened)) / 3_600_000 : null });
  }
  const hours = out.map(r => r.hours).filter((h): h is number => h !== null);
  return { issues: out, median_hours: median(hours), within_hour: hours.filter(h => h <= 1).length, complete };
}

const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
const ratio = (n: number | null) => (n === null ? 'n/a' : n.toFixed(2));
const hrs = (n: number | null) => (n === null ? 'n/a' : `${n.toFixed(1)} h`);

export function renderHealth(data: HealthData): string {
  const steps: string[] = [];
  for (const f of data.failing_files.slice(0, 3)) steps.push(`Fix the flake or regression in \`${f.file}\` (${f.count} failure annotations in the window); reproduce with \`bun run test:stress ${f.file} --iterations 10\`.`);
  for (const w of data.workflows) {
    if (w.miner && (w.spread.mean_ratio ?? 0) > SPREAD_LIMIT) steps.push(`Shards in ${w.workflow} are unbalanced (mean slowest/mean ${ratio(w.spread.mean_ratio)} > ${SPREAD_LIMIT}): \`${w.miner}\`, then commit the weights.`);
  }
  for (const c of data.criteria.filter(x => x.verdict === 'missed')) steps.push(`Exit criterion missed: ${c.name} at ${pct(c.rate)} (target ${pct(c.target)}). Record it on this issue and fix the top failing files above; a missed acceptance window gets a follow-up issue. Docs: ${DOCS}`);
  for (const c of data.criteria.filter(x => x.verdict === 'indeterminate')) steps.push(`Exit criterion indeterminate: ${c.name} (${c.why}). It is not satisfied; re-run the report (\`gh workflow run ci-health.yml -f since=${data.since} -f until=${data.until} -f dry_run=false\`) once the API reads in full.`);
  const slow = data.master_red.issues.filter(r => r.hours === null || r.hours > 1);
  if (slow.length) steps.push(`${slow.length} master-red issue(s) got no first response within 1 hour (${slow.map(r => `#${r.issue}`).join(', ')}): the agent on release duty answers with a comment or a linked repair PR. Docs: docs/RELEASING.md#master-red-issues`);
  if (data.serial_added?.length) steps.push(`Review the ${data.serial_added.length} new serial file(s) below: each needs a reason it cannot run in parallel (\`bash scripts/check-test-isolation.sh <file>\`).`);
  if (data.nightly_watch !== 'success') steps.push(`nightly-watch's latest run is \`${inert(data.nightly_watch, 40)}\`: read it with \`gh run list --workflow nightly-watch.yml --limit 3\` before trusting nightly issues.`);
  const seriesRow = (s: Series) => `| ${s.workflow} | ${s.event === 'push' ? 'push to master' : 'pull request'} | ${s.runs} | ${s.first_attempt_pass} (${pct(s.first_attempt_rate)})${s.complete ? '' : ' (incomplete)'} | ${s.stress_gate_failures} | ${s.classification.stress_gate} / ${s.classification.test} / ${s.classification.infrastructure}${s.classification.unread ? ` (+${s.classification.unread} unread)` : ''} | ${s.coverage.cancelled} of ${s.coverage.total} cancelled; ${s.coverage.completed} of ${s.coverage.total} completed |`;
  const lines = [
    `Runs created ${data.since} .. ${data.until} (same-repository pull-request runs and push-to-master runs; dispatch and scheduled runs are not counted).`,
    '',
    '| workflow | event | completed runs | first-attempt pass | stress-gate failures | failure classes (stress / test / infra) | coverage |',
    '|---|---|---|---|---|---|---|',
    ...data.workflows.map(seriesRow),
    ...data.master.map(seriesRow),
    '',
    '**Exit criteria** (indeterminate is never satisfied):',
    ...data.criteria.map(c => `- ${c.name}: ${pct(c.rate)} over ${c.runs} runs, target ${pct(c.target)} — **${c.verdict}**${c.why ? ` (${c.why})` : ''}`),
    '',
    `**Master-red first response** (target 1 hour, measured not enforced): ${data.master_red.issues.length} issue(s); median ${hrs(data.master_red.median_hours)}; ${data.master_red.within_hour} within 1 hour${data.master_red.complete ? '' : '; some issues could not be read (incomplete)'}.`,
    ...data.master_red.issues.map(r => `- #${r.issue} opened ${r.opened}: ${r.first_response ? `${r.via === 'pull_request' ? 'linked PR' : 'comment'} after ${hrs(r.hours)}` : 'no response yet'}`),
    '',
    `**Shard spread:** ${data.workflows.map(w => `${w.workflow} ${ratio(w.spread.mean_ratio)} / ${ratio(w.spread.worst_ratio)} (mean / worst slowest-to-mean over ${w.spread.runs} runs); fork runs not read: ${w.fork_runs_excluded}`).join('; ')}.`,
    `**Nightly-watch residual:** ${data.watch_residual.skipped_watch_runs ?? 'n/a'} skipped watch runs; ${data.watch_residual.master_runs_outside_allowlist ?? 'n/a'} watched-workflow runs on master outside the schedule and push allowlist (each creates a skipped watch run; no trigger-level event filter exists).`,
    '',
    '**Most failure annotations by test file** (failed runs sampled):',
    ...(data.failing_files.length ? data.failing_files.map(f => `- \`${f.file}\`: ${f.count} (e.g. \`${f.sample}\`)`) : ['- none']),
    '',
    `**Serial files:** ${data.serial_total} total; added in the window: ${data.serial_added === null ? 'unknown (shallow clone; the workflow checks out full history)'
      : data.serial_added.length ? `${data.serial_added.slice(0, 20).map(f => `\`${inert(f)}\``).join(', ')}${data.serial_added.length > 20 ? ` and ${data.serial_added.length - 20} more` : ''}` : 'none'}.`,
    `**nightly-watch latest run:** ${inert(data.nightly_watch, 40)}.`,
    ...(data.truncated.length ? ['', `**Truncated:** ${data.truncated.join('; ')}.`] : []),
    '',
    '### Next step for the agent',
    '',
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ['Nothing to do this week.']),
    '',
    `Docs: ${DOCS}`,
    '',
    jsonBlock('ci-health:json', data),
    '',
  ];
  return lines.join('\n');
}

async function jobsOf(client: GitHubClient, run: Run, attempt: number): Promise<Job[]> {
  return client.request<{ jobs: Job[] }>('GET', `repos/{repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`).then(r => r.jobs);
}

async function series(client: GitHubClient, wf: typeof WORKFLOWS[number], event: Series['event'], window: Window, truncated: string[]): Promise<{ s: Series; mine: Run[]; failed: Run[]; jobs: Map<number, Job[]> }> {
  const query = event === 'push' ? 'event=push&branch=master' : 'event=pull_request';
  const listed = await listRuns(client, wf.file, query, Date.parse(window.since), Date.parse(window.until));
  if (!listed.complete) truncated.push(`${wf.file} ${event}: the window could not be read in full (search cap), so its rate is indeterminate`);
  const mine = listed.runs.filter(r => sameRepo(r) && r.event === event && (event !== 'push' || !r.head_branch || r.head_branch === 'master'));
  const fa = firstAttempt(mine);
  const failed = mine.filter(r => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped' && (r.conclusion !== 'success' || r.run_attempt > 1));
  const classification: Classification = { stress_gate: 0, test: 0, infrastructure: 0, unread: 0 };
  let stress = 0;
  const jobs = new Map<number, Job[]>();
  for (const run of failed) {
    try {
      const js = await jobsOf(client, run, 1);
      jobs.set(run.id, js);
      classification[classify(js)]++;
      if (js.some(j => j.name === STRESS_JOB && j.conclusion === 'failure')) stress++;
    } catch {
      classification.unread++;
    }
  }
  if (classification.unread) truncated.push(`${wf.file} ${event}: jobs of ${classification.unread} failed run(s) could not be read`);
  return {
    s: { workflow: wf.file, event, runs: fa.runs, fork_runs_excluded: listed.runs.length - listed.runs.filter(sameRepo).length, first_attempt_pass: fa.pass, first_attempt_rate: fa.rate, complete: listed.complete, coverage: coverage(mine), classification, stress_gate_failures: stress },
    mine, failed, jobs,
  };
}

async function watchResidual(client: GitHubClient, window: Window): Promise<HealthData['watch_residual']> {
  const range = createdRange({ from: Date.parse(window.since), to: Date.parse(window.until) });
  const count = (path: string) => client.request<{ total_count: number }>('GET', path).then(r => r.total_count);
  try {
    let outside = 0;
    for (const file of WATCHED) {
      for (const event of ['push', 'workflow_dispatch']) {
        if (event === 'push' && ALLOWLISTED_PUSH.has(file)) continue;
        outside += await count(`repos/{repo}/actions/workflows/${file}/runs?event=${event}&branch=master&created=${range}&per_page=1`);
      }
    }
    const skipped = await count(`repos/{repo}/actions/workflows/nightly-watch.yml/runs?status=skipped&created=${range}&per_page=1`);
    return { skipped_watch_runs: skipped, master_runs_outside_allowlist: outside };
  } catch {
    return { skipped_watch_runs: null, master_runs_outside_allowlist: null };
  }
}

export async function collectHealth(client: GitHubClient, window: Window, opts: { responders?: string[] } = {}): Promise<HealthData> {
  const truncated: string[] = [];
  const workflows: WorkflowHealth[] = [];
  const master: Series[] = [];
  const annotations: Annotation[] = [];
  for (const wf of WORKFLOWS) {
    const pr = await series(client, wf, 'pull_request', window, truncated);
    const push = await series(client, wf, 'push', window, truncated);
    master.push(push.s);
    const failed = [...pr.failed, ...push.failed];
    if (failed.length > CAPS.failedRunsSampled) truncated.push(`${wf.file}: annotations from ${CAPS.failedRunsSampled} of ${failed.length} failed runs`);
    for (const run of failed.slice(0, CAPS.failedRunsSampled)) {
      const jobs = pr.jobs.get(run.id) ?? push.jobs.get(run.id) ?? [];
      for (const job of jobs.filter(j => j.conclusion === 'failure').slice(0, 3)) {
        annotations.push(...await client.request<Annotation[]>('GET', `repos/{repo}/check-runs/${job.id}/annotations?per_page=50`).catch(() => []));
      }
    }
    const ratios: number[] = [];
    for (const run of pr.mine.filter(r => r.conclusion === 'success').slice(0, CAPS.spreadRunsSampled)) {
      const r = shardRatio(await jobsOf(client, run, run.run_attempt), wf.shard);
      if (r !== null) ratios.push(r);
    }
    const greenId = push.mine.find(r => r.conclusion === 'success')?.id
      ?? (await client.request<{ workflow_runs: Array<{ id: number }> }>('GET', `repos/{repo}/actions/workflows/${wf.file}/runs?event=push&status=success&per_page=1`).catch(() => ({ workflow_runs: [] }))).workflow_runs[0]?.id;
    workflows.push({
      ...pr.s,
      spread: { runs: ratios.length, mean_ratio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null, worst_ratio: ratios.length ? Math.max(...ratios) : null },
      miner: greenId ? `bun run weights:mine --lane ${wf.lane} --run ${greenId}` : null,
    });
  }
  const criteria = [
    criterion('master Test push runs', TARGETS.master, master[0]!),
    criterion('master E2E Tests push runs', TARGETS.master, master[1]!),
    criterion('PR test.yml first attempt', TARGETS.pr, workflows[0]!),
    criterion('PR e2e.yml first attempt', TARGETS.pr, workflows[1]!),
  ];
  const watch = await client.request<{ workflow_runs: Array<{ conclusion: string | null; status: string }> }>('GET', 'repos/{repo}/actions/workflows/nightly-watch.yml/runs?per_page=1')
    .catch(() => ({ workflow_runs: [] }));
  const latest = watch.workflow_runs[0];
  return {
    since: window.since,
    until: window.until,
    workflows,
    master,
    criteria,
    master_red: await responseTimes(client, window, opts.responders ?? []),
    watch_residual: await watchResidual(client, window),
    failing_files: topFailingFiles(annotations),
    serial_added: serialAddedSince(window.since, window.until),
    serial_total: serialFiles().length,
    nightly_watch: latest ? (latest.conclusion ?? latest.status) : 'no runs yet',
    truncated,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z)?$/;

/** The report window from --days or --since/--until; an error string says what to pass instead. */
export function parseWindow(args: { days?: string; since?: string; until?: string }, now = Date.now()): { window: Window; explicit: boolean } | { error: string } {
  if (args.since !== undefined || args.until !== undefined) {
    if (!args.since || !DATE.test(args.since) || (args.until && !DATE.test(args.until))) return { error: '--since and --until take YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (UTC)' };
    const since = new Date(Date.parse(args.since.length === 10 ? `${args.since}T00:00:00Z` : args.since)).toISOString();
    const until = args.until ? new Date(Date.parse(args.until.length === 10 ? `${args.until}T23:59:59Z` : args.until)).toISOString() : new Date(now).toISOString();
    if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until)) || Date.parse(since) >= Date.parse(until)) return { error: '--since must be a valid date before --until' };
    return { window: { since, until }, explicit: true };
  }
  const days = Number(args.days ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 31) return { error: '--days takes 1-31' };
  return { window: { since: new Date(now - days * 86_400_000).toISOString(), until: new Date(now).toISOString() }, explicit: false };
}

if (import.meta.main) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const repo = flag('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'garrytan/gbrain';
  const dryRun = process.argv.includes('--dry-run');
  const parsed = parseWindow({ days: flag('--days'), since: flag('--since') || undefined, until: flag('--until') || undefined });
  if ('error' in parsed) {
    console.log(`Usage: bun scripts/ci-health-report.ts [--days 1-31 | --since <date> [--until <date>]] [--responders login,login] [--repo owner/name] [--dry-run]\nWhy: ${parsed.error}. Docs: ${DOCS}`);
    process.exit(2);
  }
  const { window, explicit } = parsed;
  const responders = (flag('--responders') ?? process.env.CI_HEALTH_RESPONDERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const client = restClient(repo);
    const data = await collectHealth(client, window, { responders });
    const body = renderHealth(data);
    const title = explicit ? `CI health (${window.since.slice(0, 10)}..${window.until.slice(0, 10)})` : `CI health (week of ${window.since.slice(0, 10)})`;
    const missed = data.criteria.filter(c => c.verdict === 'missed');
    if (dryRun) {
      console.log(`--- title: ${title}\n--- body:\n${body}`);
      process.exit(0);
    }
    await ensureLabel(client, LABEL, '0e8a16', 'CI health report (scripts/ci-health-report.ts)');
    const existing = await findIssueByTitle(client, LABEL, title);
    let number: number;
    if (existing) {
      await updateIssue(client, existing.number, { body, state: 'open' });
      await commentIssue(client, existing.number, 'Report refreshed.');
      number = existing.number;
      console.log(`[ci-health] updated #${existing.number}`);
    } else {
      number = (await createIssue(client, title, body, [LABEL])).number;
      console.log(`[ci-health] opened #${number}`);
    }
    if (explicit && missed.length) {
      const followTitle = `CI health targets missed (${window.since.slice(0, 10)}..${window.until.slice(0, 10)})`;
      const followBody = [
        `The acceptance window in #${number} missed ${missed.length} exit criterion(s): ${missed.map(c => `${c.name} ${pct(c.rate)} (target ${pct(c.target)})`).join('; ')}.`,
        '', 'Top failing files (root-cause each; never widen a timeout or weaken an assertion):',
        ...(data.failing_files.length ? data.failing_files.map(f => `- \`${f.file}\` (${f.count}): \`bun run test:stress ${f.file} --iterations 10\``) : ['- none annotated; read the failed runs in the report']),
        '', `Owner: the agent on release duty. Docs: ${DOCS}`,
      ].join('\n');
      const follow = await findIssueByTitle(client, LABEL, followTitle);
      if (follow) await updateIssue(client, follow.number, { body: followBody, state: 'open' });
      else console.log(`[ci-health] opened follow-up #${(await createIssue(client, followTitle, followBody, [LABEL])).number}`);
    }
  } catch (e) {
    console.log(`[ci-health] FAIL: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`[ci-health] Fix: check the token scopes (actions:read, checks:read, issues:write) and rerun: bun scripts/ci-health-report.ts --dry-run. Docs: ${DOCS}`);
    process.exit(1);
  }
}
