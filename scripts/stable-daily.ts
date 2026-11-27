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
 * 2. A reason must exist: a merged PR labelled `stable:important` (set by the
 *    merge lane; the classes are in docs/RELEASING.md) that is in a published
 *    release but not in stable, or stable older than 7 days with a newer
 *    release (the weekly floor). No reason: nothing happens.
 * 2b. While the upgrade matrix's own break issue is open (scripts/stable-matrix.ts
 *    findBreakIssue: the ISSUE_MARKER issue, not any issue with the label), stable
 *    holds: only an important fix whose fragment says `important: security` or
 *    `important: data-loss` may pass it, and only on a candidate whose matrix run
 *    fails on no from-version the issue does not name. The weekly floor waits.
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
 * 3b. The candidate also needs an upgrade matrix run on its exact tag and tree
 *    (stable-matrix.ts judgeMatrixRun): green, or past an open break as in 2b. No
 *    run yet: one matrix dispatch on the candidate tag, unless a matrix run is
 *    active. A red or foreign run holds stable (a maintainer decides) and is never
 *    re-dispatched by the schedule. promote() checks the run again.
 * 3c. The candidate also needs the install canary's pass: a trusted gbrain/install-canary commit status on its
 *    release commit (scripts/stable-canary.ts judgeCanary), read right after the soak so a release the canary
 *    failed is skipped for an older one before its matrix is dispatched or judged; one it has not tested yet (no
 *    status, or a pending one) is skipped after its matrix passes. When no release qualifies because of the
 *    canary, the run waits for it (not tested yet) or holds for a maintainer (failed); it dispatches nothing,
 *    since the release already soaked. A status list that cannot be read stops the run.
 * 4. Nothing promotable yet: the newest release is soaked (one dispatch of the
 *    soak on its tag, with an upgrade matrix dispatch on the same tag when it has
 *    no run) unless a soak is already running, or a soak on any newer
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
import { judgeCanary, parseCanaryPosters, readCanaryStatuses } from './stable-canary.ts';
import {
  BREAK_PASS_CLASSES, breakIssueQuery, findBreakIssue, fragmentImportance, isGateRun, judgeMatrixRun, MATRIX_WORKFLOW, receiptNames,
  type MatrixReceipt, type MatrixRunRow,
} from './stable-matrix.ts';

export const IMPORTANT_LABEL = 'stable:important';
export const WEEKLY_FLOOR_DAYS = 7;
/** The soak gates a scheduled promotion requires (pass === true in every cell); the latency gates stay record-only. */
export const INTEGRITY_GATES = ['privacy_leaks', 'read_errors', 'version_skew', 'residents_alive', 'session_refusals'] as const;
/** The search speed gate (production-soak/search-gate.ts) a scheduled promotion requires in the soak's 2 ms cell; the 65 ms cell records it only. */
export const SEARCH_GATES = ['search_gate_jit_on', 'search_gate_jit_off'] as const;
export const SEARCH_GATE_RTT_MS = 2;
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
  matrixReceipt(runId: number): Promise<MatrixReceipt | null>;
  autoPromote: string;
  dryRun: boolean;
}

export type DailyResult =
  | { action: 'off' | 'paused' | 'none' | 'held'; why: string }
  | { action: 'promoted' | 'backfilled'; why: string; promotion: Promotion }
  | { action: 'soak_dispatched' | 'matrix_dispatched' | 'waiting'; why: string; version: string }
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

/** Search speed gate failures in the 2 ms cell; a missing cell or gate fails closed. An overridden gate carries pass: true. */
export function searchGateFailures(boards: Scoreboard[]): string[] {
  const cell = boards.find(b => b.rtt_ms === SEARCH_GATE_RTT_MS);
  if (!cell) return [`no ${SEARCH_GATE_RTT_MS} ms cell for the search speed gate`];
  return SEARCH_GATES.flatMap(id => {
    const gate = cell.gates?.find(g => g.id === id);
    return gate?.pass === true ? [] : [`${cell.label ?? 'cell'}: ${id} ${gate ? (gate.pass === null ? 'has no data' : 'failed') : 'missing'}`];
  });
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

/** The `important:` class of the changelog.d fragment a merge commit added, or null. */
async function importanceOf(deps: PromoteDeps, commit: string): Promise<string | null> {
  const added = await deps.git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=A', commit, '--', 'changelog.d']);
  if (added.code !== 0) return null;
  for (const path of added.stdout.split('\n').map(p => p.trim()).filter(p => /^changelog\.d\/[^/]+\.md$/.test(p) && !p.endsWith('/README.md'))) {
    const shown = await deps.git(['show', `${commit}:${path}`]);
    const cls = shown.code === 0 ? fragmentImportance(shown.stdout) : null;
    if (cls) return cls;
  }
  return null;
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
  const labelled = ((await deps.ghApi(`search/issues?q=${encodeURIComponent(q)}&per_page=100`)) as { items?: Array<{ number: number }> }).items ?? [];
  deps.log(`[stable-daily] the ${IMPORTANT_LABEL} search returned ${labelled.length} merged PR${labelled.length === 1 ? '' : 's'} since ${since}.`);
  if (labelled.length === 0) {
    const any = (await deps.ghApi(`search/issues?q=${encodeURIComponent(`repo:${deps.repo} is:pr is:merged`)}&per_page=1`)) as { items?: unknown[] };
    if ((any.items ?? []).length === 0) throw new Refusal(`the pull-request search sees no merged pull request at all in ${deps.repo}, so this token cannot read pull requests and every ${IMPORTANT_LABEL} fix would be missed; give the workflow's GITHUB_TOKEN \`pull-requests: read\` (.github/workflows/stable-daily.yml permissions).`);
  }
  const important: Array<{ pr: number; version: string; passesBreak: boolean }> = [];
  for (const { number } of labelled) {
    const pr = await deps.ghApi(`repos/${deps.repo}/pulls/${number}`) as { merge_commit_sha?: string | null };
    const sha = pr.merge_commit_sha;
    if (!sha || (await treeOf(deps, sha)) === null || await isAncestor(deps, sha, stableCommit)) continue;
    for (const r of [...releases].reverse()) {
      if (!(await isAncestor(deps, sha, r.commit))) continue;
      const cls = await importanceOf(deps, sha);
      important.push({ pr: number, version: r.version, passesBreak: (BREAK_PASS_CLASSES as readonly string[]).includes(cls ?? '') });
      break;
    }
  }
  const weeklyDue = ageDays > WEEKLY_FLOOR_DAYS;
  if (important.length === 0 && !weeklyDue) {
    return { action: 'none', why: `no released ${IMPORTANT_LABEL} fix is missing from stable v${current.version}, and stable is ${ageDays.toFixed(1)} days old (floor ${WEEKLY_FLOOR_DAYS}).` };
  }
  const breakIssue = findBreakIssue(await deps.ghApi(breakIssueQuery(deps.repo)));
  const passing = breakIssue ? important.filter(i => i.passesBreak) : important;
  const weekly = weeklyDue && !breakIssue;
  if (breakIssue && passing.length === 0) {
    const why = `the upgrade matrix's break issue #${breakIssue.number} (${breakIssue.url}) is open, so stable v${current.version} holds; only a released important: security or data-loss fix may pass it${important.length ? ` (waiting: ${important.map(i => `#${i.pr}`).join(', ')})` : ''}.`;
    deps.log(`::warning::Daily stable check: ${why} Docs: docs/RELEASING.md#daily-stable-check`);
    return { action: 'held', why };
  }
  const reason = [
    ...(passing.length ? [`important: ${passing.map(i => `#${i.pr} (v${i.version})`).join(', ')}`] : []),
    ...(weekly ? [`weekly floor: stable v${current.version} is ${ageDays.toFixed(1)} days old`] : []),
    ...(breakIssue ? [`passing open upgrade break #${breakIssue.number} as a security or data-loss fix`] : []),
  ].join('; ');
  deps.log(`[stable-daily] reason: ${reason}.`);

  const matrixFile = MATRIX_WORKFLOW.split('/').at(-1);
  const matrixRuns = (((await deps.ghApi(`repos/${deps.repo}/actions/workflows/${matrixFile}/runs?branch=master&per_page=100`)) as { workflow_runs?: MatrixRunRow[] }).workflow_runs ?? []).filter(isGateRun);
  const receipts = new Map<number, MatrixReceipt | null>();
  /** The newest completed gate run whose receipt tests this release, or null. */
  const matrixRunFor = async (version: string): Promise<{ run: MatrixRunRow; receipt: MatrixReceipt | null } | null> => {
    for (const run of matrixRuns.filter(r => r.status === 'completed')) {
      if (!receipts.has(run.id)) receipts.set(run.id, await deps.matrixReceipt(run.id));
      if (receiptNames(receipts.get(run.id)!, version)) return { run, receipt: receipts.get(run.id)! };
    }
    return null;
  };
  const activeMatrix = matrixRuns.find(r => r.status !== 'completed');
  const dispatchMatrix = (version: string) => deps.ghPost(`repos/${deps.repo}/actions/workflows/${matrixFile}/dispatches`, { ref: 'master', inputs: { candidate: `v${version}` } });

  const runs = ((await deps.ghApi(`repos/${deps.repo}/actions/workflows/${soakPath.split('/').at(-1)}/runs?per_page=100`)) as { workflow_runs?: SoakRunRow[] }).workflow_runs ?? [];
  const runsByTree = new Map<string, SoakRunRow[]>();
  for (const run of runs) {
    const tree = await treeOf(deps, run.head_sha);
    if (tree) runsByTree.set(tree, [...(runsByTree.get(tree) ?? []), run]);
  }
  const oldestImportant = passing.reduce<string | null>((v, i) => (!v || compareVersions(i.version, v) < 0 ? i.version : v), null);
  let failedSoak: { version: string; run: SoakRunRow } | null = null;
  let canaryBlock = null as { version: string; state: 'failure' | 'untested'; why: string } | null;
  let newestSoaked = false;
  for (const rel of releases) {
    if (!weekly && oldestImportant && compareVersions(rel.version, oldestImportant) < 0) break;
    const tree = await treeOf(deps, rel.commit);
    const completed = (runsByTree.get(tree ?? '') ?? []).filter(r => r.status === 'completed');
    const passed = completed.filter(r => r.conclusion === 'success');
    let chosen: SoakRunRow | null = null;
    for (const run of passed) {
      const boards = await deps.scoreboards(run.id);
      const failures = [...integrityFailures(boards), ...searchGateFailures(boards), ...shapeFailures(boards)];
      if (failures.length === 0) { chosen = run; break; }
      deps.log(`[stable-daily] not promotable: v${rel.version} soak ${run.html_url}: ${failures.join(', ')}.`);
    }
    if (!chosen) { failedSoak ??= completed[0] ? { version: rel.version, run: completed[0] } : null; continue; }
    if (rel === releases[0]) newestSoaked = true;
    let statuses;
    try {
      statuses = await readCanaryStatuses(deps.ghApi, deps.repo, rel.commit);
    } catch (error) {
      throw new Refusal(`the install canary's statuses on v${rel.version} (${rel.commit}) could not be read (${(error as Error).message.split('\n')[0]}), so stable holds; re-run the check.`);
    }
    const canary = judgeCanary(statuses, rel.version, deps.canaryPosters ?? parseCanaryPosters(undefined));
    const skipCanary = () => {
      deps.log(`[stable-daily] skipping v${rel.version}: ${canary.why}.`);
      if (canary.state !== 'success' && (!canaryBlock || (canaryBlock.state === 'failure' && canary.state === 'untested'))) canaryBlock = { version: rel.version, state: canary.state, why: canary.why };
    };
    if (canary.state === 'failure') { skipCanary(); continue; }
    const matrix = await matrixRunFor(rel.version);
    if (!matrix) {
      if (activeMatrix) return { action: 'waiting', why: `${reason}; v${rel.version} passed its soak and upgrade matrix run ${activeMatrix.html_url} is still running.`, version: rel.version };
      if (deps.dryRun) return { action: 'dry_run', why: reason, would: `dispatch the upgrade matrix on v${rel.version}` };
      await dispatchMatrix(rel.version);
      return { action: 'matrix_dispatched', why: `${reason}; v${rel.version} passed its soak and has no upgrade matrix run yet.`, version: rel.version };
    }
    const judged = judgeMatrixRun(matrix.run, matrix.receipt, { version: rel.version, commit: rel.commit, tree: tree! }, breakIssue);
    if (!judged.ok) {
      const why = `${reason}; ${judged.why}, so stable holds and a maintainer decides.`;
      deps.log(`::warning::Daily stable check: ${why} Docs: docs/RELEASING.md#daily-stable-check`);
      return { action: 'held', why };
    }
    if (canary.state === 'untested') { skipCanary(); continue; }
    deps.log(`[stable-daily] ${canary.why}.`);
    if (deps.dryRun) return { action: 'dry_run', why: reason, would: `promote v${rel.version} on soak ${chosen.html_url} and upgrade matrix ${matrix.run.html_url}` };
    const excused = judged.excused.length ? `; upgrade break #${breakIssue!.number} excused for ${judged.excused.join(', ')}` : '';
    const promotion = await promote(deps, {
      version: rel.version, soakRunUrl: chosen.html_url, scoreboardUrl: '', rollback: false, reason: `scheduled daily check; ${reason}${excused}`,
      matrixRunUrl: matrix.run.html_url, matrixExcuse: breakIssue,
    });
    return { action: 'promoted', why: reason, promotion };
  }

  if (canaryBlock && newestSoaked) {
    if (canaryBlock.state === 'untested') {
      const why = `${reason}; ${canaryBlock.why}, and no older release qualifies, so stable waits for the install canary`;
      if (weekly) deps.log(`::warning::Daily stable check: stable v${current.version} is past the ${WEEKLY_FLOOR_DAYS}-day floor and ${why}. Docs: docs/RELEASING.md#daily-stable-check`);
      return { action: 'waiting', why, version: canaryBlock.version };
    }
    const why = `${reason}; ${canaryBlock.why}, and no older release qualifies, so stable holds and a maintainer decides`;
    deps.log(`::warning::Daily stable check: ${why}. Docs: docs/RELEASING.md#daily-stable-check`);
    return { action: 'held', why };
  }
  const why = canaryBlock ? `${reason}; ${canaryBlock.why}` : reason;
  const newest = releases[0]!;
  const active = runs.find(r => r.status !== 'completed');
  if (active) return { action: 'waiting', why: `${why}; soak ${active.html_url} is still running.`, version: newest.version };
  if (failedSoak) {
    if (weekly) deps.log(`::warning::Daily stable check: stable v${current.version} is past the ${WEEKLY_FLOOR_DAYS}-day floor and no soak qualifies; a maintainer decides. Docs: docs/RELEASING.md#daily-stable-check`);
    return { action: 'waiting', why: `${why}; v${failedSoak.version} already had a soak (${failedSoak.run.html_url}, ${failedSoak.run.conclusion}) that did not qualify, so no new soak is dispatched and a maintainer decides.`, version: newest.version };
  }
  const matrixToo = !activeMatrix && !(await matrixRunFor(newest.version));
  if (deps.dryRun) return { action: 'dry_run', why, would: `dispatch the soak${matrixToo ? ' and the upgrade matrix' : ''} on v${newest.version}` };
  await deps.ghPost(`repos/${deps.repo}/actions/workflows/${soakPath.split('/').at(-1)}/dispatches`, { ref: `v${newest.version}` });
  if (matrixToo) await dispatchMatrix(newest.version);
  return { action: 'soak_dispatched', why, version: newest.version };
}

export function dailyDeps(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DailyDeps {
  const base = processDeps(env, cwd);
  return {
    ...base,
    scheduled: scheduleAuthorized(env, base.repo),
    matrixReceipt: base.matrixReceipt!,
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
