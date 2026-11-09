#!/usr/bin/env bun
/**
 * bun run merge-queue — the stacked merge queue (docs/RELEASING.md#stacked-merge-queue).
 *
 *   bun run merge-queue plan <pr>...              versions and order for new entries behind the queue tail; writes nothing
 *   bun run merge-queue build <pr>...             append entries: queue branch mq/<version>-pr<N>, restamped onto the
 *                                                 entry ahead (or master), pushed, queue PR opened with the full-ci label
 *   bun run merge-queue status                    every live entry: head, full-suite / e2e-full-suite, receipt
 *   bun run merge-queue verify <queue-pr>         the merge checks for the first entry, the landing-tree check included
 *   bun run merge-queue land <queue-pr>           verify, merge (merge commit at the pinned head), then wait for the
 *                                                 master push runs and Release's ci-gate before returning
 *   bun run merge-queue refresh <queue-pr>        fix in place: merge the owner's new head, re-merge the entry ahead into
 *                                                 every entry behind, versions unchanged
 *   bun run merge-queue rebuild <queue-pr> [--drop <pr>]... [--first <pr>]
 *                                                 rebuild this entry and the tail on fresh branch names, versions shifted
 *
 * Each entry lands as its own queue PR. Its branch starts at the owner PR's head,
 * and bun run release:restamp --base <branch of the entry ahead> merges that
 * entry in, sets VERSION to its VERSION + 1 PATCH, numbers migrations after its
 * latest and restamps only the lines this entry added, so earlier entries'
 * CHANGELOG sections and since: rows keep their versions (checked after every
 * restamp). Entry i's tree is the tree master has once entries 1..i land, so
 * full-ci runs on every entry at once and the master push reuses each run.
 * The queue order is the version order of the mq/ branches not yet on master;
 * the owner PR head and the base are recorded in a queue note, a comment on the
 * queue PR, so /ship can rewrite the PR body freely.
 *
 * It never squashes, rebases or force-pushes. A rebuild pushes new branch names
 * and closes the queue PRs it replaces. land refuses anything but the first
 * entry, re-verifies at the pinned head and merges only through the REST merge
 * with sha=<head>.
 *
 * Seams (test/scripts/merge-queue.test.ts): main(argv, { gh, restamp, install,
 * sleep, now }) replaces the GitHub client, release:restamp, bun install and the
 * clock. Exit: 0 ok, 1 refused or stopped, 2 usage.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { main as releaseRestamp } from './release-restamp.ts';
import { BEHAVIOR_NOTICE_FILE, nextPatchVersion, splitChangelog, versionOfHeader } from './lib/restamp.ts';

export const DOCS = 'docs/RELEASING.md#stacked-merge-queue';
export const BRANCH_PREFIX = 'mq/';
/** scripts/pregate-remote-gate.sh runs_may_attest: a tree changing these never reuses its own full-ci runs. */
export const SELF_ATTESTATION_PATHS = [
  '.github/workflows/test.yml', '.github/workflows/e2e.yml', 'scripts/ci-reuse.ts', 'scripts/ci-full-suite-tree.sh',
  'scripts/ci-executed-counts.ts', 'scripts/ci-manifest.ts', 'scripts/lib/gh-issue.ts',
];
/** Check names are <workflow>/<job> for the Actions jobs of the newest run of each workflow and event on a head. */
export const REQUIRED_FULL_CHECKS = ['Test/full-suite', 'E2E Tests/e2e-full-suite'];
const POST_MERGE_WORKFLOWS = ['Test', 'E2E Tests'];
const MASTER = 'refs/remotes/origin/master';

export interface PullRequest { number: number; title: string; body: string; headRefOid: string; headRefName: string; state: string; isCrossRepository: boolean; author: string; labels: string[]; mergeStateStatus: string }
export interface CheckRun { name: string; status: string; conclusion: string | null }
export interface WorkflowRun { id: number; name: string; status: string; conclusion: string | null }
export interface Gh {
  repoOwner(): string;
  pr(n: number): PullRequest;
  openPrForBranch(branch: string): PullRequest | null;
  createPr(opts: { head: string; title: string; body: string }): number;
  addLabel(n: number, label: string): void;
  comment(n: number, body: string): void;
  comments(n: number): string[];
  closePr(n: number): void;
  checks(sha: string): CheckRun[];
  merge(n: number, sha: string, title: string, message: string): string;
  pushRuns(sha: string): WorkflowRun[];
  jobConclusion(runId: number, job: string): string | null;
  receiptHead(pr: number): string | null;
}
export interface Opts { cwd?: string; log?: (line: string) => void; env?: Record<string, string | undefined>; gh?: Gh; restamp?: (cwd: string, argv: string[]) => number; install?: (cwd: string) => void; sleep?: (ms: number) => void; now?: () => number }

class Stop extends Error {}
function stop(what: string, fix: string): never {
  throw new Stop(`MERGE_QUEUE: refused: ${what}\nFix:  ${fix}\nSee:  ${DOCS}`);
}

function sh(cmd: string[], cwd: string, env?: Record<string, string | undefined>): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...(env ?? process.env), GIT_MERGE_AUTOEDIT: 'no' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

class Git {
  constructor(readonly cwd: string, readonly env?: Record<string, string | undefined>) {}
  run(...args: string[]): string {
    const r = sh(['git', ...args], this.cwd, this.env);
    if (r.code !== 0) throw new Stop(`MERGE_QUEUE: git ${args.join(' ')} failed (exit ${r.code}): ${r.err.trim()}`);
    return r.out;
  }
  ok(...args: string[]): boolean {
    return sh(['git', ...args], this.cwd, this.env).code === 0;
  }
  show(ref: string, path: string): string | null {
    const r = sh(['git', 'show', `${ref}:${path}`], this.cwd, this.env);
    return r.code === 0 ? r.out : null;
  }
  at(dir: string): Git {
    return new Git(dir, this.env);
  }
}

export interface Entry { branch: string; version: string; owner: number; head: string }

/** mq/<version>-pr<owner>[-r<round>] */
export function parseBranch(branch: string): { version: string; owner: number; round: number } | null {
  const m = /^mq\/(\d+\.\d+\.\d+\.\d+)-pr(\d+)(?:-r(\d+))?$/.exec(branch);
  return m ? { version: m[1]!, owner: Number(m[2]), round: m[3] ? Number(m[3]) : 1 } : null;
}

export function branchName(version: string, owner: number, round = 1): string {
  return `${BRANCH_PREFIX}${version}-pr${owner}${round > 1 ? `-r${round}` : ''}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export interface Note { owner: number; ownerHead: string; base: string; baseHead: string }

export function entryBody(e: { owner: number; base: string; version: string; title: string }): string {
  return `Queue entry for #${e.owner}: ${e.title}\n\n#${e.owner}'s head merged onto ${e.base === 'master' ? 'master' : `the queue entry ahead (${e.base})`} and stamped ${e.version} by bun run merge-queue (${DOCS}). Landing this PR marks #${e.owner} merged.`;
}

/** The queue note: a comment on the queue PR naming the owner head it carries and the base it was built on. */
export function queueNote(n: Note): string {
  return `<!-- merge-queue -->\nQueue-Owner-Head: #${n.owner} ${n.ownerHead}\nQueue-Base: ${n.base} ${n.baseHead}`;
}

/** The newest queue note among a PR's comments. */
export function readNote(comments: string[]): Note | null {
  for (const body of [...comments].reverse()) {
    if (!body.startsWith('<!-- merge-queue -->')) continue;
    const o = /^Queue-Owner-Head: #(\d+) ([0-9a-f]{40})$/m.exec(body);
    const b = /^Queue-Base: (\S+) ([0-9a-f]{40})$/m.exec(body);
    if (o && b) return { owner: Number(o[1]), ownerHead: o[2]!, base: b[1]!, baseHead: b[2]! };
  }
  return null;
}

/**
 * The restamp gotcha, checked: every CHANGELOG section of the base sits unchanged, in order, under the entry's own
 * section (headed with its version), and every since: line of the base's BEHAVIOR_CHANGES is still there verbatim.
 */
export function inheritedProblems(base: { changelog: string; notice: string | null }, head: { changelog: string; notice: string | null }, version: string): string[] {
  const out: string[] = [];
  const trim = (s: string) => s.replace(/\n+$/, '');
  const bs = splitChangelog(base.changelog).sections;
  const hs = splitChangelog(head.changelog).sections;
  if (versionOfHeader(hs[0]?.header ?? '') !== version) out.push(`CHANGELOG.md top section is ${hs[0]?.header ?? '<none>'}, expected ## [${version}]`);
  bs.forEach((s, i) => {
    if (trim(hs[i + 1]?.text ?? '') !== trim(s.text)) out.push(`CHANGELOG.md no longer carries the base's section ${s.header} unchanged at position ${i + 2}`);
  });
  if (base.notice !== null) {
    const have = new Set((head.notice ?? '').split('\n'));
    for (const line of base.notice.split('\n')) {
      if (/\bsince: '/.test(line) && !have.has(line)) out.push(`${BEHAVIOR_NOTICE_FILE} changed a since: row of the base: ${line.trim().slice(0, 120)}`);
    }
  }
  return out;
}

/** The tree that merging head into master writes, or null when the merge conflicts. */
export function landingTree(git: Git, master: string, head: string): string | null {
  const r = sh(['git', 'merge-tree', '--write-tree', master, head], git.cwd, git.env);
  return r.code === 0 ? r.out.split('\n')[0]!.trim() : null;
}

/** Live entries: mq/ branches on origin not yet on master, in version order (one per version; the latest round wins). */
export function liveEntries(git: Git): Entry[] {
  const refs = git.run('for-each-ref', '--format=%(refname:strip=3) %(objectname)', `refs/remotes/origin/${BRANCH_PREFIX}`).split('\n').filter(Boolean);
  const byVersion = new Map<string, Entry & { round: number }>();
  for (const line of refs) {
    const [branch, head] = line.split(' ') as [string, string];
    const p = parseBranch(branch);
    if (!p || git.ok('merge-base', '--is-ancestor', head, MASTER)) continue;
    const prev = byVersion.get(p.version);
    if (!prev || p.round > prev.round) byVersion.set(p.version, { branch, version: p.version, owner: p.owner, head, round: p.round });
  }
  const newestRound = new Map<number, number>();
  for (const e of byVersion.values()) newestRound.set(e.owner, Math.max(newestRound.get(e.owner) ?? 0, e.round));
  return [...byVersion.values()].filter((e) => e.round === newestRound.get(e.owner))
    .sort((a, b) => compareVersions(a.version, b.version)).map(({ round: _round, ...e }) => e);
}

interface Ctx { git: Git; gh: Gh; log: (l: string) => void; opts: Opts }
interface Live extends Entry { pr: PullRequest; meta: Note | null; index: number }
interface Planned { owner: PullRequest; version: string; branch: string; base: string }

function fetchAll(ctx: Ctx): void {
  ctx.git.run('fetch', '--quiet', '--prune', 'origin', `+refs/heads/master:${MASTER}`, `+refs/heads/${BRANCH_PREFIX}*:refs/remotes/origin/${BRANCH_PREFIX}*`);
}

function masterVersion(ctx: Ctx): string {
  return (ctx.git.show(MASTER, 'VERSION') ?? '').trim();
}

function plainTitle(title: string): string {
  return title.replace(/^v?\d+\.\d+\.\d+(?:\.\d+)?\s+/, '');
}

function touchesSelfAttestation(git: Git, ref: string): string[] {
  return SELF_ATTESTATION_PATHS.filter((p) => !git.ok('diff', '--quiet', `${MASTER}...${ref}`, '--', p));
}

function ownerPr(ctx: Ctx, n: number): PullRequest {
  const pr = ctx.gh.pr(n);
  if (pr.state !== 'OPEN') stop(`#${n} is ${pr.state.toLowerCase()}`, 'queue only open PRs');
  if (pr.isCrossRepository || pr.author !== ctx.gh.repoOwner()) stop(`#${n} is a contributor PR (${pr.author})`, 'contributor work lands only through a fix-wave PR; queue that wave instead');
  if (pr.headRefName.startsWith(BRANCH_PREFIX)) stop(`#${n} is a queue PR`, 'queue the owner PR it was built from');
  return pr;
}

/** Versions and branch names for owners entering behind `after`, in order; an entry changing the CI self-attestation files must be last. */
function plan(ctx: Ctx, owners: number[], after: { base: string; version: string; isCi: boolean }, round = 1): Planned[] {
  if (after.isCi) stop(`the entry ahead (${after.base}) changes the CI self-attestation files`, 'land it first; entries behind it would attest with workflows that are not on master');
  if (new Set(owners).size !== owners.length) stop('a PR is listed twice', 'list each PR once');
  let { base, version } = after;
  return owners.map((n, i) => {
    const pr = ownerPr(ctx, n);
    ctx.git.run('fetch', '--quiet', 'origin', pr.headRefOid);
    const ci = touchesSelfAttestation(ctx.git, pr.headRefOid);
    if (ci.length && i < owners.length - 1) stop(`#${n} changes ${ci.join(', ')}`, 'put it last: an entry that changes the CI self-attestation files goes at the tail');
    version = nextPatchVersion(version);
    const p = { owner: pr, version, branch: branchName(version, n, round), base };
    base = p.branch;
    return p;
  });
}

function tail(ctx: Ctx): { base: string; version: string; isCi: boolean } {
  const last = liveEntries(ctx.git).at(-1);
  if (!last) return { base: 'master', version: masterVersion(ctx), isCi: false };
  return { base: last.branch, version: last.version, isCi: touchesSelfAttestation(ctx.git, last.head).length > 0 };
}

function worktreeFor(ctx: Ctx, branch: string): string {
  const common = ctx.git.run('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const root = ctx.opts.env?.GBRAIN_MQ_WORKTREES ?? join(common, 'merge-queue');
  mkdirSync(root, { recursive: true });
  return join(root, branch.replace(/\//g, '-'));
}

function restamp(ctx: Ctx, dir: string, base: string): void {
  const run = ctx.opts.restamp ?? ((cwd: string, argv: string[]) => releaseRestamp(argv, { cwd, env: ctx.opts.env, log: ctx.log }));
  if (run(dir, ['--base', base]) !== 0) {
    stop(`release:restamp --base ${base} stopped in ${dir}`, 'resolve what it printed there and run bun run release:restamp --continue there, then rerun this command');
  }
}

function checkInherited(wt: Git, baseRef: string, head: string, version: string, branch: string): void {
  const problems = inheritedProblems(
    { changelog: wt.show(baseRef, 'CHANGELOG.md') ?? '', notice: wt.show(baseRef, BEHAVIOR_NOTICE_FILE) },
    { changelog: wt.show(head, 'CHANGELOG.md') ?? '', notice: wt.show(head, BEHAVIOR_NOTICE_FILE) }, version);
  if (problems.length) stop(`${branch} changed what earlier entries stamped:\n${problems.map((x) => `      ${x}`).join('\n')}`, 'restore those lines from the entry ahead, commit, and rerun');
}

/** Build (or resume) one entry and return its queue PR number. */
function buildEntry(ctx: Ctx, p: Planned): number {
  const ownerHead = p.owner.headRefOid;
  const baseRef = p.base === 'master' ? MASTER : `refs/remotes/origin/${p.base}`;
  const baseHead = ctx.git.run('rev-parse', baseRef).trim();
  const dir = worktreeFor(ctx, p.branch);
  if (!existsSync(dir)) {
    ctx.git.run('worktree', 'add', '--quiet', '-B', p.branch, dir, ownerHead);
    const install = ctx.opts.install ?? ((cwd: string) => {
      const r = sh(['bun', 'install', '--frozen-lockfile'], cwd, ctx.opts.env);
      if (r.code !== 0) stop(`bun install --frozen-lockfile failed in ${cwd}: ${r.err.trim().split('\n').pop()}`, 'fix bun.lock on the owner branch');
    });
    install(dir);
  }
  const wt = ctx.git.at(dir);
  restamp(ctx, dir, p.base);
  const head = wt.run('rev-parse', 'HEAD').trim();
  const version = (wt.show(head, 'VERSION') ?? '').trim();
  if (version !== p.version) stop(`restamp gave ${p.branch} VERSION ${version}; the queue assigned ${p.version}`, 'the entry ahead moved; rebuild from it');
  if (!wt.ok('merge-base', '--is-ancestor', ownerHead, head) || !wt.ok('merge-base', '--is-ancestor', baseHead, head)) stop(`${p.branch} does not contain both #${p.owner.number}'s head and ${p.base}`, 'rebuild the entry');
  checkInherited(wt, baseRef, head, p.version, p.branch);
  wt.run('push', '--quiet', 'origin', `${head}:refs/heads/${p.branch}`);
  const n = ctx.gh.openPrForBranch(p.branch)?.number
    ?? ctx.gh.createPr({ head: p.branch, title: `v${p.version} ${plainTitle(p.owner.title)}`, body: entryBody({ owner: p.owner.number, base: p.base, version: p.version, title: plainTitle(p.owner.title) }) });
  ctx.gh.comment(n, queueNote({ owner: p.owner.number, ownerHead, base: p.base, baseHead }));
  ctx.gh.addLabel(n, 'full-ci');
  ctx.log(`QUEUE_ENTRY: #${n} ${p.branch} version=${p.version} head=${head} owner=#${p.owner.number}@${ownerHead.slice(0, 12)} base=${p.base}@${baseHead.slice(0, 12)}`);
  return n;
}

function live(ctx: Ctx): Live[] {
  return liveEntries(ctx.git).map((e, index) => {
    const pr = ctx.gh.openPrForBranch(e.branch);
    if (!pr) stop(`${e.branch} has no open queue PR`, `rebuild it, or delete the branch: git push origin --delete ${e.branch}`);
    return { ...e, pr, meta: readNote(ctx.gh.comments(pr.number)), index };
  });
}

function find(entries: Live[], n: number): Live {
  const e = entries.find((x) => x.pr.number === n || x.owner === n);
  if (!e) stop(`#${n} is not a live queue entry`, 'bun run merge-queue status lists them');
  return e;
}

function checkState(ctx: Ctx, sha: string): { failed: string[]; pending: string[]; full: Record<string, string> } {
  const rank = (r: CheckRun) => (r.status !== 'completed' ? 3 : r.conclusion === 'skipped' ? 0 : r.conclusion === 'success' ? 1 : 2);
  const latest = new Map<string, CheckRun>();
  for (const r of ctx.gh.checks(sha)) if (rank(r) >= rank(latest.get(r.name) ?? r)) latest.set(r.name, r);
  const failed: string[] = [];
  const pending: string[] = [];
  for (const r of latest.values()) {
    if (r.status !== 'completed') pending.push(r.name);
    else if (!['success', 'skipped', 'neutral'].includes(r.conclusion ?? '')) failed.push(`${r.name}=${r.conclusion}`);
  }
  const full = Object.fromEntries(REQUIRED_FULL_CHECKS.map((c) => {
    const r = latest.get(c);
    return [c, !r ? 'missing' : r.status === 'completed' ? r.conclusion ?? 'none' : r.status];
  }));
  return { failed, pending, full };
}

function verifyProblems(ctx: Ctx, e: Live, first: Live, expectHead?: string, vmGateTree?: string): string[] {
  const p: string[] = [];
  if (e !== first) p.push(`it is Q${e.index + 1}; only Q1 (#${first.pr.number}) may land`);
  if (e.pr.headRefOid !== e.head) p.push(`queue PR head ${e.pr.headRefOid} differs from the branch head ${e.head}`);
  if (expectHead && expectHead !== e.head) p.push(`head is ${e.head}, expected ${expectHead}`);
  const tree = ctx.git.run('rev-parse', `${e.head}^{tree}`).trim();
  const landed = landingTree(ctx.git, MASTER, e.head);
  if (landed !== tree) p.push(`landing-tree check: merging into master writes ${landed ?? 'a conflict'}, the gated tree is ${tree}`);
  const ci = touchesSelfAttestation(ctx.git, e.head);
  if (ci.length && vmGateTree !== tree) p.push(`it changes ${ci.join(', ')}, so its own full-ci runs cannot attest to it: run scripts/pregate-remote-gate.sh on the head (VM gate) and pass --vm-gate-tree <the tree= of its PREGATE_REMOTE line>`);
  const master = masterVersion(ctx);
  const version = (ctx.git.show(e.head, 'VERSION') ?? '').trim();
  if (version !== nextPatchVersion(master) || version !== e.version) p.push(`VERSION is ${version}; master is ${master} and the branch name says ${e.version}`);
  if (!e.pr.title.startsWith(`v${version} `)) p.push(`queue PR title does not start with v${version}`);
  if (!e.meta) p.push('queue PR has no queue note (Queue-Owner-Head / Queue-Base)');
  else {
    const owner = ctx.gh.pr(e.meta.owner);
    if (owner.headRefOid !== e.meta.ownerHead) p.push(`owner #${e.meta.owner} pushed after inclusion (${owner.headRefOid.slice(0, 12)}); refresh to fix in place, or rebuild --drop`);
    if (!ctx.git.ok('merge-base', '--is-ancestor', e.meta.ownerHead, e.head)) p.push(`owner head ${e.meta.ownerHead} is not in the entry`);
  }
  const dropped = ctx.git.run('diff', '--numstat', MASTER, e.head, '--', 'CHANGELOG.md').trim().split(/\s+/)[1];
  if (dropped && dropped !== '0') p.push(`CHANGELOG.md drops ${dropped} line(s) of master's`);
  const c = checkState(ctx, e.head);
  for (const [name, state] of Object.entries(c.full)) if (state !== 'success') p.push(`${name} is ${state} on the exact head`);
  if (c.failed.length) p.push(`failed checks: ${c.failed.join(', ')}`);
  if (c.pending.length) p.push(`pending checks: ${c.pending.join(', ')}`);
  if (e.pr.mergeStateStatus !== 'CLEAN') p.push(`mergeStateStatus is ${e.pr.mergeStateStatus}`);
  if (!e.pr.labels.includes('full-ci')) p.push('queue PR lacks the full-ci label');
  const rh = ctx.gh.receiptHead(e.pr.number);
  if (rh !== e.head) p.push(`ship receipt head is ${rh ?? 'missing'}, not ${e.head}`);
  return p;
}

function cmdPlan(ctx: Ctx, owners: number[]): void {
  fetchAll(ctx);
  plan(ctx, owners, tail(ctx)).forEach((p, i) => ctx.log(`PLAN: +${i + 1} #${p.owner.number} ${p.branch} version=${p.version} base=${p.base}`));
}

function cmdBuild(ctx: Ctx, owners: number[]): void {
  fetchAll(ctx);
  for (const p of plan(ctx, owners, tail(ctx))) {
    buildEntry(ctx, p);
    fetchAll(ctx);
  }
}

function cmdStatus(ctx: Ctx): void {
  fetchAll(ctx);
  const entries = live(ctx);
  if (!entries.length) ctx.log('QUEUE: empty');
  for (const e of entries) {
    const c = checkState(ctx, e.head);
    const moved = e.meta && ctx.gh.pr(e.meta.owner).headRefOid !== e.meta.ownerHead ? ' owner-pushed' : '';
    const receipt = ctx.gh.receiptHead(e.pr.number) === e.head ? 'head' : 'missing';
    ctx.log(`Q${e.index + 1}: #${e.pr.number} ${e.branch} head=${e.head.slice(0, 12)} full-suite=${c.full['Test/full-suite']} e2e-full-suite=${c.full['E2E Tests/e2e-full-suite']} failed=${c.failed.length} pending=${c.pending.length} receipt=${receipt}${moved}`);
  }
}

function cmdVerify(ctx: Ctx, n: number, expectHead?: string, vmGateTree?: string): Live | null {
  fetchAll(ctx);
  const entries = live(ctx);
  const e = find(entries, n);
  const review = ctx.git.run('diff', '--name-only', MASTER, e.head, '--', '.github', 'bun.lock', 'src/core/schema-migrations').split('\n').filter(Boolean);
  if (review.length) ctx.log(`REVIEW: changes under .github, bun.lock or schema-migrations: ${review.join(' ')}`);
  const problems = verifyProblems(ctx, e, entries[0]!, expectHead, vmGateTree);
  if (problems.length) {
    ctx.log(`VERIFY: refused #${e.pr.number} ${e.branch}\n${problems.map((x) => `  - ${x}`).join('\n')}`);
    return null;
  }
  ctx.log(`VERIFY: ok #${e.pr.number} ${e.branch} head=${e.head} tree=${ctx.git.run('rev-parse', `${e.head}^{tree}`).trim()} version=${e.version}`);
  return e;
}

/** Wait for master's push runs of Test and E2E Tests on the merge commit and for Release's ci-gate, so no release is superseded. */
export function waitPostMerge(gh: Gh, sha: string, timeoutMs: number, clock: { now: () => number; sleep: (ms: number) => void }, log: (l: string) => void): 'green' | 'red' | 'pending' {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    let runs: WorkflowRun[] = [];
    try {
      runs = gh.pushRuns(sha);
    } catch {
      runs = [];
    }
    const newest = (name: string) => runs.filter((x) => x.name === name).sort((a, b) => b.id - a.id)[0];
    const lines: string[] = [];
    let red = false;
    let done = true;
    for (const name of POST_MERGE_WORKFLOWS) {
      const r = newest(name);
      if (!r || r.status !== 'completed') {
        done = false;
        lines.push(`${name}=${r?.status ?? 'not started'}`);
        continue;
      }
      if (r.conclusion !== 'success') red = true;
      lines.push(`${name}=${r.conclusion}`);
    }
    const release = newest('Release');
    let gate: string | null = null;
    try {
      gate = release ? gh.jobConclusion(release.id, 'ci-gate') : null;
    } catch {
      gate = null;
    }
    if (gate === null) done = false;
    else if (gate !== 'success') red = true;
    lines.push(`Release ci-gate=${release ? gate ?? 'running' : 'not started'}`);
    if (red || done || clock.now() >= deadline) {
      const verdict = red ? 'red' : done ? 'green' : 'pending';
      log(`POST_MERGE: ${verdict} ${sha} ${lines.join(' ')}`);
      return verdict;
    }
    clock.sleep(30_000);
  }
}

function cmdLand(ctx: Ctx, n: number, expectHead: string | undefined, vmGateTree: string | undefined, timeoutMs: number): boolean {
  const e = cmdVerify(ctx, n, expectHead, vmGateTree);
  if (!e) return false;
  const tree = ctx.git.run('rev-parse', `${e.head}^{tree}`).trim();
  fetchAll(ctx);
  if (landingTree(ctx.git, MASTER, e.head) !== tree) {
    ctx.log(`VERIFY: refused #${e.pr.number}: master moved during verify; rerun land`);
    return false;
  }
  const sha = ctx.gh.merge(e.pr.number, e.head, `${plainTitle(e.pr.title)} (#${e.pr.number})`, `Queue entry ${e.version} for #${e.owner}.`);
  ctx.log(`LANDED: #${e.pr.number} ${e.version} merge=${sha}`);
  fetchAll(ctx);
  const landed = ctx.git.run('rev-parse', `${sha}^{tree}`).trim();
  if (landed !== tree) {
    ctx.log(`QUEUE_FROZEN: master moved before the merge, so ${sha} has tree ${landed}, not the gated tree ${tree}; run full-ci on master (or revert it) before landing anything else`);
    return false;
  }
  const clock = { now: ctx.opts.now ?? Date.now, sleep: ctx.opts.sleep ?? ((ms: number) => Bun.sleepSync(ms)) };
  const verdict = waitPostMerge(ctx.gh, sha, timeoutMs, clock, ctx.log);
  if (verdict === 'red') ctx.log('QUEUE_FROZEN: master is red; root-cause it before landing the next entry');
  if (verdict === 'pending') ctx.log('QUEUE_WAIT: master runs are still going; land the next entry only after they finish');
  return verdict === 'green';
}

/** Fix in place: merge the owner's new head into the entry, then re-merge the entry ahead into each entry behind. */
function cmdRefresh(ctx: Ctx, n: number): void {
  fetchAll(ctx);
  const entries = live(ctx);
  for (const e of entries.slice(find(entries, n).index)) {
    if (!e.meta) stop(`#${e.pr.number} has no queue note`, 'rebuild it');
    const dir = worktreeFor(ctx, e.branch);
    if (!existsSync(dir)) ctx.git.run('worktree', 'add', '--quiet', '-B', e.branch, dir, e.head);
    const wt = ctx.git.at(dir);
    if (existsSync(join(wt.run('rev-parse', '--path-format=absolute', '--git-dir').trim(), 'gbrain-restamp.json'))) stop(`a restamp is stopped in ${dir}`, 'finish it there (bun run release:restamp --continue), then rerun refresh');
    if (!wt.ok('merge-base', '--is-ancestor', e.head, 'HEAD')) wt.run('checkout', '--quiet', '-B', e.branch, e.head);
    const owner = ctx.gh.pr(e.meta.owner);
    wt.run('fetch', '--quiet', 'origin', owner.headRefOid);
    if (!wt.ok('merge-base', '--is-ancestor', owner.headRefOid, 'HEAD') && sh(['git', 'merge', '--no-ff', '--no-edit', owner.headRefOid], dir, ctx.opts.env).code !== 0) {
      stop(`merging #${e.meta.owner}'s new head into ${e.branch} conflicts in ${dir}`, 'resolve and commit there, push the branch (no force), then rerun refresh');
    }
    const base = e.index === 0 ? 'master' : entries[e.index - 1]!.branch;
    const baseRef = base === 'master' ? MASTER : `refs/remotes/origin/${base}`;
    const ownerMoved = wt.run('rev-parse', 'HEAD').trim() !== e.head;
    const landsClean = base === 'master' && landingTree(wt, MASTER, 'HEAD') === wt.run('rev-parse', 'HEAD^{tree}').trim();
    if (ownerMoved || (!landsClean && !wt.ok('merge-base', '--is-ancestor', baseRef, 'HEAD'))) restamp(ctx, dir, base);
    const head = wt.run('rev-parse', 'HEAD').trim();
    const version = (wt.show(head, 'VERSION') ?? '').trim();
    if (version !== e.version) stop(`refresh moved ${e.branch} to VERSION ${version}`, 'master moved under the queue; rebuild it from Q1');
    if (base !== 'master') checkInherited(wt, baseRef, head, e.version, e.branch);
    if (head !== e.head) {
      wt.run('push', '--quiet', 'origin', `${head}:refs/heads/${e.branch}`);
      ctx.gh.comment(e.pr.number, queueNote({ owner: e.meta.owner, ownerHead: owner.headRefOid, base, baseHead: wt.run('rev-parse', baseRef).trim() }));
    }
    ctx.log(`REFRESHED: #${e.pr.number} ${e.branch} head=${head}${head === e.head ? ' (unchanged)' : ''}`);
    fetchAll(ctx);
  }
}

/** Rebuild an entry and everything behind it on fresh branch names; --drop pulls owner PRs, --first puts a hotfix in front. */
function cmdRebuild(ctx: Ctx, n: number, drop: number[], first: number | null): void {
  fetchAll(ctx);
  const entries = live(ctx);
  const from = find(entries, n);
  if (first !== null && from.index !== 0) stop('--first rebuilds the whole queue', `run: bun run merge-queue rebuild ${entries[0]!.pr.number} --first ${first}`);
  const replaced = entries.slice(from.index);
  const owners = [...(first !== null ? [first] : []), ...replaced.map((e) => e.owner).filter((o) => !drop.includes(o))];
  const round = Math.max(...replaced.map((e) => parseBranch(e.branch)!.round)) + 1;
  const ahead = entries[from.index - 1];
  const after = ahead ? { base: ahead.branch, version: ahead.version, isCi: touchesSelfAttestation(ctx.git, ahead.head).length > 0 } : { base: 'master', version: masterVersion(ctx), isCi: false };
  const built: number[] = [];
  for (const p of plan(ctx, owners, after, round)) {
    built.push(buildEntry(ctx, p));
    fetchAll(ctx);
  }
  const why = [drop.length ? `dropped ${drop.map((d) => `#${d}`).join(', ')}` : '', first !== null ? `#${first} first` : ''].filter(Boolean).join(', ');
  for (const e of replaced) {
    ctx.gh.comment(e.pr.number, `Rebuilt by bun run merge-queue rebuild${why ? ` (${why})` : ''}; replaced by ${built.map((b) => `#${b}`).join(', ') || 'nothing'}.`);
    ctx.gh.closePr(e.pr.number);
    ctx.git.run('push', '--quiet', 'origin', '--delete', e.branch);
  }
  ctx.log(`REBUILT: ${replaced.map((e) => `#${e.pr.number}`).join(', ')} -> ${built.map((b) => `#${b}`).join(', ') || 'nothing'}`);
}

export function ghCli(repo: string, cwd: string, env?: Record<string, string | undefined>): Gh {
  const gh = (...args: string[]): string => {
    const r = sh(['gh', ...args], cwd, env);
    if (r.code !== 0) throw new Stop(`MERGE_QUEUE: gh ${args.slice(0, 3).join(' ')} failed (exit ${r.code}): ${r.err.trim()}`);
    return r.out;
  };
  const fields = 'number,title,body,headRefOid,headRefName,state,isCrossRepository,author,labels,mergeStateStatus';
  const toPr = (j: Record<string, unknown>): PullRequest => ({
    ...(j as unknown as PullRequest),
    author: (j.author as { login: string }).login,
    labels: (j.labels as Array<{ name: string }>).map((l) => l.name),
  });
  return {
    repoOwner: () => repo.split('/')[0]!,
    pr: (n) => toPr(JSON.parse(gh('pr', 'view', String(n), '-R', repo, '--json', fields))),
    openPrForBranch: (branch) => {
      const list = JSON.parse(gh('pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', fields)) as Array<Record<string, unknown>>;
      return list.map(toPr).find((p) => !p.isCrossRepository && p.author === repo.split('/')[0]) ?? null;
    },
    createPr: ({ head, title, body }) => Number(/\/pull\/(\d+)/.exec(gh('pr', 'create', '-R', repo, '--base', 'master', '--head', head, '--title', title, '--body', body))?.[1]),
    addLabel: (n, label) => void gh('pr', 'edit', String(n), '-R', repo, '--add-label', label),
    comment: (n, body) => void gh('pr', 'comment', String(n), '-R', repo, '--body', body),
    comments: (n) => (JSON.parse(gh('pr', 'view', String(n), '-R', repo, '--json', 'comments')) as { comments: Array<{ body: string }> }).comments.map((c) => c.body),
    closePr: (n) => void gh('pr', 'close', String(n), '-R', repo),
    checks: (sha) => {
      const newest = new Map<string, { id: number; name: string }>();
      for (const r of (JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)) as Array<{ workflow_runs: Array<{ id: number; name: string; event: string }> }>).flatMap((p) => p.workflow_runs)) {
        const key = `${r.name}@${r.event}`;
        if ((newest.get(key)?.id ?? 0) < r.id) newest.set(key, r);
      }
      const jobs = [...newest.values()].flatMap((run) => (JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)) as Array<{ jobs: Array<{ name: string; status: string; conclusion: string | null }> }>)
        .flatMap((p) => p.jobs).map((j) => ({ name: `${run.name}/${j.name}`, status: j.status, conclusion: j.conclusion })));
      const others = (JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs?per_page=100`)) as Array<{ check_runs: Array<CheckRun & { app: { slug: string } | null }> }>)
        .flatMap((p) => p.check_runs).filter((c) => c.app?.slug !== 'github-actions').map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
      const runs = [...jobs, ...others];
      const statuses = (JSON.parse(gh('api', `repos/${repo}/commits/${sha}/status`)) as { statuses: Array<{ context: string; state: string }> }).statuses
        .map((s) => ({ name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed', conclusion: s.state === 'pending' ? null : s.state }));
      return [...runs, ...statuses];
    },
    merge: (n, sha, title, message) => (JSON.parse(gh('api', '-X', 'PUT', `repos/${repo}/pulls/${n}/merge`, '-f', 'merge_method=merge', '-f', `sha=${sha}`, '-f', `commit_title=${title}`, '-f', `commit_message=${message}`)) as { sha: string }).sha,
    pushRuns: (sha) => (JSON.parse(gh('api', `repos/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=100`)) as { workflow_runs: WorkflowRun[] }).workflow_runs
      .map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion })),
    jobConclusion: (runId, job) => {
      const jobs = (JSON.parse(gh('api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)) as { jobs: Array<{ name: string; status: string; conclusion: string | null }> }).jobs;
      const j = jobs.find((x) => x.name === job);
      return j && j.status === 'completed' ? j.conclusion ?? 'none' : null;
    },
    receiptHead: (pr) => {
      const r = sh(['gstack-ship-receipt', 'read', '--pr', String(pr), '--repo', repo, '--json'], cwd, env);
      if (r.code !== 0) return null;
      try {
        return (JSON.parse(r.out) as { head?: string }).head ?? null;
      } catch {
        return null;
      }
    },
  };
}

const USAGE = `Usage: bun run merge-queue <command> [--repo owner/name]
  plan <pr>...                      versions and order for new entries behind the queue tail
  build <pr>...                     append entries behind the queue tail
  status                            every live entry
  verify <queue-pr> [--expect-head <sha>] [--vm-gate-tree <tree>]
  land <queue-pr> [--expect-head <sha>] [--vm-gate-tree <tree>] [--timeout-minutes 45]
  refresh <queue-pr>                fix in place: owner's new head, then every entry behind
  rebuild <queue-pr> [--drop <pr>]... [--first <pr>]
Docs: ${DOCS}`;

const FLAGS: Record<string, { commands: string[]; valid: RegExp }> = {
  '--repo': { commands: ['plan', 'build', 'status', 'verify', 'land', 'refresh', 'rebuild'], valid: /^[\w.-]+\/[\w.-]+$/ },
  '--expect-head': { commands: ['verify', 'land'], valid: /^[0-9a-f]{40}$/ },
  '--vm-gate-tree': { commands: ['verify', 'land'], valid: /^[0-9a-f]{40}$/ },
  '--timeout-minutes': { commands: ['land'], valid: /^[1-9]\d*$/ },
  '--drop': { commands: ['rebuild'], valid: /^#?\d+$/ },
  '--first': { commands: ['rebuild'], valid: /^#?\d+$/ },
};

/** Positional PR numbers and validated flag values, or null when anything is unknown, malformed or misplaced. */
export function parseArgs(cmd: string, rest: string[]): { nums: number[]; flags: Map<string, string[]> } | null {
  const nums: number[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) {
      if (!/^#?\d+$/.test(a)) return null;
      nums.push(Number(a.replace('#', '')));
      continue;
    }
    const spec = FLAGS[a];
    const value = rest[++i];
    if (!spec || !spec.commands.includes(cmd) || value === undefined || !spec.valid.test(value)) return null;
    if (flags.has(a) && a !== '--drop') return null;
    flags.set(a, [...(flags.get(a) ?? []), value.replace(/^#/, '')]);
  }
  const counts: Record<string, (n: number) => boolean> = { plan: (n) => n > 0, build: (n) => n > 0, status: (n) => n === 0 };
  return (counts[cmd] ?? ((n: number) => n === 1))(nums.length) ? { nums, flags } : null;
}

export function main(argv: string[], opts: Opts = {}): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const [cmd, ...rest] = argv;
  if (cmd === '--help') {
    log(USAGE);
    return 0;
  }
  const args = cmd && ['plan', 'build', 'status', 'verify', 'land', 'refresh', 'rebuild'].includes(cmd) ? parseArgs(cmd, rest) : null;
  if (!cmd || !args) {
    log(USAGE);
    return 2;
  }
  const top = sh(['git', 'rev-parse', '--show-toplevel'], opts.cwd ?? process.cwd(), opts.env);
  if (top.code !== 0) {
    log(`MERGE_QUEUE: not inside a git checkout\n${USAGE}`);
    return 2;
  }
  const one = (name: string) => args.flags.get(name)?.[0];
  const root = top.out.trim();
  const ctx: Ctx = { git: new Git(root, opts.env), gh: opts.gh ?? ghCli(one('--repo') ?? 'garrytan/gbrain', root, opts.env), log, opts };
  const n = args.nums[0]!;
  try {
    switch (cmd) {
      case 'plan': cmdPlan(ctx, args.nums); return 0;
      case 'build': cmdBuild(ctx, args.nums); return 0;
      case 'status': cmdStatus(ctx); return 0;
      case 'verify': return cmdVerify(ctx, n, one('--expect-head'), one('--vm-gate-tree')) ? 0 : 1;
      case 'land': return cmdLand(ctx, n, one('--expect-head'), one('--vm-gate-tree'), Number(one('--timeout-minutes') ?? 45) * 60_000) ? 0 : 1;
      case 'refresh': cmdRefresh(ctx, n); return 0;
      default: cmdRebuild(ctx, n, (args.flags.get('--drop') ?? []).map(Number), one('--first') ? Number(one('--first')) : null); return 0;
    }
  } catch (e) {
    if (e instanceof Stop) {
      log(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
