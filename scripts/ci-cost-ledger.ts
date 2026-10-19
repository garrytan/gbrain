#!/usr/bin/env bun
/**
 * scripts/ci-cost-ledger.ts — what GitHub Actions spends on Ubicloud runners,
 * by workflow, event and conclusion, and whether the median cost of a green
 * Test or E2E run rose against the committed baseline.
 *
 *   bun scripts/ci-cost-ledger.ts                       # last 7 days, exit 1 on a regression
 *   bun scripts/ci-cost-ledger.ts --report-only --step-summary   # ci-health.yml's weekly step
 *   bun scripts/ci-cost-ledger.ts --write-baseline      # refresh scripts/ci-cost-baseline.json
 *
 * Options:
 *   --repo OWNER/NAME     default $GITHUB_REPOSITORY, else garrytan/gbrain
 *   --days N              window length (default 7), ending at --until (default now)
 *   --max-requests N      API request budget, listing included (default 700:
 *                         GITHUB_TOKEN allows 1000 an hour per repository)
 *   --concurrency N       parallel requests (default 8)
 *   --report-only         print a regression as a ::warning and exit 0
 *   --step-summary        append the report to $GITHUB_STEP_SUMMARY
 *   --write-baseline      write the tracked medians to the baseline file
 *   --baseline PATH       default scripts/ci-cost-baseline.json
 *
 * Mining: /actions/runs in created windows of a day, halved while a window
 * holds over 1000 results (the API's cap), then /actions/runs/{id}/jobs with
 * filter=all, so reruns count toward their run. Runs still in progress are
 * left out. When the jobs of every completed run would not fit the budget,
 * each workflow x event x conclusion group is sampled evenly over time (the
 * same cap per group, as large as the budget allows) and its mean $/run is
 * scaled back to the group's run count. The sample is planned on 60% of the
 * budget left after listing (runs over 100 jobs take a second page), the
 * tracked green groups get three times the cap of the others, and skipped,
 * action_required and startup_failure runs count $0 unread (they start no
 * job). A run whose jobs still fail after
 * retries is reported and left out of its group. A rate-limit reply waits out
 * retry-after (secondary limits) up to a minute; with the primary limit
 * nearly spent the run stops reading jobs and says the figures are partial.
 *
 * Pricing: a job on a Ubicloud runner label (`ubicloud`,
 * `ubicloud-standard-N[-arm][-ubuntu-XXXX]`) costs $0.000625 per vCPU-minute,
 * billed per started minute from started_at to completed_at; a job that never
 * got a runner costs nothing. GitHub-hosted runners cost $0 on a public
 * repository. Other Ubicloud labels (premium, GPU) are counted and reported as
 * unpriced. Ubicloud VMs from `ci:ubicloud` are not Actions jobs and are not
 * in this ledger.
 *
 * Regression: the median $/run of successful runs for each tracked
 * (workflow, event) pair (Test and E2E Tests, pull_request and push) is
 * compared with the baseline; more than the baseline's threshold (20%) above
 * it exits 1. Pairs with fewer than 5 sampled green runs are not judged.
 * Tests: test/scripts/ci-cost-ledger.test.ts.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const USD_PER_VCPU_MINUTE = 0.000625;
const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_BASELINE = join(ROOT, "scripts/ci-cost-baseline.json");
const TRACKED: Array<[string, string]> = [["Test", "pull_request"], ["Test", "push"], ["E2E Tests", "pull_request"], ["E2E Tests", "push"]];
const DEFAULT_THRESHOLD = 0.2;
const MIN_JUDGED = 5;
const SEARCH_CAP = 1000;
const MIN_SPLIT_MS = 10 * 60_000;
const RATE_RESERVE = 50;
const TRACKED_WEIGHT = 3;
// Share of the budget left after listing that plans the sample; the rest pays for second pages of runs over 100 jobs (Test has about 115).
const SAMPLE_SHARE = 0.6;
// Conclusions whose runs start no job: counted at $0 without reading their jobs.
const NO_JOBS = new Set(["skipped", "action_required", "startup_failure"]);

export interface Run { id: number; name: string; event: string; conclusion: string | null; status: string; created_at: string }
export interface Job { labels: string[]; runner_name?: string | null; started_at?: string | null; completed_at?: string | null }
export interface Http { get(path: string): Promise<any> }

export class RateLimitLow extends Error {}

/** vCPUs of a Ubicloud runner label set, 0 for any other runner, null for a Ubicloud label without a known price. */
export function ubicloudVcpus(labels: string[]): number | null {
  for (const label of labels) {
    if (!label.startsWith("ubicloud")) continue;
    const m = /^ubicloud(?:-standard-(\d+))?(?:-arm)?(?:-ubuntu-\d+)?$/.exec(label);
    return m ? Number(m[1] ?? 2) : null;
  }
  return 0;
}

export function jobCostUsd(job: Job): number {
  if (!job.runner_name || !job.started_at || !job.completed_at) return 0;
  const seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
  if (!(seconds > 0)) return 0;
  return Math.ceil(seconds / 60) * (ubicloudVcpus(job.labels) ?? 0) * USD_PER_VCPU_MINUTE;
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Every run created in [from, to], read in day windows halved below the 1000-result cap. */
export async function listRuns(http: Http, repo: string, from: number, to: number, o: { concurrency: number }): Promise<{ runs: Run[]; complete: boolean; requests: number }> {
  let requests = 0;
  let complete = true;
  const url = (a: number, b: number, page: number) => `repos/${repo}/actions/runs?created=${encodeURIComponent(`${iso(a)}..${iso(b)}`)}&exclude_pull_requests=true&per_page=100&page=${page}`;
  const get = (a: number, b: number, page: number) => {
    requests++;
    return http.get(url(a, b, page)) as Promise<{ total_count: number; workflow_runs: Run[] }>;
  };
  const windows: Array<[number, number]> = [];
  for (let a = from; a <= to; a += 86_400_000) windows.push([a, Math.min(a + 86_400_000 - 1000, to)]);
  const runs: Run[] = [];
  const readWindow = async ([a, b]: [number, number]): Promise<void> => {
    const first = await get(a, b, 1);
    if (first.total_count > SEARCH_CAP && b - a > MIN_SPLIT_MS) {
      const mid = a + Math.floor((b - a) / 2000) * 1000;
      await Promise.all([readWindow([a, mid]), readWindow([mid + 1000, b])]);
      return;
    }
    if (first.total_count > SEARCH_CAP) complete = false;
    runs.push(...first.workflow_runs);
    const pages = Math.min(Math.ceil(first.total_count / 100), SEARCH_CAP / 100);
    const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), o.concurrency, (page) => get(a, b, page));
    for (const r of rest) runs.push(...r.workflow_runs);
  };
  await pool(windows, Math.max(1, Math.floor(o.concurrency / 2)), readWindow);
  const unique = [...new Map(runs.map((r) => [r.id, r])).values()];
  return { runs: unique, complete, requests };
}

const groupKey = (r: Run) => `${r.name}\t${r.event}\t${r.conclusion}`;

/**
 * The runs whose jobs are read: all of them when they fit `budget`, else an
 * evenly spaced sample per group, the same cap for every group times its
 * weight (the tracked green groups weigh TRACKED_WEIGHT, so their medians get
 * the most runs).
 */
export function pickSample(runs: Run[], budget: number): Run[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) groups.set(groupKey(r), [...(groups.get(groupKey(r)) ?? []), r]);
  const weight = (g: Run[]) => (g[0]!.conclusion === "success" && TRACKED.some(([w, e]) => w === g[0]!.name && e === g[0]!.event) ? TRACKED_WEIGHT : 1);
  const take = (g: Run[], cap: number) => Math.min(g.length, cap * weight(g));
  const fits = (cap: number) => [...groups.values()].reduce((n, g) => n + take(g, cap), 0) <= budget;
  let lo = 0;
  let hi = Math.max(0, ...[...groups.values()].map((g) => g.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const picked: Run[] = [];
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const n = take(g, lo);
    for (let i = 0; i < n; i++) picked.push(sorted[Math.floor((i * sorted.length) / n)]!);
  }
  return picked;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

interface Baseline { generated_at?: string; threshold?: number; median_usd_per_run: Record<string, number> }
export interface LedgerResult { code: number; report: string; messages: string[] }
export interface LedgerDeps {
  http?: Http;
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  now?: () => number;
}

export async function runLedger(argv: string[], deps: LedgerDeps = {}): Promise<LedgerResult> {
  const o = { repo: process.env.GITHUB_REPOSITORY || "garrytan/gbrain", days: 7, until: "", maxRequests: 700, concurrency: 8, reportOnly: false, stepSummary: false, writeBaseline: false, baseline: DEFAULT_BASELINE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    const count = () => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`${arg} needs a positive whole number`);
      return n;
    };
    if (arg === "--repo") o.repo = value();
    else if (arg === "--days") o.days = count();
    else if (arg === "--until") o.until = value();
    else if (arg === "--max-requests") o.maxRequests = count();
    else if (arg === "--concurrency") o.concurrency = count();
    else if (arg === "--report-only") o.reportOnly = true;
    else if (arg === "--step-summary") o.stepSummary = true;
    else if (arg === "--write-baseline") o.writeBaseline = true;
    else if (arg === "--baseline") o.baseline = value();
    else throw new UsageError(`unknown argument ${arg}`);
  }
  const until = o.until ? Date.parse(o.until) : (deps.now ?? Date.now)();
  if (Number.isNaN(until)) throw new UsageError(`--until ${o.until} is not a date`);
  const since = until - o.days * 86_400_000;
  const http = deps.http ?? githubHttp();
  const messages: string[] = [];

  const listed = await listRuns(http, o.repo, since, until, { concurrency: o.concurrency });
  const completed = listed.runs.filter((r) => r.status === "completed");
  const inProgress = listed.runs.length - completed.length;
  const sample = pickSample(completed.filter((r) => !NO_JOBS.has(r.conclusion ?? "")), Math.floor(Math.max(0, o.maxRequests - listed.requests) * SAMPLE_SHARE));
  const costs = new Map<number, number>();
  let unpricedJobs = 0;
  let unreadRuns = 0;
  let partial = "";
  let budget = o.maxRequests - listed.requests;
  await pool(sample, o.concurrency, async (r) => {
    if (partial) return;
    try {
      let total = 0;
      for (let page = 1; ; page++) {
        if (budget-- <= 0) throw new RateLimitLow("the request budget ran out mid-run");
        const res = (await http.get(`repos/${o.repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100&page=${page}`)) as { total_count: number; jobs: Job[] };
        for (const job of res.jobs) {
          if (ubicloudVcpus(job.labels) === null) unpricedJobs++;
          total += jobCostUsd(job);
        }
        if (page * 100 >= res.total_count || !res.jobs.length) break;
      }
      costs.set(r.id, total);
    } catch (e) {
      if (e instanceof RateLimitLow) partial = e.message;
      else unreadRuns++;
    }
  });

  const groups = new Map<string, { runs: number; read: number; sampled: number[] }>();
  for (const r of completed) {
    const g = groups.get(groupKey(r)) ?? { runs: 0, read: 0, sampled: [] };
    g.runs++;
    if (NO_JOBS.has(r.conclusion ?? "")) g.sampled.push(0);
    else if (costs.has(r.id)) {
      g.read++;
      g.sampled.push(costs.get(r.id)!);
    }
    groups.set(groupKey(r), g);
  }
  const week = 7 / o.days;
  const rows = [...groups.entries()].map(([key, g]) => {
    const [workflow, event, conclusion] = key.split("\t") as [string, string, string];
    const perRun = g.sampled.length ? g.sampled.reduce((s, x) => s + x, 0) / g.sampled.length : 0;
    return { workflow, event, conclusion, runs: g.runs, read: g.read, weekly: perRun * g.runs * week, unread: !g.sampled.length };
  }).sort((a, b) => b.weekly - a.weekly);
  const total = rows.reduce((s, r) => s + r.weekly, 0);

  const baselineText = (() => {
    try { return (deps.readFile ?? ((p: string) => readFileSync(p, "utf8")))(o.baseline); } catch { return ""; }
  })();
  const baseline: Baseline | null = baselineText ? JSON.parse(baselineText) : null;
  const threshold = baseline?.threshold ?? DEFAULT_THRESHOLD;
  const medians: Record<string, { median: number; n: number }> = {};
  for (const [workflow, event] of TRACKED) {
    const green = groups.get(`${workflow}\t${event}\tsuccess`)?.sampled ?? [];
    if (green.length) medians[`${workflow}|${event}`] = { median: median(green), n: green.length };
  }
  const regressions: string[] = [];
  const medianRows: string[] = [];
  for (const [key, m] of Object.entries(medians)) {
    const [workflow, event] = key.split("|");
    const base = baseline?.median_usd_per_run[key];
    const change = base ? (m.median - base) / base : null;
    medianRows.push(`| ${workflow} | ${event} | ${m.n} | $${m.median.toFixed(3)} | ${base ? `$${base.toFixed(3)}` : "-"} | ${change === null ? "-" : `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`}${m.n < MIN_JUDGED ? " (too few runs to judge)" : ""} |`);
    if (change !== null && m.n >= MIN_JUDGED && change > threshold) {
      regressions.push(`median $/run for ${workflow} ${event} rose ${Math.round(change * 100)}% (from $${base!.toFixed(3)} to $${m.median.toFixed(3)} over ${m.n} green runs), over the ${Math.round(threshold * 100)}% threshold of ${o.baseline.startsWith(ROOT) ? o.baseline.slice(ROOT.length + 1) : o.baseline}${baseline?.generated_at ? ` (baseline ${baseline.generated_at.slice(0, 10)})` : ""}`);
    }
  }

  const sampledNote = sample.length < completed.length ? `jobs read for ${costs.size} of ${completed.length} completed runs, sampled evenly within each group and scaled to its run count` : `jobs read for ${costs.size} of ${completed.length} completed runs`;
  const lines = [
    `## CI cost ledger: ${iso(since)} .. ${iso(until)} (${o.days} days)`,
    "",
    `Ubicloud runners at $${USD_PER_VCPU_MINUTE} per vCPU-minute, billed per started minute; GitHub-hosted runners $0 (public repository); ${sampledNote}. Ubicloud VMs from ci:ubicloud gates are not Actions jobs and are not counted.`,
    "",
    `**Total: $${total.toFixed(2)}/week**`,
    "",
    "| Workflow | Event | Conclusion | Runs | Jobs read | $/week |",
    "|---|---|---|---:|---:|---:|",
    ...rows.map((r) => `| ${r.workflow} | ${r.event} | ${r.conclusion} | ${r.runs} | ${r.read} | $${r.weekly.toFixed(2)} |${r.unread ? " (not read)" : ""}`),
    "",
    "### Median $/run of successful runs",
    "",
    "| Workflow | Event | Green runs read | Median $/run | Baseline | Change |",
    "|---|---|---:|---:|---:|---:|",
    ...medianRows,
    "",
  ];
  if (inProgress) lines.push(`${inProgress} run(s) still in progress were left out.`);
  if (!listed.complete) lines.push("Partial: a created window still held over 1000 runs at the smallest split, so some runs were not listed.");
  if (partial) lines.push(`Partial: ${partial}; groups marked (not read) cost $0 here.`);
  if (unreadRuns) lines.push(`The jobs of ${unreadRuns} run(s) could not be read after retries; their groups are scaled from the runs that were read.`);
  if (unpricedJobs) lines.push(`${unpricedJobs} job(s) ran on Ubicloud labels without a known price and are counted at $0.`);
  if (!baseline) lines.push(`No baseline at ${o.baseline}: nothing compared.`);
  for (const r of regressions) lines.push(`**Cost regression:** ${r}.`);
  const report = lines.join("\n") + "\n";

  for (const r of regressions) {
    messages.push(o.reportOnly
      ? `::warning title=CI cost::${r}`
      : `ci-cost-ledger: ${r}. Find the jobs that grew (bun scripts/ci-cost-ledger.ts --days 1 shows the current shape), fix them, or when the rise is intended refresh the baseline with bun scripts/ci-cost-ledger.ts --write-baseline and commit it.`);
  }
  if (o.stepSummary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (o.writeBaseline) {
    const out = {
      generated_at: iso(until),
      window: { since: iso(since), until: iso(until) },
      threshold,
      note: "Median $/run of successful runs from scripts/ci-cost-ledger.ts --write-baseline; refresh it in the PR that intentionally changes CI cost.",
      median_usd_per_run: Object.fromEntries(Object.entries(medians).map(([k, m]) => [k, Math.round(m.median * 10_000) / 10_000])),
      green_runs_read: Object.fromEntries(Object.entries(medians).map(([k, m]) => [k, m.n])),
    };
    (deps.writeFile ?? ((p: string, t: string) => writeFileSync(p, t)))(o.baseline, JSON.stringify(out, null, 2) + "\n");
    messages.push(`ci-cost-ledger: wrote ${o.baseline}`);
    return { code: 0, report, messages };
  }
  return { code: regressions.length && !o.reportOnly ? 1 : 0, report, messages };
}

class UsageError extends Error {}

/** GitHub REST, rate-limit aware: fetch with GH_TOKEN / GITHUB_TOKEN (Actions), else the authenticated `gh api` CLI. */
function githubHttp(): Http {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  let remaining = Infinity;
  return {
    async get(path: string) {
      if (remaining < RATE_RESERVE) throw new RateLimitLow(`the API rate limit is nearly spent (${remaining} left)`);
      for (let attempt = 0; ; attempt++) {
        let status = 0;
        let body = "";
        let headers: Record<string, string> = {};
        if (token) {
          const res = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } }).catch(() => null);
          if (res) {
            status = res.status;
            body = await res.text();
            headers = Object.fromEntries(res.headers.entries());
          }
        } else {
          const proc = Bun.spawn(["gh", "api", "-i", path], { stdout: "pipe", stderr: "pipe" });
          const out = await new Response(proc.stdout).text();
          await proc.exited;
          const split = out.indexOf("\r\n\r\n") >= 0 ? out.indexOf("\r\n\r\n") : out.indexOf("\n\n");
          const head = split >= 0 ? out.slice(0, split) : out;
          body = split >= 0 ? out.slice(split).trim() : "";
          status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0);
          for (const line of head.split(/\r?\n/).slice(1)) {
            const i = line.indexOf(":");
            if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          }
        }
        if (headers["x-ratelimit-remaining"] !== undefined) remaining = Number(headers["x-ratelimit-remaining"]);
        if (status >= 200 && status < 300) return JSON.parse(body);
        const retryAfter = Number(headers["retry-after"] ?? 0);
        if ((status === 403 || status === 429) && retryAfter > 0 && retryAfter <= 60 && attempt < 3) {
          await Bun.sleep(retryAfter * 1000);
          continue;
        }
        if ((status === 403 || status === 429) && remaining === 0) throw new RateLimitLow("the API rate limit is spent");
        if ((status === 0 || status >= 500) && attempt < 3) {
          await Bun.sleep(1000 * 3 ** attempt);
          continue;
        }
        throw new Error(`GitHub API GET ${path} -> ${status || "no response"}: ${body.slice(0, 300)}${token ? "" : ". Fix: gh auth login, or export GH_TOKEN"}`);
      }
    },
  };
}

if (import.meta.main) {
  runLedger(process.argv.slice(2)).then((r) => {
    process.stdout.write(r.report);
    for (const m of r.messages) (m.startsWith("::") ? console.log : console.error)(m);
    process.exit(r.code);
  }).catch((error) => {
    console.error(`ci-cost-ledger: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  });
}
