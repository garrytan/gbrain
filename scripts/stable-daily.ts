#!/usr/bin/env bun
/**
 * The daily stable check (.github/workflows/stable-daily.yml, twice a day).
 *
 *   bun run scripts/stable-daily.ts          # from the workflow; DAILY_DRY_RUN=true reports and writes nothing
 *
 * Moves the stable channel forward by rule, never by guess:
 *
 * 1. Off when the STABLE_AUTO_PROMOTE repository variable is `off`, and paused
 *    while the current stable record says `rollback: true` (a maintainer
 *    promotes by hand to resume).
 * 1b. When the published evidence record (stable.json on stable-record) is
 *    missing or names another commit than stable, it writes the record for
 *    the current stable first, from the stable tag's message, through
 *    promote()'s re-promotion path (no tag moves; the release, exact tree,
 *    soak run and leases are checked as for any promotion), and stops there
 *    (GBRA-346: stable was promoted before the record existed).
 * 2. A reason must exist: a merged PR labelled `stable:important` (security,
 *    regression, data-loss or blocking fix, set by the merge lane) that is in a
 *    published release but not in stable, or stable older than 7 days with a
 *    newer release (the weekly floor). No reason: nothing happens.
 * 3. The candidate is the newest release on master newer than stable whose exact
 *    git tree passed a full (SOAK_SHAPE) successful run of the STABLE_SOAK_WORKFLOW
 *    soak with every integrity gate (INTEGRITY_GATES) passing in every cell; on the
 *    important-only path it must contain one of the important fixes. It is
 *    promoted through scripts/promote-stable.ts promote(), so every promotion
 *    check (published release, exact tree, never older) still applies. A release
 *    that was stable before (its stable-v<version> record tag exists: promoted,
 *    then rolled back) or that stable.json lists as known_bad or not_promotable
 *    (bad on outside evidence the soak cannot see) is never a candidate or soaked
 *    (#8792).
 * 4. Nothing promotable yet: the newest release is soaked (one dispatch of the
 *    soak on its tag) unless a soak is already running, or a soak on any newer
 *    release did not qualify (a maintainer decides; past the weekly floor it
 *    warns); a failed soak is never retried by the schedule.
 *
 * Docs: docs/RELEASING.md#daily-stable-check
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorize, compareVersions, currentStable, DOCS, onReleaseBranch, processDeps, promote, readPriorRecord, refExists, Refusal, requireSoakWorkflow, scheduleAuthorized, STABLE_REF,
  type PromoteDeps, type Promotion,
} from './promote-stable.ts';

export const IMPORTANT_LABEL = 'stable:important';
export const WEEKLY_FLOOR_DAYS = 7;
/** The soak gates a scheduled promotion requires (pass === true in every cell); the latency gates stay record-only. */
export const INTEGRITY_GATES = ['privacy_leaks', 'read_errors', 'version_skew', 'residents_alive', 'session_refusals'] as const;
/** The full soak a scheduled promotion requires: production-soak.yml's default cells, hours and fixture pages, with privacy probes run. */
export const SOAK_SHAPE = { rtts: [65, 2], hours: 2, pages: 600_000 } as const;
const DAY_MS = 86_400_000;
const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;

export interface SoakRunRow { id: number; status: string | null; conclusion: string | null; head_sha: string; html_url: string }
export interface Scoreboard {
  label?: string; rtt_ms?: number | null; hours?: number | null; elapsed_s?: number | null; privacy?: { probes?: number; probe_errors?: number };
  brain?: { fixture?: { pages?: number; options?: { pages?: number } } } | null;
  gates?: Array<{ id: string; pass: boolean | null }>;
}

export interface DailyDeps extends PromoteDeps {
  ghPost(path: string, body: unknown): Promise<void>;
  scoreboards(runId: number): Promise<Scoreboard[]>;
  autoPromote: string;
  dryRun: boolean;
}

export type DailyResult =
  | { action: 'off' | 'paused' | 'none'; why: string }
  | { action: 'promoted' | 'backfilled'; why: string; promotion: Promotion }
  | { action: 'soak_dispatched' | 'waiting'; why: string; version: string }
  | { action: 'dry_run'; why: string; would: string };

export function parseRecord(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of message.split('\n')) {
    const m = /^([a-z_]+): (.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Integrity gate failures across a soak's cells; a missing cell set or a gate with no data fails closed. */
export function integrityFailures(boards: Scoreboard[]): string[] {
  if (boards.length === 0) return ['no scoreboard artifact'];
  const failures: string[] = [];
  for (const b of boards) {
    for (const id of INTEGRITY_GATES) {
      const gate = b.gates?.find(g => g.id === id);
      if (gate?.pass !== true) failures.push(`${b.label ?? 'cell'}: ${id} ${gate ? (gate.pass === null ? 'has no data' : 'failed') : 'missing'}`);
    }
  }
  return failures;
}

/** Ways a soak falls short of the full default soak (SOAK_SHAPE): a missing cell, a short run, a small requested fixture, no clean privacy probes. */
export function shapeFailures(boards: Scoreboard[]): string[] {
  const failures = SOAK_SHAPE.rtts.filter(rtt => !boards.some(b => b.rtt_ms === rtt)).map(rtt => `no ${rtt} ms cell`);
  for (const b of boards) {
    const cell = b.label ?? 'cell';
    if ((b.hours ?? 0) < SOAK_SHAPE.hours || (b.elapsed_s ?? 0) < SOAK_SHAPE.hours * 3600) failures.push(`${cell}: ran ${b.elapsed_s ?? 0} s of a ${SOAK_SHAPE.hours} h soak`);
    const requested = b.brain?.fixture?.options?.pages ?? 0;
    if (requested < SOAK_SHAPE.pages) failures.push(`${cell}: a ${requested}-page fixture, under ${SOAK_SHAPE.pages}`);
    if (!((b.privacy?.probes ?? 0) > 0)) failures.push(`${cell}: no privacy probes ran`);
    if (b.privacy?.probe_errors !== 0) failures.push(`${cell}: ${b.privacy?.probe_errors ?? 'unknown'} privacy probe errors`);
  }
  return failures;
}

async function ok(deps: PromoteDeps, args: string[]): Promise<string> {
  const r = await deps.git(args);
  if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').at(-1)}` : ''}; re-run the daily check.`);
  return r.stdout.trim();
}

const isAncestor = async (deps: PromoteDeps, a: string, b: string) => (await deps.git(['merge-base', '--is-ancestor', a, b])).code === 0;

async function treeOf(deps: PromoteDeps, commit: string): Promise<string | null> {
  let r = await deps.git(['rev-parse', `${commit}^{tree}`]);
  if (r.code !== 0) { await deps.git(['fetch', '--no-tags', 'origin', commit]); r = await deps.git(['rev-parse', `${commit}^{tree}`]); }
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function daily(deps: DailyDeps): Promise<DailyResult> {
  if (deps.autoPromote.trim().toLowerCase() === 'off') return { action: 'off', why: 'STABLE_AUTO_PROMOTE is off; the daily check changes nothing.' };
  const soakPath = requireSoakWorkflow(deps.soakWorkflow);
  if (!deps.dryRun) await authorize(deps);

  const current = await currentStable(deps);
  if (!current) throw new Refusal('There is no stable release yet; promote the first one by hand with promote-stable.yml.');
  const record = parseRecord(await ok(deps, ['for-each-ref', '--format=%(contents)', STABLE_REF]));
  if (record.rollback === 'true') {
    return { action: 'paused', why: `stable v${current.version} is a rollback (${record.reason ?? '-'}); the daily check stays paused until a maintainer promotes by hand.` };
  }
  const stableCommit = await ok(deps, ['rev-parse', `${STABLE_REF}^{commit}`]);

  const published = await readPriorRecord(deps);
  if (published?.releaseCommit !== stableCommit) {
    const why = `stable.json ${published ? `names ${published.version ? `v${published.version}` : 'another release'}` : 'is not published'}, not stable v${current.version}`;
    if (deps.dryRun) return { action: 'dry_run', why, would: `backfill the record for v${current.version}` };
    if (!record.soak_run) throw new Refusal(`stable v${current.version}'s tag message names no soak_run, so its stable.json cannot be written from it; write the record by hand (${DOCS}).`);
    const promotion = await promote(deps, { version: current.version, soakRunUrl: record.soak_run, scoreboardUrl: '', rollback: false, reason: '' });
    return { action: 'backfilled', why, promotion };
  }
  const promotedAt = Date.parse(record.promoted_at ?? '');
  const ageDays = Number.isFinite(promotedAt) ? (deps.now().getTime() - promotedAt) / DAY_MS : Infinity;

  const releases: Array<{ version: string; commit: string }> = [];
  for (const tag of (await ok(deps, ['tag', '--list', 'v*'])).split('\n').map(t => t.trim())) {
    const version = tag.replace(/^v/, '');
    if (!VERSION_RE.test(version) || compareVersions(version, current.version) <= 0) continue;
    const commit = await ok(deps, ['rev-parse', `refs/tags/${tag}^{commit}`]);
    if (!(await onReleaseBranch(deps, commit))) { deps.log(`[stable-daily] skipping ${tag}: ${commit} is not on master.`); continue; }
    if (published.knownBad.includes(version)) { deps.log(`[stable-daily] skipping ${tag}: stable.json lists it as known bad (withdrawn).`); continue; }
    const blocked = published.notPromotable.find(e => e.version === version);
    if (blocked) { deps.log(`[stable-daily] skipping ${tag}: stable.json lists it as not promotable (${blocked.reason}; fixed in v${blocked.fixed_in}).`); continue; }
    if (await refExists(deps, `refs/tags/stable-v${version}`)) { deps.log(`[stable-daily] skipping ${tag}: stable-v${version} exists, so it was stable before and was rolled back; a maintainer re-promotes it by hand if it should return.`); continue; }
    releases.push({ version, commit });
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  if (releases.length === 0) return { action: 'none', why: `no release is newer than stable v${current.version}.` };

  const since = new Date((Number.isFinite(promotedAt) ? promotedAt : deps.now().getTime()) - 14 * DAY_MS).toISOString().slice(0, 10);
  const q = `repo:${deps.repo} is:pr is:merged label:"${IMPORTANT_LABEL}" merged:>=${since}`;
  const found = await deps.ghApi(`search/issues?q=${encodeURIComponent(q)}&per_page=100`) as { items?: Array<{ number: number }> };
  const important: Array<{ pr: number; version: string }> = [];
  for (const { number } of found.items ?? []) {
    const pr = await deps.ghApi(`repos/${deps.repo}/pulls/${number}`) as { merge_commit_sha?: string | null };
    const sha = pr.merge_commit_sha;
    if (!sha || (await treeOf(deps, sha)) === null || await isAncestor(deps, sha, stableCommit)) continue;
    for (const r of [...releases].reverse()) {
      if (!(await isAncestor(deps, sha, r.commit))) continue;
      important.push({ pr: number, version: r.version });
      break;
    }
  }
  const weekly = ageDays > WEEKLY_FLOOR_DAYS;
  if (important.length === 0 && !weekly) {
    return { action: 'none', why: `no released ${IMPORTANT_LABEL} fix is missing from stable v${current.version}, and stable is ${ageDays.toFixed(1)} days old (floor ${WEEKLY_FLOOR_DAYS}).` };
  }
  const reason = [
    ...(important.length ? [`important: ${important.map(i => `#${i.pr} (v${i.version})`).join(', ')}`] : []),
    ...(weekly ? [`weekly floor: stable v${current.version} is ${ageDays.toFixed(1)} days old`] : []),
  ].join('; ');
  deps.log(`[stable-daily] reason: ${reason}.`);

  const runs = ((await deps.ghApi(`repos/${deps.repo}/actions/workflows/${soakPath.split('/').at(-1)}/runs?per_page=100`)) as { workflow_runs?: SoakRunRow[] }).workflow_runs ?? [];
  const runsByTree = new Map<string, SoakRunRow[]>();
  for (const run of runs) {
    const tree = await treeOf(deps, run.head_sha);
    if (tree) runsByTree.set(tree, [...(runsByTree.get(tree) ?? []), run]);
  }
  const oldestImportant = important.reduce<string | null>((v, i) => (!v || compareVersions(i.version, v) < 0 ? i.version : v), null);
  let failedSoak: { version: string; run: SoakRunRow } | null = null;
  for (const rel of releases) {
    if (!weekly && oldestImportant && compareVersions(rel.version, oldestImportant) < 0) break;
    const tree = await treeOf(deps, rel.commit);
    const completed = (runsByTree.get(tree ?? '') ?? []).filter(r => r.status === 'completed');
    const passed = completed.filter(r => r.conclusion === 'success');
    let chosen: SoakRunRow | null = null;
    for (const run of passed) {
      const boards = await deps.scoreboards(run.id);
      const failures = [...integrityFailures(boards), ...shapeFailures(boards)];
      if (failures.length === 0) { chosen = run; break; }
      deps.log(`[stable-daily] not promotable: v${rel.version} soak ${run.html_url}: ${failures.join(', ')}.`);
    }
    if (!chosen) { failedSoak ??= completed[0] ? { version: rel.version, run: completed[0] } : null; continue; }
    if (deps.dryRun) return { action: 'dry_run', why: reason, would: `promote v${rel.version} on soak ${chosen.html_url}` };
    const promotion = await promote(deps, { version: rel.version, soakRunUrl: chosen.html_url, scoreboardUrl: '', rollback: false, reason: `scheduled daily check; ${reason}` });
    return { action: 'promoted', why: reason, promotion };
  }

  const newest = releases[0]!;
  const active = runs.find(r => r.status !== 'completed');
  if (active) return { action: 'waiting', why: `${reason}; soak ${active.html_url} is still running.`, version: newest.version };
  if (failedSoak) {
    if (weekly) deps.log(`::warning::Daily stable check: stable v${current.version} is past the ${WEEKLY_FLOOR_DAYS}-day floor and no soak qualifies; a maintainer decides. Docs: docs/RELEASING.md#daily-stable-check`);
    return { action: 'waiting', why: `${reason}; v${failedSoak.version} already had a soak (${failedSoak.run.html_url}, ${failedSoak.run.conclusion}) that did not qualify, so no new soak is dispatched and a maintainer decides.`, version: newest.version };
  }
  if (deps.dryRun) return { action: 'dry_run', why: reason, would: `dispatch the soak on v${newest.version}` };
  await deps.ghPost(`repos/${deps.repo}/actions/workflows/${soakPath.split('/').at(-1)}/dispatches`, { ref: `v${newest.version}` });
  return { action: 'soak_dispatched', why: reason, version: newest.version };
}

export function dailyDeps(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DailyDeps {
  const base = processDeps(env, cwd);
  return {
    ...base,
    scheduled: scheduleAuthorized(env, base.repo),
    autoPromote: env.STABLE_AUTO_PROMOTE ?? '',
    dryRun: env.DAILY_DRY_RUN === 'true',
    async ghPost(path, body) {
      const r = spawnSync('gh', ['api', '--method', 'POST', path, '--input', '-'], { cwd, env, encoding: 'utf8', input: JSON.stringify(body) });
      if (r.status !== 0) throw new Error(`gh api POST ${path} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    },
    async scoreboards(runId) {
      const dir = mkdtempSync(join(tmpdir(), 'soak-'));
      try {
        const r = spawnSync('gh', ['run', 'download', String(runId), '-R', base.repo, '-p', 'production-soak-*', '-D', dir], { cwd, env, encoding: 'utf8' });
        if (r.status !== 0) return [];
        return readdirSync(dir).flatMap(cell => {
          try { return [JSON.parse(readFileSync(join(dir, cell, 'scoreboard.json'), 'utf8')) as Scoreboard]; } catch { return [{ label: cell, gates: [] }]; }
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function renderDailySummary(r: DailyResult): string {
  const detail = r.action === 'promoted' ? `Promoted v${r.promotion.version} (previous v${r.promotion.previous ?? 'none'}).`
    : r.action === 'backfilled' ? `Wrote stable.json for v${r.promotion.version}; no tag moved.`
    : r.action === 'dry_run' ? `Dry run: would ${r.would}.`
    : 'version' in r ? `Release v${r.version}.` : '';
  return [`## Daily stable check: ${r.action}`, '', r.why, '', detail, ''].join('\n');
}

if (import.meta.main) {
  const deps = dailyDeps();
  try {
    if (!deps.repo) throw new Refusal('GITHUB_REPOSITORY is unset; run this from the Stable daily workflow.');
    const result = await daily(deps);
    console.log(`[stable-daily] ${result.action}: ${result.why}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderDailySummary(result));
  } catch (e) {
    const why = e instanceof Refusal ? e.message : `the daily check stopped on an unexpected error (${e instanceof Error ? e.message : String(e)}).`;
    console.log(`::error::Daily stable check: ${why} Docs: docs/RELEASING.md#daily-stable-check`);
    process.exit(1);
  }
}
