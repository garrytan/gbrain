#!/usr/bin/env bun
/**
 * scripts/native/heartbeat-finalize.ts: the Linux watcher that ends every darwin-x64 heartbeat a cell left pending.
 *
 * A darwin-x64 cell posts its own terminal `success` status (scripts/native/heartbeat.sh stop), but that runner sometimes
 * cannot reach the API when the cell ends: on #7499 all three attempts of the terminal post timed out, so
 * `diag/native-heartbeat/darwin-x64/1.4.4` stayed pending on a job that passed. This job runs after every native cell,
 * on a Linux runner, reads each darwin-x64 cell's conclusion from the run, and posts `success` naming that conclusion on
 * any cell context whose latest status is still pending. A context the cell finished itself, or never posted, is left alone.
 * The description names the cell, its real conclusion and the time of its last heartbeat, so a wedge stays readable.
 *
 * Reads GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_API_URL, GITHUB_SERVER_URL and GBRAIN_HEARTBEAT_SHA; does
 * nothing unless GBRAIN_HEARTBEAT_ENABLED=1 (a fork's pull request token cannot write). A failure is a warning, never a
 * failed job: the status is diagnostic.
 */

const env = process.env;
const api = env.GITHUB_API_URL ?? 'https://api.github.com';
const repo = env.GITHUB_REPOSITORY ?? '';
const sha = env.GBRAIN_HEARTBEAT_SHA ?? '';
const backoffMs = Number(env.GBRAIN_HEARTBEAT_FINALIZE_BACKOFF_MS ?? 2000);
const CELL = /(?:^|\/ )darwin-x64 \/ Bun (\S+)$/;

type Job = { name: string; status: string; conclusion: string | null; html_url: string };
type Status = { context: string; state: string; created_at: string };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${api}${path}`, { method, signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${env.GH_TOKEN ?? ''}`, Accept: 'application/vnd.github+json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.ok) return await response.json() as T;
      last = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      last = error instanceof Error ? error.name : 'request failed';
    }
    if (attempt < 3) await Bun.sleep(backoffMs * attempt);
  }
  throw new Error(`${method} ${path.split('?')[0]} failed: ${last}`);
}

async function latestStatus(context: string): Promise<Status | null> {
  for (let page = 1; page <= 10; page++) {
    const statuses = await call<Status[]>('GET', `/repos/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`);
    const hit = statuses.find(status => status.context === context);
    if (hit) return hit;
    if (statuses.length < 100) return null;
  }
  return null;
}

async function main(): Promise<void> {
  if (env.GBRAIN_HEARTBEAT_ENABLED !== '1') return;
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const batch = await call<{ jobs: Job[] }>('GET', `/repos/${repo}/actions/runs/${env.GITHUB_RUN_ID ?? ''}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...batch.jobs);
    if (batch.jobs.length < 100) break;
  }
  for (const job of jobs) {
    const bun = CELL.exec(job.name)?.[1];
    if (!bun || job.status !== 'completed') continue;
    const cell = `darwin-x64/${bun}`.replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 32);
    const context = `diag/native-heartbeat/${cell}`;
    const latest = await latestStatus(context);
    if (!latest || latest.state !== 'pending') { console.log(`${context}: ${latest ? `already ${latest.state}` : 'no heartbeat'}`); continue; }
    const conclusion = (job.conclusion ?? 'unknown').replace(/[^a-z_]/g, '').slice(0, 16);
    const description = `${cell} finished ${conclusion} | finalized by the watcher job; last heartbeat ${latest.created_at.slice(11, 19)}Z`.slice(0, 140);
    await call('POST', `/repos/${repo}/statuses/${sha}`, { state: 'success', context, description, target_url: job.html_url });
    console.log(`${context}: finalized (${conclusion}; the cell's own terminal post never landed)`);
  }
}

export {};
await main().catch(error => { console.log(`::warning::darwin-x64 heartbeat finalize: ${error instanceof Error ? error.message : String(error)}`); });
