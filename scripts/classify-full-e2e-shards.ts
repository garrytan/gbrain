#!/usr/bin/env bun
/**
 * First step of e2e.yml's coverage-full-report (#6040): decide whether the
 * four full E2E shards are complete, were cancelled with their run, or failed.
 *
 * A run cancelled by a newer run in its concurrency group or by a user is
 * reported as cancelled (no coverage, not a test failure). Any other
 * non-success, including a shard that hit its timeout-minutes in a run nobody
 * cancelled, is a failure. The workflow cannot decide this from expressions:
 * cancelled() is false in an always() job that starts after the run was
 * cancelled (dispatch run 37371914954), and needs.<job>.result reads
 * `cancelled` for a timed-out shard too. GitHub stamps each job of a cancelled
 * run with a check-run annotation ("Canceling since a higher priority waiting
 * request for <group> exists" or "The run was canceled by @<user>.") and a
 * timed-out job with "The job running on runner <name> has exceeded the
 * maximum execution time of <n> minutes.", so the shard jobs of this run
 * attempt and their annotations decide it. Evidence that cannot be read is a
 * failure, never a cancellation on a guess.
 *
 * Usage (Actions): FULL_E2E_RESULT=<needs result> GH_TOKEN=<token>
 *   bun scripts/classify-full-e2e-shards.ts
 * Writes state=complete|cancelled to $GITHUB_OUTPUT; exits 0 for complete or
 * cancelled, 1 for failed. Docs: docs/operations/verify-and-nightly-e2e.md#full-corpus-report-states
 */
import { appendFileSync } from 'node:fs';
import { type GitHubClient, inert, restClient } from './lib/gh-issue.ts';

export const DOCS = 'docs/operations/verify-and-nightly-e2e.md#full-corpus-report-states';
const SHARD_JOB = /^coverage-full-e2e \(\d+\)$/;
const RUN_CANCELLED = [/^Canceling since a higher priority waiting request for .+ exists/, /^The run was canceled by /];
const TIMED_OUT = /has exceeded the maximum execution time/;

export interface ShardJob { name: string; conclusion: string | null; annotations: string[] }
export type ShardState = 'complete' | 'cancelled' | 'failed';
export interface Classification { state: ShardState; title: string; message: string }

export interface RunRef { repo: string; runId: string; attempt: string; serverUrl: string }

export function classifyShards(result: string, shards: ShardJob[] | Error, run: RunRef): Classification {
  const url = `${run.serverUrl}/${run.repo}/actions/runs/${run.runId}`;
  const rerun = `Next: gh run view ${run.runId} --log-failed, fix the failing shard, then gh run rerun ${run.runId} --failed. Docs: ${DOCS}`;
  if (result === 'success') return { state: 'complete', title: 'Full E2E shards complete', message: 'All four full E2E shards succeeded.' };
  if (shards instanceof Error) {
    return {
      state: 'failed',
      title: 'Full E2E shard evidence unreadable',
      message: `Full E2E did not succeed (result: ${result || 'none'}) and the shard jobs of ${url} could not be read (${inert(shards.message, 300)}), so a cancellation cannot be told apart from a failure; refusing a report. ${rerun}`,
    };
  }
  const notOk = shards.filter(s => s.conclusion !== 'success');
  const withRun = (s: ShardJob) => s.conclusion === 'cancelled'
    && !s.annotations.some(a => TIMED_OUT.test(a))
    && s.annotations.some(a => RUN_CANCELLED.some(re => re.test(a)));
  if (shards.length > 0 && notOk.length > 0 && notOk.every(withRun)) {
    return {
      state: 'cancelled',
      title: 'Full E2E shards cancelled',
      message: `Full E2E shards cancelled: ${url} was cancelled by a newer run in its concurrency group or by a user before ${notOk.map(s => s.name).join(', ')} finished, so no full-corpus coverage report exists for it. This is not a test failure. Next: gh workflow run e2e.yml --ref master -f full_corpus=true (or wait for the next schedule). Docs: ${DOCS}`,
    };
  }
  const detail = shards.length === 0
    ? 'no coverage-full-e2e shard jobs were found in this run attempt'
    : notOk.map(s => `${s.name}: ${s.conclusion ?? 'no conclusion'}${s.annotations.some(a => TIMED_OUT.test(a)) ? ' (hit timeout-minutes)' : ''}`).join('; ');
  return {
    state: 'failed',
    title: 'Full E2E shards failed',
    message: `Full E2E did not succeed (result: ${result || 'none'}) and the run was not cancelled: ${inert(detail, 600)}. A failed or timed-out shard is a failure; refusing a complete report from prior-attempt artifacts. ${rerun}`,
  };
}

interface JobInfo { id: number; name: string; conclusion: string | null }
interface Annotation { message: string }

export async function readShards(client: GitHubClient, run: RunRef): Promise<ShardJob[] | Error> {
  try {
    const { jobs } = await client.request<{ jobs: JobInfo[] }>('GET', `repos/{repo}/actions/runs/${run.runId}/attempts/${run.attempt}/jobs?per_page=100`);
    const shards = jobs.filter(j => SHARD_JOB.test(j.name));
    return await Promise.all(shards.map(async j => ({
      name: j.name,
      conclusion: j.conclusion,
      annotations: (await client.request<Annotation[]>('GET', `repos/{repo}/check-runs/${j.id}/annotations?per_page=50`)).map(a => a.message.trim()),
    })));
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

export async function main(env: Record<string, string | undefined>, client?: GitHubClient): Promise<number> {
  const run: RunRef = {
    repo: env.GITHUB_REPOSITORY ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
    serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
  };
  const result = env.FULL_E2E_RESULT ?? '';
  const shards = result === 'success' ? [] : await readShards(client ?? restClient(run.repo), run);
  const c = classifyShards(result, shards, run);
  const level = c.state === 'failed' ? 'error' : c.state === 'cancelled' ? 'warning' : 'notice';
  console.log(`::${level} title=${c.title}::${c.message}`);
  if (env.GITHUB_STEP_SUMMARY && c.state !== 'complete') appendFileSync(env.GITHUB_STEP_SUMMARY, `### Full-corpus coverage: ${c.state}\n\n${c.message}\n`);
  if (env.GITHUB_OUTPUT && c.state !== 'failed') appendFileSync(env.GITHUB_OUTPUT, `state=${c.state}\n`);
  return c.state === 'failed' ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.env));
