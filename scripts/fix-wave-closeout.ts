#!/usr/bin/env bun
/**
 * scripts/fix-wave-closeout.ts — the decision behind .github/workflows/fix-wave-closeout.yml.
 *
 * When a same-repo PR (a fix wave on a capy/* or garrytan/* branch) merges into
 * master, every pull request its body names on a `Supersedes #N` line is closed
 * with a thank-you comment that links the merged PR. Issues need no help here:
 * `Fixes #N` in the same body closes them through GitHub itself.
 *
 *   Supersedes #5085
 *   - Supersedes #5089, #5096 and #5107
 *
 * Only the list right after the keyword counts, so in "Supersedes #5140, which
 * conflicts with #5000" only #5140 is closed. A number that is not an open pull request is skipped with a log line, so an
 * issue number or an already-closed PR on a Supersedes line is harmless. The
 * comment is keyed by COMMENT_MARKER, so a re-run never comments twice.
 *
 * The workflow runs on pull_request_target, so this file and the workflow come
 * from the default branch. It reads only the event payload and the REST API; it
 * never checks out or runs PR code, and imports nothing outside the runtime so
 * the workflow can sparse-check-out this one file.
 *
 *   bun scripts/fix-wave-closeout.ts [--event <payload.json>] [--dry-run]
 *
 * --event defaults to $GITHUB_EVENT_PATH. Always exits 0 unless the payload is
 * missing; a failed close is a warning in the run log and step summary.
 * Docs: docs/RELEASING.md#fix-wave-closeout.
 */
import { appendFileSync, readFileSync } from 'node:fs';

export const TRUSTED_HEAD_REPO = 'garrytan/gbrain';
export const COMMENT_MARKER = '<!-- fix-wave-closeout -->';
export const MAX_CLOSES = 50;

interface Repo { id?: number; full_name?: string }
export interface CloseoutEvent {
  action?: string;
  pull_request?: {
    number: number;
    title?: string;
    merged?: boolean;
    body?: string | null;
    head?: { repo?: Repo | null };
    base?: { repo?: Repo | null; ref?: string };
  };
}
export interface PullInfo { number: number; state: string; login: string; title: string }
export interface CloseoutClient {
  getPull(n: number): Promise<PullInfo | null>;
  commentBodies(n: number): Promise<string[]>;
  createComment(n: number, body: string): Promise<void>;
  close(n: number): Promise<void>;
}
export interface Output { line(s: string): void; summary(s: string): void }

/** Pure. PR numbers named on `Supersedes` lines, in order, deduplicated, without `self`. */
export function supersededNumbers(body: string | null | undefined, self: number): number[] {
  const out: number[] = [];
  for (const line of (body ?? '').split('\n')) {
    const lead = /^\s*(?:[-*]\s+)?\**Supersedes\b/i.exec(line);
    if (!lead) continue;
    const list = /^(?:[\s:*,]|and\b|#\d+\b)+/i.exec(line.slice(lead[0].length))?.[0] ?? '';
    for (const m of list.matchAll(/#(\d+)\b/g)) {
      const n = Number(m[1]);
      if (n !== self && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export function isMergedWave(event: CloseoutEvent): boolean {
  const pr = event.pull_request;
  const head = pr?.head?.repo, base = pr?.base?.repo;
  return !!pr?.merged && !!head && !!base && head.full_name === TRUSTED_HEAD_REPO && head.id !== undefined && head.id === base.id;
}

export function closeoutMessage(handle: string, wave: number, waveTitle: string, credited: boolean): string {
  const credit = credited
    ? ` with credit to you: the wave says \`Contributed by @${handle}\` and carries a \`Co-Authored-By:\` trailer.`
    : '.';
  return [
    COMMENT_MARKER,
    `Thank you, @${handle}. Fix-wave PR #${wave} (${waveTitle}) merged into master and supersedes this PR, so the change it proposed has landed there${credit}`,
    '',
    `I'm closing this PR because nothing is left for it to land, not because anything was wrong with it. If part of it didn't make it into #${wave}, reply here with what's missing and the next fix wave will pick it up.`,
    '',
    'This comment comes from the fix-wave closeout workflow.',
  ].join('\n');
}

export async function runCloseout(event: CloseoutEvent, client: CloseoutClient, out: Output, dryRun = false): Promise<number> {
  const pr = event.pull_request;
  if (!pr || !isMergedWave(event)) {
    out.line(`PR #${pr?.number ?? '?'} is not a merged same-repo PR; nothing to close.`);
    return 0;
  }
  const targets = supersededNumbers(pr.body, pr.number);
  if (targets.length === 0) { out.line(`PR #${pr.number} names no Supersedes PRs.`); return 0; }
  const body = pr.body ?? '';
  const rows: string[] = [];
  for (const [i, n] of targets.entries()) {
    if (i >= MAX_CLOSES) { rows.push(`#${n}: skipped, over the ${MAX_CLOSES}-PR cap for one run`); continue; }
    try {
      const target = await client.getPull(n);
      if (!target) { rows.push(`#${n}: skipped, not a pull request`); continue; }
      if (target.state !== 'open') { rows.push(`#${n}: skipped, already ${target.state}`); continue; }
      const credited = body.toLowerCase().includes(`contributed by @${target.login.toLowerCase()}`);
      if (dryRun) { rows.push(`#${n}: would close (@${target.login}${credited ? ', credited' : ''})`); continue; }
      const bodies = await client.commentBodies(n);
      if (!bodies.some(b => b.includes(COMMENT_MARKER))) {
        await client.createComment(n, closeoutMessage(target.login, pr.number, pr.title ?? `#${pr.number}`, credited));
      }
      await client.close(n);
      rows.push(`#${n}: closed (@${target.login}${credited ? ', credited' : ''})`);
    } catch (e) {
      rows.push(`#${n}: FAILED, ${e instanceof Error ? e.message : String(e)}`);
      out.line(`::warning title=Fix-wave closeout::Could not close #${n}. Why: ${e instanceof Error ? e.message : String(e)}. Fix: close it by hand with a comment linking #${pr.number}, or re-run this workflow.`);
    }
  }
  for (const r of rows) out.line(r);
  out.summary(`### Fix-wave closeout for #${pr.number}\n\n${rows.map(r => `- ${r}`).join('\n')}\n`);
  return 0;
}

function restClient(): CloseoutClient {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repo = process.env.GITHUB_REPOSITORY ?? TRUSTED_HEAD_REPO;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${api}/repos/${repo}${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const ok = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`GitHub API ${what} returned ${res.status}`);
    return res.json();
  };
  return {
    getPull: async n => {
      const res = await call(`/pulls/${n}`);
      if (res.status === 404) return null;
      const p = await ok(res, `GET /pulls/${n}`) as { number: number; state: string; title: string; user?: { login?: string } };
      return { number: p.number, state: p.state, title: p.title, login: p.user?.login ?? 'contributor' };
    },
    commentBodies: async n => {
      const all: string[] = [];
      for (let page = 1; page <= 20; page++) {
        const batch = await ok(await call(`/issues/${n}/comments?per_page=100&page=${page}`), `GET /issues/${n}/comments`) as Array<{ body?: string }>;
        all.push(...batch.map(c => c.body ?? ''));
        if (batch.length < 100) break;
      }
      return all;
    },
    createComment: async (n, body) => { await ok(await call(`/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body }) }), `POST /issues/${n}/comments`); },
    close: async n => { await ok(await call(`/pulls/${n}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }), `PATCH /pulls/${n}`); },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--event');
  const path = at >= 0 ? args[at + 1] : process.env.GITHUB_EVENT_PATH;
  if (!path) {
    console.log('::error title=Fix-wave closeout::No event payload. Why: neither --event nor GITHUB_EVENT_PATH is set. Fix: run inside the fix-wave-closeout workflow or pass --event <payload.json>.');
    process.exit(1);
  }
  const event = JSON.parse(readFileSync(path, 'utf8')) as CloseoutEvent;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const out: Output = { line: s => console.log(s), summary: s => { if (summaryPath) appendFileSync(summaryPath, s); } };
  process.exit(await runCloseout(event, restClient(), out, args.includes('--dry-run')));
}
