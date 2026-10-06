#!/usr/bin/env bun
/**
 * scripts/fix-wave-gate.ts — the decision behind .github/workflows/fix-wave-gate.yml.
 *
 * A pull request into master passes when either:
 *   - its head repository is garrytan/gbrain (only maintainers can push
 *     there; covers capy/* and garrytan/* branches), or
 *   - the `maintainer-override` label is on it AND the most recent `labeled`
 *     timeline event for that label was made by a human on MAINTAINERS.
 *     Bots never qualify, including capy-ai[bot] and github-actions[bot].
 * Everything else fails, including a null head repository (a deleted fork).
 *
 * The workflow runs on pull_request_target, so both this file and the workflow
 * come from the default branch: a PR that edits either cannot change its own
 * result. This file reads only the event payload and the PR's timeline and
 * comments through the REST API; it never sees PR code. It imports nothing
 * outside the runtime so the workflow can sparse-check-out this one file.
 *
 *   bun scripts/fix-wave-gate.ts [--event <payload.json>] [--comment]
 *
 * --event defaults to $GITHUB_EVENT_PATH. Without --comment it is the gate
 * (exit 0 pass, 1 fail). With --comment it posts the welcome comment once on a
 * failing PR (marker COMMENT_MARKER) and always exits 0.
 * Docs: docs/RELEASING.md#fix-wave-gate, CONTRIBUTING.md.
 */
import { appendFileSync, readFileSync } from 'node:fs';

export const TRUSTED_HEAD_REPO = 'garrytan/gbrain';
export const OVERRIDE_LABEL = 'maintainer-override';
/** Humans who may apply the override label. Edit only through a reviewed PR to master. */
export const MAINTAINERS: readonly string[] = ['garrytan'];
export const COMMENT_MARKER = '<!-- fix-wave-gate -->';
const CONTRIBUTING_URL = 'https://github.com/garrytan/gbrain/blob/master/CONTRIBUTING.md#where-does-my-change-go';

interface Repo { id?: number; full_name?: string }
interface Actor { login?: string; type?: string }
export interface GateEvent {
  action?: string;
  pull_request?: {
    number: number;
    user?: Actor;
    labels?: Array<{ name?: string }>;
    head?: { repo?: Repo | null };
    base?: { repo?: Repo | null };
  };
}
export interface TimelineEvent { id?: number; event?: string; label?: { name?: string }; actor?: Actor | null; created_at?: string }
export type Reason = 'same_repo' | 'maintainer_override' | 'override_not_by_maintainer' | 'fork' | 'head_repo_missing' | 'not_a_pull_request';
export interface Decision { pass: boolean; reason: Reason; log: string[] }
export interface GateClient {
  labelEvents(pr: number): Promise<TimelineEvent[]>;
  commentBodies(pr: number): Promise<string[]>;
  createComment(pr: number, body: string): Promise<void>;
}

export function gateMessage(handle: string): string {
  return [
    COMMENT_MARKER,
    `Thanks for this pull request, @${handle}. The work is welcome, and this PR stays open.`,
    '',
    'gbrain does not merge contributor pull requests into master directly. A maintainer folds the change into a fix-wave PR, revises it there (tests, agent-facing errors, conventions), and lands it with credit to you: the commit says `Contributed by @' + handle + '` and carries a `Co-Authored-By:` trailer with your name. When that fix wave merges, this PR is closed with a comment that links it.',
    '',
    `You don't need to do anything else. To see where a change belongs and what the fix wave checks, read CONTRIBUTING.md, "Where does my change go?": ${CONTRIBUTING_URL}`,
    '',
    'This message comes from the fix-wave gate check, which stays red on contributor PRs by design.',
  ].join('\n');
}

export function isHumanMaintainer(actor: Actor | null | undefined): boolean {
  if (!actor?.login) return false;
  if (actor.type !== 'User' || actor.login.endsWith('[bot]')) return false;
  return MAINTAINERS.includes(actor.login);
}

export function needsTimeline(event: GateEvent): boolean {
  const pr = event.pull_request;
  return !!pr && !sameRepo(pr) && (pr.labels ?? []).some(l => l.name === OVERRIDE_LABEL);
}

function sameRepo(pr: NonNullable<GateEvent['pull_request']>): boolean {
  const head = pr.head?.repo, base = pr.base?.repo;
  return !!head && !!base && head.full_name === TRUSTED_HEAD_REPO && head.id !== undefined && head.id === base.id;
}

/** Pure. `timeline` is the PR's issue events in chronological order; read only when needsTimeline(). */
export function decide(event: GateEvent, timeline: TimelineEvent[]): Decision {
  const pr = event.pull_request;
  if (!pr) return { pass: false, reason: 'not_a_pull_request', log: ['The event has no pull_request; failing closed.'] };
  const head = pr.head?.repo;
  const log = [`PR #${pr.number} by @${pr.user?.login ?? 'unknown'}; head repository ${head?.full_name ?? 'null (deleted fork)'}.`];
  if (sameRepo(pr)) return { pass: true, reason: 'same_repo', log: [...log, `Head repository is ${TRUSTED_HEAD_REPO}: only maintainers can push there. Pass.`] };
  const fallback: Reason = head ? 'fork' : 'head_repo_missing';
  if (!(pr.labels ?? []).some(l => l.name === OVERRIDE_LABEL)) return { pass: false, reason: fallback, log: [...log, `No ${OVERRIDE_LABEL} label. Fail.`] };
  const applied = timeline.filter(e => e.event === 'labeled' && e.label?.name === OVERRIDE_LABEL).at(-1);
  const who = applied?.actor ? `@${applied.actor.login} (${applied.actor.type ?? 'unknown type'})` : 'an unknown actor';
  const audit = `${OVERRIDE_LABEL} applied by ${who} at ${applied?.created_at ?? 'unknown time'} (timeline event ${applied?.id ?? 'not found'})`;
  if (applied && isHumanMaintainer(applied.actor)) return { pass: true, reason: 'maintainer_override', log: [...log, `${audit}. Maintainer allowlist: ${MAINTAINERS.join(', ')}. Pass.`] };
  return { pass: false, reason: 'override_not_by_maintainer', log: [...log, `${audit}. Only a human on the maintainer allowlist (${MAINTAINERS.join(', ')}) can override. Fail.`] };
}

export interface Output { line(s: string): void; summary(s: string): void }

export async function runGate(event: GateEvent, client: GateClient, out: Output, mode: 'gate' | 'comment'): Promise<number> {
  let timeline: TimelineEvent[] = [];
  if (needsTimeline(event)) {
    try { timeline = await client.labelEvents(event.pull_request!.number); } catch (e) {
      out.line(`::error title=Fix-wave gate::Could not read the PR timeline to audit the ${OVERRIDE_LABEL} label. Why: ${e instanceof Error ? e.message : String(e)}. Fix: re-run this check from the PR's Checks tab; if it repeats, confirm the workflow still has pull-requests: read.`);
      return mode === 'gate' ? 1 : 0;
    }
  }
  const d = decide(event, timeline);
  for (const l of d.log) out.line(d.reason === 'maintainer_override' ? `::notice title=Fix-wave gate override::${l}` : l);
  out.summary(`### Fix-wave gate: ${d.pass ? 'pass' : 'fail'} (${d.reason})\n\n${d.log.map(l => `- ${l}`).join('\n')}\n`);
  const handle = event.pull_request?.user?.login ?? 'contributor';
  if (mode === 'comment') {
    if (d.pass || !event.pull_request) return 0;
    try {
      const bodies = await client.commentBodies(event.pull_request.number);
      if (bodies.some(b => b.includes(COMMENT_MARKER))) { out.line('Welcome comment already posted.'); return 0; }
      await client.createComment(event.pull_request.number, gateMessage(handle));
      out.line('Posted the welcome comment.');
    } catch (e) {
      out.line(`::warning title=Fix-wave gate::Could not post the welcome comment: ${e instanceof Error ? e.message : String(e)}`);
    }
    return 0;
  }
  if (d.pass) return 0;
  out.line(`::error title=Fix-wave gate::${gateMessage(handle).replace(COMMENT_MARKER + '\n', '').replace(/\n+/g, ' ')}`);
  out.line(`Maintainers: a human on the allowlist (${MAINTAINERS.join(', ')}) can apply the ${OVERRIDE_LABEL} label to pass this check; see docs/RELEASING.md#fix-wave-gate.`);
  return 1;
}

function restClient(): GateClient {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repo = process.env.GITHUB_REPOSITORY ?? TRUSTED_HEAD_REPO;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      ...init,
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} returned ${res.status}`);
    return res.json();
  };
  const pages = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await call(`${path}?per_page=100&page=${page}`) as T[];
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error(`${path} has more than 5000 entries`);
  };
  return {
    labelEvents: pr => pages<TimelineEvent>(`/issues/${pr}/events`),
    commentBodies: async pr => (await pages<{ body?: string }>(`/issues/${pr}/comments`)).map(c => c.body ?? ''),
    createComment: async (pr, body) => { await call(`/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body }), headers: { 'content-type': 'application/json' } }); },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--event');
  const path = at >= 0 ? args[at + 1] : process.env.GITHUB_EVENT_PATH;
  if (!path) {
    console.log('::error title=Fix-wave gate::No event payload. Why: neither --event nor GITHUB_EVENT_PATH is set. Fix: run inside the fix-wave-gate workflow or pass --event <payload.json>.');
    process.exit(1);
  }
  const event = JSON.parse(readFileSync(path, 'utf8')) as GateEvent;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const out: Output = { line: s => console.log(s), summary: s => { if (summaryPath) appendFileSync(summaryPath, s); } };
  process.exit(await runGate(event, restClient(), out, args.includes('--comment') ? 'comment' : 'gate'));
}
