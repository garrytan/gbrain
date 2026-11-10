#!/usr/bin/env bun
/**
 * Release CI gate (green master wave, Garry-approved release gating).
 *
 *   bun scripts/release-gate.ts --sha <sha> --version <v> [--ref refs/heads/master] [--repo owner/name]
 *        [--timeout-minutes 110] [--poll-seconds 60] [--output <file>] [--event push|workflow_dispatch]
 *
 * release.yml publishes a release, and moves `latest-stable`, only for a
 * commit whose push-to-master runs of Test and E2E Tests both succeeded.
 * The gate polls those runs for the release SHA:
 *
 * - both green: publish that SHA;
 * - either failed (failure, timed out, startup failure): no publish; the
 *   job fails naming the run, the master-red issue and the next command;
 * - either cancelled or skipped: no publish; the job fails naming the re-run.
 *   Master push runs are keyed by commit (test.yml, e2e.yml concurrency), so
 *   a newer push never cancels them, and under releases per batch a later
 *   master commit with the same VERSION may carry unreleased changes, so the
 *   gate never publishes another commit in the release commit's place;
 * - still running, or not created yet: wait, up to --timeout-minutes, then
 *   fail naming the re-run of this Release run, which gates the same commit.
 *
 * A workflow_dispatch backfill (--event workflow_dispatch) resolves the
 * release commit, the first-parent commit that last changed VERSION, and
 * gates only that commit: when master HEAD is a later commit it publishes
 * nothing and names the re-run of the release commit's push Release run, so
 * later landings are never published under the release's notes. Writes
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
 * Exit 0 publish, 1 no publish (failed, timed out, not master),
 * 2 usage. Docs: docs/RELEASING.md#release-ci-gate
 */
import { appendFileSync } from 'node:fs';
import { attemptJobs, checkRecord, REUSE_ARTIFACT, REUSE_FILE, REUSE_JOB } from './ci-reuse.ts';
import { fetchArtifactJson, restClient, type GitHubClient } from './lib/gh-issue.ts';

export const GATED = [{ file: 'test.yml', name: 'Test', key: 'test' }, { file: 'e2e.yml', name: 'E2E Tests', key: 'e2e' }] as const;
export const DOCS = 'docs/RELEASING.md#release-ci-gate';
const RED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const RERUN = `re-run this Release run (gh run rerun ${process.env.GITHUB_RUN_ID ?? '<this Release run id>'}), which gates the same release commit; a dispatch on master refuses once master HEAD has moved past it`;

export interface GateRun { id: number; run_number: number; run_attempt: number; status: string; conclusion: string | null; head_sha: string; head_branch: string; event: string; html_url?: string }
export interface ReusedRun { run_id: number; run_attempt: number; sha: string }
/** Whether a green push run reused a pull request run's full suite (`problem`: it did, but its record cannot name the run). */
export type Provenance = { reused: false } | ({ reused: true } & ReusedRun) | { problem: string };
export interface Source { workflow: string; key: string; run_id: number; reused?: ReusedRun }
export type Verdict =
  | { kind: 'publish'; sha: string; why: string; sources: Source[] }
  | { kind: 'wait'; sha: string; why: string }
  | { kind: 'fail'; sha: string; why: string; next: string };

export interface GateDeps {
  runsFor(file: string, sha: string): Promise<GateRun[]>;
  provenance(file: string, run: GateRun): Promise<Provenance>;
}
export interface CommitDeps {
  firstParent(sha: string): Promise<string | null>;
  versionAt(sha: string): Promise<string>;
}
const WALK_LIMIT = 500;

/** What a workflow_dispatch on master HEAD may gate: the release commit (the first-parent commit that last changed VERSION) when HEAD is it, else nothing. */
export async function dispatchTarget(deps: CommitDeps, head: string, version: string): Promise<{ kind: 'gate'; sha: string } | { kind: 'fail'; sha: string; why: string; next: string }> {
  let release = head;
  for (let i = 0; ; i++) {
    if (i === WALK_LIMIT) throw new Error(`no commit changed VERSION to ${version} within ${WALK_LIMIT} first parents of ${head.slice(0, 12)}`);
    const parent = await deps.firstParent(release);
    if (!parent || (await deps.versionAt(parent)) !== version) break;
    release = parent;
  }
  if (release === head) return { kind: 'gate', sha: release };
  return {
    kind: 'fail', sha: release,
    why: `this dispatch runs on master HEAD ${head.slice(0, 12)}, but v${version}'s release commit is ${release.slice(0, 12)} (the commit that last changed VERSION). The commits after it landed later and their notes are not in v${version}, so a dispatch never publishes them under that version`,
    next: `re-run the push Release run of the release commit: gh run rerun "$(gh run list --workflow release.yml --commit ${release} --event push --limit 1 --json databaseId --jq '.[0].databaseId')". Changes landed after it ship in the next release (gstack-release-stamp open)`,
  };
}

const newest = (runs: GateRun[]) => [...runs].sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];

/** One evaluation of the gate for a release SHA (pure over its dependencies). */
export async function evaluate(deps: GateDeps, sha: string, version: string): Promise<Verdict> {
  const runs = await Promise.all(GATED.map(async wf => ({ wf, run: newest((await deps.runsFor(wf.file, sha)).filter(r => r.event === 'push' && r.head_branch === 'master')) })));
  const failed = runs.find(r => r.run && r.run.status === 'completed' && RED.has(r.run.conclusion ?? ''));
  if (failed) {
    return {
      kind: 'fail', sha,
      why: `${failed.wf.name} run ${failed.run!.id} (${failed.run!.html_url ?? `run ${failed.run!.run_number}`}) ended ${failed.run!.conclusion} on ${sha.slice(0, 12)}, so v${version} is not published and latest-stable does not move. Releases publish only commits master CI passed.`,
      next: `Repair master (the open "Master red: ${failed.wf.name}" issue names the failing tests; docs/RELEASING.md#master-red-issues). If the failure is outside the release commit, re-run that run (gh run rerun ${failed.run!.id}) and, once it is green, ${RERUN}. Otherwise land the repair and open the next release.`,
    };
  }
  const cancelled = runs.find(r => r.run && r.run.status === 'completed' && (r.run.conclusion === 'cancelled' || r.run.conclusion === 'skipped'));
  if (cancelled) {
    return {
      kind: 'fail', sha,
      why: `${cancelled.wf.name} run ${cancelled.run!.id} on ${sha.slice(0, 12)} ended ${cancelled.run!.conclusion}, so v${version} is not published. Master push runs are keyed by commit, so a newer push never cancels them, and a later master commit may carry unreleased changes under the same VERSION, so the gate never publishes one in its place.`,
      next: `Re-run it (gh run rerun ${cancelled.run!.id}); once Test and E2E Tests are green on ${sha.slice(0, 12)}, ${RERUN}`,
    };
  }
  const pending = runs.filter(r => !r.run || r.run.status !== 'completed');
  if (pending.length) return { kind: 'wait', sha, why: pending.map(r => `${r.wf.name} ${r.run ? `run ${r.run.id} is ${r.run.status}` : 'has no push run yet'} on ${sha.slice(0, 12)}`).join('; ') };
  const proven = await Promise.all(runs.map(async r => ({ wf: r.wf, run: r.run!, prov: await deps.provenance(r.wf.file, r.run!) })));
  const unproven = proven.find(p => 'problem' in p.prov);
  if (unproven && 'problem' in unproven.prov) {
    return {
      kind: 'fail', sha,
      why: `${unproven.wf.name} run ${unproven.run.id} reused an earlier full-suite run on ${sha.slice(0, 12)}, but its reuse record cannot name that run (${unproven.prov.problem}), so v${version} is not published. A release names the run that proved its tree.`,
      next: `Re-run that push run (gh run rerun ${unproven.run.id}); it decides reuse again and records it, or runs the full suite. Once it is green, ${RERUN}`,
    };
  }
  const sources: Source[] = proven.map(p => ({ workflow: p.wf.name, key: p.wf.key, run_id: p.run.id, ...('run_id' in p.prov ? { reused: { run_id: p.prov.run_id, run_attempt: p.prov.run_attempt, sha: p.prov.sha } } : {}) }));
  const how = sources.map(s => s.reused ? `${s.workflow} reused full-suite run ${s.reused.run_id} attempt ${s.reused.run_attempt} (pull request head ${s.reused.sha.slice(0, 12)}, identical tree)` : `${s.workflow} ran in full in run ${s.run_id}`).join('; ');
  return { kind: 'publish', sha, sources, why: `Test and E2E Tests both succeeded on ${sha.slice(0, 12)}: ${how}` };
}

export function apiDeps(client: GitHubClient): GateDeps & CommitDeps {
  return {
    async firstParent(sha) {
      return (await client.request<{ parents: Array<{ sha: string }> }>('GET', `repos/{repo}/commits/${sha}`)).parents[0]?.sha ?? null;
    },
    async versionAt(sha) {
      return Buffer.from((await client.request<{ content: string }>('GET', `repos/{repo}/contents/VERSION?ref=${sha}`)).content, 'base64').toString('utf8').trim();
    },
    async runsFor(file, sha) {
      return (await client.request<{ workflow_runs: GateRun[] }>('GET', `repos/{repo}/actions/workflows/${file}/runs?head_sha=${sha}&event=push&per_page=20`)).workflow_runs;
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
      return { kind: 'fail', sha: v.sha, why: `Test and E2E Tests did not finish on ${v.sha.slice(0, 12)} within ${Math.round(opts.timeoutMs / 60_000)} minutes (${v.why})`, next: `When they finish green, ${RERUN}` };
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
  const event = flag('--event') ?? 'push';
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(version) || !(timeoutMs > 0) || !(pollMs > 0)) {
    console.log('Usage: bun scripts/release-gate.ts --sha <40-hex sha> --version <VERSION> [--ref refs/heads/master] [--repo owner/name] [--timeout-minutes 110] [--poll-seconds 60] [--output <file>] [--event push|workflow_dispatch]');
    process.exit(2);
  }
  const write = (publish: boolean, at: string) => { if (output) appendFileSync(output, `publish=${publish}\nsha=${at}\n`); };
  if (ref !== 'refs/heads/master') {
    console.log(`::error::Release v${version} not published: this run is on ${ref}. Why: releases publish only master commits that master CI passed. Fix: gh workflow run release.yml --ref master. Docs: ${DOCS}`);
    write(false, sha);
    process.exit(1);
  }
  try {
    const api = apiDeps(restClient(repo));
    if (event === 'workflow_dispatch') {
      const d = await dispatchTarget(api, sha, version);
      if (d.kind === 'fail') {
        console.log(`::error::Release v${version} not published: ${d.why}. Next: ${d.next}. Docs: ${DOCS}`);
        write(false, d.sha);
        process.exit(1);
      }
    }
    const v = await gate(api, { sha, version, timeoutMs, pollMs, log: line => console.log(line) });
    if (v.kind === 'publish') {
      console.log(`[release-gate] publish v${version} at ${v.sha}: ${v.why}.`);
      write(true, v.sha);
      if (output) appendFileSync(output, reuseOutputs(v.sources));
    } else {
      console.log(`::error::Release v${version} not published: ${v.kind === 'fail' ? v.why : 'gate ended while waiting'}. Next: ${v.kind === 'fail' ? v.next : RERUN}. Docs: ${DOCS}`);
      write(false, v.sha);
      process.exit(1);
    }
  } catch (e) {
    console.log(`::error::Release v${version} not published: the CI gate could not read the actions API (${e instanceof Error ? e.message : String(e)}). Why: publication waits for Test and E2E Tests success on the release commit. Fix: ${RERUN}. Docs: ${DOCS}`);
    write(false, sha);
    process.exit(1);
  }
}
