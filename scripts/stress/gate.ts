#!/usr/bin/env bun
/**
 * CI planner and reporter for the PR stress gate (`stress-changed-tests`) and
 * the nightly race hunt (`race-hunt`), both run by
 * .github/workflows/stress.yml through `bun run test:stress`.
 *
 *   bun scripts/stress/gate.ts plan   --mode gate|race-hunt   (env inputs below; writes GITHUB_OUTPUT + plan.json)
 *   bun scripts/stress/gate.ts report --mode gate|race-hunt --plan <plan.json> --manifests <dir>
 *
 * Plan env: EVENT, BASE_SHA/HEAD_SHA (pull_request, merge_group),
 * STRESS_FILES or STRESS_BASE/STRESS_HEAD (workflow_dispatch, validated:
 * paths match ^test/[\w./-]+\.test\.ts$, refs pass git check-ref-format or are
 * 40-hex SHAs), GBRAIN_RACE_HUNT_DAY (rotation override, tests only).
 * Report env: PLAN_RESULT, SHARDS_RESULT, GITHUB_REPOSITORY, GITHUB_RUN_ID,
 * GITHUB_RUN_ATTEMPT, GH_TOKEN, GATE_SINCE (exemptions must predate it).
 *
 * The gate's conclusion is always success or failure: outside pull_request
 * and merge_group it succeeds with "not a PR event"; a plan that cannot list
 * the changed files fails with the next step. Docs: docs/TESTING.md#stress-gate,
 * docs/TESTING.md#race-hunt.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inert, restClient, type GitHubClient } from '../lib/gh-issue.ts';
import { postgresArm } from '../check-postgres-lane-coverage.ts';
import { armMode } from './plan.ts';
import { readArmsList } from '../postgres-unit-arms.ts';
import {
  DEFAULT_ITERATIONS, RACE_HUNT_DOCS, STRESS_DOCS, allTestFiles, changedFiles, expandHelper, iterationEstimateMs,
  loadWeights, notStressedReason, parseFileList, planShards, profileFor, redact, reproduceLine, validRef,
  type HelperExpansion, type NotStressed, type ProfileName, type Shard, type Weights,
} from './plan.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
export const GATE_SHARD_BUDGET_MS = 25 * 60_000;
export const RACE_SHARD_BUDGET_MS = 55 * 60_000;
export const RACE_BASE_SHARDS = 6;
export const RACE_MAX_SHARDS = 12;
export const RACE_MIN_ITERATIONS = 3;
export const EXEMPTION_LABELS = ['master-red', 'flake', 'nightly-red'];
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const BOT = 'github-actions[bot]';

export type Mode = 'gate' | 'race-hunt';

export interface PlanFile { file: string; profile: ProfileName; iterations: number; estimateMs: number }
export interface Plan {
  version: 1; mode: Mode; run: boolean; reason: string; diagnostic: boolean; head: string; base: string;
  files: PlanFile[]; notStressed: NotStressed[]; helpers: HelperExpansion[]; shards: Shard[];
  unrun: string[]; iterations: number; budgetMs: number; estimateMs: number;
}

const emptyPlan = (mode: Mode, reason: string, extra: Partial<Plan> = {}): Plan => ({
  version: 1, mode, run: false, reason, diagnostic: false, head: '', base: '', files: [], notStressed: [], helpers: [], shards: [], unrun: [],
  iterations: DEFAULT_ITERATIONS, budgetMs: mode === 'gate' ? GATE_SHARD_BUDGET_MS : RACE_SHARD_BUDGET_MS, estimateMs: 0, ...extra,
});

function liveKeyOnly(root: string): Set<string> {
  const path = join(root, 'scripts/e2e-live-key-only.txt');
  return new Set(existsSync(path) ? readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : []);
}

function classify(root: string, files: string[], weights: Weights): { stress: Array<PlanFile & { perIterationMs: number; setupMs: number }>; notStressed: NotStressed[] } {
  const live = liveKeyOnly(root);
  const stress: Array<PlanFile & { perIterationMs: number; setupMs: number }> = [];
  const notStressed: NotStressed[] = [];
  for (const file of files) {
    if (!existsSync(join(root, file))) { notStressed.push({ file, reason: 'no such file at the head commit' }); continue; }
    const reason = notStressedReason(file, live);
    if (reason) { notStressed.push({ file, reason }); continue; }
    const profile = profileFor(file, { armed: armMode(root, file).armed, postgres: true });
    const perIterationMs = iterationEstimateMs(file, profile.name, weights);
    stress.push({ file, profile: profile.name, iterations: DEFAULT_ITERATIONS, estimateMs: 0, perIterationMs, setupMs: profile.prereq ? 180_000 : 0 });
  }
  return { stress, notStressed };
}

export interface GatePlanInput { event: string; baseSha?: string; headSha?: string; stressFiles?: string; stressBase?: string; stressHead?: string }

/** The PR gate: every changed test file plus helper importers, ten iterations, shards under the budget. */
export function planGate(root: string, input: GatePlanInput, weights = loadWeights(root)): Plan | { error: string } {
  let files: string[];
  let helpers: HelperExpansion[] = [];
  let base = input.baseSha ?? '';
  let head = input.headSha ?? '';
  let diagnostic = false;
  if (input.event === 'workflow_dispatch' && (input.stressFiles || input.stressBase)) {
    diagnostic = true;
    if (input.stressFiles) {
      const parsed = parseFileList(input.stressFiles);
      if (parsed.invalid.length) return { error: `stress_files has entries that are not repo-relative test files: ${parsed.invalid.map(f => JSON.stringify(f.slice(0, 80))).join(', ')}. Next: pass space- or comma-separated paths matching ^test/[\\w./-]+\\.test\\.ts$` };
      files = parsed.files;
      head = 'HEAD';
    } else {
      base = input.stressBase!;
      head = input.stressHead || 'HEAD';
      if (!validRef(base) || !validRef(head)) return { error: `stress_base/stress_head must be 40-hex SHAs or valid ref names (got ${JSON.stringify(base.slice(0, 80))}, ${JSON.stringify(head.slice(0, 80))}). Next: re-dispatch with e.g. stress_base=origin/master` };
      const changed = changedFiles(root, base, head);
      if (changed.error) return { error: changed.error };
      const tests = changed.helpers.length ? allTestFiles(root) : [];
      helpers = changed.helpers.map(h => expandHelper(root, h, tests, resolveSha(root, head)));
      files = [...new Set([...changed.tests, ...helpers.flatMap(h => h.stressed)])].sort();
    }
  } else if (input.event === 'pull_request' || input.event === 'merge_group') {
    if (!input.baseSha || !input.headSha) return { error: `the ${input.event} payload carried no base/head SHA. Next: re-run the job; if it repeats, report the event payload` };
    const changed = changedFiles(root, input.baseSha, input.headSha);
    if (changed.error) return { error: changed.error };
    const tests = changed.helpers.length ? allTestFiles(root) : [];
    helpers = changed.helpers.map(h => expandHelper(root, h, tests, input.headSha!));
    files = [...new Set([...changed.tests, ...helpers.flatMap(h => h.stressed)])].sort();
  } else {
    return emptyPlan('gate', 'not a PR event');
  }
  files = withWrappers(root, files);
  const { stress, notStressed } = classify(root, files, weights);
  const shards = planShards(stress, DEFAULT_ITERATIONS, GATE_SHARD_BUDGET_MS);
  return {
    ...emptyPlan('gate', stress.length ? `${stress.length} file(s) × ${DEFAULT_ITERATIONS} iterations` : 'no changed test files to stress'),
    run: stress.length > 0, diagnostic, base, head, helpers, notStressed, shards,
    files: stress.map(({ file, profile }) => ({ file, profile, iterations: DEFAULT_ITERATIONS, estimateMs: estimateOf(shards, file) })),
    estimateMs: shards.reduce((s, x) => s + x.estimateMs, 0),
  };
}

/** Add the test/e2e wrapper that owns each file's PostgreSQL arm. */
function withWrappers(root: string, files: string[]): string[] {
  return [...new Set([...files, ...files.map(f => armMode(root, f).wrapper).filter((w): w is string => !!w && existsSync(join(root, w)))])].sort();
}

const estimateOf = (shards: Shard[], file: string) => shards.flatMap(s => s.items).filter(i => i.file === file).reduce((s, i) => s + i.estimateMs, 0);

function resolveSha(root: string, ref: string): string {
  return spawnSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).stdout.trim() || ref;
}

/** Postgres-arm and E2E importers of helpers changed on master since the last night (the gate sampled them out). */
export function raceHuntHelperImporters(root: string, since = '26 hours ago'): { helpers: string[]; files: string[] } {
  const r = spawnSync('git', ['log', `--since=${since}`, '--name-only', '--format=', 'HEAD', '--', 'test/helpers'], { cwd: root, encoding: 'utf8' });
  const helpers = [...new Set((r.stdout ?? '').split('\n').filter(p => p && !p.endsWith('.test.ts') && existsSync(join(root, p))))].sort();
  if (!helpers.length) return { helpers, files: [] };
  const tests = allTestFiles(root);
  const files = new Set<string>();
  for (const h of helpers) {
    const exp = expandHelper(root, h, tests, 'race-hunt');
    for (const f of exp.listedOnly) if (f.startsWith('test/e2e/') || postgresArm(join(root, f))) files.add(f);
  }
  return { helpers, files: [...files].sort() };
}

/**
 * The race hunt: every listed Postgres arm at 10 iterations within 6 shards
 * of 55 minutes, growing to 12 shards; past that, every file runs at least 3
 * iterations nightly and the spare capacity rotates by day so each file still
 * reaches 10 within the week. Files are never dropped: what does not fit is
 * `unrun` and the job fails "race hunt over budget".
 */
export function planRaceHunt(root: string, opts: { day: number; extra?: string[]; diagnostic?: boolean }, weights = loadWeights(root)): Plan {
  const list = readArmsList(root);
  const files = [...new Set([...list.files, ...(opts.extra ?? [])])].sort();
  const { stress, notStressed } = classify(root, files, weights);
  const capacity = RACE_MAX_SHARDS * RACE_SHARD_BUDGET_MS;
  const per = (f: { perIterationMs: number }) => f.perIterationMs + 3000;
  const onePass = stress.reduce((s, f) => s + per(f), 0);
  let depth = new Map(stress.map(f => [f.file, DEFAULT_ITERATIONS]));
  const unrun: string[] = [];
  if (onePass * DEFAULT_ITERATIONS > capacity) {
    const floor = Math.floor(capacity / Math.max(1, onePass));
    if (floor >= RACE_MIN_ITERATIONS) {
      depth = new Map(stress.map(f => [f.file, Math.min(DEFAULT_ITERATIONS, floor)]));
      let spare = capacity - onePass * Math.min(DEFAULT_ITERATIONS, floor);
      const order = stress.map(f => f.file);
      const offset = order.length ? (opts.day * 7) % order.length : 0;
      for (let k = 0; k < order.length && spare > 0; k++) {
        const f = stress.find(x => x.file === order[(offset + k) % order.length])!;
        const add = Math.min(DEFAULT_ITERATIONS - depth.get(f.file)!, Math.floor(spare / per(f)));
        if (add > 0) { depth.set(f.file, depth.get(f.file)! + add); spare -= add * per(f); }
      }
    } else {
      depth = new Map();
      let used = 0;
      for (const f of stress) {
        if (used + per(f) * RACE_MIN_ITERATIONS <= capacity) { depth.set(f.file, RACE_MIN_ITERATIONS); used += per(f) * RACE_MIN_ITERATIONS; } else unrun.push(f.file);
      }
    }
  }
  const scheduled = stress.filter(f => depth.has(f.file));
  const shards: Shard[] = [];
  for (const iterations of [...new Set(depth.values())]) {
    const group = scheduled.filter(f => depth.get(f.file) === iterations);
    shards.push(...planShards(group, iterations, RACE_SHARD_BUDGET_MS));
  }
  shards.forEach((s, i) => { s.index = i + 1; });
  return {
    ...emptyPlan('race-hunt', `${scheduled.length} Postgres-arm file(s), ${shards.length} shard(s)`),
    run: scheduled.length > 0, diagnostic: !!opts.diagnostic, notStressed, shards, unrun,
    files: scheduled.map(f => ({ file: f.file, profile: f.profile, iterations: depth.get(f.file)!, estimateMs: estimateOf(shards, f.file) })),
    estimateMs: shards.reduce((s, x) => s + x.estimateMs, 0),
  };
}

// ── Exemptions ────────────────────────────────────────────────────────────────

export interface Exemption { file: string; test: string; backend: string; signature: string; owner: string; expires: string; issue: number; url: string }
export interface GhIssue { number: number; html_url?: string; title?: string; body?: string | null; created_at: string; user?: { login: string }; author_association?: string; labels?: Array<{ name: string } | string>; pull_request?: unknown }
interface GhComment { body?: string; user?: { login: string }; author_association?: string }
interface GhEvent { event: string; label?: { name: string }; actor?: { login: string } }

const MARKER = '<!-- gbrain-stress-exemption -->';

/** Every exemption block (`<!-- gbrain-stress-exemption -->` then a ```json object or array) in a text. */
export function parseExemptionBlocks(text: string): Array<Omit<Exemption, 'issue' | 'url'>> {
  const out: Array<Omit<Exemption, 'issue' | 'url'>> = [];
  let at = text.indexOf(MARKER);
  while (at !== -1) {
    const rest = text.slice(at + MARKER.length).trimStart();
    const m = /^```json\n([\s\S]*?)\n```/.exec(rest);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]!) as unknown;
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
          const r = row as Record<string, unknown>;
          if (['file', 'test', 'backend', 'signature', 'owner', 'expires'].every(k => typeof r[k] === 'string' && (r[k] as string).length > 0) && /^\d{4}-\d{2}-\d{2}$/.test(r.expires as string)) {
            out.push({ file: r.file as string, test: r.test as string, backend: r.backend as string, signature: r.signature as string, owner: r.owner as string, expires: r.expires as string });
          }
        }
      } catch { /* malformed block grants nothing */ }
    }
    at = text.indexOf(MARKER, at + MARKER.length);
  }
  return out;
}

/**
 * Exemptions from open master-red, flake or nightly-red issues. An issue
 * counts only when the nightly-watch bot or a maintainer opened it or applied
 * one of those labels, and it predates `since`; a block counts from the issue
 * body or a comment by the bot or a maintainer. Any API failure returns
 * `incomplete` and grants nothing.
 */
export async function loadExemptions(client: GitHubClient, since: string): Promise<{ exemptions: Exemption[]; openIssues: GhIssue[]; incomplete?: string }> {
  try {
    const seen = new Map<number, GhIssue>();
    for (const label of EXEMPTION_LABELS) {
      for (let page = 1; page <= 5; page++) {
        const batch = await client.request<GhIssue[]>('GET', `repos/{repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
        for (const i of batch) if (!i.pull_request) seen.set(i.number, i);
        if (batch.length < 100) break;
      }
    }
    const permission = new Map<string, boolean>();
    const maintainer = async (login: string | undefined): Promise<boolean> => {
      if (!login) return false;
      if (login === BOT) return true;
      if (!permission.has(login)) {
        try {
          const r = await client.request<{ permission?: string }>('GET', `repos/{repo}/collaborators/${encodeURIComponent(login)}/permission`);
          permission.set(login, ['admin', 'maintain', 'write'].includes(r.permission ?? ''));
        } catch { permission.set(login, false); }
      }
      return permission.get(login)!;
    };
    const exemptions: Exemption[] = [];
    for (const issue of seen.values()) {
      if (!(Date.parse(issue.created_at) < Date.parse(since))) continue;
      let trusted = issue.user?.login === BOT || TRUSTED_ASSOCIATIONS.has(issue.author_association ?? '');
      if (!trusted) {
        const events = await client.request<GhEvent[]>('GET', `repos/{repo}/issues/${issue.number}/events?per_page=100`);
        for (const e of events) if (e.event === 'labeled' && EXEMPTION_LABELS.includes(e.label?.name ?? '') && await maintainer(e.actor?.login)) { trusted = true; break; }
      }
      if (!trusted) continue;
      const texts = [issue.body ?? ''];
      const comments = await client.request<GhComment[]>('GET', `repos/{repo}/issues/${issue.number}/comments?per_page=100`);
      for (const c of comments) if (c.user?.login === BOT || TRUSTED_ASSOCIATIONS.has(c.author_association ?? '')) texts.push(c.body ?? '');
      for (const block of texts.flatMap(parseExemptionBlocks)) exemptions.push({ ...block, issue: issue.number, url: issue.html_url ?? `#${issue.number}` });
    }
    return { exemptions, openIssues: [...seen.values()] };
  } catch (e) {
    return { exemptions: [], openIssues: [], incomplete: (e as Error).message };
  }
}

export interface StressFailure { file: string; iteration: number; seed: number; test: string; backend: string; signature: string; message: string; reproduce: string; context: string }

/** A failure is exempt only when file, test name, backend and signature all match an unexpired record. */
export function matchExemption(f: StressFailure, exemptions: Exemption[], today: string): Exemption | undefined {
  return exemptions.find(e => e.file === f.file && e.test === f.test && e.backend === f.backend && e.signature === f.signature && e.expires >= today);
}

// ── Report ────────────────────────────────────────────────────────────────────

interface Manifest { sha: string; bun: string; run_id: string; artifact: string; files: Array<{ file: string; status: string; firstIteration: number; iterations: Array<{ index: number }>; reason?: string }>; failures: StressFailure[]; setup_ms: number; run_ms: number }

export function loadManifests(dir: string): Manifest[] {
  const out: Manifest[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e === 'stress-manifest.json') out.push(JSON.parse(readFileSync(p, 'utf8'))); } };
  walk(dir);
  return out;
}

/** Planned (file, iteration) pairs no manifest accounts for: an incomplete shard never reads as a pass. */
export function missingWork(plan: Plan, manifests: Manifest[]): string[] {
  const done = new Set<string>();
  for (const m of manifests) for (const f of m.files) {
    if (f.status === 'not-stressed') { for (const s of plan.shards) for (const i of s.items) if (i.file === f.file) for (let k = i.first; k < i.first + i.count; k++) done.add(`${f.file}#${k}`); continue; }
    for (const it of f.iterations) done.add(`${f.file}#${it.index}`);
  }
  const missing: string[] = [];
  for (const s of plan.shards) for (const i of s.items) {
    const absent = Array.from({ length: i.count }, (_, k) => i.first + k).filter(k => !done.has(`${i.file}#${k}`));
    if (absent.length) missing.push(`${i.file} iterations ${absent[0]}-${absent[absent.length - 1]} (shard ${s.index})`);
  }
  return missing;
}

export interface JobTiming { name: string; conclusion?: string | null; created_at: string; started_at: string | null; completed_at: string | null }
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]! : 0; };

/** p95 queue (created → started) and completion (created → completed) minutes of the shard jobs, and their runner-minutes. */
export function shardTimings(jobs: JobTiming[]): { shards: number; p95QueueMin: number; p95CompletionMin: number; runnerMin: number } {
  const shards = jobs.filter(j => /Stress shard|Race hunt shard/.test(j.name) && j.conclusion !== 'skipped' && j.started_at && j.completed_at);
  const min = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;
  return {
    shards: shards.length,
    p95QueueMin: p95(shards.map(j => min(j.created_at, j.started_at!))),
    p95CompletionMin: p95(shards.map(j => min(j.created_at, j.completed_at!))),
    runnerMin: shards.reduce((s, j) => s + min(j.started_at!, j.completed_at!), 0),
  };
}

export interface ReportInput {
  plan: Plan | undefined; planResult: string; shardsResult: string; manifests: Manifest[];
  exemptions: Awaited<ReturnType<typeof loadExemptions>>; timings?: ReturnType<typeof shardTimings>; today: string; artifact: string;
}

/** Summary markdown, `::error` lines and the exit code. Reproduce commands come from validated fields and are never passed through inert(). */
export function buildReport(r: ReportInput): { summary: string; errors: string[]; exit: number } {
  const mode = r.plan?.mode ?? 'gate';
  const docs = mode === 'gate' ? STRESS_DOCS : RACE_HUNT_DOCS;
  const title = mode === 'gate' ? 'PR stress gate (`stress-changed-tests`)' : 'Race hunt (`race-hunt`)';
  const lines: string[] = [`## ${title}${r.plan?.diagnostic ? ' — diagnostic dispatch (never opens, updates or closes an issue)' : ''}`, ''];
  const errors: string[] = [];
  if (r.planResult !== 'success' || !r.plan) {
    const why = 'the plan job failed, so the set of files to stress is unknown';
    lines.push(`**Failed:** ${why}. Next: read the "Stress plan" job log; if it says the merge base is missing, fetch it (\`git fetch --no-tags origin master\`) and re-run. Docs: ${docs}`);
    errors.push(`stress plan did not succeed (${r.planResult}). Why: ${why}. Next: read the plan job log and re-run. Docs: ${docs}`);
    return { summary: lines.join('\n'), errors, exit: 1 };
  }
  const plan = r.plan;
  if (!plan.run && !plan.unrun.length) {
    lines.push(`**Passed:** ${plan.reason}.`);
    for (const n of plan.notStressed) lines.push(`- not stressed: \`${n.file}\`: ${n.reason}`);
    return { summary: lines.join('\n'), errors, exit: 0 };
  }
  const failures = r.manifests.flatMap(m => m.failures);
  const missing = missingWork(plan, r.manifests);
  const exempt: Array<{ f: StressFailure; e: Exemption }> = [];
  const real: StressFailure[] = [];
  for (const f of failures) {
    const e = mode === 'gate' && !r.exemptions.incomplete ? matchExemption(f, r.exemptions.exemptions, r.today) : undefined;
    if (e) exempt.push({ f, e }); else real.push(f);
  }
  const fileCount = plan.files.length;
  const iterationTotal = plan.files.reduce((s, f) => s + f.iterations, 0);
  lines.push(`${fileCount} file(s), ${iterationTotal} iteration(s) across ${plan.shards.length} shard(s); a fresh database per database iteration.`);
  if (r.timings) lines.push(`Shards: ${r.timings.shards}, runner-minutes ${r.timings.runnerMin.toFixed(1)}, p95 queue ${r.timings.p95QueueMin.toFixed(1)} min, p95 completion ${r.timings.p95CompletionMin.toFixed(1)} min.`);
  lines.push('');
  const byFile = new Map<string, StressFailure[]>();
  for (const f of real) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  if (byFile.size) {
    lines.push(`### Failed (${byFile.size} file${byFile.size > 1 ? 's' : ''})`, '');
    for (const [file, fs] of byFile) {
      const iterations = [...new Set(fs.map(f => f.iteration))].sort((a, b) => a - b);
      const planned = plan.files.find(p => p.file === file)?.iterations ?? DEFAULT_ITERATIONS;
      const first = fs[0]!;
      const reproduce = reproduceLine({ file, iterations: planned, firstIteration: first.iteration, seed: first.seed - first.iteration + 1, postgres: plan.files.find(p => p.file === file)?.profile === 'postgres-arm' || file.startsWith('test/e2e/') });
      const headline = mode === 'gate'
        ? `failed ${iterations.length} of ${planned} iterations (first: iteration ${first.iteration}). A flaky touched file must be root-caused in this PR`
        : `failed ${iterations.length} of ${planned} iterations (first: iteration ${first.iteration}); open a repair PR that root-causes it`;
      lines.push(`- \`${file}\`: ${headline}.`, `  - test: ${inert(first.test)}; backend ${inert(first.backend)}; ${inert(redact(first.message.split('\n')[0] ?? ''), 300)}`, '', '  ```bash', `  ${reproduce}`, `  # ${inert(redact(first.context), 400)}`, '  ```', '');
      errors.push(`file=${file}::${mode === 'gate' ? 'stress gate' : 'race hunt'}: ${headline}. Why: the same commit passed and failed across iterations. Reproduce: ${reproduce} (${r.artifact || 'see the run artifacts'}). Docs: ${docs}`);
    }
  }
  if (exempt.length) {
    lines.push('### Known failures (exempt)', '');
    for (const { f, e } of exempt) lines.push(`- \`${f.file}\` ${inert(f.test)}: matches the open issue ${e.url} (owner ${inert(e.owner)}, expires ${e.expires}); not counted. Any other failure still fails the check.`);
    lines.push('');
  }
  if (mode === 'gate') {
    const touched = plan.files.map(p => p.file);
    const known = r.exemptions.openIssues.filter(i => touched.some(f => (i.body ?? '').includes(f) || (i.title ?? '').includes(f)));
    if (known.length) { lines.push('### Touched files with an open issue', ''); for (const i of known) lines.push(`- ${i.html_url ?? `#${i.number}`}: ${inert(i.title ?? '')}`); lines.push(''); }
    if (r.exemptions.incomplete) lines.push(`Exemption lookup incomplete (${inert(r.exemptions.incomplete, 200)}): no exemption was granted.`, '');
  }
  if (missing.length) {
    lines.push('### Incomplete', '', `Shards result: ${r.shardsResult}. These planned iterations left no receipt, so the run cannot pass:`, ...missing.map(m => `- ${m}`), '', `Next: open the failed shard's log; re-run the job when the cause is outside the PR. Docs: ${docs}`, '');
    errors.push(`${missing.length} planned work item(s) left no receipt (shards: ${r.shardsResult}). Why: an unrun iteration is not a pass. Next: read the shard logs and re-run. Docs: ${docs}`);
  }
  if (plan.unrun.length) {
    lines.push('### Race hunt over budget', '', `These files did not fit ${RACE_MAX_SHARDS} shards × ${RACE_SHARD_BUDGET_MS / 60_000} minutes at ${RACE_MIN_ITERATIONS} iterations and did not run:`, ...plan.unrun.map(f => `- \`${f}\``), '', `Next: speed up the slowest listed files or split the race hunt into a second scheduled run. Docs: ${docs}`, '');
    errors.push(`race hunt over budget: ${plan.unrun.length} file(s) did not run (${plan.unrun.slice(0, 5).join(', ')}${plan.unrun.length > 5 ? ', …' : ''}). Why: files are never dropped silently. Next: speed up the slowest files or add a second scheduled shard group. Docs: ${docs}`);
  }
  if (plan.notStressed.length) { lines.push('### Not stressed', ''); for (const n of plan.notStressed) lines.push(`- \`${n.file}\`: ${n.reason}`); lines.push(''); }
  const runtimeSkips = r.manifests.flatMap(m => m.files.filter(f => f.status === 'not-stressed'));
  for (const s of runtimeSkips) lines.push(`- not stressed at run time: \`${s.file}\`: ${inert(s.reason ?? '')}`);
  for (const h of plan.helpers) if (h.listedOnly.length) lines.push(`- helper \`${h.helper}\` has ${h.importers} direct importers; stressed ${h.stressed.length} (its own tests and a sample seeded by the head SHA). Not stressed here: ${h.listedOnly.map(f => `\`${f}\``).join(', ')}${h.listedOnly.some(f => f.startsWith('test/e2e/')) ? '; their Postgres arms join that night\'s race hunt' : ''}.`);
  const exit = byFile.size || missing.length || plan.unrun.length ? 1 : 0;
  if (!exit) lines.push('', `**Passed.** Every planned iteration ran and passed.`);
  return { summary: lines.join('\n'), errors, exit };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; }

function writeOutputs(plan: Plan) {
  const out = process.env.GITHUB_OUTPUT;
  const matrix = { include: plan.shards.map(s => ({ shard: s.index, work: JSON.stringify(s.items.map(({ file, first, count }) => ({ file, first, count }))) })) };
  const lines = [`run=${plan.run}`, `count=${plan.shards.length}`, `matrix=${JSON.stringify(matrix)}`, `reason=${plan.reason.replace(/\n/g, ' ')}`];
  if (out) appendFileSync(out, `${lines.join('\n')}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  const mode = (arg(argv, '--mode') ?? 'gate') as Mode;
  if (!['gate', 'race-hunt'].includes(mode)) { console.error('usage: scripts/stress/gate.ts plan|report --mode gate|race-hunt'); return 2; }
  if (command === 'plan') {
    const env = process.env;
    let plan: Plan;
    if (mode === 'gate') {
      const result = planGate(ROOT, { event: env.EVENT ?? '', baseSha: env.BASE_SHA, headSha: env.HEAD_SHA, stressFiles: env.STRESS_FILES, stressBase: env.STRESS_BASE, stressHead: env.STRESS_HEAD });
      if ('error' in result) {
        console.error(`::error::stress gate: the changed-file list could not be computed: ${result.error}. Why: the gate stresses every test file the diff touches, so a guessed list could skip one. Docs: ${STRESS_DOCS}`);
        return 1;
      }
      plan = result;
    } else {
      const day = Number(env.GBRAIN_RACE_HUNT_DAY ?? Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86_400_000));
      const extra = raceHuntHelperImporters(ROOT);
      plan = planRaceHunt(ROOT, { day, extra: extra.files, diagnostic: env.EVENT === 'workflow_dispatch' });
      if (extra.files.length) console.log(`race hunt: added ${extra.files.length} Postgres-arm importer(s) of ${extra.helpers.join(', ')} (changed on master since the last night)`);
    }
    const dir = join(env.RUNNER_TEMP ?? join(ROOT, '.context'), 'stress-plan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    writeOutputs(plan);
    console.log(`${mode}: ${plan.reason}; ${plan.shards.length} shard(s), estimate ${(plan.estimateMs / 60_000).toFixed(1)} runner-minutes of tests${plan.unrun.length ? `; ${plan.unrun.length} file(s) over budget` : ''}`);
    for (const s of plan.shards) console.log(`  shard ${s.index}: ${(s.estimateMs / 60_000).toFixed(1)} min, ${s.items.map(i => `${i.file}[${i.first}..${i.first + i.count - 1}]`).join(' ')}`);
    return 0;
  }
  if (command === 'report') {
    const planPath = arg(argv, '--plan');
    const plan = planPath && existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) as Plan : undefined;
    const manifests = loadManifests(arg(argv, '--manifests') ?? '');
    const repo = process.env.GITHUB_REPOSITORY ?? '';
    const client = repo ? restClient(repo) : undefined;
    const since = process.env.GATE_SINCE || new Date().toISOString();
    const exemptions = mode === 'gate' && plan?.run && client ? await loadExemptions(client, since) : { exemptions: [], openIssues: [] };
    let timings: ReturnType<typeof shardTimings> | undefined;
    if (client && process.env.GITHUB_RUN_ID) {
      try {
        const jobs = await client.request<{ jobs: JobTiming[] }>('GET', `repos/{repo}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT ?? 1}/jobs?per_page=100`);
        timings = shardTimings(jobs.jobs);
      } catch { /* timings are informational */ }
    }
    const artifact = process.env.GITHUB_SERVER_URL && repo && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
    const report = buildReport({ plan, planResult: process.env.PLAN_RESULT ?? 'success', shardsResult: process.env.SHARDS_RESULT ?? 'success', manifests, exemptions, timings, today: new Date().toISOString().slice(0, 10), artifact });
    console.log(report.summary);
    for (const e of report.errors) console.log(e.startsWith('file=') ? `::error ${e}` : `::error::${e}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.summary}\n`);
    const result = arg(argv, '--json');
    if (result) { mkdirSync(dirname(result), { recursive: true }); writeFileSync(result, JSON.stringify({ exit: report.exit, errors: report.errors, timings }, null, 2)); }
    return report.exit;
  }
  console.error('usage: bun scripts/stress/gate.ts plan|report --mode gate|race-hunt [--plan <plan.json>] [--manifests <dir>] [--json <out>]');
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
