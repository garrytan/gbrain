#!/usr/bin/env bun
/**
 * Master-push reuse of an identical-tree full-suite run (P2, docs/ci-event-parity.md#master-push-reuse).
 *
 *   bun scripts/ci-reuse.ts --workflow test|e2e --sha <push sha> --repo <owner/name>
 *        --output <GITHUB_OUTPUT> [--summary <GITHUB_STEP_SUMMARY>] [--record <reuse.json>]
 *
 * A push to master is a merge commit M. Its run may reuse the full run of the
 * same workflow that already ran the complete full suite on M's tree: the
 * workflow_dispatch on the PR head branch (full-ci.yml, or a hand-run
 * `gh workflow run`) or an earlier push run. Pull-request runs are the cheap
 * tier and never candidates. Fail-closed: reuse=true only when
 *   (a) M is a merge commit (two parents) whose tree equals the candidate's
 *       recorded tree;
 *   (b) the candidate is a same-repository workflow_dispatch or push run
 *       whose LATEST attempt completed with conclusion success;
 *   (c) its full-suite job (`full-suite` / `e2e-full-suite`, by name, exactly
 *       one) concluded success in that latest attempt;
 *   (d) its tested-tree artifact (`full-suite-tree` / `e2e-full-suite-tree`,
 *       tree.json) is readable, has profile full, names this run, attempt,
 *       event, head and workflow, and its tree equals both M's tree and the
 *       tree of the run's head commit.
 * A diagnostic dispatch (test.yml native_only, race_hunt, stress_*; e2e.yml
 * full_corpus, order_hunt) skips the full-suite job, so (c) rejects it.
 * Candidates on head M^2 (the merged PR head) come first, newest first; then
 * recent successful dispatch and push runs whose head tree equals M's tree. Any
 * API error, cancelled, failed or in-progress attempt, missing or cheap
 * artifact, tree mismatch or non-merge push gives reuse=false with a reason.
 *
 * Writes reuse, source_run_id, source_run_attempt, source_sha, tree and reason
 * to --output, one summary line (the reused run URL, or the fallback reason)
 * to --summary, and the reuse record (REUSE_FILE, read by
 * scripts/release-gate.ts) to --record. Exit 0 whenever a decision was
 * written (a fallback is not an error), 2 on usage.
 *
 *   bun scripts/ci-reuse.ts --gate --sha <HEAD> --tree <tree> --repo <owner/name> [--wait-minutes N] [--poll-seconds S]
 *
 * Remote-gate reuse (decideGate, runGate): scripts/pregate-remote-gate.sh asks whether Test and E2E already
 * passed their complete full runs on this exact tree; exit 0 reuse, 3 a full run on the tree failed, 4 no reuse.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { fetchArtifactJson, inert, restClient, type GitHubClient } from './lib/gh-issue.ts';

export const PROFILES = {
  test: { file: 'test.yml', workflow: 'Test', job: 'full-suite', artifact: 'full-suite-tree' },
  e2e: { file: 'e2e.yml', workflow: 'E2E Tests', job: 'e2e-full-suite', artifact: 'e2e-full-suite-tree' },
} as const;
export type Profile = (typeof PROFILES)[keyof typeof PROFILES];
export const TREE_FILE = 'tree.json';
/** The push run's marker job and artifact when it reused a run; scripts/release-gate.ts reads both. */
export const REUSE_JOB = 'reused-full-suite';
export const REUSE_ARTIFACT = 'reused-full-suite';
export const REUSE_FILE = 'reuse.json';
const MAX_FALLBACK_HEADS = 20;
const SHA = /^[0-9a-f]{40}$/;
/** Full runs have the push shape; pull_request runs are the cheap tier. */
export const CANDIDATE_EVENTS = ['workflow_dispatch', 'push'] as const;
const isCandidate = (run: FullRun) => (CANDIDATE_EVENTS as readonly string[]).includes(run.event);

export interface Commit { tree: string; parents: string[] }
export interface FullRun { id: number; run_number: number; run_attempt: number; status: string; conclusion: string | null; head_sha: string; event: string; head_repository?: { full_name: string } | null }
export interface JobRow { name: string; status?: string; conclusion: string | null }
export interface ReuseDeps {
  commit(sha: string): Promise<Commit>;
  runsForHead(file: string, sha: string): Promise<FullRun[]>;
  recentSuccessfulRuns(file: string): Promise<FullRun[]>;
  jobs(runId: number, attempt: number): Promise<JobRow[]>;
  artifact(runId: number, name: string): Promise<{ value?: unknown; reason?: string }>;
}
export type Reason =
  | 'identical_tree_full_run' | 'not_merge_commit' | 'api_error' | 'no_candidate' | 'fork_run'
  | 'run_in_progress' | 'run_cancelled' | 'run_failed' | 'full_suite_missing' | 'full_suite_ambiguous' | 'full_suite_not_success'
  | 'artifact_missing' | 'artifact_mismatch' | 'artifact_not_full' | 'tree_mismatch';
export interface Rejection { run_id: number; reason: Reason; detail: string }
export interface Decision { reuse: boolean; reason: Reason; detail: string; tree?: string; source?: { run_id: number; run_attempt: number; sha: string }; rejected: Rejection[] }

async function reject(deps: ReuseDeps, p: Profile, run: FullRun, repo: string, pushTree: string, headTree: string): Promise<Omit<Rejection, 'run_id'> | undefined> {
  const at = `run ${run.id} attempt ${run.run_attempt}`;
  if (run.head_repository?.full_name !== repo) return { reason: 'fork_run', detail: `${at} ran for ${run.head_repository?.full_name ?? 'an unknown repository'}, not ${repo}` };
  if (run.status !== 'completed') return { reason: 'run_in_progress', detail: `${at} is ${run.status}` };
  if (run.conclusion === 'cancelled') return { reason: 'run_cancelled', detail: `${at} was cancelled` };
  if (run.conclusion !== 'success') return { reason: 'run_failed', detail: `${at} concluded ${run.conclusion}` };
  const jobs = (await deps.jobs(run.id, run.run_attempt)).filter(j => j.name === p.job);
  if (jobs.length === 0) return { reason: 'full_suite_missing', detail: `${at} has no ${p.job} job (not a full-profile run)` };
  if (jobs.length > 1) return { reason: 'full_suite_ambiguous', detail: `${at} has ${jobs.length} jobs named ${p.job}` };
  if (jobs[0]!.conclusion !== 'success') return { reason: 'full_suite_not_success', detail: `${at}'s ${p.job} job concluded ${jobs[0]!.conclusion}` };
  const got = await deps.artifact(run.id, p.artifact);
  if (got.reason) return { reason: 'artifact_missing', detail: got.reason };
  const rec = got.value as Record<string, unknown> | null;
  if (!rec || typeof rec !== 'object') return { reason: 'artifact_mismatch', detail: `${at}'s ${p.artifact} ${TREE_FILE} is not a JSON object` };
  if (rec.profile !== 'full') return { reason: 'artifact_not_full', detail: `${at}'s ${p.artifact} records profile ${String(rec.profile)}` };
  const expected: Array<[string, string | number]> = [['run_id', run.id], ['run_attempt', run.run_attempt], ['sha', run.head_sha], ['event', run.event], ['workflow', p.workflow]];
  if (rec.head_sha !== undefined) expected.push(['head_sha', run.head_sha]);
  const wrong = expected.filter(([k, v]) => rec[k] !== v);
  if (wrong.length) return { reason: 'artifact_mismatch', detail: `${at}'s ${p.artifact} records ${wrong.map(([k, v]) => `${k} ${String(rec[k])} (expected ${v})`).join(', ')}` };
  if (rec.tree !== pushTree) return { reason: 'tree_mismatch', detail: `${at} tested tree ${String(rec.tree)}, the push tree is ${pushTree}` };
  if (rec.tree !== headTree) return { reason: 'tree_mismatch', detail: `${at} recorded tree ${String(rec.tree)} but its head ${run.head_sha} has tree ${headTree}` };
  return undefined;
}

/** The reuse decision for push commit `sha` (pure over its dependencies; every failure is a fallback). */
export async function decide(deps: ReuseDeps, p: Profile, sha: string, repo: string): Promise<Decision> {
  const rejected: Rejection[] = [];
  let tree: string | undefined;
  try {
    const push = await deps.commit(sha);
    tree = push.tree;
    if (push.parents.length !== 2) return { reuse: false, reason: 'not_merge_commit', detail: `push ${sha} has ${push.parents.length} parent(s); only a two-parent merge commit can reuse its merged head's run`, tree, rejected };
    const head = push.parents[1]!;
    const headTree = (await deps.commit(head)).tree;
    const primary = (await deps.runsForHead(p.file, head)).filter(r => r.head_sha === head && isCandidate(r)).sort((a, b) => b.id - a.id);
    for (const run of primary) {
      const why = await reject(deps, p, run, repo, tree, headTree);
      if (!why) return accept(run, tree, rejected, 'the merged head');
      rejected.push({ run_id: run.id, ...why });
    }
    const tried = new Set(primary.map(r => r.id));
    const heads = new Map<string, string>();
    for (const run of (await deps.recentSuccessfulRuns(p.file)).sort((a, b) => b.id - a.id)) {
      if (tried.has(run.id) || !isCandidate(run) || run.head_sha === head || run.head_sha === sha || run.head_repository?.full_name !== repo) continue;
      if (!heads.has(run.head_sha)) {
        if (heads.size >= MAX_FALLBACK_HEADS) continue;
        heads.set(run.head_sha, (await deps.commit(run.head_sha)).tree);
      }
      if (heads.get(run.head_sha) !== tree) continue;
      const why = await reject(deps, p, run, repo, tree, tree);
      if (!why) return accept(run, tree, rejected, `head ${run.head_sha.slice(0, 12)} (same tree as the merged head)`);
      rejected.push({ run_id: run.id, ...why });
    }
  } catch (e) {
    return { reuse: false, reason: 'api_error', detail: `reading the push commit, runs, jobs or artifacts failed: ${e instanceof Error ? e.message : String(e)}`, tree, rejected };
  }
  if (!rejected.length) return { reuse: false, reason: 'no_candidate', detail: `no ${p.workflow} workflow_dispatch or push run exists on the merged head or on another head with tree ${tree}`, tree, rejected };
  return { reuse: false, reason: rejected[0]!.reason, detail: rejected.map(r => r.detail).join('; '), tree, rejected };
}

function accept(run: FullRun, tree: string, rejected: Rejection[], where: string): Decision {
  return { reuse: true, reason: 'identical_tree_full_run', detail: `run ${run.id} attempt ${run.run_attempt} on ${where} ran the complete full suite on tree ${tree}`, tree, source: { run_id: run.id, run_attempt: run.run_attempt, sha: run.head_sha }, rejected };
}

/**
 * Remote-gate reuse (scripts/pregate-remote-gate.sh, docs/ci-event-parity.md#remote-gate-reuse): GitHub's full
 * profile is the source of truth, so a clean working tree whose commit `head` (or another head with the same tree)
 * already passed the complete full run of a workflow needs no Ubicloud gate. Same fail-closed checks as a push:
 * the run's latest attempt and its full-suite job succeeded and its tested-tree artifact records `tree`. Only
 * the identical tree reuses; a stamp-only difference goes through gstack-pregate's stamp rule, never through here.
 * The newest full run on the tree decides, across `head` and every other recent head with the same tree: in progress
 * waits, a failure refuses (no receipt, no VMs), cancelled or not a full run (its full job skipped or absent: a
 * diagnostic dispatch, a push that reused) looks further back; anything else is `none` and the caller runs the VM gate.
 */
export type GateState = 'reuse' | 'pending' | 'failed' | 'none';
export interface GateDecision { state: GateState; detail: string; tests?: number; failed?: number; url?: string }
export interface GateDeps extends ReuseDeps {
  /** The newest workflow_dispatch and push runs of `file`, whatever their status (a failed run counts against its tree too). */
  recentRuns(file: string): Promise<FullRun[]>;
  /** Executed (pass, fail) test identities in the run's executed-identities artifact, or why they cannot be read. */
  executed(runId: number): Promise<{ tests: number; failed: number } | { reason: string }>;
}

export async function decideGate(deps: GateDeps, p: Profile, head: string, tree: string, repo: string): Promise<GateDecision> {
  const rejected: Rejection[] = [];
  try {
    const headTree = (await deps.commit(head)).tree;
    if (headTree !== tree) return { state: 'none', detail: `${p.workflow}: commit ${head} has tree ${headTree} on GitHub, not the working tree ${tree}` };
    const shas = [head];
    const trees = new Map<string, string>();
    for (const run of (await deps.recentRuns(p.file)).sort((a, b) => b.id - a.id)) {
      if (!isCandidate(run) || run.head_sha === head || run.head_repository?.full_name !== repo || trees.has(run.head_sha)) continue;
      if (trees.size >= MAX_FALLBACK_HEADS) break;
      trees.set(run.head_sha, (await deps.commit(run.head_sha)).tree);
      if (trees.get(run.head_sha) === tree) shas.push(run.head_sha);
    }
    const runs = (await Promise.all(shas.map(async sha => (await deps.runsForHead(p.file, sha)).filter(r => r.head_sha === sha && isCandidate(r))))).flat().sort((a, b) => b.id - a.id);
    for (const run of runs) {
      const full = (await deps.jobs(run.id, run.run_attempt)).filter(j => j.name === p.job);
      if (full.some(j => j.conclusion === 'skipped') || (run.status === 'completed' && full.length === 0)) {
        rejected.push({ run_id: run.id, reason: 'full_suite_missing', detail: `run ${run.id} attempt ${run.run_attempt} did not run ${p.job} (not a full-profile run)` });
        continue;
      }
      const why = await reject(deps, p, run, repo, tree, tree);
      if (!why) return gateAccept(deps, p, run, tree, repo);
      if (why.reason === 'run_in_progress') return { state: 'pending', detail: `${p.workflow} ${why.detail}` };
      if (why.reason === 'run_failed' || why.reason === 'full_suite_not_success') return { state: 'failed', detail: `${p.workflow} ${why.detail}`, url: runUrl(repo, run) };
      rejected.push({ run_id: run.id, ...why });
    }
  } catch (e) {
    return { state: 'none', detail: `${p.workflow}: reading commits, runs, jobs or artifacts failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { state: 'none', detail: rejected.length ? `${p.workflow}: ${rejected.map(r => r.detail).join('; ')}` : `${p.workflow}: no workflow_dispatch or push run on ${head} or on another head with tree ${tree}` };
}

const runUrl = (repo: string, run: FullRun) => `https://github.com/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}`;

async function gateAccept(deps: GateDeps, p: Profile, run: FullRun, tree: string, repo: string): Promise<GateDecision> {
  const counts = await deps.executed(run.id);
  if ('reason' in counts) return { state: 'none', detail: `${p.workflow}: ${counts.reason}` };
  if (counts.tests <= 0) return { state: 'none', detail: `${p.workflow}: run ${run.id}'s executed-identities artifact lists no executed test` };
  return { state: 'reuse', detail: `${p.workflow} run ${runUrl(repo, run)} passed the complete full suite on tree ${tree}`, url: runUrl(repo, run), ...counts };
}

/**
 * The gate's decision over Test and E2E, waiting while a full run on the tree is still in progress. Prints progress
 * at least every poll (gstack's stall timeout kills a silent gate) and, on reuse, a last line
 * `GBRAIN_REUSE_RESULT tests=<n> failed=<n>`. Exit codes: 0 reuse, 3 a full run on this tree failed, 4 no reuse.
 */
export async function runGate(deps: GateDeps, o: { head: string; tree: string; repo: string; waitMs: number; pollMs: number; log: (line: string) => void; sleep?: (ms: number) => Promise<unknown>; now?: () => number }): Promise<number> {
  const now = o.now ?? Date.now;
  const deadline = now() + o.waitMs;
  for (;;) {
    const ds = await Promise.all([PROFILES.test, PROFILES.e2e].map(p => decideGate(deps, p, o.head, o.tree, o.repo)));
    const failed = ds.find(d => d.state === 'failed');
    if (failed) {
      o.log(`[ci-reuse] gate: ${failed.detail} (${failed.url}); the full run on this tree failed, so no receipt and no Ubicloud gate`);
      return 3;
    }
    if (ds.every(d => d.state === 'reuse')) {
      for (const d of ds) o.log(`[ci-reuse] gate: ${d.detail} (${d.tests} tests, ${d.failed} failed)`);
      o.log(`GBRAIN_REUSE_RESULT tests=${ds.reduce((n, d) => n + d.tests!, 0)} failed=${ds.reduce((n, d) => n + d.failed!, 0)}`);
      return 0;
    }
    const pending = ds.filter(d => d.state === 'pending');
    if (!pending.length || now() >= deadline) {
      for (const d of ds.filter(x => x.state !== 'reuse')) o.log(`[ci-reuse] gate: no reuse: ${inert(d.detail, 600)}`);
      return 4;
    }
    o.log(`[ci-reuse] gate: waiting for ${pending.map(d => d.detail).join('; ')} (${Math.ceil((deadline - now()) / 60_000)} min left)`);
    await (o.sleep ?? Bun.sleep)(o.pollMs);
  }
}

/**
 * Every job of one attempt. The jobs API pages at up to 100, but GitHub has answered a 100-job page of a rerun attempt
 * with a 502 on every retry while 30-job pages of the same attempt answered (Release run 39712021085, v0.60.361.0), so a
 * 5xx that outlives the client's retries restarts the listing at 30 per page.
 */
export async function attemptJobs(client: GitHubClient, runId: number, attempt: number): Promise<JobRow[]> {
  for (const perPage of [100, 30]) {
    const out: JobRow[] = [];
    try {
      for (let page = 1; page * perPage <= 1000; page++) {
        const r = await client.request<{ total_count: number; jobs: JobRow[] }>('GET', `repos/{repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${perPage}&page=${page}`);
        out.push(...r.jobs);
        if (r.jobs.length < perPage || out.length >= r.total_count) return out;
      }
    } catch (e) {
      if (perPage === 30 || ((e as { status?: number }).status ?? 0) < 500) throw e;
      continue;
    }
    throw new Error(`run ${runId} attempt ${attempt} lists more than 1000 jobs`);
  }
  throw new Error('unreachable');
}

export function apiDeps(client: GitHubClient): ReuseDeps {
  return {
    async commit(sha) {
      const c = await client.request<{ tree: { sha: string }; parents: Array<{ sha: string }> }>('GET', `repos/{repo}/git/commits/${sha}`);
      return { tree: c.tree.sha, parents: c.parents.map(x => x.sha) };
    },
    async runsForHead(file, sha) {
      return (await client.request<{ workflow_runs: FullRun[] }>('GET', `repos/{repo}/actions/workflows/${file}/runs?head_sha=${sha}&per_page=100`)).workflow_runs;
    },
    async recentSuccessfulRuns(file) {
      const pages = await Promise.all(CANDIDATE_EVENTS.map(event => client.request<{ workflow_runs: FullRun[] }>('GET', `repos/{repo}/actions/workflows/${file}/runs?event=${event}&status=success&per_page=100`)));
      return pages.flatMap(p => p.workflow_runs);
    },
    jobs: (runId, attempt) => attemptJobs(client, runId, attempt),
    artifact: (runId, name) => fetchArtifactJson(client, runId, name, TREE_FILE),
  };
}

export function gateDeps(client: GitHubClient): GateDeps {
  return {
    ...apiDeps(client),
    async recentRuns(file) {
      const pages = await Promise.all(CANDIDATE_EVENTS.map(event => client.request<{ workflow_runs: FullRun[] }>('GET', `repos/{repo}/actions/workflows/${file}/runs?event=${event}&per_page=100`)));
      return pages.flatMap(p => p.workflow_runs);
    },
    async executed(runId) {
      const got = await fetchArtifactJson(client, runId, 'executed-identities', 'executed-identities.json');
      if (got.reason) return { reason: got.reason };
      const ids = (got.value as { head?: { identities?: Array<{ status?: string }> } } | null)?.head?.identities;
      if (!Array.isArray(ids)) return { reason: `run ${runId}'s executed-identities.json has no head.identities list` };
      return { tests: ids.filter(i => i.status === 'pass' || i.status === 'fail').length, failed: ids.filter(i => i.status === 'fail').length };
    },
  };
}

/** The validated source run of a reuse record, or why the record cannot prove one. */
export function checkRecord(value: unknown, workflow: string, pushSha: string): { run_id: number; run_attempt: number; sha: string } | string {
  const rec = value as Record<string, unknown> | null | undefined;
  if (!rec || typeof rec !== 'object') return `${REUSE_FILE} is not a JSON object`;
  if (rec.reuse !== true) return `${REUSE_FILE} says reuse is not true`;
  if (rec.workflow !== workflow) return `${REUSE_FILE} is for workflow ${String(rec.workflow)}, not ${workflow}`;
  if (rec.push_sha !== pushSha) return `${REUSE_FILE} is for push ${String(rec.push_sha)}, not ${pushSha}`;
  const id = rec.source_run_id, attempt = rec.source_run_attempt, sha = rec.source_sha;
  if (!Number.isSafeInteger(id) || (id as number) <= 0 || !Number.isSafeInteger(attempt) || (attempt as number) <= 0 || typeof sha !== 'string' || !SHA.test(sha)) return `${REUSE_FILE} names no valid source run`;
  return { run_id: id as number, run_attempt: attempt as number, sha };
}

export function writeDecision(d: Decision, p: Profile, opts: { repo: string; sha: string; output: string; summary?: string; record?: string }): string {
  const url = d.source && `https://github.com/${opts.repo}/actions/runs/${d.source.run_id}/attempts/${d.source.run_attempt}`;
  appendFileSync(opts.output, [
    `reuse=${d.reuse}`, `source_run_id=${d.source?.run_id ?? ''}`, `source_run_attempt=${d.source?.run_attempt ?? ''}`,
    `source_sha=${d.source?.sha ?? ''}`, `tree=${d.tree ?? ''}`, `reason=${d.reason}`, '',
  ].join('\n'));
  const line = d.reuse
    ? `${p.workflow} push ${opts.sha.slice(0, 12)}: reused the complete full-suite run ${url} (head ${d.source!.sha.slice(0, 12)}, identical tree ${d.tree}).`
    : `${p.workflow} push ${opts.sha.slice(0, 12)}: full run, no reuse (reason \`${d.reason}\`: ${inert(d.detail, 600)}).`;
  if (opts.summary) appendFileSync(opts.summary, `${line}\n`);
  if (opts.record) {
    writeFileSync(opts.record, `${JSON.stringify({
      reuse: d.reuse, workflow: p.workflow, push_sha: opts.sha, tree: d.tree ?? null, reason: d.reason,
      source_run_id: d.source?.run_id ?? null, source_run_attempt: d.source?.run_attempt ?? null, source_sha: d.source?.sha ?? null, source_url: url ?? null,
    }, null, 2)}\n`);
  }
  return line;
}

if (import.meta.main && process.argv.includes('--gate')) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const head = flag('--sha') ?? '', tree = flag('--tree') ?? '', repo = flag('--repo') ?? '';
  const minutes = Number(flag('--wait-minutes') ?? '90'), poll = Number(flag('--poll-seconds') ?? '60');
  if (!SHA.test(head) || !SHA.test(tree) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !(minutes >= 0) || !(poll > 0)) {
    console.log('Usage: bun scripts/ci-reuse.ts --gate --sha <40-hex HEAD> --tree <40-hex tree> --repo <owner/name> [--wait-minutes 90] [--poll-seconds 60]');
    process.exit(2);
  }
  process.exit(await runGate(gateDeps(restClient(repo)), { head, tree, repo, waitMs: minutes * 60_000, pollMs: poll * 1000, log: line => console.log(line) }));
} else if (import.meta.main) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const key = flag('--workflow') ?? '';
  const sha = flag('--sha') ?? '';
  const repo = flag('--repo') ?? '';
  const output = flag('--output');
  if (!(key === 'test' || key === 'e2e') || !SHA.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !output) {
    console.log('Usage: bun scripts/ci-reuse.ts --workflow test|e2e --sha <40-hex push sha> --repo <owner/name> --output <GITHUB_OUTPUT> [--summary <GITHUB_STEP_SUMMARY>] [--record <reuse.json>]');
    process.exit(2);
  }
  const p = PROFILES[key];
  const d = await decide(apiDeps(restClient(repo)), p, sha, repo);
  console.log(`[ci-reuse] ${writeDecision(d, p, { repo, sha, output, summary: flag('--summary'), record: flag('--record') })}`);
}
