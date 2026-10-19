#!/usr/bin/env bun
/**
 * Release CI gate (green master wave, Garry-approved release gating).
 *
 *   bun scripts/release-gate.ts --sha <sha> --version <v> [--ref refs/heads/master] [--repo owner/name]
 *        [--timeout-minutes 110] [--poll-seconds 60] [--output <file>]
 *
 * release.yml publishes a release, and moves `latest-stable`, only for a
 * commit whose push-to-master runs of Test and E2E Tests both succeeded.
 * The gate polls those runs for the release SHA:
 *
 * - both green: publish that SHA;
 * - either failed (failure, timed out, startup failure): no publish; the
 *   job fails naming the run, the master-red issue and the next command;
 * - either cancelled by a newer push: follow the next push-to-master run of
 *   that workflow. When its commit contains the release SHA and carries the
 *   same VERSION, the gate re-evaluates both workflows there and publishes
 *   that commit; when VERSION moved on, this version is superseded (the
 *   newer VERSION's own release run publishes; exit 0, publish=false);
 * - still running, or not created yet: wait, up to --timeout-minutes, then
 *   fail with the dispatch backfill command.
 *
 * A workflow_dispatch backfill runs the same gate for master's HEAD, so it
 * publishes the current VERSION once master's CI for HEAD is green. Writes
 * `publish=true|false` and `sha=<commit>` to --output (GITHUB_OUTPUT).
 *
 * Master-push reuse (scripts/ci-reuse.ts, docs/ci-event-parity.md#master-push-reuse):
 * a green push run whose latest attempt has a succeeded `reused-full-suite`
 * job reused a pull request run's full suite. On publish the gate reads that
 * push run's `reused-full-suite` artifact (reuse.json, written by
 * ci-reuse.ts --record), prints the reused run per workflow and writes
 * `test_reused_run_id` / `e2e_reused_run_id` (empty when the push ran in
 * full). A reused job whose record is missing or names another workflow or
 * commit publishes nothing.
 * Exit 0 publish or superseded, 1 no publish (failed, timed out, not master),
 * 2 usage. Docs: docs/RELEASING.md#release-ci-gate
 */
import { appendFileSync } from 'node:fs';
import { attemptJobs, checkRecord, REUSE_ARTIFACT, REUSE_FILE, REUSE_JOB } from './ci-reuse.ts';
import { fetchArtifactJson, restClient, type GitHubClient } from './lib/gh-issue.ts';

export const GATED = [{ file: 'test.yml', name: 'Test', key: 'test' }, { file: 'e2e.yml', name: 'E2E Tests', key: 'e2e' }] as const;
export const DOCS = 'docs/RELEASING.md#release-ci-gate';
const RED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const MAX_HOPS = 10;

export interface GateRun { id: number; run_number: number; run_attempt: number; status: string; conclusion: string | null; head_sha: string; head_branch: string; event: string; html_url?: string }
export interface ReusedRun { run_id: number; run_attempt: number; sha: string }
/** Whether a green push run reused a pull request run's full suite (`problem`: it did, but its record cannot name the run). */
export type Provenance = { reused: false } | ({ reused: true } & ReusedRun) | { problem: string };
export interface Source { workflow: string; key: string; run_id: number; reused?: ReusedRun }
export type Verdict =
  | { kind: 'publish'; sha: string; why: string; sources: Source[] }
  | { kind: 'superseded'; sha: string; why: string }
  | { kind: 'wait'; sha: string; why: string }
  | { kind: 'fail'; sha: string; why: string; next: string };

export interface GateDeps {
  runsFor(file: string, sha: string): Promise<GateRun[]>;
  newerRuns(file: string, after: number): Promise<GateRun[]>;
  versionAt(sha: string): Promise<string>;
  contains(base: string, head: string): Promise<boolean>;
  provenance(file: string, run: GateRun): Promise<Provenance>;
}

const newest = (runs: GateRun[]) => [...runs].sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];

/** One evaluation of the gate for a release SHA (pure over its dependencies). */
export async function evaluate(deps: GateDeps, sha: string, version: string): Promise<Verdict> {
  let candidate = sha;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const runs = await Promise.all(GATED.map(async wf => ({ wf, run: newest((await deps.runsFor(wf.file, candidate)).filter(r => r.event === 'push' && r.head_branch === 'master')) })));
    const failed = runs.find(r => r.run && r.run.status === 'completed' && RED.has(r.run.conclusion ?? ''));
    if (failed) {
      return {
        kind: 'fail', sha: candidate,
        why: `${failed.wf.name} run ${failed.run!.id} (${failed.run!.html_url ?? `run ${failed.run!.run_number}`}) ended ${failed.run!.conclusion} on ${candidate.slice(0, 12)}, so v${version} is not published and latest-stable does not move. Releases publish only commits master CI passed.`,
        next: `Repair master (the open "Master red: ${failed.wf.name}" issue names the failing tests; docs/RELEASING.md#master-red-issues). Once a later push-to-master run of Test and E2E Tests is green, publish the current VERSION with: gh workflow run release.yml --ref master`,
      };
    }
    const cancelled = runs.find(r => r.run && r.run.status === 'completed' && (r.run.conclusion === 'cancelled' || r.run.conclusion === 'skipped'));
    if (cancelled) {
      const successor = (await deps.newerRuns(cancelled.wf.file, cancelled.run!.run_number))
        .filter(r => r.event === 'push' && r.head_branch === 'master' && r.head_sha !== candidate)
        .sort((a, b) => a.run_number - b.run_number)[0];
      if (!successor) return { kind: 'wait', sha: candidate, why: `${cancelled.wf.name} run ${cancelled.run!.id} was cancelled (superseded by a newer push); waiting for the newer push-to-master run` };
      const [moved, inside] = [await deps.versionAt(successor.head_sha), await deps.contains(sha, successor.head_sha)];
      if (!inside) return { kind: 'fail', sha: candidate, why: `${cancelled.wf.name} on ${candidate.slice(0, 12)} was cancelled and the next master run (${successor.head_sha.slice(0, 12)}) does not contain the release commit`, next: 'Re-run the gate after master settles: gh workflow run release.yml --ref master' };
      if (moved !== version) return { kind: 'superseded', sha: successor.head_sha, why: `${cancelled.wf.name} on ${candidate.slice(0, 12)} was cancelled by a newer push that carries VERSION ${moved}; v${version} is superseded and v${moved}'s own release run publishes` };
      candidate = successor.head_sha;
      continue;
    }
    const pending = runs.filter(r => !r.run || r.run.status !== 'completed');
    if (pending.length) return { kind: 'wait', sha: candidate, why: pending.map(r => `${r.wf.name} ${r.run ? `run ${r.run.id} is ${r.run.status}` : 'has no push run yet'} on ${candidate.slice(0, 12)}`).join('; ') };
    const proven = await Promise.all(runs.map(async r => ({ wf: r.wf, run: r.run!, prov: await deps.provenance(r.wf.file, r.run!) })));
    const unproven = proven.find(p => 'problem' in p.prov);
    if (unproven && 'problem' in unproven.prov) {
      return {
        kind: 'fail', sha: candidate,
        why: `${unproven.wf.name} run ${unproven.run.id} reused an earlier full-suite run on ${candidate.slice(0, 12)}, but its reuse record cannot name that run (${unproven.prov.problem}), so v${version} is not published. A release names the run that proved its tree.`,
        next: `Re-run that push run (gh run rerun ${unproven.run.id}); it decides reuse again and records it, or runs the full suite. Once it is green: gh workflow run release.yml --ref master`,
      };
    }
    const sources: Source[] = proven.map(p => ({ workflow: p.wf.name, key: p.wf.key, run_id: p.run.id, ...('run_id' in p.prov ? { reused: { run_id: p.prov.run_id, run_attempt: p.prov.run_attempt, sha: p.prov.sha } } : {}) }));
    const how = sources.map(s => s.reused ? `${s.workflow} reused full-suite run ${s.reused.run_id} attempt ${s.reused.run_attempt} (pull request head ${s.reused.sha.slice(0, 12)}, identical tree)` : `${s.workflow} ran in full in run ${s.run_id}`).join('; ');
    return { kind: 'publish', sha: candidate, sources, why: `Test and E2E Tests both succeeded on ${candidate.slice(0, 12)}${candidate === sha ? '' : ` (the newer master commit that replaced the cancelled runs of ${sha.slice(0, 12)}; same VERSION)`}: ${how}` };
  }
  return { kind: 'fail', sha: candidate, why: `followed ${MAX_HOPS} cancelled runs without a completed one`, next: 'Wait for master to settle, then: gh workflow run release.yml --ref master' };
}

export function apiDeps(client: GitHubClient): GateDeps {
  return {
    async runsFor(file, sha) {
      return (await client.request<{ workflow_runs: GateRun[] }>('GET', `repos/{repo}/actions/workflows/${file}/runs?head_sha=${sha}&event=push&per_page=20`)).workflow_runs;
    },
    async newerRuns(file, after) {
      return (await client.request<{ workflow_runs: GateRun[] }>('GET', `repos/{repo}/actions/workflows/${file}/runs?event=push&branch=master&per_page=30`)).workflow_runs.filter(r => r.run_number > after);
    },
    async versionAt(sha) {
      const file = await client.request<{ content: string }>('GET', `repos/{repo}/contents/VERSION?ref=${sha}`);
      return Buffer.from(file.content, 'base64').toString('utf8').trim();
    },
    async contains(base, head) {
      if (base === head) return true;
      const cmp = await client.request<{ status: string }>('GET', `repos/{repo}/compare/${base}...${head}`);
      return cmp.status === 'ahead' || cmp.status === 'identical';
    },
    async provenance(file, run) {
      const name = GATED.find(g => g.file === file)?.name ?? file;
      const marker = (await attemptJobs(client, run.id, run.run_attempt)).filter(j => j.name === REUSE_JOB);
      if (marker.length === 0 || marker.every(j => j.conclusion === 'skipped')) return { reused: false };
      if (marker.length > 1 || marker[0]!.conclusion !== 'success') return { problem: `run ${run.id}'s ${REUSE_JOB} job concluded ${marker.map(j => j.conclusion).join(', ')}` };
      const got = await fetchArtifactJson(client, run.id, REUSE_ARTIFACT, REUSE_FILE);
      if (got.reason) return { problem: got.reason };
      const rec = checkRecord(got.value, name, run.head_sha);
      return typeof rec === 'string' ? { problem: rec } : { reused: true, ...rec };
    },
  };
}

/** GITHUB_OUTPUT lines naming the run each workflow reused (empty when the push ran in full). */
export function reuseOutputs(sources: Source[]): string {
  return GATED.map(g => `${g.key}_reused_run_id=${sources.find(s => s.key === g.key)?.reused?.run_id ?? ''}\n`).join('');
}

export async function gate(deps: GateDeps, opts: { sha: string; version: string; timeoutMs: number; pollMs: number; log: (line: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<Verdict> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const v = await evaluate(deps, opts.sha, opts.version);
    if (v.kind !== 'wait') return v;
    if (now() >= deadline) {
      return { kind: 'fail', sha: v.sha, why: `Test and E2E Tests did not finish on ${v.sha.slice(0, 12)} within ${Math.round(opts.timeoutMs / 60_000)} minutes (${v.why})`, next: 'When they finish green, publish with: gh workflow run release.yml --ref master' };
    }
    opts.log(`[release-gate] waiting: ${v.why}`);
    await sleep(opts.pollMs);
  }
}

if (import.meta.main) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const sha = flag('--sha') ?? '';
  const version = flag('--version') ?? '';
  const ref = flag('--ref') ?? 'refs/heads/master';
  const repo = flag('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'garrytan/gbrain';
  const timeoutMs = Number(flag('--timeout-minutes') ?? 110) * 60_000;
  const pollMs = Number(flag('--poll-seconds') ?? 60) * 1000;
  const output = flag('--output');
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(version) || !(timeoutMs > 0) || !(pollMs > 0)) {
    console.log('Usage: bun scripts/release-gate.ts --sha <40-hex sha> --version <VERSION> [--ref refs/heads/master] [--repo owner/name] [--timeout-minutes 110] [--poll-seconds 60] [--output <file>]');
    process.exit(2);
  }
  const write = (publish: boolean, at: string) => { if (output) appendFileSync(output, `publish=${publish}\nsha=${at}\n`); };
  if (ref !== 'refs/heads/master') {
    console.log(`::error::Release v${version} not published: this run is on ${ref}. Why: releases publish only master commits that master CI passed. Fix: gh workflow run release.yml --ref master. Docs: ${DOCS}`);
    write(false, sha);
    process.exit(1);
  }
  try {
    const v = await gate(apiDeps(restClient(repo)), { sha, version, timeoutMs, pollMs, log: line => console.log(line) });
    if (v.kind === 'publish') {
      console.log(`[release-gate] publish v${version} at ${v.sha}: ${v.why}.`);
      write(true, v.sha);
      if (output) appendFileSync(output, reuseOutputs(v.sources));
    } else if (v.kind === 'superseded') {
      console.log(`::notice::Release v${version} skipped: ${v.why}. Nothing to do. Docs: ${DOCS}`);
      write(false, v.sha);
    } else {
      console.log(`::error::Release v${version} not published: ${v.kind === 'fail' ? v.why : 'gate ended while waiting'}. Next: ${v.kind === 'fail' ? v.next : 'gh workflow run release.yml --ref master'}. Docs: ${DOCS}`);
      write(false, v.sha);
      process.exit(1);
    }
  } catch (e) {
    console.log(`::error::Release v${version} not published: the CI gate could not read the actions API (${e instanceof Error ? e.message : String(e)}). Why: publication waits for Test and E2E Tests success on the release commit. Fix: re-run this workflow (gh run rerun <this run id>) or gh workflow run release.yml --ref master. Docs: ${DOCS}`);
    write(false, sha);
    process.exit(1);
  }
}
